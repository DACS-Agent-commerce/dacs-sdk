import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { world, purchase, code, setPurchaseAdmission, T0 } from './helpers/wire-client-fixture.mjs';
import { createSellerSessionKeys } from '../src/dacs/seller-session-keys.mjs';

const CLAIM_PREFIX = 'did:demos:agent:';
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const delegationBytes = (payload) => Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(payload));
const buyerSignsDelegation = (w, payload) => w.buyer.sign(delegationBytes(payload)).toString('base64url');
const identity = (p) => p.service.identityRequest(p.get(), p.op.terms.buyer.wallet);
const eventCount = (p) => p.ops.history(p.op.id).length;
const protocolOf = (p) => p.get().state.protocol;
const keyOf = (claim) => claim.slice(CLAIM_PREFIX.length);
const verifiesUnder = (claim, bytes, signature) => verify(null, bytes, createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(keyOf(claim), 'hex')]), format: 'der', type: 'spki' }), signature);
const SESSION_EVENTS = ['seller_request_failed', 'protocol_commit-request', 'protocol_native-evidence', 'protocol_agreement-context'];

// A purchase whose session key comes from a registry; `restart` stands for a new process: an empty registry, then a fresh key, over the same saved row.
async function openPurchase(t, { plan = false } = {}) {
  const w = await world(t), session = { keys: createSellerSessionKeys() }, signed = [];
  const p = await purchase(t, w, { sessionSignerFor: (operation) => {
    const signer = session.keys.signerFor(operation);
    return { claim: signer.claim, async sign(bytes) { const signature = await signer.sign(bytes); signed.push({ claim: signer.claim, bytes: Buffer.from(bytes), signature }); w.state.signs.push(Buffer.from(bytes)); return signature; } };
  } });
  session.keys.start(p.op.id);
  const first = await identity(p);
  const old = { payload: first.delegation.payload, signature: buyerSignsDelegation(w, first.delegation.payload) };
  const presentation = w.buyer.sign(Buffer.from(first.message)).toString('base64url');
  if (plan) await p.service.planRequest(first.operation, presentation, old.signature);
  return { w, p, session, signed, old, presentation,
    restart() { session.keys = createSellerSessionKeys(); session.keys.start(p.op.id); p.reopen(); return session.keys; } };
}
async function renewed(s) {
  const renewal = await s.p.service.sessionRenewal(s.p.get());
  return { renewal, signature: buyerSignsDelegation(s.w, renewal.delegation.payload) };
}

// A paid purchase through the real protocol service whose seller transport takes its session key from a registry; the retained delegation names another key.
async function sellerRun(t, kind, keys, beforeRun = () => {}) {
  const { createSourceDemoSellerTransport } = await import('../src/dacs/source-demo-seller-transport.mjs');
  const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
  const proof = {};
  // The flow's world, with its endpoint proof and its effect boundary, exists only once the flow starts.
  const effectBoundary = { signerFor: (...args) => proof.boundary.signerFor(...args) };
  const sellerTransport = createSourceDemoSellerTransport({ authority: 'TEST-wire', sessionSignerFor: (operation) => keys.signerFor(operation), sessionPolicyFor: () => ({ expiresAt: T0 + 1800000 }), endpointProofFor: () => proof.value, effectBoundary });
  const seen = {};
  const run = sellerFlow(t, kind, async (s, state, service) => { proof.value = s.w.endpointProof; proof.boundary = s.w.options.effectBoundary; seen.s = s; seen.service = service; await beforeRun(s, service); }, { sellerTransport });
  return { run, seen };
}
const noSellerTraffic = (s) => {
  const protocol = s.p.get().state.protocol;
  assert.equal(s.fetches.length, 0);
  assert.equal(s.w.state.signs.length, 0);
  assert.equal(protocol.attempts, undefined);
  assert.equal(protocol.sellerRequests, undefined);
  assert.deepEqual(s.p.ops.history(s.p.op.id).map((event) => event.type).filter((type) => SESSION_EVENTS.includes(type)), []);
};

test('after a restart, a purchase whose retained delegation names the old key answers session_gone_reapprove before any request record, seller request or session signature', async (t) => {
  for (const started of [false, true]) {
    const keys = createSellerSessionKeys();
    if (started) keys.start('another-purchase');
    const { run, seen } = await sellerRun(t, 'agreement', keys, (s) => { if (started) keys.start(s.p.op.id); });
    await assert.rejects(run, code('session_gone_reapprove'));
    noSellerTraffic(seen.s);
  }
});

test('an identity request after a restart whose saved payload names a gone key returns no wallet message and answers session_gone_reapprove', async (t) => {
  const s = await openPurchase(t), before = eventCount(s.p);
  s.restart();
  await assert.rejects(identity(s.p), code('session_gone_reapprove'));
  assert.equal(eventCount(s.p), before);
  assert.equal(s.w.state.signs.length, 0);
  s.session.keys = createSellerSessionKeys();
  await assert.rejects(identity(s.p), code('session_gone_reapprove'));
});

test('session_gone_reapprove from the commit and replayed-commit paths, which precede payment, is rethrown unchanged and records no note, attempt or seller_request_failed row', async (t) => {
  for (const kind of ['commit', 'replay']) {
    const { run, seen } = await sellerRun(t, kind, createSellerSessionKeys());
    await assert.rejects(run, (error) => error.code === 'session_gone_reapprove' && error.name === 'OperationError');
    noSellerTraffic(seen.s);
  }
  const source = readFileSync(new URL('../src/dacs/protocol-purchases.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/\bsellerFor\(/g).length, 5, 'a new sellerFor call site needs its catch reviewed for session_gone_reapprove');
});

test('after a restart, the payment evidence step of a paid purchase returns the purchase with a held attempt naming session_gone_reapprove, and sends and signs nothing', async (t) => {
  const { run, seen } = await sellerRun(t, 'payment', createSellerSessionKeys());
  const { result } = await run;
  assert.equal(result.status, 'settled_verified');
  const protocol = seen.s.p.get().state.protocol;
  assert.equal(protocol.attempts.length, 1);
  assert.deepEqual([protocol.attempts[0].step, protocol.attempts[0].outcome], ['native-evidence', 'held']);
  assert.match(protocol.attempts[0].reason, /new session key/);
  assert.equal(seen.s.p.get().status, 'settled_verified');
  assert.equal(seen.s.fetches.length, 0);
  assert.equal(seen.s.w.state.signs.length, 0);
});

test('sessionRenewal after a restart returns the retained scope with the live key, a fresh notBefore and the original expiresAt, saves it as pending, and signs or sends nothing', async (t) => {
  const s = await openPurchase(t, { plan: true });
  s.w.state.time = T0 + 5000;
  s.restart();
  const newClaim = s.session.keys.signerFor(s.p.get()).claim, signsBefore = s.signed.length;
  const { delegation } = await s.p.service.sessionRenewal(s.p.get());
  assert.deepEqual(delegation.payload, { ...s.old.payload, sessionPublicKey: keyOf(newClaim), notBefore: T0 + 5000 - 30000 });
  assert.equal(delegation.payload.expiresAt, s.old.payload.expiresAt);
  assert.deepEqual(Buffer.from(delegation.message), delegationBytes(delegation.payload));
  assert.deepEqual(protocolOf(s.p).pendingSessionDelegation, { payload: delegation.payload });
  assert.deepEqual(protocolOf(s.p).sessionDelegation, s.old);
  assert.equal(s.signed.length, signsBefore);
  assert.equal(s.p.ops.history(s.p.op.id).filter((event) => event.type === 'protocol_seller_session_renewal_requested').length, 1);
});

test("sessionRenewalAccept with the buyer's signature replaces the retained delegation, and the next seller request is signed by the new key and carries the renewed delegation", async (t) => {
  const keys = createSellerSessionKeys(), signed = [];
  const recording = { signerFor: (operation) => { const signer = keys.signerFor(operation); return { claim: signer.claim, async sign(bytes) { const signature = await signer.sign(bytes); signed.push({ claim: signer.claim, bytes: Buffer.from(bytes), signature }); return signature; } }; } };
  const { run, seen } = await sellerRun(t, 'payment', recording, async (s, service) => {
    const { claim } = keys.start(s.p.op.id);
    const { delegation } = await service.sessionRenewal(s.p.get());
    assert.equal(delegation.payload.sessionPublicKey, keyOf(claim));
    await service.sessionRenewalAccept(s.p.get(), buyerSignsDelegation(s.w, delegation.payload));
    assert.deepEqual(s.p.get().state.protocol.sessionDelegation.payload, delegation.payload);
    assert.equal(s.p.get().state.protocol.pendingSessionDelegation, undefined);
  });
  await run;
  const { s } = seen, renewed = s.p.get().state.protocol.sessionDelegation;
  assert.ok(s.fetches.length > 0 && signed.length > 0);
  for (const { claim, bytes, signature } of signed) assert.equal(verifiesUnder(claim, bytes, signature), true);
  assert.deepEqual([...new Set(signed.map((entry) => entry.claim))], [`${CLAIM_PREFIX}${renewed.payload.sessionPublicKey}`]);
  const carried = JSON.parse(Buffer.from(s.fetches[0].headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url')).delegation;
  assert.deepEqual(carried, renewed);
  await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(carried)), { binding: s.w.binding, local: s.w.local, seller: s.w.seller.claim, listingPin: s.w.pin, jobId: s.w.job.jobId, time: s.w.state.time });
});

test('sessionRenewal refuses session_live, session_not_started, seller_session_ended, invalid_state and seller_delegation_expiring, saving nothing', async (t) => {
  const s = await openPurchase(t), refused = async (expected) => {
    const before = eventCount(s.p), saved = protocolOf(s.p);
    await assert.rejects(s.p.service.sessionRenewal(s.p.get()), code(expected));
    assert.equal(eventCount(s.p), before);
    assert.deepEqual(protocolOf(s.p), saved);
  };
  await refused('session_live');
  s.restart();
  s.session.keys = createSellerSessionKeys();
  await refused('session_not_started');
  s.session.keys.start(s.p.op.id);
  const row = s.p.get();
  s.p.ops.transition(row.id, row.status, 'expired', { state: { protocol: row.state.protocol }, event: 'test_purchase_expired', data: {} });
  assert.notEqual(protocolOf(s.p).sellerSessionFinalAt, undefined);
  await refused('seller_session_ended');
  const fresh = await openPurchase(t), unsaved = { ...fresh.p.get(), state: { protocol: { ...fresh.p.get().state.protocol, sessionDelegation: undefined } } };
  await assert.rejects(fresh.p.service.sessionRenewal(unsaved), code('invalid_state'));
  const late = await openPurchase(t);
  late.restart();
  for (const time of [late.old.payload.expiresAt - 1000, late.old.payload.expiresAt + 1]) {
    late.w.state.time = time;
    const before = eventCount(late.p);
    await assert.rejects(late.p.service.sessionRenewal(late.p.get()), code('seller_delegation_expiring'));
    assert.equal(eventCount(late.p), before);
    assert.equal(protocolOf(late.p).pendingSessionDelegation, undefined);
  }
});

test('a paid purchase renews its seller session inside the safety margin and is refused only once the delegation has expired; an unpaid one keeps the margin', async (t) => {
  const restarted = async (paid) => {
    const s = await openPurchase(t);
    s.restart();
    if (paid) {
      const row = s.p.get();
      s.p.ops.transition(row.id, row.status, 'settled_verified', { state: { protocol: { ...row.state.protocol, stage: 'payment-observed' } }, event: 'test_purchase_paid', data: {} });
    }
    return s;
  };
  const at = (s, msBeforeExpiry) => { s.w.state.time = s.old.payload.expiresAt - msBeforeExpiry; };
  const renews = async (s) => {
    const newClaim = s.session.keys.signerFor(s.p.get()).claim;
    const { delegation } = await s.p.service.sessionRenewal(s.p.get());
    assert.deepEqual(delegation.payload, { ...s.old.payload, sessionPublicKey: keyOf(newClaim), notBefore: s.w.state.time - 30000 });
    assert.deepEqual(protocolOf(s.p).pendingSessionDelegation, { payload: delegation.payload });
    return delegation;
  };
  const refuses = async (s, expected) => {
    const before = eventCount(s.p);
    await assert.rejects(s.p.service.sessionRenewal(s.p.get()), code(expected));
    assert.equal(eventCount(s.p), before);
    assert.equal(protocolOf(s.p).pendingSessionDelegation, undefined);
  };

  const fourMinutes = await restarted(true);
  at(fourMinutes, 4 * 60000);
  const delegation = await renews(fourMinutes);
  await fourMinutes.p.service.sessionRenewalAccept(fourMinutes.p.get(), buyerSignsDelegation(fourMinutes.w, delegation.payload));
  assert.deepEqual(protocolOf(fourMinutes.p).sessionDelegation.payload, delegation.payload);
  assert.equal(fourMinutes.p.get().status, 'settled_verified');

  const tenMinutes = await restarted(true);
  at(tenMinutes, 10 * 60000);
  await renews(tenMinutes);

  for (const msBeforeExpiry of [0, -1]) {
    const expired = await restarted(true);
    at(expired, msBeforeExpiry);
    await refuses(expired, 'seller_delegation_expired');
  }

  const unpaid = await restarted(false);
  at(unpaid, 4 * 60000);
  await refuses(unpaid, 'seller_delegation_expiring');
  at(unpaid, 10 * 60000);
  await renews(unpaid);
});

// A restarted purchase moved to `status`, with the clock `msBeforeExpiry` before its retained delegation expires.
async function restartedAs(t, status, msBeforeExpiry) {
  const s = await openPurchase(t);
  s.restart();
  if (status) {
    const row = s.p.get();
    s.p.ops.transition(row.id, row.status, status, { state: { protocol: { ...row.state.protocol, stage: 'payment-observed' } }, event: 'test_purchase_status', data: {} });
  }
  s.w.state.time = s.old.payload.expiresAt - msBeforeExpiry;
  return s;
}

test('inside the safety margin a purchase whose transfer may already have been sent is told to verify the payment, never to pay again or prepare a new purchase; an unpaid one keeps seller_delegation_expiring', async (t) => {
  const refusedWith = async (s, check) => {
    const before = eventCount(s.p);
    await assert.rejects(s.p.service.sessionRenewal(s.p.get()), (error) => { check(error); return true; });
    assert.equal(eventCount(s.p), before);
    assert.equal(protocolOf(s.p).pendingSessionDelegation, undefined);
    assert.deepEqual(protocolOf(s.p).sessionDelegation.payload, s.old.payload);
  };
  for (const status of ['payment_handoff', 'broadcast_reported', 'payment_uncertain']) {
    await t.test(status, async (st) => refusedWith(await restartedAs(st, status, 4 * 60000), (error) => {
      assert.equal(error.code, 'seller_delegation_expiring_payment_unresolved');
      assert.match(error.message, /do not pay again and do not prepare a new purchase/);
      assert.match(error.message, /Verify or recover the payment first/);
      assert.doesNotMatch(error.message, /Prepare a new purchase/);
    }));
  }
  await t.test('unpaid', async (st) => refusedWith(await restartedAs(st, null, 4 * 60000), (error) => {
    assert.equal(error.code, 'seller_delegation_expiring');
    assert.match(error.message, /nothing was signed or sent\. Prepare a new purchase\.$/);
  }));
});

test('a paid purchase whose delegation expires between sessionRenewal and sessionRenewalAccept is refused with seller_delegation_expired and saves nothing; an unpaid one keeps the wire refusal', async (t) => {
  const expiresBeforeAccept = async (s) => {
    const { renewal, signature } = await renewed(s);
    s.w.state.time = s.old.payload.expiresAt;
    const before = eventCount(s.p);
    let refused;
    await assert.rejects(s.p.service.sessionRenewalAccept(s.p.get(), signature), (error) => { refused = error; return true; });
    assert.equal(eventCount(s.p), before);
    assert.deepEqual(protocolOf(s.p).sessionDelegation.payload, s.old.payload);
    assert.deepEqual(protocolOf(s.p).pendingSessionDelegation, { payload: renewal.delegation.payload });
    return refused;
  };
  const paid = await expiresBeforeAccept(await restartedAs(t, 'settled_verified', 4 * 60000));
  assert.equal(paid.code, 'seller_delegation_expired');
  assert.match(paid.message, /Do not pay again; keep the transaction hash\.$/);
  assert.equal(paid.cause?.code, 'peer_delegation_expired');

  const unpaid = await expiresBeforeAccept(await restartedAs(t, null, 10 * 60000));
  assert.equal(unpaid.code, 'peer_delegation_expired');
});

test("sessionRenewalAccept refuses a signature that does not decode (bad_signature), one that does not verify (peer_delegation_signature_invalid), a payload outside the purchase's scope (peer_delegation_mismatch) and a pending payload whose key is no longer live (session_gone_reapprove), saving nothing", async (t) => {
  const s = await openPurchase(t);
  s.restart();
  const { renewal, signature } = await renewed(s);
  const unchanged = async (signatureToTry, expected) => {
    const before = eventCount(s.p), saved = protocolOf(s.p);
    await assert.rejects(s.p.service.sessionRenewalAccept(s.p.get(), signatureToTry), code(expected));
    assert.equal(eventCount(s.p), before);
    assert.deepEqual(protocolOf(s.p), saved);
  };
  await unchanged('not a signature %%%', 'bad_signature');
  await unchanged(s.w.other.sign(delegationBytes(renewal.delegation.payload)).toString('base64url'), 'peer_delegation_signature_invalid');
  await unchanged(s.old.signature, 'peer_delegation_signature_invalid');
  const row = s.p.get(), widened = { ...renewal.delegation.payload, seller: s.w.other.claim };
  s.p.ops.transition(row.id, row.status, row.status, { state: { protocol: { ...row.state.protocol, pendingSessionDelegation: { payload: widened }, revision: (row.state.protocol.revision ?? 0) + 1 } }, event: 'test_pending_changed', data: {} });
  await unchanged(buyerSignsDelegation(s.w, widened), 'peer_delegation_mismatch');
  s.p.ops.transition(row.id, row.status, row.status, { state: { protocol: { ...s.p.get().state.protocol, pendingSessionDelegation: { payload: renewal.delegation.payload }, revision: (s.p.get().state.protocol.revision ?? 0) + 1 } }, event: 'test_pending_restored', data: {} });
  s.restart();
  await unchanged(signature, 'session_gone_reapprove');
  s.session.keys = createSellerSessionKeys();
  await unchanged(signature, 'session_gone_reapprove');
});

test('a repeated sessionRenewalAccept after the renewal was saved answers session_gone_reapprove and changes nothing', async (t) => {
  const s = await openPurchase(t);
  s.restart();
  const { signature } = await renewed(s);
  await s.p.service.sessionRenewalAccept(s.p.get(), signature);
  const saved = protocolOf(s.p), before = eventCount(s.p);
  await assert.rejects(s.p.service.sessionRenewalAccept(s.p.get(), signature), code('session_gone_reapprove'));
  assert.deepEqual(protocolOf(s.p), saved);
  assert.equal(eventCount(s.p), before);
  assert.equal(saved.pendingSessionDelegation, undefined);
});

test('no renewed delegation is saved without a verified buyer signature, and nothing in the client calls start or sessionRenewalAccept on its own', async (t) => {
  const s = await openPurchase(t);
  s.restart();
  await renewed(s);
  await assert.rejects(s.p.service.sessionRenewalAccept(s.p.get(), undefined), code('bad_signature'));
  assert.deepEqual(protocolOf(s.p).sessionDelegation, { payload: s.old.payload });
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(srcDir, { recursive: true }).filter((name) => name.endsWith('.mjs'));
  const callers = (pattern) => files.filter((name) => pattern.test(readFileSync(join(srcDir, name), 'utf8'))).map((name) => name.replaceAll('\\', '/')).sort();
  assert.deepEqual(callers(/\bsessionRenewalAccept\(/), ['dacs/protocol-purchases.mjs', 'purchases.mjs']);
  assert.deepEqual(callers(/createSellerSessionKeys|seller-session-keys/), ['dacs/seller-session-keys.mjs', 'index.mjs']);
});

test('while purchase actions are held, both renewal methods reject profile_not_admitted before any read', async (t) => {
  const s = await openPurchase(t);
  s.restart();
  const { createPurchaseService } = await import('../src/purchases.mjs');
  const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
  let reads = 0;
  const ops = new Proxy(s.p.ops, { get: (target, key) => (key === 'get' ? (...args) => { reads++; return target.get(...args); } : target[key]) });
  s.p.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(s.p.op.id);
  const service = createPurchaseService({ db: s.p.db, ops, coordinates: { get: () => null }, protocol: s.p.service, chain: {}, config: {}, store: createSqlitePurchaseStore(), now: () => s.w.state.time, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  const request = { operationId: s.p.op.id, token: s.p.ops.handoffTokenFor(s.p.op.id) };
  setPurchaseAdmission('held');
  reads = 0;
  await assert.rejects(service.sessionRenewal(request), code('profile_not_admitted'));
  await assert.rejects(service.sessionRenewalAccept({ ...request, delegationSignature: s.old.signature }), code('profile_not_admitted'));
  await assert.rejects(s.p.service.sessionRenewal(s.p.get()), code('profile_not_admitted'));
  await assert.rejects(s.p.service.sessionRenewalAccept(s.p.get(), s.old.signature), code('profile_not_admitted'));
  assert.equal(reads, 0);
});

test('two concurrent sessionRenewal calls in one process save one pending payload and return the same one, and across two processes the later pending payload replaces the earlier, whose accept answers session_gone_reapprove', async (t) => {
  const s = await openPurchase(t);
  const processA = s.restart(), stale = s.p.get();
  const [first, second] = await Promise.all([s.p.service.sessionRenewal(stale), s.p.service.sessionRenewal(stale)]);
  assert.deepEqual(first.delegation, second.delegation);
  const requested = () => s.p.ops.history(s.p.op.id).filter((event) => event.type === 'protocol_seller_session_renewal_requested').length;
  assert.equal(requested(), 1);
  const processB = createSellerSessionKeys();
  processB.start(s.p.op.id);
  s.session.keys = processB;
  const later = await s.p.service.sessionRenewal(s.p.get());
  assert.notEqual(later.delegation.payload.sessionPublicKey, first.delegation.payload.sessionPublicKey);
  assert.deepEqual(protocolOf(s.p).pendingSessionDelegation, { payload: later.delegation.payload });
  assert.equal(requested(), 2);
  s.session.keys = processA;
  const before = protocolOf(s.p);
  await assert.rejects(s.p.service.sessionRenewalAccept(s.p.get(), buyerSignsDelegation(s.w, first.delegation.payload)), code('session_gone_reapprove'));
  assert.deepEqual(protocolOf(s.p), before);
});

test('after a renewal, agreementPlan with the old delegation signature is refused peer_delegation_signature_invalid before an Agreement is planned, and is ignored once one is planned; in neither case is anything saved or signed with it', async (t) => {
  for (const planned of [false, true]) {
    const s = await openPurchase(t, { plan: planned });
    s.restart();
    const { renewal, signature } = await renewed(s);
    await s.p.service.sessionRenewalAccept(s.p.get(), signature);
    const before = eventCount(s.p), saved = protocolOf(s.p), signsBefore = s.signed.length;
    const retry = s.p.service.planRequest(s.p.get(), s.presentation, s.old.signature);
    if (planned) assert.ok((await retry).request);
    else await assert.rejects(retry, code('peer_delegation_signature_invalid'));
    assert.equal(eventCount(s.p), before);
    assert.deepEqual(protocolOf(s.p), saved);
    assert.deepEqual(protocolOf(s.p).sessionDelegation, { payload: renewal.delegation.payload, signature });
    assert.equal(s.signed.length, signsBefore);
  }
});
