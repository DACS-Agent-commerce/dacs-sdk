// A wallet request's own signing check over the seller's Node wallet: a request may carry `{ authorize }`, which the wallet
// asks as the approval answer returns and again in the client's effect gate right before each transaction signature of that
// request. Any answer but an immediate `true` refuses not-authorized with nothing signed or sent.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { installNoEgress } from '../../dacs-client/test/helpers/no-egress.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, evidenceInput, finalization, FIXTURE_MNEMONIC, inWalletPass, jsonResponse, ok, outcomes, preparedWrite, privateDataDirectory, replayNode, replyTo,
  restartedWorld, runWalletChild, settlingApproval, settlingWorld, spyTransactionSignatures, T0, writesOf } from './helpers/seller-node-wallet-world.mjs';

const egress = installNoEgress();
after(() => {
  assert.deepEqual(egress.attempts, [], 'no socket or DNS lookup left the process');
  egress.restore();
});
const { OPERATOR_CLOSING } = await import('../src/devnet-demo/operator-approval.mjs');
const { createDevnetDemoArtifactAnchor } = await import('../src/devnet-demo/artifact-anchor.mjs');
const { deriveWalletIdentity } = await import('../src/cli/node-identity.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');
const { productionObserveIdentity } = await import('./helpers/sr2-live-fixture.mjs');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const LISTING_ADDRESS = 'dacs1:listing:fixture-report:1';
const PASS_WINDOW_MS = 10_000;
const SEND = 'sendTransaction';

const jobCreate = () => api.passContext({ operationClass: 'job-create', currentAuthorization: () => true });
const countOf = (reads, message) => reads.filter(read => read === message).length;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

/** The fixture mnemonic's custody signer: its claim and an Ed25519 signBytes over the derived key, zero-filled once imported. */
async function fixtureSigner() {
  const { claim, privateKey } = await deriveWalletIdentity(FIXTURE_MNEMONIC);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, privateKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  privateKey.fill(0);
  return { claim, signBytes: bytes => sign(null, Buffer.from(bytes), key) };
}

/**
 * A seller wallet world whose approval double logs each sendTransaction it is asked, into `events`, with the node reads so far.
 * `answer(request)` (true by default) is the approver's answer once `gate` resolves.
 */
async function loggedWorld(t, { gate = async () => {}, answer = () => true } = {}) {
  const events = [];
  const logged = async request => {
    if (request.method === SEND) events.push({ step: 'approval', reads: world.node.reads.length });
    await gate(request);
  };
  const base = settlingApproval({ gate: logged });
  const approve = async request => (answer(request) === true ? base(request) : logged(request).then(() => false));
  Object.assign(approve, { accepted: base.accepted, settled: base.settled, confirm: base.confirm, retained: base.retained, settle: base.settle });
  const world = await settlingWorld(t, { approve });
  world.events = events;
  return world;
}

/**
 * An `authorize` that answers the next of `answers` (throwing it when it is an Error) and logs each call into `world.events`
 * with the node reads, nonce reads, confirmTx reads and transaction signatures made so far.
 */
function scriptedAuthorize(world, answers, signatures) {
  const pending = [...answers];
  return () => {
    const { reads } = world.node;
    world.events.push({ step: 'authorize', reads: reads.length, nonceReads: countOf(reads, 'getAddressNonce'), confirms: countOf(reads, 'confirmTx'), signatures: signatures.length });
    const next = pending.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

/** One artifact CREATE sent with `authorize` answering `answers`, inside one job-create effect pass with `synchronousChecks`. */
async function checkedWrite(world, answers, signatures, synchronousChecks = Object.freeze([])) {
  const { wallet, request } = await preparedWrite(world);
  const authorize = scriptedAuthorize(world, answers, signatures);
  return inWalletPass(world, () => wallet.request(request, { authorize }), { context: jobCreate(), synchronousChecks });
}

const stepsOf = world => world.events.map(({ step }) => step);
const authorizeCalls = world => world.events.filter(({ step }) => step === 'authorize');
const approvalReads = world => world.events.find(({ step }) => step === 'approval').reads;
const sentNothing = (world, signatures) => {
  assert.equal(signatures.length, 0, 'no transaction signature');
  assert.equal(world.node.confirms.length, 0, 'no confirmTx');
  assert.equal(world.node.broadcasts.length, 0, 'no broadcastTx');
};
const assertNotAuthorized = answer => {
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.equal(answer.data, null);
  assert.equal(answer.error?.code, 'not-authorized', JSON.stringify(answer));
};

test('every walletFactory view of the composed seller wallet says guardsSigning is true, and a CREATE whose authorize answers true is asked once as its approval answer returns and once more at its signature, after the wallet\'s network and nonce reads, then signed, confirmed and broadcast once and settled spent', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await loggedWorld(t);
  assert.equal(world.wallet.walletFactory().guardsSigning, true);
  assert.equal(world.wallet.walletFactory({ anchorJournal: world.wallet.artifactJournal }).guardsSigning, true);
  const hostCheck = ({ phase }) => { world.events.push({ step: `host ${phase}` }); };
  const checks = Object.freeze([hostCheck]);
  const answer = await checkedWrite(world, [true, true], signatures, checks);
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.deepEqual(stepsOf(world), ['approval', 'authorize', 'host sign', 'authorize', 'host confirmTx', 'host broadcastTx'],
    'asked after the approval and after the pass\'s own check at the signature, never at confirmTx or broadcastTx');
  const [atApproval, atSignature] = authorizeCalls(world);
  assert.equal(atApproval.reads, approvalReads(world), 'the first ask comes before any post-approval read');
  assert.equal(atSignature.nonceReads, atApproval.nonceReads + 1, 'the second ask comes after the wallet\'s post-approval nonce read');
  assert.deepEqual({ confirms: atSignature.confirms, signatures: atSignature.signatures }, { confirms: 0, signatures: 0 });
  assert.equal(signatures.length, 1);
  assert.equal(world.node.confirms.length, 1);
  assert.equal(world.node.broadcasts.length, 1);
  assert.deepEqual(outcomes(world), ['spent']);
  assert.deepEqual(checks, [hostCheck], 'the caller\'s frozen list is unchanged');
});

test('a CREATE whose authorize refuses as its approval answer returns answers not-authorized with no signature, no confirmTx or broadcastTx and no post-approval node read, and its approval is settled released', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await loggedWorld(t);
  assertNotAuthorized(await checkedWrite(world, ['TEST-withdrawn'], signatures));
  assert.deepEqual(stepsOf(world), ['approval', 'authorize']);
  assert.equal(world.node.reads.length, approvalReads(world), 'no node read after the approval');
  sentNothing(world, signatures);
  assert.deepEqual(outcomes(world), ['released']);
});

test('a CREATE whose authorize allows its approval and then refuses at its signature, by a string, false, a throw or a promise of true, answers not-authorized each time with no signature, no confirmTx or broadcastTx, and its approval settled released, so neither journal recorded broadcast-started', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  for (const refusal of ['TEST-withdrawn', false, new Error('TEST-check-failed'), Promise.resolve(true)]) {
    const world = await loggedWorld(t);
    assertNotAuthorized(await checkedWrite(world, [true, refusal], signatures));
    const [atApproval, atSignature] = authorizeCalls(world);
    assert.equal(authorizeCalls(world).length, 2);
    assert.ok(atSignature.reads > atApproval.reads && atSignature.nonceReads === atApproval.nonceReads + 1, 'the second ask sees the post-approval reads');
    sentNothing(world, signatures);
    assert.deepEqual(outcomes(world), ['released'], 'released: no broadcast-started record reached either journal');
  }
});

test('a request\'s signing check is its own: while a CREATE whose authorize refuses at its signature waits for its approval, a payment-evidence CREATE in the same pass is signed without that check refusing it, and the waiting CREATE is then refused not-authorized at its own signature with nothing signed', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  let entered = false, release;
  const held = new Promise(resolve => { release = resolve; });
  const world = await loggedWorld(t, { gate: async request => { if (request.method === SEND) { entered = true; await held; } } });
  const { wallet, request } = await preparedWrite(world);
  const authorize = scriptedAuthorize(world, [true, 'TEST-withdrawn'], signatures);
  const { waiting, evidence } = await inWalletPass(world, async () => {
    const waiting = wallet.request(request, { authorize });
    while (!entered) await nextTurn();
    replyTo(world.node, 'confirmTx', row => jsonResponse(ok({ data: { valid: false, message: 'TEST-refused-confirmation', gas_operation: null, transaction: row.body.params[0].data } })));
    const evidence = await world.wallet.paymentEvidence.anchorEvidence(evidenceInput(world)).then(value => value, error => error);
    world.node.reply = null;
    release();
    return { waiting: await waiting, evidence };
  }, { context: jobCreate() });
  assert.equal(signatures.length, 1, 'only the payment-evidence CREATE was signed');
  assert.equal(world.node.confirms.length, 1, 'its confirmation was sent and refused');
  assert.equal(world.node.broadcasts.length, 0);
  assert.ok(!JSON.stringify(evidence, Object.getOwnPropertyNames(evidence ?? {})).includes('not-authorized'), 'the evidence CREATE failed on its refused confirmation, not on the waiting request\'s check');
  assert.notEqual(evidence?.code, 'not-authorized');
  assertNotAuthorized(waiting);
  assert.equal(authorizeCalls(world).length, 2, 'the waiting CREATE was asked at its approval and at its own signature');
});

test('before asking approval, the composed wallet refuses a second argument that is not exactly { authorize: function } with a TypeError, and an authorize on any request but sendTransaction with not-authorized, approving, signing and sending nothing', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await loggedWorld(t);
  const { wallet, request } = await preparedWrite(world);
  const acceptedBefore = world.approve.accepted.length;
  let asked = 0;
  const authorize = () => { asked++; return true; };
  const malformed = [null, 'TEST', {}, { authorize: 'TEST' }, { authorize, TEST: 1 }, { authorize, [Symbol('TEST')]: 1 }];
  for (const options of malformed) await assert.rejects(inWalletPass(world, () => wallet.request(request, options), { context: jobCreate() }), TypeError);
  assertNotAuthorized(await wallet.request({ method: 'sign', params: ['TEST-message'] }, { authorize }));
  assert.equal(world.approve.accepted.length, acceptedBefore, 'approval was not asked');
  assert.equal(asked, 0, 'authorize was not asked');
  sentNothing(world, signatures);
});

// An artifact anchor over the wallet's walletFactory, built outside any effect pass with the world's binding and the host's
// identity observation, and the fixture Listing it would publish.
async function listingAnchor(world) {
  const { sourceCapability } = world.wallet, signer = await fixtureSigner();
  const anchor = createDevnetDemoArtifactAnchor({ sourceCapability, binding: world.admission.binding, observeIdentity: productionObserveIdentity(world),
    journal: world.wallet.artifactJournal, walletFactory: world.wallet.walletFactory, network: sourceCapability.pins.network, signer: { claim: signer.claim },
    runCreate: () => assert.fail('no CREATE reaches runCreate here') });
  return { anchor, listing: fixtureListing(signer, { now: T0 }) };
}

// Asserts that `publish` rejects `code` with no node or authority read, journal entry, signature or lock left behind.
async function assertPublishRefused(world, signatures, publish, code) {
  const before = { authority: world.authority.state.calls, reads: world.node.reads.length };
  await assert.rejects(publish(), { code });
  assert.deepEqual({ authority: world.authority.state.calls, reads: world.node.reads.length }, before, 'no authority or node read');
  assert.deepEqual(await world.wallet.artifactJournal.entries(), [], 'no journal entry');
  assert.equal(signatures.length, 0, 'no signature');
  assert.deepEqual(world.wallet.artifactJournal.inspectLocks(), [], 'no artifact journal lock');
  assert.deepEqual(world.wallet.sourceCapability.journal.inspectLocks(), [], 'no transport journal lock');
}

test('an artifact anchor over the composed wallet takes a Listing publish with authorizeSigning past its signing-check gate: it refuses nonce_lane_unavailable, as the same publish without the check does, with no node or authority read, journal entry or signature', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await loggedWorld(t);
  const { anchor, listing } = await listingAnchor(world);
  const publish = extra => () => anchor.publish({ logicalAddress: LISTING_ADDRESS, artifact: listing, artifactKind: 'Listing', operationClass: 'job-create',
    currentAuthorization: () => true, ...extra });
  await assertPublishRefused(world, signatures, publish({ authorizeSigning: () => true }), 'nonce_lane_unavailable');
  await assertPublishRefused(world, signatures, publish({}), 'nonce_lane_unavailable');
});

test('a guarded CREATE outside any effect pass is asked its check once as its approval answer returns and then refused effect_pass_required at its signature, and a pass made through the composed wallet whose synchronousChecks is not an array or has a hole is refused effect_pass_invalid, with nothing signed or sent', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await loggedWorld(t);
  const { wallet, request } = await preparedWrite(world);
  const answer = await wallet.request(request, { authorize: scriptedAuthorize(world, [true, true], signatures) });
  assert.equal(answer.error?.code, 'effect_pass_required', JSON.stringify(answer));
  assert.deepEqual(stepsOf(world), ['approval', 'authorize'], 'asked once, after the approval');
  sentNothing(world, signatures);
  assert.deepEqual(outcomes(world), ['released']);

  const lease = await world.owner.acquireConnectionFence();
  t.after(() => lease.release());
  const pass = { fence: lease, deadline: T0 + PASS_WINDOW_MS, refreshAuthority() {}, finalStop() {}, synchronousChecks: [], feeCeilingOs: finalization.feeCeilingOs,
    context: api.passContext({ operationClass: 'payment-evidence', currentAuthorization: () => true }) };
  assert.equal(typeof world.wallet.effectPass(pass), 'object', 'the same options with a list make a pass');
  // eslint-disable-next-line no-sparse-arrays -- the hole is what this checks
  const sparse = [, () => true];
  for (const synchronousChecks of ['TEST', sparse]) assert.throws(() => world.wallet.effectPass({ ...pass, synchronousChecks }), { code: 'effect_pass_invalid' });
  assert.equal(sparse.length, 2);
  assert.ok(!(0 in sparse), 'the caller\'s hole is still a hole');
  sentNothing(world, signatures);
});

test('a guarded CREATE whose approval ends in a shutdown answers operator_closing, and one whose approver answers false answers user_rejected; in both, authorize is never asked and nothing is signed or sent', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const closing = await loggedWorld(t, { gate: async request => { if (request.method === SEND) throw Object.assign(new Error('TEST-closing'), { code: OPERATOR_CLOSING }); } });
  const rejecting = await loggedWorld(t, { answer: request => request.method !== SEND });
  for (const [world, code] of [[closing, OPERATOR_CLOSING], [rejecting, 'user_rejected']]) {
    const answer = await checkedWrite(world, [true, true], signatures);
    assert.equal(answer.error?.code, code, JSON.stringify(answer));
    assert.deepEqual(stepsOf(world), ['approval'], 'authorize was never asked');
    assert.equal(world.node.reads.length, approvalReads(world), 'no node read after the approval');
    assert.deepEqual(writesOf(world.approve), [], 'nothing accepted, so nothing to settle');
    assert.ok(!world.approve.accepted.some(({ method }) => method === SEND), 'the write was not accepted');
    sentNothing(world, signatures);
  }
});

test('an artifact anchor over the composed wallet refuses a Listing publish whose authorizeSigning is not a function with not-authorized, even though the wallet says guardsSigning, with no node or authority read, journal entry or signature', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await loggedWorld(t);
  const { anchor, listing } = await listingAnchor(world);
  for (const authorizeSigning of ['TEST', {}]) {
    await assertPublishRefused(world, signatures, () => anchor.publish({ logicalAddress: LISTING_ADDRESS, artifact: listing, artifactKind: 'Listing', authorizeSigning,
      operationClass: 'job-create', currentAuthorization: () => true }), 'not-authorized');
  }
});

test('killed while a CREATE\'s authorize runs, at its approval answer or at its signature, the wallet sent nothing, and after a restart the same CREATE is signed, confirmed and broadcast once', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const nonceReadsAtKill = [];
  for (const call of [1, 2]) {
    const directory = privateDataDirectory(t), stateDirectory = privateDataDirectory(t);
    const child = await runWalletChild(`guarded:${call}`, directory, stateDirectory);
    assert.equal(child.signal, 'SIGKILL', `call ${call}: ${child.stderr}`);
    const killed = JSON.parse(readFileSync(join(stateDirectory, 'killed.json'), 'utf8'));
    assert.equal(killed.call, call);
    assert.ok(!killed.reads.includes('confirmTx') && !killed.reads.includes('broadcastTx'), `call ${call}: nothing was sent before the kill`);
    nonceReadsAtKill.push(countOf(killed.reads, 'getAddressNonce'));
    const left = replayNode(join(stateDirectory, 'chain.json'));
    assert.deepEqual({ confirms: left.confirms.length, broadcasts: left.broadcasts.length }, { confirms: 0, broadcasts: 0 }, `call ${call}: the killed process sent nothing`);

    const world = await restartedWorld(t, directory, stateDirectory);
    const before = signatures.length;
    const { wallet, request } = await preparedWrite(world);
    const answer = await inWalletPass(world, () => wallet.request(request, { authorize: () => true }), { context: jobCreate() });
    assert.equal(answer.success, true, `call ${call}: ${JSON.stringify(answer)}`);
    assert.equal(signatures.length - before, 1, `call ${call}: signed once after the restart`);
    assert.deepEqual({ confirms: world.node.confirms.length, broadcasts: world.node.broadcasts.length }, { confirms: 1, broadcasts: 1 }, `call ${call}: sent once`);
    await world.wallet.close();
  }
  assert.ok(nonceReadsAtKill[1] > nonceReadsAtKill[0], 'the second kill came after the wallet\'s post-approval nonce read');
});
