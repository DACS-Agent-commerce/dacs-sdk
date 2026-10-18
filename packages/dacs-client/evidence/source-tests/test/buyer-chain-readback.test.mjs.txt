// DACS_BUYER_CHAIN_READBACK against the live-composition chain fixture: the
// buyer verifies the seller's commitment, Deliverable and evidence on chain
// only, even with the seller's journals gone; forged, foreign, altered and
// wrongly bound records are refused; not-found stays indeterminate and the
// normal poll reads again without any write; with DACS_READBACK_CACHE=1 only an
// authenticated positive is reused. Off, the buyer still uses today's readers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { createBuyerChainReadback, PUBLIC_SIGNED_CREATES } from '../src/dacs/buyer-chain-readback.mjs';
import { readDemDeliveryReady } from '../src/dacs/dem-delivery-consumer.mjs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { deliverableAddress } from '../src/dacs/purchase-protocol.mjs';
import { NEW_FIELDS, agree, context, creates, handoff, notFound, payAndDeliver, served, start, txReads } from './helpers/buyer-chain-readback-flow.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

test('on: the commitment, Deliverable and payment evidence verify from chain with the seller journal deleted mid-purchase', { timeout: 420000 }, async (t) => {
  const h = await start(t, { buyerChainReadback: 'on' });
  assert.equal(h.config.buyerChainReadback, 'on');
  const f = await agree(t, h);
  const committed = await f.verify(); assert.equal(committed.protocol?.stage, 'seller-committed', JSON.stringify(committed));
  let c = context(h, f); const commitmentAddress = finalityCommitmentAddress(c.jobId);
  const pointed = served(h, '/dacs/v1/commitments').map((answer) => answer[PUBLIC_SIGNED_CREATES]?.[commitmentAddress]).filter(Boolean);
  assert.ok(pointed.length > 0, 'the seller\'s sent answer points at its signed commitment CREATE');
  assert.equal(c.p.chainReadback[commitmentAddress].hash, pointed.at(-1).hash, 'the buyer keeps the bytes it authenticated');
  assert.doesNotMatch(JSON.stringify(committed), NEW_FIELDS, 'tool output is unchanged');

  // The seller's journals are gone for every buyer step until the seller must deliver.
  h.sellerJournals.deleted = true;
  await h.app.services.protocol.recheckCommitment(f.operation());
  await h.app.services.protocol.recheckCommitment(f.operation(), { reuseVerified: true });
  const payment = await handoff(f);
  assert.equal(h.sellerJournals.touched, 0, 'no buyer read consulted the seller journal');
  h.sellerJournals.deleted = false;

  const { txHash, completed } = await payAndDeliver(h, f, payment);
  assert.equal(completed.protocol.nativeEvidence?.deliveryReadback?.disposition, 'present');
  assert.doesNotMatch(JSON.stringify(completed), NEW_FIELDS);
  c = context(h, f);
  assert.ok(c.p.chainReadback[deliverableAddress(c.jobId)], 'the authenticated Deliverable bytes are kept');
  // Then the seller journals are closed and their files removed.
  // One more seller answer, with the pointers its HTTP handler would send.
  const answer = await h.composition.publicSignedCreates(c.jobId, await h.composition.sellerAgent.submitPayment({ jobId: c.jobId, txHash, payerPayingKey: f.buyerActor.signer.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }));
  assert.ok(answer[PUBLIC_SIGNED_CREATES]?.[deliverableAddress(c.jobId)], JSON.stringify(answer).slice(0, 400));
  assert.ok(served(h, '/dacs/v1/payments').some((sent) => sent[PUBLIC_SIGNED_CREATES]?.[deliverableAddress(c.jobId)]), 'the buyer was sent the Deliverable pointer');
  // The seller offers only its own verified write of the asked kind at the asked address.
  assert.equal(await h.composition.anchor.retainedSignedCreate({ logicalAddress: deliverableAddress(c.jobId), artifactKind: 'FinalityCommitmentRecord' }), null);
  assert.equal(await h.composition.anchor.retainedSignedCreate({ logicalAddress: deliverableAddress(c.jobId), artifactKind: 'Agreement' }), null);
  assert.equal(await h.composition.anchor.retainedSignedCreate({ logicalAddress: `dacs4:deliverable:${c.jobId.replace(/.$/, (x) => (x === '0' ? '1' : '0'))}`, artifactKind: 'Deliverable' }), null);
  const createsBefore = creates(h);
  h.deleteSellerJournals();
  const chainReadback = createBuyerChainReadback({ sourceCapability: h.transport.capability });
  const base = { anchors: null, nativeDemDelivery: h.composition.nativeDemDelivery, agreement: c.agreement, listing: c.listing, seller: c.seller };
  const fromAnswer = await readDemDeliveryReady({ ...base, answer, chainReadback });
  assert.equal(fromAnswer.disposition, 'present', JSON.stringify(fromAnswer));
  assert.deepEqual(fromAnswer.delivery.report, c.p.delivery.report);
  const { [PUBLIC_SIGNED_CREATES]: _pointer, ...bare } = answer;
  const fromRetained = await readDemDeliveryReady({ ...base, answer: bare, chainReadback, retainedSignedCreates: c.p.chainReadback });
  assert.equal(fromRetained.disposition, 'present', 'the bytes the buyer retained suffice without the seller');
  const evidence = await h.composition.dacsProtocol.nativePaymentEvidence.readEvidence({ agreement: c.agreement, writer: c.seller, txHash, blockNumber: c.p.paymentEvidence.blockNumber,
    committedAt: c.p.commitment.committedAt, signedProjection: answer.signedProjection, answerProjectionOnly: true });
  assert.equal(evidence.disposition, 'present', JSON.stringify(evidence));
  const unsigned = await h.composition.dacsProtocol.nativePaymentEvidence.readEvidence({ agreement: c.agreement, writer: c.seller, txHash, blockNumber: c.p.paymentEvidence.blockNumber,
    committedAt: c.p.commitment.committedAt, answerProjectionOnly: true });
  assert.equal(unsigned.disposition, 'indeterminate', 'without the signed bytes the payment evidence is unknown, not refused');
  h.testHooks.rpcOverride = notFound(logicalToStorageProgramName(answer.evidenceAddress));
  try {
    const unseen = await h.composition.dacsProtocol.nativePaymentEvidence.readEvidence({ agreement: c.agreement, writer: c.seller, txHash, blockNumber: c.p.paymentEvidence.blockNumber,
      committedAt: c.p.commitment.committedAt, signedProjection: answer.signedProjection, answerProjectionOnly: true });
    assert.equal(unseen.disposition, 'indeterminate', 'payment evidence not found is not absence');
  } finally { h.testHooks.rpcOverride = null; }
  const commitment = await chainReadback.readCommitment({ agreement: c.agreement, listing: c.listing, seller: c.seller, signedProjection: c.p.chainReadback[commitmentAddress], fresh: true });
  assert.equal(commitment.status, 'verified', JSON.stringify(commitment));
  assert.equal(commitment.contentHash, c.p.commitment.contentHash);
  assert.equal(h.sellerJournals.touched, 0, 'chain readback never touched the deleted journals');
  // Today's readers need the seller journal: with it gone they cannot verify.
  const journalPath = await readDemDeliveryReady({ ...base, answer });
  assert.equal(journalPath.disposition, 'indeterminate', JSON.stringify(journalPath));
  assert.ok(h.sellerJournals.touched > 0);
  assert.equal(creates(h), createsBefore, 'readback wrote nothing');
});

test('on: a wrong writer, kind or Agreement binding is refused; forged or altered bytes that do not authenticate, and not-found, are indeterminate', { timeout: 420000 }, async (t) => {
  const h = await start(t, { buyerChainReadback: 'on' });
  const f = await agree(t, h);
  assert.equal((await f.verify()).protocol?.stage, 'seller-committed');
  let c = context(h, f);
  const chain = createBuyerChainReadback({ sourceCapability: h.transport.capability }), commitmentAddress = finalityCommitmentAddress(c.jobId);
  const real = c.p.chainReadback[commitmentAddress], read = (over = {}) => chain.readCommitment({ agreement: c.agreement, listing: c.listing, seller: c.seller, signedProjection: real, fresh: true, ...over });
  assert.equal((await read()).status, 'verified');
  const before = creates(h);
  const refused = async (name, over) => { const result = await read(over); assert.equal(result.status, 'rejected', `${name}: ${JSON.stringify(result)}`); };
  // an earlier review (code P2-1 / a review P2-1): bytes that do not authenticate,
  // offered or read back, are the SR-2 adapter's unmarked `invalid` (the source change): not
  // a contradiction, so indeterminate with the code kept.
  const unauthenticated = async (name, over) => { const result = await read(over); assert.deepEqual([result.status, result.code], ['indeterminate', 'invalid'], `${name}: ${JSON.stringify(result)}`); };
  await refused('another expected writer', { seller: f.buyerActor.signer.claim });
  await refused('bytes signed by another writer (the buyer\'s own Agreement CREATE)', { signedProjection: c.p.agreement.signedProjection });
  await unauthenticated('forged native address', { signedProjection: { ...real, content: { ...real.content, to: `stor-${'0'.repeat(40)}` } } });
  const altered = structuredClone(real); altered.content.data[1].data = { ...altered.content.data[1].data, createdAt: 1 };
  await unauthenticated('altered signed bytes', { signedProjection: altered });
  const otherAgreement = structuredClone(c.agreement); otherAgreement.terms.deadline += 1000;
  await refused('another Agreement', { agreement: otherAgreement });
  h.transport.chain.faults.native = (object) => ({ ...object, data: { ...object.data, createdAt: 1 } });
  try { await unauthenticated('altered bytes on chain', {}); } finally { h.transport.chain.faults.native = null; }
  for (const signedProjection of [undefined, null]) {
    const missing = await read({ signedProjection });
    assert.equal(missing.status, 'indeterminate', 'no pointer is not absence');
  }
  h.testHooks.rpcOverride = notFound(logicalToStorageProgramName(commitmentAddress));
  try {
    const absent = await read();
    assert.equal(absent.status, 'indeterminate', JSON.stringify(absent)); assert.match(absent.reason, /not proof of absence/);
    await assert.rejects(h.app.services.protocol.recheckCommitment(f.operation()), (error) => error.code === 'commitment_unverified' && /indeterminate/.test(error.message));
  } finally { h.testHooks.rpcOverride = null; }
  assert.equal((await read()).status, 'verified');
  assert.equal(creates(h), before, 'refusals wrote nothing');

  const { txHash } = await payAndDeliver(h, f, await handoff(f));
  c = context(h, f);
  const answer = await h.composition.publicSignedCreates(c.jobId, await h.composition.sellerAgent.submitPayment({ jobId: c.jobId, txHash, payerPayingKey: f.buyerActor.signer.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }));
  const base = { anchors: null, nativeDemDelivery: h.composition.nativeDemDelivery, agreement: c.agreement, listing: c.listing, seller: c.seller, answer, chainReadback: chain };
  assert.equal((await readDemDeliveryReady(base)).disposition, 'present');
  const deliveryRefused = async (name, over) => { const result = await readDemDeliveryReady({ ...base, ...over }); assert.equal(result.disposition, 'rejected', `${name}: ${JSON.stringify(result)}`); };
  const forged = structuredClone(answer); forged.delivery.anchorReceipt.nativeAddress = `stor-${'0'.repeat(40)}`;
  await deliveryRefused('a seller pointer with a forged native address', { answer: forged });
  await deliveryRefused('another expected writer', { seller: f.buyerActor.signer.claim });
  await deliveryRefused('another Agreement binding', { agreement: { ...c.agreement, terms: { ...c.agreement.terms, deadline: c.agreement.terms.deadline + 1000 } } });
  const offered = structuredClone(answer); offered[PUBLIC_SIGNED_CREATES][deliverableAddress(c.jobId)] = real;
  await deliveryRefused('the commitment bytes offered as the Deliverable', { answer: offered });
  h.transport.chain.faults.native = (object) => ({ ...object, data: { ...object.data, title: 'altered on chain' } });
  try {
    const result = await readDemDeliveryReady(base);
    assert.deepEqual([result.disposition, result.code], ['indeterminate', 'invalid'], `altered bytes on chain: ${JSON.stringify(result)}`);
  } finally { h.transport.chain.faults.native = null; }
  const { [PUBLIC_SIGNED_CREATES]: _pointer, ...bare } = answer;
  assert.equal((await readDemDeliveryReady({ ...base, answer: bare })).disposition, 'indeterminate', 'no pointer and nothing retained: indeterminate');
  assert.equal(creates(h), before + 2, 'only the purchase\'s own payment-evidence and Deliverable CREATEs were written');
});

test('on, with DACS_READBACK_CACHE=1: not-found stays indeterminate and the normal poll verifies it with no write; only an authenticated positive is reused', { timeout: 420000 }, async (t) => {
  const h = await start(t, { buyerChainReadback: 'on', env: { DACS_READBACK_CACHE: '1' } });
  assert.equal(h.config.readbackCache, true);
  let programName = null;
  // Not found for the buyer's first read only: armed after the seller's commit returns.
  h.testHooks.afterSellerCommit = (answer) => { if (answer?.address) { programName = logicalToStorageProgramName(answer.address); h.testHooks.rpcOverride = notFound(programName); h.testHooks.afterSellerCommit = null; } };
  const f = await agree(t, h);
  const first = await f.verify();
  assert.equal(first.protocol?.stage, 'agreement-anchored', JSON.stringify(first));
  const attempt = f.operation().state.protocol.attempts.at(-1);
  assert.equal(attempt.step, 'commitment', JSON.stringify(attempt)); assert.equal(attempt.outcome, 'indeterminate');
  assert.match(attempt.reason, /not proof of absence/);
  assert.equal(f.operation().state.protocol.chainReadback, undefined, 'a seller pointer that did not verify is not kept');
  assert.ok(programName);
  const written = creates(h);
  h.testHooks.rpcOverride = null;
  const polled = await f.verify();
  assert.equal(polled.protocol?.stage, 'seller-committed', JSON.stringify(polled));
  assert.equal(creates(h), written, 'the poll read again and wrote nothing');

  // Pre-approval reuse of an authenticated commitment (and the cached Agreement,
  // whose own reusable proof the first call establishes).
  await h.app.services.protocol.recheckCommitment(f.operation(), { reuseVerified: true });
  const reads = txReads(h);
  for (let i = 0; i < 2; i++) await h.app.services.protocol.recheckCommitment(f.operation(), { reuseVerified: true });
  assert.equal(txReads(h), reads, 'a verified commitment is reused before payment');
  // A fresh negative is never masked by the cached positive, and evicts it.
  h.testHooks.rpcOverride = notFound(programName);
  try {
    await assert.rejects(h.app.services.protocol.recheckCommitment(f.operation()), { code: 'commitment_unverified' });
    await assert.rejects(h.app.services.protocol.recheckCommitment(f.operation(), { reuseVerified: true }), { code: 'commitment_unverified' }, 'the evicted positive is not served');
  } finally { h.testHooks.rpcOverride = null; }
  // The negative was not kept: the next reuse call reads the chain and verifies.
  const again = txReads(h);
  await h.app.services.protocol.recheckCommitment(f.operation(), { reuseVerified: true });
  assert.ok(txReads(h) > again, 'read fresh after the negative');
  // Unauthenticated bytes never reach or come from the cache.
  const c = context(h, f), chain = createBuyerChainReadback({ sourceCapability: h.transport.capability }), real = c.p.chainReadback[finalityCommitmentAddress(c.jobId)];
  const forged = structuredClone(real); forged.content.data[1].data = { ...forged.content.data[1].data, createdAt: 1 };
  assert.equal((await chain.readCommitment({ agreement: c.agreement, listing: c.listing, seller: c.seller, signedProjection: real })).status, 'verified');
  for (let i = 0; i < 2; i++) assert.equal((await chain.readCommitment({ agreement: c.agreement, listing: c.listing, seller: c.seller, signedProjection: forged })).status, 'indeterminate');
  assert.equal(creates(h), written);
});

test('on, operator with delivery evidence: the buyer driver and the app verify the Deliverable and its evidence from chain; the seller journal is not needed', { timeout: 600000 }, async (t) => {
  const previous = process.env.DACS_BUYER_CHAIN_READBACK; process.env.DACS_BUYER_CHAIN_READBACK = 'on';
  t.after(() => { if (previous === undefined) delete process.env.DACS_BUYER_CHAIN_READBACK; else process.env.DACS_BUYER_CHAIN_READBACK = previous; });
  const gate = { deleted: false, touched: 0 };
  const wrapPublicJournal = (journal) => new Proxy(journal, { get(target, key) { const value = target[key]; if (typeof value !== 'function' || key === 'close') return value;
    return (...args) => { if (gate.deleted) { gate.touched += 1; throw Object.assign(new Error('TEST seller journal deleted'), { code: 'ENOENT' }); } return value.apply(target, args); }; } });
  const h = await startOperatorPurchaseNode2({ tlsFixture: createLoopbackTestTlsMaterial(), sellerApproval: { mode: 'policy' }, sellerDeliveryEvidence: { enabled: true }, wrapPublicJournal,
    authorizeSellerApproval: ({ request }) => request.content.artifactKind === 'Listing', authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  assert.equal(h.prepared.config.buyerChainReadback, 'on');
  // The driver's own independent re-read goes through the app's chain reader.
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'chain-readback-operator' });
  assert.equal(result.status, 'delivered', JSON.stringify(result).slice(0, 600));
  const row = h.application.db.prepare('SELECT terms, state FROM operations WHERE id = ?').get(result.operationId), p = JSON.parse(row.state).protocol, terms = JSON.parse(row.terms);
  assert.equal(p.stage, 'delivered'); assert.equal(p.delivery.evidencePublication, 'native-read-back');
  assert.ok(p.chainReadback[deliverableAddress(result.jobId)] && p.chainReadback[`dacs4:evidence:${result.jobId}`], 'the buyer keeps the authenticated Deliverable and evidence bytes');
  // The seller journal goes away; the buyer's own retained bytes still verify both records on chain.
  gate.deleted = true;
  const d = p.delivery, answer = { settlementId: d.report.settlementId, delivery: { status: d.status, fulfilmentId: d.fulfilmentId, logicalAddress: d.deliverableRef.anchor.locator,
    contentHash: d.payloadHash, evidenceHash: d.evidenceHash, anchorReceipt: d.anchorReceipt } };
  const base = { anchors: null, nativeDemDelivery: h.composition.nativeDemDelivery, agreement: p.agreement.artifact, listing: p.listing, seller: terms.seller.claim, answer };
  const chained = await readDemDeliveryReady({ ...base, chainReadback: h.application.services.protocol.chainReadback, retainedSignedCreates: p.chainReadback });
  assert.equal(chained.disposition, 'present', JSON.stringify(chained).slice(0, 600));
  assert.equal(chained.delivery.status, 'delivered', 'the delivery evidence verified from chain');
  assert.equal(gate.touched, 0);
  const journal = await readDemDeliveryReady(base);
  assert.notEqual(journal.disposition === 'present' && journal.delivery.status, 'delivered', 'today\'s readers cannot verify without the seller journal');
  assert.ok(gate.touched > 0);
  gate.deleted = false;
  // Journal back, but no signed evidence bytes: the evidence stays pending, it is not read from the journal.
  const { [`dacs4:evidence:${result.jobId}`]: _evidence, ...deliverableOnly } = p.chainReadback;
  const pending = await readDemDeliveryReady({ ...base, chainReadback: h.application.services.protocol.chainReadback, retainedSignedCreates: deliverableOnly });
  assert.equal(pending.disposition, 'present'); assert.equal(pending.delivery.status, 'delivery-ready');
  assert.equal(pending.delivery.evidenceHold?.status, 'pending', JSON.stringify(pending.delivery.evidenceHold));
});

test('on, operator: a driver re-read that does not authenticate on chain fails the run; it never falls back to the seller journal', { timeout: 600000 }, async (t) => {
  const previous = process.env.DACS_BUYER_CHAIN_READBACK; process.env.DACS_BUYER_CHAIN_READBACK = 'on';
  t.after(() => { if (previous === undefined) delete process.env.DACS_BUYER_CHAIN_READBACK; else process.env.DACS_BUYER_CHAIN_READBACK = previous; });
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  // TEST: whenever the app has kept the authenticated Deliverable bytes, they are
  // swapped for the commitment's, which never authenticate as the Deliverable.
  // The app has already verified; only the driver's own re-read sees the swap.
  const pointer = (kind, row) => `'$.protocol.chainReadback."${kind}:' || json_extract(${row}.terms, '$.protocol.jobId') || '"'`;
  h.application.db.exec(`CREATE TEMP TRIGGER test_swap_deliverable_pointer AFTER UPDATE OF state ON operations
    WHEN json_extract(NEW.state, ${pointer('dacs4:deliverable', 'NEW')} || '.hash') IS NOT json_extract(NEW.state, ${pointer('dacs3:commit', 'NEW')} || '.hash')
      AND json_extract(NEW.state, ${pointer('dacs4:deliverable', 'NEW')} || '.hash') IS NOT NULL
    BEGIN UPDATE operations SET state = json_set(state, ${pointer('dacs4:deliverable', 'operations')}, json(json_extract(state, ${pointer('dacs3:commit', 'operations')}))) WHERE id = NEW.id; END`);
  await assert.rejects(h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'chain-readback-driver-no-fallback' }),
    (error) => { assert.match(error.message, /independent buyer native readback differs from the app delivery/); return true; });
  const row = h.application.db.prepare("SELECT terms, state FROM operations WHERE kind = 'purchase'").get(), p = JSON.parse(row.state).protocol, jobId = JSON.parse(row.terms).protocol.jobId;
  assert.equal(p.chainReadback[deliverableAddress(jobId)].hash, p.chainReadback[finalityCommitmentAddress(jobId)].hash, 'the swap happened');
  assert.equal(h.node2.chain.record.accepted.length, 1, 'one payment, never resent');
});

test('off (default): the buyer still uses the seller-journal readers and nothing new is written, sent or shown', { timeout: 420000 }, async (t) => {
  const h = await start(t, { buyerChainReadback: 'off' });
  assert.equal(h.config.buyerChainReadback, 'off');
  assert.equal(h.composition.publicSignedCreates, undefined, 'no pointer function exists');
  const f = await agree(t, h);
  const committed = await f.verify(); assert.equal(committed.protocol?.stage, 'seller-committed', JSON.stringify(committed));
  assert.ok(served(h, '/dacs/v1/commitments').length > 0);
  assert.equal(f.operation().state.protocol.chainReadback, undefined);
  // Today's path reads the in-process seller journal: without it the commitment cannot verify.
  h.sellerJournals.deleted = true;
  try { await assert.rejects(h.app.services.protocol.recheckCommitment(f.operation())); }
  finally { h.sellerJournals.deleted = false; }
  assert.ok(h.sellerJournals.touched > 0);
  const { completed } = await payAndDeliver(h, f, await handoff(f));
  assert.equal(completed.protocol.nativeEvidence?.deliveryReadback?.disposition, 'present');
  assert.doesNotMatch(JSON.stringify(completed), NEW_FIELDS);
  const db = h.app.db, rows = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) rows.push(...db.prepare(`SELECT * FROM "${name}"`).all());
  assert.doesNotMatch(JSON.stringify(rows), NEW_FIELDS, 'no application row carries a new field');
  assert.doesNotMatch(JSON.stringify(await h.transport.capability.journal.entries()), NEW_FIELDS, 'no source journal row carries a new field');
  assert.doesNotMatch(JSON.stringify(h.sellerResponses), NEW_FIELDS, 'no seller response carries a new field');
});
