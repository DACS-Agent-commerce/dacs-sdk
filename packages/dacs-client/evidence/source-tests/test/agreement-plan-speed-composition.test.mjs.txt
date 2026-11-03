// PR the source change composed with Start intent (the source change) and commitment on signature (the source change).
// Start refuses DEM context profiles before touching the plan. The service's
// approved-generation-time path is also exercised with the real Vet provider,
// so a future caller cannot skip the shared flight or cancellation checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionApp } from './helpers/devnet-live-composition-app.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { post } from './helpers/public-sr2-projection-flow.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';

import { createSellerTransportClientAuth } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, ms) => Promise.race([promise.then((value) => ({ value })), sleep(ms).then(() => 'pending')]);

// gated: whose CVR approval waits for the gate, as a TTY prompt does.
async function world(t, { planWaitMs, gated = 'seller', commitOnSignature = false } = {}) {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const ctl = { prompts: [], buyerAddr: null, sellerAddr: null };
  const approve = async (request) => { const address = request.content?.logicalAddress; ctl.prompts.push(address); return address === (gated === 'seller' ? ctl.sellerAddr : ctl.buyerAddr) ? gate : true; };
  const h = await startDevnetLiveCompositionApp({ approve, planWaitMs, intentApproval: true, commitOnSignature }); t.after(async () => { release(true); await h.close(); });
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
  const generatedAt = Date.now();
  await sleep(20); // the approved time precedes planning, after identity presentation
  const servicePlan = () => h.app.services.purchases.agreementPlan({ operationId: id, token, signature, intentGeneratedAt: generatedAt });
  const creates = () => h.transport.chain.wire.record.accepted.length;
  const prompted = (address) => ctl.prompts.filter((entry) => entry === address).length;
  const waitForSellerPrompt = async () => { while (!prompted(ctl.sellerAddr)) await sleep(20); };
  return { h, ctl, api, signature, release, creates, prompted, waitForSellerPrompt, buyerActor, jobId, id, servicePlan, generatedAt, accountId: h.app.services.accounts.walletOwner(address) };
}

function oneVetEach(w) {
  assert.equal(w.creates(), 3, 'Listing, one buyer CVR and one seller CVR CREATE');
  assert.equal(w.prompted(w.ctl.buyerAddr), 1); assert.equal(w.prompted(w.ctl.sellerAddr), 1);
  assert.deepEqual(w.h.composition.contextProvider.invocations.map((entry) => entry.evaluatedParty).sort(), [w.buyerActor.signer.claim, w.h.sellerActor.signer.claim].sort(), 'one buyer and one seller Vet');
}

test('Start refuses the DEM context without any Vet effect; approved generation time shares the ordinary plan flight', { timeout: 180000 }, async t => {
  const w = await world(t);
  assert.equal(w.creates(), 1);
  assert.equal(w.h.partyVetStore.usage().jobs, 0);
  assert.deepEqual(w.h.composition.contextProvider.invocations, []);
  assert.equal(await w.h.composition.anchor.hasIntent(w.ctl.buyerAddr), false);
  assert.equal(await w.h.composition.anchor.hasIntent(w.ctl.sellerAddr), false);
  const start = await w.api('intent/start', { address: w.buyerActor.signer.address });
  assert.equal(start.httpStatus, 409, JSON.stringify(start));
  assert.equal(start.error, 'intent_unsupported');
  assert.equal(w.h.partyVetStore.usage().jobs, 0);
  const first = w.servicePlan().catch(error => ({ error }));
  await w.waitForSellerPrompt();
  const second = w.servicePlan().catch(error => ({ error }));
  assert.equal(await within(second, 200), 'pending', 'identical intent joins the flight');
  const ordinaryRequest = w.api('agreement/plan', { signature: w.signature });
  const ordinaryBeforeRelease = await within(ordinaryRequest, 500);
  // Let every waiter and the producer finish before asserting a mutant's
  // refusal: cleanup must not close the store under an unfinished plan.
  w.release(true);
  const [a, b, ordinary] = await Promise.all([first, second, ordinaryRequest]);
  assert.notEqual(ordinaryBeforeRelease, 'pending', 'another generation time is refused before the plan finishes');
  assert.equal(ordinary.httpStatus, 409, JSON.stringify(ordinary));
  assert.equal(ordinary.error, 'plan_in_progress', 'an ordinary request cannot replace the intent generation time');
  assert.equal(a.operation.state.protocol.planned.draft.generatedAt, w.generatedAt);
  assert.deepEqual(b.operation.state.protocol.planned, a.operation.state.protocol.planned);
  oneVetEach(w);
  const saved = await w.api('agreement/plan');
  assert.equal(saved.httpStatus, 200);
  oneVetEach(w);
});

for (const commitOnSignature of [false, true]) test(`Approved-generation plan respects cancellation before the seller Vet, commit-on-signature=${commitOnSignature}`, { timeout: 180000 }, async t => {
  const w = await world(t, { gated: 'buyer', commitOnSignature });
  const plan = w.servicePlan().then(value => ({ value }), error => ({ error: error.code }));
  while (!w.prompted(w.ctl.buyerAddr)) await sleep(20);
  assert.equal((await w.h.app.services.purchases.cancel({ accountId: w.accountId, operationId: w.id })).cancelled, true);
  w.release(true);
  const result = await plan;
  assert.equal(result.error, 'invalid_state', JSON.stringify(result));
  assert.equal(w.prompted(w.ctl.sellerAddr), 0);
  assert.equal(w.creates(), 2);
  assert.deepEqual(w.h.composition.contextProvider.invocations.map(x => x.evaluatedParty), [w.buyerActor.signer.claim]);
});

async function signatureWorld(t, options = {}) {
  const h = await startDevnetLiveCompositionApp({ commitOnSignature: true, ...options }); t.after(() => h.close());
  const actor = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin)) }); t.after(() => actor.close());
  let client;
  const wallet = actor.walletFactory({ anchorJournal: { get: key => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) } });
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async message => { const r = await wallet.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  const authentication = createSellerTransportClientAuth({ buyerSigner: { claim: actor.signer.claim, sign: bytes => actor.signer.signBytes(bytes) }, seller: h.sellerActor.signer.claim, resolveJob: job => h.jobContexts.get(job) });
  h.authenticationRegistry.set(h.sellerActor.signer.claim, authentication);
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: h.composition.listing.listingId, version: 1, seller: h.sellerActor.signer.claim, idempotencyKey: `signature-native-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl), api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const r = await post(`${h.origin}${path}`, body, h.origin); if (r.httpStatus !== 200) throw Error(JSON.stringify(r)); return r; } });
  const account = h.app.services.accounts.walletOwner(address), op = () => h.app.services.ops.get(account, id);
  const identity = await api('agreement/identity', { address }), plan = await api('agreement/plan', { signature: await sign(identity.signRequest.message) });
  assert.equal(plan.httpStatus, 200, JSON.stringify(plan));
  h.jobContexts.set(op().terms.protocol.jobId, { listingPin: plan.signRequest.summary.listing, agreementHash: plan.signRequest.agreementHash });
  await client.authenticate({ address, sign });
  assert.equal((await api('agreement/sign', { agreementSignature: await sign(plan.signRequest.agreementMessage) })).httpStatus, 200);
  return { h, actor, wallet, client, buyer, op, verify: () => tool(h, buyer, 'verify_deal', { operationId: id }), peer: createSellerAgentClient({ url: h.sellerOrigin, authentication, commitOnSignature: true }) };
}

test('early commitment consumes the final stored plan and never reruns party Vet production', { timeout: 180000 }, async t => {
  const w = await signatureWorld(t);
  const provider = w.h.composition.contextProvider;
  const plan = structuredClone(w.op().state.protocol.planned);
  const rows = await w.h.partyVetStore.entries();
  assert.equal(rows.length, 1);
  assert.ok(rows[0][1].writeStarted);
  const calls = structuredClone(provider.invocations);
  assert.equal(calls.length, 2);
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  await w.h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  const result = await w.verify();
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result));
  assert.deepEqual(provider.invocations, calls, 'commitment does not rerun the plan');
  assert.deepEqual(await w.h.partyVetStore.entries(), rows, 'commitment does not change the stored Vet bytes or signatures');
  assert.deepEqual(w.op().state.protocol.planned, plan);
  const accepted = w.h.transport.chain.wire.record.accepted;
  assert.equal(accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'CompositeVerificationRecord').length, 2);
  assert.equal(accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord').length, 1);
});
