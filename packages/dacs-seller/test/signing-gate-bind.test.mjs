import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWhenNoSigningGate } from '../src/dacs/signing-gate-bind.mjs';

const SETTLEMENT = 'TEST-settlement';
const openGate = (gates, id) => {
  let open;
  gates.set(id, new Promise((resolve) => { open = resolve; }));
  return () => { gates.delete(id); open(); };
};

test('a gate registered in the microtask after the check does not sit between the check and the bind', async () => {
  const gates = new Map(), seenAtBind = [];
  const has = gates.has.bind(gates);
  // The microtask is queued by the last check, as another job's submission passing its signing check would be.
  gates.has = (id) => { const held = has(id); if (!held) queueMicrotask(() => openGate(gates, id)); return held; };
  await bindWhenNoSigningGate(gates, SETTLEMENT, () => { seenAtBind.push(has(SETTLEMENT)); return true; });
  assert.deepEqual(seenAtBind, [false], 'the bind ran in the same step as the check that found no gate');
});

test('a held gate delays the bind until the submission has returned', async () => {
  const gates = new Map(), events = [], release = openGate(gates, SETTLEMENT);
  const bound = bindWhenNoSigningGate(gates, SETTLEMENT, () => { events.push('bind'); return true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [], 'no bind while the gate is held');
  events.push('release'); release();
  await bound;
  assert.deepEqual(events, ['release', 'bind']);
});

test('a gate set again as the first one is released is waited for too', async () => {
  const gates = new Map(), events = [], releaseFirst = openGate(gates, SETTLEMENT);
  let releaseSecond;
  const bound = bindWhenNoSigningGate(gates, SETTLEMENT, () => { events.push('bind'); return true; });
  // The next submission passes its check in the same turn that the first one returns.
  releaseFirst(); releaseSecond = openGate(gates, SETTLEMENT);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [], 'the replacement gate is still held');
  releaseSecond();
  await bound;
  assert.deepEqual(events, ['bind']);
});

test('the bind result is returned, so a collision answer can follow', async () => {
  assert.equal(await bindWhenNoSigningGate(new Map(), SETTLEMENT, () => false), false);
  assert.equal(await bindWhenNoSigningGate(new Map(), SETTLEMENT, () => true), true);
});

test('a gate on another settlement does not delay the bind', async () => {
  const gates = new Map(); openGate(gates, 'TEST-other-settlement');
  assert.equal(await bindWhenNoSigningGate(gates, SETTLEMENT, () => true), true);
});

test('a bind that throws rejects the call', async () => {
  await assert.rejects(bindWhenNoSigningGate(new Map(), SETTLEMENT, () => { throw new Error('TEST bind refused'); }), /TEST bind refused/);
});
