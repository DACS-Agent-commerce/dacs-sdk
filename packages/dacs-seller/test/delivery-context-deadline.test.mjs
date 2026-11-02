import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createDemDeliveryContext, resolveDemDeliverySellerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { protocolFixture, NOW, JOB } from './helpers/protocol-fixture.mjs';

const TIMEOUT_MS = 10_000;
const capability = resolveSeller => createDemDeliveryContext({ authority: 'TEST-deadline', resolveBuyer: async () => null, resolveSeller });
const request = f => ({ ...f, jobId: JOB, generatedAt: NOW });

for (const late of ['resolve', 'reject']) test(`an uncooperative resolver times out and ignores a late ${late}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await protocolFixture();
  let options, finish, settled;
  const provider = (_, limits) => {
    options = limits;
    return new Promise((resolve, reject) => { finish = late === 'resolve' ? resolve : reject; });
  };
  const pending = resolveDemDeliverySellerContext(capability(provider), request(f));
  pending.then(value => { settled = value; });
  await setImmediate();
  assert.equal(settled, undefined);
  t.mock.timers.tick(TIMEOUT_MS);
  await setImmediate();
  assert.equal(settled?.disposition, 'indeterminate');
  assert.match(settled.reason, /resolver-timeout/);
  assert.equal(options.signal.aborted, true);
  finish(late === 'resolve' ? { disposition: 'present', value: { input: f.input, vetRequirements: [] } } : new Error('TEST-late-failure'));
  await setImmediate();
  assert.equal(await pending, settled);
  assert.match(settled.reason, /resolver-timeout/);
});

test('provider cancellation cannot replace the deadline cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await protocolFixture();
  const pending = resolveDemDeliverySellerContext(capability((_, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('TEST-cancelled')), { once: true });
  })), request(f));
  await setImmediate();
  t.mock.timers.tick(TIMEOUT_MS);
  assert.match((await pending).reason, /resolver-timeout/);
});

for (const mode of ['success', 'sync failure', 'async failure']) test(`resolver ${mode} receives read limits and releases its signal`, async () => {
  const f = await protocolFixture();
  let options;
  const result = await resolveDemDeliverySellerContext(capability((input, limits) => {
    options = limits;
    assert.equal(input.jobId, JOB);
    assert.equal(options.timeoutMs, TIMEOUT_MS);
    assert.equal(options.maxBytes, 64 * 1024);
    assert.equal(options.signal.aborted, false);
    if (mode === 'sync failure') throw new Error('TEST-sync-cause');
    if (mode === 'async failure') return Promise.reject(new Error('TEST-async-cause'));
    return { disposition: 'absent', reason: 'TEST-no-record' };
  }), request(f));
  assert.equal(options.signal.aborted, true);
  if (mode === 'success') assert.deepEqual(result, { disposition: 'absent', reason: 'TEST-no-record' });
  else {
    assert.equal(result.disposition, 'indeterminate');
    assert.match(result.reason, mode === 'sync failure' ? /TEST-sync-cause/ : /TEST-async-cause/);
  }
});
