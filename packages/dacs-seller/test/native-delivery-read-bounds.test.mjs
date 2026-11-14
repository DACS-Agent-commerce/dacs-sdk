import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  createNativeDemDeliveryCapability, submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery,
  verifyNativeDemDeliveryReceipt, provenUnsignedAbsence, deadRefusedCreate, mayPublishAgain,
} from '../src/dacs/native-dem-delivery-consumer.mjs';

const DEADLINE_MS = 30_000;
const OVER_BYTE_LIMIT = 'x'.repeat(300 * 1024);
const OVER_LIST_LIMIT = Array.from({ length: 20_000 }, () => 0);

const OPERATIONS = {
  submit: { call: (capability) => submitNativeDemDelivery(capability, {}), indeterminate: { status: 'indeterminate' } },
  'guarded submit': { call: (capability) => submitNativeDemDelivery(capability, {}, () => true), indeterminate: { status: 'indeterminate' } },
  reconcile: { call: (capability) => reconcileNativeDemDelivery(capability, {}), indeterminate: { status: 'indeterminate' } },
  read: { call: (capability) => readNativeDemDelivery(capability, {}), indeterminate: { status: 'indeterminate' } },
  verify: { call: (capability) => verifyNativeDemDeliveryReceipt(capability, {}), indeterminate: 'indeterminate' },
};
const OPERATION_NAMES = { submit: 'submit', 'guarded submit': 'submitAuthorized', reconcile: 'reconcile', read: 'read', verify: 'verifyReceipt' };

function capabilityWhere(label, operation) {
  const unused = async () => ({ status: 'present' });
  const operations = { submitAuthorized: unused, reconcile: unused, read: unused, verifyReceipt: unused };
  if (label === 'submit') operations.submit = operation;
  else operations[OPERATION_NAMES[label]] = operation;
  return createNativeDemDeliveryCapability({ authority: 'TEST-native-bounds', ...operations });
}

function assertIndeterminate(label, answer, reason) {
  const expected = OPERATIONS[label].indeterminate;
  if (typeof expected === 'string') return assert.equal(answer, expected);
  assert.equal(answer.status, 'indeterminate');
  assert.match(answer.reason, reason);
}

const SUBMITS = ['submit', 'guarded submit'];
const READ_ONLY = Object.keys(OPERATIONS).filter(label => !SUBMITS.includes(label));

for (const label of SUBMITS) test(`a native delivery ${label} that outlasts the deadline is not answered early`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const accepted = { status: 'accepted', reconciliationId: 'TEST-late-create' };
  let finish;
  const capability = capabilityWhere(label, () => new Promise(resolve => { finish = () => resolve(accepted); }));
  let answer;
  const pending = OPERATIONS[label].call(capability).then(value => { answer = value; });
  await setImmediate();
  t.mock.timers.tick(DEADLINE_MS * 2);
  await setImmediate();
  assert.equal(answer, undefined);
  finish();
  await pending;
  assert.deepEqual(answer, accepted);
});

for (const label of READ_ONLY) test(`a native delivery ${label} that never settles answers indeterminate at the deadline`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const capability = capabilityWhere(label, () => new Promise(() => {}));
  let answer;
  const pending = OPERATIONS[label].call(capability).then(value => { answer = value; });
  await setImmediate();
  assert.equal(answer, undefined);
  t.mock.timers.tick(DEADLINE_MS);
  await pending;
  assertIndeterminate(label, answer, /deadline/);
});

for (const label of Object.keys(OPERATIONS)) test(`a native delivery ${label} reply over the byte limit is refused as indeterminate`, async () => {
  const reply = label === 'verify' ? OVER_BYTE_LIMIT : { status: 'present', artifact: { text: OVER_BYTE_LIMIT } };
  const answer = await OPERATIONS[label].call(capabilityWhere(label, async () => reply));
  assertIndeterminate(label, answer, /limit/);
});

test('a native delivery read reply with too many list entries is refused as indeterminate', async () => {
  const capability = capabilityWhere('read', async () => ({ status: 'present', artifact: { entries: OVER_LIST_LIMIT } }));
  assertIndeterminate('read', await readNativeDemDelivery(capability, {}), /limit/);
});

test('a read of proven unsigned absence returns the capability\'s own reply object', async () => {
  const absence = provenUnsignedAbsence('TEST never signed');
  const answer = await readNativeDemDelivery(capabilityWhere('read', async () => absence), {});
  assert.equal(answer, absence);
  assert.equal(mayPublishAgain(answer), true);
});

test('a proven unsigned absence with an oversized reason answers indeterminate', async () => {
  const absence = provenUnsignedAbsence(OVER_BYTE_LIMIT);
  const answer = await readNativeDemDelivery(capabilityWhere('read', async () => absence), {});
  assert.equal(answer.status, 'indeterminate');
  assert.equal(mayPublishAgain(answer), false);
});

test('a proven unsigned absence whose toJSON hides an oversized reason answers indeterminate', async () => {
  const absence = provenUnsignedAbsence(OVER_BYTE_LIMIT);
  Object.defineProperty(absence, 'toJSON', { value: () => ({ status: 'absent', reason: 'short' }), enumerable: true });
  const answer = await readNativeDemDelivery(capabilityWhere('read', async () => absence), {});
  assert.equal(answer.status, 'indeterminate');
  assert.equal(mayPublishAgain(answer), false);
});

for (const [kind, makeProof] of [['unsigned absence', provenUnsignedAbsence], ['dead refused create', deadRefusedCreate]]) {
  for (const [form, reason] of [['no reason', undefined], ['an Error reason', new Error('TEST gone')]]) {
    test(`a proven ${kind} with ${form} returns the capability's own reply object`, async () => {
      const proof = makeProof(reason);
      const answer = await readNativeDemDelivery(capabilityWhere('read', async () => proof), {});
      assert.equal(answer, proof);
      assert.equal(mayPublishAgain(answer), true);
    });
  }
  test(`a proven ${kind} with an Error reason whose message is over the byte limit answers indeterminate`, async () => {
    const answer = await readNativeDemDelivery(capabilityWhere('read', async () => makeProof(new Error(OVER_BYTE_LIMIT))), {});
    assert.equal(answer.status, 'indeterminate');
    assert.equal(mayPublishAgain(answer), false);
  });
}

test('a read reply holding the largest report the seller sends, twice, is returned', async () => {
  const wide = Array.from({ length: 8000 }, () => 0);
  let deep = 0;
  for (let level = 1; level < 64; level++) deep = [deep];
  for (const report of [{ list: wide }, deep]) {
    const reply = { status: 'present', artifact: { report }, receipt: { nested: { a: { b: { c: { report } } } } } };
    const answer = await readNativeDemDelivery(capabilityWhere('read', async () => reply), {});
    assert.deepEqual(answer, reply);
  }
});

test('a read reply with an undefined-valued key inside the limits is returned as its checked copy', async () => {
  const reply = { status: 'present', receipt: { transactionRef: { value: 'TEST' }, note: undefined } };
  const answer = await readNativeDemDelivery(capabilityWhere('read', async () => reply), {});
  assert.deepEqual(answer, { status: 'present', receipt: { transactionRef: { value: 'TEST' } } });
});

test('a read reply whose toJSON hides an oversized artifact does not reach the caller', async () => {
  const reply = { status: 'present', artifact: { text: 'x'.repeat(300 * 1024) }, toJSON() { return { status: 'present' }; } };
  const answer = await readNativeDemDelivery(capabilityWhere('read', async () => reply), {});
  assert.notEqual(answer, reply);
  assert.equal(answer.artifact, undefined);
  assert.equal(answer.toJSON, undefined);
});

test('an error thrown by the capability reaches the caller unchanged', async () => {
  const failure = Object.assign(new Error('TEST read failed'), { observation: 'absent' });
  const capability = capabilityWhere('read', async () => { throw failure; });
  await assert.rejects(readNativeDemDelivery(capability, {}), error => error === failure);
});

test('a capability error that reads like a timeout is not taken for the deadline', async () => {
  const failure = Object.assign(new Error('resolver-timeout'), { code: 'rpc_failure', observation: 'absent' });
  const capability = capabilityWhere('read', async () => { throw failure; });
  await assert.rejects(readNativeDemDelivery(capability, {}), error => error === failure);
});
