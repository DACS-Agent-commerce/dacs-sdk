// F1 repair boundaries (docs/DENIED-AGREEMENT-RECOVERY.md). Actual OAuth/MCP,
// portal, loopback broker and packaged SDK wallet over a reopenable SQLite
// journal; approvals are synthetic consent and the chain is a local fixture.
// The accepting control is I4 in dacs-current-broker-interactions.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeBrokerSetup } from './helpers/current-broker-interactions.mjs';
import { DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } from '../src/dacs/demos-sr2-adapter.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const adapterOf = async (w, op) => (await w.store.adapters()).find((a) => a.logicalAddress === op.logicalAddress)?.stage ?? null;
const rawAdapter = async (w, op) => (await w.store.journal.entries()).find(([k, v]) => k.startsWith('sr2/adapter/') && v.logicalAddress === op.logicalAddress)?.[1];

test('denial recorded before a restart: the restarted consumer retires it once on recheck; reopened journal keeps the terminal record; nothing sent', async (t) => {
  const w = await nodeBrokerSetup(t, runtime);
  const x = await w.operation('x');
  await x.authenticate(); await x.submit();
  w.decision.allow = false;
  assert.equal((await x.approveOne()).state, 'denied');
  assert.equal(await adapterOf(w, x), 'handoff-issued', 'the denial alone retires nothing');
  await w.restart();
  assert.equal((await x.recheck()).stage, 'agreement-rejected');
  assert.equal(await adapterOf(w, x), 'denied-unsigned');
  const retired = await rawAdapter(w, x);
  assert.deepEqual(retired.retirement, { reason: 'explicit-wallet-denial-without-signed-record', observedAccountNonce: 0 });
  assert.equal(retired.authorizedTransaction, undefined);
  await w.store.reopen();
  assert.equal(await adapterOf(w, x), 'denied-unsigned', 'retained across reopen');
  assert.equal((await x.record()).stage, 'denied');
  assert.deepEqual(await w.store.lanes(), []);
  assert.equal(w.broadcasts(), 0); assert.equal(w.createApprovals(), 1);
});

test('guard witness: a signed lane record naming X keeps the denied handoff fenced and fresh Y wallet-fenced', async (t) => {
  const w = await nodeBrokerSetup(t, runtime);
  const x = await w.operation('x'), y = await w.operation('y');
  await x.authenticate(); await x.submit();
  w.decision.allow = false;
  assert.equal((await x.approveOne()).state, 'denied');
  w.decision.allow = true;
  // Test-only public-shaped fault: a lane record naming X's address (another
  // content hash, so the broker still takes its denial branch).
  const lane = `sr2/wallet/${JSON.stringify([w.h.config.chain.network, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY, w.address])}`;
  await w.store.journal.put(lane, { stage: 'broadcast-started', nonce: 1, hash: '0'.repeat(64), approved: { logicalAddress: x.logicalAddress, contentHash: '1'.repeat(64) } });
  assert.equal((await x.verify()).protocol.stage, 'agreement-rejected', 'the explicit denial still rejects X');
  assert.equal(await adapterOf(w, x), 'handoff-issued', 'unsigned proof failed: not retired');
  await y.authenticate();
  const py = (await y.submit()).evidence.protocol;
  assert.match(py.lastAttempt.reason, /wallet-fenced/);
  assert.equal(y.anchor(), null); assert.equal(await y.record(), undefined);
  assert.equal(w.broadcasts(), 0);
});

test('boundary: a queued X (delivered to no browser) is never retired and keeps fencing fresh Y; no deletion', async (t) => {
  const w = await nodeBrokerSetup(t, runtime);
  const x = await w.operation('x'), y = await w.operation('y');
  await x.authenticate(); await x.submit();
  assert.equal((await x.record()).stage, 'queued');
  assert.equal((await x.verify()).protocol.stage, 'agreement-signing');
  assert.equal(await adapterOf(w, x), 'handoff-issued');
  await y.authenticate();
  assert.match((await y.submit()).evidence.protocol.lastAttempt.reason, /wallet-fenced/);
  await w.restart();
  assert.equal((await x.recheck()).stage, 'agreement-signing');
  assert.equal(await adapterOf(w, x), 'handoff-issued', 'queued intent survives restart unretired');
  assert.equal((await x.record()).stage, 'queued');
  assert.equal(w.broadcasts(), 0); assert.equal(w.createApprovals(), 0);
});

test('boundary: an unavailable chain observation during the denial recheck retires nothing; X is still rejected and fresh Y stays fenced (residual F1)', async (t) => {
  const w = await nodeBrokerSetup(t, runtime);
  const x = await w.operation('x'), y = await w.operation('y');
  await x.authenticate(); await x.submit();
  w.decision.allow = false;
  assert.equal((await x.approveOne()).state, 'denied');
  w.decision.allow = true;
  w.chain.faults.unavailable = true;
  const px = (await x.verify()).protocol;
  w.chain.faults.unavailable = false;
  assert.equal(px.stage, 'agreement-rejected');
  assert.equal(await adapterOf(w, x), 'handoff-issued', 'no proof, no retirement');
  await y.authenticate();
  assert.match((await y.submit()).evidence.protocol.lastAttempt.reason, /wallet-fenced/);
  assert.equal(await y.record(), undefined);
  assert.equal(w.broadcasts(), 0);
});

test('denial recovery connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
