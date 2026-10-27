// DACS_BUYER_CHAIN_READBACK decision branches with a stub SR-2 reader over a
// real pinned source transport: writer, address, kind, content hash, not-found,
// adapter verdicts, pointer preference, the seller answer decorator and the
// switch itself. The live chain paths are in buyer-chain-readback.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contentHash, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';
import { BuyerChainReadbackUnsupported, CONTRADICTED_READ_CODES, createBuyerChainReadback, POINTER_MISSING, signedCreateBytes, signedCreateFor, PUBLIC_SIGNED_CREATES } from '../src/dacs/buyer-chain-readback.mjs';
import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { DemosSr2Error, demosSr2Contradiction } from '../src/dacs/demos-sr2-adapter.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { deliveryPointerDiffers, missingChainPointers } from '../src/dacs/seller-session-lifecycle.mjs';
import { SELLER_TRANSPORT_MAX_RESPONSE } from '../src/dacs/seller-transport-auth.mjs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import http from 'node:http';
import { createPublicSignedCreates } from '../src/devnet-demo/public-signed-creates.mjs';
import { createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { DEVNET_PURCHASED_REPORT_KIND } from '../src/devnet-demo/deliverable.mjs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { normalizeRuns } from './helpers/buyer-chain-readback-identity.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const HEX = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const seller = createEphemeralWallet(), other = createEphemeralWallet();
const jobId = generateCanonicalJobId(), agreementHash = HEX('agreement');
const listing = { listingId: 'unit-listing', listingVersion: 1, seller: { identity: { presentedBy: seller.claim } } }, pin = listingPin(listing);
const address = `dacs4:deliverable:${jobId}`, nativeAddress = `stor-${HEX('native').slice(0, 40)}`, txHash = HEX('tx');
const report = { reportVersion: '1', kind: DEVNET_PURCHASED_REPORT_KIND, jobId, agreementHash, listing: pin, title: 'Unit report', settlementId: `demos:${HEX('pay')}`,
  producer: seller.claim, content: { mediaType: 'text/plain; charset=utf-8', text: 'unit bytes' } };
const binding = { version: '1', profile: 'dacs-native-delivery-publication/v1', jobId, phase: 'deliver-storage-program', phaseIndex: 3, listing: pin, agreementHash,
  fulfilmentId: 'fulfilment-1', purchaseAmount: { amount: '1', currency: 'DEM' }, payloadHash: contentHash(report) };
const projection = (over = {}) => ({ hash: txHash, content: { from: seller.address, to: nativeAddress, data: ['storageProgram', { metadata: { logicalAddress: address, artifactKind: 'Deliverable' } }], ...over }, signature: { type: 'ed25519', data: '0x00' } });
const record = (over = {}) => ({ status: 'present', artifactKind: 'Deliverable', artifact: structuredClone(report),
  receipt: { writer: seller.claim, logicalAddress: address, contentHash: contentHash(report), transactionRef: { value: txHash }, nativeAddress }, ...over });
const input = (over = {}) => ({ jobId, agreementHash, listing, seller: seller.claim, deliveryBinding: binding, receiptContentHash: contentHash(report), settlementId: report.settlementId, signedProjection: projection(), ...over });
function stub({ read = () => record(), verify = () => 'valid' } = {}) {
  const calls = { read: [], verify: [] };
  return { calls, read: async (logicalAddress, options) => { calls.read.push({ logicalAddress, options }); return read(logicalAddress, options); },
    verifyReceipt: async (value) => { calls.verify.push(value); return verify(value); } };
}

let transport;
test.before(async () => { transport = await startDevnetLiveCompositionTransport(); });
test.after(async () => { await transport?.close(); });



test('a present, exactly bound Deliverable reads back with the Listing seller as the only expected writer', async () => {
  const reader = stub(), chain = createBuyerChainReadback({ sourceCapability: transport.capability, reader });
  const read = await chain.readDeliverable(input());
  assert.equal(read.status, 'present', JSON.stringify(read));
  assert.deepEqual(read.artifact, report);
  assert.equal(reader.calls.read.length, 1);
  assert.equal(reader.calls.read[0].logicalAddress, address);
  assert.equal(reader.calls.read[0].options.expectedWriter, seller.claim);
  assert.equal(reader.calls.read[0].options.expectedArtifactKind, 'Deliverable');
  assert.deepEqual(reader.calls.read[0].options.expectedDeliveryBinding, binding);
  assert.equal(reader.calls.verify[0].receiptContentHash, contentHash(report), 'the receipt is verified against the hash of the bytes read, not the receipt\'s own claim');
});

test('not found is indeterminate, never absent, and a missing pointer reads nothing', async () => {
  const absent = stub({ read: () => ({ status: 'absent' }) }), chain = createBuyerChainReadback({ sourceCapability: transport.capability, reader: absent });
  const read = await chain.readDeliverable(input());
  assert.equal(read.status, 'indeterminate');
  assert.match(read.reason, /not proof of absence/);
  const none = stub(), unpointed = createBuyerChainReadback({ sourceCapability: transport.capability, reader: none });
  for (const signedProjection of [undefined, null, {}, { hash: 'nothex', content: {} }]) {
    const unread = await unpointed.readDeliverable(input({ signedProjection }));
    assert.equal(unread.status, 'indeterminate');
    assert.equal(unread.pointer, POINTER_MISSING, 'a missing pointer is marked as such');
  }
  assert.equal(read.pointer, undefined, 'a chain not-found is not a missing pointer');
  assert.equal(none.calls.read.length, 0, 'no chain read is made without the original signed bytes');
  // an earlier review (a review P3): only the adapter's definite `invalid` verdict is a
  // rejection. Any other code, or none at all (a local or transport fault),
  // proves nothing and is indeterminate.
  assert.deepEqual(CONTRADICTED_READ_CODES, ['invalid']);
  for (const error of [Object.assign(new Error('unavailable'), { code: 'indeterminate' }), Object.assign(new Error('another chain'), { code: 'invalid-chain' }),
    Object.assign(new Error('a write path'), { code: 'journal-error' }), new Error('no code'), new TypeError('a local fault'), 'a thrown string']) {
    const thrown = stub({ read: () => { throw error; } });
    const read2 = await createBuyerChainReadback({ sourceCapability: transport.capability, reader: thrown }).readDeliverable(input());
    assert.equal(read2.status, 'indeterminate', String(error?.code ?? error));
  }
  // an earlier review (code P2-1 / a review P2-1): only the adapter's marked
  // contradiction rejects. An unmarked `invalid` (node data or offered bytes
  // that did not authenticate, the source change) is indeterminate and keeps its code, so a
  // caller can still blame a fresh seller offer; a foreign error that merely
  // carries the code is not a verdict either.
  const contradicted = stub({ read: () => { throw demosSr2Contradiction('the authenticated CREATE binds another delivery scope'); } });
  const refused = await createBuyerChainReadback({ sourceCapability: transport.capability, reader: contradicted }).readDeliverable(input());
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.authenticated, undefined, 'the caller decides whom a rejection of the offered bytes blames');
  assert.equal(refused.code, undefined);
  for (const error of [new DemosSr2Error('invalid', 'observed block does not establish source-bound inclusion'), Object.assign(new Error('refused'), { code: 'invalid' }),
    Object.assign(new Error('a foreign mark'), { code: 'invalid', contradiction: true })]) {
    const unmarked = await createBuyerChainReadback({ sourceCapability: transport.capability, reader: stub({ read: () => { throw error; } }) }).readDeliverable(input());
    assert.equal(unmarked.status, 'indeterminate', error.message);
    assert.equal(unmarked.code, 'invalid', error.message);
    assert.equal(unmarked.authenticated, undefined, error.message);
    assert.match(unmarked.reason, /native Deliverable read: invalid: /);
  }
  for (const [verdict, status, authenticated] of [['indeterminate', 'indeterminate', undefined], ['invalid', 'rejected', true]]) {
    const read2 = await createBuyerChainReadback({ sourceCapability: transport.capability, reader: stub({ verify: () => verdict }) }).readDeliverable(input());
    assert.equal(read2.status, status);
    assert.equal(read2.authenticated, authenticated);
  }
});

test('an earlier review: a rejection says whether the bytes authenticated on chain first', async () => {
  // Refused before any read: the offered bytes, not the chain.
  const unread = stub(), chain = createBuyerChainReadback({ sourceCapability: transport.capability, reader: unread });
  for (const over of [{ signedProjection: projection({ from: other.address }) }, { signedProjection: projection({ data: ['storageProgram', { metadata: { logicalAddress: address, artifactKind: 'SettlementEvidence' } }] }) }]) {
    const read = await chain.readDeliverable(input(over));
    assert.equal(read.status, 'rejected'); assert.equal(read.authenticated, undefined);
  }
  assert.equal(unread.calls.read.length, 0);
  // The bytes authenticated and what read back differs: the chain's verdict.
  for (const value of [record({ receipt: { ...record().receipt, contentHash: HEX('claimed') } }), record({ artifactKind: 'SettlementEvidence' }), record({ artifact: { ...report, settlementId: `demos:${HEX('another payment')}` } })]) {
    const read = await createBuyerChainReadback({ sourceCapability: transport.capability, reader: stub({ read: () => value, verify: (v) => v.receiptContentHash === v.receipt.contentHash ? 'valid' : 'invalid' }) }).readDeliverable(input());
    assert.equal(read.status, 'rejected'); assert.equal(read.authenticated, true);
  }
});

test('any other writer is refused: caller seller, pointer signer or receipt writer', async () => {
  const reader = stub(), chain = createBuyerChainReadback({ sourceCapability: transport.capability, reader });
  assert.equal((await chain.readDeliverable(input({ seller: other.claim }))).status, 'rejected', 'a seller other than the verified Listing seller');
  assert.equal((await chain.readDeliverable(input({ listing: { ...listing, seller: { identity: { presentedBy: other.claim } } } }))).status, 'rejected');
  assert.equal((await chain.readDeliverable(input({ signedProjection: projection({ from: other.address }) }))).status, 'rejected', 'bytes signed by another key');
  assert.equal(reader.calls.read.length, 0, 'refused before any read');
  // A caller seller and pointer signer that agree with each other but not with the verified Listing.
  const otherPointer = projection({ from: other.address }), asked = stub(), listed = createBuyerChainReadback({ sourceCapability: transport.capability, reader: asked });
  assert.equal((await listed.readDeliverable(input({ seller: other.claim, signedProjection: otherPointer }))).status, 'rejected');
  const evidencePointer = { ...otherPointer, content: { ...otherPointer.content, data: ['storageProgram', { metadata: { logicalAddress: `dacs4:evidence:${jobId}`, artifactKind: 'SettlementEvidence' } }] } };
  assert.equal((await listed.readDeliveryEvidence({ agreement: { jobId }, listing, seller: other.claim, signedProjection: evidencePointer })).status, 'rejected');
  assert.equal(asked.calls.read.length, 0, 'only the verified Listing seller is ever read as the writer');
  const foreign = stub({ read: () => record({ receipt: { ...record().receipt, writer: other.claim } }) });
  assert.equal((await createBuyerChainReadback({ sourceCapability: transport.capability, reader: foreign }).readDeliverable(input())).status, 'rejected');
});

test('another address, native address, kind, transaction or content hash is refused', async () => {
  const cases = [
    ['pointer names another logical address', { signedProjection: projection({ data: ['storageProgram', { metadata: { logicalAddress: `dacs4:deliverable:${generateCanonicalJobId()}`, artifactKind: 'Deliverable' } }] }) }],
    ['pointer names another kind', { signedProjection: projection({ data: ['storageProgram', { metadata: { logicalAddress: address, artifactKind: 'SettlementEvidence' } }] }) }],
    ['pointer names another native address', { signedProjection: projection({ to: `stor-${HEX('forged').slice(0, 40)}` }) }],
  ];
  for (const [name, over] of cases) {
    const reader = stub();
    assert.equal((await createBuyerChainReadback({ sourceCapability: transport.capability, reader }).readDeliverable(input(over))).status, 'rejected', name);
  }
  const records = [
    ['receipt hash differs from the bytes read', record({ receipt: { ...record().receipt, contentHash: HEX('claimed') } })],
    ['bytes differ from the receipt hash', record({ artifact: { ...report, content: { ...report.content, text: 'altered bytes' } } })],
    ['another kind read back', record({ artifactKind: 'SettlementEvidence' })],
    ['another transaction read back', record({ receipt: { ...record().receipt, transactionRef: { value: HEX('other-tx') } } })],
    ['another native address read back', record({ receipt: { ...record().receipt, nativeAddress: `stor-${HEX('elsewhere').slice(0, 40)}` } })],
    ['another logical address read back', record({ receipt: { ...record().receipt, logicalAddress: `dacs4:deliverable:${generateCanonicalJobId()}` } })],
  ];
  for (const [name, value] of records) {
    // The stub verifier trusts whatever hash it is asked about, like a reader
    // that only format-checks metadata: the reader's own hash check must refuse.
    const reader = stub({ read: () => value, verify: (v) => v.receiptContentHash === v.receipt.contentHash ? 'valid' : 'invalid' });
    assert.equal((await createBuyerChainReadback({ sourceCapability: transport.capability, reader }).readDeliverable(input())).status, 'rejected', name);
  }
});

test('the Deliverable must bind this Agreement, Listing, payload and settlement', async () => {
  const chain = createBuyerChainReadback({ sourceCapability: transport.capability, reader: stub() });
  assert.equal((await chain.readDeliverable(input({ agreementHash: HEX('another agreement') }))).status, 'rejected');
  assert.equal((await chain.readDeliverable(input({ deliveryBinding: { ...binding, agreementHash: HEX('another agreement') } }))).status, 'rejected');
  assert.equal((await chain.readDeliverable(input({ deliveryBinding: { ...binding, listing: { ...pin, version: 2 } } }))).status, 'rejected');
  assert.equal((await chain.readDeliverable(input({ listing: { ...listing, listingVersion: 2 } }))).status, 'rejected', 'another Listing version');
  assert.equal((await chain.readDeliverable(input({ receiptContentHash: HEX('claimed payload') }))).status, 'rejected');
  assert.equal((await chain.readDeliverable(input({ settlementId: `demos:${HEX('another payment')}` }))).status, 'rejected');
  // A pointer and binding that both claim other bytes than the ones read back.
  const claimed = HEX('claimed payload');
  assert.equal((await chain.readDeliverable(input({ receiptContentHash: claimed, deliveryBinding: { ...binding, payloadHash: claimed } }))).status, 'rejected');
  const shifted = createBuyerChainReadback({ sourceCapability: transport.capability, reader: stub({ read: () => record({ artifact: { ...report, agreementHash: HEX('x') } }) }) });
  assert.equal((await shifted.readDeliverable(input())).status, 'rejected');
});

test('the buyer prefers signed bytes it already authenticated over the seller\'s pointer', () => {
  const own = { hash: 'own' }, offered = { hash: 'offered' };
  assert.equal(signedCreateFor('a', { retained: { a: own }, answer: { [PUBLIC_SIGNED_CREATES]: { a: offered } } }), own);
  assert.equal(signedCreateFor('a', { retained: { b: own }, answer: { [PUBLIC_SIGNED_CREATES]: { a: offered } } }), offered);
  assert.equal(signedCreateFor('a', { retained: null, answer: { [PUBLIC_SIGNED_CREATES]: null } }), undefined);
  assert.equal(signedCreateFor('a', {}), undefined);
});

test('the reader needs the buyer\'s own pinned source transport', () => {
  for (const sourceCapability of [undefined, null, {}, { observeBinding() {} }]) assert.throws(() => createBuyerChainReadback({ sourceCapability }), TypeError);
});

test('the seller pointer function names only its own verified signed CREATEs for the job and leaves every other answer unchanged', async () => {
  const signed = { hash: HEX('s'), content: {} }, evidence = { hash: HEX('e'), content: {} }, asked = [], readBack = [];
  const evidenceAddress = `dacs4:evidence:${jobId}`;
  let evidenceVerified = false;
  const anchor = {
    retainedSignedCreate: async ({ logicalAddress, artifactKind }) => { asked.push([logicalAddress, artifactKind]);
      return logicalAddress === address ? structuredClone(signed) : logicalAddress === evidenceAddress && evidenceVerified ? structuredClone(evidence) : null; },
    // The seller's own authenticated readback; here it verifies the evidence it had not yet verified.
    readRetained: async ({ logicalAddress }) => { readBack.push(logicalAddress); if (logicalAddress === evidenceAddress) { evidenceVerified = true; return { status: 'present' }; } return { status: 'absent' }; } };
  const pointers = createPublicSignedCreates(anchor);
  assert.deepEqual(await pointers(jobId, { status: 'payment-evidenced' }), { status: 'payment-evidenced', [PUBLIC_SIGNED_CREATES]: { [address]: signed, [evidenceAddress]: evidence } });
  assert.deepEqual(asked.map(([, kind]) => kind), ['FinalityCommitmentRecord', 'Deliverable', 'SettlementEvidence', 'SettlementEvidence']);
  assert.deepEqual(readBack, [`dacs3:commit:${jobId}`, evidenceAddress], 'only writes not yet verified are read back, by the seller');
  const unseen = createPublicSignedCreates({ retainedSignedCreate: async () => null, readRetained: async () => ({ status: 'indeterminate' }) });
  assert.deepEqual(await unseen(jobId, { status: 'x' }), { status: 'x' }, 'bytes the seller has not seen included are not offered');
  const failing = createPublicSignedCreates({ retainedSignedCreate: async () => null, readRetained: async () => { throw new Error('TEST'); } });
  assert.deepEqual(await failing(jobId, { status: 'x' }), { status: 'x' });
  const other = { status: 'committed', address: 'x' };
  assert.equal(await pointers(generateCanonicalJobId(), other), other, 'nothing retained: the same answer');
  for (const answer of [{ error: 'refused' }, null, ['array'], 'text']) assert.equal(await pointers(jobId, answer), answer);
  assert.equal(await pointers(undefined, other), other, 'no job: unchanged');
  assert.throws(() => createPublicSignedCreates({}), TypeError);
  assert.throws(() => createPublicSignedCreates({ retainedSignedCreate: async () => null }), TypeError);
  assert.throws(() => createPublicSignedCreates(anchor, { readbackBudgetMs: -1 }), TypeError);
});

test('the seller\'s readback inside an answer is bounded: past its deadline the answer is sent without that pointer', async () => {
  const started = [], slow = createPublicSignedCreates({ retainedSignedCreate: async () => null,
    readRetained: ({ logicalAddress }) => { started.push(logicalAddress); return new Promise(() => {}); } }, { readbackBudgetMs: 50 });
  const t0 = Date.now(), late = new Promise((_, reject) => setTimeout(() => reject(new Error('the answer waited for the seller readback past its budget')), 2000).unref());
  assert.deepEqual(await Promise.race([slow(jobId, { status: 'x' }), late]), { status: 'x' });
  assert.ok(Date.now() - t0 < 1000, 'the whole answer waited about one budget, not one per write');
  assert.equal(started.length, 1, 'once the budget is spent no further readback starts');
  const none = createPublicSignedCreates({ retainedSignedCreate: async () => null, readRetained: async () => assert.fail('no budget, no readback') }, { readbackBudgetMs: 0 });
  assert.deepEqual(await none(jobId, { status: 'x' }), { status: 'x' });
});

test('only the signed fields of an offered CREATE are read and kept', async () => {
  const offered = { ...projection(), status: 'confirmed', blockNumber: 7, extra: { seller: 'chosen' } };
  assert.deepEqual(signedCreateBytes(offered), projection());
  assert.deepEqual(Object.keys(signedCreateBytes({ ...projection(), ed25519_signature: '0x01' })).sort(), ['content', 'ed25519_signature', 'hash', 'signature']);
  assert.deepEqual(Object.keys(signedCreateBytes({ ...projection(), ed25519_signature: '' })).sort(), ['content', 'hash', 'signature'], 'an empty dual signature is not signature material');
  assert.equal(signedCreateBytes(null), undefined);
  const reader = stub(), chain = createBuyerChainReadback({ sourceCapability: transport.capability, reader });
  const read = await chain.readDeliverable(input({ signedProjection: offered }));
  assert.equal(read.status, 'present', JSON.stringify(read));
  assert.deepEqual(read.signedProjection, projection(), 'the kept bytes carry no unsigned field');
  assert.deepEqual(reader.calls.read[0].options.signedProjection, projection(), 'and only they are authenticated');
});

test('switch on: a native DEM delivery that can only verify through a seller journal is refused at startup, never kept silently', () => {
  const nativeDemDelivery = createNativeDemDeliveryCapability({ authority: 'TEST-unit-generic-native-delivery', submit: async () => assert.fail('no submit'), reconcile: async () => assert.fail('no reconcile'),
    read: async () => assert.fail('no journal read'), verifyReceipt: async () => assert.fail('no receipt') });
  assert.throws(() => createProtocolPurchases({ db: null, ops: null, coordinates: null, dacsProtocol: { nativeDemDelivery }, buyerChainReadback: true }),
    (error) => error instanceof BuyerChainReadbackUnsupported && error.code === 'buyer_chain_readback_unsupported' && /DACS_BUYER_CHAIN_READBACK=on/.test(error.message));
  assert.throws(() => createProtocolPurchases({ db: null, ops: null, coordinates: null, dacsProtocol: { nativeDemDelivery }, buyerChainReadback: false }),
    (error) => !(error instanceof BuyerChainReadbackUnsupported), 'off: today\'s configuration checks only');
});

test('the chain pointers a seller-free readback still needs', () => {
  const evidenceAddress = `dacs4:evidence:${jobId}`, paid = { paymentEvidence: { ref: {} }, agreement: { artifact: null } };
  const op = (protocol) => ({ terms: { protocol: { jobId } }, state: { protocol } });
  assert.deepEqual(missingChainPointers(op({})), [], 'nothing verified, nothing needed');
  assert.deepEqual(missingChainPointers(op({ delivery: { status: 'delivery-ready' } })), [address]);
  assert.deepEqual(missingChainPointers(op({ delivery: { evidenceRef: { anchor: { locator: evidenceAddress } } } })), [address, evidenceAddress]);
  assert.deepEqual(missingChainPointers(op({ delivery: { evidenceRef: { anchor: { locator: evidenceAddress } } }, chainReadback: { [address]: {}, [evidenceAddress]: {} } })), []);
  // an earlier review: no placeholder that no pointer could ever satisfy (it held the key and the asks open for good).
  assert.deepEqual(missingChainPointers(op(paid)), [], 'an unreadable Agreement names no payment evidence address, so nothing can be missing there');
  assert.deepEqual(missingChainPointers(op({ delivery: { evidenceRef: { anchor: {} } } })), [address, evidenceAddress], 'the evidence pointer is the canonical address, whatever the reference says');
});

test('an earlier review: a fresh seller answer\'s delivery pointer is compared with the verified delivery, field by field', () => {
  const receipt = { receiptVersion: '1', substrate: 'demos', finalityProfile: 'x', logicalAddress: address, nativeAddress, contentHash: contentHash(report), writer: seller.claim, nonce: '7',
    state: 'finalized', observationDisposition: 'established', transactionRef: { kind: 'demos', value: txHash }, blockRef: { number: 3 }, observedAt: 1 };
  const verified = { status: 'delivery-ready', fulfilmentId: 'fulfilment-1', deliverableRef: { anchor: { kind: 'storage-program', locator: address }, contentHash: contentHash(report) },
    anchorReceipt: receipt, payloadHash: contentHash(report), evidenceHash: HEX('evidence'), substrate: 'source-native-one-node-delivery', report };
  const answer = (delivery = {}, over = {}) => ({ settlementId: report.settlementId, delivery: { status: 'delivered', logicalAddress: address, contentHash: contentHash(report), fulfilmentId: 'fulfilment-1',
    evidenceHash: HEX('evidence'), anchorReceipt: { ...receipt, observedAt: 2 }, ...delivery }, ...over });
  assert.equal(deliveryPointerDiffers(verified, answer()), null, 'the same pointer (a new observation time and a promoted status are not part of it)');
  assert.equal(deliveryPointerDiffers(verified, answer(), { evidence: true }), null);
  for (const [name, value, field] of [['address', answer({ logicalAddress: `dacs4:deliverable:${generateCanonicalJobId()}` }), 'Deliverable address'], ['payload', answer({ contentHash: HEX('other') }), 'Deliverable payload hash'],
    ['fulfilment', answer({ fulfilmentId: 'fulfilment-2' }), 'fulfilment'], ['settlement', answer({}, { settlementId: `demos:${HEX('other')}` }), 'settlement'],
    ['receipt', answer({ anchorReceipt: { ...receipt, nonce: '8' } }), 'Deliverable receipt'], ['no pointer', { settlementId: report.settlementId }, 'delivery pointer']]) assert.equal(deliveryPointerDiffers(verified, value), field, name);
  assert.equal(deliveryPointerDiffers(verified, answer({ evidenceHash: HEX('other evidence') })), null, 'the evidence hash only when asked');
  assert.equal(deliveryPointerDiffers(verified, answer({ evidenceHash: HEX('other evidence') }), { evidence: true }), 'delivery evidence hash');
  assert.equal(deliveryPointerDiffers({ ...verified, anchorReceipt: undefined }, answer()), 'Deliverable receipt', 'no verified receipt: never the same');
});

test('identity capture: values every run shares stay literal; only run-random ones become tokens', () => {
  const chain = (n) => HEX(`chain-identity-${n}`), random = () => createHash('sha256').update(String(Math.random())).digest('hex');
  // a an earlier review: two trees with different stable chain identities must not normalise the same.
  const tree = (identity) => JSON.stringify(normalizeRuns([{ chainIdentity: identity, key: random() }, { chainIdentity: identity, key: random() }]));
  assert.notEqual(tree(chain(1)), tree(chain(2)));
  assert.deepEqual(JSON.parse(tree(chain(1))), { chainIdentity: chain(1), key: '<hex#1>' });
  // Relations between run-random values are kept; prefixes do not hide a stable key.
  const r = random(), s = random();
  assert.deepEqual(normalizeRuns([{ a: `did:demos:agent:${r}`, b: `0x${r}`, c: `0x${chain(3)}` }, { a: `did:demos:agent:${s}`, b: `0x${s}`, c: `0x${chain(3)}` }]),
    { a: 'did:demos:agent:<hex#1>', b: '0x<hex#1>', c: `0x${chain(3)}` });
  // Ports and per-request nonces are always replaced (a port can be reused by chance).
  assert.deepEqual(normalizeRuns([{ url: 'http://127.0.0.1:4000/x', nonce: 'n-1' }, { url: 'http://127.0.0.1:4000/x', nonce: 'n-1' }]), { url: 'http://127.0.0.1:<port#1>/x', nonce: '<nonce#1>' });
  assert.throws(() => normalizeRuns([{ chainIdentity: chain(1) }]), /two or more independent runs/);
});

test('the seller HTTP handler adds the pointers when it sends a successful answer, and only then', async (t) => {
  const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, '127.0.0.1', () => resolve(server)); });
  const agent = { claim: seller.claim, listingPin: pin,
    commit: async ({ jobId: job }) => { if (job === 'refuse') throw new SellerAgentError('not_agreed', 'TEST refusal', 409); return { status: 'committed', address: `dacs3:commit:${job}` }; },
    submitPayment: async ({ jobId: job }) => ({ status: 'accepted', settlementId: `demos:${job}` }), agreementState: async () => ({ status: 'agreed', jobId }) };
  const calls = [], pointers = async (job, answer) => { calls.push(job); if (job === 'lookup-fails') throw new Error('TEST seller journal deleted');
    return { ...answer, [PUBLIC_SIGNED_CREATES]: { [job]: { hash: HEX(job), ...(job === 'huge' ? { padding: 'x'.repeat(SELLER_TRANSPORT_MAX_RESPONSE) } : {}) } } }; };
  const post = async (server, body, path = '/dacs/v1/commitments') => { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const on = await listen(createSellerHttpHandler(agent, { publicSignedCreates: pointers })), off = await listen(createSellerHttpHandler(agent));
  t.after(() => { on.close(); off.close(); });
  const sent = await post(on, { jobId });
  assert.equal(sent.status, 200); assert.deepEqual(sent.body[PUBLIC_SIGNED_CREATES], { [jobId]: { hash: HEX(jobId) } });
  assert.deepEqual(await post(on, { jobId: 'lookup-fails' }), { status: 200, body: { status: 'committed', address: 'dacs3:commit:lookup-fails' } }, 'a failed lookup sends the answer unchanged');
  assert.deepEqual(await post(on, { jobId: 'huge' }), { status: 200, body: { status: 'committed', address: 'dacs3:commit:huge' } }, 'pointers that would make the answer too large are left out');
  const refused = await post(on, { jobId: 'refuse' });
  assert.equal(refused.status, 409); assert.equal(refused.body[PUBLIC_SIGNED_CREATES], undefined);
  assert.deepEqual(calls, [jobId, 'lookup-fails', 'huge'], 'refusals are never decorated');
  // an earlier review (code P3-3): only commit and payment answers carry pointers; no other route runs the pointer lookup.
  const paid = await post(on, { jobId: 'paid' }, '/dacs/v1/payments');
  assert.deepEqual(paid.body[PUBLIC_SIGNED_CREATES], { paid: { hash: HEX('paid') } });
  assert.deepEqual(await post(on, { jobId, transportIdentity: {} }, '/dacs/v1/agreements/state'), { status: 200, body: { status: 'agreed', jobId } }, 'a state answer is sent as it is');
  assert.deepEqual(calls, [jobId, 'lookup-fails', 'huge', 'paid'], 'the state route never ran the pointer lookup');
  assert.deepEqual(await post(off, { jobId }), { status: 200, body: { status: 'committed', address: `dacs3:commit:${jobId}` } }, 'without the option the answer is unchanged');
  assert.throws(() => createSellerHttpHandler(agent, { publicSignedCreates: {} }), /publicSignedCreates/);
});
