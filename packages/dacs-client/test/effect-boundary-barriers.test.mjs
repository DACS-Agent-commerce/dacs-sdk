import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { bindTp1Profile, TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_CAPABILITIES, signDiscoveryDocument, verifyEndpointProof, signWireRequest } from '@kynesyslabs/dacs/wire';
import { boundaryWorld, setPurchaseAdmission, flush, code, signedBytes, states, cutAppend, noEffects } from './helpers/effect-boundary-fixture.mjs';

const changes = {
  reconnect: w => { w.current.connectionId = 'TEST-bypass'; },
  stop: w => { w.stopped = true; },
  hold: () => setPurchaseAdmission('held'),
  revision: w => { w.revision++; },
  approval: w => { w.approval = { rev: 2, open: false }; },
};
const codes = { reconnect: 'tp1_local_binding_changed', stop: 'writes_stopped', hold: 'profile_not_admitted', revision: 'context_admission_closed', approval: 'write-fee-cap' };

test("at the fence wait, the final authority read and the final stop read, a fenced replacement, a bypassing reconnect, a stop, a hold flip, a revision change or a closed approval signs nothing", async t => {
  for (const barrier of ['fence', 'authority', 'stop']) for (const [change, mutate] of Object.entries(changes)) {
    const w = await boundaryWorld(t);
    let release, entered;
    if (barrier === 'fence') {
      const holding = w.fence.withFence('TEST-holder', () => new Promise(resolve => { release = resolve; }));
      await flush();
      const result = w.sign(); await flush(); mutate(w); release(); await holding;
      await noEffects(w, result, codes[change]); continue;
    }
    const reached = new Promise(resolve => { entered = resolve; });
    let checks = 0;
    if (barrier === 'authority') w.authority.state.gate = async () => { if (++checks === 2) { entered(); await new Promise(resolve => { release = resolve; }); } };
    else w.resetBoundary({ stopped: async () => { if (++checks === 3) { entered(); await new Promise(resolve => { release = resolve; }); } return w.stopped; } });
    const result = w.sign(); await reached; mutate(w); release();
    await noEffects(w, result, codes[change]);
  }
  const w = await boundaryWorld(t);
  let release;
  const holder = w.fence.withFence('TEST-holder', () => new Promise(resolve => { release = resolve; })); await flush();
  const replacement = w.boundary.replaceConnection(() => { w.current.connectionId = 'TEST-replaced'; });
  const pending = w.sign(); await flush(); release(); await holder; await replacement;
  await noEffects(w, pending, 'tp1_local_binding_changed');
});

test("inside the authority read after persistence and the dispatch intent write, the same changes hold or withhold the signed bytes and transmit nothing", async t => {
  for (const barrier of ['signed', 'dispatch']) for (const [change, mutate] of Object.entries(changes)) {
    const w = await boundaryWorld(t);
    if (barrier === 'signed') { let reads = 0; w.authority.state.gate = async () => { if (++reads === 3) mutate(w); }; }
    else cutAppend(w, 'dispatch-started', { mutate: () => mutate(w) });
    await assert.rejects(w.run(), code(codes[change]));
    assert.equal(w.signatures, 1); assert.equal(w.sent.length, 0); assert.equal(w.held, false);
    const records = (await w.journal.entries()).filter(([key]) => key.startsWith('eb/')).map(([, value]) => value);
    const last = records.at(-1);
    assert.equal(last.state, barrier === 'signed' ? 'signed-held' : 'dispatch-withheld');
    assert.equal(last.cause.code, codes[change]);
    const artifact = { ...w.op, artifactHash: last.artifactHash };
    w.reopen(); setPurchaseAdmission('testnet-tp1'); w.stopped = false;
    assert.deepEqual(await states(w, artifact), records.map(record => record.state));
  }
});

test("a withheld artifact is not transmitted after restart and stop removal; a new explicit pass transmits the retained bytes once", async t => {
  const w = await boundaryWorld(t);
  cutAppend(w, 'dispatch-started', { mutate: () => { w.stopped = true; } });
  await assert.rejects(w.run(), code('writes_stopped'));
  const records = (await w.journal.entries()).filter(([key]) => key.startsWith('eb/')).map(([, value]) => value);
  const artifact = { ...w.op, artifactHash: records[0].artifactHash };
  w.reopen(); w.stopped = false;
  await assert.rejects(w.send(artifact), code('eb_explicit_resume_required'));
  await w.send(artifact, { explicit: true });
  await assert.rejects(w.send(artifact, { explicit: true }), code('eb_readback_required'));
  assert.deepEqual(w.sent, [signedBytes]); assert.equal(w.signatures, 1);

  // A closed revision cannot be revived by any explicit pass.
  const closed = await boundaryWorld(t), signed = await closed.sign();
  cutAppend(closed, 'dispatch-started', { mutate: () => { closed.revision = 2; } });
  await assert.rejects(closed.send(signed), code('context_admission_closed'));
  closed.reopen();
  await assert.rejects(closed.send(signed, { explicit: true }), code('context_admission_closed'));
  assert.equal(closed.sent.length, 0);

  // A later withheld replay never erases an earlier possible dispatch.
  const unknown = await boundaryWorld(t), retained = await unknown.sign();
  await unknown.history.append({ ...retained, passId: 'TEST-prior', state: 'dispatch-started' });
  await unknown.history.append({ ...retained, passId: 'TEST-replay', state: 'dispatch-started' });
  await unknown.history.append({ ...retained, passId: 'TEST-replay', state: 'dispatch-withheld' });
  unknown.reopen();
  await assert.rejects(unknown.send(retained, { explicit: true }), code('eb_readback_required'));
  assert.equal(unknown.sent.length, 0);
});

test("a fenced replacement during a pass waits; the pass completes on the bound connection and the next pass binds again", async t => {
  const w = await boundaryWorld(t);
  let replace, changed = false;
  const inner = w.sign;
  w.sign = async op => { const result = await inner(op); replace = w.boundary.replaceConnection(() => { changed = true; w.current.connectionId = 'TEST-next-connection'; }); assert.equal(changed, false); return result; };
  await w.run(); await replace;
  assert.equal(changed, true); assert.equal(w.sent.length, 1); assert.equal(w.fence.connectionGeneration, 1);
  w.sign = inner;
  await assert.rejects(w.sign(), code('tp1_local_binding_changed'));
  w.binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: w.currentLocal(), readAuthority: w.authority.read });
  w.resetBoundary();
  await w.run({ ...w.op, operationId: 'TEST-next', lane: 'TEST-next' });
  assert.equal(w.sent.length, 2);
});

function party() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { claim: 'did:demos:agent:' + publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), sign: bytes => sign(null, bytes, privateKey) };
}
async function requestFixture(w) {
  const seller = party(), buyer = party(), now = 1000, jobId = '01K7FZ8Q9W3V5T2R1N0M8K6J4H';
  const listingPin = { listingId: 'TEST-listing', version: 1, contentHash: 'b'.repeat(64) }, publicEndpoint = 'https://seller.example.invalid';
  let onJob = () => {};
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: w.currentLocal(), readAuthority: async scope => {
    if (scope.sessionId === jobId) onJob();
    return { local: scope.local, chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-source', sessionId: scope.sessionId,
      participants: scope.participants.map(claim => ({ claim, profile: binding.profile, modules: TESTNET_PROFILE_TP1.tuple })) };
  } });
  // The callback is invoked only with no participants during binding construction.
  w.binding = binding; w.resetBoundary();
  const document = await signDiscoveryDocument({ format: 'dacs-seller-discovery/v1', profile: binding.profile, seller: seller.claim, publicEndpoint,
    transport: ['dacs-seller-http/v1'], listings: [listingPin], capabilities: TP1_CAPABILITIES, ready: true, issuedAt: now, expiresAt: now + 60000 }, seller, binding, w.currentLocal());
  const endpointProof = await verifyEndpointProof(document, { listing: { seller: seller.claim, publicEndpoint, listingPin }, binding, local: w.currentLocal(), now,
    readListingEligibility: ({ seller: claim, publicEndpoint: endpoint, listingPin: pin }) => ({ seller: claim, publicEndpoint: endpoint, listingPin: pin, pricingKind: 'fixed', negotiation: 'negotiate-fixed-price', commitPhase: 'commit-payee-bound-agreement', rail: 'pay-dem',
      delivery: TP1_CAPABILITIES.delivery, service: { kind: 'fixed-text' }, output: TP1_CAPABILITIES.output, buyerRequestInput: false, notBefore: 0, expiresAt: 100000 }) });
  return { buyer, onJob: fn => { onJob = fn; }, input: { binding, local: w.currentLocal(), path: '/dacs/v1/commitments', jobId, text: JSON.stringify({ jobId }), seller: seller.claim,
    job: { listingPin, agreementHash: 'c'.repeat(64), profile: binding.profile }, now, endpointProof, publicEndpoint } };
}

test("signWireRequest given the boundary signer refuses a stop or a hold flip at the authority read before signer.sign", async t => {
  for (const change of ['stop', 'hold']) {
    const w = await boundaryWorld(t), fixture = await requestFixture(w);
    let jobReads = 0;
    fixture.onJob(() => { jobReads++; changes[change](w); });
    const signer = w.boundary.signerFor(w.op, { claim: fixture.buyer.claim, sign: bytes => { w.signatures++; return fixture.buyer.sign(bytes); } });
    await noEffects(w, signWireRequest({ ...fixture.input, signer }), codes[change]);
    assert.equal(jobReads, 1, 'the real wire job authority await immediately precedes signer.sign');
  }
});

test('an aggregate deadline expires across reads and late fenced answers release without signing or dispatching', async t => {
  const w = await boundaryWorld(t);
  let reads = 0;
  w.authority.state.gate = async () => { if (++reads === 1) w.clock.advance(6000); else w.clock.advance(4001); };
  await noEffects(w, w.sign(), 'tp1_authority_timeout');
  assert.equal(w.acquired, 1); assert.equal(w.released, 1);
});

test('a crash before withheld persistence leaves dispatch-started unknown after restart', async t => {
  const w = await boundaryWorld(t), signed = await w.sign();
  cutAppend(w, 'dispatch-started', { mutate: () => { w.stopped = true; } });
  const append = w.history.append;
  w.history.append = record => { if (record.state === 'dispatch-withheld') throw new Error('TEST-withheld-crash'); return append(record); };
  await assert.rejects(w.send(signed));
  w.reopen(); w.stopped = false;
  assert.deepEqual(await states(w, signed), ['signed', 'dispatch-started']);
  await assert.rejects(w.send(signed, { explicit: true }), code('eb_readback_required'));
  assert.equal(w.sent.length, 0);
});

test('concurrent explicit resumes inside one operation never dispatch the same lane twice', async t => {
  const w = await boundaryWorld(t), artifact = await w.sign();
  cutAppend(w, 'dispatch-started', { mutate: () => { w.stopped = true; } });
  await assert.rejects(w.send(artifact), code('writes_stopped'));
  w.reopen(); w.stopped = false;
  const results = await w.boundary.withOperation(w.op, () => Promise.allSettled([
    w.send(artifact, { explicit: true }), w.send(artifact, { explicit: true }),
  ]));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const lost = results.find(result => result.status === 'rejected')?.reason;
  assert.equal(lost?.code, 'eb_persist_failed'); assert.equal(lost.cause.code, 'eb_history_conflict');
  assert.deepEqual(w.sent, [signedBytes]);
  assert.deepEqual((await w.history.readOperation(w.op)).map(record => `${record.passId}/${record.state}`),
    ['p1/signed', 'p1/dispatch-started', 'p1/dispatch-withheld', 'p2/signed', 'p2/dispatch-started', 'p2/dispatch-acknowledged']);
});

test('time waiting for the fence does not spend the pass read budget, and each pass of one operation has its own', async t => {
  const waited = await boundaryWorld(t);
  waited.authority.state.gate = async () => { waited.clock.advance(2000); };
  let release;
  const holder = waited.fence.withFence('TEST-holder', () => new Promise(resolve => { release = resolve; })); await flush();
  const pending = waited.sign(); await flush();
  waited.clock.advance(9000); release(); await holder;
  assert.deepEqual(await states(waited, await pending), ['signed']);

  const w = await boundaryWorld(t);
  w.authority.state.gate = async () => { w.clock.advance(4000); };
  await w.boundary.withOperation(w.op, async () => {
    await w.sign(); await w.sign({ ...w.op, lane: 'TEST-second-lane' });
  });
  assert.equal(w.signatures, 2);
});
