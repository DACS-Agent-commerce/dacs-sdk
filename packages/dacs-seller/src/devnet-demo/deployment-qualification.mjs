// Node qualification. A native write is signed and sent only to a serving node whose build is a reviewed one: the host's
// deployment evidence must name a reviewed build, the bound endpoint and chain, and be current, and the node's own version
// answer must agree on the connection the write uses. The node's self-report alone never qualifies a build.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { canonicalNodeEndpoint, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { tp1AuthorityLabel } from '@kynesyslabs/dacs-client/node-wallet';
import { isDevnetDemoTransport, isQualificationObserverSource } from '../dacs/devnet-source.mjs';
import { deepFreeze } from '../dacs/seller-challenge-ledger.mjs';
import { OperationError } from '../operations.mjs';
import { boundedResolutionValue, isResolverDeadline, resolveWithDeadline } from '../util/bounded-resolution.mjs';
import { deploymentEvidenceProblem, verifyDeploymentRecord } from './deployment-record-verifier.mjs';
import { QUALIFICATION_OPERATIONS } from './qualification-operations.mjs';

/** The reviewed node builds, deep-frozen; only these qualify, and a release pins and compares all seven fields of one. */
export const QUALIFIED_NODE_BUILDS = deepFreeze([
  // The approved testnet's node, commit e6af8f4 as deployed with local edits (dirty, accepted only for that chain). The digest
  // is of our own rebuild of that commit with its wstcp stage pinned to rust:1.99.1-slim@sha256:e6cd1d294a300601eaaa4a294b337e5f0826f427fb2d481e9f76e69e7981e244,
  // because the commit's unpinned stage no longer builds; nothing claims the deployed binary matches this digest.
  { chainIdentity: 'd59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc', reportedVersion: '0.9.9 RC', commit: 'e6af8f4023fa4e77f482503dae97f1ca00834bf9',
    artifactSha256: 'c75d2b327254e70152de16747760c78415199e47a1e440e16a3ed2f27f8ae5fb', dirty: true, qualifiedOperations: ['fee', 'nonce', 'broadcast', 'confirmation'],
    evidenceMaxAgeMs: 2_592_000_000 },
]);

// The packaged record's SHA-256 and the deployer's raw Ed25519 key; both change only in a reviewed release. The key is a
// testnet-only test key and proves nothing about mainnet: while it is the pin, every build and record must be the approved testnet's.
const PINNED_DEPLOYMENT_SHA256 = 'c504b401230874fc1918d5257b7850b1cd8859b5dcb879a30eaaed2d9446c1c0';
const PINNED_DEPLOYER_PUBLIC_KEY = '99937d163c9aa5e723e76860cc2e991c0ad17260ce96f0fa70ca9270a25ba1bc';
const PINNED_DEPLOYER_KEY_TESTNET_ONLY = true;
const APPROVED_TESTNET_CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
for (const build of QUALIFIED_NODE_BUILDS) {
  if (build.dirty && build.chainIdentity !== APPROVED_TESTNET_CHAIN) throw new Error(`a dirty node build is reviewed only for the approved testnet chain, not ${build.chainIdentity}`);
}
for (const build of PINNED_DEPLOYER_KEY_TESTNET_ONLY ? QUALIFIED_NODE_BUILDS : []) {
  if (build.chainIdentity !== APPROVED_TESTNET_CHAIN) throw new Error('testnet-only deployer key pin cannot qualify chain ' + build.chainIdentity);
}

const RECORD_DIRECTORY = new URL('../../vectors/testnet-records/', import.meta.url);
const READ_MAX_BYTES = 4 * 1024 * 1024;
const DEPLOYMENT_EVIDENCE_MAX_AGE_MS = 2_592_000_000;
const QUALIFICATION_DEADLINE_MS = 10_000;
const RELEASE_OBSERVATION_MAX_AGE_MS = 10_000;
const EVIDENCE_LIMITS = Object.freeze({ maxBytes: READ_MAX_BYTES, maxValues: 13, maxDepth: 3, maxListEntries: 4 });
const NODE_INFO_LIMITS = Object.freeze({ maxBytes: READ_MAX_BYTES, maxValues: 256, maxDepth: 8, maxListEntries: 64 });
const MAX_VERSION_LENGTH = 64;
const BUILD_IDENTITY = Object.freeze(['chainIdentity', 'commit', 'artifactSha256', 'reportedVersion', 'dirty']);
const PUBLICATIONS = Object.freeze(['settlementPublication', 'deliveryPublication', 'demoArtifactPublication']);
// Every observation readQualificationObservation made and no release check has compared yet.
const releaseObservations = new WeakSet();

const refusal = (reason, message, cause) => Object.assign(new OperationError('deployment_unqualified', message, reason), cause === undefined ? {} : { cause });
const unverified = (message, cause) => { throw refusal('node_build_unverified', message, cause); };
// True when `list` holds exactly the strings of `expected`, each once, in any order.
const sameSet = (list, expected) => Array.isArray(list) && list.length === expected.length && expected.every(item => list.includes(item));

// One packaged record file, opened without following a symlink: a regular file of at most READ_MAX_BYTES, read whole.
async function readRecordFile(name, signal) {
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(new URL(name, RECORD_DIRECTORY), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat(), { size } = stats;
    if (!stats.isFile()) throw new Error(`${name} is not a regular file`);
    if (size > READ_MAX_BYTES) unverified(`${name} is over its byte limit`);
    const bytes = Buffer.alloc(size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== size) unverified(`${name} changed while it was read`);
    return bytes.subarray(0, size);
  } catch (cause) {
    throw cause instanceof OperationError ? cause : refusal('node_build_unavailable', `the packaged record file ${name} cannot be read`, cause);
  } finally { await handle?.close(); }
}

/**
 * Resolves the bytes of this package's signed deployment record (`vectors/testnet-records/`) once they and its digest and key files
 * match the module's pins. Rejects deployment_unqualified: node_build_unavailable for a missing, unreadable or symlinked file or
 * an abort (cause kept), node_build_unverified for any byte that differs from the pins.
 */
export async function readPackagedDeploymentRecord({ signal } = {}) {
  const record = await readRecordFile('deployment-record.json', signal), digest = await readRecordFile('deployment.sha256', signal);
  const key = await readRecordFile('deployer-public-key.json', signal);
  if (digest.toString('latin1') !== PINNED_DEPLOYMENT_SHA256 || key.toString('latin1') !== JSON.stringify(PINNED_DEPLOYER_PUBLIC_KEY)) unverified('the packaged digest or key file is not the pinned one');
  if (sha256Hex(record) !== PINNED_DEPLOYMENT_SHA256) unverified('the packaged deployment record is not the pinned record');
  return new Uint8Array(record);
}

/**
 * Returns the production `readDeploymentEvidence({signal})`: each call verifies `recordBytes` with the pinned digest and key and the
 * exact 30-day `evidenceMaxAgeMs` on `clock` and resolves the evidence payload, or rejects as verifyDeploymentRecord. Throws TypeError.
 */
export function createVerifiedDeploymentEvidenceReader({ recordBytes, evidenceMaxAgeMs, clock } = {}) {
  if (evidenceMaxAgeMs !== DEPLOYMENT_EVIDENCE_MAX_AGE_MS) throw new TypeError(`evidenceMaxAgeMs must be ${DEPLOYMENT_EVIDENCE_MAX_AGE_MS}`);
  if (!(recordBytes instanceof Uint8Array) || typeof clock?.now !== 'function') throw new TypeError('the verified deployment reader needs recordBytes and a clock');
  return async ({ signal } = {}) => {
    signal?.throwIfAborted();
    return verifyDeploymentRecord(recordBytes, { digest: PINNED_DEPLOYMENT_SHA256, publicKey: PINNED_DEPLOYER_PUBLIC_KEY, clock,
      maxAgeMs: evidenceMaxAgeMs, testnetOnly: PINNED_DEPLOYER_KEY_TESTNET_ONLY });
  };
}

// A read, then its bounded copy: a failed read is a timeout (signal ended or observer timeout) or unavailable, cause kept.
async function boundedRead(read, signal, limits, what) {
  let answer;
  try {
    signal.throwIfAborted();
    answer = await read();
  } catch (cause) {
    throw refusal(signal.aborted || cause?.code === 'tp1_authority_timeout' ? 'node_build_timeout' : 'node_build_unavailable', `the ${what} read did not answer`, cause);
  }
  try { return limits ? boundedResolutionValue(answer, limits) : answer; } catch (cause) { return unverified(`the ${what} is over its read limits or not JSON`, cause); }
}

// The reviewed build the evidence names, for the bound endpoint and chain, with exactly the native write operations, current on `clock`.
function reviewedBuildOf(evidence, binding, clock) {
  const problem = deploymentEvidenceProblem(evidence), { endpoint, chainIdentity } = evidence ?? {};
  if (problem) unverified(problem);
  if (canonicalNodeEndpoint(endpoint, { chainIdentity: binding.profile.chainIdentity }) !== endpoint || endpoint !== binding.local.endpoint) unverified('the deployment evidence is for another endpoint');
  if (chainIdentity !== binding.profile.chainIdentity) unverified('the deployment evidence is for another chain');
  const build = QUALIFIED_NODE_BUILDS.find(entry => BUILD_IDENTITY.every(key => entry[key] === evidence[key]));
  if (!build) unverified('no reviewed node build matches the deployment evidence');
  if (!sameSet(build.qualifiedOperations, QUALIFICATION_OPERATIONS) || !sameSet(evidence.qualifiedOperations, QUALIFICATION_OPERATIONS)) unverified('the deployment evidence does not qualify exactly the native write operations');
  const age = clock.now() - evidence.observedAt;
  if (!(age >= 0 && age <= build.evidenceMaxAgeMs)) unverified('the deployment evidence is older than its bound or from the future');
  return build;
}

// The connection generation and the version the node reports on it, read through the fence-free observer.
async function readServingBuild(observer, binding, signal) {
  const observed = await boundedRead(() => observer.observe({ signal }), signal, null, 'node connection');
  if (observed?.local?.endpoint !== binding.local.endpoint || observed.chainIdentity !== binding.profile.chainIdentity) unverified('the observed connection is not the bound endpoint and chain');
  const { nodeVersion } = await boundedRead(() => observer.readNodeInfo('getNetworkInfo', { signal }), signal, NODE_INFO_LIMITS, 'node build') ?? {};
  const version = nodeVersion?.version;
  if (Array.isArray(nodeVersion) || typeof version !== 'string' || version.length < 1 || version.length > MAX_VERSION_LENGTH) unverified('the node build answer has no version');
  return { generation: observed.local.connectionId, version };
}

// `live` when every declared publication names the binding's TP-1 label, `fixture` when one is a TEST- label; the source must be
// one the client registered: the composition's demo transport or the same-owner qualification observer source.
function authorityClassOf({ source, binding, currentLocal, observer }) {
  const registered = isDevnetDemoTransport(source) || isQualificationObserverSource(source, { binding, currentLocal, observer });
  const labels = registered ? PUBLICATIONS.filter(name => source[name] != null).map(name => source[name].authority) : [];
  if (labels.length === 0) unverified('the source declares no publication of a registered composition');
  if (labels.some(label => typeof label === 'string' && label.startsWith('TEST-'))) return 'fixture';
  let live;
  try { live = tp1AuthorityLabel(binding); } catch (cause) { unverified('the binding has no TP-1 authority label', cause); }
  if (!labels.every(label => label === live)) unverified('the declared publications are not the binding\'s own authority');
  return 'live';
}

// The one qualification read, under one deadline linked to the caller's signal when there is one. Nothing is cached.
async function verifiedObservation({ binding, currentLocal, observer, readDeploymentEvidence, source, clock, signal }) {
  try {
    return await resolveWithDeadline(async ({ signal: deadline }) => {
      const linked = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const evidence = await boundedRead(() => readDeploymentEvidence({ signal: linked }), linked, EVIDENCE_LIMITS, 'deployment evidence');
      const build = reviewedBuildOf(evidence, binding, clock);
      const { generation, version } = await readServingBuild(observer, binding, linked);
      if (version !== build.reportedVersion) throw refusal('node_build_drift', 'the node reports another version than the reviewed build');
      const current = await boundedRead(() => currentLocal().connectionId, linked, null, 'connection');
      if (current !== generation) throw refusal('node_build_drift', 'the connection changed during the qualification read');
      const authorityClass = authorityClassOf({ source, binding, currentLocal, observer });
      return deepFreeze({ commit: build.commit, artifactSha256: build.artifactSha256, dirty: build.dirty, reportedVersion: build.reportedVersion,
        chainIdentity: build.chainIdentity, qualifiedOperations: [...build.qualifiedOperations], endpoint: evidence.endpoint, connectionGeneration: generation,
        evidence: { digest: sha256Hex(canonicalize(evidence)), observedAt: evidence.observedAt, maxAgeMs: build.evidenceMaxAgeMs }, authorityClass, observedAt: clock.now() });
    }, { timeoutMs: QUALIFICATION_DEADLINE_MS });
  } catch (cause) {
    throw isResolverDeadline(cause) ? refusal('node_build_timeout', 'the qualification read did not finish within its deadline', cause) : cause;
  }
}

/**
 * The check the effect gate awaits through the wallet's `qualify`: within 10 s, `readDeploymentEvidence({signal})` (JSON bytes or value)
 * must match a reviewed build, the binding and the age bound on `clock`, and `observer` must show its version on an unchanged connection
 * of a registered `source`. Resolves the connectionId. Rejects deployment_unqualified (node_build_unverified, _drift, _unavailable or
 * _timeout), cause kept, its message prefixed with `phase`.
 */
export async function assertQualifiedDeployment({ phase, ...inputs }) {
  try { return (await verifiedObservation(inputs)).connectionGeneration; } catch (error) {
    if (error instanceof OperationError) error.message = `${phase}: ${error.message}`;
    throw error;
  }
}

/**
 * Resolves, after assertQualifiedDeployment's checks, a deep-frozen observation of the serving build (its seven build fields, `endpoint`,
 * `connectionGeneration`, `evidence: {digest, observedAt, maxAgeMs}`, `authorityClass` 'live' or 'fixture', `observedAt`) for one release check.
 */
export async function readQualificationObservation(inputs) {
  const observation = await verifiedObservation(inputs);
  releaseObservations.add(observation);
  return observation;
}

/**
 * Checks that `observation`, a readQualificationObservation answer not compared before (the first call consumes it), is `live`, of the
 * `pinned` build's seven fields, with current evidence and at most 10 s old on `clock`. Throws TypeError without a clock;
 * deployment_unqualified: node_build_unverified (not fresh, stale or future), node_build_fixture or node_build_drift (another build).
 */
export function assertReleaseQualification(observation, pinned, { clock } = {}) {
  if (typeof clock?.now !== 'function') throw new TypeError('assertReleaseQualification needs a clock');
  if (!releaseObservations.delete(observation)) unverified('the release check needs a fresh observation from readQualificationObservation');
  if (observation.authorityClass !== 'live') throw refusal('node_build_fixture', 'a fixture observation is not release evidence');
  const now = clock.now(), age = now - observation.observedAt;
  if (!(now - observation.evidence.observedAt <= observation.evidence.maxAgeMs)) unverified('the deployment evidence is older than its bound');
  if (!(age >= 0 && age <= RELEASE_OBSERVATION_MAX_AGE_MS)) unverified('the observation is too old or from the future for a release check');
  if (!BUILD_IDENTITY.every(key => observation[key] === pinned?.[key]) || !sameSet(pinned?.qualifiedOperations, observation.qualifiedOperations)) {
    throw refusal('node_build_drift', 'the serving build is not the pinned build');
  }
}
