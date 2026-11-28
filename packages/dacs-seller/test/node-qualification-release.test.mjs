// The release observation: a release compares one fresh, module-made observation of the serving build with the pinned build, once,
// immediately before publication. A saved, copied, stale or fixture observation, or another build, never authorizes a publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINT, T0 } from './helpers/seller-node-wallet-world.mjs';
import { EVIDENCE_MAX_AGE_MS, qualificationInputs } from './helpers/qualification-inputs.mjs';
import { importQualificationWith } from './helpers/qualified-builds-fixture.mjs';
import { RECORDED_REVIEWED_BUILD, shippedBuildEvidence } from './helpers/shipped-build-evidence.mjs';

const { assertReleaseQualification, QUALIFIED_NODE_BUILDS, readQualificationObservation } = await import('../src/devnet-demo/deployment-qualification.mjs');

const RELEASE_OBSERVATION_MAX_AGE_MS = 10_000;
const BUILD_B_ARTIFACT = 'b'.repeat(64);
const refusalOf = (call) => { try { call(); } catch (error) { return error; } return assert.fail('expected a refusal'); };
const pinOf = (entry) => ({ ...entry, qualifiedOperations: [...entry.qualifiedOperations] });

// A recording publish double behind the release check: it publishes only when the comparison passes.
function recordingRelease(check) {
  const published = [];
  return { published, release: (observation, pinned, clock) => { check(observation, pinned, { clock }); published.push(observation); } };
}

// A test clock that the test moves.
function movableClock(now = T0) {
  return { now: () => now, set(at) { now = at; } };
}

test('a release pin built from the shipped seven-field entry qualifies; the same pin with `dirty` omitted or changed refuses the release comparison before publication; dropping `dirty` from the comparison fails this test', async (t) => {
  const clock = movableClock(), { inputs } = await qualificationInputs(t, { clock });
  const { published, release } = recordingRelease(assertReleaseQualification);
  const entry = QUALIFIED_NODE_BUILDS[0];
  assert.deepEqual(Object.keys(entry).sort(), ['artifactSha256', 'chainIdentity', 'commit', 'dirty', 'evidenceMaxAgeMs', 'qualifiedOperations', 'reportedVersion']);
  release(await readQualificationObservation(inputs), pinOf(entry), clock);
  assert.equal(published.length, 1);
  const { dirty, ...withoutDirty } = pinOf(entry);
  for (const [label, pin] of [['dirty omitted', withoutDirty], ['dirty changed', { ...pinOf(entry), dirty: !dirty }]]) {
    const observation = await readQualificationObservation(inputs);
    assert.deepEqual([refusalOf(() => release(observation, pin, clock)).details], ['node_build_drift'], label);
  }
  assert.equal(published.length, 1, 'no refused comparison published');
});

test('build A qualified and pinned, then build B with the same version and chain, both reviewed entries (a synthetic two-entry list through the second module instance): a newly read B observation refuses against pin A and the recording publish double sees zero calls until qualification reruns; a fresh A observation against pin A passes and the double sees exactly one call', async (t) => {
  const buildA = pinOf(QUALIFIED_NODE_BUILDS[0]), buildB = { ...pinOf(QUALIFIED_NODE_BUILDS[0]), artifactSha256: BUILD_B_ARTIFACT };
  const twoBuilds = await importQualificationWith({ builds: [buildA, buildB] });
  let serving = buildA;
  const clock = movableClock();
  const { inputs } = await qualificationInputs(t, { clock,
    readDeploymentEvidence: () => ({ ...shippedBuildEvidence({ endpoint: ENDPOINT, observedAt: clock.now() }), artifactSha256: serving.artifactSha256 }) });
  const { published, release } = recordingRelease(twoBuilds.assertReleaseQualification);
  release(await twoBuilds.readQualificationObservation(inputs), buildA, clock);
  assert.equal(published.length, 1, 'build A qualified and was published once');

  serving = buildB;
  const observationB = await twoBuilds.readQualificationObservation(inputs);
  assert.equal(observationB.artifactSha256, BUILD_B_ARTIFACT, 'build B is itself a reviewed build');
  assert.equal(refusalOf(() => release(observationB, buildA, clock)).details, 'node_build_drift');
  assert.equal(published.length, 1, 'zero further calls while the serving build is B');
  serving = buildA;
  release(await twoBuilds.readQualificationObservation(inputs), buildA, clock);
  assert.equal(published.length, 2, 'a fresh A observation passes: exactly one more call');
});

test('through readQualificationObservation, unavailable verification, expired evidence, a wrapped currentLocal that changes connectionId during the read and TEST-derived evidence each refuse release with their cause', async (t) => {
  const clock = movableClock(), node = (await import('./helpers/seller-node-wallet-world.mjs')).replayNode();
  const { inputs } = await qualificationInputs(t, { clock, node });
  const { published, release } = recordingRelease(assertReleaseQualification);
  const failure = new Error('TEST-verification-unavailable');
  const unavailable = await readQualificationObservation({ ...inputs, readDeploymentEvidence: () => { throw failure; } }).catch((error) => error);
  assert.deepEqual([unavailable.details, unavailable.cause], ['node_build_unavailable', failure]);
  const expired = await readQualificationObservation({ ...inputs, readDeploymentEvidence: () => shippedBuildEvidence({ endpoint: ENDPOINT, observedAt: T0 - EVIDENCE_MAX_AGE_MS - 1 }) })
    .catch((error) => error);
  assert.equal(expired.details, 'node_build_unverified');
  // The connection generation changes while the node's version is read: the wrapped currentLocal answers another connection after it.
  let switched = false;
  const currentLocal = () => (switched ? { ...inputs.currentLocal(), connectionId: 'TEST-other-connection' } : inputs.currentLocal());
  node.reply = (row) => { if (row.body?.params[0]?.message === 'getNetworkInfo') switched = true; return undefined; };
  const changed = await readQualificationObservation({ ...inputs, currentLocal }).catch((error) => error);
  assert.equal(changed.details, 'node_build_drift');
  node.reply = null;
  const world = await (await import('./helpers/seller-node-wallet-world.mjs')).sellerWalletWorld(t);
  const fixture = await readQualificationObservation({ binding: world.admission.binding, currentLocal: world.admission.currentLocal, observer: world.wallet.observer,
    source: world.wallet.sourceCapability, clock, readDeploymentEvidence: () => shippedBuildEvidence({ endpoint: ENDPOINT, observedAt: clock.now() }) });
  assert.equal(refusalOf(() => release(fixture, pinOf(QUALIFIED_NODE_BUILDS[0]), clock)).details, 'node_build_fixture');
  assert.equal(published.length, 0);
});

test('assertReleaseQualification consumes a module-made A observation on the first comparison, then refuses the same object on a second comparison even when its evidence and observation ages remain in bounds; a copy also refuses and publish calls stay zero', async (t) => {
  const clock = movableClock(), { inputs } = await qualificationInputs(t, { clock });
  const { published, release } = recordingRelease(assertReleaseQualification);
  const pin = pinOf(QUALIFIED_NODE_BUILDS[0]);
  const observation = await readQualificationObservation(inputs);
  const copy = structuredClone(observation);
  release(observation, pin, clock);
  assert.equal(published.length, 1, 'the first comparison publishes');
  assert.equal(refusalOf(() => release(observation, pin, clock)).details, 'node_build_unverified', 'the same object again');
  assert.equal(refusalOf(() => release(copy, pin, clock)).details, 'node_build_unverified', 'a copy');
  const refusedFirst = await readQualificationObservation(inputs);
  assert.equal(refusalOf(() => release(refusedFirst, { ...pin, commit: 'c'.repeat(40) }, clock)).details, 'node_build_drift');
  assert.equal(refusalOf(() => release(refusedFirst, pin, clock)).details, 'node_build_unverified', 'a refused comparison consumes the observation too');
  assert.equal(published.length, 1, 'no publish call after the first');
});

test('an observation older than RELEASE_OBSERVATION_MAX_AGE_MS, an observation from the future, or a missing clock refuses release before publication', async (t) => {
  const clock = movableClock(), { inputs } = await qualificationInputs(t, { clock });
  const { published, release } = recordingRelease(assertReleaseQualification);
  const pin = pinOf(QUALIFIED_NODE_BUILDS[0]);
  const old = await readQualificationObservation(inputs);
  clock.set(T0 + RELEASE_OBSERVATION_MAX_AGE_MS + 1);
  assert.equal(refusalOf(() => release(old, pin, clock)).details, 'node_build_unverified', 'older than 10 s');
  clock.set(T0);
  const future = await readQualificationObservation(inputs);
  clock.set(T0 - 1);
  assert.equal(refusalOf(() => release(future, pin, clock)).details, 'node_build_unverified', 'from the future');
  clock.set(T0);
  const unclocked = await readQualificationObservation(inputs);
  assert.throws(() => assertReleaseQualification(unclocked, pin), TypeError);
  assert.throws(() => assertReleaseQualification(unclocked, pin, { clock: {} }), TypeError);
  assert.equal(published.length, 0);
  clock.set(T0 + RELEASE_OBSERVATION_MAX_AGE_MS);
  release(unclocked, pin, clock);
  assert.equal(published.length, 1, 'exactly 10 s old still compares, and the missing clock consumed nothing');
  assert.equal(RECORDED_REVIEWED_BUILD.reportedVersion, unclocked.reportedVersion);
});
