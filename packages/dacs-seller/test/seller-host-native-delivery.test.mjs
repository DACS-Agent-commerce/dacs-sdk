// The shipped standalone host on its native path, from payment evidence to
// delivery: startSellerHost with every operator capability scripted, and the
// package's own native payment evidence consumer reading a scripted in-memory
// Demos node (marked as the fixture node it requires). The buyer proposes,
// commits, pays and claims over the host's authenticated HTTP transport.
// Commitment, payment evidence and the Deliverable are signed storage CREATEs
// on that node, each read back through the package's SR-2 adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import * as seller from '../src/index.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer, NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } from '../src/dacs/demos-sr2-adapter.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
import { createSessionAdmissionFixture } from './helpers/session-admission-fixture.mjs';

const RPC = 'http://127.0.0.1:9/';
const clone = (value) => structuredClone(value);
const demToOs = (amount) => { const [whole, fraction = ''] = amount.split('.'); return (BigInt(whole) * 10n ** 9n + BigInt(fraction.padEnd(9, '0'))).toString(); };

function key() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { address: `0x${raw.toString('hex')}`, claim: `did:demos:agent:${raw.toString('hex')}`,
    sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey),
    signWallet: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}` };
}
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'host-native-delivery' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};

// One Demos node: confirmed blocks bound to the fixture chain identity, native
// DEM transfers, signed storage CREATEs and the name index over them.
function demosNode() {
  const ID = DEMOS_SR2_FIXTURE_CHAIN_IDENTITY;
  const blocks = [{ number: 0, status: 'confirmed', hash: ID, content: { timestamp: 0, ordered_transactions: [] }, validation_data: { simulated: true, chainIdentity: ID } }];
  const txs = new Map(), programs = new Map(), nonces = new Map(), creates = [];
  // The name index for a program: `indexDown` does not answer, `indexEmpty`
  // answers no rows, `beforeSearch` runs before it answers. `searches` lists them.
  const faults = { indexDown: () => false, indexEmpty: () => false, beforeSearch: async () => {} }, searches = [];
  let clock = Math.ceil(Date.now() / 1000);
  const include = (tx) => {
    clock += 2;
    const number = blocks.length;
    blocks.push({ number, status: 'confirmed', hash: core.sha256Hex(`TEST-block:${number}:${tx.hash}`), content: { timestamp: clock, ordered_transactions: [tx.hash] },
      validation_data: { simulated: true, chainIdentity: ID } });
    txs.set(tx.hash, { ...clone(tx), status: 'confirmed', blockNumber: number });
  };
  const nodeCall = (message, data) => {
    switch (message) {
      case 'getBlockByNumber': return clone(blocks[data.blockNumber] ?? null);
      case 'getTransactionStatus': { const tx = txs.get(String(data.hash).toLowerCase()); return tx ? { state: 'included', blockNumber: tx.blockNumber } : { state: 'not-found' }; }
      case 'getTxByHash': return clone(txs.get(String(data.hash).toLowerCase()) ?? null);
      case 'searchStoragePrograms': return faults.indexEmpty(data.query) ? []
        : [...programs.values()].filter((p) => p.programName === data.query).map(({ storageAddress, programName }) => ({ storageAddress, programName }));
      default: return undefined;
    }
  };
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const program = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(pathname);
    if ((init.method ?? 'GET') === 'GET' && program) return programs.has(program[1]) ? answer(200, clone(programs.get(program[1]))) : answer(404, { success: false });
    if (init.method === 'POST' && pathname === '/') {
      const call = JSON.parse(init.body).params[0];
      if (call.message === 'searchStoragePrograms') {
        searches.push(call.data.query);
        await faults.beforeSearch(call.data.query);
        if (faults.indexDown(call.data.query)) return answer(503, { error: 'TEST name index unavailable' });
      }
      const response = nodeCall(call.message, call.data ?? {});
      return answer(200, response === undefined ? { result: 400, response: 'unknown method' } : { result: 200, response });
    }
    return answer(404, { error: 'not found' });
  };
  // The buyer's native DEM transfer.
  const pay = ({ from, to, amountOs }) => {
    const content = { type: 'native', from, from_ed25519_address: from, to, amount: amountOs, data: ['native', { nativeOperation: 'send', args: [to, amountOs] }], nonce: 1, timestamp: Date.now() };
    const tx = { hash: core.sha256Hex(JSON.stringify(content)), content, signature: { type: 'ed25519', data: 'TEST-buyer-transfer' } };
    include(tx);
    return tx.hash;
  };
  // A storage CREATE the writer's wallet signed (Demos: ed25519 over the tx hash).
  const create = (writer, { logicalAddress, artifact, artifactKind, deliveryBinding }) => {
    const owner = writer.address, programName = core.logicalToStorageProgramName(logicalAddress), nonce = (nonces.get(owner) ?? 0) + 1;
    nonces.set(owner, nonce);
    const storageAddress = deriveStorageAddress(owner, programName, nonce, '');
    const { content } = buildStorageProgramCreatePayload({ from: owner, storageAddress, programName, logicalAddress, signedListing: clone(artifact), nonce, timestamp: Date.now() });
    const metadata = { logicalAddress, contentHash: core.contentHash(artifact), envelopeHash: core.sha256Hex(core.canonicalize(artifact)), artifactKind, ...(deliveryBinding ? { deliveryBinding: clone(deliveryBinding) } : {}) };
    content.data[1].metadata = metadata;
    content.from_ed25519_address = owner;
    const hash = core.sha256Hex(JSON.stringify(content)), signed = { hash, content, signature: { type: 'ed25519', data: writer.signWallet(hash) } };
    include(signed);
    programs.set(storageAddress, { success: true, storageAddress, owner, programName, data: clone(artifact), metadata: clone(metadata), createdByTx: hash, interactionTxs: [hash] });
    creates.push({ logicalAddress, artifactKind, hash });
    return clone(signed);
  };
  const reader = createDemosSr2Adapter({ rpcUrl: RPC, journal: createInMemoryDemosSr2Journal(), fetchImpl });
  // A transfer's block and inclusion time (ms), as the pay-dem observer reads them.
  const inclusion = (hash) => { const { blockNumber } = txs.get(hash); return { blockNumber, includedAt: blocks[blockNumber].content.timestamp * 1000 }; };
  return { fetchImpl, pay, create, reader, creates, programs, faults, searches, inclusion, latestBlockMs: () => blocks.at(-1).content.timestamp * 1000 };
}

// The application's Deliverable producer: a report bound to the job, its
// Agreement and its settlement; `change` replaces any of its fields.
const report = (change = {}) => ({ agreement, settlementId }) => ({ reportVersion: '1', kind: 'TEST-host-native-delivery/report', jobId: agreement.jobId,
  agreementHash: core.contentHash(agreement), settlementId, body: ['TEST report delivered by the standalone host.'], ...change });

// `schemaUrl: false`: the Listing's deliverable names no schema, so the SDK
// runs no schema verifier over the prepared Deliverable.
async function world(t, { deliverableProducer = null, schemaUrl = true } = {}) {
  const sellerKey = key(), buyerKey = key(), now = Date.now(), steward = railSteward(), node = demosNode();
  // The host's and the buyer client's clock: wall time, never behind the
  // node's latest block (the node stamps its blocks 2 s apart).
  const clock = () => Math.max(Date.now(), node.latestBlockMs());
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey });
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Native host seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'host-native-delivery', listingVersion: 1, title: 'Native host report', description: 'Payment evidence to delivery through the standalone host.',
    category: 'services.market-report', tags: ['native'], priceDem: '2.5', notBefore: now - 60000 });
  if (!schemaUrl) delete draft.offering.deliverable.schemaUrl;
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft))), pin = seller.listingPin(listing);
  const buyerBundle = identityFor(buyerKey, now);
  // What each operator capability did. `faults` script the next answers;
  // `beforeDeliveryReconcile` runs before the delivery capability reconciles.
  const effects = { anchorEvidence: [], deliverySubmit: [], published: [] };
  const faults = { anchorEvidence: [], deliverySubmit: [], beforeDeliveryReconcile: async () => {} };

  // The operator's Vet context for each job: references to the
  // counterparty-verified records its session admission keeps (DACS-2 §7.7.2).
  const inputs = new Map();
  const vettedInput = async (jobId) => {
    if (!inputs.has(jobId)) {
      const input = seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now });
      inputs.set(jobId, { ...input, buyer: { ...input.buyer, vetRecordRef: await admission.vetRecord(jobId, buyerKey.claim, buyerBundle) },
        seller: { ...input.seller, vetRecordRef: await admission.vetRecord(jobId, sellerKey.claim, listing.seller.identity) } });
    }
    return clone(inputs.get(jobId));
  };
  // The buyer's Agreement CREATEs, read back by the seller.
  const agreements = new Map();
  const agreementAnchor = { source: 'TEST-host-native-delivery/agreement',
    readAgreement: async ({ logicalAddress }) => (agreements.has(logicalAddress)
      ? { disposition: 'present', artifact: clone(agreements.get(logicalAddress)), ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: core.contentHash(agreements.get(logicalAddress)) },
        native: { source: 'TEST-host-native-delivery/agreement', evidenceMode: 'TEST-scripted', nativeAddress: 'TEST-native-agreement', txRef: { kind: 'demos', txHash: 'c3'.repeat(32), blockNumber: 1 } } }
      : { disposition: 'absent', reason: 'TEST not anchored' }) };
  // Seller CREATEs, by logical address; each is read back through the SR-2 adapter.
  const signedCreates = new Map(), written = new Map();
  const readBack = async (logicalAddress, artifactKind, deliveryBinding) => {
    const signed = signedCreates.get(logicalAddress);
    if (!signed) return { status: 'absent', reason: 'TEST no seller CREATE at this address' };
    const read = await node.reader.read(logicalAddress, { expectedWriter: sellerKey.claim, expectedArtifactKind: artifactKind, signedProjection: clone(signed),
      ...(deliveryBinding ? { expectedDeliveryBinding: deliveryBinding } : {}) });
    if (read.status !== 'present') return { status: read.status, reason: 'TEST seller CREATE did not read back' };
    return { status: 'present', artifact: read.artifact, receipt: read.receipt, txRef: { kind: 'demos', txHash: signed.hash, blockNumber: read.demosEvidence.blockNumber },
      signedProjection: clone(signed), demosEvidence: read.demosEvidence };
  };
  const writeOnce = (logicalAddress, artifact, artifactKind, deliveryBinding) => {
    if (!signedCreates.has(logicalAddress)) {
      signedCreates.set(logicalAddress, node.create(sellerKey, { logicalAddress, artifact, artifactKind, deliveryBinding }));
      written.set(logicalAddress, clone(artifact));
    }
  };
  const artifactAnchor = { writer: sellerKey.claim, source: 'TEST-host-native-delivery/artifacts',
    publish: async ({ logicalAddress, artifact, artifactKind, authorize }) => {
      if (!signedCreates.has(logicalAddress)) {
        if (authorize && authorize() !== true) throw new Error('TEST the seller withdrew this write');
        effects.published.push(artifactKind);
        writeOnce(logicalAddress, artifact, artifactKind);
      }
      return readBack(logicalAddress, artifactKind);
    },
    readRetained: async ({ logicalAddress, artifactKind }) => readBack(logicalAddress, artifactKind),
    verifyReceipt: async ({ logicalAddress, artifact, artifactKind, receipt, signedProjection }) =>
      node.reader.verifyReceipt({ receipt, logicalAddress, artifact, expectedWriter: sellerKey.claim, artifactKind, signedProjection }),
  };
  // The seller wallet's payment-evidence anchor. PC-7(b): idempotent on the
  // dacs4:payment address, so a retry gets the earlier CREATE, never a second.
  // `fail`: refused before anything was signed; `lost`: written, answer lost;
  // `other`: the wallet writes seller-signed evidence naming another transfer.
  const nativePaymentEvidence = createNativePaymentEvidenceConsumer({ rpcUrl: RPC, fetchImpl: node.fetchImpl,
    anchorEvidence: async (input) => {
      effects.anchorEvidence.push(input.logicalAddress);
      const fault = faults.anchorEvidence.shift();
      if (fault === 'fail') throw Object.assign(new Error('TEST wallet refused before signing'), { code: 'TEST-wallet-refused' });
      let artifact = input.artifact;
      if (fault === 'other') {
        const { signature: _signature, ...unsigned } = clone(artifact);
        unsigned.paymentTxRefs = [{ ...unsigned.paymentTxRefs[0], txHash: 'd4'.repeat(32) }];
        artifact = await core.signComponentArtifact(unsigned, core.ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: sellerKey.claim, sign: sellerKey.sign });
      }
      writeOnce(input.logicalAddress, artifact, 'SettlementEvidence');
      if (fault === 'lost') throw new Error('TEST wallet answer lost after the CREATE');
      return { status: 'submitted', txHash: signedCreates.get(input.logicalAddress).hash };
    },
    readSignedProjection: async ({ logicalAddress }) => (signedCreates.has(logicalAddress) ? clone(signedCreates.get(logicalAddress)) : undefined) });
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-host-native-delivery',
    resolveBuyer: async () => { throw new Error('TEST the buyer resolver is not the seller\'s'); },
    resolveSeller: async ({ jobId }) => {
      const input = await vettedInput(jobId);
      // One requirement invocation per Vet record the Agreement references,
      // each naming the evaluated party's counterparty as verifier.
      const invocation = (party, claim, verifier) => ({ vetRecordRef: input[party].vetRecordRef, evaluatedParty: claim, requirement: clone(listing.buyerRequirement),
        verifier, freshness: [], dealSpecific: [] });
      return { disposition: 'present', value: { input, vetRequirements: [invocation('buyer', buyerKey.claim, sellerKey.claim), invocation('seller', sellerKey.claim, buyerKey.claim)] } };
    } });
  // The seller's Deliverable CREATE and its public readback.
  const deliverable = async (input) => readBack(input.logicalAddress, 'Deliverable', input.deliveryBinding);
  const nativeDemDelivery = createNativeDemDeliveryCapability({ authority: 'TEST-host-native-delivery',
    submit: async (input) => {
      effects.deliverySubmit.push(input.logicalAddress);
      if (faults.deliverySubmit.shift() === 'fail') throw new Error('TEST delivery wallet refused before signing');
      writeOnce(input.logicalAddress, input.report, 'Deliverable', input.deliveryBinding);
      return { status: 'accepted', reconciliationId: signedCreates.get(input.logicalAddress).hash };
    },
    reconcile: async (input) => {
      await faults.beforeDeliveryReconcile();
      const read = await deliverable(input);
      return read.status === 'present' ? { status: 'complete', reconciliationId: read.receipt.transactionRef.value, observedAt: read.receipt.blockRef.timestamp } : { status: 'absent', reason: read.reason };
    },
    read: deliverable,
    verifyReceipt: async ({ logicalAddress, report, receipt, receiptContentHash, deliveryBinding }) => node.reader.verifyReceipt({ receipt, logicalAddress, artifact: report,
      expectedWriter: sellerKey.claim, artifactKind: 'Deliverable', deliveryBinding, receiptContentHash, signedProjection: clone(signedCreates.get(logicalAddress)) }),
  });
  const producer = deliverableProducer ?? report();

  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-host-native-')));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const hosts = [];
  t.after(async () => { for (const host of hosts) await host.close(); });
  const capabilities = () => ({ signer: { claim: sellerKey.claim, sign: sellerKey.sign }, listing,
    buyerAccess: seller.createOperatorBuyerAccess({ openBuyerAccess: true }), agreementAnchor, deliverableProducer: producer,
    observeDemosTransfer: async () => { throw new Error('TEST the native profile observes transfers through native payment evidence'); },
    nativePaymentEvidence, demDeliveryContext, nativeDemDelivery, railAuthority: steward.railAuthority(), sessionAdmission: admission.sessionAdmission, now: clock });
  const start = async () => {
    const host = await seller.startSellerHost({ ...capabilities(), dataDirectory, artifactAnchor });
    hosts.push(host);
    return host;
  };
  let host = await start();

  // One buyer purchase: the buyer signs, finalizes and anchors the Agreement,
  // asks the seller to commit, and pays the Agreement's payee.
  const purchase = async () => {
    const jobId = core.generateCanonicalJobId();
    const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(await vettedInput(jobId)));
    const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
    const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
    const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
    const client = () => seller.createSellerAgentClient({ url: host.url, authentication: seller.createSellerTransportClientAuth({
      buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim, resolveJob: () => ({ listingPin: pin, agreementHash: plan.agreementHash }), now: clock }) });
    const answer = await client().propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle });
    assert.equal(answer.disposition, 'complete', 'the seller signs the vetted Agreement');
    const agreement = await core.finalizeFixedPriceAgreementContributions(plan, [buyerContribution, answer.contribution], seller.contributionVerifier);
    agreements.set(core.fixedPriceAgreementLogicalAddress(jobId), agreement);
    assert.equal((await client().commit(jobId)).status, 'committed');
    const payout = agreement.terms.payoutBindings[0], amountOs = demToOs(agreement.terms.price.amount);
    return { jobId, agreement, payout, amountOs, client,
      pay: () => node.pay({ from: buyerKey.address, to: payout.payeeAddress, amountOs }),
      claim: async (txHash) => { try { return await client().submitPayment({ jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }); }
        catch (error) { return { error: error.code, status: error.status }; } } };
  };
  const restart = async () => { await host.close(); hosts.splice(hosts.indexOf(host), 1); host = await start(); };
  // The operator's read-only view of a job's retained session (durableSessionOf),
  // read with the host stopped, from the host's own durable state.
  const retainedSession = async (jobId) => {
    await host.close(); hosts.splice(hosts.indexOf(host), 1);
    const agent = await seller.createSellerAgent({ ...capabilities(), durableDirectory: join(dataDirectory, 'seller'), nativeArtifactAnchor: artifactAnchor });
    try { return agent.durableSessionOf(jobId); } finally { agent.close(); }
  };
  const createsAt = (logicalAddress) => node.creates.filter((entry) => entry.logicalAddress === logicalAddress).length;
  const signedCreate = (logicalAddress) => clone(signedCreates.get(logicalAddress));
  const writtenAt = (logicalAddress) => clone(written.get(logicalAddress));
  return { node, effects, faults, purchase, restart, retainedSession, createsAt, signedCreate, writtenAt, sellerKey, buyerKey, listing };
}

const paymentAddress = (p) => core.paymentEvidenceAddress(p.jobId, p.payout.railId, p.payout.phaseIndex);
const shown = (answer) => JSON.stringify(answer);

test('the host takes a native payment to anchored, read-back payment evidence and hands the order to delivery; the confirmed anchor is never sent again', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.evidenceAddress, address);
  assert.equal(typeof answer.delivery, 'object', 'the paid order is handed to the SDK delivery runner');
  // The evidence CREATE reads back as this payment's seller-signed SettlementEvidence.
  const read = await w.node.reader.read(address, { expectedWriter: w.sellerKey.claim, expectedArtifactKind: 'SettlementEvidence', signedProjection: answer.signedProjection });
  assert.equal(read.status, 'present');
  assert.equal(core.contentHash(read.artifact), answer.evidenceHash);
  assert.equal(read.artifact.jobId, p.jobId);
  assert.deepEqual(read.artifact.paymentTxRefs.map((ref) => ref.txHash), [tx]);
  assert.deepEqual(w.effects.anchorEvidence, [address]);
  // While the delivery is not final, each claim runs the retained work again,
  // also on a restarted host: it reads the confirmed anchor back and sends nothing.
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  await w.restart();
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.anchorEvidence, [address], 'a confirmed anchor is not sent again');
  assert.equal(w.createsAt(address), 1);
});

test('a payment-evidence anchor that failed is sent again on the buyer\'s next claim, and the order goes on to delivery (DACS-4 PC-7(b))', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.anchorEvidence.push('fail');
  const held = await p.claim(tx);
  assert.equal(held.status, 'held', shown(held));
  assert.equal(held.readback, 'absent');
  assert.equal(held.anchorError?.code, 'TEST-wallet-refused');
  assert.equal(w.createsAt(address), 0);
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(typeof answer.delivery, 'object', 'the paid order is handed to the SDK delivery runner');
  assert.deepEqual(w.effects.anchorEvidence, [address, address], 'sent again once the readback proved it absent');
  assert.equal(w.createsAt(address), 1, 'one CREATE');
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.equal(w.effects.anchorEvidence.length, 2, 'once confirmed, it is not sent again');
});

test('the anchor retry survives a restart: the restarted host sends the failed anchor again', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.anchorEvidence.push('fail');
  assert.equal((await p.claim(tx)).status, 'held');
  await w.restart();
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.deepEqual(w.effects.anchorEvidence, [address, address]);
  assert.equal(w.createsAt(address), 1);
});

test('an anchor whose answer was lost after the write is read back, not sent again', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.anchorEvidence.push('lost');
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.anchorEvidence, [address]);
  assert.equal(w.createsAt(address), 1);
});

test('an indeterminate readback sends nothing: the anchor is sent again only on a proven absence', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.anchorEvidence.push('fail');
  assert.equal((await p.claim(tx)).status, 'held');
  w.node.faults.indexDown = (programName) => programName === core.logicalToStorageProgramName(address);
  const unknown = await p.claim(tx);
  assert.equal(unknown.status, 'held', shown(unknown));
  assert.equal(unknown.readback, 'indeterminate');
  assert.deepEqual(w.effects.anchorEvidence, [address], 'nothing is sent while the readback is unknown');
  w.node.faults.indexDown = () => false;
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.anchorEvidence, [address, address]);
  assert.equal(w.createsAt(address), 1);
});

test('a confirmed anchor is not sent again when the name index later reads it absent', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  w.node.faults.indexEmpty = (programName) => programName === core.logicalToStorageProgramName(address);
  await p.claim(tx);
  w.node.faults.indexEmpty = () => false;
  assert.equal((await p.claim(tx)).status, 'payment-evidenced');
  assert.deepEqual(w.effects.anchorEvidence, [address]);
  assert.equal(w.createsAt(address), 1);
});

// Settlement credit (SB-2): one transfer claimed by two jobs gives neither
// job credit. Job A's failed anchor leaves its checkpoint bound to the
// transfer; once job B claims it too, job A reads nothing back, sends nothing
// and gets no answer about the job.
test('settlement credit: a transfer another job also claims is anchored for neither job and handed to no delivery', async (t) => {
  const w = await world(t);
  const a = await w.purchase(), b = await w.purchase(), tx = a.pay(), address = paymentAddress(a);
  w.faults.anchorEvidence.push('fail');
  assert.equal((await a.claim(tx)).status, 'held');
  assert.deepEqual(await b.claim(tx), { status: 'indeterminate', reason: 'settlement-collision' });
  const reads = w.node.searches.length;
  assert.equal((await a.claim(tx)).error, 'seller_unavailable', 'no answer for a job whose credit is contested');
  assert.deepEqual(w.node.searches.slice(reads).filter((name) => name === core.logicalToStorageProgramName(address)), [], 'the contested checkpoint is not read back');
  assert.deepEqual(w.effects.anchorEvidence, [address], 'nothing is anchored once the credit is contested');
  assert.equal(w.createsAt(address) + w.createsAt(paymentAddress(b)), 0);
});

test('settlement credit is checked again right before the anchor is sent: a claim on another job during the readback stops it', async (t) => {
  const w = await world(t);
  const a = await w.purchase(), b = await w.purchase(), tx = a.pay(), address = paymentAddress(a), name = core.logicalToStorageProgramName(address);
  w.faults.anchorEvidence.push('fail');
  assert.equal((await a.claim(tx)).status, 'held');
  let contested = null;
  w.node.faults.beforeSearch = async (programName) => { if (programName === name && contested === null) contested = await b.claim(tx); };
  assert.equal((await a.claim(tx)).error, 'seller_unavailable');
  assert.deepEqual(contested, { status: 'indeterminate', reason: 'settlement-collision' }, 'job B claimed the transfer while job A read back');
  assert.deepEqual(w.effects.anchorEvidence, [address], 'job A sends nothing once its credit is contested');
  assert.equal(w.createsAt(address), 0);
});

test('a readback that is not this payment\'s evidence is refused before delivery', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), address = paymentAddress(p);
  w.faults.anchorEvidence.push('other');
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'rejected', shown(answer));
  assert.equal(answer.reason, 'native-payment-evidence-scope-mismatch');
  assert.equal(answer.delivery, undefined, 'no delivery is attempted');
  assert.equal((await p.claim(tx)).status, 'rejected');
  assert.deepEqual(w.effects.anchorEvidence, [address], 'a CREATE that is present is never sent again');
});

// Delivery. Each party's Vet record is verified by its counterparty (DACS-2
// §7.7.2), as the core delivery runner checks in the audit source.
test('a native payment is delivered: the Deliverable CREATE reads back bound to the Agreement and the settlement', async (t) => {
  const w = await world(t);
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  // Payment evidence, the settlement credit on the payment permit, then the Deliverable.
  const answer = await p.claim(tx);
  assert.equal(answer.status, 'payment-evidenced', shown(answer));
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer.delivery));
  assert.equal(answer.delivery.logicalAddress, deliverable);
  assert.deepEqual(w.effects.anchorEvidence, [paymentAddress(p)]);
  assert.deepEqual(w.effects.deliverySubmit, [deliverable]);
  assert.equal(w.createsAt(deliverable), 1);
  // The CREATE reads back as the seller's Deliverable for this job, Agreement and settlement.
  const binding = answer.delivery.deliveryBinding;
  assert.deepEqual([binding.jobId, binding.agreementHash], [p.jobId, core.contentHash(p.agreement)]);
  const read = await w.node.reader.read(deliverable, { expectedWriter: w.sellerKey.claim, expectedArtifactKind: 'Deliverable', signedProjection: w.signedCreate(deliverable),
    expectedDeliveryBinding: binding });
  assert.equal(read.status, 'present');
  assert.equal(core.contentHash(read.artifact), answer.delivery.contentHash);
  assert.deepEqual([read.artifact.jobId, read.artifact.agreementHash, read.artifact.settlementId], [p.jobId, core.contentHash(p.agreement), answer.settlementId]);
  // A later claim, also on a restarted host, reads the delivery back and sends nothing.
  assert.equal((await p.claim(tx)).delivery?.status, 'delivery-ready');
  await w.restart();
  const again = await p.claim(tx);
  assert.equal(again.delivery?.status, 'delivery-ready', shown(again.delivery));
  assert.equal(again.delivery.contentHash, answer.delivery.contentHash);
  assert.deepEqual(w.effects.deliverySubmit, [deliverable], 'the Deliverable is sent once');
  assert.equal(w.createsAt(deliverable), 1);
});

test('a Deliverable the producer does not bind to this job, Agreement and settlement is not sent', async (t) => {
  const changes = { 'another job': { jobId: core.generateCanonicalJobId() }, 'another Agreement': { agreementHash: core.sha256Hex('TEST another Agreement') },
    'another settlement': { settlementId: core.sha256Hex('TEST another settlement') } };
  for (const [label, change] of Object.entries(changes)) {
    const w = await world(t, { deliverableProducer: report(change) });
    const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
    const answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}: ${shown(answer)}`);
    assert.equal(answer.delivery?.status, 'held', `${label}: ${shown(answer.delivery)}`);
    assert.match(answer.delivery.reason, /the application deliverable is not bound to this Agreement and settlement/, label);
    assert.deepEqual(w.effects.deliverySubmit, [], `${label}: nothing is sent`);
    assert.equal(w.createsAt(deliverable), 0, label);
  }
});

// The SDK submits the candidate it prepared; the seller sends it only if it is
// still the exact report the producer answers for this job and settlement.
// With a schema the SDK's schema verifier compares it too; without one, the
// seller's check at submission is the only one.
test('a delivery candidate that is not the exact report is not sent: the producer answered differently at submission', async (t) => {
  for (const schemaUrl of [true, false]) {
    let answers = 0;
    const w = await world(t, { schemaUrl, deliverableProducer: (input) => report({ body: [`TEST report, answer ${++answers}`] })(input) });
    assert.equal('schemaUrl' in w.listing.offering.deliverable, schemaUrl);
    const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`, label = schemaUrl ? 'with a schema' : 'without a schema';
    const answer = await p.claim(tx);
    assert.equal(answer.status, 'payment-evidenced', `${label}: ${shown(answer)}`);
    assert.equal(answer.delivery?.status, 'held', `${label}: ${shown(answer.delivery)}`);
    assert.deepEqual(w.effects.deliverySubmit, [], `${label}: nothing is sent`);
    assert.equal(w.createsAt(deliverable), 0, label);
  }
});

test('without a schema in the Listing, a native payment is delivered', async (t) => {
  const w = await world(t, { schemaUrl: false });
  const p = await w.purchase(), tx = p.pay(), deliverable = `dacs4:deliverable:${p.jobId}`;
  const answer = await p.claim(tx);
  assert.equal(answer.delivery?.status, 'delivery-ready', shown(answer.delivery));
  assert.deepEqual(w.effects.deliverySubmit, [deliverable]);
  assert.equal(w.createsAt(deliverable), 1);
});

// Settlement credit (SB-2) on the payment permit: job B claims job A's
// transfer after A's delivery has read its audit source and before A's permit
// is consumed. Neither job has credit: A's permit is refused, not spent, and
// A's Deliverable is not sent. The SDK receipt store elects one of the two
// claims on its own (both are observed at the transfer's inclusion, so the
// lower evidence hash wins) and takes the permit from a job it does not elect.
// A is the job it elects: only the seller's credit check refuses A's permit.
test('settlement credit is checked again before the Deliverable is sent: a claim on another job during the delivery stops it', async (t) => {
  const w = await world(t);
  // Both jobs pay the same payee the same amount, so one transfer serves either.
  const x = await w.purchase(), y = await w.purchase(), tx = x.pay(), { blockNumber, includedAt } = w.node.inclusion(tx);
  const evidenceInput = (p) => ({ evidenceVersion: '1', jobId: p.jobId, phase: 'pay-dem', outcome: 'success', paymentTxRefs: [{ kind: 'demos', txHash: tx, blockNumber }],
    paymentAmount: clone(p.agreement.terms.price), settlementFinality: { model: 'bft-final', finalityObservedAt: includedAt }, observedAt: includedAt });
  const [a, b] = core.contentHash(evidenceInput(x)) < core.contentHash(evidenceInput(y)) ? [x, y] : [y, x], deliverable = `dacs4:deliverable:${a.jobId}`;
  let contested = null;
  w.faults.beforeDeliveryReconcile = async () => { if (contested === null) contested = await b.claim(tx); };
  assert.equal((await a.claim(tx)).error, 'seller_unavailable', 'no answer for a job whose credit is contested');
  assert.deepEqual(contested, { status: 'indeterminate', reason: 'settlement-collision' }, 'job B claimed the transfer during job A\'s delivery');
  assert.deepEqual(w.effects.anchorEvidence, [paymentAddress(a)], 'job A\'s payment evidence was anchored before the claim on job B');
  assert.deepEqual(w.effects.deliverySubmit, [], 'job A\'s Deliverable is not sent');
  assert.equal(w.createsAt(deliverable), 0);
  // A's anchored evidence is the input A's election was computed from.
  const { signature: _signature, ...anchored } = w.writtenAt(paymentAddress(a));
  assert.deepEqual(anchored, evidenceInput(a));
  const retained = await w.retainedSession(a.jobId);
  assert.equal(retained.settlementCredit, 'indeterminate');
  assert.deepEqual([retained.deliveryHold?.result?.decision, retained.deliveryHold?.result?.code], ['rejected', 'payment-permit-invalid'], shown(retained.deliveryHold));
});
