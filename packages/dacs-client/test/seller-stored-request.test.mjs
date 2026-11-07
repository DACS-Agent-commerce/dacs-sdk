import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { storedWorld, PATHS, bodyFor, errorCode, nonce, sameBodies } from './helpers/stored-request-fixture.mjs';
import { setPurchaseAdmission } from './helpers/wire-client-fixture.mjs';
const { signatureCommitmentAnchor } = await import('../src/dacs/commit-on-signature.mjs');
const transport = await import('../src/dacs/seller-http.mjs');
const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const P = PATHS.proposals;
const CONTEXT_LIMITS = { min: 240000, max: 300000 };

test("route, stage, exact body bytes, body hash and attempt id are durable before the first send, written by compare-and-set on the purchase revision", async (t) => {
  const s = await storedWorld(t); const initial = s.p.get().state.protocol.revision ?? 0;
  const c = s.client({ respond: init => {
    const r = s.record(P); assert.equal(r.path, P); assert.equal(r.stage, 'agreement-signing');
    assert.equal(Buffer.from(r.bodyB64, 'base64url').toString(), init.body); assert.equal(r.bodyHash, sha256Hex(init.body));
    assert.equal(typeof r.attemptId, 'string'); assert.equal(r.attempts, 1); assert.equal(r.clearAttempts, 0);
    assert.ok(s.p.get().state.protocol.revision > initial); return s.reply(init);
  } }); await c.propose(bodyFor(P)); assert.equal(s.record(P).lastClass, 'result');
});

test("a crash after the record and before the send resends the stored bytes on restart with a fresh nonce", async (t) => {
  const s = await storedWorld(t); const r = s.records().start(P, bodyFor(P));
  const held = await s.auth.request(P, bodyFor(P), r.text);
  s.advance(100); s.restart(); await s.client().propose(bodyFor(P)); assert.equal(s.fetches[0].body, r.text);
  assert.notEqual(nonce(s.fetches[0]).nonce, held.payload.nonce); assert.ok(nonce(s.fetches[0]).expiresAt > held.payload.expiresAt);
  assert.equal(s.record(P).attempts, 2); assert.equal(s.record(P).clearAttempts, 0);
});

test("at the route deadline the outcome is unknown and recorded, and the next explicit call retries the stored bytes", async (t) => {
  const s = await storedWorld(t); let expired = false;
  const respond = async init => { if (!expired) { expired = true; s.advance(15000); throw Object.assign(new Error('TEST-timeout'), { name: 'TimeoutError' }); } return s.reply(init); };
  await assert.rejects(s.client({ respond }).propose(bodyFor(P)), e => e.answerClass === 'unknown');
  assert.equal(s.record(P).lastClass, 'unknown'); assert.equal(s.fetches.length, 1);
  s.restart(); await s.client({ respond }).propose(bodyFor(P)); sameBodies(s.fetches);
});

test("a late response for stage n after the row moved to n+1 is ignored (K5-C4)", async (t) => {
  const s = await storedWorld(t);
  await assert.rejects(s.client({ respond: init => { s.patch({ stage: 'agreement-anchored' }); return s.reply(init); } }).propose(bodyFor(P)), errorCode('protocol_check_stale'));
  assert.equal(s.p.get().state.protocol.stage, 'agreement-anchored'); assert.notEqual(s.record(P).lastClass, 'result');
});

test("two concurrent flows for one purchase send the same stored bytes; the compare-and-set loser reloads, revalidates and adopts the stored request, and a different body for the same route is refused stored_request_mismatch", async (t) => {
  const s = await storedWorld(t); const other = { row: s.p.get() }; const h = { get: () => other.row, set: row => { other.row = row; } };
  await Promise.all([s.client().propose(bodyFor(P)), s.client({ requestRecords: s.records(h) }).propose(bodyFor(P))]);
  assert.equal(s.record(P).attempts, 2); sameBodies(s.fetches);
  await assert.rejects(s.client().propose({ ...bodyFor(P), changed: true }), errorCode('stored_request_mismatch')); assert.equal(s.fetches.length, 2);
});

test("a record write racing a stage advance loses the compare-and-set, reloads, and sends nothing for a stage the row no longer authorizes", async (t) => {
  const s = await storedWorld(t); const records = s.records(); s.patch({ stage: 'agreement-anchored' });
  await assert.rejects(s.client({ requestRecords: records }).propose(bodyFor(P)), errorCode('protocol_check_stale')); assert.equal(s.fetches.length, 0);
});

test("in each of the five seller flows the record write advances the revision and the flow's later stage save succeeds from the advanced row", async (t) => {
  const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
  for (const kind of ['agreement', 'commit', 'replay', 'payment', 'signature']) {
    const { s, result, path } = await sellerFlow(t, kind);
    assert.ok(s.fetches.length > 0, kind);
    assert.equal(s.record(path).lastClass, 'result', kind);
    assert.equal(result.state.protocol.revision, s.p.get().state.protocol.revision, kind);
    assert.ok(!result.state.protocol.notSaved, kind);
    if (kind !== 'replay') assert.ok(s.p.ops.history(s.p.op.id).some(event => event.type.startsWith('protocol_') && event.type !== 'protocol_check_not_saved'), kind);
  }
});

test("the fire-and-forget commitments/signature request records its bytes through the anchor flow's holder, and the anchor flow's later saves succeed", async (t) => {
  const s = await storedWorld(t); let notify; let pending;
  const client = s.client({ respond: async init => { await pending; return s.reply(init); } });
  let sent; const seller = { ...client, commitOnSignature(...args) { sent = client.commitOnSignature(...args); return sent; } };
  let release; pending = new Promise(resolve => { release = resolve; });
  const anchor = signatureCommitmentAnchor({ onCreateAuthorized(_input, fn) { notify = fn; }, async anchorAgreement() { notify({ version: 1 }); return {}; } }, seller, true);
  await anchor.anchorAgreement({ artifact: { jobId: s.w.job.jobId } });
  await Promise.resolve(); assert.ok(s.record(PATHS.commitmentSignature));
  assert.equal(s.holder.get().state.protocol.revision, s.p.get().state.protocol.revision);
  release(); await sent;
  assert.equal(s.holder.get().state.protocol.revision, s.p.get().state.protocol.revision);
  const saved = await s.p.service.identityRequest(s.holder.get(), s.w.buyer.address);
  assert.equal(saved.operation.state.protocol.sellerRequests[PATHS.commitmentSignature].lastClass, 'result');
});

test("a stored record whose bytes do not match its hash is refused stored_request_corrupt and never re-derived", async (t) => {
  const s = await storedWorld(t); s.records().start(P, bodyFor(P)); s.patch({ sellerRequests: { [P]: { ...s.record(P), bodyB64: Buffer.from('{}').toString('base64url') } } }); s.restart();
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('stored_request_corrupt')); assert.equal(s.fetches.length, 0);
});

test("keepChainPointers, holdChainReadback, note and save keep every stored request record", async (t) => {
  const s = await storedWorld(t); await s.client().propose(bodyFor(P)); const before = s.record(P);
  const op = s.p.get(); s.p.ops.transition(op.id, op.status, op.status, { state: { protocol: { ...op.state.protocol, chainReadback: { TEST: {} } } }, event: 'test_pointer', data: {} });
  await s.client().commit(s.w.job.jobId); assert.deepEqual(s.record(P), before);
  const saved = await s.p.service.identityRequest(s.holder.get(), s.w.buyer.address);
  assert.deepEqual(saved.operation.state.protocol.sellerRequests[P], before);
  s.patch({ stage: 'delivered', delivery: { status: 'delivered' } }, 'settled_verified');
  await s.p.service.holdChainReadback(s.p.get(), 'TEST-key-retired');
  assert.deepEqual(s.record(P), before);
  const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
  const replay = await sellerFlow(t, 'replay');
  assert.ok(replay.result.state.protocol.chainReadback[replay.commitmentAddress]);
  assert.ok(replay.result.state.protocol.sellerRequests[PATHS.commitments]);
});

test("a purchase cancelled while its request is being signed sends nothing and keeps the refusal's cause", async (t) => {
  const s = await storedWorld(t);
  const authentication = { ...s.auth, async request(...args) { const signed = await s.auth.request(...args); s.patch({}, 'cancelled'); return signed; } };
  await assert.rejects(s.client({ authentication }).propose(bodyFor(P)), errorCode('protocol_check_stale'));
  assert.equal(s.fetches.length, 0);
});

test("two concurrent first requests: only the compare-and-set winner is a new-purchase request", async (t) => {
  const s = await storedWorld(t, { accepted: false }); let row = s.p.get(); const other = { get: () => row, set: next => { row = next; } };
  const a = s.records().start(PATHS.context, bodyFor(PATHS.context)); const b = s.records(other).start(PATHS.context, bodyFor(PATHS.context));
  assert.equal(a.newPurchase, true); assert.equal(b.newPurchase, false); assert.equal(s.record(PATHS.context).attempts, 2);
});

test("a record write by another route during an in-flight effect request does not lose that request's answer", async (t) => {
  const s = await storedWorld(t); let row = s.p.get(); const other = { get: () => row, set: next => { row = next; } };
  await s.client({ respond: init => { s.records(other).start(PATHS.commitments, bodyFor(PATHS.commitments)); return s.reply(init); } }).propose(bodyFor(P));
  assert.equal(s.record(P).lastClass, 'result'); assert.ok(s.record(PATHS.commitments)); assert.equal(s.holder.get().state.protocol.revision, s.p.get().state.protocol.revision);
});

test("a stage save from a snapshot that is stale only by another route's request record is saved", async (t) => {
  const s = await storedWorld(t), snapshot = s.p.get();
  s.records({ get: () => s.p.get(), set() {} }).start(PATHS.commitments, bodyFor(PATHS.commitments));
  const saved = await s.p.service.identityRequest(snapshot, s.w.buyer.address);
  assert.ok(!saved.operation.state.protocol.notSaved); assert.ok(saved.operation.state.protocol.sellerRequests[PATHS.commitments]);
});

test("a superseded CREATE after a stored commitments/signature record sends nothing new, the swallowed refusal is recorded, and the ordinary commit carries the current projection", async (t) => {
  const s = await storedWorld(t); const c = s.client(); await c.commitOnSignature(s.w.job.jobId, {}, { version: 1 }); s.restart();
  const anchor = signatureCommitmentAnchor({ onCreateAuthorized(_input, fn) { fn({ version: 2 }); }, async anchorAgreement() { return {}; } }, s.client(), true);
  await anchor.anchorAgreement({ artifact: { jobId: s.w.job.jobId } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.fetches.length, 1); assert.ok(s.p.ops.history(s.p.op.id).some(e => JSON.stringify(e).includes('stored_request_mismatch')));
  await s.client().commit(s.w.job.jobId, { signedProjection: { version: 2 } }); assert.equal(JSON.parse(s.fetches[1].body).signedProjection.version, 2);
  s.patch({}, 'cancelled'); await assert.rejects(s.client().commitOnSignature(s.w.job.jobId, {}, { version: 1 })); assert.equal(s.fetches.length, 2);
});

test("stored request byte and metadata bounds fail closed before signing", async (t) => {
  const s = await storedWorld(t);
  await assert.rejects(s.client().propose({ jobId: s.w.job.jobId, oversized: 'x'.repeat(65537) }));
  assert.equal(s.fetches.length, 0); assert.equal(s.w.state.signs.length, 0); assert.equal(s.record(P), undefined);
  const path = PATHS.context, store = s.records(), attempt = store.start(path, bodyFor(path));
  attempt.finish('not-started'); attempt.finish('not-started');
  assert.equal(s.record(path).clearAttempts, 1);
  const kept = s.record(path), badUtf8 = Buffer.concat([Buffer.from('{"v":"'), Buffer.from([255]), Buffer.from('"}')]);
  for (const damage of [{ bodyB64: 'x'.repeat(100000) }, { attempts: Number.MAX_SAFE_INTEGER }, { attemptId: '' }, { bodyB64: '**' }, { bodyB64: badUtf8.toString('base64url'), bodyHash: sha256Hex(badUtf8) }]) {
    s.patch({ sellerRequests: { [path]: { ...kept, ...damage } } }); s.restart();
    await assert.rejects(s.client().request(path, bodyFor(path)), errorCode('stored_request_corrupt'));
  }
  assert.equal(s.fetches.length, 0); assert.equal(s.w.state.signs.length, 0);
});

test("route deadlines: context is clamped to 240 through 300 seconds and every other route defaults to 15 seconds", async (t) => {
  for (const [path, timeoutMs, expected] of [[PATHS.context, 1000, CONTEXT_LIMITS.min], [PATHS.context, 400000, CONTEXT_LIMITS.max], [P, undefined, 15000]]) {
    const s = await storedWorld(t);
    await s.client({ timeoutMs, respond: () => { s.advance(expected); throw new Error('TEST-deadline'); } }).request(path, bodyFor(path)).catch(() => {});
    assert.equal(s.clock.now(), expected); assert.equal(s.fetches.length, 1);
  }
});

test("retained payment and commitment bytes stay replayable after their authorized stage advances", async (t) => {
  for (const [path, first, next] of [[PATHS.payments, 'payment-observed', 'payment-evidenced'], [PATHS.commitments, 'agreement-anchored', 'seller-committed']]) {
    const s = await storedWorld(t, { stage: first });
    await s.client().request(path, bodyFor(path)); const before = s.record(path);
    s.patch({ stage: next }); s.restart();
    await s.client().request(path, bodyFor(path));
    sameBodies(s.fetches); assert.equal(s.record(path).bodyHash, before.bodyHash); assert.equal(s.record(path).stage, first); assert.equal(s.p.get().state.protocol.stage, next);
  }
});

test("a stored proposals request is not resent once the row has moved past its stage", async (t) => {
  const s = await storedWorld(t);
  await s.client().propose(bodyFor(P));
  s.patch({ stage: 'agreement-anchored' }); s.restart();
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('protocol_check_stale'));
  assert.equal(s.fetches.length, 1);
});

test("a failed record write rolls back and sends nothing, and a failed outcome write leaves an unknown attempt that a restart completes once", async (t) => {
  const { transaction } = createSqlitePurchaseStore();
  const s = await storedWorld(t), before = s.p.get();
  const abortAll = (db, work) => transaction(db, () => { work(); throw new Error('TEST-record-commit-failed'); });
  await assert.rejects(s.client({ requestRecords: s.records(s.holder, abortAll) }).propose(bodyFor(P)), /TEST-record-commit-failed/);
  assert.equal(s.fetches.length, 0); assert.deepEqual(s.p.get(), before);
  let writes = 0; const abortOutcome = (db, work) => transaction(db, () => { const result = work(); if (++writes === 2) throw new Error('TEST-outcome-commit-failed'); return result; });
  const effects = new Set(), respond = init => { effects.add(init.body); return s.reply(init); };
  await assert.rejects(s.client({ requestRecords: s.records(s.holder, abortOutcome), respond }).propose(bodyFor(P)), /TEST-outcome-commit-failed/);
  assert.equal(s.record(P).lastClass, 'unknown');
  s.restart(); await s.client({ respond }).propose(bodyFor(P));
  assert.equal(effects.size, 1); assert.equal(s.record(P).lastClass, 'result'); sameBodies(s.fetches);
});
