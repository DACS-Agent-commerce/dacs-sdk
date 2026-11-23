// The wire-routes test world mocks performance.now; its teardown must leave the property exactly as it found it, also when several
// worlds are built in one test, when a test mocks performance.now itself, and when a world's setup throws after the mock is installed.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { LISTING, world } from './helpers/wire-routes-world.mjs';

const descriptors = () => ({ own: Object.getOwnPropertyDescriptor(performance, 'now'), inherited: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(performance), 'now') });
const ORIGINAL = descriptors();

test('the wire-routes world puts back the original performance.now after one, two, a mocked and a failed setup, and nothing stale is restored later', async (t) => {
  const wrong = [];
  const during = [];
  // Each case is checked on its own: a case that leaves something behind is recorded, then the original is put back for the next.
  const check = (when) => {
    if (!isDeepStrictEqual(descriptors(), ORIGINAL)) wrong.push(when);
    mock.reset();
    delete performance.now;
  };
  await t.test('one world', async (st) => { (await world(st)).state.elapsedMs = 1_000; });
  check('one world');
  await t.test('two worlds in one test', async (st) => { (await world(st)).state.elapsedMs = 1_000; (await world(st)).state.elapsedMs = 2_000; });
  check('two worlds in one test');
  await t.test('nested worlds restore the still-live parent mock', async (st) => {
    const outer = await world(st);
    outer.state.elapsedMs = 10_000;
    const before = performance.now();
    await st.test('inner world', async (inner) => { await world(inner); });
    during.push(performance.now() > before);
  });
  check('nested worlds');
  let externalMock;
  await t.test('a world over a test mock of performance.now', async (st) => {
    mock.method(performance, 'now', () => 0);
    externalMock = Object.getOwnPropertyDescriptor(performance, 'now');
    await world(st);
  });
  if (!isDeepStrictEqual(descriptors(), { ...ORIGINAL, own: externalMock })) wrong.push('a world over a test mock');
  mock.reset();
  delete performance.now;
  await t.test('a world whose setup throws after its mock', async (st) => {
    let reads = 0;
    const fixture = { get listing() { if (reads++ > 0) throw new Error('TEST setup stops after the mock'); return LISTING; } };
    await assert.rejects(world(st, { fixture }), /TEST setup stops after the mock/);
  });
  check('a failed setup');
  for (let round = 0; round < 3; round++) await t.test(`sequential world ${round}`, async (st) => { await world(st); });
  // A later restoreAll (another helper's teardown) must find no stale mock of these worlds to put back.
  mock.restoreAll();
  check('sequential worlds and a later restoreAll');
  assert.deepEqual(wrong, [], 'cases that left performance.now changed');
  assert.deepEqual(during, [true], 'the parent world mock remains active after a nested world finishes');
});
