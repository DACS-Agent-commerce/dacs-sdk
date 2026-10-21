// An interrupted Start is retried by starting again: the server issues a new
// Start record, the buyer approves it, and the wallet may sign the same steps
// under that new approval. The durable journal still refuses a step requested
// twice under one record (one approval), across reloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixturePurchase, withListingHash, viewFor, identityFor } from './helpers/start-intent.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createIntentGate } from '../public/portal-intent/gate.mjs';
import { createSignatureJournal } from '../public/portal-intent/signature-journal.mjs';
import { runStart } from '../public/portal-intent/start-flow.mjs';
import { checkSellerSessionDelegation } from '../public/portal/seller-session-delegation.mjs';
import { attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';

const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const signed = [];
class Counting extends runtime.Demos { async signMessage(m, o) { signed.push(String(m)); return super.signMessage(m, o); } }

// IndexedDB's add uniqueness over one retained store, shared by every "reload".
const claims = new Map();
const indexedDB = { open() {
  const request = {};
  queueMicrotask(() => { request.result = { transaction() {
    const tx = { objectStore: () => ({ add(value, key) { queueMicrotask(() => { if (claims.has(key)) { tx.error = new Error('ConstraintError'); tx.onabort(); } else { claims.set(key, value); tx.oncomplete(); } }); } }) };
    return tx;
  } }; request.onsuccess(); });
  return request;
} };

let mnemonic;
// One page load: a new gate and SDK session over the same wallet and storage.
async function page() {
  const gate = createIntentGate({ approve: async () => true, checkDelegation: checkSellerSessionDelegation, claimSignature: createSignatureJournal({ indexedDB }) });
  const session = createSdkWalletSession({ DemosCtor: Counting, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, approve: gate.approve });
  if (mnemonic) await session.importMnemonic(mnemonic); else { await session.create(); mnemonic = session.exportMnemonicForUser(); }
  gate.attach(session);
  return { gate, session, address: session.getPublicAccount().address };
}

test('after a lost /sign answer, a new approved Start signs the same messages again and completes; the old record cannot', async () => {
  const first = await page();
  const now = Date.now();
  const p = await withListingHash(fixturePurchase({ address: first.address, now }));
  const view = viewFor(p, { now });
  const unsigned = identityFor(p, first.address, now);
  view.start.identity = { bundle: unsigned.bundle };
  // The server: one identity bundle and one Agreement plan for the purchase;
  // a new Start record on every /start (start-intent.mjs issue()).
  let plan = null; let records = 0; let record = null;
  const server = ({ loseSign = false, reuseRecord = false } = {}) => async (path, body) => {
    if (path.endsWith('/start')) {
      if (!reuseRecord) record = `rec_${String(++records).padStart(22, '0')}`;
      return { ...view, start: { ...view.start, intent: { ...view.start.intent, id: record }, needs: { identitySignature: !plan } } };
    }
    if (path.endsWith('/plan')) {
      assert.equal(body.intent, record);
      plan ??= planAgreement({ jobId: p.jobId, listing: p.listing, buyerBundle: attachIdentityPresentation(unsigned, body.signature), generatedAt: now });
      return { plan: { draft: plan.draft, needs: { agreementSignature: true } } };
    }
    if (path.endsWith('/sign')) {
      if (loseSign) throw new Error('network: response lost');
      return { status: 'agreement_pending', evidence: { protocol: { stage: 'committed' } } };
    }
    throw new Error(path);
  };
  const start = (tab, api) => runStart({ id: p.id, token: 't', address: tab.address, gate: tab.gate, api, origin: 'http://127.0.0.1' });

  await assert.rejects(start(first, server({ loseSign: true })), /response lost/);
  const [agreementMessage, anchorMessage] = signed.slice(-2);
  assert.equal(agreementMessage, plan.agreementMessage);
  assert.equal(anchorMessage, plan.anchorMessage);
  first.session.lock();

  // A reload replaying the same Start record (the same approval) signs nothing.
  const replay = await page();
  let before = signed.length;
  await assert.rejects(start(replay, server({ reuseRecord: true })), (e) => e.code === 'intent_mismatch' && e.field === 'journal');
  assert.equal(signed.length, before);
  replay.session.lock();

  // A reload with a new Start: the buyer approves again and the retry completes.
  const retry = await page();
  before = signed.length;
  const next = await start(retry, server());
  assert.equal(next.evidence.protocol.stage, 'committed');
  assert.deepEqual(signed.slice(before), [agreementMessage, anchorMessage], 'the same Agreement and anchor messages, once each');
  retry.session.lock();
});
