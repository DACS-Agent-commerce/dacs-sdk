// The live failure on PR the source change's purchase, end to end through the portal's HTTP
// plan route with the real devnet demo provider behind it (both reviews asked
// for this): plan request 1 waits in the seller's approval of its own CVR,
// request 2 arrives while it waits, and both finish with exactly one buyer and
// one seller CVR CREATE. Fixture chain and loopback servers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionApp } from './helpers/devnet-live-composition-app.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { post } from './helpers/public-sr2-projection-flow.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, ms) => Promise.race([promise.then((value) => ({ value })), sleep(ms).then(() => 'pending')]);

// gated: whose CVR approval waits for the gate, as a TTY prompt does.
async function world(t, { planWaitMs, gated = 'seller' } = {}) {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const ctl = { prompts: [], buyerAddr: null, sellerAddr: null };
  const approve = async (request) => { const address = request.content?.logicalAddress; ctl.prompts.push(address); return address === (gated === 'seller' ? ctl.sellerAddr : ctl.buyerAddr) ? gate : true; };
  const h = await startDevnetLiveCompositionApp({ approve, planWaitMs }); t.after(async () => { release(true); await h.close(); });
  globalThis.location = new URL(h.origin); globalThis.window ??= globalThis; globalThis.document ??= { baseURI: `${h.origin}/portal/assets/embedded-wallet/`, currentScript: null };
  const buyerActor = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin)) }); t.after(() => buyerActor.close());
  const wallet = buyerActor.walletFactory({ anchorJournal: { get: async () => null, put: async () => { throw new Error('TEST no buyer write'); }, withWalletLock: (_key, work) => work() } });
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: h.composition.listing.listingId, version: 1, seller: h.sellerActor.signer.claim, idempotencyKey: `route-single-vet-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl), api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  const jobId = h.app.services.ops.get(h.app.services.accounts.walletOwner(address), id).terms.protocol.jobId;
  ctl.buyerAddr = compositeVerificationAddress(jobId, buyerActor.signer.claim); ctl.sellerAddr = compositeVerificationAddress(jobId, h.sellerActor.signer.claim);
  const identity = await api('agreement/identity', { address });
  const signature = await sign(identity.signRequest.message);
  const creates = () => h.transport.chain.wire.record.accepted.length;
  const prompted = (address) => ctl.prompts.filter((entry) => entry === address).length;
  const waitForSellerPrompt = async () => { while (!prompted(ctl.sellerAddr)) await sleep(20); };
  return { h, ctl, api, signature, release, creates, prompted, waitForSellerPrompt, buyerActor, jobId, id, accountId: h.app.services.accounts.walletOwner(address) };
}

function oneVetEach(w) {
  assert.equal(w.creates(), 3, 'Listing, one buyer CVR and one seller CVR CREATE');
  assert.equal(w.prompted(w.ctl.buyerAddr), 1); assert.equal(w.prompted(w.ctl.sellerAddr), 1);
  assert.deepEqual(w.h.composition.contextProvider.invocations.map((entry) => entry.evaluatedParty).sort(), [w.buyerActor.signer.claim, w.h.sellerActor.signer.claim].sort(), 'one buyer and one seller Vet');
}

test('route: a second plan request during the seller\'s approval waits for the first; both get the one plan', { timeout: 180000 }, async (t) => {
  const w = await world(t);
  assert.equal(w.creates(), 1, 'Listing only');
  const first = w.api('agreement/plan', { signature: w.signature });
  await w.waitForSellerPrompt();
  assert.equal(w.creates(), 2, 'Listing and buyer CVR');
  const second = w.api('agreement/plan', { signature: w.signature });
  assert.equal(await within(second, 1500), 'pending', 'request 2 waits for request 1 instead of signing a new record');
  w.release(true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.httpStatus, 200, JSON.stringify(a)); assert.equal(b.httpStatus, 200, JSON.stringify(b));
  assert.equal(b.signRequest.agreementHash, a.signRequest.agreementHash);
  oneVetEach(w);
  // Saved: the provider keeps only that request's context; ended: none.
  const contexts = () => [...w.h.composition.contextProvider.contexts.values()].filter((entry) => entry.input.jobId === w.jobId).length;
  assert.equal(contexts(), 1);
  const rows = async () => (await w.h.partyVetStore.entries()).filter(([, row]) => row.jobId === w.jobId).length;
  assert.equal(await rows(), 1);
  // The health report shows the party Vet store's use.
  const health = await fetch(`${w.h.origin}/health`).then((response) => response.json());
  assert.deepEqual({ jobs: health.dependencies.partyVetStore.jobs, maxJobs: health.dependencies.partyVetStore.maxJobs, remainingJobs: health.dependencies.partyVetStore.remainingJobs }, { jobs: 1, maxJobs: 4096, remainingJobs: 4095 });
  assert.ok(health.dependencies.partyVetStore.bytes > 0);
  assert.equal((await w.h.app.services.purchases.cancel({ accountId: w.accountId, operationId: w.id })).cancelled, true);
  await sleep(0);
  assert.equal(contexts(), 0, 'released once the purchase ended');
  while (await rows()) await sleep(10);
  assert.equal(w.h.partyVetStore.usage().jobs, 0, 'the ended job\'s party Vet row is deleted');
});

// Code review R10: the purchase check the provider runs before each write
// includes the approval window, even when nothing else touches the purchase.
test('route: the approval window passes while the buyer CVR waits for approval; the seller Vet is not signed or sent', { timeout: 180000 }, async (t) => {
  const w = await world(t, { gated: 'buyer' });
  const plan = w.api('agreement/plan', { signature: w.signature });
  while (!w.prompted(w.ctl.buyerAddr)) await sleep(20);
  // The window elapses; nothing reads or writes the purchase meanwhile.
  w.h.app.db.prepare('UPDATE operations SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), w.id);
  w.release(true);
  const out = await plan;
  assert.notEqual(out.httpStatus, 200, JSON.stringify(out));
  assert.equal(w.prompted(w.ctl.sellerAddr), 0, 'no seller CVR approval asked');
  assert.equal(w.creates(), 2, 'Listing and the buyer CVR only');
  assert.deepEqual(w.h.composition.contextProvider.invocations.map((entry) => entry.evaluatedParty), [w.buyerActor.signer.claim], 'no seller Vet');
});

test('route: when the seller\'s approval outlasts the wait bound, both requests get 202 and the step still saves its one plan', { timeout: 180000 }, async (t) => {
  const w = await world(t, { planWaitMs: 1000 });
  const first = w.api('agreement/plan', { signature: w.signature });
  await w.waitForSellerPrompt();
  const second = w.api('agreement/plan', { signature: w.signature });
  for (const out of await Promise.all([first, second])) { assert.equal(out.httpStatus, 202, JSON.stringify(out)); assert.equal(out.error, 'plan_in_progress'); }
  assert.equal((await w.api('view')).evidence.protocol.stage, 'identity', 'nothing saved yet');
  w.release(true);
  let view;
  do { await sleep(50); view = await w.api('view'); } while (view.evidence.protocol.stage !== 'agreement-signing');
  // The page continues from the saved plan without a signature.
  const saved = await w.api('agreement/plan');
  assert.equal(saved.httpStatus, 200, JSON.stringify(saved)); assert.match(saved.signRequest.agreementHash, /^[0-9a-f]{64}$/);
  oneVetEach(w);
});
