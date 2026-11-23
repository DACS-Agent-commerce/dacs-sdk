// Reads the plugin's version-1 wallet keystore (dacs-plugin `stdio-mcp/src/keystore.ts` at 980c45b) and returns the
// recovery phrase's UTF-8 bytes. Internal: no package entry exports it. It writes nothing and keeps nothing.
import { createDecipheriv, scryptSync } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { OperationError } from '../client-errors.mjs';

const MAX_BYTES = 65_536;
const SALT_BYTES = 32, IV_BYTES = 12, TAG_BYTES = 16, KEY_BYTES = 32;
const WORD_COUNTS = [12, 15, 18, 21, 24];
const POSIX = process.platform !== 'win32';
const SPACE = 0x20, a = 0x61, z = 0x7a;
// The bytes the plugin's `validateMnemonic` treats as whitespace (`/\s+/`) that can appear in ASCII.
const isSpace = byte => byte === SPACE || (byte >= 0x09 && byte <= 0x0d);

const refuse = code => { throw new OperationError(code, code === 'keystore_unreadable' ? 'the keystore file cannot be read as a version-1 keystore'
  : code === 'keystore_unlock_failed' ? 'the keystore did not unlock (wrong passphrase or changed file)' : 'the keystore does not hold a recovery phrase'); };
const unsafe = stat => !stat.isFile() || stat.size > MAX_BYTES || (POSIX && (stat.mode & 0o077) !== 0);

// One read of a private regular file, never through a link: lstat, open without following, and the same checks on the open file.
function readPrivateFile(path) {
  let stat, fd;
  try { stat = lstatSync(path); } catch { return refuse('keystore_unreadable'); }
  if (stat.isSymbolicLink() || unsafe(stat)) refuse('keystore_unreadable');
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return refuse('keystore_unreadable'); }
  try {
    const open = fstatSync(fd);
    if (unsafe(open) || open.ino !== stat.ino || open.dev !== stat.dev) refuse('keystore_unreadable');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, read;
    while ((read = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += read;
    if (length > MAX_BYTES) refuse('keystore_unreadable');
    return bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    throw error instanceof OperationError ? error : new OperationError('keystore_unreadable', 'the keystore file cannot be read as a version-1 keystore');
  } finally { closeSync(fd); }
}

// Standard padded base64, as Buffer#toString('base64') writes it; anything else is not the plugin's.
function base64Of(value, length) {
  if (typeof value !== 'string') refuse('keystore_unreadable');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length === undefined ? bytes.length === 0 : bytes.length !== length)) refuse('keystore_unreadable');
  return bytes;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The members and bounds the plugin's reader requires (keystore.ts:13-25, :55, :57), plus the sizes its writer always uses (:36-38).
function parseKeystore(text) {
  let ks;
  try { ks = JSON.parse(text); } catch { return refuse('keystore_unreadable'); }
  if (!isObject(ks) || ks.version !== 1 || ks.kdf !== 'scrypt' || ks.cipher !== 'aes-256-gcm' || !isObject(ks.kdfparams)) refuse('keystore_unreadable');
  const { N, r, p, salt } = ks.kdfparams;
  if (!Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r !== 8 || p !== 1) refuse('keystore_unreadable');
  if ((ks.address !== undefined && typeof ks.address !== 'string') || (ks.onboarding !== undefined && !isObject(ks.onboarding))) refuse('keystore_unreadable');
  return { N, r, p, salt: base64Of(salt, SALT_BYTES), iv: base64Of(ks.iv, IV_BYTES), tag: base64Of(ks.tag, TAG_BYTES), ciphertext: base64Of(ks.ciphertext) };
}

// The phrase with surrounding whitespace removed and inner runs as single spaces, as the plugin's validateMnemonic does,
// in a fresh array; refused unless it is 12-24 words of lowercase ASCII letters. No string is made of it.
function normalizedPhrase(plain) {
  const out = new Uint8Array(plain.length);
  let length = 0, words = 0, pending = false;
  try {
    for (const byte of plain) {
      if (isSpace(byte)) { pending = length > 0; continue; }
      if (byte < a || byte > z) refuse('invalid_mnemonic');
      if (pending) { out[length++] = SPACE; pending = false; }
      if (length === 0 || out[length - 1] === SPACE) words += 1;
      out[length++] = byte;
    }
    if (!WORD_COUNTS.includes(words)) refuse('invalid_mnemonic');
    return out.slice(0, length);
  } finally { out.fill(0); }
}

/**
 * readKeystorePhrase({path, passphrase}) returns the phrase of the plugin's version-1 keystore at `path` as UTF-8 bytes in a fresh Uint8Array,
 * which the caller owns and zero-fills. Throws OperationError(keystore_unreadable) for a file that is absent, a link, not a regular file,
 * readable or writable by group or others (POSIX), over 65,536 bytes, or not the version-1 format within the plugin's scrypt bounds;
 * OperationError(keystore_unlock_failed) when the GCM tag fails (wrong passphrase or changed bytes); OperationError(invalid_mnemonic) when the
 * plaintext is not 12, 15, 18, 21 or 24 lowercase words. Messages never echo the path, the passphrase or the decipher's error.
 * The derived key and every decrypted chunk are zero-filled before it returns or throws.
 */
export function readKeystorePhrase({ path, passphrase }) {
  const { N, r, p, salt, iv, tag, ciphertext } = parseKeystore(readPrivateFile(path));
  let key, decipher, head, tail, plain;
  try {
    key = scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
    decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    head = decipher.update(ciphertext);
    try { tail = decipher.final(); } catch { refuse('keystore_unlock_failed'); }
    plain = Buffer.concat([head, tail]);
    return normalizedPhrase(plain);
  } catch (error) {
    throw error instanceof OperationError ? error : new OperationError('keystore_unreadable', 'the keystore file cannot be read as a version-1 keystore');
  } finally {
    for (const bytes of [key, head, tail, plain]) bytes?.fill(0);
  }
}
