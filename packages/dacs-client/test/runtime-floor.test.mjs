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

const REFUSED = ['v20.19.0', 'v22.12.0', 'v23.3.0'];
const ADMITTED = ['v22.13.0', 'v23.4.0', 'v24.0.0'];
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

test('assertPurchaseRuntime refuses v20.19.0, v22.12.0 and v23.3.0 and admits v22.13.0, v23.4.0 and v24.0.0 (K14-R1 to R6)', () => {
  for (const version of REFUSED) assert.throws(() => assertPurchaseRuntime(version), isUnsupported(version), version);
  for (const version of ADMITTED) assert.equal(assertPurchaseRuntime(version), undefined, version);
  for (const malformed of ['', 'v22', 'node-22.13.0', undefined, 22]) assert.throws(() => assertPurchaseRuntime(malformed), { code: 'runtime_unsupported' }, String(malformed));
});

test('each public purchase factory constructed with valid admission under process.version v20.19.0, v22.12.0 and v23.3.0 throws runtime_unsupported naming that version, with SQLite statements, journal, custody and signer constructed 0 times and the journal directory unchanged (K14-R1, R2, R4, R7)', async (t) => {
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

test('under v22.13.0, v23.4.0 and v24.0.0 each public purchase factory gets past the runtime check and finishes construction (K14-R3, R5, R6)', async (t) => {
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

test('CI asserts the Node 20 refusal on the 20.19.0 leg only and constructs each packed factory at the engine floor (K14-R1, R3, R5)', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = (name) => {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.ok(start >= 0, name);
    const next = workflow.indexOf('\n      - ', start + 1);
    return workflow.slice(start, next < 0 ? undefined : next);
  };
  const smoke = step('Package smoke (buyer root; Node 20 import is outside client engines)');
  assert.doesNotMatch(smoke, /\n\s+if:/, 'the packed-root smoke runs on both build-test legs');
  assert.match(smoke, /canonicalize/);
  assert.doesNotMatch(smoke, /runtime_unsupported/, 'the floating leg makes no refusal assertion');
  const refusal = step('Package smoke (buyer purchase factories refuse Node 20 with runtime_unsupported)');
  assert.match(refusal, /if: matrix\.node-version == '20\.19\.0'/);
  assert.match(refusal, /runtime_unsupported/);
  assert.match(refusal, /process\.version/);
  const floor = step('Check both packed JavaScript entry points at the engine floor');
  for (const name of Object.keys(FACTORIES)) assert.match(floor, new RegExp(`c\\.${name}\\(`), name);
});
