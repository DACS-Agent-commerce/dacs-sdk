// The kit's operation guard (K11, DC12): while it is off, the kit signs and
// sends nothing. The off-state cases run in a probe child without the guard
// fixture loader (helpers/kit-guard-fixture.mjs); the cases that flip the guard
// run the probe with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXPORT_CLASSIFICATION } from './helpers/kit-guard-classification.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const probePath = fileURLToPath(new URL('./helpers/kit-guard-probe.mjs', import.meta.url));
const fixtureUrl = new URL('./helpers/kit-guard-fixture.mjs', import.meta.url).href;
const PROBE_TIMEOUT_MS = 120000;
const GUARD_CODE = 'kit_operation_guard_off';
const GUARD_EXPORTS = ['KIT_OPERATION_GUARD', 'KitOperationGuardError', 'assertKitOperationAdmitted', 'kitOperationAdmitted'];
// Exported only by the fixture loader's copy of the guard.
const LOADER_SETTER = 'setKitOperationGuardForTest';
const NOT_SHIPPED = ['src/devnet-demo/operator-custody.mjs', 'src/devnet-demo/seller-issuance.mjs'];
// The entries each module guards, named as the error's `entry` (51-2, 51-3).
const GUARD_SITES = {
  'src/host.mjs': ['startSellerHost'],
  'src/dacs/seller-agent.mjs': ['createSellerAgent'],
  'src/dacs/seller-http.mjs': ['createSellerHttpHandler', 'createSellerAgentClient'],
  'src/dacs/seller-transport-auth.mjs': ['createSellerTransportServerAuth', 'createSellerTransportClientAuth'],
  'src/dacs/seller-durable-state.mjs': ['signOnce'],
  'src/dacs/payment-evidence-wallet-journal.mjs': ['anchorEvidence', 'reconcilePaymentEvidence', 'ensureEvidence', 'guardedCreate'],
  'src/dacs/native-payment-evidence-consumer.mjs': ['createNativePaymentEvidenceConsumer'],
  'src/dacs/native-dem-delivery-consumer.mjs': ['submitNativeDemDelivery'],
  'src/dacs/fixture-anchors.mjs': ['signAnchorWrite'],
  'src/dacs/commit-on-signature.mjs': ['signatureCommitmentAnchor'],
  'src/devnet-demo/agreement-context.mjs': ['createDevnetDemoAgreementContextProvider'],
  'src/devnet-demo/artifact-anchor.mjs': ['publish'],
  'src/devnet-demo/listing.mjs': ['createDevnetDemoListingPublisher'],
  'src/devnet-demo/native-delivery.mjs': ['createDevnetDemoDeliveryCapability.submit'],
  'src/devnet-demo/storage-write-recovery.mjs': ['storageWriteRpcSigner'],
};

// A probe child's NODE_OPTIONS: whatever the runner passed, minus the guard fixture loader, plus it when asked.
function probeNodeOptions(withFixtureLoader) {
  const kept = (process.env.NODE_OPTIONS ?? '').split(' ').filter((option) => option !== '' && !option.includes('kit-guard-fixture.mjs'));
  return [...kept, ...(withFixtureLoader ? [`--import=${fixtureUrl}`] : [])].join(' ');
}
function runProbe(name, { withFixtureLoader = false, environment = {}, args = [] } = {}) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', probePath, name, ...args], { cwd: packageDirectory, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, ...environment, NODE_OPTIONS: probeNodeOptions(withFixtureLoader) } });
  assert.equal(child.status, 0, `probe ${name} failed\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}
function privateDirectory(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-kit-guard-')));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const snapshot = (directory) => readdirSync(directory, { recursive: true }).sort().map((name) => {
  const stat = statSync(join(directory, name));
  return [name, stat.mode, stat.mtimeMs, stat.isFile() ? readFileSync(join(directory, name)).toString('base64') : null];
});
const sourceFiles = () => readdirSync(join(packageDirectory, 'src'), { recursive: true }).filter((name) => name.endsWith('.mjs')).map((name) => `src/${name}`).sort();
const sourceOf = (file) => readFileSync(join(packageDirectory, file), 'utf8');
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const functionNames = (module) => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort();
// The exports a classification row does not name, and the names it holds that the module no longer exports.
const classificationDrift = (exported, { effect, pure }) => {
  const classified = [...Object.keys(effect), ...pure];
  return { unclassified: exported.filter((name) => !classified.includes(name)), stale: classified.filter((name) => !exported.includes(name)) };
};

test('while the guard is off, startSellerHost refuses kit_operation_guard_off before it reads options or opens any file', () => {
  const { refusal, optionReads, fsCalls } = runProbe('startWithHostileOptions');
  assert.deepEqual({ name: refusal.name, code: refusal.code, entry: refusal.entry }, { name: 'KitOperationGuardError', code: GUARD_CODE, entry: 'startSellerHost' });
  assert.deepEqual(optionReads, [], 'no option was read');
  assert.deepEqual(fsCalls, [], 'no file was opened, created or inspected');
});

test('while the guard is off, every directly reachable effect entry under ./src/* refuses before it reads, signs or sends', () => {
  const answer = runProbe('effectEntries');
  assert.deepEqual(Object.keys(answer.refused).sort(), [...new Set(Object.values(GUARD_SITES).flat())].sort(), 'every guarded entry was reached');
  for (const [entry, refusal] of Object.entries(answer.refused)) assert.deepEqual({ name: refusal?.name, code: refusal?.code, entry: refusal?.entry }, { name: 'KitOperationGuardError', code: GUARD_CODE, entry }, entry);
  assert.deepEqual(answer.effects, { signs: 0, sends: 0 });
  assert.equal(answer.walletRequests, 0);
  assert.equal(answer.anchorJournalRows, 0, 'the refused publish stored no intent');
  assert.equal(answer.readable.durableState, 'function', 'the durable store stays readable');
  assert.equal(answer.readable.signedProjection, null, 'the wallet journal stays readable');
  assert.notEqual(answer.readable.anchorRead, GUARD_CODE, 'the artifact anchor stays readable');
});

test('every function exported by a shipped module is classified as an effect entry or as pure, and an unclassified export fails', async () => {
  const modules = sourceFiles().filter((file) => !NOT_SHIPPED.includes(file));
  const everyExport = new Set();
  const withFunctions = [];
  for (const file of modules.filter((name) => name !== 'src/index.mjs')) {
    const module = await import(pathToFileURL(join(packageDirectory, file)).href);
    for (const value of Object.values(module)) if (typeof value === 'function') everyExport.add(value);
    const names = functionNames(module).filter((name) => name !== LOADER_SETTER);
    if (names.length) withFunctions.push(file);
    if (names.length) assert.deepEqual(classificationDrift(names, EXPORT_CLASSIFICATION[file] ?? { effect: {}, pure: [] }), { unclassified: [], stale: [] }, `${file} export classification drifted`);
  }
  assert.deepEqual(Object.keys(EXPORT_CLASSIFICATION).sort(), withFunctions, 'a module with no function export is still classified');
  const index = await import(pathToFileURL(join(packageDirectory, 'src/index.mjs')).href);
  for (const [name, value] of Object.entries(index)) if (typeof value === 'function') assert.ok(everyExport.has(value), `${name} is re-exported from a classified module`);
  assert.deepEqual(classificationDrift(['guarded', 'forgotten'], { effect: { guarded: [] }, pure: ['gone'] }), { unclassified: ['forgotten'], stale: ['gone'] });

  const named = new Set(Object.values(GUARD_SITES).flat());
  for (const [file, row] of Object.entries(EXPORT_CLASSIFICATION)) for (const [name, reached] of Object.entries(row.effect)) {
    for (const entry of reached) assert.ok(named.has(entry), `${file} ${name} reaches ${entry}, which no module guards`);
  }
  for (const [file, entries] of Object.entries(GUARD_SITES)) {
    const source = sourceOf(file);
    assert.match(source, /import \{[^}]*\bassertKitOperationAdmitted\b[^}]*\} from '\.{1,2}\/kit-operation-guard\.mjs'/, `${file} imports the guard`);
    for (const entry of entries) assert.ok(source.includes(`assertKitOperationAdmitted('${entry}')`), `${file} guards ${entry}`);
  }
  const guarding = modules.filter((file) => file !== 'src/kit-operation-guard.mjs' && sourceOf(file).includes('assertKitOperationAdmitted('));
  assert.deepEqual(guarding, Object.keys(GUARD_SITES).sort(), 'every module that calls the guard is listed with its entries');
});

test('an environment variable, a CLI argument or a host option naming the guard changes nothing', () => {
  const answer = runProbe('namedGuardInputs', { environment: { DACS_KIT_GUARD: 'testnet-tp1' }, args: ['--guard=testnet-tp1'] });
  assert.equal(answer.environment, 'testnet-tp1', 'the probe did carry the environment variable');
  assert.deepEqual(answer.argv, ['namedGuardInputs', '--guard=testnet-tp1']);
  assert.equal(answer.admitted, false);
  assert.equal(answer.refusal.code, GUARD_CODE, 'refused as the guard, not as an unknown option');
});

test("a guard value other than exactly testnet-tp1 refuses: empty, upper case, 'on', undefined", () => {
  const answers = runProbe('guardValues', { withFixtureLoader: true });
  assert.deepEqual(answers.map(({ value, admitted }) => [value, admitted]), [['testnet-tp1', true], ['', false], ['TESTNET-TP1', false], ['on', false], ['testnet-tp1 ', false], ['undefined', false], ['null', false], ['true', false], ['1', false]]);
  for (const { value, refusal } of answers) assert.equal(refusal?.code ?? null, value === 'testnet-tp1' ? null : GUARD_CODE, value);
  assert.match(sourceOf('src/kit-operation-guard.mjs'), /KIT_OPERATION_GUARD === 'testnet-tp1'/);
});

test('the guard module imports nothing and reads no environment, file or option', () => {
  const code = withoutComments(sourceOf('src/kit-operation-guard.mjs'));
  assert.doesNotMatch(code, /\bimport\b|\brequire\b|\bprocess\b|\benv\b|\bargv\b|\bfs\b|\breadFile|\bglobalThis\b|\bfetch\b|\beval\b|\bFunction\(/);
  assert.match(code, /export const KIT_OPERATION_GUARD = 'off';/);
  assert.deepEqual([...code.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((match) => match[1]).sort(), GUARD_EXPORTS);
});

test('two concurrent starts while off both refuse and neither takes the state lock', (t) => {
  const dataDirectory = privateDirectory(t);
  const { results, entries } = runProbe('concurrentStarts', { args: [dataDirectory] });
  assert.deepEqual(results.map((refusal) => refusal?.code), [GUARD_CODE, GUARD_CODE]);
  assert.deepEqual(entries, [], 'no lock file or state was created');
});

test('a refused start leaves the data directory byte-identical', (t) => {
  const dataDirectory = privateDirectory(t);
  mkdirSync(join(dataDirectory, 'seller'), { mode: 0o700 });
  writeFileSync(join(dataDirectory, 'seller', 'state.bin'), 'TEST retained state', { mode: 0o600 });
  const before = snapshot(dataDirectory);
  for (let repeat = 0; repeat < 2; repeat++) assert.equal(runProbe('concurrentStarts', { args: [dataDirectory] }).results[0].code, GUARD_CODE);
  assert.deepEqual(snapshot(dataDirectory), before);
});

test('while off, an artifact read that would recover a pending CREATE stays readback-only and sends nothing', () => {
  const answer = runProbe('artifactReadRecovery', { withFixtureLoader: true });
  assert.deepEqual({ resends: answer.admitted.resends, walletRequests: answer.admitted.walletRequests }, { resends: 1, walletRequests: 1 }, 'control: the same read recovers while admitted');
  assert.deepEqual({ resends: answer.off.resends, walletRequests: answer.off.walletRequests }, { resends: 0, walletRequests: 1 }, 'off: the read resends nothing and signs nothing new');
  assert.notEqual(answer.off.status, 'present', 'a pending CREATE is not reported as landed');
});

test('under the unshipped fixture loader the guard admits, and the loader lives outside files and src', () => {
  const answer = runProbe('fixtureAdmits', { withFixtureLoader: true });
  assert.deepEqual({ guard: answer.guard, admitted: answer.admitted, startRefusal: answer.startRefusal }, { guard: 'testnet-tp1', admitted: true, startRefusal: null });
  assert.deepEqual(answer.exports, [...GUARD_EXPORTS, LOADER_SETTER].sort(), 'only the loader adds the test setter');
  assert.equal(runProbe('namedGuardInputs').admitted, false, 'without the loader the same checkout is off');
  const manifest = JSON.parse(sourceOf('package.json'));
  for (const helper of ['kit-guard-fixture.mjs', 'kit-guard-fixture-hook.mjs']) {
    assert.ok(!sourceFiles().some((file) => file.endsWith(helper)), `${helper} is not under src`);
    assert.ok(!manifest.files.some((entry) => entry.includes(helper) || /(?:^|\/)test(?:\/|$)/.test(entry)), `${helper} is outside files`);
  }
  assert.ok(manifest.files.includes('src/'), 'the guard ships with src');
  const runner = readFileSync(join(packageDirectory, '../../scripts/run-seller-tests.mjs'), 'utf8');
  assert.match(runner, /NODE_OPTIONS/);
  assert.ok(runner.includes(relative(join(packageDirectory, '../..'), fileURLToPath(fixtureUrl)).replaceAll('\\', '/')), 'the runner preloads the loader into every test process');
});
