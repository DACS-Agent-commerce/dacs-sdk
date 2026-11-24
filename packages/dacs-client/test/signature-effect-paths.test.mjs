// The client's signature paths through the effect boundary: the session-key request signature (and the
// last check before its first byte), the wallet's message signature through the Node wallet session
// (identity presentation, delegation, Agreement and anchor authorization all sign messages), and the RPC
// authentication of a recovery. Each signs only after the boundary's final stop check and synchronous
// rechecks, and only under the approved TP-1 record. Real durable history, fence and journal; the
// seller is a loopback TLS server or a stand-in connector. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { createEffectBoundary, flush } from './helpers/effect-boundary-fixture.mjs';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { JOB_IDS } from './helpers/native-create-world.mjs';
import { startHttpsSeller } from './helpers/seller-https-rig.mjs';
import { storedWorld, PATHS, bodyFor, nonce } from './helpers/stored-request-fixture.mjs';
import { world as nodeWorld } from './helpers/tp1-node-fixture.mjs';
import { world as wireWorld, request, setPurchaseAdmission, JOB } from './helpers/wire-client-fixture.mjs';

const { createSellerHttpsClient } = await import('../src/dacs/seller-http.mjs');
const { SELLER_ANSWER_CLASS } = await import('../src/dacs/seller-response-class.mjs');
const { createSourceDemoSellerTransport } = await import('../src/dacs/source-demo-seller-transport.mjs');
const { loadNodeDemos } = await import('../src/wallet/node-demos-loading.mjs');

const RECORD_REFUSALS = [[{ ...TP1_APPROVED_IDENTITY_RECORD, recordId: 'TEST-self-made-record' }, 'tp1_identity_unapproved'],
  [{ ...TP1_APPROVED_IDENTITY_RECORD, network: 'demos-mainnet' }, 'tp1_identity_record_invalid'],
  [{ ...TP1_APPROVED_IDENTITY_RECORD, chainIdentity: TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0] }, 'tp1_identity_fixture']];
const OTHER_CHAIN = 'f'.repeat(64);
const code = expected => error => error.code === expected;
// What can change while a signature is being made: the host's stop, the profile hold, the actor's connection.
const CHANGES = [['a stop', 'writes_stopped', 'stop'], ['a re-hold', 'profile_not_admitted', 'hold'], ['a reconnect behind the fence', 'tp1_local_binding_changed', 'reconnect']];

// ---- the session-key request: the real wire authentication over a boundary, and the real client over a loopback seller ----
async function requestWorld(t, options) {
  const seller = await startHttpsSeller(t, (_req, res) => res.destroy());
  const w = await wireWorld(t, { publicEndpoint: seller.origin, ...options });
  const client = (authentication = w.auth) => createSellerHttpsClient({ publicEndpoint: seller.origin, connector: seller.connector, authentication });
  const authenticationSigning = sign => w.createSellerWireAuthentication({ ...w.options, sessionSigner: { claim: w.options.sessionSigner.claim, sign } });
  const change = {
    stop: () => { w.requests.control.stopped = true; },
    hold: () => setPurchaseAdmission('held'),
    reconnect: () => { w.local.connectionId = 'TEST-reconnected'; },
  };
  const post = (authentication) => client(authentication).agreementState({ jobId: JOB });
  const sign = (authentication = w.auth) => request({ ...w, auth: authentication });
  const states = async () => (await w.requests.records()).map(record => record.state);
  return { w, seller, client, authenticationSigning, change, post, sign, states, control: w.requests.control };
}
const heldSigner = (r) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sign = async bytes => { await gate; return r.w.session.sign(bytes); };
  return { sign, release };
};

// ---- the wallet message signature: the Node wallet session's general `sign` request ----
async function messageWorld(t, options = {}) {
  let current;
  const state = { signs: 0, stopped: false, stopCalls: 0, stopCallsAtSigner: undefined, onStop: null, pending: null };
  const w = await nodeWorld(t, { ownerWrap: owner => { current = owner.currentLocal(); return { ...owner, currentLocal: () => current }; }, ...options,
    sessionOptions: { stopped: async () => { state.stopCalls++; await state.onStop?.(state.stopCalls); return state.stopped; } } });
  const { Demos } = await loadNodeDemos();
  const original = Demos.prototype.signMessage;
  t.mock.method(Demos.prototype, 'signMessage', async function (...args) {
    state.signs++; state.stopCallsAtSigner = state.stopCalls;
    await state.pending?.();
    return Reflect.apply(original, this, args);
  });
  const change = { stop: () => { state.stopped = true; }, hold: () => setPurchaseAdmission('held'), reconnect: () => { current = { ...current, connectionId: 'TEST-reconnected' }; } };
  const sign = (message = 'TEST-wallet-message') => w.session.wallet.request({ method: 'sign', params: [message] });
  const records = async () => (await w.journal().entries()).filter(([key]) => key.startsWith('eb/')).map(([, record]) => record);
  return { w, state, change, sign, records };
}
// The wallet envelope hides the refusal; its cause chain keeps the boundary's own code.
const causeCodes = (m, answer) => { const codes = []; for (let error = m.w.session.internalCauseOf(answer); error; error = error.cause) codes.push(error.code ?? error.message); return codes; };
function refusedWith(m, answer, expected) {
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.equal(answer.data, null);
  assert.ok(causeCodes(m, answer).includes(expected), `the refusal keeps ${expected}; it holds ${causeCodes(m, answer)}`);
}

// ---- the RPC authentication of a recovery ----
async function recoveryWorld(t, options) {
  const events = [];
  const c = await boundedCreateWorld(t, { events, ...options });
  const { tx } = await c.send(JOB_IDS[0], 1);
  const headers = [];
  const signRpc = async message => { const signature = c.world.wallet.signHex(message); headers.push(signature); return signature; };
  const recover = () => c.world.capability.recoverStorageWrite({ signedTransaction: tx, signRpc });
  return { c, tx, headers, recover, events };
}

test('the session-key request, the wallet message signature and the RPC authentication signature each sign zero times for a mainnet-labelled, self-approved or refused record', async t => {
  for (const [record, expected] of RECORD_REFUSALS) await assert.rejects(bindFixture({ record }), { code: expected });
  assert.throws(() => createEffectBoundary({ currentLocal: () => ({}), stopped: async () => false, history: {}, fence: {}, binding: undefined }), TypeError, 'no binding, no boundary');

  const r = await requestWorld(t);
  r.w.state.failure = Object.assign(new Error('TEST-authority-refused'), { code: 'tp1_connection_unverified' });
  await assert.rejects(request(r.w), code('tp1_connection_unverified'));
  assert.equal(r.w.state.signs.length, 0);
  assert.equal(r.seller.seen.requests.length, 0);

  const m = await messageWorld(t);
  m.w.authority.state.chainIdentity = OTHER_CHAIN;
  await assert.rejects(m.sign(), code('profile_not_admitted'));
  assert.equal(m.state.signs, 0);

  const c = await recoveryWorld(t);
  c.c.bound.authority.state.chainIdentity = OTHER_CHAIN;
  assert.deepEqual(await c.recover(), { disposition: 'pending', hash: c.tx.hash, noResend: true });
  assert.equal(c.headers.length, 0);
});

test('the approved record signs once on each signature path', async t => {
  const r = await requestWorld(t);
  await assert.rejects(r.post());
  assert.equal(r.w.state.signs.length, 1);
  assert.equal(r.seller.seen.requests.length, 1);
  assert.deepEqual(await r.states(), [], 'a request that goes out is signed again when it is sent, so it leaves no record');

  const m = await messageWorld(t);
  const answer = await m.sign();
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.match(answer.data.signature, /^[0-9a-f]{128}$/);
  assert.equal(m.state.signs, 1);
  assert.deepEqual((await m.records()).map(record => record.state), ['signed', 'dispatch-started']);

  const c = await recoveryWorld(t);
  await c.recover();
  assert.equal(c.headers.length, 2, 'one authentication for the confirmation and one for the resend');
});

test('each signature path runs the final stop check and the synchronous rechecks with no await before the signer', async t => {
  const control = await requestWorld(t);
  let finalStop;
  const probe = control.authenticationSigning(bytes => { finalStop = control.control.stopCalls; return control.w.session.sign(bytes); });
  await control.sign(probe);
  assert.ok(finalStop > 0);
  for (const [, expected, name] of CHANGES.slice(1)) {
    const r = await requestWorld(t);
    r.control.onStop = call => { if (call === finalStop) r.change[name](); };
    await assert.rejects(r.sign(), code(expected));
    assert.equal(r.w.state.signs.length, 0, `the request signer ran after ${name} inside the final stop read`);
  }

  const reference = await messageWorld(t);
  assert.equal((await reference.sign()).success, true);
  for (const [, expected, name] of CHANGES.slice(1)) {
    const m = await messageWorld(t);
    m.state.onStop = call => { if (call === reference.state.stopCallsAtSigner) m.change[name](); };
    refusedWith(m, await m.sign(), expected);
    assert.equal(m.state.signs, 0, `the message signer ran after ${name} inside the final stop read`);
  }
});

test('the session-key request signer refuses a stop or a hold flip at the authority read that precedes the signer', async t => {
  for (const [, expected, name] of CHANGES.slice(0, 2)) {
    const r = await requestWorld(t);
    let reads = 0;
    r.w.state.gate = async () => { if (++reads === 1) r.change[name](); };
    await assert.rejects(r.sign(), code(expected));
    assert.equal(r.w.state.signs.length, 0);
  }
});

test("an RPC authentication signature inside a recovery reuses the operation's fence and is not persisted", async t => {
  const c = await recoveryWorld(t);
  const before = c.events.length;
  await c.recover();
  assert.equal(c.events.length - before, 1, 'the recovery holds the connection fence once; its two authentications add no acquisition');
  assert.equal(c.headers.length, 2);
  const stored = JSON.stringify(await c.c.journal.entries());
  for (const header of c.headers) assert.ok(!stored.includes(header), 'an authentication header was written to the journal');
});

test('an RPC authentication signature refuses a stop that arrives after the recovery began and signs nothing more', async t => {
  const c = await recoveryWorld(t);
  c.c.nodeHook = async message => { if (message === 'confirmTx') c.c.stopped = true; };
  const broadcasts = c.c.calls.broadcastTx;
  assert.deepEqual(await c.recover(), { disposition: 'pending', hash: c.tx.hash, noResend: true });
  assert.equal(c.headers.length, 1, 'only the confirmation was authenticated');
  assert.equal(c.c.calls.broadcastTx, broadcasts, 'nothing was broadcast');
});

test('a signature that completes after a stop or a re-hold is retained as evidence and the request carrying it is not sent', async t => {
  for (const [, expected, name] of CHANGES) {
    const r = await requestWorld(t);
    const held = heldSigner(r);
    const sending = r.post(r.authenticationSigning(held.sign));
    sending.catch(() => {});
    await flush();
    r.change[name]();
    held.release();
    await assert.rejects(sending);
    assert.equal(r.seller.seen.requests.length, 0);
    assert.deepEqual(await r.states(), ['signed', 'signed-held'], `${name}: the signature stays recorded and is never released`);
    assert.equal((await r.w.requests.records())[1].cause.code, expected);
  }
});

test('a wallet message signature through the Node wallet session refuses at each barrier and signs again after a restart', async t => {
  for (const [, expected, name] of CHANGES) {
    const m = await messageWorld(t);
    let release;
    m.state.pending = () => new Promise(resolve => { release = resolve; });
    const answer = m.sign();
    while (release === undefined) await flush();
    m.change[name]();
    release();
    refusedWith(m, await answer, expected);
    assert.deepEqual((await m.records()).map(record => record.state), ['signed', 'signed-held'], `${name}: retained, never released`);
    m.state.pending = null; m.state.stopped = false; setPurchaseAdmission('testnet-tp1');
    await m.w.restart();
    assert.equal((await m.sign()).success, true, `${name}: a restart asks the signer again`);
    assert.equal(m.state.signs, 2);
  }
});

test('while held, every signature path refuses profile_not_admitted with zero signer calls', async t => {
  const r = await requestWorld(t);
  setPurchaseAdmission('held');
  await assert.rejects(request(r.w), code('profile_not_admitted'));
  assert.equal(r.w.state.signs.length, 0);
  assert.equal(r.control.acquired, 0);

  const c = await recoveryWorld(t);
  setPurchaseAdmission('held');
  const acquired = c.events.length;
  assert.deepEqual(await c.recover(), { disposition: 'pending', hash: c.tx.hash, noResend: true });
  assert.equal(c.headers.length, 0);
  assert.equal(c.events.length, acquired, 'a held recovery never takes the connection fence');
});

test('with the signing of a session-key request held pending, or the request held before its first byte, a stop, a re-hold or a reconnect behind the fence withholds it; the unchanged control posts once', async t => {
  const control = await requestWorld(t);
  await assert.rejects(control.post());
  assert.equal(control.seller.seen.requests.length, 1);
  const lastStop = control.control.stopCalls;

  for (const [, expected, name] of CHANGES) {
    const pending = await requestWorld(t);
    const held = heldSigner(pending);
    const sending = pending.post(pending.authenticationSigning(held.sign));
    sending.catch(() => {});
    await flush();
    pending.change[name]();
    held.release();
    // A host stop refused before anything was written reaches the caller as the stop's own refusal; the others are unsent seller calls.
    await assert.rejects(sending, error => name === 'stop' ? error.code === expected : error.answerClass === SELLER_ANSWER_CLASS.NOT_SENT);
    assert.equal(pending.seller.seen.requests.length, 0, `${name}: the request was written while its signing was pending`);

    const waiting = await requestWorld(t);
    waiting.control.onStop = call => { if (call === lastStop) waiting.change[name](); };
    // The connector's refusal before the first byte unwraps the same way for a stop.
    await assert.rejects(waiting.post(), error => name === 'stop' ? error.code === expected && error.answerClass === undefined : error.answerClass === SELLER_ANSWER_CLASS.NOT_SENT);
    assert.equal(waiting.seller.seen.requests.length, 0, `${name}: the request was written after the last check refused`);
    await flush();
    const kept = await waiting.w.requests.records();
    assert.deepEqual(kept.map(record => record.state), ['signed', 'signed-held'], `${name}: the refused transmission keeps its signature, unreleased`);
    assert.equal(kept[1].cause.code, expected);
  }
});

test('a refused last check whose record cannot be saved still writes nothing', async t => {
  const control = await requestWorld(t);
  await assert.rejects(control.post());
  const lastStop = control.control.stopCalls;

  const r = await requestWorld(t);
  r.w.requests.history.append = async () => { throw new Error('TEST-journal-cut'); };
  r.control.onStop = call => { if (call === lastStop) r.change.stop(); };
  await assert.rejects(r.post(), error => error.code === 'writes_stopped' && error.answerClass === undefined);
  assert.equal(r.seller.seen.requests.length, 0);
  assert.deepEqual(await r.states(), []);
});

test('many session-key requests leave the wallet journal as it was, so it never fills with them', async t => {
  const r = await requestWorld(t);
  await assert.rejects(r.post());
  const rows = (await r.w.requests.journal.entries()).length;
  for (let sent = 0; sent < 25; sent++) await assert.rejects(r.post());
  assert.equal(r.seller.seen.requests.length, 26);
  assert.equal((await r.w.requests.journal.entries()).length, rows, 'a request that goes out writes no journal row');
});

test('a wallet message signature whose record is not saved is not released, and a restart finds no release', async t => {
  for (const state of ['signed', 'dispatch-started']) {
    const fault = { state: null };
    const journalWrap = journal => ({ ...journal, appendUnderLock: (lane, key, value) => {
      if (fault.state && key.endsWith(`/${fault.state}`)) throw new Error('TEST-journal-cut');
      return journal.appendUnderLock(lane, key, value);
    }, get: key => journal.get(key), put: (key, value) => journal.put(key, value), entries: () => journal.entries(),
    withWalletLock: (key, work) => journal.withWalletLock(key, work), withOwnedOrAcquiredLane: (lane, work) => journal.withOwnedOrAcquiredLane(lane, work) });
    const m = await messageWorld(t, { journalWrap });
    fault.state = state;
    const answer = await m.sign();
    assert.equal(answer.success, false, `${state}: a signature came back although its record was not saved`);
    assert.equal(answer.data, null);
    assert.equal(m.state.signs, 1);
    const kept = (await m.records()).map(record => record.state);
    assert.deepEqual(kept, state === 'signed' ? [] : ['signed'], `${state}: what the history holds`);
    fault.state = null;
    await m.w.restart();
    assert.ok(!(await m.records()).some(record => record.state === 'dispatch-started'), `${state}: a restart found a release that never happened`);
    const again = await m.sign();
    assert.equal(again.success, true, `${state}: the signature is asked for again; ${causeCodes(m, again)}`);
  }
});

test('a signed request whose answer is lost is retried with the saved body and a fresh signature', async t => {
  const s = await storedWorld(t);
  let sent = 0;
  const answer = await s.client({ respond: init => { if (++sent === 1) throw new Error('TEST-lost-answer'); return s.reply(init); } }).propose(bodyFor(PATHS.proposals));
  assert.deepEqual(answer, { status: 'complete' });
  assert.equal(s.fetches.length, 2);
  assert.equal(s.fetches[0].body, s.fetches[1].body, 'the saved body is sent again');
  assert.notEqual(nonce(s.fetches[0]).nonce, nonce(s.fetches[1]).nonce);
  assert.equal(s.w.state.signs.length, 2, 'each send is signed again');
  assert.equal(await s.w.requests.records().then(records => records.length), 0, 'a request that goes out leaves no record');
});

test('a session-key request authentication and a seller transport are refused without an effect boundary', async t => {
  const w = await wireWorld(t);
  assert.throws(() => w.createSellerWireAuthentication({ ...w.options, effectBoundary: undefined }), { name: 'TypeError', message: /effect_boundary_required/ });
  assert.throws(() => w.createSellerWireAuthentication({ ...w.options, effectBoundary: {} }), { name: 'TypeError', message: /effect_boundary_required/ });
  const resolvers = { authority: 'TEST-wire', sessionSignerFor: () => w.options.sessionSigner, sessionPolicyFor: () => ({ expiresAt: 1 }), endpointProofFor: () => w.endpointProof };
  assert.throws(() => createSourceDemoSellerTransport(resolvers), { name: 'TypeError', message: /effect boundary/ });
  assert.ok(createSourceDemoSellerTransport({ ...resolvers, effectBoundary: w.options.effectBoundary }));
});
