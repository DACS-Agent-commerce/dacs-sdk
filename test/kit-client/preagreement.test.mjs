// K12-H4-wire / K12-H4-host: the delegated context request before any Agreement exists, at the wire's public entry
// and at the composed kit host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, checkWireRequest, openWireEnvelope, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { LOCAL } from '../../packages/dacs-client/test/fixtures/tp1-authority-reader.mjs';
import { BUYER, JOB, LISTING_PIN, SELLER, SESSION, T0, bindWireProfile, contextScope, contextScopeHash, publicKeyHex } from './fixtures.mjs';
import { clientAuthFor, composedKitHost, postHeader, postSigned, wireSignedRequest } from './kit-host.mjs';

const K1_JOB = '01M5YKPJG0248H248H248H248H';
const K1_S1_HASH_PREFIX = '6f6eef0286377afa';
const REQUEST_NONCE_BYTES = 16;
const REQUEST_LIFETIME_MS = 20_000;
const DELEGATION_LEAD_MS = 30_000;
const DELEGATION_LIFETIME_MS = 3_600_000;
const header = (value) => Buffer.from(canonicalize(value)).toString('base64url');
const signedBy = (wallet, domain, payload) => ({ payload, signature: wallet.signBytes(Buffer.from(domain + canonicalize(payload))).toString('base64url') });

/** A delegated (session-signed, buyer-delegated) request to `path` with `body`, opened by the wire's own entry, with the check that admits it. */
/** `allocated` is the host's own record of a live allocation; the stage routes (proposals) require it in the retained record, the context route does not. */
async function delegatedRequest(path, body, allocated) {
  const binding = await bindWireProfile();
  const rawBody = Buffer.from(JSON.stringify(body));
  const request = { version: '1', kind: 'request', method: 'POST', path, jobId: JOB, buyer: BUYER.claim, seller: SELLER.claim, bodyHash: sha256Hex(rawBody),
    listingPin: LISTING_PIN, agreementHash: contextScopeHash, nonce: Buffer.alloc(REQUEST_NONCE_BYTES, 0x6e).toString('base64url'), expiresAt: T0 + REQUEST_LIFETIME_MS, profile: binding.profile };
  const delegation = signedBy(BUYER, DACS_SELLER_HTTP_DOMAINS.delegation, { version: '1', kind: 'seller-session-delegation', buyer: BUYER.claim, seller: SELLER.claim,
    sessionPublicKey: publicKeyHex(SESSION), listingPin: LISTING_PIN, jobId: JOB, notBefore: T0 - DELEGATION_LEAD_MS, expiresAt: T0 + DELEGATION_LIFETIME_MS, profile: binding.profile });
  const envelope = header({ ...signedBy(SESSION, DACS_SELLER_HTTP_DOMAINS.request, request), delegation });
  const opened = await openWireEnvelope(envelope, 'request', { binding, local: LOCAL, purchaseProfile: binding.profile, requireDelegation: true });
  const check = { binding, local: LOCAL, purchaseProfile: binding.profile, seller: SELLER.claim, listingPin: LISTING_PIN, method: 'POST', path, rawBody, now: T0, ready: true,
    retained: { jobId: JOB, agreementHash: contextScopeHash, buyer: BUYER.claim, seller: SELLER.claim, ...(allocated === undefined ? {} : { allocated }) } };
  return { opened, check };
}

const reservationFiles = (directory) => readdirSync(directory).filter((name) => /^[ko]-/.test(name));

async function journalDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-kit-client-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('K12-H4-wire today: checkWireRequest refuses a delegated context request with no Agreement (peer_delegation_agreement_required, K2-PRE-1)', async (t) => {
  assert.equal(JOB, K1_JOB);
  assert.ok(contextScopeHash.startsWith(K1_S1_HASH_PREFIX), 'the retained hash is K1-S1\'s');
  const directory = await journalDirectory(t);
  const { opened, check } = await delegatedRequest(DACS_SELLER_HTTP_PATHS.context, { scope: contextScope, buyerIdentityBundle: { presentedBy: BUYER.claim } });
  await assert.rejects(checkWireRequest(opened, { ...check, requestJournal: openWireRequestJournal(directory) }), { code: 'peer_delegation_agreement_required', status: 409 });
  assert.deepEqual(reservationFiles(directory), [], 'nothing was reserved');
});

test('K12-H4-wire control: the same delegated request on proposals with a host-owned draft is admitted', async (t) => {
  // Same envelope signers, delegation and retained Agreement; only the route and the host-owned draft differ.
  const directory = await journalDirectory(t);
  const { opened, check } = await delegatedRequest(DACS_SELLER_HTTP_PATHS.proposals, { scope: contextScope, buyerIdentityBundle: { presentedBy: BUYER.claim } }, false);
  // The delegation must not outlive the Agreement's deadline, so the draft's deadline is the delegation's own expiry.
  const draft = { jobId: JOB, listingRef: LISTING_PIN, parties: [{ role: 'buyer', primaryClaim: BUYER.claim }, { role: 'seller', primaryClaim: SELLER.claim }], terms: { deadline: T0 + DELEGATION_LIFETIME_MS } };
  const checked = await checkWireRequest(opened, { ...check, artifacts: [draft], requestJournal: openWireRequestJournal(directory) });
  assert.equal(checked.readbackOnly, false);
  assert.equal(typeof checked.reserve, 'function', 'an effect route returns its reservation');
  assert.deepEqual(reservationFiles(directory), [], 'admission journals nothing until reserve() is called');
  await checked.reserve();
  assert.equal(reservationFiles(directory).filter((name) => name.startsWith('k-')).length, 1, 'the admitted request is reserved once');
});

test('K12-H4-host today: the composed kit host has no mounted wire context handler (unsigned 404 not_found)', async (t) => {
  const { fixture, host } = await composedKitHost(t);
  const agentCallsBefore = fixture.admission.calls.length + fixture.signed.length;
  const answer = await postSigned(host, clientAuthFor(host), DACS_SELLER_HTTP_PATHS.context, { jobId: JOB, scope: contextScope, buyerIdentityBundle: { presentedBy: BUYER.claim } });
  assert.deepEqual({ status: answer.status, body: JSON.parse(answer.text), signed: answer.signed }, { status: 404, body: { error: 'not_found' }, signed: false });
  assert.equal(fixture.admission.calls.length + fixture.signed.length, agentCallsBefore, 'the request reached no admission read and no signature');
});

test('K12-H4-host control: the composed host authenticates and answers a signed state request', async (t) => {
  const { host } = await composedKitHost(t);
  // The state route is on the wire (P11a1a): the request is signed under the wire domain, and a job the host holds nothing for is a signed 404 (SA-10), not the unmounted route's.
  const { header, text } = await wireSignedRequest(host, DACS_SELLER_HTTP_PATHS.state, { transportIdentity: { jobId: JOB } }, { jobId: JOB, agreementHash: sha256Hex('kit-client-host-agreement') });
  const answer = await postHeader(host, DACS_SELLER_HTTP_PATHS.state, header, text);
  assert.equal(answer.signed, true, 'the answer carries the seller signature');
  assert.equal(JSON.parse(answer.text).error, 'peer_unknown_job');
});
