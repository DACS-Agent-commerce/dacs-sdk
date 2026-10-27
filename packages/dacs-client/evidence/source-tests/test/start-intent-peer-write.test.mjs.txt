// A Start dropped after the gate approved its wallet write or signature
// (a peer tab's Start, a newer Start, a lock) must not still send it. The
// write is stopped before the wallet records it as issued and broadcasts it;
// a signature that completes after the drop is discarded. The same case with
// the real SDK and the devnet loopback chain is in start-intent-devnet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatedWallet, fixturePurchase, withListingHash, viewFor, identityFor } from './helpers/start-intent.mjs';
import { createIntentGate, START_ANNOUNCEMENT } from '../public/portal-intent/gate.mjs';
import { buildIntent, DEVNET_CREATE_KIND } from '../public/portal-intent/intent.mjs';
import { attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';
import { EmbeddedWalletError } from '../public/portal/embedded-wallet/sdk-provider.mjs';

const peerStart = (address) => ({ type: START_ANNOUNCEMENT, wallet: address });

// Gate-level: the covered CREATE approved, then the journal issue.
const w = await gatedWallet();
const now = Date.now();
async function approvedCreate() {
  const p = await withListingHash(fixturePurchase({ address: w.address, now, devnet: true }));
  const view = viewFor(p, { now });
  const unsigned = identityFor(p, w.address, now);
  view.start.identity = { bundle: unsigned.bundle };
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  await w.gate.open(intent);
  const signature = await w.gate.signIdentity(unsigned.bundle);
  const plan = planAgreement({ jobId: p.jobId, listing: p.listing, buyerBundle: attachIdentityPresentation(unsigned, signature), generatedAt: now });
  await w.gate.noteAgreement(plan.draft);
  w.gate.expectAgreementCreate();
  const approved = await w.gate.approve({ method: 'sendTransaction', address: w.address, content: {
    kind: DEVNET_CREATE_KIND, artifactKind: 'Agreement', jobId: p.jobId, logicalAddress: `dacs3:agreement:${p.jobId}`, owner: intent.buyer, wallet: w.address,
    contentHash: plan.plan.agreementHash, exactStorageBytes: JSON.stringify(plan.draft), network: intent.network.name, chainIdentity: intent.network.chainIdentity, nonce: 1, debit: { totalOs: '1' },
  } });
  assert.equal(approved, true);
}
function recordingJournal() {
  const puts = [];
  return { puts, journal: { get: async () => undefined, put: async (key, value) => { puts.push(value.stage); }, withWalletLock: (key, work) => work() } };
}

for (const drop of ['peer Start', 'newer Start in this tab', 'lock']) {
  test(`an approved CREATE is not issued after a ${drop}`, async () => {
    const { puts, journal } = recordingJournal();
    const fenced = w.gate.fenceJournal(journal, EmbeddedWalletError);
    await approvedCreate();
    if (drop === 'peer Start') w.gate.peerStarted(peerStart(w.address));
    else if (drop === 'lock') w.gate.finish();
    else await assert.rejects(w.gate.open({ wallet: w.address, expiresAt: 0 }), (e) => e.code === 'intent_mismatch');
    // The session reports only its own errors' codes; anything else would
    // be recorded as an internal failure of the wallet.
    await assert.rejects(fenced.put('lane', { stage: 'broadcast-started' }), (e) => e instanceof EmbeddedWalletError && e.code === 'superseded' && /^Nothing was sent: .*this purchase is closed/.test(e.message));
    assert.deepEqual(puts, []);
    assert.equal(w.gate.lastRefusal.field, 'superseded');
    assert.match(w.gate.lastRefusal.message, /prepare a new purchase/);
  });
}
test('the fence cannot be built without the wallet session error class', () => {
  assert.throws(() => w.gate.fenceJournal(recordingJournal().journal), TypeError);
  assert.equal(w.gate.fenceJournal(undefined), undefined, 'no journal, nothing to fence');
});
test('an approved CREATE under a live Start is issued, and its outcome recorded', async () => {
  const { puts, journal } = recordingJournal();
  const fenced = w.gate.fenceJournal(journal, EmbeddedWalletError);
  await approvedCreate();
  await fenced.put('lane', { stage: 'broadcast-started' });
  await fenced.put('lane', { stage: 'broadcast-accepted' });
  assert.deepEqual(puts, ['broadcast-started', 'broadcast-accepted']);
  w.gate.finish();
});
test('a drop after the CREATE was issued does not stop recording its outcome', async () => {
  const { puts, journal } = recordingJournal();
  const fenced = w.gate.fenceJournal(journal, EmbeddedWalletError);
  await approvedCreate();
  await fenced.put('lane', { stage: 'broadcast-started' });
  w.gate.peerStarted(peerStart(w.address));
  await fenced.put('lane', { stage: 'broadcast-accepted' });
  assert.deepEqual(puts, ['broadcast-started', 'broadcast-accepted']);
});
test('a later per-step write is not held back by an older approved CREATE that never issued', async () => {
  const { puts, journal } = recordingJournal();
  const fenced = w.gate.fenceJournal(journal, EmbeddedWalletError);
  await approvedCreate();
  w.gate.finish(); // the Start ended before the session issued its CREATE
  assert.equal(await w.gate.approve({ method: 'sendTransaction', address: w.address, content: { kind: DEVNET_CREATE_KIND } }), true, 'normal dialog');
  await fenced.put('lane', { stage: 'broadcast-started' });
  assert.deepEqual(puts, ['broadcast-started']);
});
test('a message signature that completes after a peer Start is discarded', async () => {
  const p = await withListingHash(fixturePurchase({ address: w.address, now }));
  const view = viewFor(p, { now });
  const unsigned = identityFor(p, w.address, now);
  view.start.identity = { bundle: unsigned.bundle };
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  let began; let release;
  const signing = new Promise((resolve) => { began = resolve; });
  const gate = createIntentGate({ approve: async () => true, now: () => now });
  gate.attach({ isLocked: () => false, getPublicAccount: () => ({ address: w.address }), request: async ({ params }) => {
    const ok = await gate.approve({ method: 'sign', address: w.address, message: params[0] });
    began(); await new Promise((resolve) => { release = resolve; });
    return ok ? { success: true, data: { signature: 'signature' } } : { success: false };
  } });
  await gate.open(intent);
  const pending = gate.signIdentity(unsigned.bundle);
  const refused = assert.rejects(pending, (e) => e.code === 'intent_mismatch' && e.field === 'superseded');
  await signing;
  gate.peerStarted(peerStart(w.address));
  release();
  await refused;
});
test.after(() => w.session.lock());
