// The seller key's closed non-effect signing roles (P20a, cases 20-21 and
// 20-22): the read-only role for answers, refusals and discovery, and the
// integrity role for the durable state's journal domain. Every cryptographic
// signer call is counted on node:crypto's sign, under the key object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUYER, JOB, LOCAL, SELLER, controlledBinding, cryptoCalls, discoveryPayload, importSellerKey, keyFixture, loaderSpy, openOptions, refusalOf, requestPayload,
  responsePayload, testBinding, verifiesUnder, wire,
} from './helpers/seller-key-fixture.mjs';
import { SELLER_STATE_SIGNING_DOMAIN, createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';

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
  assert.equal((await once.sign(answerBytes)).length, 64);
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

const answerBytesUnder = (scoped, path, status, body) => wire.wireEnvelopeSigningBytes(responsePayload(requestPayload(scoped, path), status, body));
/** One role of each read-only purpose minted under `scoped`, each with the exact bytes the wire would hand it. */
async function mintedRoles(key, scoped) {
  return {
    discovery: [await key.readOnlyAnswerSigner({ purpose: 'discovery', binding: scoped, local: LOCAL }), wire.discoverySigningBytes(discoveryPayload(scoped))],
    'read answer': [await key.readOnlyAnswerSigner({ purpose: 'read-answer', binding: scoped, local: LOCAL, body: READ_BODY }), answerBytesUnder(scoped, PATHS.state, 200, READ_BODY)],
    refusal: [await key.readOnlyAnswerSigner({ purpose: 'refusal', binding: scoped, local: LOCAL, body: REFUSAL_BODY }), answerBytesUnder(scoped, PATHS.proposals, 503, REFUSAL_BODY)],
  };
}
/** A reader answer that waits until the test releases it; `waiting` resolves once the reader is waiting. */
function heldAnswer() {
  const held = {};
  held.waiting = new Promise((resolve) => { held.reached = resolve; });
  held.answer = () => { held.reached(); return new Promise((resolve) => { held.release = resolve; }); };
  return held;
}

test('a minted read-only role signs only for the job or discovery session the authority admits when it signs: a reader that admits the connection but refuses the job or the discovery session leaves every directly signed role refused with zero cryptographic signer calls', async (t) => {
  const key = await openAdmittedKey(t);
  const { binding: scoped, control } = await controlledBinding();
  const refusedSessions = new Set([JOB, wire.DACS_SELLER_DISCOVERY_FORMAT]);
  control.answer = (scope) => { if (refusedSessions.has(scope.sessionId)) throw new Error('TEST session refused'); };
  const roles = await mintedRoles(key, scoped);
  const before = cryptoCalls.signs;
  for (const [name, [role, bytes]] of Object.entries(roles)) assert.equal((await refusalOf(() => role.sign(bytes)))?.code, 'seller_key_role_refused', name);
  assert.equal(cryptoCalls.signs - before, 0, 'nothing reached the cryptographic signer for a refused session');
  const asked = control.calls.filter((scope) => scope.sessionId !== null);
  assert.deepEqual(asked.map((scope) => [scope.sessionId, scope.participants]), [
    [wire.DACS_SELLER_DISCOVERY_FORMAT, [SELLER.claim]], [JOB, [BUYER.claim, SELLER.claim]], [JOB, [BUYER.claim, SELLER.claim]],
  ], 'each role asked for its own session and participants');
  // Control: the same roles under a reader that admits every session sign, and the signatures verify.
  for (const [name, [role, bytes]] of Object.entries(await mintedRoles(key, binding))) assert.ok(verifiesUnder(SELLER, bytes, await role.sign(bytes)), `${name} signs when admitted`);
  assert.equal(cryptoCalls.signs - before, 3);
});

test('closing custody while a minted role awaits its signing-time authority check refuses it seller_key_closed with zero signer calls; a reader that throws, or is slow and then refuses, refuses the role', async (t) => {
  const key = await openAdmittedKey(t);
  const { binding: scoped, control } = await controlledBinding();
  const bytes = answerBytesUnder(scoped, PATHS.state, 200, READ_BODY);
  const mint = () => key.readOnlyAnswerSigner({ purpose: 'read-answer', binding: scoped, local: LOCAL, body: READ_BODY });
  const before = cryptoCalls.signs;
  const throwing = await mint();
  control.answer = (scope) => { if (scope.sessionId === JOB) throw new Error('TEST reader failed'); };
  assert.equal((await refusalOf(() => throwing.sign(bytes)))?.code, 'seller_key_role_refused', 'a reader that throws');
  const slow = await mint();
  control.answer = (scope) => (scope.sessionId === JOB ? new Promise((resolve, reject) => setImmediate(() => reject(new Error('TEST refused late')))) : undefined);
  assert.equal((await refusalOf(() => slow.sign(bytes)))?.code, 'seller_key_role_refused', 'a reader that is slow and then refuses');
  const pending = await mint();
  const held = heldAnswer();
  control.answer = (scope) => (scope.sessionId === JOB ? held.answer() : undefined);
  const signing = refusalOf(() => pending.sign(bytes));
  await held.waiting;
  key.close();
  held.release();
  assert.equal((await signing)?.code, 'seller_key_closed', 'the close during the await wins over the late admission');
  assert.equal(cryptoCalls.signs - before, 0);
});

test('a minted role signs the bytes it was given when sign was called: changing the caller\'s buffer during the authority await changes nothing it signs', async (t) => {
  const key = await openAdmittedKey(t);
  const { binding: scoped, control } = await controlledBinding();
  const role = await key.readOnlyAnswerSigner({ purpose: 'read-answer', binding: scoped, local: LOCAL, body: READ_BODY });
  const original = answerBytesUnder(scoped, PATHS.state, 200, READ_BODY);
  const callerBuffer = Buffer.from(original);
  const held = heldAnswer();
  control.answer = (scope) => (scope.sessionId === JOB ? held.answer() : undefined);
  const signing = role.sign(callerBuffer);
  await held.waiting;
  callerBuffer.fill(0x41);
  held.release();
  assert.ok(verifiesUnder(SELLER, original, await signing), 'the signature is over the bytes as they were when sign was called');
});

test('a minted role is single-use: one whose authority check failed cannot be retried, a new mint under a current binding signs, and minting again never revives a used role', async (t) => {
  const key = await openAdmittedKey(t);
  const { binding: scoped, control } = await controlledBinding();
  const bytes = answerBytesUnder(scoped, PATHS.state, 200, READ_BODY);
  const mint = () => key.readOnlyAnswerSigner({ purpose: 'read-answer', binding: scoped, local: LOCAL, body: READ_BODY });
  const before = cryptoCalls.signs;
  const used = await mint();
  control.answer = (scope) => { if (scope.sessionId === JOB) throw new Error('TEST refused once'); };
  assert.equal((await refusalOf(() => used.sign(bytes)))?.code, 'seller_key_role_refused');
  control.answer = () => undefined;
  const retry = await refusalOf(() => used.sign(bytes));
  assert.deepEqual([retry?.code, retry?.details], ['seller_key_role_refused', 'single-use'], 'the failed role is spent');
  assert.equal((await (await mint()).sign(bytes)).length, 64, 'a new mint signs');
  assert.equal((await refusalOf(() => used.sign(bytes)))?.details, 'single-use', 'the new mint did not revive the used role');
  assert.equal(cryptoCalls.signs - before, 1);
});

test('the read-only role refuses a read answer on the pre-agreement route, an answer body past the response limit and discovery under another profile, each with its own detail', async (t) => {
  const key = await openAdmittedKey(t);
  const before = cryptoCalls.signs;
  const preAgreement = await readOnlySigner(key, 'read-answer', { body: READ_BODY });
  assert.equal((await refusalOf(() => preAgreement.sign(responseBytes(PATHS.contextChallenge, 200, READ_BODY))))?.details, 'not-a-read-answer');
  const oversized = await refusalOf(() => readOnlySigner(key, 'read-answer', { body: 'x'.repeat(wire.DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes + 1) }));
  assert.deepEqual([oversized?.code, oversized?.details], ['seller_key_role_refused', 'body']);
  const discovery = await readOnlySigner(key, 'discovery');
  const otherProfile = wire.discoverySigningBytes(discoveryPayload(binding, { profile: { ...binding.profile, pinVersion: 'another-pin' } }));
  assert.equal((await refusalOf(() => discovery.sign(otherProfile)))?.details, 'wrong-binding-or-seller');
  assert.equal(cryptoCalls.signs - before, 0);
});

test('the integrity role stays synchronous, so the durable state creates a store over it, writes a record and reads it back after a reopen', async (t) => {
  const key = await openAdmittedKey(t);
  const signature = key.integritySigner.sign(withPrefix(SELLER_STATE_SIGNING_DOMAIN, '{}'));
  assert.ok(signature instanceof Uint8Array && typeof signature.then !== 'function', 'sign returns bytes, not a Promise');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-seller-key-state-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { dir: join(dir, 'state'), signer: key.integritySigner, listingPin: { contentHash: 'a'.repeat(64) } };
  const store = await createSellerDurableState(options);
  store.retainContext({ probe: 'integrity role' });
  store.close();
  const reopened = await createSellerDurableState(options);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.context(), { probe: 'integrity role' });
});

const READY_ENTRY = 'sellerKey.readOnlyAnswerSigner';
const readyBytes = (scoped, ready = true) => wire.discoverySigningBytes(discoveryPayload(scoped, { ready }));
const discoveryRole = (key, scoped = binding) => key.readOnlyAnswerSigner({ purpose: 'discovery', binding: scoped, local: LOCAL });
const refusedByGuard = (refusal) => [refusal?.code, refusal?.error?.entry];
const GUARD_REFUSAL = ['kit_operation_guard_off', READY_ENTRY];

test('a key opened while admitted, then re-held, signs a ready:false discovery document and refuses a ready:true one with kit_operation_guard_off and zero signer calls, directly and through the wire\'s signDiscoveryDocument', async (t) => {
  const key = await openAdmittedKey(t);
  guard.setKitOperationGuardForTest('off');
  const before = cryptoCalls.signs;
  const served = JSON.parse(Buffer.from(await wire.signDiscoveryDocument(discoveryPayload(binding), await discoveryRole(key), binding, LOCAL)).toString());
  assert.equal(served.payload.ready, false);
  assert.ok(verifiesUnder(SELLER, wire.discoverySigningBytes(served.payload), Buffer.from(served.signature, 'base64url')), 'ready:false signs and verifies');
  assert.equal(cryptoCalls.signs - before, 1);
  const viaWire = await refusalOf(async () => wire.signDiscoveryDocument(discoveryPayload(binding, { ready: true }), await discoveryRole(key), binding, LOCAL));
  assert.deepEqual(refusedByGuard(viaWire), GUARD_REFUSAL, 'through the wire');
  const direct = await refusalOf(async () => (await discoveryRole(key)).sign(readyBytes(binding)));
  assert.deepEqual(refusedByGuard(direct), GUARD_REFUSAL, 'directly');
  assert.equal(cryptoCalls.signs - before, 1, 'the ready:true documents made no signer call');
});

test('a discovery role minted while admitted refuses a ready:true document once the guard re-holds, because the check is at signing and not at minting', async (t) => {
  const key = await openAdmittedKey(t);
  const role = await discoveryRole(key);
  guard.setKitOperationGuardForTest('off');
  const before = cryptoCalls.signs;
  assert.deepEqual(refusedByGuard(await refusalOf(() => role.sign(readyBytes(binding)))), GUARD_REFUSAL);
  assert.equal(cryptoCalls.signs - before, 0);
});

test('the guard re-holding while a ready:true discovery role awaits its authority check refuses it with zero signer calls; the same sequence with no re-hold signs once', async (t) => {
  const key = await openAdmittedKey(t);
  const { binding: scoped, control } = await controlledBinding();
  const before = cryptoCalls.signs;
  for (const reHold of [true, false]) {
    guard.setKitOperationGuardForTest('testnet-tp1');
    const role = await discoveryRole(key, scoped);
    const held = heldAnswer();
    control.answer = (scope) => (scope.sessionId === wire.DACS_SELLER_DISCOVERY_FORMAT ? held.answer() : undefined);
    const signing = refusalOf(() => role.sign(readyBytes(scoped)));
    await held.waiting;
    if (reHold) guard.setKitOperationGuardForTest('off');
    held.release();
    const outcome = await signing;
    if (reHold) assert.deepEqual(refusedByGuard(outcome), GUARD_REFUSAL, 'a re-hold during the await refuses');
    else assert.equal(outcome, null, 'control: no re-hold signs');
    assert.equal(cryptoCalls.signs - before, reHold ? 0 : 1);
  }
});

test('a key that was never admitted (the shipped off guard) refuses a ready:true discovery document and still signs ready:false and a read answer', async (t) => {
  loaderSpy.reset();
  guard.setKitOperationGuardForTest('off');
  const key = await openSellerKey(openOptions(keyFixture(t)));
  t.after(() => { guard.setKitOperationGuardForTest('testnet-tp1'); key.close(); });
  const before = cryptoCalls.signs;
  assert.deepEqual(refusedByGuard(await refusalOf(async () => (await discoveryRole(key)).sign(readyBytes(binding)))), GUARD_REFUSAL);
  assert.equal(cryptoCalls.signs - before, 0);
  assert.ok(verifiesUnder(SELLER, readyBytes(binding, false), await (await discoveryRole(key)).sign(readyBytes(binding, false))), 'ready:false signs');
  const answer = await readOnlySigner(key, 'read-answer', { body: READ_BODY });
  assert.equal((await answer.sign(responseBytes(PATHS.state, 200, READ_BODY))).length, 64, 'a read answer signs');
  assert.equal(cryptoCalls.signs - before, 2);
});

test('while admitted a ready:true discovery document signs and verifies; a role the guard refused is spent', async (t) => {
  const key = await openAdmittedKey(t);
  const before = cryptoCalls.signs;
  const bytes = readyBytes(binding);
  assert.ok(verifiesUnder(SELLER, bytes, await (await discoveryRole(key)).sign(bytes)), 'ready:true signs while admitted');
  const role = await discoveryRole(key);
  guard.setKitOperationGuardForTest('off');
  assert.deepEqual(refusedByGuard(await refusalOf(() => role.sign(bytes))), GUARD_REFUSAL);
  guard.setKitOperationGuardForTest('testnet-tp1');
  assert.equal((await refusalOf(() => role.sign(bytes)))?.details, 'single-use', 'the refused role cannot be retried');
  assert.equal(cryptoCalls.signs - before, 1);
});

test('a caller who forgets to await the read-only signer fails loudly: sign returns a Promise, which no signature consumer accepts as signature bytes', async (t) => {
  const key = await openAdmittedKey(t);
  const bytes = responseBytes(PATHS.state, 200, READ_BODY);
  const role = await readOnlySigner(key, 'read-answer', { body: READ_BODY });
  const minted = readOnlySigner(key, 'discovery');
  assert.ok(minted instanceof Promise, 'minting a role returns a Promise too');
  await minted;
  const unawaited = role.sign(bytes);
  assert.ok(unawaited instanceof Promise && !(unawaited instanceof Uint8Array), 'sign returns a Promise');
  assert.throws(() => Buffer.from(unawaited), TypeError, 'a sync consumer copying the result');
  assert.throws(() => verifiesUnder(SELLER, bytes, unawaited), TypeError, 'a verifier handed the Promise');
  assert.ok(verifiesUnder(SELLER, bytes, await unawaited), 'awaited, the same call yields verifying signature bytes');
});

test('the README and the openSellerKey doc comment both say minting a read-only role and its sign return Promises to await', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const source = readFileSync(new URL('../src/seller-key.mjs', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(readme, /`readOnlyAnswerSigner\(\.\.\.\)`, which returns a Promise of a single-use signer/);
  assert.match(readme, /`sign` returns a Promise of the signature \(always `await` both/);
  assert.match(source, /`readOnlyAnswerSigner` returns a Promise of `\{ claim, sign\(bytes\) \}` whose `sign` returns a Promise of the signature: await both/);
});
