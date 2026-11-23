// The test-only native retry seam: legacy mode leaves the retry path as the
// base has it, wire mode lets one test cross the issued lease explicitly, and
// crash setup goes through an injected adapter. These cases run the seam over
// fake clocks and in-memory adapters; seller-host-native-delivery.test.mjs
// runs it over the real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRetrySeam } from './helpers/native-retry-seam.mjs';

const T0 = 1_793_102_400_000;
const LEASE_MS = 300_000;
const JOB_ID = '01J8N4YV7YVYQ4DB7M8T000001';
const PAYMENTS_PATH = '/dacs/v1/payments';

// A wall clock never behind the fixture's latest block, and a monotonic clock
// that only moves when the wall clock is advanced: advance moves both.
function fakeClocks(latestBlockMs = () => 0) {
  let floor = T0, monotonic = 0;
  const wallNow = () => (floor = Math.max(floor, latestBlockMs()));
  const advance = (milliseconds) => { floor = wallNow() + milliseconds; monotonic += milliseconds; };
  return { wallNow, monotonicNow: () => monotonic, advance };
}

function seamOver({ mode, clocks = fakeClocks(), lease = { until: null }, establishCut = async () => {} }) {
  const advances = [];
  const seam = createNativeRetrySeam({ wallNow: clocks.wallNow, monotonicNow: clocks.monotonicNow, mode, leaseUntil: () => lease.until, establishCut,
    advance: (milliseconds) => { advances.push(milliseconds); clocks.advance(milliseconds); } });
  return { seam, clocks, advances, lease };
}

const validOptions = () => ({ ...fakeClocks(), mode: 'legacy', leaseUntil: () => null, establishCut: async () => {} });
const paymentBody = () => ({ jobId: JOB_ID, txHash: 'TEST-tx-1', payerPayingKey: 'TEST-payer' });
const cutFor = (point, body = paymentBody()) => ({ point, jobId: JOB_ID, path: PAYMENTS_PATH, rawBody: Buffer.from(JSON.stringify(body)) });

test('native-retry-clock-seam', async (t) => {
  await t.test('legacy mode leaves both clocks and the cut adapter alone even with a live lease', () => {
    const cuts = [];
    const { seam, clocks, advances } = seamOver({ mode: 'legacy', lease: { until: T0 + LEASE_MS }, establishCut: async cut => { cuts.push(cut); } });
    seam.beforeRetry();
    assert.deepEqual(advances, []);
    assert.equal(clocks.wallNow(), T0);
    assert.equal(clocks.monotonicNow(), 0);
    assert.deepEqual(cuts, []);
  });

  await t.test('wire mode crosses exactly the issued lease on both clocks without touching the payment or purchase', () => {
    const purchase = { body: paymentBody(), purchases: 1, claims: 1 };
    const before = structuredClone(purchase);
    const { seam, clocks, advances, lease } = seamOver({ mode: 'wire' });
    lease.until = clocks.wallNow() + LEASE_MS;
    seam.beforeRetry();
    assert.deepEqual(advances, [LEASE_MS]);
    assert.equal(clocks.wallNow(), T0 + LEASE_MS, 'the wall clock stops at the lease end, not at a reset value');
    assert.equal(clocks.monotonicNow(), LEASE_MS);
    assert.deepEqual(purchase, before, 'same payment body, one purchase, no new claim');
    seam.beforeRetry();
    assert.deepEqual(advances, [LEASE_MS], 'an ended lease is not crossed twice');
  });

  await t.test('wire mode advances nothing when no lease was issued', () => {
    const { seam, advances } = seamOver({ mode: 'wire', lease: { until: null } });
    seam.beforeRetry();
    assert.deepEqual(advances, []);
  });

  await t.test('wire mode advances nothing when the fixture clock already passed the lease', () => {
    let blockMs = T0;
    const { seam, clocks, advances, lease } = seamOver({ mode: 'wire', clocks: fakeClocks(() => blockMs) });
    lease.until = T0 + LEASE_MS;
    blockMs = T0 + 2 * LEASE_MS;
    seam.beforeRetry();
    assert.deepEqual(advances, []);
    assert.equal(clocks.wallNow(), T0 + 2 * LEASE_MS);
  });

  await t.test('wire mode refuses an advance that leaves the lease live', () => {
    const seam = createNativeRetrySeam({ ...validOptions(), mode: 'wire', leaseUntil: () => T0 + LEASE_MS, advance: () => {} });
    assert.throws(() => seam.beforeRetry(), /lease/);
  });

  await t.test('wire mode refuses an advance that leaves the monotonic clock behind the wall clock', () => {
    const clocks = fakeClocks();
    const seam = createNativeRetrySeam({ ...validOptions(), wallNow: clocks.wallNow, monotonicNow: () => 0, mode: 'wire',
      leaseUntil: () => T0 + LEASE_MS, advance: clocks.advance });
    assert.throws(() => seam.beforeRetry(), /monotonic/);
  });

  await t.test('an unknown mode or a missing function is a TypeError', () => {
    assert.doesNotThrow(() => createNativeRetrySeam(validOptions()));
    for (const change of [{ mode: 'other' }, { wallNow: 'now' }, { monotonicNow: null }, { advance: undefined }, { leaseUntil: 1 }, { establishCut: {} }]) {
      assert.throws(() => createNativeRetrySeam({ ...validOptions(), ...change }), TypeError, JSON.stringify(Object.keys(change)));
    }
    assert.throws(() => createNativeRetrySeam(null), TypeError);
  });

  await t.test('a bad clock or lease reading in wire mode is a TypeError', () => {
    const wire = (change) => createNativeRetrySeam({ ...validOptions(), mode: 'wire', leaseUntil: () => T0, ...change });
    assert.throws(() => wire({ wallNow: () => Number.NaN }).beforeRetry(), TypeError);
    assert.throws(() => wire({ monotonicNow: () => '0' }).beforeRetry(), TypeError);
    assert.throws(() => wire({ leaseUntil: () => '5' }).beforeRetry(), TypeError);
    assert.throws(() => wire({ leaseUntil: () => Infinity }).beforeRetry(), TypeError);
  });
});

test('native-crash-seam-equivalence', async (t) => {
  await t.test('the adapter receives the exact cut for each point, with the body bytes copied on entry', async () => {
    for (const point of ['reservation-before-work', 'work-before-completion']) {
      const seen = [];
      const { seam } = seamOver({ mode: 'legacy', establishCut: async cut => { await Promise.resolve(); seen.push({ ...cut, rawBody: Buffer.from(cut.rawBody) }); } });
      const cut = cutFor(point), original = Buffer.from(cut.rawBody);
      const done = seam.establishCut(cut);
      cut.rawBody.fill(0);
      await done;
      assert.deepEqual(seen.map(({ rawBody, ...rest }) => ({ ...rest, rawBody: rawBody.toString('hex') })),
        [{ point, jobId: JOB_ID, path: PAYMENTS_PATH, rawBody: original.toString('hex') }]);
    }
  });

  await t.test('the adapter cut is a frozen record that does not share the caller body buffer', async () => {
    let received;
    const { seam } = seamOver({ mode: 'legacy', establishCut: async cut => { received = cut; } });
    const cut = cutFor('reservation-before-work');
    await seam.establishCut(cut);
    assert.ok(Object.isFrozen(received));
    assert.notEqual(received.rawBody.buffer, cut.rawBody.buffer);
  });

  await t.test('one cut keeps the original claim, signed transaction, retained work and delivery counters', async () => {
    // The adapter stands in for the journal-specific setup: it records the
    // claim it was handed and performs no signing, broadcast or delivery.
    const world = { claims: [], signed: [], broadcast: [], deliveries: 0, retained: null };
    const { seam } = seamOver({ mode: 'legacy', establishCut: async ({ rawBody }) => { world.claims.push(JSON.parse(Buffer.from(rawBody).toString())); } });
    const before = structuredClone(world);
    await seam.establishCut(cutFor('reservation-before-work'));
    assert.deepEqual(world.claims, [paymentBody()], 'the claim is the original body, unchanged');
    assert.deepEqual({ ...world, claims: [] }, { ...before, claims: [] }, 'nothing was signed, broadcast, retained or delivered');
  });

  await t.test('a bad cut is a TypeError and never reaches the adapter', async () => {
    let calls = 0;
    const { seam } = seamOver({ mode: 'legacy', establishCut: async () => { calls++; } });
    const good = cutFor('reservation-before-work');
    for (const change of [{ point: 'after-finish' }, { jobId: '' }, { jobId: 7 }, { path: 'dacs/v1/payments' }, { path: 1 },
      { rawBody: JSON.stringify(paymentBody()) }, { rawBody: undefined }]) {
      await assert.rejects(seam.establishCut({ ...good, ...change }), TypeError, JSON.stringify(Object.keys(change)));
    }
    await assert.rejects(seam.establishCut(null), TypeError);
    assert.equal(calls, 0);
  });

  await t.test('an adapter failure keeps its own error', async () => {
    const cause = new Error('TEST adapter refused the cut');
    const { seam } = seamOver({ mode: 'legacy', establishCut: async () => { throw cause; } });
    await assert.rejects(seam.establishCut(cutFor('work-before-completion')), error => error === cause);
  });
});

test('native-retry-clock-does-not-expire-scope', async (t) => {
  // A delegation and an Agreement window as the retry tests build them.
  const scopeFor = (window) => ({ ...window, live: (now) => now >= window.notBefore && now <= window.expiresAt && now <= window.agreementDeadline });
  const plannedLapses = 3;
  const crossLease = ({ seam, clocks, lease }) => { lease.until = clocks.wallNow() + LEASE_MS; seam.beforeRetry(); };

  await t.test('every planned lapse stays inside a delegation and Agreement window sized for them', () => {
    const world = seamOver({ mode: 'wire' });
    const horizon = T0 + (plannedLapses + 1) * LEASE_MS;
    const scope = scopeFor({ notBefore: T0 - 1000, expiresAt: horizon, agreementDeadline: horizon });
    for (let lapse = 1; lapse <= plannedLapses; lapse++) {
      crossLease(world);
      assert.equal(world.clocks.wallNow(), T0 + lapse * LEASE_MS);
      assert.equal(world.clocks.monotonicNow(), lapse * LEASE_MS, 'both clocks moved together');
      assert.ok(scope.live(world.clocks.wallNow()), `lapse ${lapse} leaves the scope live`);
    }
    assert.deepEqual(world.advances, Array(plannedLapses).fill(LEASE_MS));
  });

  await t.test('an intentional expiry still expires: a window shorter than the lapse is dead after it', () => {
    const world = seamOver({ mode: 'wire' });
    const scope = scopeFor({ notBefore: T0 - 1000, expiresAt: T0 + LEASE_MS - 1, agreementDeadline: T0 + 10 * LEASE_MS });
    assert.ok(scope.live(world.clocks.wallNow()));
    crossLease(world);
    assert.equal(scope.live(world.clocks.wallNow()), false);
  });

  await t.test('the wall clock never falls behind a later fixture block after a lapse', () => {
    let blockMs = T0;
    const world = seamOver({ mode: 'wire', clocks: fakeClocks(() => blockMs) });
    crossLease(world);
    const afterLapse = world.clocks.wallNow();
    blockMs = T0 + 2_000;
    assert.equal(world.clocks.wallNow(), afterLapse, 'an earlier block cannot undo the lapse');
    blockMs = afterLapse + 2_000;
    assert.equal(world.clocks.wallNow(), afterLapse + 2_000, 'a later block still moves the clock forward');
  });
});

test('native-clock-does-not-settle-work', async (t) => {
  // A live worker holds retained work behind an explicit barrier; only the
  // test releasing the barrier lets it settle.
  const liveWorker = () => {
    const worker = { settled: false, release: null, effects: { signed: 1, broadcast: 1, deliveries: 0 }, retained: { claim: paymentBody(), signedBytes: 'TEST-signed-create' } };
    worker.done = new Promise(resolve => { worker.release = resolve; }).then(() => { worker.settled = true; });
    return worker;
  };

  await t.test('crossing the lease does not settle a live worker or clear its retained work and effects', async () => {
    const worker = liveWorker(), before = structuredClone({ retained: worker.retained, effects: worker.effects });
    let cuts = 0;
    const world = seamOver({ mode: 'wire', establishCut: async () => { cuts++; } });
    world.lease.until = world.clocks.wallNow() + LEASE_MS;
    world.seam.beforeRetry();
    await Promise.resolve();
    assert.equal(worker.settled, false, 'the worker is still behind its barrier');
    assert.deepEqual({ retained: worker.retained, effects: worker.effects }, before);
    assert.equal(cuts, 0, 'a retry does not invent a cut');
    worker.release();
    await worker.done;
    assert.equal(worker.settled, true, 'only the barrier settles the worker');
  });

  await t.test('the seam offers no way to settle work, clear retained state or reset a clock', () => {
    const { seam } = seamOver({ mode: 'wire' });
    assert.deepEqual(Object.keys(seam).sort(), ['beforeRetry', 'establishCut']);
    assert.ok(Object.isFrozen(seam));
  });
});
