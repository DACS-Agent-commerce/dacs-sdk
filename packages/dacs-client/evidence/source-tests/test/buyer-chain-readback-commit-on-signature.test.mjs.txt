// DACS_BUYER_CHAIN_READBACK=on together with DACS_COMMIT_ON_SIGNATURE=on (the source change).
// The seller's commitment CREATE may now land before the buyer's Agreement. The
// buyer still reads the commitment only after its own Agreement readback, binds
// it to that exact Agreement and Listing, and takes its pointer only from the
// ordinary commit answer (fresh, reconciled or replayed from the effect cache),
// never from the early route's answer. Its reads take address-free read fences
// one at a time, so a seller connection request is never held behind it. An
// early commitment proves nothing about the Agreement: the payment gates still
// re-read the Agreement fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { finalityCommitmentAddress, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { POINTER_MISSING, PUBLIC_SIGNED_CREATES } from '../src/dacs/buyer-chain-readback.mjs';
import { deliverableAddress, fixedPriceAgreementLogicalAddress } from '../src/dacs/purchase-protocol.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createSellerAgentClient, createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { createSellerTransportClientAuth } from '../src/dacs/seller-transport-auth.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { post } from './helpers/public-sr2-projection-flow.mjs';
import { authorizedCreate } from './helpers/review-commit-retry-coverage-world.mjs';
import { agree, context, handoff, notFound, payAndDeliver, served, start } from './helpers/buyer-chain-readback-flow.mjs';

const BOTH = { commitOnSignature: true, buyerChainReadback: 'on' };
const kind = (h, artifactKind) => h.transport.chain.wire.record.accepted.filter((tx) => tx.content.data[1].metadata.artifactKind === artifactKind);
const noResend = (h) => assert.equal(h.transport.chain.wire.record.broadcastAttempts.length, h.transport.chain.wire.record.accepted.length, 'no broadcast retry');

// The live-composition purchase up to the Agreement signature, before the
// buyer's wallet approves (and broadcasts) the Agreement CREATE.
async function signedAgreement(t, h) {
  let client;
  const buyerActor = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin)) }); t.after(() => buyerActor.close());
  const wallet = buyerActor.walletFactory({ anchorJournal: { get: (key) => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) } });
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  const authentication = createSellerTransportClientAuth({ buyerSigner: { claim: buyerActor.signer.claim, sign: (bytes) => buyerActor.signer.signBytes(bytes) }, seller: h.sellerActor.signer.claim, resolveJob: (jobId) => h.jobContexts.get(jobId) });
  h.authenticationRegistry.set(h.sellerActor.signer.claim, authentication);
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: h.composition.listing.listingId, version: 1, seller: h.sellerActor.signer.claim, idempotencyKey: `chain-readback-signature-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl), api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const answer = await post(`${h.origin}${path}`, body, h.origin); if (answer.httpStatus !== 200) throw Object.assign(new Error(answer.message), { code: answer.error }); return answer; } });
  const account = h.app.services.accounts.walletOwner(address), operation = () => h.app.services.ops.get(account, id);
  const identity = await api('agreement/identity', { address }), planned = await api('agreement/plan', { signature: await sign(identity.signRequest.message) }); assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  h.jobContexts.set(operation().terms.protocol.jobId, { listingPin: planned.signRequest.summary.listing, agreementHash: planned.signRequest.agreementHash });
  await client.authenticate({ address, sign });
  const signed = await api('agreement/sign', { agreementSignature: await sign(planned.signRequest.agreementMessage) }); assert.equal(signed.httpStatus, 200, JSON.stringify(signed));
  return { buyer, buyerActor, wallet, client, api, sign, id, address, operation, verify: () => tool(h, buyer, 'verify_deal', { operationId: id }),
    peer: createSellerAgentClient({ url: h.sellerOrigin, authentication, commitOnSignature: true }) };
}

test('both on: an early commitment on chain before the Agreement verifies only after the buyer\'s own Agreement readback, from the ordinary commit answer\'s pointer', { timeout: 600000 }, async (t) => {
  const h = await start(t, BOTH);
  assert.equal(h.config.commitOnSignature, true); assert.equal(h.config.buyerChainReadback, 'on');
  const f = await signedAgreement(t, h);
  const agreement = f.operation().state.protocol.walletAnchor.artifact, jobId = agreement.jobId, commitmentAddress = finalityCommitmentAddress(jobId);
  // The buyer's signed Agreement CREATE reaches the seller before the wallet broadcasts it.
  const signedCreate = authorizedCreate({ buyer: { address: f.address, signHex: (message) => `0x${f.buyerActor.signer.signBytes(Buffer.from(message)).toString('hex')}` }, agreement, clock: Date.now() });
  const early = await f.peer.commitOnSignature(jobId, agreement, signedCreate);
  assert.equal(early.status, 'commitment-held', JSON.stringify(early));
  assert.equal(early[PUBLIC_SIGNED_CREATES], undefined, 'the early answer names no pointer');
  assert.equal(kind(h, 'FinalityCommitmentRecord').length, 1);
  assert.equal(kind(h, 'Agreement').length, 0, 'the commitment is on chain before the Agreement CREATE was broadcast');

  // No Agreement readback yet: the commitment is not read, kept or verified.
  const pending = await f.verify();
  assert.equal(pending.status, 'agreement_pending', JSON.stringify(pending));
  let p = f.operation().state.protocol;
  assert.equal(p.agreement, undefined); assert.equal(p.commitment, undefined); assert.equal(p.chainReadback, undefined);
  assert.ok(!p.attempts.some((attempt) => attempt.step === 'commitment'), JSON.stringify(p.attempts));
  await assert.rejects(h.app.services.protocol.recheckCommitment(f.operation()), (error) => error.code === 'commitment_required');

  // The reader binds the early commitment to the exact Agreement and Listing
  // seller; with no pointer it is indeterminate, never absent.
  const pointer = (await h.composition.publicSignedCreates(jobId, {}))[PUBLIC_SIGNED_CREATES]?.[commitmentAddress];
  assert.ok(pointer, 'the seller has verified its own early commitment');
  const read = (over) => h.app.services.protocol.chainReadback.readCommitment({ agreement, listing: p.listing, seller: h.sellerActor.signer.claim, signedProjection: pointer, fresh: true, ...over });
  const missing = await read({ signedProjection: undefined });
  assert.equal(missing.status, 'indeterminate', JSON.stringify(missing)); assert.equal(missing.pointer, POINTER_MISSING);
  const otherAgreement = structuredClone(agreement); otherAgreement.terms.deadline += 1000;
  assert.equal((await read({ agreement: otherAgreement })).status, 'rejected', 'another Agreement');
  assert.equal((await read({ seller: f.buyerActor.signer.claim })).status, 'rejected', 'another Listing seller');

  // The wallet approves and broadcasts the Agreement; the broker's own early
  // request finds the attempt and only reads back.
  assert.equal((await f.client.approveOne(f.wallet)).state, 'completed');
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  const committed = await f.verify();
  assert.equal(committed.status, 'awaiting_approval', JSON.stringify(committed));
  p = f.operation().state.protocol;
  const [commitmentTx] = kind(h, 'FinalityCommitmentRecord'), [agreementTx] = kind(h, 'Agreement');
  assert.equal(kind(h, 'FinalityCommitmentRecord').length, 1, 'one commitment CREATE: the early one');
  assert.ok(h.transport.chain.inclusion.numberFor(commitmentTx.hash) < h.transport.chain.inclusion.numberFor(agreementTx.hash), 'the commitment is in an earlier block than the Agreement');
  noResend(h);
  const steps = p.attempts.map((attempt) => `${attempt.step}/${attempt.outcome}`);
  assert.ok(steps.indexOf('agreement/anchored') >= 0 && steps.indexOf('agreement/anchored') < steps.indexOf('commitment/verified'), steps.join(', '));
  assert.ok(!steps.some((step) => step.endsWith('/absent')), steps.join(', '));
  assert.equal(p.chainReadback[commitmentAddress].hash, commitmentTx.hash, 'the kept pointer is the early commitment CREATE');

  // Pointers: the ordinary commit answer and its effect-cache replay carry it;
  // the early route's answers (fresh and replayed) never do.
  const earlyServed = served(h, '/dacs/v1/commitments/signature');
  assert.ok(earlyServed.length >= 1);
  for (const answer of earlyServed) assert.equal(answer[PUBLIC_SIGNED_CREATES], undefined, JSON.stringify(answer));
  assert.equal(served(h, '/dacs/v1/commitments').at(-1)?.[PUBLIC_SIGNED_CREATES]?.[commitmentAddress]?.hash, commitmentTx.hash);
  const replayed = await f.peer.commit(jobId, { signedProjection: p.agreement.signedProjection });
  assert.equal(replayed[PUBLIC_SIGNED_CREATES]?.[commitmentAddress]?.hash, commitmentTx.hash, 'the replayed commit answer carries the pointer');
  const earlyReplayed = await f.peer.commitOnSignature(jobId, agreement, signedCreate);
  assert.equal(earlyReplayed.status, 'commitment-held'); assert.equal(earlyReplayed[PUBLIC_SIGNED_CREATES], undefined, 'the replayed early answer is not pointed');

  const { completed } = await payAndDeliver(h, f, await handoff(f));
  assert.equal(completed.protocol.stage, 'delivery-ready');
  p = f.operation().state.protocol;
  assert.ok(p.chainReadback[deliverableAddress(jobId)], 'the Deliverable verified from chain');
  assert.equal(kind(h, 'FinalityCommitmentRecord').length, 1);
  noResend(h);
});

test('both on: an early commitment whose commit answer is lost stays indeterminate; the reconciled answer carries the pointer and nothing is written again', { timeout: 600000 }, async (t) => {
  const h = await start(t, BOTH);
  let lost = 0;
  h.testHooks.afterSellerCommit = () => { lost += 1; h.testHooks.afterSellerCommit = null; throw new Error('TEST commit answer lost'); };
  const f = await agree(t, h);
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  const commitmentAddress = finalityCommitmentAddress(f.operation().terms.protocol.jobId);
  const held = await f.verify();
  assert.equal(lost, 1, 'the seller committed (read back its early commitment) and its answer was lost');
  assert.equal(held.status, 'agreement_pending', JSON.stringify(held));
  let p = f.operation().state.protocol;
  assert.equal(p.stage, 'agreement-anchored'); assert.equal(p.commitment, undefined); assert.equal(p.chainReadback, undefined);
  const last = p.attempts.at(-1);
  assert.equal(`${last.step}/${last.outcome}`, 'commitment/indeterminate', JSON.stringify(p.attempts));
  assert.match(last.reason, /not available yet/);
  assert.equal(kind(h, 'FinalityCommitmentRecord').length, 1, 'the early commitment is on chain; the buyer still has no pointer to authenticate');
  assert.equal(served(h, '/dacs/v1/commitments').length, 0, 'no successful commit answer was sent');

  const again = await f.verify();
  assert.equal(again.status, 'awaiting_approval', JSON.stringify(again));
  p = f.operation().state.protocol;
  const [commitmentTx] = kind(h, 'FinalityCommitmentRecord');
  assert.equal(p.chainReadback[commitmentAddress].hash, commitmentTx.hash);
  assert.equal(served(h, '/dacs/v1/commitments').at(-1)?.[PUBLIC_SIGNED_CREATES]?.[commitmentAddress]?.hash, commitmentTx.hash, 'the reconciled answer carries the pointer');
  assert.equal(kind(h, 'FinalityCommitmentRecord').length, 1);
  noResend(h);
});

test('both on: the buyer\'s chain readback takes only address-free read fences, one read at a time, so a seller connection request is granted while it is still reading', { timeout: 600000 }, async (t) => {
  const h = await start(t, BOTH);
  const f = await agree(t, h);
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  assert.equal((await f.verify()).status, 'awaiting_approval');
  const c = context(h, f), pointer = c.p.chainReadback[finalityCommitmentAddress(c.jobId)], seller = h.sellerActor.signer.address;
  assert.equal(typeof seller, 'string');
  const fences = h.transport.fences;
  fences.length = 0;
  let readDone = null, sellerDone = null;
  const reading = h.app.services.protocol.chainReadback.readCommitment({ agreement: c.agreement, listing: c.listing, seller: c.seller, signedProjection: pointer, fresh: true })
    .then((result) => { readDone = performance.now(); return result; });
  const deadline = Date.now() + 30000;
  while (!fences.some((entry) => entry.granted !== null) && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  const sellerBind = h.transport.capability.binding({ phase: 'bind', address: seller }).then((result) => { sellerDone = performance.now(); return result; });
  const [result] = await Promise.all([reading, sellerBind]);
  assert.equal(result.status, 'verified', JSON.stringify(result));
  assert.ok(sellerDone !== null && sellerDone < readDone, 'the seller\'s connection request completed while the readback was still reading');
  const sellerFences = fences.filter((entry) => entry.claim?.address === seller), readFences = fences.filter((entry) => entry.claim?.address !== seller);
  assert.equal(sellerFences.length, 1, JSON.stringify(fences.map((entry) => entry.claim)));
  assert.ok(readFences.length >= 2, 'the readback made separately fenced reads');
  assert.ok(readFences.every((entry) => entry.claim !== null && entry.claim.address === undefined), JSON.stringify(readFences.map((entry) => entry.claim)));
  assert.ok(fences.every((entry) => entry.released !== null), 'every fence was released');
});

test('both on: an early commitment proves nothing about the Agreement: with the Agreement not visible on the fresh re-read the payment gates refuse and nothing is paid', { timeout: 600000 }, async (t) => {
  const h = await start(t, BOTH);
  const f = await agree(t, h);
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  assert.equal((await f.verify()).status, 'awaiting_approval');
  const c = context(h, f), before = h.transport.chain.wire.record.accepted.length;
  h.testHooks.rpcOverride = notFound(logicalToStorageProgramName(fixedPriceAgreementLogicalAddress(c.jobId)));
  try {
    await assert.rejects(h.app.services.protocol.recheckCommitment(f.operation()), (error) => error.code === 'agreement_unverified', 'the commitment alone does not pass the gate');
    const challenge = await f.api('challenge', { address: f.address });
    const refused = await f.api('approve', { challengeId: challenge.challengeId, signature: await f.sign(challenge.message) });
    assert.notEqual(refused.status, 'payment_handoff', JSON.stringify(refused));
  } finally { h.testHooks.rpcOverride = null; }
  assert.equal(f.operation().status, 'awaiting_approval');
  assert.equal(h.transport.chain.wire.record.accepted.length, before, 'nothing was written or paid');
  await handoff(f);
});

test('both on, seller HTTP: only the ordinary commit and payment answers are pointed; the early route and its refusals never are', async (t) => {
  const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, '127.0.0.1', () => resolve(server)); });
  const agent = { claim: 'did:demos:agent:' + 'a'.repeat(64), listingPin: { listingId: 'unit' },
    commit: async ({ jobId }) => ({ status: 'committed', address: `dacs3:commit:${jobId}` }),
    commitOnSignature: async ({ jobId }) => {
      if (jobId === 'unresolved') throw new SellerAgentError('seller_signature_buyer_unresolved', 'TEST held buyer slot', 409);
      if (jobId === 'connection') throw new SellerAgentError('signature_connection_unavailable', 'TEST connection reservation', 503);
      return { status: 'commitment-held', address: `dacs3:commit:${jobId}`, resumed: false };
    },
    submitPayment: async ({ jobId }) => ({ status: 'accepted', settlementId: `demos:${jobId}` }) };
  const calls = [], pointers = async (jobId, answer) => { calls.push(jobId); return { ...answer, [PUBLIC_SIGNED_CREATES]: { [jobId]: { hash: jobId } } }; };
  const send = async (server, path, body) => { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const both = await listen(createSellerHttpHandler(agent, { commitOnSignature: true, publicSignedCreates: pointers })), readbackOnly = await listen(createSellerHttpHandler(agent, { publicSignedCreates: pointers }));
  t.after(() => { both.close(); readbackOnly.close(); });
  const early = { agreement: {}, signedProjection: {} };
  assert.deepEqual(await send(both, '/dacs/v1/commitments/signature', { jobId: 'held', ...early }), { status: 200, body: { status: 'commitment-held', address: 'dacs3:commit:held', resumed: false } });
  assert.deepEqual(await send(both, '/dacs/v1/commitments/signature', { jobId: 'unresolved', ...early }), { status: 409, body: { error: 'seller_signature_buyer_unresolved', message: 'TEST held buyer slot' } });
  assert.deepEqual(await send(both, '/dacs/v1/commitments/signature', { jobId: 'connection', ...early }), { status: 503, body: { error: 'signature_connection_unavailable', message: 'TEST connection reservation' } });
  assert.deepEqual(calls, [], 'the early route never ran the pointer lookup');
  assert.deepEqual((await send(both, '/dacs/v1/commitments', { jobId: 'ordinary' })).body[PUBLIC_SIGNED_CREATES], { ordinary: { hash: 'ordinary' } });
  assert.deepEqual((await send(both, '/dacs/v1/payments', { jobId: 'paid' })).body[PUBLIC_SIGNED_CREATES], { paid: { hash: 'paid' } });
  assert.deepEqual(await send(readbackOnly, '/dacs/v1/commitments/signature', { jobId: 'held', ...early }), { status: 404, body: { error: 'not_found' } }, 'commit on signature off: main\'s route table');
  assert.deepEqual(calls, ['ordinary', 'paid']);
});
