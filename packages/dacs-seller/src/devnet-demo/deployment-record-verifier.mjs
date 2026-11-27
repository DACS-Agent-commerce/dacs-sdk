// The signed deployment record: the deployer's Ed25519 signature over the eight-key evidence of one deployed node build,
// in one canonical JSON envelope. This module checks a record against the digest, key and age bound it is given.
import { canonicalize, ed25519Verify, isCanonicalBase64Url, publicKeyFromRaw, sha256Hex } from '@kynesyslabs/dacs';
import { canonicalNodeEndpoint, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../operations.mjs';

const RECORD_SCHEMA = 'dacs-testnet-deployment/v1';
const SIGNED_PREFIX = 'dacs-testnet-deployment:v1\n';
const RECORD_MAX_BYTES = 4 * 1024 * 1024;
const SIGNATURE_LENGTH = 86;
const ENVELOPE_KEYS = ['payload', 'schema', 'signature'];
const SIGNATURE_KEYS = ['algorithm', 'value'];
const EVIDENCE_KEYS = ['artifactSha256', 'chainIdentity', 'commit', 'dirty', 'endpoint', 'observedAt', 'qualifiedOperations', 'reportedVersion'];
const MAX_VERSION_LENGTH = 64;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const hasExactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === keys.join();
const unverified = (message, cause) => {
  const error = new OperationError('deployment_unqualified', message, 'node_build_unverified');
  if (cause !== undefined) error.cause = cause;
  throw error;
};
const isDistinctStringList = list => Array.isArray(list) && list.every(item => typeof item === 'string') && new Set(list).size === list.length;

/**
 * Returns null when `value` is deployment evidence of the exact shape: the eight keys `dirty` (boolean), `commit` (40 lowercase
 * hex), `artifactSha256` and `chainIdentity` (64 lowercase hex), `reportedVersion` (1 to 64 characters), `qualifiedOperations`
 * (distinct strings), `endpoint` (a string) and `observedAt` (a non-negative safe integer); otherwise what is wrong with it.
 */
export function deploymentEvidenceProblem(value) {
  if (!hasExactKeys(value, EVIDENCE_KEYS)) return 'the deployment evidence does not have exactly its eight keys';
  const { dirty, commit, artifactSha256, chainIdentity, reportedVersion, qualifiedOperations, endpoint, observedAt } = value;
  if (typeof dirty !== 'boolean' || !HEX_40.test(commit) || !HEX_64.test(artifactSha256) || !HEX_64.test(chainIdentity)) return 'the deployment evidence names no exact build';
  if (typeof reportedVersion !== 'string' || reportedVersion.length < 1 || reportedVersion.length > MAX_VERSION_LENGTH) return 'the deployment evidence has no reported version';
  if (!isDistinctStringList(qualifiedOperations) || typeof endpoint !== 'string') return 'the deployment evidence has no operation list or endpoint';
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) return 'the deployment evidence has no observation time';
  return null;
}

function parseCanonicalEnvelope(bytes) {
  let text, envelope;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    envelope = JSON.parse(text);
    if (canonicalize(envelope) !== text) throw new Error('the bytes are not the canonical JSON of their value');
  } catch (cause) { unverified('the deployment record is not canonical UTF-8 JSON', cause); }
  if (!hasExactKeys(envelope, ENVELOPE_KEYS) || envelope.schema !== RECORD_SCHEMA
    || !hasExactKeys(envelope.signature, SIGNATURE_KEYS) || envelope.signature.algorithm !== 'ed25519') unverified(`the deployment record is not one ${RECORD_SCHEMA} envelope`);
  return envelope;
}

/**
 * Verifies one signed deployment record and returns its eight-key evidence payload. `bytes` must hash (SHA-256, lowercase hex)
 * to `digest` and be the canonical JSON envelope `{schema: 'dacs-testnet-deployment/v1', payload, signature: {algorithm: 'ed25519',
 * value}}` with no other member, where `value` is the canonical 86-character base64url signature, under `publicKey` (64 lowercase
 * hex of the raw key), over `dacs-testnet-deployment:v1\n` followed by the canonical payload. With `testnetOnly` the payload
 * must name the approved testnet chain identity. Its endpoint must be a canonical node root for its chain, and its `observedAt`
 * at most `maxAgeMs` before `clock.now()` and not after it.
 * Throws TypeError for a missing or malformed input (`testnetOnly` must be a boolean), and OperationError('deployment_unqualified')
 * with details `node_build_unverified` for every record that does not verify.
 */
export function verifyDeploymentRecord(bytes, { digest, publicKey, clock, maxAgeMs, testnetOnly } = {}) {
  if (typeof testnetOnly !== 'boolean') throw new TypeError('testnetOnly must be a boolean');
  if (!(bytes instanceof Uint8Array) || !HEX_64.test(digest) || !HEX_64.test(publicKey) || typeof clock?.now !== 'function'
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new TypeError('verifyDeploymentRecord needs record bytes, a digest, a public key, a clock and an age bound');
  if (bytes.byteLength > RECORD_MAX_BYTES) unverified('the deployment record is over its byte limit');
  if (sha256Hex(bytes) !== digest) unverified('the deployment record is not the pinned record');
  const { payload, signature } = parseCanonicalEnvelope(bytes);
  const problem = deploymentEvidenceProblem(payload);
  if (problem) unverified(problem);
  if (signature.value.length !== SIGNATURE_LENGTH || !isCanonicalBase64Url(signature.value)) unverified('the deployment record signature is not canonical base64url');
  const signed = new TextEncoder().encode(SIGNED_PREFIX + canonicalize(payload));
  if (!ed25519Verify(signed, Buffer.from(signature.value, 'base64url'), publicKeyFromRaw(Buffer.from(publicKey, 'hex')))) unverified('the deployment record signature does not verify under the deployer key');
  if (testnetOnly && payload.chainIdentity !== TP1_APPROVED_IDENTITY_RECORD.chainIdentity) unverified('deployment record for another chain under a testnet-only deployer key');
  if (canonicalNodeEndpoint(payload.endpoint, { chainIdentity: payload.chainIdentity }) !== payload.endpoint) unverified('the deployment record endpoint is not a canonical node root');
  const age = clock.now() - payload.observedAt;
  if (!(age >= 0 && age <= maxAgeMs)) unverified('the deployment record is older than its age bound or from the future');
  return payload;
}
