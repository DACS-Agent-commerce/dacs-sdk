import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextWorkRegistry } from '../src/dacs/context-work-registry.mjs';
import { SellerTransportError } from '../src/dacs/seller-transport-auth.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve)); };

test('context work is registered before it starts and stays registered until it settles', async () => {
  const registry = createContextWorkRegistry(), gate = deferred();
  let drainedWhileStarting = null, drained = false;
  const work = registry.track(() => {
    drainedWhileStarting = registry.drain().then(() => { drained = true; });
    return gate.promise;
  });
  await flush();
  assert.equal(drained, false, 'a drain asked for as the work starts waits for it');
  gate.resolve('done');
  assert.equal(await work, 'done');
  await drainedWhileStarting;
  assert.equal(drained, true);
});

test('context work offered after stop is refused with seller_stopped and never starts', async () => {
  const registry = createContextWorkRegistry();
  let started = 0;
  registry.stop();
  await assert.rejects(registry.track(() => { started++; }), (error) => error instanceof SellerTransportError && error.code === 'seller_stopped' && error.status === 503);
  assert.equal(started, 0);
  await registry.drain();
});

test('a rejected context work is returned to its caller and leaves the registry empty', async () => {
  const registry = createContextWorkRegistry(), failure = new Error('TEST the work failed');
  const unhandled = [], onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(registry.track(async () => { throw failure; }), failure);
    await assert.rejects(registry.track(() => { throw failure; }), failure);
    await registry.drain();
    await flush();
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
});

test('a drain also waits for work registered while it waits', async () => {
  const registry = createContextWorkRegistry(), first = deferred(), second = deferred();
  const firstWork = registry.track(() => first.promise);
  let drained = false;
  const draining = registry.drain().then(() => { drained = true; });
  const secondWork = registry.track(() => second.promise);
  first.resolve();
  await firstWork;
  await flush();
  assert.equal(drained, false);
  second.resolve();
  await secondWork;
  await draining;
  assert.equal(drained, true);
});
