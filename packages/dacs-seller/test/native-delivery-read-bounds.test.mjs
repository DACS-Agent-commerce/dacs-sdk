import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  createNativeDemDeliveryCapability, submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery,
  verifyNativeDemDeliveryReceipt, provenUnsignedAbsence, mayPublishAgain,
} from '../src/dacs/native-dem-delivery-consumer.mjs';

const DEADLINE_MS = 30_000;
const OVER_BYTE_LIMIT = 'x'.repeat(300 * 1024);
const OVER_LIST_LIMIT = Array.from({ length: 2000 }, () => 0);

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
  assert.equal(answer, accepted);
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

test('a read inside the limits returns the capability\'s own reply object', async () => {
  const absence = provenUnsignedAbsence('TEST never signed');
  const answer = await readNativeDemDelivery(capabilityWhere('read', async () => absence), {});
  assert.equal(answer, absence);
  assert.equal(mayPublishAgain(answer), true);
});

test('a read reply with an undefined-valued key inside the limits is returned unchanged', async () => {
  const reply = { status: 'present', receipt: { transactionRef: { value: 'TEST' }, note: undefined } };
  assert.equal(await readNativeDemDelivery(capabilityWhere('read', async () => reply), {}), reply);
});

test('an error thrown by the capability reaches the caller unchanged', async () => {
  const failure = Object.assign(new Error('TEST read failed'), { observation: 'absent' });
  const capability = capabilityWhere('read', async () => { throw failure; });
  await assert.rejects(readNativeDemDelivery(capability, {}), error => error === failure);
});
