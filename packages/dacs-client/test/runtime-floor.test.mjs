// K14: purchase factories refuse an unsupported Node before building anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPurchaseRuntime } from '../src/public-admission.mjs';
import { createProtocolPurchases, createPurchaseService, createListingVerifier, createSqlitePurchaseStore, createCoordinateStore } from '../src/index.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const REFUSED = ['v20.19.0', 'v22.13.0', 'v22.22.1', 'v23.4.0', 'v24.14.0', 'v25.0.0', 'v26.0.0'];
const ADMITTED = ['v22.22.2', 'v22.23.0', 'v24.15.0'];
const isUnsupported = (version) => (error) => error.code === 'runtime_unsupported' && error.message.includes(version);

const setProcessVersion = (version) => Object.defineProperty(process, 'version', { value: version, configurable: true });
function restoreProcessVersionAfter(t) {
  const original = Object.getOwnPropertyDescriptor(process, 'version');
  t.after(() => Object.defineProperty(process, 'version', original));
}

// Every property read on a stand-in counts as one construction step.
function countingStandIns() {
  const count = { reads: 0 };
  const standIn = () => new Proxy({}, { get() { count.reads++; return () => {}; } });
  return { count, options: { db: standIn(), store: standIn(), ops: standIn(), coordinates: standIn(), journal: standIn(), custody: standIn(), signer: standIn() } };
}

function realOptions(t, name) {
  if (name === 'createListingVerifier') return { directory: {}, chain: {} };
  if (name === 'createProtocolPurchases') return { store: createSqlitePurchaseStore() };
  const db = openDatabase(':memory:'); t.after(() => db.close());
  return { db, ops: createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now: () => 1 }), coordinates: createCoordinateStore({ db }),
    chain: {}, config: {}, store: createSqlitePurchaseStore(), purposes: { APPROVE_PURCHASE: 'TEST-approve' } };
}

const FACTORIES = { createProtocolPurchases, createPurchaseService, createListingVerifier };

test('assertPurchaseRuntime refuses every REFUSED version and admits every ADMITTED version', () => {
  for (const version of REFUSED) assert.throws(() => assertPurchaseRuntime(version), isUnsupported(version), version);
  for (const version of ADMITTED) assert.equal(assertPurchaseRuntime(version), undefined, version);
  for (const malformed of ['', 'v22', 'node-22.22.2', undefined, 22]) assert.throws(() => assertPurchaseRuntime(malformed), { code: 'runtime_unsupported' }, String(malformed));
});

test('the purchase runtime check admits exactly the client package engines range', () => {
  const engines = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node;
  assert.throws(() => assertPurchaseRuntime('v1.0.0'), (error) => error.message.startsWith(`purchases need Node ${engines};`));
});

test('each public purchase factory constructed with valid admission under every REFUSED process.version throws runtime_unsupported naming that version, with SQLite statements, journal, custody and signer constructed 0 times and the journal directory unchanged', async (t) => {
  const { binding, currentLocal } = await bindFixture();
  const directory = mkdtempSync(join(tmpdir(), 'dacs-floor-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  restoreProcessVersionAfter(t);
  for (const version of REFUSED) {
    setProcessVersion(version);
    for (const [name, factory] of Object.entries(FACTORIES)) {
      const { count, options } = countingStandIns();
      assert.throws(() => factory({ ...options, journalDirectory: directory, admission: { binding, currentLocal } }), isUnsupported(version), `${name} ${version}`);
      assert.equal(count.reads, 0, `${name} ${version}`);
    }
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('under every ADMITTED version each public purchase factory gets past the runtime check and finishes construction', async (t) => {
  const { binding, currentLocal } = await bindFixture();
  restoreProcessVersionAfter(t);
  for (const version of ADMITTED) {
    setProcessVersion(version);
    for (const [name, factory] of Object.entries(FACTORIES)) {
      const built = factory({ ...realOptions(t, name), admission: { binding, currentLocal } });
      assert.equal(typeof built, 'object', `${name} ${version}`);
    }
  }
});

test('CI asserts the packed refusal on Node 20.19.0 and 22.13.0 and constructs each packed factory at the engine floor', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = (name) => {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.ok(start >= 0, name);
    const next = workflow.indexOf('\n      - ', start + 1);
    return workflow.slice(start, next < 0 ? undefined : next);
  };
  const smoke = step('Package smoke (buyer root)');
  assert.doesNotMatch(smoke, /\n\s+if:/, 'the packed-root smoke runs on both build-test legs');
  assert.match(smoke, /canonicalize/);
  assert.doesNotMatch(smoke, /runtime_unsupported/, 'the supported legs make no refusal assertion');
  for (const version of ['20.19.0', '22.13.0']) {
    const setup = step(`Use Node ${version} for the buyer refusal check`);
    assert.match(setup, new RegExp(`node-version: "${version.replaceAll('.', '\\.')}"`), version);
    const label = version === '20.19.0' ? 'Node 20' : `Node ${version}`;
    const refusal = step(`Package smoke (buyer purchase factories refuse ${label} with runtime_unsupported)`);
    assert.match(refusal, new RegExp(`test "\\$\\(node --version\\)" = v${version.replaceAll('.', '\\.')}`), version);
    assert.match(refusal, /node refuse-runtime\.mjs/, version);
  }
  const script = step('Package smoke (buyer purchase factories refuse Node 20 with runtime_unsupported)');
  assert.match(script, /runtime_unsupported/);
  assert.match(script, /process\.version/);
  assert.match(step("Use this leg's Node again after the refusal checks"), /node-version: \$\{\{ matrix\.node-version \}\}/);
  const floor = step('Check both packed JavaScript entry points at the engine floor');
  for (const name of Object.keys(FACTORIES)) assert.match(floor, new RegExp(`c\\.${name}\\(`), name);
});
