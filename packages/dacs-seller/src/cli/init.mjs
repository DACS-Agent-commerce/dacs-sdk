import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { DURABLE_SYNC, publishFileExclusive, syncDirectory, syncFile } from '../devnet-demo/durable-file.mjs';
import { isPrivateDirectory } from '../private-directory.mjs';
import { SELLER_KEY_ALGORITHM, SELLER_KEY_FORMAT, SellerKeyError, loadKeyFile, parseSellerKeyRecord } from '../seller-key.mjs';
import { CONFIG_MAX_BYTES, SELLER_CONFIG_FILE, SELLER_CONFIG_FORMAT, SELLER_KEY_FILE, SellerConfigError, assertConfigBindsDirectory, parseSellerConfig } from './config.mjs';

const PRIVATE_DIRECTORY_MODE = 0o700;
const GROUP_AND_OTHER_BITS = 0o077;
const CONFIG_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CLAIM_PATTERN = /^did:demos:agent:[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^(?:0x)?[0-9a-f]{1,128}$/;
// Operator-specific fields start unset; `assertSellerConfigComplete` refuses them until the operator fills them in.
const UNSET_OPERATOR_FIELDS = ['rpcUrl', 'publicOrigin', 'listener', 'directoryOrigin', 'listing', 'service', 'sellerApproval'];

const refusal = (code, detail, cause) => Object.assign(new Error(detail === undefined ? code : `${code}{${detail}}`, { cause }), { code, detail });
const unavailable = cause => refusal('seller_data_directory_unavailable', undefined, cause);

async function lstatOrNull(path) {
  try { return await lstat(path); } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw unavailable(cause);
  }
}

// An owner without full access leaves group and other with none: the mode of a creator stopped before its chmod.
const lacksOwnerAccess = stat => stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & GROUP_AND_OTHER_BITS) === 0 && (stat.mode & PRIVATE_DIRECTORY_MODE) !== PRIVATE_DIRECTORY_MODE;

async function assertPrivateDirectory(path) {
  if (isPrivateDirectory(path)) return;
  const stat = await lstatOrNull(path);
  throw refusal('data_directory_unsafe', stat !== null && lacksOwnerAccess(stat) ? 'owner-permissions' : 'not-private');
}

async function assertParentExists(parent) {
  let real;
  try { real = await realpath(parent); } catch (cause) {
    throw cause.code === 'ENOENT' ? refusal('data_directory_parent_missing', undefined, cause) : unavailable(cause);
  }
  if (real !== parent) throw refusal('data_directory_unsafe', 'not-canonical');
}

// Only the directory this run creates is ever chmod-ed. EEXIST means a concurrent init created it: validate it like any existing one.
async function ensurePrivateDirectory(path) {
  if (!isAbsolute(path)) throw refusal('data_directory_unsafe', 'not-canonical');
  if (await lstatOrNull(path) !== null) return assertPrivateDirectory(path);
  await assertParentExists(dirname(path));
  try { await mkdir(path, PRIVATE_DIRECTORY_MODE); } catch (cause) {
    if (cause.code === 'EEXIST') return assertPrivateDirectory(path);
    throw unavailable(cause);
  }
  try { await chmod(path, PRIVATE_DIRECTORY_MODE); } catch (cause) { throw unavailable(cause); }
}

// A failed sync means the file may not survive a power cut, so none may end in a printed identity.
async function durably(operation) {
  try { return await operation(); } catch (cause) { throw refusal('init_durability_failed', undefined, cause); }
}

const REFUSING_SYNC = Object.freeze({
  file: (handle, path) => durably(() => DURABLE_SYNC.file(handle, path)),
  directory: path => durably(() => DURABLE_SYNC.directory(path)),
});

// Publishes `text` at `path` exactly once, never replacing a file. The result is ignored: the stored file, whoever wrote it, is what init verifies.
async function publish(path, text) {
  try { await publishFileExclusive(path, text, REFUSING_SYNC); } catch (cause) {
    throw cause.code === 'init_durability_failed' ? cause : unavailable(cause);
  }
}

// Reads at most CONFIG_MAX_BYTES + 1 bytes of a regular file that is not a symbolic link; parseSellerConfig refuses an oversized result.
async function readConfigBytes(path) {
  let handle;
  try {
    handle = await open(path, CONFIG_READ_FLAGS);
    if (!(await handle.stat()).isFile()) throw new SellerConfigError('seller_config_invalid', '$');
    const buffer = Buffer.alloc(CONFIG_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch (cause) {
    throw cause instanceof SellerConfigError ? cause : unavailable(cause);
  } finally { await handle?.close(); }
}

// Loads the key file that is now stored, whoever published it, and derives its identity. Copies of the secret are zeroed.
async function storedIdentity(keyPath, identity) {
  const loader = await loadKeyFile(keyPath);
  let recordBytes, derived;
  try {
    recordBytes = loader.bytes();
    derived = await identity.deriveWalletIdentity(parseSellerKeyRecord(recordBytes, identity.validateMnemonic).mnemonic);
  } catch (error) {
    // No cause is kept for a failed derivation: its text can quote the mnemonic.
    throw error instanceof SellerKeyError ? error : new SellerKeyError('seller_key_derivation_failed');
  } finally {
    recordBytes?.fill(0);
    loader.destroy();
  }
  if (derived?.privateKey instanceof Uint8Array) derived.privateKey.fill(0);
  if (!CLAIM_PATTERN.test(derived?.claim) || !ADDRESS_PATTERN.test(derived.address)) throw new SellerKeyError('seller_key_derivation_failed');
  return { claim: derived.claim, address: derived.address };
}

// A generated mnemonic is published for good, so a bad one is refused before it is written.
async function generatedKeyRecordText(identity) {
  const mnemonic = await identity.generateWalletMnemonic();
  if (identity.validateMnemonic(mnemonic) !== true) throw new SellerKeyError('seller_key_derivation_failed', 'generate');
  return JSON.stringify({ format: SELLER_KEY_FORMAT, algorithm: SELLER_KEY_ALGORITHM, mnemonic }) + '\n';
}

const configTemplateText = dataDirectory => JSON.stringify({
  format: SELLER_CONFIG_FORMAT, dataDirectory, keyPath: join(dataDirectory, SELLER_KEY_FILE),
  ...Object.fromEntries(UNSET_OPERATOR_FIELDS.map(field => [field, null])),
}, null, 2) + '\n';

// Syncs both files, then the data directory and its parent and nothing above, so a run that published nothing still finishes what a killed winner left.
const syncBarrier = (keyPath, configPath, dataDirectory) => durably(async () => {
  await syncFile(keyPath);
  await syncFile(configPath);
  await syncDirectory(dataDirectory);
  await syncDirectory(dirname(dataDirectory));
});

/**
 * Creates the private data directory (its parent must exist), then the seller key and a `seller.json` of unset
 * operator fields, each published whole and never replaced, and writes `claim: <claim>` and `address: <address>`
 * to `stdout` only after both files and their directories are synced. A repeat, a rerun after a crash and a run
 * that loses a race verify the stored files and print the stored key's identity. `identity` supplies
 * `generateWalletMnemonic()`, `validateMnemonic(text)` and `deriveWalletIdentity(mnemonic)`.
 * Throws `seller_identity_unavailable` without `identity`; `data_directory_unsafe{detail}`, `data_directory_parent_missing`,
 * `seller_data_directory_unavailable` (a filesystem failure, with its cause), `init_durability_failed` (a sync failure,
 * with its cause), `seller_key_*` and SellerConfigError refusals.
 */
export async function runInit({ dataDirectory, identity, stdout }) {
  if (identity === undefined) throw refusal('seller_identity_unavailable');
  await ensurePrivateDirectory(dataDirectory);
  const keyPath = join(dataDirectory, SELLER_KEY_FILE), configPath = join(dataDirectory, SELLER_CONFIG_FILE);
  await publish(keyPath, await generatedKeyRecordText(identity));
  const { claim, address } = await storedIdentity(keyPath, identity);
  await publish(configPath, configTemplateText(dataDirectory));
  assertConfigBindsDirectory(parseSellerConfig(await readConfigBytes(configPath)), dataDirectory);
  await syncBarrier(keyPath, configPath, dataDirectory);
  stdout.write(`claim: ${claim}\naddress: ${address}\n`);
}
