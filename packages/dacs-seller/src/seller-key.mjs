// Seller key custody (K10): the one place the kit loads its seller key. The key
// comes only from loadDacsSecretV1, from one absolute file in the kit's private
// data directory, in the closed record `init` writes. Every mutable copy this
// module owns is zeroed, and the key then signs only through three closed roles:
// effect signing (guarded at every call), a read-only role bound to validated
// answers, refusals and discovery, and a local journal-integrity role.
import { createHash, createPrivateKey, createPublicKey, sign as signEd25519 } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, assertTp1Binding, discoverySigningBytes, isReadRoute, wireEnvelopeSigningBytes } from '@kynesyslabs/dacs/wire';
import { loadDacsSecretV1 } from '@kynesyslabs/dacs-node/secrets';
import { SELLER_STATE_SIGNING_DOMAIN } from './dacs/seller-durable-state.mjs';
import { assertKitOperationAdmitted } from './kit-operation-guard.mjs';
import { OperationError } from './operations.mjs';
import { isPrivateDirectory } from './private-directory.mjs';

const SELLER_KEY_FORMAT = 'dacs-seller-key/v1';
const SELLER_KEY_ALGORITHM = 'ed25519';
const SELLER_KEY_RECORD_FIELDS = ['algorithm', 'format', 'mnemonic'];
const SELLER_KEY_SECRET_NAME = 'dacs-seller-key';
const CLAIM_PREFIX = 'did:demos:agent:';
const ED25519_SEED_BYTES = 32;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PKCS8_ED25519_BYTES = PKCS8_ED25519_PREFIX.length + ED25519_SEED_BYTES;
const MAX_REFUSAL_BODY_BYTES = 4096;
const READ_ONLY_PURPOSES = Object.freeze(['discovery', 'read-answer', 'refusal']);
const JOURNAL_DOMAIN_BYTES = Buffer.from(SELLER_STATE_SIGNING_DOMAIN);
const FIXED_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Every seller key refusal. `code` is a fixed `seller_key_*` or
 * `runtime_unsupported` code. `details` is nonsecret context: a loader reason
 * code, a wire code or a Node version. The original failure is `cause`, which is
 * not enumerable and never serialized.
 */
export class SellerKeyError extends OperationError {
  constructor(code, details, cause) {
    super(code, code, details);
    this.name = 'SellerKeyError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
  }
}

const fixedCode = (value) => (typeof value === 'string' && FIXED_CODE.test(value) ? value : undefined);
const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refusedRole = (details, cause) => new SellerKeyError('seller_key_role_refused', details, cause);
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// K14: the purchase paths admit Node ^22.13.0 || >=23.4.0.
function runtimeSupported(version) {
  const [major, minor] = /^v(\d+)\.(\d+)\./.exec(version)?.slice(1).map(Number) ?? [];
  return (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24;
}

function assertKeyLocation(filePath, dataDirectory) {
  if (typeof filePath !== 'string' || typeof dataDirectory !== 'string' || !isAbsolute(filePath) || dirname(filePath) !== dataDirectory || !isPrivateDirectory(dataDirectory)) {
    throw new SellerKeyError('seller_key_location_invalid');
  }
}

async function loadKeyFile(filePath) {
  let loader;
  try {
    loader = await loadDacsSecretV1({ name: SELLER_KEY_SECRET_NAME, mode: 'live-demos', filePath });
  } catch (cause) {
    throw new SellerKeyError('seller_key_unavailable', fixedCode(cause?.reasonCode), cause);
  }
  if (loader.source !== 'file') {
    loader.destroy();
    throw new SellerKeyError('seller_key_unavailable', 'secret-source-not-file');
  }
  return loader;
}

/**
 * Parses the closed key record `init` writes: exactly `format`
 * ("dacs-seller-key/v1"), `algorithm` ("ed25519") and a `mnemonic` the injected
 * BIP-39 check accepts. Returns the record; throws SellerKeyError
 * `seller_key_format_invalid` for anything else. The caller zeroes `bytes`.
 */
export function parseSellerKeyRecord(bytes, validateMnemonic) {
  const invalid = (cause) => new SellerKeyError('seller_key_format_invalid', undefined, cause);
  let record;
  try {
    record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw invalid(cause);
  }
  const closed = isPlainRecord(record) && Object.keys(record).sort().join() === SELLER_KEY_RECORD_FIELDS.join();
  if (!closed || record.format !== SELLER_KEY_FORMAT || record.algorithm !== SELLER_KEY_ALGORITHM || typeof record.mnemonic !== 'string') throw invalid();
  let accepted;
  try {
    accepted = validateMnemonic(record.mnemonic);
  } catch (cause) {
    throw invalid(cause);
  }
  if (accepted !== true) throw invalid();
  return record;
}

async function deriveOwned(derive, mnemonic) {
  let derived;
  try {
    derived = await derive(mnemonic);
  } catch (cause) {
    throw new SellerKeyError('seller_key_derivation_failed', undefined, cause);
  }
  return derived;
}

const derivationShapeValid = (derived) => isPlainRecord(derived) && typeof derived.claim === 'string' && derived.ed25519PrivateKey instanceof Uint8Array &&
  derived.ed25519PrivateKey.length >= ED25519_SEED_BYTES && typeof derived.cleanup === 'function';

// The Node key object for the derived seed, built from one named PKCS8 buffer that the caller zeroes.
function keyObjectFromSeed(ed25519PrivateKey, der) {
  der.set(PKCS8_ED25519_PREFIX);
  der.set(ed25519PrivateKey.subarray(0, ED25519_SEED_BYTES), PKCS8_ED25519_PREFIX.length);
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch (cause) {
    throw new SellerKeyError('seller_key_derivation_failed', undefined, cause);
  }
}

function claimOfPublicKey(keyObject) {
  return `${CLAIM_PREFIX}${createPublicKey(keyObject).export({ format: 'der', type: 'spki' }).subarray(-ED25519_SEED_BYTES).toString('hex')}`;
}

// Runs the derivation's cleanup; returns what it threw so it can never replace the original failure.
function cleanUpDerivation(derived) {
  try {
    derived?.cleanup?.();
    return null;
  } catch (cause) {
    return cause;
  }
}

// Reads the record, derives the key and checks its claim. Every owned mutable copy is zeroed on every path.
async function keyFromKeyFile(loader, { listingSeller, validateMnemonic, derive }) {
  const recordBytes = loader.bytes();
  const der = Buffer.alloc(PKCS8_ED25519_BYTES);
  let derived = null;
  let keyObject = null;
  let failure = null;
  try {
    derived = await deriveOwned(derive, parseSellerKeyRecord(recordBytes, validateMnemonic).mnemonic);
    if (!derivationShapeValid(derived)) throw new SellerKeyError('seller_key_derivation_failed');
    keyObject = keyObjectFromSeed(derived.ed25519PrivateKey, der);
    const claim = claimOfPublicKey(keyObject);
    if (derived.claim !== claim || claim !== listingSeller) throw new SellerKeyError('seller_key_claim_mismatch');
  } catch (error) {
    failure = error;
  }
  recordBytes.fill(0);
  der.fill(0);
  if (derived?.ed25519PrivateKey instanceof Uint8Array) derived.ed25519PrivateKey.fill(0);
  const cleanupFailure = cleanUpDerivation(derived);
  if (failure !== null) throw failure;
  if (cleanupFailure !== null) throw new SellerKeyError('seller_key_derivation_failed', 'cleanup', cleanupFailure);
  return { keyObject, claim: derived.claim };
}

function hasPrefix(bytes, prefix) {
  return bytes instanceof Uint8Array && bytes.length >= prefix.length && Buffer.from(bytes.buffer, bytes.byteOffset, prefix.length).equals(prefix);
}

// The bytes the wire's own builder gives for `payload`, or a refusal when it rejects the payload.
function wireBytesFor(purpose, text) {
  try {
    const payload = JSON.parse(text);
    return { payload, bytes: purpose === 'discovery' ? discoverySigningBytes(payload) : wireEnvelopeSigningBytes(payload) };
  } catch (cause) {
    throw refusedRole('payload-invalid', cause);
  }
}

function assertClosedRefusalBody(body) {
  if (Buffer.byteLength(body) > MAX_REFUSAL_BODY_BYTES) throw refusedRole('refusal-body-too-large');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw refusedRole('refusal-body-invalid', cause);
  }
  const members = isPlainRecord(parsed) ? Object.keys(parsed) : [];
  if (typeof parsed?.error !== 'string' || members.some((name) => name !== 'error' && name !== 'message') || (members.includes('message') && typeof parsed.message !== 'string')) {
    throw refusedRole('refusal-body-invalid');
  }
}

function assertAnswerPurpose(purpose, payload, body) {
  if (payload.bodyHash !== sha256Hex(body)) throw refusedRole('body-mismatch');
  if (purpose === 'read-answer') {
    if (!isReadRoute(payload.path) || payload.status < 200 || payload.status > 299) throw refusedRole('not-a-read-answer');
    return;
  }
  if (payload.status < 400 || payload.status > 599) throw refusedRole('not-a-refusal');
  assertClosedRefusalBody(body);
}

// Accepts `bytes` only when they are exactly the wire's signing bytes for an answer, refusal or discovery document of this seller under this binding.
function assertReadOnlyBytes({ purpose, binding, claim, body }, bytes) {
  if (!(bytes instanceof Uint8Array)) throw refusedRole('not-bytes');
  const discovery = purpose === 'discovery';
  const domain = discovery ? DACS_SELLER_HTTP_DOMAINS.discovery : DACS_SELLER_HTTP_DOMAINS.response;
  if (bytes.length > (discovery ? DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes : DACS_SELLER_HTTP_LIMITS.maxHeaderLength)) throw refusedRole('bytes-too-large');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw refusedRole('not-text', cause);
  }
  if (!text.startsWith(domain)) throw refusedRole('wrong-domain');
  const { payload, bytes: recomputed } = wireBytesFor(purpose, text.slice(domain.length));
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).equals(recomputed)) throw refusedRole('not-the-wire-bytes');
  if (canonicalize(payload.profile) !== canonicalize(binding.profile) || payload.seller !== claim) throw refusedRole('wrong-binding-or-seller');
  if (!discovery) assertAnswerPurpose(purpose, payload, body);
}

async function assertReadOnlyRequest(request) {
  if (!isPlainRecord(request) || !READ_ONLY_PURPOSES.includes(request.purpose)) throw refusedRole('purpose');
  const { purpose, binding, local, body } = request;
  if (purpose === 'discovery' ? body !== undefined : typeof body !== 'string' || Buffer.byteLength(body) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) throw refusedRole('body');
  try {
    await assertTp1Binding(binding, local);
  } catch (cause) {
    throw refusedRole(fixedCode(cause?.code), cause);
  }
  return { purpose, binding, body };
}

// The three signing roles over one key object. `close()` drops the key, after which every role refuses.
function createSigningRoles(keyObject, claim) {
  let key = keyObject;
  const requireOpen = () => {
    if (key === null) throw new SellerKeyError('seller_key_closed');
  };
  const signBytes = (bytes) => signEd25519(null, bytes, key);
  return Object.freeze({
    claim,
    sign(bytes) {
      assertKitOperationAdmitted('sellerKey.sign');
      requireOpen();
      if (!(bytes instanceof Uint8Array)) throw new TypeError('sign takes bytes');
      return signBytes(bytes);
    },
    async readOnlyAnswerSigner(request) {
      requireOpen();
      const purposeScope = { ...(await assertReadOnlyRequest(request)), claim };
      requireOpen(); // custody may have closed while the binding check was pending
      let used = false;
      return Object.freeze({
        claim,
        sign(bytes) {
          requireOpen();
          if (used) throw refusedRole('single-use');
          used = true;
          assertReadOnlyBytes(purposeScope, bytes);
          return signBytes(bytes);
        },
      });
    },
    integritySigner: Object.freeze({
      claim,
      sign(bytes) {
        requireOpen();
        if (!hasPrefix(bytes, JOURNAL_DOMAIN_BYTES)) throw refusedRole('journal-domain');
        return signBytes(bytes);
      },
    }),
    close() {
      key = null;
    },
  });
}

// A diagnostic is a fixed code and nonsecret context; while the loader is live each value passes through its redact (K10 Logging).
function reportFailure(log, failure, loader) {
  const entry = { code: failure.code, ...(failure.details === undefined ? {} : { details: failure.details }) };
  const live = loader !== null && !loader.destroyed;
  try {
    log(live ? Object.fromEntries(Object.entries(entry).map(([name, value]) => [name, loader.redact(value)])) : entry);
  } catch {
    // A failing log sink never replaces the custody failure being reported.
  }
}

/**
 * Opens the seller key and returns `{ claim, sign(bytes), readOnlyAnswerSigner(request), integritySigner, close() }`.
 * Steps, in order: runtime floor (K14), `keyFormat`, key location (the file sits in the private
 * `dataDirectory`), `loadDacsSecretV1`, closed-record parse with the injected `validateMnemonic`,
 * injected `derive(mnemonic)` returning `{ claim, ed25519PrivateKey, cleanup }` (ownership transfers
 * here), and `claim === listingSeller`. Opening is possible while the kit guard is off; `sign` checks
 * the guard at every call, and the read-only and integrity roles do not (they sign no effect).
 * Throws SellerKeyError (`runtime_unsupported`, `seller_key_format_invalid`, `seller_key_location_invalid`,
 * `seller_key_unavailable`, `seller_key_derivation_failed` or `seller_key_claim_mismatch`) and emits
 * only its fixed code and nonsecret details through `log`; the original failure is its `cause`.
 */
export async function openSellerKey({ filePath, dataDirectory, keyFormat, listingSeller, validateMnemonic, derive, log = () => {} }) {
  if (typeof validateMnemonic !== 'function' || typeof derive !== 'function' || typeof log !== 'function') throw new TypeError('openSellerKey needs validateMnemonic, derive and log functions');
  let loader = null;
  try {
    if (!runtimeSupported(process.version)) throw new SellerKeyError('runtime_unsupported', process.version);
    if (keyFormat !== SELLER_KEY_FORMAT) throw new SellerKeyError('seller_key_format_invalid');
    assertKeyLocation(filePath, dataDirectory);
    loader = await loadKeyFile(filePath);
    const { keyObject, claim } = await keyFromKeyFile(loader, { listingSeller, validateMnemonic, derive });
    return createSigningRoles(keyObject, claim);
  } catch (error) {
    if (error instanceof SellerKeyError) reportFailure(log, error, loader);
    throw error;
  } finally {
    loader?.destroy();
  }
}
