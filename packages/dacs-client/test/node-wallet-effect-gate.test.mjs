import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { agreementRequest, api, mnemonicBytes, ok, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import { causeChain } from './helpers/node-wallet-signing-spy.mjs';
import { assertFenceFree, FEE_CEILING_OS, gateWorld, microtaskMarker, openPass, sellerPublications } from './helpers/effect-gate-world.mjs';
import { confirmThroughFacade, listingCreate, retainAcceptedCreate, signedTransaction, signingWallet } from './helpers/seller-facade-confirm.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';

const PHASES = ['sign', 'confirmTx', 'broadcastTx'];
const SENTINEL_CODE = 'TEST_SENTINEL';
const sentinel = () => Object.assign(new Error('TEST-sentinel'), { code: SENTINEL_CODE });
const answerWith = value => new Response(JSON.stringify(ok(value)), { headers: { 'content-type': 'application/json' } });
const causesOf = (w, result) => causeChain(w.session.internalCauseOf(result));
const nativeRequest = (w, amountOs = '2500000000') => ({ method: 'sendTransaction', params: [buildNativeTransferPayload({
  from: w.session.wallet.getPublicAccount().address, to: '0x' + '2'.repeat(64), amountOs, nonce: 1, timestamp: T0, encoding: 'os-string' })] });
const sendNative = (w, amountOs) => w.session.wallet.request(nativeRequest(w, amountOs));
const sendAnchor = async w => w.session.wallet.request(await agreementRequest(w));
// Answers the identity, absence and confirmation reads a storage recovery makes for a transaction the node has never seen.
const scriptedRecoveryNode = w => row => {
  const call = row.body.params[0], message = call.message ?? call.extra;
  const json = answer => new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
  const reply = (response, extra = null) => json({ result: 200, response, require_reply: false, extra });
  if (message === 'getBlockByNumber' && call.data.blockNumber === 0) return reply({ number: 0, status: 'confirmed', hash: w.admission.binding.profile.chainIdentity }, '');
  if (message === 'getTransactionStatus') return reply({ state: 'unknown' }, '');
  if (message === 'getTxByHash') return json({ result: 400, response: 'error', require_reply: false, extra: null });
  if (message !== 'confirmTx') return undefined;
  w.node.confirms.push(structuredClone(call.data));
  return reply({ data: { valid: true, reference_block: 0, message: 'TEST validated', gas_operation: null, transaction: call.data },
    signature: { type: 'ed25519', data: '0x' + '11'.repeat(64) }, rpc_public_key: { type: 'ed25519', data: '0x' + '22'.repeat(32) } });
};
const answerNetworkFee =(w, networkFee) => { w.node.intercept = row => (row.body.params[0].message === 'getNetworkParameters' ? answerWith({ networkFee, rpcFee: 0, additionalFee: 0 }) : undefined); };
const refusedBeforeEffect = (w, result, code) => {
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
  assert.equal(w.signsInsideSign, 0, 'no inner signature');
  assert.equal(w.node.confirms.length + w.node.broadcasts.length, 0, 'nothing transmitted');
};
// A seller whose qualify runs `onQualify(phase)` and then reports the connection it observed.
async function qualifiedWorld(t, onQualify = () => {}) {
  let w;
  const qualify = async ({ phase }) => { await onQualify(phase); return w.currentOwner().local.connectionId; };
  w = await gateWorld(t, { qualify });
  return w;
}
// Records the finalized debit the session's finalContent reports for each signature.
function captureDebits(t, w) {
  const debits = [], sign = w.nodeDemosPrototype.sign;
  t.mock.method(w.nodeDemosPrototype, 'sign', async function captureDebit(rawTx, options) {
    const signed = await Reflect.apply(sign, this, [rawTx, options]);
    debits.push(options.finalContent(signed.content));
    return signed;
  });
  return debits;
}
function replaceFinalContent(t, w, finalContent) {
  const sign = w.nodeDemosPrototype.sign;
  t.mock.method(w.nodeDemosPrototype, 'sign', function replaceDebit(rawTx, options) { return Reflect.apply(sign, this, [rawTx, { ...options, finalContent }]); });
}

test("after SDK preparation one gate pass runs optional qualify, then its fresh authority check under the held fence, then finalStop, then synchronous checks and the inner crypto signature or real fetch with no intervening await", async t => {
  const events = [], marks = {}, effects = [];
  const w = await qualifiedWorld(t, phase => { events.push('qualify:' + phase); });
  const effect = (name, phase) => { effects.push([phase, events.at(-1) === 'sync:' + phase, marks[phase].turned]); events.push(name); };
  const pushSign = w.innerSigns.push.bind(w.innerSigns);
  w.innerSigns.push = message => { if (events.at(-1) === 'sync:sign') effect('signature', 'sign'); return pushSign(message); };
  w.node.intercept = row => {
    const call = row.body.params[0];
    if (row.body.method === 'nodeCall') events.push('read:' + call.message); else effect('fetch:' + call.extra, call.extra);
  };
  const synchronousChecks = [({ phase }) => { events.push('sync:' + phase); marks[phase] = microtaskMarker(); }];
  const pass = await openPass(w, { events, pass: { synchronousChecks } });
  const result = await pass.run(() => w.send());
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(events.filter(event => !event.startsWith('read:')), PHASES.flatMap(phase => [`qualify:${phase}`, `authority:${phase}`, `stop:${phase}`, `sync:${phase}`, phase === 'sign' ? 'signature' : `fetch:${phase}`]));
  assert.ok(events.indexOf('read:getNetworkParameters') < events.indexOf('qualify:sign'), 'the SDK finished its preparation reads first');
  assert.ok(!events.slice(events.indexOf('qualify:sign'), events.indexOf('signature')).some(event => event.startsWith('read:')), 'no read inside the gate');
  assert.deepEqual(effects, PHASES.map(phase => [phase, true, false]), 'each effect ran in the same synchronous run as its last check');
});

test("a barrier inside qualify flips the hold or replaces currentLocal: a refusal at the signature leaves signer 0; a refusal at transmission transmits 0, keeps the signed bytes and reports not_dispatched", async t => {
  const flips = {
    hold: { code: 'profile_not_admitted', flip: () => setPurchaseAdmission('held') },
    local: { code: 'tp1_local_binding_changed', flip: w => w.currentOwner().replaceLocal({ ...w.currentOwner().local, connectionId: 'TEST-replaced' }) },
  };
  for (const [change, { code, flip }] of Object.entries(flips)) {
    const atSignature = await qualifiedWorld(t, phase => { if (phase === 'sign') flip(atSignature); });
    refusedBeforeEffect(atSignature, await (await openPass(atSignature)).run(() => atSignature.send()), code);
    const atBroadcast = await qualifiedWorld(t, phase => { if (phase === 'broadcastTx') flip(atBroadcast); });
    const result = await (await openPass(atBroadcast)).run(() => atBroadcast.send());
    assert.equal(atBroadcast.node.broadcasts.length, 0, change);
    assert.equal(atBroadcast.node.confirms.length, 1, change);
    assert.ok(causesOf(atBroadcast, result).some(error => error.code === code), change);
    assert.equal(causesOf(atBroadcast, result).find(error => error.stage)?.stage, 'not_dispatched', change);
    assert.equal((await atBroadcast.lane()).signedTransaction.hash, atBroadcast.node.confirms[0].hash, 'the signed bytes stay retained');
  }
  for (const observed of ['TEST-observed-elsewhere', undefined]) {
    const w = await gateWorld(t, { qualify: async () => observed });
    refusedBeforeEffect(w, await (await openPass(w)).run(() => w.send()), 'tp1_local_binding_changed');
  }
});

test("qualification, authority and final stop share the remaining aggregate deadline; a late result at any step refuses with signer 0 or transport 0 and releases the fence", async t => {
  const scenarios = [
    { name: 'qualify', spend: { qualify: 10_001 }, code: 'deployment_unqualified', ran: ['qualify:sign'] },
    { name: 'authority', spend: { qualify: 4_000, authority: 6_001 }, code: 'tp1_authority_timeout', ran: ['qualify:sign', 'authority:sign'] },
    { name: 'stop', spend: { qualify: 4_000, authority: 4_000, stop: 2_001 }, code: 'stop_check_timeout', ran: ['qualify:sign', 'authority:sign', 'stop:sign'] },
  ];
  for (const { name, spend, code, ran } of scenarios) {
    let now = T0;
    const events = [], advance = (step, phase) => { events.push(`${step}:${phase}`); now += spend[step] ?? 0; };
    const w = await qualifiedWorld(t, phase => advance('qualify', phase));
    w.clock.now = () => now;
    const pass = await openPass(w, { events: [], pass: { refreshAuthority: ({ phase }) => advance('authority', phase), finalStop: ({ phase }) => advance('stop', phase), synchronousChecks: [() => events.push('sync')] } });
    refusedBeforeEffect(w, await pass.run(() => w.send()), code);
    assert.deepEqual(events, ran, `${name}: no step after the late one, no synchronous check`);
    await assertFenceFree(w.currentOwner());
  }
  for (const [step, code] of [['qualify', 'deployment_unqualified'], ['authority', 'tp1_authority_timeout'], ['stop', 'stop_check_timeout']]) {
    let now = T0;
    const stall = () => new Promise(() => {});
    const w = await qualifiedWorld(t, phase => (step === 'qualify' ? stall() : (now += 4_000, phase)));
    w.clock.now = () => now;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pass = await openPass(w, { pass: { refreshAuthority: () => (step === 'authority' ? stall() : undefined), finalStop: () => (step === 'stop' ? stall() : undefined) } });
    const pending = pass.run(() => w.send());
    while (!(await Promise.race([pending, new Promise(resolve => setImmediate(resolve, null))]))) t.mock.timers.tick(step === 'qualify' ? 10_000 : 6_000);
    refusedBeforeEffect(w, await pending, code);
    t.mock.timers.reset();
    await assertFenceFree(w.currentOwner());
  }
});

test("only the transaction-hash signature inside sign and confirmTx/broadcastTx execute bodies, the recovery raw() included, are gated; RPC-authentication header signatures and read bodies pass through, and the SDK's preparation reads finish before the gated signature", async t => {
  const events = [], reads = [];
  const w = await qualifiedWorld(t);
  w.node.intercept = row => { if (row.body.method === 'nodeCall') reads.push(row.body.params[0].message); };
  const result = await (await openPass(w, { events })).run(() => w.send());
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(events.filter(event => event.startsWith('authority:')), PHASES.map(phase => `authority:${phase}`));
  assert.equal(w.signsInsideSign, 1, 'one gated transaction-hash signature');
  assert.ok(w.innerSigns.length >= 3, 'the RPC-authentication signatures passed through ungated');
  assert.ok(reads.includes('getNetworkParameters') && reads.includes('getNetworkInfo'), 'read bodies passed through');
  const facade = await qualifiedWorld(t), wallet = await signingWallet(facade), tx = signedTransaction(wallet, facade.request.params[0]);
  const confirmEvents = [], { answer } = await (await openPass(facade, { events: confirmEvents })).run(() => confirmThroughFacade(facade, wallet, tx));
  assert.equal(answer.response.data.valid, true);
  assert.deepEqual(confirmEvents, ['authority:confirmTx', 'stop:confirmTx', 'sync:confirmTx'], 'a facade execute body is gated by the same pass');
  const recovery = await qualifiedWorld(t), signer = await signingWallet(recovery), create = listingCreate(recovery, signer), recoveryEvents = [];
  await retainAcceptedCreate(recovery, signer, create);
  recovery.node.intercept = scriptedRecoveryNode(recovery);
  const signRpc = async message => signer.signBytes(Buffer.from(message)).toString('hex');
  const outcome = await (await openPass(recovery, { events: recoveryEvents })).run(() => recovery.session.transport.recoverStorageWrite({ signedTransaction: create, signRpc }));
  assert.equal(outcome.disposition, 'pending');
  assert.deepEqual(recoveryEvents, ['confirmTx', 'broadcastTx'].flatMap(phase => ['authority', 'stop', 'sync'].map(step => `${step}:${phase}`)), 'the recovery raw() confirmTx and broadcastTx run through the same pass');
  assert.deepEqual([recovery.node.confirms.length, recovery.node.broadcasts.length], [1, 1]);
});

test("a seller signature or execute transmission with no current pass refuses effect_pass_required; signer 0 and transport 0", async t => {
  const w = await qualifiedWorld(t);
  refusedBeforeEffect(w, await w.send(), 'effect_pass_required');
  const facade = await qualifiedWorld(t), wallet = await signingWallet(facade), tx = signedTransaction(wallet, facade.request.params[0]);
  await assert.rejects(confirmThroughFacade(facade, wallet, tx), error => causeChain(error).some(cause => cause.code === 'effect_pass_required'));
  assert.equal(facade.node.confirms.length, 0);
});

test("a plain copy of a pass handle, another composition's handle, or a handle whose fence lease was released is refused effect_pass_invalid; signer 0", async t => {
  const w = await qualifiedWorld(t), other = await qualifiedWorld(t);
  const released = await openPass(w);
  await released.run(async () => {});
  const own = await openPass(w), foreign = await openPass(other);
  const handles = { 'a spread copy': { ...own.handle }, 'a parsed copy': JSON.parse(JSON.stringify(own.handle)), 'a null-prototype copy': Object.assign(Object.create(null), own.handle),
    'another composition': foreign.handle, 'a released lease': released.handle, 'no handle': undefined };
  for (const [name, handle] of Object.entries(handles)) {
    const result = await w.session.runInEffectPass(handle, () => w.send());
    refusedBeforeEffect(w, result, name === 'no handle' ? 'effect_pass_required' : 'effect_pass_invalid');
  }
  await own.run(async () => {});
  await foreign.run(async () => {});
  const lapsing = await openPass(w, { pass: { finalStop: async () => lapsing.lease.release() } });
  refusedBeforeEffect(w, await lapsing.run(() => w.send()), 'effect_pass_invalid');
});

test("no request field, environment variable or per-call option adds, removes or replaces qualify, refreshAuthority, finalStop or a synchronous check", async t => {
  const decoys = [];
  const decoy = name => () => { decoys.push(name); };
  const smuggled = { qualify: decoy('qualify'), refreshAuthority: decoy('authority'), finalStop: decoy('stop'), synchronousChecks: [decoy('sync')], feeCeilingOs: '1000000000000', effectPass: decoy('effectPass'), skipGate: true };
  const env = { DACS_SKIP_EFFECT_GATE: '1', DACS_FEE_CEILING_OS: '1000000000000', DACS_QUALIFY: 'off' };
  Object.assign(process.env, env);
  t.after(() => { for (const name of Object.keys(env)) delete process.env[name]; });
  const w = await qualifiedWorld(t);
  const withExtras = { ...w.request, ...smuggled };
  refusedBeforeEffect(w, await w.session.wallet.request(withExtras, smuggled), 'effect_pass_required');
  const events = [], pass = await openPass(w, { events, pass: { feeCeilingOs: '1' } });
  refusedBeforeEffect(w, await pass.run(() => w.session.wallet.request(withExtras, smuggled)), 'write-fee-cap');
  assert.deepEqual(events, ['authority:sign', 'stop:sign', 'sync:sign'], "the pass's own steps ran; the smuggled ones did not");
  assert.deepEqual(decoys, []);
});

test("inside a pass, RPC-authentication header signatures reuse its fence lease and are not gated, and the gate acquires no fence", async t => {
  const events = [], buyer = await gateWorld(t, { seller: false });
  await (await openPass(buyer, { events })).run(async () => assert.equal((await buyer.send()).success, true));
  const inside = buyer.currentOwner().acquisitions();
  const plain = await gateWorld(t, { seller: false });
  assert.equal((await plain.send()).success, true);
  assert.equal(inside, plain.currentOwner().acquisitions() + 1, "the pass's own acquisition is the only extra one: the gate and the nested steps acquire none beyond the plain flow");
  assert.deepEqual(events.filter(event => event.startsWith('authority:')), PHASES.map(phase => `authority:${phase}`));
  assert.ok(buyer.innerSigns.length > 1 && buyer.signsInsideSign === 1, 'authentication signatures ran inside the pass, ungated');
});

test("a missing or non-function refreshAuthority refuses effect_pass_invalid; a failing authority callback invokes no signer or fetch, keeps its cause and releases the owning fence", async t => {
  const w = await qualifiedWorld(t), lease = await w.currentOwner().acquireConnectionFence();
  const base = { fence: lease, deadline: T0 + 1000, refreshAuthority: async () => {}, finalStop: async () => {}, synchronousChecks: [], feeCeilingOs: FEE_CEILING_OS };
  const invalid = error => error.code === 'effect_pass_invalid';
  assert.equal(typeof w.session.effectPass(base), 'object');
  for (const refreshAuthority of [undefined, null, 'authority', {}, 7]) assert.throws(() => w.session.effectPass({ ...base, refreshAuthority }), invalid);
  for (const patch of [{ finalStop: undefined }, { synchronousChecks: [() => {}, 'check'] }, { synchronousChecks: undefined }, { fence: { ...lease } }, { fence: undefined },
    { feeCeilingOs: '0' }, { feeCeilingOs: '01' }, { feeCeilingOs: 50 }, { feeCeilingOs: '-1' }, { deadline: T0 }, { deadline: T0 + 10_001 }, { deadline: '1' }, { deadline: NaN }]) {
    assert.throws(() => w.session.effectPass({ ...base, ...patch }), invalid, JSON.stringify(patch));
  }
  assert.throws(() => w.session.runInEffectPass(w.session.effectPass(base), 'work'), { code: 'invalid_params' });
  lease.release();
  const construction = { admission: w.admission, owner: w.owner, journal: w.journal(), approve: async () => true, clock: w.clock };
  for (const value of ['nope', null, {}, 7]) {
    const key = mnemonicBytes();
    await assert.rejects(api.createNodeSellerComposition({ ...construction, key, approveConfirmedWrite: null, publications: sellerPublications(), qualify: value }), { code: 'invalid_params' });
    assert.ok(key.every(byte => byte === 0), 'the key is zeroed on refusal');
  }
  await assert.rejects(api.createNodeWalletSession({ ...construction, key: mnemonicBytes(), qualify: async () => 0 }), { code: 'invalid_params' });
  const failure = sentinel(), pass = await openPass(w, { pass: { refreshAuthority: async () => { throw failure; } } });
  const result = await pass.run(() => w.send());
  refusedBeforeEffect(w, result, SENTINEL_CODE);
  assert.ok(causesOf(w, result).includes(failure), 'the callback error is kept as the cause');
  await assertFenceFree(w.currentOwner());
});

test("native sends and session anchors through the real SDK preparation seam: revoke a participant or change the observed chain on the same local generation during preparation; the fresh authority check refuses with inner signatures 0 and the fence released; the buyer runs this without qualify", async t => {
  const changes = { chain: ['tp1_connection_unverified', state => { state.chainIdentity = 'e'.repeat(64); }], participants: ['tp1_participant_profile_mismatch', state => { state.participants = 1; }] };
  for (const seller of [true, false]) for (const send of [sendNative, sendAnchor]) for (const [change, [code, apply]] of Object.entries(changes)) {
    const w = seller ? await qualifiedWorld(t) : await gateWorld(t, { seller: false }), request = send === sendAnchor ? await agreementRequest(w) : nativeRequest(w);
    let changed = false;
    w.node.intercept = row => { if (!changed && row.body.params[0].message === 'getNetworkParameters') { changed = true; apply(w.authority.state); } };
    const refreshAuthority = () => assertTp1Binding(w.admission.binding, w.currentOwner().currentLocal());
    const result = await (await openPass(w, { pass: { refreshAuthority } })).run(() => w.session.wallet.request(request));
    assert.ok(changed, 'the change happened during preparation');
    assert.equal(result.error?.code, code, `${seller ? 'seller' : 'buyer'} ${send.name} ${change}: ${JSON.stringify(result)}`);
    assert.equal(w.signsInsideSign, 0);
    assert.equal(w.node.confirms.length, 0);
    await assertFenceFree(w.currentOwner());
  }
});

test("CREATE fees and total debit exactly 50 DEM sign once; 50 DEM plus one OS refuses before the inner signature", async t => {
  for (const [ceilingOs, signs] of [[FEE_CEILING_OS, 1], [String(BigInt(FEE_CEILING_OS) - 1n), 0]]) {
    const w = await qualifiedWorld(t), debits = captureDebits(t, w);
    answerNetworkFee(w, 48);
    const result = await (await openPass(w, { pass: { feeCeilingOs: ceilingOs } })).run(() => sendAnchor(w));
    if (signs) {
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(debits, [{ totalDebitOs: FEE_CEILING_OS, feeDebitOs: FEE_CEILING_OS }]);
      assert.equal(w.signsInsideSign, 1);
    } else refusedBeforeEffect(w, result, 'write-fee-cap');
  }
});

test("with the approval revision still current, a finalized debit that differs from the approved request refuses before the inner signature; inner signatures 0", async t => {
  const approval = { revision: 1 }, events = [];
  const w = await qualifiedWorld(t);
  let reads = 0;
  w.node.intercept = row => (row.body.params[0].message === 'getNetworkParameters' && ++reads > 1 ? answerWith({ networkFee: 60, rpcFee: 0, additionalFee: 0 }) : undefined);
  const synchronousChecks = [() => { events.push('approval'); if (approval.revision !== 1) throw new Error('approval closed'); }];
  const result = await (await openPass(w, { pass: { synchronousChecks } })).run(() => w.send());
  assert.deepEqual(events, ['approval'], 'the approval revision was still current');
  refusedBeforeEffect(w, result, 'payload_mismatch');
});

test("through the real native session finalContent, an approved price of 50 DEM plus 1 DEM fees signs once; full debit is 51 DEM and fee debit is 1 DEM", async t => {
  const w = await qualifiedWorld(t), debits = captureDebits(t, w);
  answerNetworkFee(w, 0);
  const result = await (await openPass(w)).run(() => sendNative(w, '50000000000'));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(debits, [{ totalDebitOs: '51000000000', feeDebitOs: '1000000000' }]);
  assert.equal(w.signsInsideSign, 1);
});

test("with a nonzero separately approved native price, approved fees exactly 50 DEM sign and approved fees 50 DEM plus one OS refuse before the inner signature", async t => {
  for (const [ceilingOs, signs] of [[FEE_CEILING_OS, 1], [String(BigInt(FEE_CEILING_OS) - 1n), 0]]) {
    const w = await qualifiedWorld(t), debits = captureDebits(t, w);
    answerNetworkFee(w, 49);
    const result = await (await openPass(w, { pass: { feeCeilingOs: ceilingOs } })).run(() => sendNative(w));
    if (signs) {
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(debits, [{ totalDebitOs: '52500000000', feeDebitOs: FEE_CEILING_OS }], 'the 2.5 DEM price is in the total, not in the compared fee');
    } else refusedBeforeEffect(w, result, 'write-fee-cap');
  }
});

test("a native seller amount changed after exact approval refuses before the inner signature even when fees remain below 50 DEM; malformed or inconsistent total and fee components also refuse", async t => {
  const { Demos } = await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos(), original = Demos.prototype.sign;
  t.mock.method(Demos.prototype, 'sign', function changeAmount(rawTx, options) {
    rawTx.content.amount = '2500000001';
    return Reflect.apply(original, this, [rawTx, options]);
  });
  const changed = await qualifiedWorld(t);
  refusedBeforeEffect(changed, await (await openPass(changed)).run(() => changed.send()), 'payload_mismatch');
  Demos.prototype.sign.mock.restore();
  const malformed = [{ totalDebitOs: '1.5', feeDebitOs: '1' }, { totalDebitOs: '5', feeDebitOs: '6' }, { totalDebitOs: '5' }, { totalDebitOs: 5, feeDebitOs: 1 }, { totalDebitOs: '05', feeDebitOs: '1' }, null, 'debit'];
  for (const debit of malformed) {
    const w = await qualifiedWorld(t);
    replaceFinalContent(t, w, () => debit);
    refusedBeforeEffect(w, await (await openPass(w)).run(() => w.send()), 'payload_mismatch');
  }
});

test("a sentinel error thrown inside qualify, refreshAuthority, finalStop or a synchronous check reaches the session's caller with its own code and the sentinel as cause, not sdk_error", async t => {
  const failure = sentinel(), fail = () => { throw failure; };
  const places = { qualify: [fail, {}], refreshAuthority: [undefined, { refreshAuthority: fail }], finalStop: [undefined, { finalStop: fail }], 'a synchronous check': [undefined, { synchronousChecks: [fail] }] };
  for (const [place, [qualify, pass]] of Object.entries(places)) {
    const w = await qualifiedWorld(t, qualify ? () => fail() : undefined);
    const result = await (await openPass(w, { pass })).run(() => w.send());
    refusedBeforeEffect(w, result, SENTINEL_CODE);
    assert.ok(causesOf(w, result).includes(failure), place);
  }
  const atTransmission = await qualifiedWorld(t, phase => { if (phase === 'confirmTx') fail(); });
  const result = await (await openPass(atTransmission)).run(() => atTransmission.send());
  assert.ok(causesOf(atTransmission, result).includes(failure), 'a transmission refusal keeps the sentinel too');
  assert.equal(atTransmission.node.confirms.length, 0);
});

test("the export inventory doc lists effectPass and runInEffectPass with their inputs and refusals, and equals the composition's members", async t => {
  const doc = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rowNames = prefix => [...doc.split('\n').find(line => line.startsWith(prefix)).matchAll(/`(\w+)`/g)].map(match => match[1]).sort();
  const seller = await qualifiedWorld(t), buyer = await gateWorld(t, { seller: false });
  assert.deepEqual(rowNames('| Seller composition members |'), Object.keys(seller.session).sort());
  assert.deepEqual(rowNames('| Buyer composition members |'), Object.keys(buyer.session).sort());
  for (const word of ['effectPass', 'runInEffectPass', 'qualify', 'refreshAuthority', 'finalStop', 'synchronousChecks', 'feeCeilingOs', 'fence', 'deadline',
    'effect_pass_required', 'effect_pass_invalid', 'invalid_params', 'admitTp1Authority', 'tp1AuthorityLabel', 'authorityLabelOf', 'isTp1AuthorityToken']) assert.ok(doc.includes('`' + word + '`'), word);
});

test("second job closes approval during final authority await and inner effect is never called", async t => {
  for (const closingPhase of ['sign', 'broadcastTx']) {
    const approval = { open: true }, w = await qualifiedWorld(t);
    const closed = Object.assign(new Error('TEST-approval-closed'), { code: 'context_admission_closed' });
    const refreshAuthority = async ({ phase }) => { if (phase === closingPhase) { await new Promise(setImmediate); approval.open = false; } };
    const synchronousChecks = [() => { if (!approval.open) throw closed; }];
    const result = await (await openPass(w, { pass: { refreshAuthority, synchronousChecks } })).run(() => w.send());
    if (closingPhase === 'sign') refusedBeforeEffect(w, result, 'context_admission_closed');
    else { assert.ok(causesOf(w, result).some(error => error.code === 'context_admission_closed')); assert.equal(w.node.broadcasts.length, 0); }
  }
});

test("serialized old pass cannot authorize a reopened composition", async t => {
  const w = await qualifiedWorld(t), old = await openPass(w);
  const serialized = JSON.parse(JSON.stringify(old.handle));
  await w.restart();
  for (const handle of [old.handle, serialized]) {
    const result = await w.session.runInEffectPass(handle, () => w.send());
    assert.equal(result.error?.code, 'effect_pass_invalid', JSON.stringify(result));
    assert.equal(w.node.confirms.length + w.node.broadcasts.length, 0);
  }
  await old.run(async () => {});
});

test("kill after gate refusal before withheld append preserves earlier dispatch history", async t => {
  const w = await qualifiedWorld(t, phase => { if (phase === 'broadcastTx') throw sentinel(); });
  await (await openPass(w)).run(() => w.send());
  const before = await w.lane();
  assert.equal(before.stage, 'broadcast-started', 'the lane still records the dispatch intent it wrote before the refusal');
  assert.equal(w.node.broadcasts.length, 0);
  await w.restart();
  assert.deepEqual(await w.lane(), before, 'a process death here leaves the earlier intent untouched: the artifact stays possibly dispatched');
  const recovery = await qualifiedWorld(t), signer = await signingWallet(recovery), create = listingCreate(recovery, signer);
  await retainAcceptedCreate(recovery, signer, create);
  recovery.node.intercept = scriptedRecoveryNode(recovery);
  const finalStop = ({ phase }) => { if (phase === 'broadcastTx') throw sentinel(); };
  await (await openPass(recovery, { pass: { finalStop } })).run(() => recovery.session.transport.recoverStorageWrite({ signedTransaction: create, signRpc: async message => signer.signBytes(Buffer.from(message)).toString('hex') }));
  assert.equal(recovery.node.broadcasts.length, 0);
  assert.equal((await recovery.lane()).storageWriteResends, 1, "the recovery's reserved single resend stays consumed after the refusal, so no later pass resends");
});

test("reopen signed-held transaction without automatic transmission", async t => {
  let allow = false;
  const w = await qualifiedWorld(t, phase => { if (phase === 'broadcastTx' && !allow) throw sentinel(); });
  await (await openPass(w)).run(() => w.send());
  const held = await w.lane();
  await w.restart();
  allow = true;
  await new Promise(setImmediate);
  assert.equal(w.node.broadcasts.length, 0, 'nothing is transmitted on reopen, although the checks would now pass');
  const again = await (await openPass(w)).run(() => w.send());
  assert.equal(w.node.broadcasts.length, 0, JSON.stringify(again));
  assert.equal((await w.lane()).signedTransaction.hash, held.signedTransaction.hash, 'the retained bytes are unchanged');
});
