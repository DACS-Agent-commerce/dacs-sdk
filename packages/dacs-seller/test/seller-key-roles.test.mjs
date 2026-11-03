// The seller key's closed non-effect signing roles (P20a, cases 20-21 and
// 20-22): the read-only role for answers, refusals and discovery, and the
// integrity role for the durable state's journal domain. Every cryptographic
// signer call is counted on node:crypto's sign, under the key object.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUYER, LOCAL, SELLER, cryptoCalls, discoveryPayload, importSellerKey, keyFixture, loaderSpy, openOptions, refusalOf, requestPayload, responsePayload, testBinding,
  verifiesUnder, wire,
} from './helpers/seller-key-fixture.mjs';
import { SELLER_STATE_SIGNING_DOMAIN } from '../src/dacs/seller-durable-state.mjs';

const { openSellerKey } = await importSellerKey();
const guard = await import('../src/kit-operation-guard.mjs');
const binding = await testBinding();
const { DACS_SELLER_HTTP_DOMAINS: DOMAINS, DACS_SELLER_HTTP_PATHS: PATHS } = wire;
const NOW = 1793102400000;
const REFUSAL_BODY = '{"error":"operation_uncertain","message":"A retained operation needs authenticated reconciliation."}';
const READ_BODY = '{"status":"signed"}';
const OVERSIZED_REFUSAL_BODY = JSON.stringify({ error: 'x', message: 'm'.repeat(8192) });

async function openAdmittedKey(t) {
  loaderSpy.reset();
  guard.setKitOperationGuardForTest('testnet-tp1');
  const key = await openSellerKey(openOptions(keyFixture(t)));
  t.after(() => { guard.setKitOperationGuardForTest('testnet-tp1'); key.close(); });
  return key;
}
const readOnlySigner = (key, purpose, extra = {}) => key.readOnlyAnswerSigner({ purpose, binding, local: LOCAL, ...extra });
const wireContext = (signer) => ({ signer, binding, local: LOCAL, now: NOW, purchaseProfile: binding.profile });
const responseBytes = (path, status, body, change = {}) => wire.wireEnvelopeSigningBytes({ ...responsePayload(requestPayload(binding, path), status, body), ...change });
const withPrefix = (domain, text) => Buffer.from(`${domain}${text}`);

test('(round 4) a key opened while admitted, then re-held: through the wire\'s actual signDiscoveryDocument with ready:false and signWireResponse for a read-route answer and for a signed refusal, the read-only role yields envelopes that verify under the valid binding, while effect sign refuses; the read-only role refuses request, delegation and artifact-authorization bytes, a 2xx answer on an effect route, an altered body and an invalid binding with zero cryptographic signer calls; every role refuses after close', async (t) => {
  const key = await openAdmittedKey(t);
  assert.deepEqual(Object.keys(key).sort(), ['claim', 'close', 'integritySigner', 'readOnlyAnswerSigner', 'sign'], 'no raw signing alias beside the three roles');
  guard.setKitOperationGuardForTest('off');
  assert.equal((await refusalOf(() => key.sign(Buffer.from('effect'))))?.code, 'kit_operation_guard_off', 'effect sign refuses after the re-hold');

  const served = JSON.parse(Buffer.from(await wire.signDiscoveryDocument(discoveryPayload(binding), await readOnlySigner(key, 'discovery'), binding, LOCAL)).toString());
  assert.equal(served.payload.ready, false);
  assert.ok(verifiesUnder(SELLER, wire.discoverySigningBytes(served.payload), Buffer.from(served.signature, 'base64url')), 'the discovery document verifies');

  const readRequest = requestPayload(binding, PATHS.state);
  const readHeader = await wire.signWireResponse(readRequest, 200, READ_BODY, wireContext(await readOnlySigner(key, 'read-answer', { body: READ_BODY })));
  const read = await wire.verifyWireResponse(readRequest, { header: readHeader, status: 200, body: Buffer.from(READ_BODY), now: NOW, binding, local: LOCAL });
  assert.equal(read.principal, SELLER.claim);
  const refusedRequest = requestPayload(binding, PATHS.proposals);
  const refusalHeader = await wire.signWireResponse(refusedRequest, 503, REFUSAL_BODY, wireContext(await readOnlySigner(key, 'refusal', { body: REFUSAL_BODY })));
  const refusal = await wire.verifyWireResponse(refusedRequest, { header: refusalHeader, status: 503, body: Buffer.from(REFUSAL_BODY), now: NOW, binding, local: LOCAL });
  assert.equal(refusal.principal, SELLER.claim);

  const signsBeforeRefusals = cryptoCalls.signs;
  const refusedBytes = {
    'request bytes': ['read-answer', wire.wireEnvelopeSigningBytes(readRequest), { body: READ_BODY }],
    'delegation bytes': ['read-answer', withPrefix(DOMAINS.delegation, '{}'), { body: READ_BODY }],
    'artifact authorization bytes': ['read-answer', withPrefix('dacs-artifact-authorization:v1:', '{}'), { body: READ_BODY }],
    'arbitrary bytes': ['refusal', Buffer.from('anything'), { body: REFUSAL_BODY }],
    'a 2xx answer on an effect route': ['read-answer', responseBytes(PATHS.proposals, 200, READ_BODY), { body: READ_BODY }],
    'a changed body': ['read-answer', responseBytes(PATHS.state, 200, READ_BODY), { body: '{"status":"changed"}' }],
    'an answer of another seller': ['read-answer', wire.wireEnvelopeSigningBytes({ ...responsePayload(readRequest, 200, READ_BODY), seller: BUYER.claim, buyer: SELLER.claim }), { body: READ_BODY }],
    'an answer under another profile': ['read-answer', responseBytes(PATHS.state, 200, READ_BODY, { profile: { ...binding.profile, pinVersion: 'another-pin' } }), { body: READ_BODY }],
    'a refusal status on a read answer': ['read-answer', responseBytes(PATHS.state, 503, REFUSAL_BODY), { body: REFUSAL_BODY }],
    'a 2xx status on a refusal': ['refusal', responseBytes(PATHS.proposals, 200, REFUSAL_BODY), { body: REFUSAL_BODY }],
    'a refusal body with another member': ['refusal', responseBytes(PATHS.proposals, 503, '{"error":"x","extra":1}'), { body: '{"error":"x","extra":1}' }],
    'a refusal body that is not JSON': ['refusal', responseBytes(PATHS.proposals, 503, 'refused'), { body: 'refused' }],
    'an oversized refusal body': ['refusal', responseBytes(PATHS.proposals, 503, OVERSIZED_REFUSAL_BODY), { body: OVERSIZED_REFUSAL_BODY }],
    'discovery bytes for an answer': ['read-answer', wire.discoverySigningBytes(discoveryPayload(binding)), { body: READ_BODY }],
    'answer bytes for discovery': ['discovery', responseBytes(PATHS.state, 200, READ_BODY), {}],
    'discovery of another seller': ['discovery', wire.discoverySigningBytes(discoveryPayload(binding, { seller: BUYER.claim })), {}],
    'bytes past the discovery limit': ['discovery', withPrefix(DOMAINS.discovery, 'a'.repeat(wire.DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes)), {}],
  };
  for (const [name, [purpose, bytes, extra]] of Object.entries(refusedBytes)) {
    const signer = await readOnlySigner(key, purpose, extra);
    assert.equal((await refusalOf(() => signer.sign(bytes)))?.code, 'seller_key_role_refused', name);
  }
  const forgedBinding = { ...binding };
  const refusedSigners = {
    'a forged binding': () => key.readOnlyAnswerSigner({ purpose: 'discovery', binding: forgedBinding, local: LOCAL }),
    'a changed local connection': () => key.readOnlyAnswerSigner({ purpose: 'discovery', binding, local: { ...LOCAL, connectionId: 'another-conn' } }),
    'an unknown purpose': () => readOnlySigner(key, 'effect', { body: READ_BODY }),
    'an answer with no body': () => readOnlySigner(key, 'read-answer'),
    'discovery with a body': () => readOnlySigner(key, 'discovery', { body: READ_BODY }),
  };
  for (const [name, run] of Object.entries(refusedSigners)) assert.equal((await refusalOf(run))?.code, 'seller_key_role_refused', name);
  const once = await readOnlySigner(key, 'read-answer', { body: READ_BODY });
  const answerBytes = responseBytes(PATHS.state, 200, READ_BODY);
  assert.equal(once.sign(answerBytes).length, 64);
  assert.equal((await refusalOf(() => once.sign(answerBytes)))?.code, 'seller_key_role_refused', 'a read-only signer is single-use');
  assert.equal(cryptoCalls.signs - signsBeforeRefusals, 1, 'only the one valid answer reached the cryptographic signer');

  const issuedBeforeClose = await readOnlySigner(key, 'read-answer', { body: READ_BODY });
  key.close();
  guard.setKitOperationGuardForTest('testnet-tp1');
  const afterClose = {
    'effect sign': () => key.sign(Buffer.from('effect')),
    'integrity sign': () => key.integritySigner.sign(Buffer.from(`${SELLER_STATE_SIGNING_DOMAIN}{}`)),
    'a new read-only signer': () => readOnlySigner(key, 'discovery'),
    'a read-only signer issued before close': () => issuedBeforeClose.sign(answerBytes),
  };
  for (const [name, run] of Object.entries(afterClose)) assert.equal((await refusalOf(run))?.code, 'seller_key_closed', name);
  assert.equal(cryptoCalls.signs - signsBeforeRefusals, 1, 'nothing signed after close');
});

test('custody-close-during-role-binding: closing custody while a read-only role awaits its binding check refuses the pending role and every retained role, so a late result restores no signing access', async (t) => {
  const key = await openAdmittedKey(t);
  const answerBytes = responseBytes(PATHS.state, 200, READ_BODY);
  const retained = await readOnlySigner(key, 'read-answer', { body: READ_BODY });
  const before = cryptoCalls.signs;
  const pending = readOnlySigner(key, 'read-answer', { body: READ_BODY });
  key.close();
  assert.equal((await refusalOf(() => pending))?.code, 'seller_key_closed', 'the pending role is never handed out');
  assert.equal((await refusalOf(() => retained.sign(answerBytes)))?.code, 'seller_key_closed', 'a role retained from before the close refuses');
  assert.equal((await refusalOf(() => key.integritySigner.sign(Buffer.from(`${SELLER_STATE_SIGNING_DOMAIN}{}`))))?.code, 'seller_key_closed');
  assert.equal(cryptoCalls.signs - before, 0, 'no cryptographic signer call after the close');
});

test('(round 4) the integrity role signs only bytes beginning with the seller-state journal domain; Agreement, commitment, settlement-evidence, wire request, response, delegation, discovery and arbitrary bytes refuse with zero cryptographic signer calls; it stays usable after a re-hold and refuses after close', async (t) => {
  const key = await openAdmittedKey(t);
  const { integritySigner } = key;
  assert.deepEqual(Object.keys(integritySigner).sort(), ['claim', 'sign']);
  assert.equal(integritySigner.claim, SELLER.claim);
  guard.setKitOperationGuardForTest('off');
  const record = withPrefix(SELLER_STATE_SIGNING_DOMAIN, '{"record":"journal entry"}');
  const signsBefore = cryptoCalls.signs;
  assert.ok(verifiesUnder(SELLER, record, integritySigner.sign(record)), 'a journal record signs after a re-hold and verifies under the claim');
  assert.equal(cryptoCalls.signs - signsBefore, 1);
  const refused = {
    Agreement: withPrefix('dacs-agreement:v1:', '{}'),
    commitment: withPrefix('dacs-commitment:v1:', '{}'),
    'settlement evidence': withPrefix('dacs-settlement-evidence:v1:', '{}'),
    'wire request': wire.wireEnvelopeSigningBytes(requestPayload(binding, PATHS.state)),
    'wire response': responseBytes(PATHS.state, 200, READ_BODY),
    delegation: withPrefix(DOMAINS.delegation, '{}'),
    discovery: wire.discoverySigningBytes(discoveryPayload(binding)),
    'arbitrary bytes': Buffer.from('anything'),
    'no bytes': Buffer.alloc(0),
    'the domain with its last byte missing': Buffer.from(SELLER_STATE_SIGNING_DOMAIN.slice(0, -1)),
    'the domain after another byte': withPrefix(' ', SELLER_STATE_SIGNING_DOMAIN),
    'text, not bytes': SELLER_STATE_SIGNING_DOMAIN,
  };
  for (const [name, bytes] of Object.entries(refused)) assert.equal((await refusalOf(() => integritySigner.sign(bytes)))?.code, 'seller_key_role_refused', name);
  assert.equal(cryptoCalls.signs - signsBefore, 1, 'every refused byte string made zero cryptographic signer calls');
  key.close();
  assert.equal((await refusalOf(() => integritySigner.sign(record)))?.code, 'seller_key_closed');
  assert.equal(cryptoCalls.signs - signsBefore, 1);
});
