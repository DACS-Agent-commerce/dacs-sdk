// The buyer's half of an explicit resume: only the explicit public resume signs a proof bound to the request that carries it;
// ordinary calls and automatic retries never send one. These fixtures install their own purchase-admission double, so this
// is a separate file from native-withheld-reopen.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as wire from '@kynesyslabs/dacs/wire';
import { code, T0, world as buyerWorld } from './helpers/wire-client-fixture.mjs';
import { storedWorld, PATHS, bodyFor } from './helpers/stored-request-fixture.mjs';

const { createSellerAgentClient } = await import('../src/dacs/seller-http.mjs');
const carriesProof = init => wire.DACS_SELLER_RESUME_HEADER in init.headers;
// A seller suspension on `path`, written as the suspension tests write one: a request-only change to the purchase row.
function suspend(s, path) {
  const row = s.p.get(), protocol = row.state.protocol;
  const sellerSuspension = { id: 'TEST-suspension', cause: 'seller_stopped', path, at: new Date(s.w.state.time).toISOString() };
  return s.p.ops.transition(row.id, row.status, row.status, { state: { protocol: { ...protocol, sellerSuspension, revision: (protocol.revision ?? 0) + 1 } }, event: 'test_suspension', data: {} });
}

test('automatic retries omit the resume proof; the explicit public resume alone signs the bound proof, which verifies once and only for its own request; the ordinary retry stays a positive control', async t => {
  await t.test('an automatic retry of the explicit call omits the proof', async t => {
    t.mock.method(Date, 'now', () => T0);
    const s = await storedWorld(t, { paid: true });
    let armed = true;
    const explicitResume = path => armed && path === PATHS.proposals && !(armed = false);
    await assert.rejects(s.client({ explicitResume, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).propose(bodyFor(PATHS.proposals)), error => error.answerClass === 'unknown');
    assert.deepEqual(s.fetches.map(carriesProof), [true, false, false], 'the first attempt carries the proof, both retries omit it');
  });
  await t.test('through the purchase service only the explicit recheck sends a proof, once; ordinary rechecks never do', async t => {
    t.mock.method(Date, 'now', () => T0);
    // Loaded here, as the suspension tests do: the helper's resolve hooks apply to every module imported after it.
    const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
    const coordinates = { verifiedAt: 'TEST-verified', reportedTxHash: 'a'.repeat(64), observation: { observation: { blockNumber: 1 } } };
    const { s, service } = await sellerFlow(t, 'payment', world => suspend(world, PATHS.payments));
    const held = s.p.get().state.protocol.sellerSuspension, carriers = () => s.fetches.filter(carriesProof);
    assert.equal(s.fetches.length, 0, 'the flow rechecked once without a resume: it stays suspended and sends nothing');
    await service.recheck(s.p.get(), coordinates);
    assert.equal(s.fetches.length, 0, 'an ordinary recheck stays suspended and sends nothing');
    await service.recheck(s.p.get(), coordinates, { resumeSuspensionId: held.id });
    assert.equal(carriers().length, 1, 'the explicit recheck sends one proof');
    await service.recheck(s.p.get(), coordinates);
    assert.equal(carriers().length, 1, 'a later ordinary recheck sends none');
  });
  // Both calls wait inside the same verification step after the explicit one cleared the suspension, then finish one after the other.
  // Their requests differ by transaction hash, so each fetch is attributed to its own call.
  for (const order of ['ordinary call first', 'explicit call first']) {
    await t.test(`an ordinary recheck racing the explicit one neither takes nor clears its proof (${order})`, async t => {
      t.mock.method(Date, 'now', () => T0);
      const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
      const hashes = { explicit: 'a'.repeat(64), ordinary: 'b'.repeat(64) };
      const coordinates = hash => ({ verifiedAt: 'TEST-verified', reportedTxHash: hash, observation: { observation: { blockNumber: 1 } } });
      const parked = [];
      const waiting = until => new Promise(resolve => { const poll = () => (until() ? resolve() : setImmediate(poll)); poll(); });
      const { s, service } = await sellerFlow(t, 'payment', (world, state) => {
        suspend(world, PATHS.payments);
        state.payment.verifyAgreement = () => (parked.length < 2 ? new Promise(release => parked.push(release)) : Promise.resolve());
      });
      const held = s.p.get().state.protocol.sellerSuspension;
      const explicit = service.recheck(s.p.get(), coordinates(hashes.explicit), { resumeSuspensionId: held.id });
      await waiting(() => parked.length === 1);
      const ordinary = service.recheck(s.p.get(), coordinates(hashes.ordinary));
      await waiting(() => parked.length === 2);
      const [first, second] = order === 'ordinary call first' ? [[1, ordinary], [0, explicit]] : [[0, explicit], [1, ordinary]];
      for (const [index, call] of [first, second]) { parked[index](); await call; }
      const carried = who => s.fetches.filter(init => init.body.includes(hashes[who]) && carriesProof(init)).length;
      assert.equal(carried('ordinary'), 0, 'the ordinary call sends none');
      // When the ordinary call finishes first it moves the purchase on, and the explicit call then sends nothing: its proof is not lent out.
      assert.equal(carried('explicit'), order === 'explicit call first' ? 1 : 0, 'only the explicit call can send its proof');
      assert.equal(s.fetches.filter(carriesProof).length, carried('explicit'), 'no other request carries a proof');
      await service.recheck(s.p.get(), coordinates(hashes.ordinary));
      assert.equal(s.fetches.filter(carriesProof).length, carried('explicit'), 'a later ordinary recheck finds no proof either');
    });
  }
  await t.test('two explicit rechecks naming one suspension send one proof between them', async t => {
    t.mock.method(Date, 'now', () => T0);
    const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
    const coordinates = { verifiedAt: 'TEST-verified', reportedTxHash: 'a'.repeat(64), observation: { observation: { blockNumber: 1 } } };
    const { s, service } = await sellerFlow(t, 'payment', world => suspend(world, PATHS.payments));
    const held = s.p.get().state.protocol.sellerSuspension, row = s.p.get();
    await Promise.all([service.recheck(row, coordinates, { resumeSuspensionId: held.id }), service.recheck(row, coordinates, { resumeSuspensionId: held.id })]);
    assert.equal(s.fetches.filter(carriesProof).length, 1, 'one proof is sent');
  });
  await t.test('only the explicit call signs and sends a proof bound to its request; ordinary calls and automatic retries never carry one', async t => {
    const w = await buyerWorld(t), seen = [];
    const path = wire.DACS_SELLER_HTTP_PATHS.commitments, fetchImpl = async (_url, init) => { seen.push(init.headers); throw Error('TEST-response-lost'); };
    let armed = true;
    const explicitResume = requested => armed && requested === path && !(armed = false);
    const client = createSellerAgentClient({ url: w.publicEndpoint, authentication: w.auth, explicitResume, fetchImpl });
    await assert.rejects(client.request(path, { jobId: w.payload.jobId }));
    await assert.rejects(client.request(path, { jobId: w.payload.jobId }));
    await assert.rejects(createSellerAgentClient({ url: w.publicEndpoint, authentication: w.auth, fetchImpl }).request(path, { jobId: w.payload.jobId }));
    assert.deepEqual(seen.map(headers => wire.DACS_SELLER_RESUME_HEADER in headers), [true, false, false], 'only the one-shot first call carries a proof');
    const header = seen[0][wire.DACS_SELLER_RESUME_HEADER];
    assert.ok(header.length <= wire.DACS_SELLER_HTTP_LIMITS.maxHeaderLength);
    const signed = await w.auth.request(path, { jobId: w.payload.jobId }, JSON.stringify({ jobId: w.payload.jobId }));
    const scope = { binding: w.binding, local: w.local, delegation: w.delegation.payload, time: w.state.time, ledger: wire.createExplicitResumeLedger() };
    const own = await w.auth.resumeProof(signed);
    const opened = await wire.verifyExplicitCreateResume(own, { ...scope, request: signed.payload });
    assert.equal(opened.requestHash, wire.wireRequestHash(signed.payload));
    await assert.rejects(wire.verifyExplicitCreateResume(own, { ...scope, request: signed.payload }), code('explicit_resume_used'));
    await assert.rejects(wire.verifyExplicitCreateResume(header, { ...scope, request: signed.payload }), code('explicit_resume_mismatch'));
    await assert.rejects(w.auth.resumeProof({ payload: { ...signed.payload, path: wire.DACS_SELLER_HTTP_PATHS.state } }));
  });
});
