// Node qualification. A native write is signed and sent only to a serving node whose build is a reviewed one: the host's
// deployment evidence must name a reviewed build in QUALIFIED_NODE_BUILDS, the bound endpoint and chain, and be current, and
// the node's own version answer must agree, all on the connection the write uses. The seller's effect gate runs this check
// before each signature and transmission. The node's self-report alone never qualifies a build.
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

const APPROVED_TESTNET_CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;

/**
 * The reviewed node builds, deep-frozen: `{chainIdentity, reportedVersion, commit, artifactSha256, dirty, qualifiedOperations,
 * evidenceMaxAgeMs}`. Only these builds qualify; a release pins and compares all seven fields.
 */
export const QUALIFIED_NODE_BUILDS = deepFreeze([
  {
    // The approved testnet's serving node, commit e6af8f4 as deployed. It reports local edits, so `dirty` is true, which is
    // accepted only for the approved testnet chain. artifactSha256 is the image of our own rebuild of that commit with one
    // deviation, the wstcp stage pinned to rust:1.99.1-slim@sha256:e6cd1d294a300601eaaa4a294b337e5f0826f427fb2d481e9f76e69e7981e244
    // because the commit's unpinned stage no longer builds; nothing claims the deployed binary matches this digest.
    chainIdentity: 'd59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc',
    reportedVersion: '0.9.9 RC',
    commit: 'e6af8f4023fa4e77f482503dae97f1ca00834bf9',
    artifactSha256: 'c75d2b327254e70152de16747760c78415199e47a1e440e16a3ed2f27f8ae5fb',
    dirty: true,
    qualifiedOperations: ['fee', 'nonce', 'broadcast', 'confirmation'],
    evidenceMaxAgeMs: 2_592_000_000,
  },
]);

// The packaged signed deployment record's SHA-256 and the deployer's raw Ed25519 public key; both change only in a reviewed release.
const PINNED_DEPLOYMENT_SHA256 = 'c504b401230874fc1918d5257b7850b1cd8859b5dcb879a30eaaed2d9446c1c0';
// A testnet-only test key: it proves nothing about mainnet. While it is the pin, every reviewed build and every record it
// verifies must be for the approved testnet chain; any other network needs the owner's deployer key.
const PINNED_DEPLOYER_PUBLIC_KEY = '99937d163c9aa5e723e76860cc2e991c0ad17260ce96f0fa70ca9270a25ba1bc';
const PINNED_DEPLOYER_KEY_TESTNET_ONLY = true;

// A dirty build is reviewed only for the approved testnet chain; under the testnet-only key pin, so is every build.
for (const build of QUALIFIED_NODE_BUILDS) {
  if (build.dirty && build.chainIdentity !== APPROVED_TESTNET_CHAIN) throw new Error(`a dirty node build is reviewed only for the approved testnet chain, not ${build.chainIdentity}`);
}
for (const build of PINNED_DEPLOYER_KEY_TESTNET_ONLY ? QUALIFIED_NODE_BUILDS : []) {
  if (build.chainIdentity !== APPROVED_TESTNET_CHAIN) throw new Error('testnet-only deployer key pin cannot qualify chain ' + build.chainIdentity);
}

const RECORD_DIRECTORY = new URL('../../vectors/testnet-records/', import.meta.url);
const RECORD_FILES = Object.freeze(['deployment-record.json', 'deployment.sha256', 'deployer-public-key.json']);
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

const refusal = (reason, message, cause) => {
  const error = new OperationError('deployment_unqualified', message, reason);
  if (cause !== undefined) error.cause = cause;
  return error;
};
const unverified = (message, cause) => { throw refusal('node_build_unverified', message, cause); };
// True when `list` holds exactly the strings of `expected`, each once, in any order.
const sameSet = (list, expected) => Array.isArray(list) && list.length === expected.length && expected.every(item => list.includes(item));

// One packaged record file: opened without following a symlink, a regular file of at most READ_MAX_BYTES, read whole.
async function readRecordFile(name, signal) {
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(new URL(name, RECORD_DIRECTORY), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${name} is not a regular file`);
    if (stats.size > READ_MAX_BYTES) unverified(`${name} is over its byte limit`);
    const bytes = Buffer.alloc(stats.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    signal?.throwIfAborted();
    if (bytesRead !== stats.size) unverified(`${name} changed while it was read`);
    return bytes.subarray(0, bytesRead);
  } catch (cause) {
    throw cause instanceof OperationError ? cause : refusal('node_build_unavailable', `the packaged deployment record file ${name} cannot be read`, cause);
  } finally {
    await handle?.close();
  }
}

/**
 * Resolves the exact bytes of the packaged signed deployment record (`vectors/testnet-records/` of this package), once its
 * digest file and deployer key file are the module's reviewed pins and the record hashes to that digest. Each file is opened
 * without following a symlink, must be a regular file and is read under a 4 MiB cap; an aborted `signal` stops the reads.
 * Rejects OperationError('deployment_unqualified') with details `node_build_unavailable` (a missing or unreadable file, or the
 * abort, cause kept) or `node_build_unverified` (any byte that differs from the pins).
 */
export async function readPackagedDeploymentRecord({ signal } = {}) {
  const files = [];
  for (const name of RECORD_FILES) files.push(await readRecordFile(name, signal));
  const [record, digest, key] = files;
  if (digest.toString('latin1') !== PINNED_DEPLOYMENT_SHA256) unverified('the packaged digest file is not the pinned digest');
  if (key.toString('latin1') !== JSON.stringify(PINNED_DEPLOYER_PUBLIC_KEY)) unverified('the packaged deployer key file is not the pinned key');
  if (sha256Hex(record) !== PINNED_DEPLOYMENT_SHA256) unverified('the packaged deployment record is not the pinned record');
  return new Uint8Array(record);
}

/**
 * Returns the production `readDeploymentEvidence({signal})` over `recordBytes` (from readPackagedDeploymentRecord): each call
 * verifies the record against the module's pinned digest and deployer key, the testnet-only key rule and the age bound on
 * `clock`, and resolves only its eight-key evidence payload. `evidenceMaxAgeMs` must be exactly 2,592,000,000 (30 days).
 * Throws TypeError for any other bound, record or clock; each call rejects as verifyDeploymentRecord throws, or with the abort reason.
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

// A host or node read: its failure keeps its cause, as a timeout once the signal ended or the observer timed out.
async function boundedRead(read, signal) {
  try {
    signal.throwIfAborted();
    return await read();
  } catch (cause) {
    const timedOut = signal.aborted || cause?.code === 'tp1_authority_timeout';
    throw refusal(timedOut ? 'node_build_timeout' : 'node_build_unavailable', 'the deployment evidence or node build read did not answer', cause);
  }
}

function boundedCopy(answer, limits, what) {
  try { return boundedResolutionValue(answer, limits); } catch (cause) { return unverified(`the ${what} is over its read limits or not JSON`, cause); }
}

async function readEvidence(readDeploymentEvidence, signal) {
  const evidence = boundedCopy(await boundedRead(() => readDeploymentEvidence({ signal }), signal), EVIDENCE_LIMITS, 'deployment evidence');
  const problem = deploymentEvidenceProblem(evidence);
  if (problem) unverified(problem);
  return evidence;
}

// The reviewed build the evidence names, for the bound endpoint and chain, with exactly the native write operations, current on `clock`.
function reviewedBuildOf(evidence, binding, clock) {
  const { endpoint, chainIdentity } = evidence;
  if (canonicalNodeEndpoint(endpoint, { chainIdentity: binding.profile.chainIdentity }) !== endpoint || endpoint !== binding.local.endpoint) unverified('the deployment evidence is for another endpoint');
  if (chainIdentity !== binding.profile.chainIdentity) unverified('the deployment evidence is for another chain');
  const build = QUALIFIED_NODE_BUILDS.find(entry => BUILD_IDENTITY.every(key => entry[key] === evidence[key]));
  if (!build) unverified('no reviewed node build matches the deployment evidence');
  if (!sameSet(build.qualifiedOperations, QUALIFICATION_OPERATIONS) || !sameSet(evidence.qualifiedOperations, QUALIFICATION_OPERATIONS)) unverified('the deployment evidence does not qualify exactly the native write operations');
  const age = clock.now() - evidence.observedAt;
  if (!(age >= 0 && age <= build.evidenceMaxAgeMs)) unverified('the deployment evidence is older than its bound or from the future');
  return build;
}

// The serving connection's generation and the version the node reports on it, read through the fence-free observer.
async function readServingBuild(observer, binding, signal) {
  const observed = await boundedRead(() => observer.observe({ signal }), signal);
  if (observed?.local?.endpoint !== binding.local.endpoint || observed.chainIdentity !== binding.profile.chainIdentity) unverified('the observed connection is not the bound endpoint and chain');
  const info = boundedCopy(await boundedRead(() => observer.readNodeInfo('getNetworkInfo', { signal }), signal), NODE_INFO_LIMITS, 'node build answer');
  const nodeVersion = info?.nodeVersion, version = nodeVersion?.version;
  if (nodeVersion === null || typeof nodeVersion !== 'object' || Array.isArray(nodeVersion) || typeof version !== 'string'
    || version.length < 1 || version.length > MAX_VERSION_LENGTH) unverified('the node build answer has no version');
  return { generation: observed.local.connectionId, version };
}

function currentGeneration(currentLocal) {
  try { return currentLocal().connectionId; } catch (cause) { throw refusal('node_build_unavailable', 'the connection cannot be read', cause); }
}

// `live` when every declared publication names the binding's TP-1 label, `fixture` when one is a TEST- label, from a source
// the client registered: the composition's demo transport or the same-owner qualification observer source.
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

// The one qualification read, under one deadline, linked to the caller's signal when there is one. Nothing is cached.
async function verifiedObservation({ binding, currentLocal, observer, readDeploymentEvidence, source, clock, signal }) {
  try {
    return await resolveWithDeadline(async ({ signal: deadline }) => {
      const linked = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const evidence = await readEvidence(readDeploymentEvidence, linked);
      const build = reviewedBuildOf(evidence, binding, clock);
      const { generation, version } = await readServingBuild(observer, binding, linked);
      if (version !== build.reportedVersion) throw refusal('node_build_drift', 'the node reports another version than the reviewed build');
      if (currentGeneration(currentLocal) !== generation) throw refusal('node_build_drift', 'the connection changed during the qualification read');
      const authorityClass = authorityClassOf({ source, binding, currentLocal, observer });
      return deepFreeze({ commit: build.commit, artifactSha256: build.artifactSha256, dirty: build.dirty, reportedVersion: build.reportedVersion,
        chainIdentity: build.chainIdentity, qualifiedOperations: [...build.qualifiedOperations], endpoint: evidence.endpoint, connectionGeneration: generation,
        evidence: { digest: sha256Hex(canonicalize(evidence)), observedAt: evidence.observedAt, maxAgeMs: build.evidenceMaxAgeMs }, authorityClass, observedAt: clock.now() });
    }, { timeoutMs: QUALIFICATION_DEADLINE_MS });
  } catch (cause) {
    if (isResolverDeadline(cause)) throw refusal('node_build_timeout', 'the qualification read did not finish within its deadline', cause);
    throw cause;
  }
}

/**
 * The seller's qualification check, which the effect gate awaits through the wallet's `qualify`. Reads the host's
 * `readDeploymentEvidence({signal})` (UTF-8 JSON bytes or a JSON value), then the node's connection and `getNetworkInfo` version
 * through `observer`, all within 10 s, and resolves the connection generation (`connectionId`) the reads ran on. The evidence
 * must match a reviewed build of QUALIFIED_NODE_BUILDS, the binding's endpoint and chain, and be within the build's age bound
 * on `clock`; the node must report the build's version on an unchanged connection; `source` must be the composition's
 * registered transport or the same-owner observer source. `phase` names the gate phase or preflight in a refusal.
 * Rejects OperationError('deployment_unqualified') with details node_build_unverified, node_build_drift,
 * node_build_unavailable or node_build_timeout, the original error kept as `cause`.
 */
export async function assertQualifiedDeployment({ phase, ...inputs }) {
  try {
    return (await verifiedObservation(inputs)).connectionGeneration;
  } catch (error) {
    if (error instanceof OperationError) error.message = `${phase}: ${error.message}`;
    throw error;
  }
}

/**
 * Resolves a deep-frozen observation of the serving build after the checks of assertQualifiedDeployment: `{commit, artifactSha256,
 * dirty, reportedVersion, chainIdentity, qualifiedOperations, endpoint, connectionGeneration, evidence: {digest, observedAt, maxAgeMs},
 * authorityClass ('live' or 'fixture'), observedAt}`, kept for one assertReleaseQualification. Rejects as assertQualifiedDeployment does.
 */
export async function readQualificationObservation(inputs) {
  const observation = await verifiedObservation(inputs);
  releaseObservations.add(observation);
  return observation;
}

/**
 * Checks that `observation`, one readQualificationObservation made in this process and not compared before, is a `live`
 * observation of the `pinned` build (its seven fields, operations as a set), with evidence current on `clock` and the
 * observation itself at most 10 s old. The first call consumes the observation, refused or not. Returns nothing.
 * Throws TypeError without a clock; OperationError('deployment_unqualified') with details node_build_unverified (not a fresh
 * module-made observation, stale or future), node_build_fixture or node_build_drift (another build than the pinned one).
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
