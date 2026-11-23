// The wire-routes test world mocks performance.now; its teardown must leave the property exactly as it found it, also when several
// worlds are built in one test, when a test mocks performance.now itself, and when a world's setup throws after the mock is installed.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
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
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith('TEST-wire-routes-')).sort();
    let reads = 0;
    const fixture = { get listing() { if (reads++ > 0) throw new Error('TEST setup stops after the mock'); return LISTING; } };
    await assert.rejects(world(st, { fixture }), /TEST setup stops after the mock/);
    st.after(() => assert.deepEqual(readdirSync(tmpdir()).filter((entry) => entry.startsWith('TEST-wire-routes-')).sort(), before));
  });
  check('a failed setup');
  for (let round = 0; round < 3; round++) await t.test(`sequential world ${round}`, async (st) => { await world(st); });
  // A later restoreAll (another helper's teardown) must find no stale mock of these worlds to put back.
  mock.restoreAll();
  check('sequential worlds and a later restoreAll');
  assert.deepEqual(wrong, [], 'cases that left performance.now changed');
  assert.deepEqual(during, [true], 'the parent world mock remains active after a nested world finishes');
});

test('a world teardown preserves a parent-owned mock on another object', async (t) => {
  const target = { value: () => 'original' };
  mock.method(target, 'value', () => 'parent');

  await t.test('child world', async (child) => {
    await world(child);
  });

  assert.equal(target.value(), 'parent');
  mock.reset();
  assert.equal(target.value(), 'original');
});

test('a failed owned-directory removal still restores the test clock', async () => {
  const probe = fileURLToPath(new URL('./helpers/wire-routes-world-cleanup-probe.mjs', import.meta.url));
  const guard = fileURLToPath(new URL('./helpers/kit-guard-fixture.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--import', guard, probe], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000, env,
  });
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.match(result.stdout, /CLEANUP_FAILURE_INJECTED=true/);
  assert.match(result.stdout, /PERFORMANCE_RESTORED=true/);
  assert.match(result.stdout, /TEST injected owned-directory removal failure/);
});
