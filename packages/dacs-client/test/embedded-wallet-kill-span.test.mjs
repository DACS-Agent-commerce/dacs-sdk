// The embedded wallet's storage CREATE reads the host's stop check after signing, after confirmation before its
// `broadcast-started` marker, and after that marker before broadcast. The stop is a real KILL file read by the seller kit's
// check; the session, its SDK and its journal are the real ones, against the loopback anchor fixture. No network or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorRequest, memoryAnchorJournal, startAnchorFixture } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { loadNodeDemos } from '../src/wallet/node-demos-loading.mjs';
import { createSdkWalletSession } from '../src/public/portal/embedded-wallet/sdk-provider.mjs';
import { createStopCheck } from '../../dacs-seller/src/kill-switch.mjs';

const { Demos, validateMnemonic } = await loadNodeDemos();

const NETWORK = 'TEST-loopback-network';
const MARKER = 'broadcast-started';

// One session over the fixture chain. `cuts` hooks run as the SDK's sign and confirm return and as the marker is written.
async function world(t, { stopped } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'embedded-wallet-kill-span-'));
  const dataDirectory = join(root, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  const chain = await startAnchorFixture();
  t.after(async () => { await chain.close(); rmSync(root, { recursive: true, force: true }); });
  const cuts = {};
  class CutDemos extends Demos {
    async sign(...args) { const signed = await super.sign(...args); cuts.afterSign?.(); return signed; }
    async confirm(...args) { const validity = await super.confirm(...args); cuts.afterConfirm?.(); return validity; }
  }
  const memory = memoryAnchorJournal();
  let markerWrites = 0;
  const journal = { ...memory, put: (key, value) => { memory.put(key, value); if (value?.stage === MARKER) { markerWrites += 1; cuts.afterMarker?.(); } } };
  const session = createSdkWalletSession({ DemosCtor: CutDemos, validateMnemonic, anchorJournal: journal,
    transactionTransport: { profile: 'simulated-loopback', network: NETWORK, rpcUrl: `${chain.url}/portal/api/wallet-rpc` }, approve: async () => true,
    stopped: stopped ?? createStopCheck(dataDirectory) });
  const account = await session.create();
  t.after(() => session.lock());
  const kill = join(dataDirectory, 'KILL');
  return {
    chain, cuts,
    createKill: () => writeFileSync(kill, ''),
    removeKill: () => rmSync(kill, { force: true }),
    send: () => session.request({ method: 'sendTransaction', params: [anchorRequest(account.address, NETWORK)] }),
    counts: () => ({ confirms: chain.record.confirms.length, broadcasts: chain.record.broadcastAttempts.length, markers: markerWrites }),
    retainedMarkers: () => memory.snapshot().filter(([, value]) => value?.stage === MARKER).length,
  };
}
const refusedWith = (answer, code) => {
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.equal(answer.error.code, code, answer.error.message);
};

test('the provider checks KILL after signing, after confirmation before the issued marker, and after the marker before broadcast', async (t) => {
  await t.test('with no KILL the CREATE confirms and broadcasts once', async (s) => {
    const w = await world(s);
    const answer = await w.send();
    assert.equal(answer.success, true, JSON.stringify(answer));
    assert.deepEqual(w.counts(), { confirms: 1, broadcasts: 1, markers: 1 });
  });

  await t.test('KILL created as the signature returns: no confirm and no broadcast', async (s) => {
    const w = await world(s);
    w.cuts.afterSign = w.createKill;
    refusedWith(await w.send(), 'writes_stopped');
    assert.deepEqual(w.counts(), { confirms: 0, broadcasts: 0, markers: 0 });
  });

  await t.test('KILL created during confirmation: no marker and no broadcast, and the nonce lane stays usable', async (s) => {
    const w = await world(s);
    w.cuts.afterConfirm = w.createKill;
    refusedWith(await w.send(), 'writes_stopped');
    assert.deepEqual(w.counts(), { confirms: 1, broadcasts: 0, markers: 0 });
    delete w.cuts.afterConfirm;
    w.removeKill();
    const again = await w.send();
    assert.equal(again.success, true, JSON.stringify(again));
    assert.deepEqual(w.counts(), { confirms: 2, broadcasts: 1, markers: 1 }, 'a later unstopped write uses the same nonce');
  });

  await t.test('KILL created as the marker is written: the marker stays for readback, nothing is broadcast or retried', async (s) => {
    const w = await world(s);
    w.cuts.afterMarker = w.createKill;
    refusedWith(await w.send(), 'writes_stopped');
    assert.deepEqual(w.counts(), { confirms: 1, broadcasts: 0, markers: 1 });
    assert.equal(w.retainedMarkers(), 1, 'the issued marker is kept for readback');
    delete w.cuts.afterMarker;
    w.removeKill();
    await w.send();
    assert.equal(w.counts().broadcasts, 0, 'the issued marker is never broadcast again by this provider');
    assert.equal(w.retainedMarkers(), 1);
  });
});

test('a stop check that throws, answers a promise or answers a non-boolean refuses before the confirm', async (t) => {
  const cases = [
    ['throws', () => { throw new Error('TEST stop check failure'); }, 'stop_check_failed'],
    ['answers a rejected promise', () => Promise.reject(new Error('TEST rejected stop check')), 'stop_check_invalid'],
    ['answers a string', () => 'yes', 'stop_check_invalid'],
  ];
  for (const [name, stopped, code] of cases) {
    const w = await world(t, { stopped });
    refusedWith(await w.send(), code);
    assert.deepEqual(w.counts(), { confirms: 0, broadcasts: 0, markers: 0 }, name);
  }
});

test('a stop seam that is not a function is refused when the session is made', () => {
  assert.throws(() => createSdkWalletSession({ DemosCtor: Demos, stopped: true }), { name: 'TypeError', message: 'stop_seam_invalid' });
});
