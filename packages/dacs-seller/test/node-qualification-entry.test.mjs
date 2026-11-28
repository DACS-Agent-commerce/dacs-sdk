// The shipped reviewed build list and the packaged deployment record: the list equals the recorded reviewed build and cannot be
// changed at run time; the operation list is one frozen export; the three record files agree with the module's pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENDPOINT, T0 } from './helpers/seller-node-wallet-world.mjs';
import { EVIDENCE_MAX_AGE_MS, qualificationInputs } from './helpers/qualification-inputs.mjs';
import { importQualificationWith } from './helpers/qualified-builds-fixture.mjs';
import { RECORDED_REVIEWED_BUILD, shippedBuildEvidence } from './helpers/shipped-build-evidence.mjs';

const qualification = await import('../src/devnet-demo/deployment-qualification.mjs');
const { QUALIFICATION_OPERATIONS } = await import('../src/devnet-demo/qualification-operations.mjs');
const { assertQualifiedDeployment, QUALIFIED_NODE_BUILDS } = qualification;

const RECORD_DIRECTORY = new URL('../vectors/testnet-records/', import.meta.url);
const RECORD_FILES = ['deployment-record.json', 'deployment.sha256', 'deployer-public-key.json'];
const MODULE_SOURCE = readFileSync(new URL('../src/devnet-demo/deployment-qualification.mjs', import.meta.url), 'utf8');
const refusalOf = (promise) => promise.then((value) => assert.fail(`expected a refusal, got ${JSON.stringify(value)}`), (error) => error);

// A private copy of the packaged record directory, changed by `change(directory)`; removed after the test.
function recordDirectoryCopy(t, change) {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-testnet-records-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of RECORD_FILES) copyFileSync(new URL(name, RECORD_DIRECTORY), join(directory, name));
  change(directory);
  return pathToFileURL(`${directory}/`);
}

test('the shipped QUALIFIED_NODE_BUILDS equals the recorded reviewed build literal (all seven fields, `dirty` included, and the four operations), and evidence differing from the literal in any one field is refused node_build_unverified', async (t) => {
  assert.equal(QUALIFIED_NODE_BUILDS.length, 1);
  const [entry] = QUALIFIED_NODE_BUILDS;
  assert.deepEqual({ ...entry, qualifiedOperations: [...entry.qualifiedOperations].sort() }, { ...RECORDED_REVIEWED_BUILD, qualifiedOperations: [...RECORDED_REVIEWED_BUILD.qualifiedOperations].sort() });
  assert.equal(entry.dirty, true);
  const { inputs } = await qualificationInputs(t);
  assert.equal(typeof await assertQualifiedDeployment({ phase: 'preflight', ...inputs }), 'string', 'the literal\'s evidence qualifies');
  const evidence = shippedBuildEvidence({ endpoint: ENDPOINT, observedAt: T0 });
  const changes = { dirty: false, commit: 'c'.repeat(40), artifactSha256: 'a'.repeat(64), reportedVersion: '0.9.9', chainIdentity: 'e'.repeat(64),
    qualifiedOperations: ['fee', 'nonce', 'broadcast', 'TEST-other'], endpoint: 'https://other.example.invalid/', observedAt: T0 + 1 };
  assert.deepEqual(Object.keys(changes).sort(), Object.keys(evidence).sort(), 'one change for each evidence field');
  for (const [field, value] of Object.entries(changes)) {
    const refusal = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => ({ ...evidence, [field]: value }) }));
    assert.deepEqual([refusal.code, refusal.details], ['deployment_unqualified', 'node_build_unverified'], field);
  }
});

test('the exported list, each entry and each qualifiedOperations array are frozen; an attempt to change a build\'s identity, its operation set or the list itself through the export throws or changes nothing, and qualification still refuses the unreviewed build and still admits the shipped one', async (t) => {
  const [entry] = QUALIFIED_NODE_BUILDS;
  assert.ok(Object.isFrozen(QUALIFIED_NODE_BUILDS) && Object.isFrozen(entry) && Object.isFrozen(entry.qualifiedOperations));
  const unreviewed = { ...RECORDED_REVIEWED_BUILD, commit: 'c'.repeat(40) };
  const attempts = [
    () => { entry.commit = unreviewed.commit; },
    () => Object.defineProperty(entry, 'artifactSha256', { value: 'a'.repeat(64) }),
    () => Object.assign(entry, { dirty: false }),
    () => entry.qualifiedOperations.push('TEST-other'),
    () => entry.qualifiedOperations.splice(0, 1),
    () => { entry.qualifiedOperations.length = 0; },
    () => QUALIFIED_NODE_BUILDS.push(unreviewed),
    () => QUALIFIED_NODE_BUILDS.splice(0, 1, unreviewed),
    () => { QUALIFIED_NODE_BUILDS.length = 0; },
    () => Object.defineProperty(QUALIFIED_NODE_BUILDS, '1', { value: unreviewed }),
  ];
  for (const attempt of attempts) assert.throws(attempt, TypeError, String(attempt));
  assert.deepEqual({ ...QUALIFIED_NODE_BUILDS[0], qualifiedOperations: [...QUALIFIED_NODE_BUILDS[0].qualifiedOperations].sort() },
    { ...RECORDED_REVIEWED_BUILD, qualifiedOperations: [...RECORDED_REVIEWED_BUILD.qualifiedOperations].sort() }, 'nothing changed');
  const { inputs } = await qualificationInputs(t);
  const refusal = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => ({ ...shippedBuildEvidence({ endpoint: ENDPOINT, observedAt: T0 }),
    commit: unreviewed.commit }) }));
  assert.equal(refusal.details, 'node_build_unverified');
  assert.equal(typeof await assertQualifiedDeployment({ phase: 'preflight', ...inputs }), 'string');
});

test('QUALIFICATION_OPERATIONS is the frozen four-operation export, and deployment qualification imports and uses it for operation-list set equality without an inline requirement list', () => {
  assert.ok(Object.isFrozen(QUALIFICATION_OPERATIONS));
  assert.deepEqual(QUALIFICATION_OPERATIONS, ['fee', 'nonce', 'broadcast', 'confirmation']);
  assert.match(MODULE_SOURCE, /^import \{ QUALIFICATION_OPERATIONS \} from '\.\/qualification-operations\.mjs';$/m);
  assert.match(MODULE_SOURCE, /sameSet\(build\.qualifiedOperations, QUALIFICATION_OPERATIONS\)/);
  assert.match(MODULE_SOURCE, /sameSet\(evidence\.qualifiedOperations, QUALIFICATION_OPERATIONS\)/);
  // Outside the reviewed build list itself, the module names no operation.
  const withoutBuildList = MODULE_SOURCE.replace(/^export const QUALIFIED_NODE_BUILDS = deepFreeze\(\[$[\s\S]*?^\]\);$/m, '');
  assert.notEqual(withoutBuildList, MODULE_SOURCE);
  for (const operation of QUALIFICATION_OPERATIONS) assert.doesNotMatch(withoutBuildList, new RegExp(`'${operation}'`), operation);
});

test('the installed record file, digest file, key file and production module pins agree', async (t) => {
  const record = readFileSync(new URL('deployment-record.json', RECORD_DIRECTORY));
  const digest = readFileSync(new URL('deployment.sha256', RECORD_DIRECTORY), 'utf8');
  const key = JSON.parse(readFileSync(new URL('deployer-public-key.json', RECORD_DIRECTORY), 'utf8'));
  assert.equal(digest, createHash('sha256').update(record).digest('hex'), 'the digest file is the record\'s SHA-256, with no newline');
  assert.match(key, /^[0-9a-f]{64}$/);
  const recordBytes = await qualification.readPackagedDeploymentRecord();
  assert.deepEqual(Buffer.from(recordBytes), record, 'the loader returns the exact record bytes once the files match the module pins');
  const { payload } = JSON.parse(record.toString('utf8'));
  const read = qualification.createVerifiedDeploymentEvidenceReader({ recordBytes, evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS, clock: { now: () => payload.observedAt } });
  assert.deepEqual(await read({}), payload, 'the record verifies under the module\'s pinned digest and deployer key');

  // Any change to the installed files fails before a native write: a missing file, a symlink or one changed byte.
  const flipLastByte = (path) => { const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes); };
  const cases = [
    ['a missing record', (directory) => rmSync(join(directory, 'deployment-record.json')), 'node_build_unavailable'],
    ['a symlinked record', (directory) => { rmSync(join(directory, 'deployment-record.json')); symlinkSync(new URL('deployment-record.json', RECORD_DIRECTORY).pathname, join(directory, 'deployment-record.json')); }, 'node_build_unavailable'],
    ['one changed record byte', (directory) => flipLastByte(join(directory, 'deployment-record.json')), 'node_build_unverified'],
    ['one changed digest byte', (directory) => flipLastByte(join(directory, 'deployment.sha256')), 'node_build_unverified'],
    ['one changed key byte', (directory) => flipLastByte(join(directory, 'deployer-public-key.json')), 'node_build_unverified'],
  ];
  for (const [label, change, details] of cases) {
    const instance = await importQualificationWith({ recordDirectory: recordDirectoryCopy(t, change) });
    const refusal = await refusalOf(instance.readPackagedDeploymentRecord());
    assert.deepEqual([refusal.code, refusal.details], ['deployment_unqualified', details], label);
  }
  const aborted = await refusalOf(qualification.readPackagedDeploymentRecord({ signal: AbortSignal.abort() }));
  assert.equal(aborted.details, 'node_build_unavailable', 'an aborted read stops before any file');
});
