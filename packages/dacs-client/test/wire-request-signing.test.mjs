import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { world, request, code, encode, OLD_REQUEST, setPurchaseAdmission } from './helpers/wire-client-fixture.mjs';
const { createSellerAgentClient } = await import('../src/dacs/seller-http.mjs');
const response = async (w, signed, { offset = 0, text = '{"ok":true}', expiresAt } = {}) => {
  const payload = {
    ...signed.payload, kind: 'response', bodyHash: sha256Hex(text), requestHash: wire.wireRequestHash(signed.payload), status: 200, expiresAt: expiresAt ?? w.state.time + offset + 30000
  };
  return { payload, header: encode(payload, w.seller, wire.DACS_SELLER_HTTP_DOMAINS.response), status: 200, body: Buffer.from(text) };
};
test("a seller request is signed under dacs-seller-http:v1:request: and carries the purchase's kept TP-1 profile", async (t) => {
  const w = await world(t), s = await request(w);
  assert.deepEqual(s.payload.profile, w.binding.profile);
  assert.equal(w.state.signs[0].toString(), wire.DACS_SELLER_HTTP_DOMAINS.request + canonicalize(s.payload));
});
test("a request whose kept profile differs from the binding's is refused before the signer is called", async (t) => {
  const w = await world(t);
  w.auth = w.createSellerWireAuthentication({ ...w.options, job: { ...w.job, profile: { ...w.binding.profile, revision: 'TP-1.1' } } });
  await assert.rejects(request(w), code('tp1_purchase_profile_mismatch'));
  assert.equal(w.state.signs.length, 0);
});
test("a request after the actor's connection changed is refused tp1_local_binding_changed before signing (K7-FENCE-1)", async (t) => {
  const w = await world(t);
  w.local.connectionId = 'changed';
  await assert.rejects(request(w), code('tp1_local_binding_changed'));
  assert.equal(w.state.signs.length, 0);
});
test("the signed request lifetime is 30 s and a 30,001 ms lifetime is refused", async (t) => {
  const w = await world(t), s = await request(w);
  assert.equal(s.payload.expiresAt - w.state.time, 30000);
  await assert.rejects(wire.signWireRequest({
    signer: w.options.sessionSigner, binding: w.binding, local: w.local, now: w.state.time, endpointProof: w.endpointProof, publicEndpoint: w.publicEndpoint, path: s.payload.path, jobId: s.payload.jobId, text: '{}', seller: w.seller.claim, job: w.job, lifetimeMs: 30001
  }), TypeError);
});
test("responses from a seller clock 30 s ahead or behind verify, and one expiring more than 60 s after the client clock is refused peer_response_mismatch", async (t) => {
  const w = await world(t), s = await request(w);
  for (const offset of [-29999, 30000])
    assert.deepEqual((await w.auth.verifyResponse(s.payload, await response(w, s, { offset }))).body, { ok: true });
  await assert.rejects(w.auth.verifyResponse(s.payload, await response(w, s, { offset: -30000 })), code('peer_response_mismatch'));
  await assert.rejects(w.auth.verifyResponse(s.payload, await response(w, s, { expiresAt: w.state.time + 60001 })), code('peer_response_mismatch'));
});
test("a response signed under dacs-chatgpt-plugin:loopback-seller-peer:v1: is refused and never verified under a fallback", async (t) => {
  const w = await world(t), s = await request(w), r = await response(w, s);
  r.header = encode(r.payload, w.seller, OLD_REQUEST);
  await assert.rejects(w.auth.verifyResponse(s.payload, r), code('peer_signature_invalid'));
});
test("an old-transport seller answering a wire request is refused and the client sends nothing under the old domain", async (t) => {
  const w = await world(t);
  let calls = 0;
  const client = createSellerAgentClient({
    url: w.publicEndpoint, authentication: w.auth, fetchImpl: async (_url, init) => {
      calls++;
      const envelope = JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url'));
      assert.equal(w.state.signs[0].toString().startsWith(wire.DACS_SELLER_HTTP_DOMAINS.request), true);
      const r = await response(w, envelope);
      return new Response(r.body, { headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: encode(r.payload, w.seller, OLD_REQUEST) } });
    }
  });
  await assert.rejects(client.agreementState({ jobId: w.delegation.payload.jobId }));
  assert.equal(calls, 1);
});
test("a response without a profile, with revision TP-1.1 or with the r1 pinVersion is refused with the wire's peer-profile code (K7-PEER-1 to -3)", async (t) => {
  const w = await world(t), s = await request(w);
  {
    const expected = 'tp1_profile_missing';
    const r = await response(w, s);
    delete r.payload.profile;
    r.header = encode(r.payload, w.seller, wire.DACS_SELLER_HTTP_DOMAINS.response);
    await assert.rejects(w.auth.verifyResponse(s.payload, r), code(expected));
  }
  for (const [profile, expected] of [[{ ...w.binding.profile, revision: 'TP-1.1' }, 'tp1_profile_revision_unknown'], [{ ...w.binding.profile, pinVersion: 'dacs-demos-testnet-identity/2026-10-20' }, 'tp1_profile_mismatch']]) {
    const r = await response(w, s);
    r.payload.profile = profile;
    r.header = encode(r.payload, w.seller, wire.DACS_SELLER_HTTP_DOMAINS.response);
    await assert.rejects(w.auth.verifyResponse(s.payload, r), code(expected));
  }
});
test("the response passed to verification is the exact received bytes and the admitted body it returns is the one used", async (t) => {
  const w = await world(t);
  let exact;
  const auth = {
    request: (...args) => w.auth.request(...args), async verifyResponse(payload, received) {
      assert.deepEqual(received.body, exact);
      assert.equal(received.text, undefined);
      const receipt = await w.auth.verifyResponse(payload, received);
      return { ...receipt, body: { admitted: true } };
    }
  };
  const client = createSellerAgentClient({
    url: w.publicEndpoint, authentication: auth, fetchImpl: async (_url, init) => {
      const envelope = JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url'));
      const r = await response(w, envelope, { text: '{ "ok" : true }' });
      exact = r.body;
      return new Response(exact, { headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: r.header } });
    }
  });
  assert.deepEqual(await client.agreementState({ jobId: w.payload.jobId }), { admitted: true });
});
test('a signed response with changed body bytes is refused before its status is used', async (t) => {
  const w = await world(t);
  const client = createSellerAgentClient({ url: w.publicEndpoint, authentication: w.auth, fetchImpl: async (_url, init) => {
    const envelope = JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url'));
    const signed = await response(w, envelope, { text: '{"ok":true}' });
    return new Response('{"ok":false}', { headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: signed.header } });
  } });
  await assert.rejects(client.agreementState({ jobId: w.payload.jobId }));
  assert.equal(client.failureCause, 'response-auth');
});
test("the injected session signer receives the exact wire signing bytes once per request", async (t) => {
  const w = await world(t), s = await request(w);
  assert.equal(w.state.signs.length, 1);
  assert.deepEqual(w.state.signs[0], Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.request + canonicalize(s.payload)));
});
test("admission re-held while the wire's binding and proof checks are awaited gives zero session-signer calls", async (t) => {
  const w = await world(t);
  let entered, release;
  const gate = new Promise(r => release = r), at = new Promise(r => entered = r);
  w.state.gate = async () => {
    entered();
    await gate;
  };
  const pending = request(w);
  await at;
  setPurchaseAdmission('held');
  release();
  await assert.rejects(pending, code('profile_not_admitted'));
  assert.equal(w.state.signs.length, 0);
});
test('a copied binding, missing delegation and unverified endpoint proof refuse before signing', async (t) => {
  const w = await world(t);
  assert.throws(() => w.createSellerWireAuthentication({ ...w.options, delegation: null }), code('seller_delegation_unavailable'));
  w.auth = w.createSellerWireAuthentication({ ...w.options, admission: { ...w.admission, binding: structuredClone(w.binding) } });
  await assert.rejects(request(w), code('tp1_binding_required'));
  w.auth = w.createSellerWireAuthentication({ ...w.options, endpointProof: {} });
  await assert.rejects(request(w), code('endpoint_proof_required'));
  assert.equal(w.state.signs.length, 0);
});
test('a connection replacement during wire authority awaits refuses before signing', async (t) => {
  const w = await world(t);
  w.auth = w.createSellerWireAuthentication({ ...w.options, admission: { ...w.admission, currentLocal: () => w.local } });
  w.state.gate = async () => {
    w.local.connectionId = 'changed-during-authority';
  };
  await assert.rejects(request(w), code('tp1_local_binding_changed'));
  assert.equal(w.state.signs.length, 0);
});
test('a failed session signature sends no HTTP request', async (t) => {
  const w = await world(t);
  let signatures = 0, sends = 0;
  const authentication = w.createSellerWireAuthentication({ ...w.options, sessionSigner: { claim: w.session.claim, sign() {
        signatures++;
        throw Error('TEST-signature-failed');
      } } });
  const client = createSellerAgentClient({ url: w.publicEndpoint, authentication, fetchImpl: async () => {
      sends++;
      throw Error('unexpected dispatch');
    } });
  await assert.rejects(client.agreementState({ jobId: w.payload.jobId }));
  assert.equal(signatures, 1);
  assert.equal(sends, 0);
});
test('a lost HTTP response does not replay or fall back to the old domain', async (t) => {
  const w = await world(t);
  let sends = 0;
  const client = createSellerAgentClient({ url: w.publicEndpoint, authentication: w.auth, fetchImpl: async () => {
      sends++;
      throw Error('TEST-response-lost');
    } });
  await assert.rejects(client.agreementState({ jobId: w.payload.jobId }));
  assert.equal(sends, 1);
  assert.equal(w.state.signs.length, 1);
  assert.ok(w.state.signs[0].toString().startsWith(wire.DACS_SELLER_HTTP_DOMAINS.request));
});
test('response verification remains within the HTTP deadline', async (t) => {
  const w = await world(t), controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const authentication = { request: (...args) => w.auth.request(...args), verifyResponse() {
      controller.abort(new DOMException('TEST-verification-timeout', 'TimeoutError'));
      return new Promise(() => {
      });
    } };
  const client = createSellerAgentClient({ url: w.publicEndpoint, authentication, fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.agreementState({ jobId: w.payload.jobId }));
  assert.equal(client.failureCause, 'timeout');
});
const deadline = (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  return () => controller.abort(new DOMException('TEST-deadline', 'TimeoutError'));
};const turn = () => new Promise(resolve => setImmediate(resolve));
const outcome = (call) => Promise.race([call.then(() => 'resolved', (error) => error), turn().then(() => 'pending')]);
test('an authority read that never answers ends at the HTTP deadline with cause timeout, and nothing is signed or sent', async (t) => {
  const w = await world(t), expire = deadline(t);
  let release, sends = 0;
  w.state.gate = () => new Promise(resolve => release = resolve);
  const client = createSellerAgentClient({ url: w.publicEndpoint, authentication: w.auth, fetchImpl: async () => {
      sends++;
      throw Error('unexpected dispatch');
    } });
  const call = client.agreementState({ jobId: w.payload.jobId });
  await turn();
  expire();
  assert.equal((await outcome(call)).name, 'SellerUnavailableError');
  assert.equal(client.failureCause, 'timeout');
  release();
  await turn();
  assert.equal(w.state.signs.length, 0, 'the signer is not called after the deadline');
  assert.equal(sends, 0);
});
test('a signature that finishes after the HTTP deadline is dropped and nothing is sent', async (t) => {
  const w = await world(t), expire = deadline(t);
  let release, sends = 0;
  const authentication = w.createSellerWireAuthentication({ ...w.options, sessionSigner: { claim: w.session.claim, sign: (bytes) => new Promise(resolve => release = () => resolve(w.session.sign(bytes))) } });
  const client = createSellerAgentClient({ url: w.publicEndpoint, authentication, fetchImpl: async () => {
      sends++;
      throw Error('unexpected dispatch');
    } });
  const call = client.agreementState({ jobId: w.payload.jobId });
  while (!release) await turn();
  expire();
  assert.equal((await outcome(call)).name, 'SellerUnavailableError');
  assert.equal(client.failureCause, 'timeout');
  release();
  await turn();
  assert.equal(sends, 0);
});
