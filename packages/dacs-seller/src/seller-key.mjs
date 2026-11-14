// Seller key custody (K10): the one place the kit loads its seller key. The key
// comes only from loadDacsSecretV1, from one absolute file in the kit's private
// data directory, in the closed record `init` writes. Every mutable copy this
// module owns is zeroed, and the key then signs only through three closed roles:
// effect signing (guarded at every call), a read-only role for one answer, refusal
// or discovery document (the TP-1 authority admits its job when it signs; a ready
// one also needs the kit guard), and a local journal-integrity role.
import { createHash, createPrivateKey, createPublicKey, sign as signEd25519 } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_FORMAT, DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, assertTp1Authority, assertTp1Binding, discoverySigningBytes, isReadRoute, wireEnvelopeSigningBytes } from '@kynesyslabs/dacs/wire';
import { loadDacsSecretV1 } from '@kynesyslabs/dacs-node/secrets';
import { SELLER_STATE_SIGNING_DOMAIN } from './dacs/seller-durable-state.mjs';
import { assertKitOperationAdmitted } from './kit-operation-guard.mjs';
import { OperationError } from './operations.mjs';
import { isPrivateDirectory } from './private-directory.mjs';

export const SELLER_KEY_FORMAT = 'dacs-seller-key/v1';
export const SELLER_KEY_ALGORITHM = 'ed25519';
const SELLER_KEY_RECORD_FIELDS = ['algorithm', 'format', 'mnemonic'];
const SELLER_KEY_SECRET_NAME = 'dacs-seller-key';
const CLAIM_PREFIX = 'did:demos:agent:';
const ED25519_SEED_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PKCS8_ED25519_BYTES = PKCS8_ED25519_PREFIX.length + ED25519_SEED_BYTES;
const MAX_REFUSAL_BODY_BYTES = 4096;
const READ_ONLY_PURPOSES = Object.freeze(['discovery', 'read-answer', 'refusal']);
const JOURNAL_DOMAIN_BYTES = Buffer.from(SELLER_STATE_SIGNING_DOMAIN);
const FIXED_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Every seller key refusal. `code` is a fixed `seller_key_*` or
 * `runtime_unsupported` code. `details` is nonsecret context: a loader reason
 * code, a wire code, a failed step or a Node version. Only a loader or wire
 * failure is kept as `cause` (not enumerable, never serialized): a step that sees
 * the key record or mnemonic keeps none, since its error text can quote them.
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
const formatInvalid = (step) => new SellerKeyError('seller_key_format_invalid', step);
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Runs one step; its failure becomes `refusal(cause)`. A step that sees the key record or mnemonic passes a refusal that drops the cause, whose text can quote them.
function refusing(refusal, run) {
  try {
    return run();
  } catch (cause) {
    throw refusal(cause);
  }
}

// The purchase paths admit Node ^22.22.2 || ^24.15.0, the package's engines range.
function runtimeSupported(version) {
  const [major, minor, patch] = /^v(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number) ?? [];
  return (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || (major === 24 && minor >= 15);
}

function assertKeyLocation(filePath, dataDirectory) {
  if (typeof filePath !== 'string' || typeof dataDirectory !== 'string' || !isAbsolute(filePath) || dirname(filePath) !== dataDirectory || !isPrivateDirectory(dataDirectory)) {
    throw new SellerKeyError('seller_key_location_invalid');
  }
}

/** Loads the seller key file through the custody loader; returns the live loader (the caller destroys it) or throws SellerKeyError `seller_key_unavailable`. */
export async function loadKeyFile(filePath) {
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
  const text = refusing(() => formatInvalid('utf8'), () => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const record = refusing(() => formatInvalid('json'), () => JSON.parse(text));
  const closed = isPlainRecord(record) && Object.keys(record).sort().join() === SELLER_KEY_RECORD_FIELDS.join();
  if (!closed || record.format !== SELLER_KEY_FORMAT || record.algorithm !== SELLER_KEY_ALGORITHM || typeof record.mnemonic !== 'string') throw formatInvalid();
  if (refusing(() => formatInvalid('validate'), () => validateMnemonic(record.mnemonic)) !== true) throw formatInvalid();
  return record;
}

async function deriveOwned(derive, mnemonic) {
  try {
    return await derive(mnemonic);
  } catch {
    throw new SellerKeyError('seller_key_derivation_failed', 'derive');
  }
}

const derivationShapeValid = (derived) => isPlainRecord(derived) && typeof derived.claim === 'string' && derived.ed25519PrivateKey instanceof Uint8Array &&
  derived.ed25519PrivateKey.length >= ED25519_SEED_BYTES && typeof derived.cleanup === 'function';

// The Node key object for the derived seed, built from one named PKCS8 buffer that the caller zeroes.
function keyObjectFromSeed(ed25519PrivateKey, der) {
  der.set(PKCS8_ED25519_PREFIX);
  der.set(ed25519PrivateKey.subarray(0, ED25519_SEED_BYTES), PKCS8_ED25519_PREFIX.length);
  return refusing(() => new SellerKeyError('seller_key_derivation_failed', 'pkcs8'), () => createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
}

function claimOfPublicKey(keyObject) {
  return `${CLAIM_PREFIX}${createPublicKey(keyObject).export({ format: 'der', type: 'spki' }).subarray(-ED25519_PUBLIC_KEY_BYTES).toString('hex')}`;
}

// Runs the derivation's cleanup; answers whether it completed, so its failure can never replace the original one.
function cleanUpDerivation(derived) {
  try {
    derived?.cleanup?.();
    return true;
  } catch {
    return false;
  }
}

// Reads the record, derives the key and checks its claim. Every owned mutable copy is zeroed on every path.
async function keyFromKeyFile(loader, { listingSeller, validateMnemonic, derive }) {
  const recordBytes = loader.bytes();
  const der = Buffer.alloc(PKCS8_ED25519_BYTES);
  let derived = null, keyObject = null, failure = null;
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
  const cleanedUp = cleanUpDerivation(derived);
  if (failure !== null) throw failure;
  if (!cleanedUp) throw new SellerKeyError('seller_key_derivation_failed', 'cleanup');
  return { keyObject, claim: derived.claim };
}

function hasPrefix(bytes, prefix) {
  return bytes instanceof Uint8Array && bytes.length >= prefix.length && Buffer.from(bytes.buffer, bytes.byteOffset, prefix.length).equals(prefix);
}

// The bytes the wire's own builder gives for `payload`, or a refusal when it rejects the payload.
function wireBytesFor(purpose, text) {
  return refusing((cause) => refusedRole('payload-invalid', cause), () => {
    const payload = JSON.parse(text);
    return { payload, bytes: purpose === 'discovery' ? discoverySigningBytes(payload) : wireEnvelopeSigningBytes(payload) };
  });
}

function assertClosedRefusalBody(body) {
  if (Buffer.byteLength(body) > MAX_REFUSAL_BODY_BYTES) throw refusedRole('refusal-body-too-large');
  const parsed = refusing((cause) => refusedRole('refusal-body-invalid', cause), () => JSON.parse(body));
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

// Returns the payload of `bytes` only when they are exactly the wire's signing bytes for an answer, refusal or discovery document of this seller under this binding.
function assertReadOnlyBytes({ purpose, binding, claim, body }, bytes) {
  const discovery = purpose === 'discovery';
  const domain = discovery ? DACS_SELLER_HTTP_DOMAINS.discovery : DACS_SELLER_HTTP_DOMAINS.response;
  if (bytes.length > (discovery ? DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes : DACS_SELLER_HTTP_LIMITS.maxHeaderLength)) throw refusedRole('bytes-too-large');
  const text = refusing((cause) => refusedRole('not-text', cause), () => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!text.startsWith(domain)) throw refusedRole('wrong-domain');
  const { payload, bytes: recomputed } = wireBytesFor(purpose, text.slice(domain.length));
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).equals(recomputed)) throw refusedRole('not-the-wire-bytes');
  if (canonicalize(payload.profile) !== canonicalize(binding.profile) || payload.seller !== claim) throw refusedRole('wrong-binding-or-seller');
  if (!discovery) assertAnswerPurpose(purpose, payload, body);
  return payload;
}

// Runs one of the wire's TP-1 checks; its refusal (or the authority reader's own error) becomes a role refusal.
async function wireAuthority(check) {
  try {
    await check();
  } catch (cause) {
    throw refusedRole(fixedCode(cause?.code), cause);
  }
}

// The request's inputs, read once and copied, after the wire's binding check passes for them.
async function readOnlyScope(request) {
  const { purpose, binding, local, body } = isPlainRecord(request) ? request : {};
  if (!READ_ONLY_PURPOSES.includes(purpose)) throw refusedRole('purpose');
  if (purpose === 'discovery' ? body !== undefined : typeof body !== 'string' || Buffer.byteLength(body) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) throw refusedRole('body');
  const scope = Object.freeze({ purpose, binding, local: isPlainRecord(local) ? Object.freeze({ ...local }) : local, body });
  await wireAuthority(() => assertTp1Binding(scope.binding, scope.local));
  return scope;
}

// The wire's signing-time check, read fresh from the reader: this seller's discovery session, or the payload's job for its buyer and seller.
function assertSigningAuthority({ purpose, binding, local }, payload) {
  const discovery = purpose === 'discovery';
  return wireAuthority(() => assertTp1Authority(binding, local, discovery ? [payload.seller] : [payload.buyer, payload.seller],
    discovery ? DACS_SELLER_DISCOVERY_FORMAT : payload.jobId));
}

// A discovery document that says ready lets buyers start purchases, so it signs only while the kit operation guard admits.
const assertReadyAdmitted = ({ purpose }, { ready }) => { if (purpose === 'discovery' && ready !== false) assertKitOperationAdmitted('sellerKey.readOnlyAnswerSigner'); };

// The three signing roles over one key object. `close()` drops the key, after which every role refuses.
function createSigningRoles(keyObject, claim) {
  let key = keyObject;
  const requireOpen = () => { if (key === null) throw new SellerKeyError('seller_key_closed'); };
  const signBytes = (bytes) => signEd25519(null, bytes, key);
  return Object.freeze({
    claim,
    sign(bytes) {
      requireOpen();
      assertKitOperationAdmitted('sellerKey.sign');
      if (!(bytes instanceof Uint8Array)) throw new TypeError('sign takes bytes');
      return signBytes(bytes);
    },
    async readOnlyAnswerSigner(request) {
      requireOpen();
      const scope = { ...(await readOnlyScope(request)), claim };
      requireOpen(); // custody may have closed while the binding check was pending
      let used = false;
      return Object.freeze({
        claim,
        // Async (always await it), single-use: it signs its own copy of `bytes` only after the authority admits their job when it signs.
        async sign(bytes) {
          requireOpen();
          if (used) throw refusedRole('single-use');
          used = true;
          if (!(bytes instanceof Uint8Array)) throw refusedRole('not-bytes');
          const owned = Uint8Array.from(bytes);
          const payload = assertReadOnlyBytes(scope, owned);
          assertReadyAdmitted(scope, payload);
          await assertSigningAuthority(scope, payload);
          requireOpen(); // custody may have closed while the authority check was pending
          assertReadyAdmitted(scope, payload); // and the guard may have re-held
          return signBytes(owned); // no await between the two rechecks and the signature
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
    close() { key = null; },
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
 * Opens the seller key: runtime floor, `keyFormat`, location in the private `dataDirectory`, `loadDacsSecretV1`,
 * closed-record parse with `validateMnemonic`, `derive(mnemonic)` (which hands over `{ claim, ed25519PrivateKey,
 * cleanup }`), then `claim === listingSeller`. Returns `{ claim, sign(bytes), readOnlyAnswerSigner(request), integritySigner, close() }`;
 * `readOnlyAnswerSigner` returns a Promise of `{ claim, sign(bytes) }` whose `sign` returns a Promise of the signature: await both.
 * Throws TypeError without the three functions, else SellerKeyError, whose fixed code and nonsecret details alone go to
 * `log`. The roles throw `seller_key_closed` after close() and `seller_key_role_refused` outside their purpose.
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
