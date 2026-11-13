import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { world, purchase, request, code, OLD_DELEGATION, T0, JOB } from './helpers/wire-client-fixture.mjs';
const bytes = p => Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(p));
const identity = async (p) => p.service.identityRequest(p.get(), p.op.terms.buyer.wallet);
const plan = (p, w, result, signature) => p.service.planRequest(result.operation, w.buyer.sign(Buffer.from(result.message)).toString('base64url'), signature);
test("the delegation payload carries the binding's profile and notBefore 30 s before the client clock, and the wallet message is the wire's signing bytes (K2-DEL-1)", async (t) => {
  const w = await world(t), p = await purchase(t, w), r = await identity(p);
  assert.deepEqual(r.delegation.payload.profile, w.binding.profile);
  assert.equal(r.delegation.payload.notBefore, T0 - 30000);
  assert.deepEqual(Buffer.from(r.delegation.message), bytes(r.delegation.payload));
  assert.deepEqual(p.get().state.protocol.sessionDelegation.payload, r.delegation.payload);
  const vector = await wire.sellerSessionDelegationSigningBytes({ ...w.payload, expiresAt: T0 + 3600000 }, w.binding, w.local);
  assert.equal(vector.length, 821);
  assert.equal(sha256Hex(vector), '5d43ce506fd18689880b65a345eadd9b1f0767d0103460e54e358e464bccf922');
});
test("wallet signatures in hex, 0x-prefixed hex and base64url are accepted and stored as canonical base64url (K2-DEL-16)", async (t) => {
  for (const encoding of ['hex', 'prefixed', 'base64url']) {
    const w = await world(t), p = await purchase(t, w), r = await identity(p), sig = w.buyer.sign(bytes(r.delegation.payload));
    const supplied = encoding === 'prefixed' ? '0x' + sig.toString('hex') : sig.toString(encoding);
    await plan(p, w, r, supplied);
    assert.equal(p.get().state.protocol.sessionDelegation.signature, sig.toString('base64url'));
  }
});
test("a delegation signed under dacs-chatgpt-plugin:seller-session-delegation:v1: is refused peer_delegation_signature_invalid (K2-DEL-11)", async (t) => {
  const w = await world(t), p = await purchase(t, w), r = await identity(p);
  const signature = w.buyer.sign(Buffer.from(OLD_DELEGATION + canonicalize(r.delegation.payload))).toString('base64url');
  await assert.rejects(plan(p, w, r, signature), code('peer_delegation_signature_invalid'));
  assert.equal(w.state.signs.length, 0);
});
test("every member of the delegation payload and its signature is mutated once, and each mutation is refused before any request is signed, with zero signer calls: job (another job); buyer (another buyer); seller (another seller); Listing pin (another pin); profile (absent, or revision TP-1.1); notBefore (not yet valid); expiresAt (expired, or over 24 h); sessionPublicKey (the buyer's key, the seller's own key, and the delegation's signing key); the signature (signed by the session key, or altered) (K2-DEL-3, 5, 6, 7, 9, 12, 13, 14, 15, 17). The mutation list is generated from the payload's own members, so a new member with no mutation fails the test. The seller's-own-key row refuses `peer_delegation_invalid` (K2-DEL-17; the wire's check is P03b's)", async (t) => {
  const w = await world(t);
  const mutations = {
    version: [p => p.version = '2'], kind: [p => p.kind = 'other'], jobId: [p => p.jobId = '01M5YKPJG048H248H248H248H2'], buyer: [p => p.buyer = w.other.claim], seller: [p => p.seller = w.other.claim], listingPin: [p => p.listingPin.contentHash = 'a'.repeat(64)], profile: [p => delete p.profile, p => p.profile.revision = 'TP-1.1'], notBefore: [p => p.notBefore = T0 + 1], expiresAt: [p => p.expiresAt = T0, p => p.expiresAt = p.notBefore + 86400001], sessionPublicKey: [p => p.sessionPublicKey = w.buyer.raw, p => p.sessionPublicKey = w.seller.raw]
  };
  assert.deepEqual(Object.keys(mutations).sort(), Object.keys(w.payload).sort());
  for (const member of Object.keys(w.payload))
    for (const mutate of mutations[member]) {
      const payload = structuredClone(w.payload);
      mutate(payload);
      const delegation = { payload, signature: w.buyer.sign(bytes(payload)).toString('base64url') };
      w.auth = w.createSellerWireAuthentication({ ...w.options, delegation });
      await assert.rejects(request(w, wire.DACS_SELLER_HTTP_PATHS.contextChallenge), error => {
        if (member === 'sessionPublicKey')
          assert.equal(error.code, 'peer_delegation_invalid');
        return Boolean(error.code);
      }, member);
    }
  for (const signature of [w.session.sign(bytes(w.payload)).toString('base64url'), Buffer.alloc(64, 9).toString('base64url')]) {
    w.auth = w.createSellerWireAuthentication({ ...w.options, delegation: { ...w.delegation, signature } });
    await assert.rejects(request(w), code('peer_delegation_signature_invalid'));
  }
  assert.equal(w.state.signs.length, 0);
});
test("a derived Agreement deadline earlier than the delegation's expiry is refused seller_delegation_invalid (K2-DEL-8)", async (t) => {
  const w = await world(t), p = await purchase(t, w, { policy: () => ({ expiresAt: T0 + 7200000 }) }), r = await identity(p);
  await assert.rejects(plan(p, w, r, w.buyer.sign(bytes(r.delegation.payload)).toString('base64url')), code('seller_delegation_invalid'));
  assert.equal(p.get().state.protocol.planned, undefined);
});
test("an expired delegation still signs readback requests and no new effect starts under it", async (t) => {
  const w = await world(t);
  w.delegation.payload.expiresAt = T0 - 1;
  w.delegation.signature = w.buyer.sign(bytes(w.payload)).toString('base64url');
  await request(w);
  await assert.rejects(request(w, wire.DACS_SELLER_HTTP_PATHS.contextChallenge), code('peer_delegation_expired'));
  await assert.rejects(wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(w.delegation)), { binding: w.binding, local: w.local, seller: w.seller.claim, listingPin: w.pin, jobId: JOB, time: w.state.time }), code('peer_delegation_expired'));
  assert.equal(w.state.signs.length, 1);
});
test("sessionPolicyFor absent, throwing, non-integer, non-finite, not after notBefore or more than 24 h after notBefore refuses before any wallet message is returned, and exactly 24 h is accepted (K2-DEL-9, -10)", async (t) => {
  const w = await world(t);
  const { createSourceDemoSellerTransport } = await import('../src/dacs/source-demo-seller-transport.mjs');
  assert.throws(() => createSourceDemoSellerTransport({ authority: 'TEST-wire', sessionSignerFor: () => w.session, endpointProofFor: () => w.endpointProof }), TypeError);
  for (const value of [null, {}, { expiresAt: 1.2 }, { expiresAt: Infinity }, { expiresAt: T0 - 30000 }, { expiresAt: T0 - 30000 + 86400001 }, 'throw']) {
    const p = await purchase(t, w, { policy: () => {
        if (value === 'throw')
          throw Error('TEST-policy');
        return value;
      } });
    await assert.rejects(identity(p));
    assert.equal(p.get().state.protocol.sessionDelegation, undefined);
  }
  const p = await purchase(t, w, { policy: () => ({ expiresAt: T0 - 30000 + 86400000 }) });
  assert.equal((await identity(p)).delegation.payload.expiresAt, T0 - 30000 + 86400000);
});
test('a session signer without a claim refuses before a delegation payload is saved', async (t) => {
  const w = await world(t);
  w.options = { ...w.options, sessionSigner: { sign() {} } };
  const p = await purchase(t, w);
  await assert.rejects(identity(p), code('seller_delegation_invalid'));
  assert.equal(p.get().state.protocol.sessionDelegation, undefined);
});
test("with an authority reader that answers late, identityRequest resolves to a wallet message holding bytes, never a nested Promise, and only after the binding check", async (t) => {
  const w = await world(t), p = await purchase(t, w);
  let entered, release, finished = false;
  const at = new Promise(r => entered = r), gate = new Promise(r => release = r);
  w.state.gate = async () => {
    entered();
    await gate;
  };
  const pending = identity(p).then(r => {
    finished = true;
    return r;
  });
  await at;
  assert.equal(finished, false);
  release();
  const r = await pending;
  assert.equal(typeof r.delegation.message, 'string');
  assert.deepEqual(Buffer.from(r.delegation.message), bytes(r.delegation.payload));
});
test("a repeated identity request and one after a restart return the same payload and message bytes, and never ask sessionPolicyFor for a new expiry", async (t) => {
  const w = await world(t), p = await purchase(t, w);
  w.state.gate = async () => {
    if (p.get().state.protocol.sessionDelegation)
      throw Error('TEST-authority-cut-after-save');
  };
  await assert.rejects(identity(p));
  const saved = p.get().state.protocol.sessionDelegation.payload;
  w.state.gate = null;
  const a = await identity(p), b = await identity(p);
  p.reopen();
  const c = await identity(p);
  for (const r of [a, b, c]) {
    assert.deepEqual(r.delegation.payload, saved);
    assert.deepEqual(Buffer.from(r.delegation.message), bytes(saved));
  }
  assert.equal(p.policies(), 1);
});
test('two concurrent identity requests save one payload and return one message', async (t) => {
  const w = await world(t), p = await purchase(t, w);
  const old = p.get();
  const [a, b] = await Promise.all([p.service.identityRequest(old, w.buyer.address), p.service.identityRequest(old, w.buyer.address)]);
  assert.deepEqual(a.delegation, b.delegation);
  assert.equal(p.policies(), 1);
  assert.equal(p.ops.history(p.op.id).filter(e => e.type === 'protocol_seller_session_requested').length, 1);
});
test('a retained payload past expiry or inside the margin after restart returns no wallet message and mints no new payload', async (t) => {
  const w = await world(t), p = await purchase(t, w), a = await identity(p);
  for (const time of [a.delegation.payload.expiresAt - 1, a.delegation.payload.expiresAt + 1]) {
    w.state.time = time;
    p.reopen();
    await assert.rejects(identity(p), code('seller_delegation_expiring'));
    assert.deepEqual(p.get().state.protocol.sessionDelegation.payload, a.delegation.payload);
  }
  assert.equal(p.policies(), 1);
});
test('a failed payload save returns no wallet message and restart retains the first saved payload', async (t) => {
  const w = await world(t), p = await purchase(t, w);
  p.db.exec(`CREATE TRIGGER refuse_payload BEFORE UPDATE ON operations
  WHEN json_extract(NEW.state,'$.protocol.sessionDelegation.payload') IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'TEST-payload-save-failure'); END`);
  await assert.rejects(identity(p), /TEST-payload-save-failure/);
  assert.equal(p.get().state.protocol.sessionDelegation, undefined);
  p.reopen();
  p.db.exec('DROP TRIGGER refuse_payload');
  const first = await identity(p);
  assert.deepEqual((await identity(p)).delegation, first.delegation);
  assert.equal(p.policies(), 2);
});
test('a failed signature save reuses the retained delegation and wallet signature after restart', async (t) => {
  const w = await world(t), p = await purchase(t, w), r = await identity(p);
  const signature = w.buyer.sign(bytes(r.delegation.payload)).toString('base64url');
  p.db.exec(`CREATE TRIGGER refuse_signature BEFORE UPDATE ON operations
  WHEN json_extract(NEW.state,'$.protocol.sessionDelegation.signature') IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'TEST-signature-save-failure'); END`);
  await assert.rejects(plan(p, w, r, signature), /TEST-signature-save-failure/);
  assert.equal(p.get().state.protocol.sessionDelegation.signature, undefined);
  p.reopen();
  p.db.exec('DROP TRIGGER refuse_signature');
  const retained = await identity(p);
  assert.deepEqual(retained.delegation, r.delegation);
  await plan(p, w, retained, signature);
  assert.equal(p.get().state.protocol.sessionDelegation.signature, signature);
  assert.equal(p.policies(), 1);
});
// Each deadline the code starts is a fresh signal; the returned function ends the ones started so far.
const deadline = (t) => {
  const controllers = [];
  t.mock.method(AbortSignal, 'timeout', () => {
    controllers.push(new AbortController());
    return controllers.at(-1).signal;
  });
  return () => controllers.forEach(controller => controller.abort(new DOMException('TEST-deadline', 'TimeoutError')));
};
const turn = () => new Promise(resolve => setImmediate(resolve));
// The method's own admission check reads the authority first and answers; every later read never does.
const silentAfterEntry = (w) => {
  let reads = 0;
  w.state.gate = () => ++reads > 1 ? new Promise(() => {}) : undefined;
};
const outcome = (call) => Promise.race([call.then(() => 'resolved', (error) => error), turn().then(() => 'pending')]);
test('an authority read that never answers ends the wallet message at the seller deadline, and the saved payload is reused after it', async (t) => {
  const w = await world(t), p = await purchase(t, w), expire = deadline(t);
  silentAfterEntry(w);
  const call = identity(p);
  await turn();
  expire();
  assert.equal((await outcome(call)).code, 'seller_authority_timeout');
  const saved = p.get().state.protocol.sessionDelegation.payload;
  w.state.gate = null;
  assert.deepEqual((await identity(p)).delegation.payload, saved);
  assert.equal(p.policies(), 1);
});
test('an authority read that never answers while the wallet delegation is accepted ends at the seller deadline and saves no signature', async (t) => {
  const w = await world(t), p = await purchase(t, w), expire = deadline(t), r = await identity(p);
  silentAfterEntry(w);
  const call = plan(p, w, r, w.buyer.sign(bytes(r.delegation.payload)).toString('base64url'));
  await turn();
  expire();
  assert.equal((await outcome(call)).code, 'seller_authority_timeout');
  assert.equal(p.get().state.protocol.sessionDelegation.signature, undefined);
});
test('an authority read that never answers while the Agreement plan is saved ends at the seller deadline with its own cause', async (t) => {
  const w = await world(t), p = await purchase(t, w), expire = deadline(t), r = await identity(p);
  w.state.gate = async () => {
    if (p.get().state.protocol.sessionDelegation.signature)
      await new Promise(() => {});
  };
  const call = plan(p, w, r, w.buyer.sign(bytes(r.delegation.payload)).toString('base64url'));
  await turn();
  expire();
  assert.equal((await outcome(call)).code, 'seller_authority_timeout');
  assert.equal(p.get().state.protocol.planned, undefined);
});
