// Shared fixtures for the seller key custody tests. Key records and mnemonics
// are built at run time from C0's repeated-byte seeds, so no key-shaped literal
// is committed. Every cryptographic signer call is counted on node:crypto's
// sign, the call under every KeyObject signature.
import crypto from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { register, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wire from '@kynesyslabs/dacs/wire';
import * as loaderSpy from './secret-loader-spy.mjs';

export { loaderSpy, wire };

export const KEY_FORMAT = 'dacs-seller-key/v1';
export const T0 = 1793102400000;
export const JOB = '01M5YKPJG0248H248H248H248H';
export const LOCAL = Object.freeze({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' });
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const SELLER_SEED_BYTE = 2;
const BUYER_SEED_BYTE = 1;
const MNEMONIC_PATTERN = /^TEST mnemonic seed (\d+)$/;

// Custody refuses Node outside ^22.22.2 || ^24.15.0 (the runtime refusal test sets its own versions).
// Elsewhere the fixtures report a supported version, so keys open when the suite runs on another Node.
const SUPPORTED_TEST_VERSION = 'v22.22.2';
const [runtimeMajor, runtimeMinor, runtimePatch] = /^v(\d+)\.(\d+)\.(\d+)/.exec(process.version)?.slice(1).map(Number) ?? [0, 0, 0];
if (!((runtimeMajor === 22 && (runtimeMinor > 22 || (runtimeMinor === 22 && runtimePatch >= 2))) || (runtimeMajor === 24 && runtimeMinor >= 15))) {
  Object.defineProperty(process, 'version', { value: SUPPORTED_TEST_VERSION, configurable: true });
}

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
export const allZero = (bytes) => bytes.every((byte) => byte === 0);

const originalSign = crypto.sign;
const originalCreatePrivateKey = crypto.createPrivateKey;
/** Counts node:crypto sign calls, and keeps the DER buffer of every private key made while `derBuffers.watching`. */
export const cryptoCalls = { signs: 0, derBuffers: [], watching: false };
crypto.sign = (...args) => { cryptoCalls.signs += 1; return originalSign(...args); };
crypto.createPrivateKey = (options, ...rest) => {
  if (cryptoCalls.watching && Buffer.isBuffer(options?.key)) cryptoCalls.derBuffers.push(options.key);
  return originalCreatePrivateKey(options, ...rest);
};
syncBuiltinESMExports();

const wallets = new Map();
/** The Ed25519 wallet of a repeated-byte seed: { seed, publicKey, claim, publicKeyObject }. Cached, so building it never reaches the watched calls. */
export function walletFor(seedByte) {
  if (!wallets.has(seedByte)) {
    const seed = Buffer.alloc(32, seedByte);
    const privateKey = originalCreatePrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const publicKeyObject = crypto.createPublicKey(privateKey);
    const publicKey = publicKeyObject.export({ format: 'der', type: 'spki' }).subarray(-32);
    wallets.set(seedByte, { seed, publicKey, publicKeyObject, claim: `did:demos:agent:${publicKey.toString('hex')}` });
  }
  return wallets.get(seedByte);
}
export const SELLER = walletFor(SELLER_SEED_BYTE);
export const BUYER = walletFor(BUYER_SEED_BYTE);

export const mnemonicFor = (seedByte) => `TEST mnemonic seed ${seedByte}`;
/** The injected BIP-39 double: accepts only the run-time test mnemonics. */
export const validateMnemonic = (value) => typeof value === 'string' && MNEMONIC_PATTERN.test(value);
export const keyRecordBytes = (mnemonic, overrides = {}) => Buffer.from(JSON.stringify({ format: KEY_FORMAT, algorithm: 'ed25519', mnemonic, ...overrides }));

/** The injected derivation double. `record` holds every buffer it handed out or retained. */
export function derivationDouble({ claimOf = (wallet) => wallet.claim, privateKeyLength = 64, fail = null, cleanupError = null } = {}) {
  const record = { received: [], privateKeys: [], retained: [], cleanups: 0 };
  const derive = async (mnemonic) => {
    record.received.push(mnemonic);
    if (fail) throw fail(mnemonic);
    const wallet = walletFor(Number(MNEMONIC_PATTERN.exec(mnemonic)[1]));
    const ed25519PrivateKey = new Uint8Array(privateKeyLength);
    ed25519PrivateKey.set(Buffer.concat([wallet.seed, wallet.publicKey]).subarray(0, privateKeyLength));
    const retained = Buffer.from(wallet.seed);
    record.privateKeys.push(ed25519PrivateKey);
    record.retained.push(retained);
    return { claim: claimOf(wallet), ed25519PrivateKey, cleanup() { retained.fill(0); record.cleanups += 1; if (cleanupError) throw cleanupError; } };
  };
  return { derive, record };
}

/** A private data directory (0700) holding one key file (0600) with `record` as its bytes. Removed after the test. */
export function keyFixture(t, { seedByte = SELLER_SEED_BYTE, record = keyRecordBytes(mnemonicFor(seedByte)) } = {}) {
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-seller-key-')));
  chmodSync(dataDirectory, 0o700);
  const filePath = join(dataDirectory, 'seller.key');
  writeFileSync(filePath, record, { mode: 0o600 });
  t.after(() => { chmodSync(dataDirectory, 0o700); rmSync(dataDirectory, { recursive: true, force: true }); });
  return { dataDirectory, filePath, wallet: walletFor(seedByte) };
}

/** Diagnostic lines the key wrapper emitted, each as the JSON text a log sink would print. */
export function capturedLog() {
  const lines = [];
  return { lines, log: (entry) => { lines.push(JSON.stringify(entry)); } };
}

/** The options openSellerKey takes, for a key fixture, with a derivation double and a captured log. */
export function openOptions(fixture, { derivation = derivationDouble(), sink = capturedLog(), ...overrides } = {}) {
  return { filePath: fixture.filePath, dataDirectory: fixture.dataDirectory, keyFormat: KEY_FORMAT, listingSeller: fixture.wallet.claim,
    validateMnemonic, derive: derivation.derive, log: sink.log, ...overrides };
}

let sellerKeyModule = null;
/** Loads src/seller-key.mjs with the secrets subpath served by the loader spy. */
export async function importSellerKey() {
  if (sellerKeyModule === null) {
    register('./secret-loader-spy-hook.mjs', import.meta.url, { data: { spyUrl: new URL('./secret-loader-spy.mjs', import.meta.url).href } });
    sellerKeyModule = await import('../../src/seller-key.mjs');
  }
  return sellerKeyModule;
}

/** Catches the rejection of `run` and returns its `code`, `details` and the error; null when it does not throw. */
export async function refusalOf(run) {
  try { await run(); return null; } catch (error) { return { code: error.code, details: error.details, error }; }
}

/**
 * A TP-1 binding under the SDK's approved record and a test-only authority reader (the wire's own fixture pattern).
 * The reader first awaits `control.answer(scope)`, which a test may replace to refuse, delay or change the answer;
 * the decision it then returns is `control.decide(admitted)`. Returns `{ binding, control }`.
 */
export async function controlledBinding() {
  const record = wire.TP1_APPROVED_IDENTITY_RECORD;
  const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
  const control = { answer: () => undefined, decide: (admitted) => admitted, calls: [] };
  const readAuthority = async (scope) => {
    control.calls.push(scope);
    await control.answer(scope);
    return control.decide({ local: { ...scope.local }, chainIdentity: profile.chainIdentity, provenance: 'test-only-independent-authority/v1',
      sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) });
  };
  return { binding: await wire.bindTp1Profile({ record, local: LOCAL, readAuthority }), control };
}

/** A TP-1 binding whose test-only authority reader admits every scope. */
export const testBinding = async () => (await controlledBinding()).binding;

const LISTING_PIN = Object.freeze({ listingId: 'tp1-vector-listing', version: 1, contentHash: sha256Hex('contracts-vector-listing') });

/** A wire request payload to the seller from the buyer. */
export function requestPayload(binding, path, bodyText = '{}') {
  return { version: '1', kind: 'request', method: 'POST', path, bodyHash: sha256Hex(bodyText), jobId: JOB, buyer: BUYER.claim, seller: SELLER.claim,
    listingPin: LISTING_PIN, agreementHash: sha256Hex('agreement'), nonce: Buffer.alloc(16, 5).toString('base64url'), expiresAt: T0 + 30_000, profile: binding.profile };
}

/** The answer payload the wire builds for `request`: bound to its hash, status and exact body text. */
export function responsePayload(request, status, bodyText) {
  return { ...request, kind: 'response', bodyHash: sha256Hex(bodyText), expiresAt: T0 + 30_000, requestHash: wire.wireRequestHash(request), status };
}

/** A discovery payload for the seller under `binding`. */
export function discoveryPayload(binding, overrides = {}) {
  return { format: wire.DACS_SELLER_DISCOVERY_FORMAT, profile: binding.profile, seller: SELLER.claim, publicEndpoint: 'https://seller.example.invalid',
    transport: [wire.DACS_SELLER_HTTP_V1], listings: [LISTING_PIN], capabilities: wire.TP1_CAPABILITIES, ready: false, issuedAt: T0, expiresAt: T0 + 60_000, ...overrides };
}

/** True when `signature` verifies over `bytes` under the public key of `wallet`. */
export const verifiesUnder = (wallet, bytes, signature) => crypto.verify(null, bytes, wallet.publicKeyObject, signature);
