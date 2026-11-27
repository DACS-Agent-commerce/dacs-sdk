// The seller's three chain readers: readCommitmentReceipt, sessionAdmission's six reads and observePayment. Most rows build them over
// a scripted finalized session (anchor, transport, binding, identity read and clock); the port rows use the production wallet-session
// port over the client's scripted TP-1 node, and the revocation rows the live SR-2 adapter over the seller wallet's real source.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, finalization, jsonResponse, ok, privateDataDirectory, T0 } from './helpers/seller-node-wallet-world.mjs';
import { canonicalize, compositeVerificationAddress, contentHash, encodeAddressSegment, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';

const { walletSessionWorld, LISTING_PIN } = await import('./helpers/seller-wallet-session-world.mjs');
const { enrolled, enrollment, TP1_PROFILE } = await import('./helpers/kit-wallet-session.mjs');
const { buyer, seller, NOW, protocolFixture } = await import('./helpers/protocol-fixture.mjs');
const { readbackFixture } = await import('./helpers/sr2-readback-fixture.mjs');
const { productionObserveIdentity, registeredSource, resign, sellerWalletWorld } = await import('./helpers/sr2-live-fixture.mjs');
const { confirmedNativeTransferNode } = await import('./helpers/confirmed-native-transfer-fixture.mjs');
const { createNodeChainReaders, createReadOnlyDemosSr2Journal } = await import('../src/devnet-demo/node-chain-readers.mjs');
const { createDemosSr2Adapter } = await import('../src/dacs/demos-sr2-adapter.mjs');
const { agreementTerms } = await import('../src/dacs/purchase-protocol.mjs');
const { isBoundedCallTimeout } = await import('../src/dacs/bounded-call.mjs');
const { createSellerWalletSession } = await import('../src/devnet-demo/seller-wallet-session.mjs');
const { REPLY_LIMIT_CODE, SELLER_PROFILE, sessionAdmissionConfig, sessionAdmissionProblem } = await import('../src/dacs/session-admission.mjs');
const { markerWorld } = await import('./helpers/revocation-marker-world.mjs');
const { sellerRecordsPurchaseResolver } = await import('../src/devnet-demo/seller-purchase-source.mjs');
const { composeSellerApproval, createExactOperatorApproval } = await import('../src/devnet-demo/operator-approval.mjs');
const { artifactAuthority, confirmationFor, deliveredHashFor, requestFor, sourceBinding } = await import('./helpers/d5-policy-fixtures.mjs');
const { commitmentReceiptTime } = await import('../../../dist/wire/commitment.js');

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const JOB = '01M5YKPJG0248H248H248H248A';
const ADMISSION_METHODS = ['admit', 'resolveVetRecord', 'readVetAnchorReceipt', 'verifyVetAnchorReceipt', 'readRevocationSurfaces', 'readRevocationMarker'];
const refusalOf = (promise) => promise.then((value) => assert.fail(`expected a refusal, got ${JSON.stringify(value)}`), (error) => error);
const flush = async () => { for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve)); };

// The purchase: the protocol fixture's signed Agreement, a commitment time and one retained payment transfer.
const fx = await protocolFixture();
const TERMS = agreementTerms(fx.agreement), AGREEMENT_HASH = contentHash(fx.agreement);
const TX = 'ab'.repeat(32), BLOCK = 77, COMMITTED_AT = NOW - 60_000;
const unpaidSession = (patch = {}) => ({ jobId: fx.agreement.jobId, agreement: fx.agreement, agreementHash: AGREEMENT_HASH, buyerBundle: fx.buyerBundle,
  commitment: { committedAt: COMMITTED_AT }, settlementBound: false, ...patch });
const paidSession = (patch = {}, settlementIdentity = { txHash: TX, blockNumber: BLOCK }) => unpaidSession({ nativeEvidenceWork: { txHash: TX, intake: { settlementIdentity } }, ...patch });
const transfer = (patch = {}) => ({ status: 'included', execution: 'executed', txHash: TX, payer: buyer.address, payee: TERMS.payee, amountOs: TERMS.price.amountOs,
  blockNumber: BLOCK, includedAt: NOW, ...patch });
const paymentQuery = (observedAt = NOW - 5) => ({ jobId: fx.agreement.jobId, agreementHash: AGREEMENT_HASH, agreement: fx.agreement, observedAt, fresh: true });
const demString = (os) => `${os / 1_000_000_000n}${os % 1_000_000_000n ? `.${(os % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')}` : ''}`;
const LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 1024 });
const admitQuery = (patch = {}) => ({ jobId: JOB, buyer: buyer.claim, buyerBundleHash: 'd'.repeat(64), sessionNonce: 'TEST-nonce', seller: seller.claim,
  listingPin: LISTING_PIN, profile: structuredClone(SELLER_PROFILE), ...patch });

// A seller-owned Vet record at the job's composite address for the buyer, with its finalized receipt.
const VET_LOCATOR = compositeVerificationAddress(JOB, buyer.claim);
const VET_RECORD = { TEST: 'vet record', jobId: JOB, signature: { algorithm: 'ed25519', signer: seller.claim, value: 'TEST' } };
const VET_REF = { anchor: { kind: 'storage-program', locator: VET_LOCATOR }, contentHash: contentHash(VET_RECORD), signer: seller.claim };
const VET_RECEIPT = { logicalAddress: VET_LOCATOR, contentHash: VET_REF.contentHash, state: 'finalized', writer: seller.claim };
const vetQuery = (patch = {}) => ({ jobId: JOB, role: 'buyer', party: buyer.claim, ref: VET_REF, ...patch });
const presentVet = () => ({ status: 'present', artifact: structuredClone(VET_RECORD), receipt: structuredClone(VET_RECEIPT) });
const ANCHORED = { record: { TEST: 'commitment' }, anchorReceipt: { logicalAddress: `dacs3:commitment:${JOB}`, TEST: 'receipt' } };

// A scripted finalized session. `world.calls` lists each anchor, transfer and identity read with its input; the anchor answers
// `verdict` and `retained`, the transfer read `observation` (a function of the hash when one), the identity read `identity`.
function scriptedChain() {
  const world = { calls: [], verdict: 'valid', retained: presentVet(), observation: transfer(), identity: CHAIN, session: paidSession(), source: enrollment() };
  const answer = (value, ...args) => { if (value instanceof Error) throw value; return typeof value === 'function' ? value(...args) : structuredClone(value); };
  const record = (name, input) => world.calls.push([name, input === undefined ? undefined : structuredClone(input)]);
  world.bound = Object.freeze({
    anchor: { verifyReceipt: async (input) => { record('verifyReceipt', input); return answer(world.verdict); },
      readRetained: async (input, ...rest) => { record('readRetained', { input, rest }); return answer(world.retained); } },
    transport: { pins: { endpoint: 'https://rpc.example.invalid/' }, chainReader: () => ({ observeTransfer: async (hash, options) => { record('observeTransfer', hash); world.signal = options?.signal; return answer(world.observation, hash); } }) },
    binding: { profile: { ...TP1_PROFILE } },
    observeIdentity: async () => { record('observeIdentity'); return answer(world.identity); },
    clock: { now: () => NOW },
  });
  world.chain = () => world.bound;
  world.readers = (inputs = {}) => createNodeChainReaders({ claim: () => seller.claim, chain: () => world.chain(), participantImplementations: world.source,
    sessionOf: (jobId) => (jobId === fx.agreement.jobId ? answer(world.session) : null), ...inputs });
  world.count = (name) => world.calls.filter(([read]) => read === name).length;
  return world;
}
const everyRead = (readers) => [() => readers.readCommitmentReceipt(ANCHORED, CHAIN), ...ADMISSION_METHODS.map((name) => () => readers.sessionAdmission[name](admitQuery(), LIMITS)),
  () => readers.observePayment(paymentQuery(), LIMITS)];

// The production port over the client's scripted node, finalized by the host's stages; `options` are added to the port's options.
async function finalizedPort(t, options = {}) {
  const world = await walletSessionWorld(t, { options });
  world.session = (await world.finalize()).session;
  return world;
}
// The node answers the reads of one confirmed native transfer, leaving the identity reads (block 0) to the scripted node.
const transferNode = (transferFacts) => (row) => {
  const call = row.body?.params[0], answers = confirmedNativeTransferNode(transferFacts);
  if (!answers[call?.message] || (call.message === 'getBlockByNumber' && call.data?.blockNumber !== transferFacts.blockNumber)) return undefined;
  return answers[call.message]().then(jsonResponse);
};
const NODE_TRANSFER = { txHash: TX, payer: buyer.address, payee: TERMS.payee, amountOs: TERMS.price.amountOs, blockNumber: BLOCK, includedAt: NOW / 1000 };

const UNAVAILABLE = (readFailureReason) => [{ kind: 'catalog', status: 'active', readStatus: 'unavailable', readFailureReason }];

test('the three chain readers reject wallet_session_not_finalized before finalize and wallet_session_closed after close with no read made, and a reader built without a chain thunk rejects reader_input_missing', async (t) => {
  const world = await walletSessionWorld(t, { options: { participantImplementations: enrollment(), sessionOf: () => paidSession() } });
  const reads = world.node.calls.length;
  for (const read of everyRead(world.port)) assert.equal((await refusalOf(read())).code, 'wallet_session_not_finalized');
  await world.port.close();
  for (const read of everyRead(world.port)) assert.equal((await refusalOf(read())).code, 'wallet_session_closed');
  assert.equal(world.node.calls.length, reads, 'no node read');
  const unbound = createNodeChainReaders({ claim: () => seller.claim, participantImplementations: enrollment(), sessionOf: () => paidSession() });
  for (const read of everyRead(unbound)) assert.match((await refusalOf(read())).message, /chain/, 'names chain');
  for (const read of everyRead(unbound)) assert.equal((await refusalOf(read())).code, 'reader_input_missing');
});

test('a production-style port built with a stable enrollment wrapper and a `sessionOf` stand-in shaped like `durableSessionOf` (returns a view, null, or throws `seller_state_unverified`) reads the newly bound enrollment on the next call; an unbound wrapper fails closed and either omitted option rejects reader_input_missing on its dependent reader', async (t) => {
  let source = null, view = () => unpaidSession();
  const wrapper = { entriesFor: (claim, options) => { if (source === null) throw Object.assign(new Error('TEST enrollment source not bound'), { code: 'TEST_unbound' }); return source.entriesFor(claim, options); } };
  const world = await finalizedPort(t, { participantImplementations: wrapper, sessionOf: () => view() });
  const query = admitQuery({ seller: world.signer.claim });
  assert.equal((await refusalOf(world.port.sessionAdmission.admit(query, LIMITS))).code, 'TEST_unbound', 'an unbound wrapper fails closed');
  source = enrollment();
  assert.equal((await world.port.sessionAdmission.admit(query, LIMITS)).disposition, 'admitted', 'the newly bound enrollment is read');
  source = enrollment([]);
  assert.deepEqual(await world.port.sessionAdmission.admit(query, LIMITS), { disposition: 'not-admitted' }, 'and read again on the next call');
  assert.equal((await world.port.observePayment(paymentQuery(T0 - 5), LIMITS)).disposition, 'absent', 'a view with no payment, on the bound chain');
  view = () => null;
  assert.equal((await refusalOf(world.port.observePayment(paymentQuery(T0 - 5), LIMITS))).code, 'payment_unverified', 'no session');
  view = () => { throw Object.assign(new Error('TEST unverified'), { code: 'seller_state_unverified' }); };
  assert.equal((await refusalOf(world.port.observePayment(paymentQuery(T0 - 5), LIMITS))).cause.code, 'seller_state_unverified');
  for (const [omitted, read] of [['participantImplementations', (port) => port.sessionAdmission.admit(query, LIMITS)], ['sessionOf', (port) => port.observePayment(paymentQuery(T0 - 5), LIMITS)]]) {
    const partial = await finalizedPort(t, { participantImplementations: wrapper, sessionOf: () => view(), [omitted]: undefined });
    const refused = await refusalOf(read(partial.port));
    assert.equal(refused.code, 'reader_input_missing', omitted);
    assert.match(refused.message, new RegExp(omitted));
  }
});

test('a chain read waits behind a held connection fence inside its deadline and then refuses, while connectionAuthority answers with no fence taken', async (t) => {
  const world = await finalizedPort(t, { participantImplementations: enrollment(), sessionOf: () => paidSession() });
  world.node.reply = transferNode(NODE_TRANSFER);
  const lease = await world.session.acquireConnectionFence();
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let settled = false;
  const waiting = refusalOf(world.port.observePayment(paymentQuery(T0 - 5), { ...LIMITS, timeoutMs: 1000 })).finally(() => { settled = true; });
  await flush();
  assert.equal(settled, false, 'the read waits for the fence');
  assert.equal((await world.port.connectionAuthority({ local: world.stages.local(), sessionId: null, participants: [] })).chainIdentity, CHAIN, 'the connection reader takes no fence');
  mock.timers.tick(1000);
  const refused = await waiting;
  assert.equal(refused.code, 'payment_unverified');
  assert.ok(isBoundedCallTimeout(refused.cause), 'its cause is the deadline');
  mock.timers.reset();
  lease.release();
});

test('an after-payment write approved by the policy calls the port\'s real observePayment from stillAuthorizedToSign and the confirmation approval while its own signature lease holds the connection fence; an executed matching transfer answers verified before the deadline and no second fence is acquired', async (t) => {
  const SOURCE = { ...sourceBinding }, listingPin = { listingId: fx.agreement.listingRef.listingId, version: fx.agreement.listingRef.version, contentHash: fx.agreement.listingRef.contentHash };
  const sessionOf = () => paidSession({ agreementSignedProjection: { content: { network: SOURCE.network, chainIdentity: SOURCE.chainIdentity, data: ['storageProgram', { metadata: { networkBinding: SOURCE } }] } } });
  const world = await finalizedPort(t, { participantImplementations: enrollment(), sessionOf });
  world.node.reply = transferNode(NODE_TRANSFER);
  const resolvePurchase = sellerRecordsPurchaseResolver({ sessionOf, buyerAccess: () => ({ allowsWallet: () => true }), now: () => T0, observePayment: world.port.observePayment });
  const policy = { address: seller.address, seller: seller.claim, sourceBinding: SOURCE, artifactAuthority, listingPin: () => listingPin, resolvePurchase, paymentPhaseIndex: () => 2, deliveryPhaseIndex: () => 3, deliveredPayloadHash: deliveredHashFor };
  const approval = createExactOperatorApproval({ maxTotalOs: '50000000000', evidencePath: join(privateDataDirectory(t), 'approvals.jsonl'), now: () => T0,
    sellerApproval: { mode: 'policy', maxWriteTotalOs: '4000000000' }, policy });
  t.after(() => approval.stop());
  const retained = composeSellerApproval({ mode: 'policy', policy: approval, manual: () => assert.fail('the operator was asked') }).retained;
  const payment = requestFor({ artifactKind: 'SettlementEvidence', phase: 'pay-dem', job: fx.agreement.jobId, walletAddress: seller.address, writer: seller.claim, sourceBinding: SOURCE,
    artifact: { signature: { algorithm: 'ed25519', signer: seller.claim, value: 'A'.repeat(86) }, paymentTxRefs: [{ kind: 'demos', txHash: TX, blockNumber: BLOCK }], paymentAmount: { amount: demString(BigInt(TERMS.price.amountOs)), currency: 'DEM' } } });
  // A read that waits for the pass's own fence would wait for its 10 s deadline; the pass must finish well inside it.
  const withinPass = (work) => Promise.race([work, new Promise((_, fail) => setTimeout(() => fail(new Error('a second connection fence is waited for')), 3000).unref())]);
  const lease = await world.session.acquireConnectionFence();
  try {
    const handle = world.session.effectPass({ fence: lease, deadline: T0 + 5_000, refreshAuthority() {}, finalStop() {}, synchronousChecks: [], feeCeilingOs: finalization.feeCeilingOs,
      context: api.passContext({ operationClass: 'payment-evidence', currentAuthorization: () => true }) });
    // The signing check (stillAuthorizedToSign at the end of the sign gate), then the confirmation approval's own stillAuthorizedToSign.
    const prepared = await withinPass(world.session.runInEffectPass(handle, () => retained.prepare(payment)));
    assert.equal(typeof prepared.ledgerId, 'string', 'the policy authorized the signature: a verified matching transfer left no refusal');
    const observed = () => world.node.reads.filter((read) => read === 'getTxByHash').length, afterSigning = observed();
    assert.ok(afterSigning >= 2, 'the approval decision and the signing check each observed the transfer');
    const binding = { ledgerId: prepared.ledgerId, requestText: prepared.requestText, ...(prepared.token ? { token: prepared.token } : {}) };
    assert.equal(await withinPass(world.session.runInEffectPass(handle, () => retained.confirm(binding, confirmationFor(payment, { executed: true })))), true, 'the confirmation approval was accepted');
    assert.ok(observed() > afterSigning, 'the confirmation approval observed the transfer again');
  } finally { lease.release(); }
});

test('a second call reads again: nothing is cached across calls, and a restarted port reads from its own new session', async () => {
  const world = scriptedChain(), readers = world.readers();
  for (let call = 0; call < 2; call++) {
    await readers.readCommitmentReceipt(ANCHORED, CHAIN);
    await readers.sessionAdmission.admit(admitQuery(), LIMITS);
    await readers.sessionAdmission.resolveVetRecord(vetQuery(), LIMITS);
    await readers.observePayment(paymentQuery(), LIMITS);
  }
  assert.deepEqual([world.count('verifyReceipt'), world.source.reads, world.count('readRetained'), world.count('observeTransfer')], [2, 2, 2, 2]);
  const restarted = scriptedChain();
  restarted.verdict = 'invalid';
  world.chain = restarted.chain;
  assert.equal(await readers.readCommitmentReceipt(ANCHORED, CHAIN), 'invalid', 'the next call reads the session chain() gives now');
  assert.deepEqual([world.count('verifyReceipt'), restarted.count('verifyReceipt')], [2, 1]);
});

test('readCommitmentReceipt carries an own data chainIdentity equal to the approved record\'s, and the wire accepts it while another reader\'s chain is refused commitment_reader_chain_mismatch', async (t) => {
  const { readCommitmentReceipt } = scriptedChain().readers();
  assert.deepEqual(Object.getOwnPropertyDescriptor(readCommitmentReceipt, 'chainIdentity'), { value: CHAIN, writable: false, enumerable: true, configurable: false });
  const { admission } = await sellerWalletWorld(t);
  const other = Object.assign(async () => 'valid', { chainIdentity: 'c'.repeat(64) });
  const codeWith = async (reader) => (await refusalOf(commitmentReceiptTime({}, null, null, reader, { binding: admission.binding }))).code;
  assert.notEqual(await codeWith(readCommitmentReceipt), 'commitment_reader_chain_mismatch', 'the reader passes the chain check');
  assert.equal(await codeWith(other), 'commitment_reader_chain_mismatch');
});

test('an anchor verdict valid answers valid through a fresh verifyReceipt call that names the FinalityCommitmentRecord, its logical address and its receipt', async () => {
  const world = scriptedChain();
  assert.equal(await world.readers().readCommitmentReceipt(ANCHORED, CHAIN), 'valid');
  assert.deepEqual(world.calls, [['verifyReceipt', { logicalAddress: ANCHORED.anchorReceipt.logicalAddress, artifact: ANCHORED.record, artifactKind: 'FinalityCommitmentRecord',
    receipt: ANCHORED.anchorReceipt, fresh: true }]]);
});

test('invalid and indeterminate pass through, any other verdict answers indeterminate, no retained CREATE answers indeterminate after authorizeJob, and a thrown anchor read keeps its cause and is never valid', async () => {
  const world = scriptedChain(), readers = world.readers();
  for (const [verdict, expected] of [['invalid', 'invalid'], ['indeterminate', 'indeterminate'], ['error', 'indeterminate'], [undefined, 'indeterminate'], [true, 'indeterminate']]) {
    world.verdict = verdict;
    assert.equal(await readers.readCommitmentReceipt(ANCHORED, CHAIN), expected, String(verdict));
  }
  // An anchor without a retained CREATE checks the job's access, then answers indeterminate.
  const authorized = [];
  world.verdict = (() => { authorized.push(JOB); return 'indeterminate'; });
  assert.equal(await readers.readCommitmentReceipt(ANCHORED, CHAIN), 'indeterminate');
  assert.deepEqual(authorized, [JOB]);
  const failure = Object.assign(new Error('TEST buyer access closed'), { code: 'TEST_access_closed' });
  world.verdict = failure;
  assert.equal(await refusalOf(readers.readCommitmentReceipt(ANCHORED, CHAIN)), failure);
});

test('sessionAdmission has exactly the six methods, is frozen, and sessionAdmissionConfig accepts it', () => {
  const { sessionAdmission } = scriptedChain().readers();
  assert.deepEqual(Object.keys(sessionAdmission).sort(), [...ADMISSION_METHODS].sort());
  assert.ok(Object.isFrozen(sessionAdmission));
  assert.equal(sessionAdmissionConfig(sessionAdmission), sessionAdmission);
});

test('admit answers for an enrolled buyer an answer sessionAdmissionProblem accepts, with both participants on SELLER_PROFILE', async () => {
  const query = admitQuery(), answer = await scriptedChain().readers().sessionAdmission.admit(query, LIMITS);
  assert.equal(sessionAdmissionProblem(answer, query), null);
  assert.deepEqual(answer.participants.map(({ role, claim, standardRevision, documentVersions }) => [role, claim, standardRevision, canonicalize(documentVersions)]),
    [['buyer', buyer.claim, SELLER_PROFILE.standardRevision, canonicalize(SELLER_PROFILE.documentVersions)], ['seller', seller.claim, SELLER_PROFILE.standardRevision, canonicalize(SELLER_PROFILE.documentVersions)]]);
});

test('admit answers not-admitted for no enrollment, two enrollments, a revoked or evidence-less one, another profile id, base, revision, chain identity or pin version, another tuple, another seller or another profile in the query', async () => {
  const profile = (patch) => ({ profile: { ...TP1_PROFILE, ...patch } });
  const entries = { none: [], two: [enrolled(buyer.claim), enrolled(buyer.claim)], revoked: [enrolled(buyer.claim, { revoked: true })], 'no evidence': [enrolled(buyer.claim, { evidence: '' })],
    ...Object.fromEntries(['id', 'base', 'revision', 'chainIdentity', 'pinVersion'].map((member) => [member, [enrolled(buyer.claim, profile({ [member]: 'TEST-other' }))]])),
    tuple: [enrolled(buyer.claim, { modules: { ...enrolled(buyer.claim).modules, TEST: 'other' } })] };
  const world = scriptedChain(), readers = world.readers();
  for (const [name, list] of Object.entries(entries)) {
    world.source.entries.set(buyer.claim, list);
    assert.deepEqual(await readers.sessionAdmission.admit(admitQuery(), LIMITS), { disposition: 'not-admitted' }, name);
  }
  world.source.entries.set(buyer.claim, [enrolled(buyer.claim)]);
  for (const [name, patch] of [['seller', { seller: buyer.claim }], ['profile', { profile: { ...SELLER_PROFILE, standardRevision: 'TEST-other' } }]]) {
    assert.deepEqual(await readers.sessionAdmission.admit(admitQuery(patch), LIMITS), { disposition: 'not-admitted' }, name);
  }
});

test('admit reads the enrollment source on every call and rejects with the source\'s own error when it throws or is missing; malformed participantImplementations and sessionOf port options are rejected by checkOptions', async () => {
  const world = scriptedChain(), readers = world.readers();
  await readers.sessionAdmission.admit(admitQuery(), LIMITS);
  world.source.entries.set(buyer.claim, [enrolled(buyer.claim, { revoked: true })]);
  assert.deepEqual(await readers.sessionAdmission.admit(admitQuery(), LIMITS), { disposition: 'not-admitted' }, 'a revocation between calls is read');
  assert.equal(world.source.reads, 2);
  const failure = new Error('TEST enrollment source down');
  assert.equal(await refusalOf(world.readers({ participantImplementations: { entriesFor: () => { throw failure; } } }).sessionAdmission.admit(admitQuery(), LIMITS)), failure);
  const missing = await refusalOf(world.readers({ participantImplementations: undefined }).sessionAdmission.admit(admitQuery(), LIMITS));
  assert.deepEqual([missing.code, /participantImplementations/.test(missing.message)], ['reader_input_missing', true]);
  const { portOptions } = await import('./helpers/seller-wallet-session-world.mjs');
  const valid = await portOptions({ fetch: () => assert.fail('no node read') }, async () => assert.fail('no key load'));
  for (const [name, value] of [['participantImplementations', {}], ['participantImplementations', null], ['participantImplementations', { entriesFor: 'x' }], ['sessionOf', {}], ['sessionOf', null]]) {
    assert.throws(() => createSellerWalletSession({ ...valid, [name]: value }), (error) => error instanceof TypeError && error.message.includes(name), name);
  }
});

test('a source-structure assertion reads `authority-reader.mjs` and `node-chain-readers.mjs`: the exported `currentEnrollment` is the sole enrollment selector, `createSellerAuthorityReader`\'s participant path calls it, and `sessionAdmission.admit` imports and calls that export. Neither caller defines a private enrollment selector or directly calls `entriesFor`. Reintroducing the Base `enrolledImplementation` in the staged reader or copying its rule into `admit` fails this test even when rows 22 and 37 still return the same answers.', () => {
  // The module's code without its comment lines.
  const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\/\*\*|\*)/.test(line)).join('\n');
  const reader = source('dacs/authority-reader.mjs'), chainReaders = source('devnet-demo/node-chain-readers.mjs');
  const selector = /export async function currentEnrollment\(participantImplementations, peer, \{ sessionId, signal \} = \{\}\) \{([\s\S]*?)\n\}/.exec(reader);
  assert.ok(selector, 'currentEnrollment is exported');
  assert.equal(reader.match(/\.entriesFor\(/g).length, 1, 'one entriesFor read in the seller reader');
  assert.match(selector[1], /\.entriesFor\(/, 'and it is inside currentEnrollment');
  assert.match(/async function readParticipantEvidence[\s\S]*?\n {2}\}/.exec(reader)[0], /currentEnrollment\(participantImplementations, peer/);
  assert.match(chainReaders, /import \{ currentEnrollment \} from '\.\.\/dacs\/authority-reader\.mjs';/);
  assert.match(chainReaders, /await currentEnrollment\(participantImplementations, query\.buyer/);
  for (const text of [reader, chainReaders]) assert.doesNotMatch(text, /enrolledImplementation|revoked !== false[\s\S]*revoked !== false/);
  assert.doesNotMatch(chainReaders, /\.entriesFor\(|\.revoked\b|\.evidence\b/, 'admit copies no part of the rule');
});

test('resolveVetRecord uses the bound anchor\'s fresh passive retained read for the seller-owned CompositeVerificationRecord, with `claim()` as CREATE writer and the role\'s Vet verifier; it answers the record its reference names and refuses a missing retained CREATE, wrong locator, wrong verifier, changed hash or another endpoint\'s binding', async () => {
  const world = scriptedChain(), resolve = (query) => world.readers().sessionAdmission.resolveVetRecord(query, LIMITS);
  assert.deepEqual(await resolve(vetQuery()), VET_RECORD);
  assert.deepEqual(world.calls, [['readRetained', { input: { logicalAddress: VET_LOCATOR, artifactKind: 'CompositeVerificationRecord', fresh: true }, rest: [] }]], 'one passive read, no resend');
  const refusals = {
    'missing retained CREATE': [vetQuery(), { status: 'absent', reason: 'no seller-owned demo CREATE intent' }],
    'another endpoint binding': [vetQuery(), { status: 'rejected', reason: 'TEST another endpoint binding' }],
    'wrong verifier': [vetQuery({ ref: { ...VET_REF, signer: buyer.claim } }), presentVet()],
    'changed hash': [vetQuery({ ref: { ...VET_REF, contentHash: 'e'.repeat(64) } }), presentVet()],
  };
  for (const [name, [query, retained]] of Object.entries(refusals)) {
    world.retained = retained;
    assert.equal((await refusalOf(resolve(query))).code, 'vet_record_unverified', name);
  }
  const reads = world.count('readRetained');
  assert.equal((await refusalOf(resolve(vetQuery({ party: seller.claim })))).code, 'vet_record_unverified', 'wrong locator');
  assert.equal(world.count('readRetained'), reads, 'a wrong locator is refused before any read');
});

test('the internal `createReadOnlyDemosSr2Journal` helper returns a frozen wrapper: `put` rejects and mutating a returned `get` or `records` clone changes no stored entry. One successful and one refused SR-2 adapter read over that wrapper leave its `records()` count and contents unchanged. A narrow source-structure assertion confirms `sessionAdmission` passes the helper\'s result to `createDemosSr2Adapter`, never the writable memory object; restoring a writable `put` or a direct memory pass fails.', async (t) => {
  const journal = createReadOnlyDemosSr2Journal();
  assert.ok(Object.isFrozen(journal));
  await assert.rejects(journal.put({ planId: 'TEST' }), /cannot write/);
  journal.records().push({ planId: 'TEST' });
  assert.deepEqual([journal.records(), journal.get('TEST')], [[], null]);
  const world = await markerWorld(t), source = registeredSource(world, { fixture: world.fixture });
  const adapter = createDemosSr2Adapter({ rpcUrl: source.pins.endpoint, journal, sourceCapability: source, binding: world.admission.binding, observeIdentity: productionObserveIdentity(world),
    ownWriter: seller.claim, now: () => NOW });
  assert.equal((await adapter.read(world.logicalAddress, { expectedWriter: seller.claim })).status, 'present');
  assert.ok(await refusalOf(adapter.read(`${world.logicalAddress}-TEST-other`, { expectedWriter: seller.claim })));
  assert.deepEqual(journal.records(), [], 'the reads wrote nothing');
  const text = readFileSync(new URL('../src/devnet-demo/node-chain-readers.mjs', import.meta.url), 'utf8');
  assert.match(text, /createDemosSr2Adapter\(\{ rpcUrl, journal: createReadOnlyDemosSr2Journal\(\),/);
  assert.match(text, /return Object\.freeze\(\{ \.\.\.memory, put: async \(\) => \{ throw new Error\('node chain reader cannot write'\); \} \}\);/);
  assert.equal(text.match(/createInMemoryDemosSr2Journal\(\)/g).length, 1, 'the writable memory journal is made once, inside the wrapper');
});

test('readVetAnchorReceipt makes a fresh passive bound-anchor read and answers its finalized receipt; absent, rejected or indeterminate readback refuses, and a receipt naming another locator, hash or endpoint binding is refused', async () => {
  const world = scriptedChain(), read = () => world.readers().sessionAdmission.readVetAnchorReceipt(vetQuery(), LIMITS);
  assert.deepEqual(await read(), VET_RECEIPT);
  assert.deepEqual(world.calls[0][1].input, { logicalAddress: VET_LOCATOR, artifactKind: 'CompositeVerificationRecord', fresh: true });
  const refused = [{ status: 'absent' }, { status: 'rejected', reason: 'TEST another endpoint binding' }, { status: 'indeterminate' }, null,
    { ...presentVet(), receipt: { ...VET_RECEIPT, logicalAddress: compositeVerificationAddress(JOB, seller.claim) } }, { ...presentVet(), receipt: { ...VET_RECEIPT, contentHash: 'e'.repeat(64) } },
    { ...presentVet(), receipt: { ...VET_RECEIPT, state: 'included' } }];
  for (const retained of refused) {
    world.retained = retained;
    assert.equal((await refusalOf(read())).code, 'vet_record_unverified', JSON.stringify(retained));
  }
  assert.equal(world.count('readRetained'), refused.length + 1, 'each call reads again');
});

test('verifyVetAnchorReceipt calls the bound anchor\'s fresh verifyReceipt for the exact record, role-specific verifier and receipt; valid, invalid and indeterminate verdicts are preserved, and a missing or changed signed projection is never valid', async () => {
  const world = scriptedChain(), verify = (patch) => world.readers().sessionAdmission.verifyVetAnchorReceipt(vetQuery({ record: VET_RECORD, receipt: VET_RECEIPT, ...patch }), LIMITS);
  for (const verdict of ['valid', 'invalid', 'indeterminate']) {
    world.verdict = verdict;
    assert.equal(await verify(), verdict);
  }
  assert.deepEqual(world.calls[0], ['verifyReceipt', { logicalAddress: VET_LOCATOR, artifact: VET_RECORD, artifactKind: 'CompositeVerificationRecord', receipt: VET_RECEIPT,
    writer: seller.claim, verifier: seller.claim, fresh: true }]);
  // The anchor answers indeterminate without a signed projection and invalid for a changed one.
  for (const [verdict, expected] of [['indeterminate', 'indeterminate'], ['invalid', 'invalid'], ['TEST-other', 'indeterminate']]) {
    world.verdict = verdict;
    assert.equal(await verify(), expected);
  }
  const calls = world.count('verifyReceipt');
  world.verdict = 'valid';
  assert.equal(await verify({ record: { ...VET_RECORD, TEST: 'changed' } }), 'invalid', 'a record its reference does not name');
  assert.equal(await verify({ ref: { ...VET_REF, signer: buyer.claim } }), 'invalid', 'another verifier');
  assert.equal(world.count('verifyReceipt'), calls, 'neither reaches the anchor');
});

test('with a live-shaped native Vet object omitting `createdByTx` and `interactionTxs` and executed CREATE content omitting `network` and `chainIdentity`, all three Vet methods authenticate through the bound anchor\'s retained signed projection; the same read through an empty-journal adapter refuses, and a changed projection refuses', async (t) => {
  const world = await sellerWalletWorld(t), source = world.wallet.sourceCapability;
  const record = { ...VET_RECORD, TEST: 'live-shaped vet record' }, ref = { ...VET_REF, contentHash: contentHash(record) };
  const f = readbackFixture({ logicalAddress: VET_LOCATOR, artifact: record, metadata: { artifactKind: 'CompositeVerificationRecord', contentHash: contentHash(record) } });
  resign(f, (content) => { content.network = source.pins.network; content.chainIdentity = source.pins.chainIdentity; content.data[1].metadata.networkBinding = structuredClone(source.transportBinding); });
  const signedProjection = structuredClone(f.signed);
  delete f.native.createdByTx; delete f.native.interactionTxs;
  delete f.tx.content.network; delete f.tx.content.chainIdentity;
  const adapter = createDemosSr2Adapter({ rpcUrl: source.pins.endpoint, journal: createReadOnlyDemosSr2Journal(), sourceCapability: registeredSource(world, { fixture: f }),
    binding: world.admission.binding, observeIdentity: productionObserveIdentity(world), ownWriter: seller.claim, now: () => NOW });
  // The anchor's retained read and receipt check, which give the adapter the signed CREATE the anchor kept.
  let projection = signedProjection;
  const anchor = {
    readRetained: async ({ logicalAddress }) => ({ ...await adapter.read(logicalAddress, { expectedWriter: seller.claim, signedProjection: projection }), signedProjection: projection }),
    verifyReceipt: async ({ logicalAddress, artifact, artifactKind, receipt, writer }) => adapter.verifyReceipt({ receipt, logicalAddress, artifact, expectedWriter: writer, artifactKind, signedProjection: projection }),
  };
  const { sessionAdmission } = createNodeChainReaders({ claim: () => seller.claim, chain: () => ({ anchor }) });
  const query = vetQuery({ ref });
  assert.deepEqual(await sessionAdmission.resolveVetRecord(query, LIMITS), record);
  const read = await anchor.readRetained({ logicalAddress: VET_LOCATOR });
  // A live receipt is larger than the payment reading's limit; the agent bounds admission reads at 64 KiB.
  assert.deepEqual(await sessionAdmission.readVetAnchorReceipt(query, { ...LIMITS, maxBytes: 64 * 1024 }), read.receipt);
  assert.equal(read.receipt.state, 'finalized');
  assert.equal(await sessionAdmission.verifyVetAnchorReceipt({ ...query, record, receipt: read.receipt }, LIMITS), 'valid');
  assert.equal((await refusalOf(adapter.read(VET_LOCATOR, { expectedWriter: seller.claim }))).code, 'invalid', 'an empty-journal read has no projection');
  projection = { ...signedProjection, hash: sha256Hex('TEST changed projection') };
  assert.ok(await refusalOf(sessionAdmission.resolveVetRecord(query, LIMITS)), 'a changed projection refuses');
  assert.notEqual(await sessionAdmission.verifyVetAnchorReceipt({ ...query, record, receipt: read.receipt }, LIMITS), 'valid');
});

test('readRevocationSurfaces answers exactly a one-element array for both a present revoked marker and an unavailable read; assert `Array.isArray(result)`, `result.length === 1` and the element shape before passing that same array to the core check; a name-index miss answers unavailable with `readFailureReason: \'name-index-miss\'` exactly, native-address-miss and other failed reads answer unavailable, never active with readStatus ok; the core check refuses those as indeterminate and verifies a present marker as revoked', async (t) => {
  const world = await markerWorld(t), readers = world.readers(), query = { jobId: JOB, listingPin: world.listingPin };
  const revoked = await readers.sessionAdmission.readRevocationSurfaces(query, LIMITS);
  assert.ok(Array.isArray(revoked) && revoked.length === 1);
  assert.deepEqual(revoked[0], { kind: 'catalog', status: 'revoked', readStatus: 'ok', catalogObservedAt: NOW, binding: { sellerPrimaryClaim: seller.claim, listingId: world.listingPin.listingId,
    listingVersion: world.listingPin.version, listingContentHash: world.listingPin.contentHash, logicalAddress: world.logicalAddress,
    markerAnchor: { kind: 'storage-program', locator: world.logicalAddress }, markerContentHash: contentHash(world.marker) } });
  assert.deepEqual(await world.coreCheck(readers), { code: 'session_not_admitted', status: 409, message: 'the Listing is revoked (verified-revocation-marker)' });
  const failures = { 'name-index-miss': { change: (f) => { f.state.rows = []; } }, 'native-address-miss': { storageMiss: true },
    invalid: { change: (f) => { f.state.tx.signature.data = `0x${'0'.repeat(128)}`; } } };
  for (const [reason, options] of Object.entries(failures)) {
    const failed = await markerWorld(t, options), failedReaders = failed.readers();
    const surfaces = await failedReaders.sessionAdmission.readRevocationSurfaces({ jobId: JOB, listingPin: failed.listingPin }, LIMITS);
    assert.ok(Array.isArray(surfaces) && surfaces.length === 1, reason);
    assert.deepEqual(surfaces, UNAVAILABLE(reason), reason);
    assert.equal((await failed.coreCheck(failedReaders)).status, 503, reason);
  }
});

test('finalize the production `createSellerWalletSession` port with its bound transport and real `createDemosSr2Adapter`; serve a marker name-index miss through the fixture node, call the port\'s own `sessionAdmission.readRevocationSurfaces`, and assert a one-element array whose element has exactly the own keys `{ kind, status, readStatus, readFailureReason }` and values `{ kind: \'catalog\', status: \'active\', readStatus: \'unavailable\', readFailureReason: \'name-index-miss\' }`, with no extra key; do not replace the port reader or adapter with a stub. Changing the adapter\'s `observation` mapping or adding a surface key fails this test.', async (t) => {
  const world = await finalizedPort(t, { participantImplementations: enrollment(), sessionOf: () => null });
  world.node.reply = (row) => (row.body?.params[0]?.message === 'searchStoragePrograms' ? jsonResponse(ok([])) : undefined);
  const surfaces = await world.port.sessionAdmission.readRevocationSurfaces({ jobId: JOB, listingPin: LISTING_PIN }, LIMITS);
  assert.ok(Array.isArray(surfaces) && surfaces.length === 1);
  assert.deepEqual(Reflect.ownKeys(surfaces[0]), ['kind', 'status', 'readStatus', 'readFailureReason']);
  assert.deepEqual(surfaces, UNAVAILABLE('name-index-miss'));
  assert.ok(world.node.reads.includes('searchStoragePrograms'), 'the name index was read through the port\'s transport');
});

test('readRevocationMarker answers the marker at its anchor; name-index-miss and native-address-miss reject with the adapter cause rather than answering null; another seller\'s locator also rejects', async (t) => {
  const world = await markerWorld(t), readMarker = (w, locator = world.logicalAddress) => w.readers().sessionAdmission.readRevocationMarker({ kind: 'storage-program', locator }, LIMITS);
  assert.deepEqual(await readMarker(world), world.marker);
  for (const [observation, options] of [['name-index-miss', { change: (f) => { f.state.rows = []; } }], ['native-address-miss', { storageMiss: true }]]) {
    const refused = await refusalOf(readMarker(await markerWorld(t, options)));
    assert.equal(refused.observation, observation, 'the adapter\'s own refusal, never null');
  }
  const reads = world.fixture.state.calls.length;
  const other = `dacs1-revoked:${encodeAddressSegment(buyer.claim)}:${world.listingPin.listingId}:v${world.listingPin.version}`;
  assert.equal((await refusalOf(readMarker(world, other))).code, 'revocation_marker_unverified');
  assert.equal(world.fixture.state.calls.length, reads, 'another seller\'s locator is refused before any read');
});

test('with a native marker omitting both provenance fields and executed content omitting network and chainIdentity, both marker methods refuse as unavailable without an independently authenticated signed projection; a rich, authenticated present marker still yields the one-element revoked array and the marker', async (t) => {
  const bare = await markerWorld(t, { change: (f) => { delete f.native.createdByTx; delete f.native.interactionTxs; delete f.tx.content.network; delete f.tx.content.chainIdentity; } });
  const readers = bare.readers(), query = { jobId: JOB, listingPin: bare.listingPin };
  const surfaces = await readers.sessionAdmission.readRevocationSurfaces(query, LIMITS);
  assert.deepEqual([surfaces.length, surfaces[0].status, surfaces[0].readStatus], [1, 'active', 'unavailable']);
  assert.ok(await refusalOf(readers.sessionAdmission.readRevocationMarker({ kind: 'storage-program', locator: bare.logicalAddress }, LIMITS)));
  const rich = await markerWorld(t), richReaders = rich.readers();
  assert.equal((await richReaders.sessionAdmission.readRevocationSurfaces({ jobId: JOB, listingPin: rich.listingPin }, LIMITS))[0].status, 'revoked');
  assert.deepEqual(await richReaders.sessionAdmission.readRevocationMarker({ kind: 'storage-program', locator: rich.logicalAddress }, LIMITS), rich.marker);
});

test('each admission read honors an aborted signal and its timeoutMs, and a result over maxBytes rejects with REPLY_LIMIT_CODE; the marker adapter takes only `canonicalNodeEndpoint(transport.pins.endpoint, { chainIdentity: binding.profile.chainIdentity })`: HTTP with the exact approved testnet identity and HTTPS pass, HTTP with another or missing identity refuses, and HTTP with a path, credentials, query or fragment refuses. A recorded scratch mutant that drops the identity condition fails this test', async (t) => {
  const world = scriptedChain(), readers = world.readers(), reason = new Error('TEST aborted');
  const queries = { admit: admitQuery(), resolveVetRecord: vetQuery(), readVetAnchorReceipt: vetQuery(), verifyVetAnchorReceipt: vetQuery({ record: VET_RECORD, receipt: VET_RECEIPT }),
    readRevocationSurfaces: { jobId: JOB, listingPin: LISTING_PIN }, readRevocationMarker: { kind: 'storage-program', locator: `dacs1-revoked:${encodeAddressSegment(seller.claim)}:x:v1` } };
  for (const name of ADMISSION_METHODS) {
    assert.equal(await refusalOf(readers.sessionAdmission[name](queries[name], { ...LIMITS, signal: AbortSignal.abort(reason) })), reason, name);
  }
  assert.equal(world.calls.length + world.source.reads, 0, 'an aborted read starts nothing');
  const tooLarge = await refusalOf(readers.sessionAdmission.admit(admitQuery(), { ...LIMITS, maxBytes: 64 }));
  assert.deepEqual([tooLarge instanceof RangeError, tooLarge.code], [true, REPLY_LIMIT_CODE]);
  world.source.entriesFor = () => new Promise(() => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = refusalOf(readers.sessionAdmission.admit(admitQuery(), { ...LIMITS, timeoutMs: 50 }));
  await flush();
  mock.timers.tick(50);
  assert.ok(isBoundedCallTimeout(await stalled), 'the read ends at its timeoutMs');
  mock.timers.reset();
  const markers = await markerWorld(t), surfacesWith = (pins, binding) => markers.readers({ pins, binding }).sessionAdmission.readRevocationSurfaces({ jobId: JOB, listingPin: markers.listingPin }, LIMITS);
  const otherChain = { ...markers.admission.binding, profile: { ...markers.admission.binding.profile, chainIdentity: 'c'.repeat(64) } };
  const noChain = { ...markers.admission.binding, profile: { ...markers.admission.binding.profile, chainIdentity: undefined } };
  assert.equal((await surfacesWith(undefined))[0].status, 'revoked', 'https');
  assert.equal((await surfacesWith({ endpoint: 'http://rpc.example.invalid/' }))[0].status, 'revoked', 'http with the approved testnet identity');
  const reads = markers.fixture.state.calls.length;
  for (const [name, pins, binding] of [['another identity', { endpoint: 'http://rpc.example.invalid/' }, otherChain], ['no identity', { endpoint: 'http://rpc.example.invalid/' }, noChain],
    ...['http://rpc.example.invalid/path', 'http://user:pw@rpc.example.invalid/', 'http://rpc.example.invalid/?q=1', 'http://rpc.example.invalid/#f'].map((endpoint) => [endpoint, { endpoint }])]) {
    assert.deepEqual(await surfacesWith(pins, binding), UNAVAILABLE('node_endpoint_refused'), name);
  }
  assert.equal(markers.fixture.state.calls.length, reads, 'a refused endpoint reads nothing');
});

test('an executed included transfer from the buyer to the seller\'s payee for the exact price, at or after the commitment, with the retained block number, answers verified with the exact paymentTxRef, and the transfer is observed again on a second call', async () => {
  const world = scriptedChain(), readers = world.readers(), query = paymentQuery();
  const expected = { disposition: 'verified', jobId: query.jobId, agreementHash: AGREEMENT_HASH, observedAt: NOW, paymentTxRef: { kind: 'demos', txHash: TX, blockNumber: BLOCK } };
  assert.deepEqual(await readers.observePayment(query, LIMITS), expected);
  assert.deepEqual(await readers.observePayment(query, LIMITS), expected);
  assert.deepEqual(world.calls.filter(([name]) => name === 'observeTransfer'), [['observeTransfer', TX], ['observeTransfer', TX]]);
});

test('an uppercase settlementIdentity.txHash equal ignoring case to normalized nativeEvidenceWork.txHash observes and reports only the latter lowercase hash; a hash mismatch refuses payment_unverified', async () => {
  const world = scriptedChain();
  world.session = paidSession({}, { txHash: TX.toUpperCase(), blockNumber: BLOCK });
  assert.equal((await world.readers().observePayment(paymentQuery(), LIMITS)).paymentTxRef.txHash, TX);
  assert.deepEqual(world.calls.filter(([name]) => name === 'observeTransfer'), [['observeTransfer', TX]]);
  world.session = paidSession({}, { txHash: 'cd'.repeat(32), blockNumber: BLOCK });
  assert.equal((await refusalOf(world.readers().observePayment(paymentQuery(), LIMITS))).code, 'payment_unverified');
});

test('an included transfer from another payer, to another payee, of another amount, before the commitment or after the deadline, or with another block number, is never verified', async () => {
  const world = scriptedChain(), readers = world.readers();
  const others = { payer: { payer: seller.address }, payee: { payee: buyer.address }, amount: { amountOs: `${BigInt(TERMS.price.amountOs) + 1n}` },
    'before the commitment': { includedAt: COMMITTED_AT - 1 }, 'after the deadline': { includedAt: TERMS.deadline + 1 }, block: { blockNumber: BLOCK + 1 }, 'not executed': { execution: undefined } };
  for (const [name, patch] of Object.entries(others)) {
    world.observation = transfer(patch);
    assert.equal((await refusalOf(readers.observePayment(paymentQuery(), LIMITS))).code, 'payment_unverified', name);
  }
});

test('a pending, failed, not found, unavailable or invalid observation, or a missing commitment time, rejects payment_unverified, never verified and never absent', async () => {
  const world = scriptedChain(), readers = world.readers();
  for (const status of ['pending', 'failed', 'not-found', 'unavailable', 'invalid']) {
    world.observation = { status, reason: 'TEST' };
    assert.equal((await refusalOf(readers.observePayment(paymentQuery(), LIMITS))).code, 'payment_unverified', status);
  }
  const failure = new Error('TEST read failed');
  world.observation = failure;
  assert.equal((await refusalOf(readers.observePayment(paymentQuery(), LIMITS))).cause, failure, 'a failed read keeps its cause');
  world.observation = transfer();
  world.session = paidSession({ commitment: {} });
  assert.equal((await refusalOf(readers.observePayment(paymentQuery(), LIMITS))).code, 'payment_unverified', 'no commitment time');
});

test('with no payment or settlement reference visible in the durable session, and the connection\'s chain identity read as the bound one, observePayment answers absent; a failed or different identity read rejects payment_unverified, and a missing sessionOf rejects reader_input_missing', async () => {
  const world = scriptedChain(), readers = world.readers();
  world.session = unpaidSession();
  assert.deepEqual(await readers.observePayment(paymentQuery(), LIMITS), { disposition: 'absent', jobId: fx.agreement.jobId, agreementHash: AGREEMENT_HASH, observedAt: NOW, paymentTxRef: null });
  assert.deepEqual([world.count('observeIdentity'), world.count('observeTransfer')], [1, 0]);
  for (const identity of [new Error('TEST identity read failed'), 'c'.repeat(64), undefined]) {
    world.identity = identity;
    assert.equal((await refusalOf(readers.observePayment(paymentQuery(), LIMITS))).code, 'payment_unverified', String(identity));
  }
  assert.equal((await refusalOf(world.readers({ sessionOf: undefined }).observePayment(paymentQuery(), LIMITS))).code, 'reader_input_missing');
});

test('a session without a payment reference whose settlementBound is true, missing, null or a string rejects payment_unverified and reads neither the chain identity nor the transfer', async () => {
  const world = scriptedChain(), readers = world.readers();
  const missing = unpaidSession();
  delete missing.settlementBound;
  for (const session of [unpaidSession({ settlementBound: true }), missing, unpaidSession({ settlementBound: null }), unpaidSession({ settlementBound: 'false' })]) {
    world.session = session;
    const refused = await refusalOf(readers.observePayment(paymentQuery(), LIMITS));
    assert.deepEqual([refused.code, refused.message], ['payment_unverified', 'a settlement is bound to the job without its payment reference']);
  }
  assert.deepEqual([world.count('observeIdentity'), world.count('observeTransfer')], [0, 0]);
});

test('a session with a retained payment reference answers verified whether settlementBound is true or missing', async () => {
  const world = scriptedChain(), readers = world.readers();
  const missing = paidSession();
  delete missing.settlementBound;
  for (const session of [paidSession({ settlementBound: true }), missing]) {
    world.session = session;
    assert.equal((await readers.observePayment(paymentQuery(), LIMITS)).disposition, 'verified');
  }
});

test('a session with payment, paymentWork, settlementCredit indeterminate or another visible settlement reference but no nativeEvidenceWork rejects payment_unverified rather than answering absent; a throwing sessionOf keeps its seller_state_unverified cause', async () => {
  const world = scriptedChain(), readers = world.readers();
  for (const patch of [{ payment: { TEST: 'payment' } }, { paymentWork: { TEST: 'work' } }, { settlementCredit: 'indeterminate' }, { nativeEvidenceWork: { txHash: TX } }]) {
    world.session = unpaidSession(patch);
    assert.equal((await refusalOf(readers.observePayment(paymentQuery(), LIMITS))).code, 'payment_unverified', Object.keys(patch)[0]);
  }
  assert.equal(world.count('observeIdentity'), 0, 'a recorded payment is never reported absent');
  const failure = Object.assign(new Error('TEST unverified state'), { code: 'seller_state_unverified' });
  world.session = failure;
  const refused = await refusalOf(readers.observePayment(paymentQuery(), LIMITS));
  assert.deepEqual([refused.code, refused.cause], ['payment_unverified', failure]);
});

test('a retained session whose Agreement does not hash to the query\'s agreementHash, whose retained agreementHash differs, or whose `sessionOf(jobId)` is null is refused payment_unverified before any chain read, never absent; the reader uses the retained Agreement for payment terms', async () => {
  const world = scriptedChain(), readers = world.readers();
  const changed = { ...fx.agreement, terms: { ...fx.agreement.terms, deadline: fx.agreement.terms.deadline + 1 } };
  for (const session of [paidSession({ agreement: changed }), paidSession({ agreementHash: 'e'.repeat(64) }), null]) {
    world.session = session;
    assert.equal((await refusalOf(readers.observePayment(paymentQuery(), LIMITS))).code, 'payment_unverified');
  }
  assert.equal(world.count('observeTransfer') + world.count('observeIdentity'), 0, 'no chain read');
  world.session = paidSession();
  const forged = { ...paymentQuery(), agreement: changed };
  assert.equal((await readers.observePayment(forged, LIMITS)).disposition, 'verified', 'the query\'s Agreement copy is not read for terms');
});

test('the answer names the query\'s jobId and agreementHash, observedAt is not before the query\'s, and the answer fits maxBytes; a limit one byte below the serialized answer rejects with TypeError', async () => {
  const world = scriptedChain(), readers = world.readers(), later = paymentQuery(NOW + 7);
  const answer = await readers.observePayment(later, LIMITS);
  assert.deepEqual([answer.jobId, answer.agreementHash, answer.observedAt], [later.jobId, AGREEMENT_HASH, NOW + 7]);
  const size = Buffer.byteLength(JSON.stringify(answer));
  assert.ok(size <= LIMITS.maxBytes);
  assert.deepEqual(await readers.observePayment(later, { ...LIMITS, maxBytes: size }), answer);
  assert.ok((await refusalOf(readers.observePayment(later, { ...LIMITS, maxBytes: size - 1 }))) instanceof TypeError);
});

test('a stalled observation ends at min(timeoutMs, 10000) and a late answer resolves nothing; an aborted signal rejects with its reason and starts no further read', async (t) => {
  const world = scriptedChain(), readers = world.readers();
  let answerLate;
  world.observation = () => new Promise((resolve) => { answerLate = resolve; });
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  for (const [timeoutMs, ends] of [[60_000, 10_000], [200, 200]]) {
    let settled = false;
    const stalled = refusalOf(readers.observePayment(paymentQuery(), { ...LIMITS, timeoutMs })).finally(() => { settled = true; });
    await flush();
    mock.timers.tick(ends - 1);
    await flush();
    assert.equal(settled, false, `still waiting at ${ends - 1} ms`);
    mock.timers.tick(1);
    const refused = await stalled;
    assert.deepEqual([refused.code, isBoundedCallTimeout(refused.cause)], ['payment_unverified', true]);
    answerLate(transfer());
  }
  const controller = new AbortController(), reason = new Error('TEST caller aborted');
  world.observation = () => new Promise(() => {});
  const pending = refusalOf(readers.observePayment(paymentQuery(), { ...LIMITS, signal: controller.signal }));
  await flush();
  controller.abort(reason);
  assert.equal(await pending, reason);
  assert.equal(world.signal, controller.signal, 'the transfer read was given the caller\'s signal');
  const reads = world.calls.length;
  assert.equal(await refusalOf(readers.observePayment(paymentQuery(), { ...LIMITS, signal: controller.signal })), reason);
  assert.equal(world.calls.length, reads, 'an aborted call starts no read');
});
