// The portal checks a seller session delegation against the purchase terms
// before the wallet signs it. Pure module test; no browser, network or wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { sellerSessionDelegationSigningBytes } from '../src/dacs/seller-transport-auth.mjs';
import { checkSellerSessionDelegation, describeSellerSessionDelegation, SELLER_SESSION_DELEGATION_PREFIX } from '../public/portal/seller-session-delegation.mjs';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const HOUR = 3600000;

function fixture() {
  const buyer = createEphemeralWallet(), seller = createEphemeralWallet(), session = createEphemeralWallet();
  const jobId = generateCanonicalJobId();
  const listing = { listingId: 'operator-native-report', version: 1, contentHash: 'c'.repeat(64) };
  const terms = { buyer: { wallet: buyer.address }, seller: { claim: seller.claim }, listing: { ...listing, anchor: { kind: 'storage-program', locator: 'x' } }, protocol: { jobId } };
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length), seller: seller.claim, listingPin: listing, jobId, notBefore: NOW - 1000, expiresAt: NOW + HOUR };
  const request = (p = payload) => ({ payload: p, message: sellerSessionDelegationSigningBytes(p).toString('utf8') });
  return { buyer, seller, session, jobId, listing, terms, payload, request };
}

test('a delegation matching the purchase terms gives a readable summary with an ISO expiry', () => {
  const f = fixture();
  const summary = checkSellerSessionDelegation(f.request(), f.terms, { now: NOW });
  assert.deepEqual({ ...summary }, { seller: f.seller.claim, listing: 'operator-native-report v1', listingHash: 'c'.repeat(64), jobId: f.jobId,
    notBefore: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + HOUR).toISOString() });
  const text = describeSellerSessionDelegation(summary);
  assert.match(text, /2026-10-08T13:00:00\.000Z/);assert.match(text, new RegExp(f.jobId));assert.doesNotMatch(text, /[{}"]/, 'no raw JSON');
  // The portal's canonical form equals the server's SDK JCS bytes.
  assert.ok(f.request().message.startsWith(SELLER_SESSION_DELEGATION_PREFIX));
  // A wallet address in another case still names the same buyer.
  assert.ok(checkSellerSessionDelegation(f.request(), { ...f.terms, buyer: { wallet: `0x${f.buyer.address.slice(2).toUpperCase()}` } }, { now: NOW }));
});

test('every scope mismatch with the purchase terms is refused before signing', () => {
  const f = fixture(), other = createEphemeralWallet();
  const cases = {
    buyer: [{ ...f.payload, buyer: other.claim }, /buyer is not this purchase wallet/],
    seller: [{ ...f.payload, seller: other.claim }, /seller differs/],
    listingId: [{ ...f.payload, listingPin: { ...f.listing, listingId: 'another-listing' } }, /Listing differs/],
    listingVersion: [{ ...f.payload, listingPin: { ...f.listing, version: 2 } }, /Listing differs/],
    listingHash: [{ ...f.payload, listingPin: { ...f.listing, contentHash: 'd'.repeat(64) } }, /Listing differs/],
    jobId: [{ ...f.payload, jobId: generateCanonicalJobId() }, /job differs/],
    sessionIsSeller: [{ ...f.payload, sessionPublicKey: f.seller.claim.slice('did:demos:agent:'.length) }, /session key/],
  };
  for (const [name, [payload, reason]] of Object.entries(cases)) {
    assert.throws(() => checkSellerSessionDelegation(f.request(payload), f.terms, { now: NOW }), (error) => error.code === 'delegation_refused' && reason.test(error.message), name);
  }
  // The server refuses a session key equal to the buyer key too, so build that message directly.
  const sessionIsBuyer = { ...f.payload, sessionPublicKey: f.buyer.claim.slice('did:demos:agent:'.length) };
  assert.throws(() => checkSellerSessionDelegation({ payload: sessionIsBuyer, message: `${SELLER_SESSION_DELEGATION_PREFIX}${canonicalize(sessionIsBuyer)}` }, f.terms, { now: NOW }), /session key/);
});

test('expiry outside the fixed bounds is refused', () => {
  const f = fixture();
  const cases = {
    expired: [{ ...f.payload, notBefore: NOW - 2 * HOUR, expiresAt: NOW }, /already expired/],
    longerThan24h: [{ ...f.payload, notBefore: NOW, expiresAt: NOW + 24 * HOUR + 1 }, /longer than 24 hours/],
    startsInFuture: [{ ...f.payload, notBefore: NOW + 6 * 60000, expiresAt: NOW + HOUR }, /starts in the future/],
    reversed: [{ ...f.payload, notBefore: NOW + 1000, expiresAt: NOW + 1000 }, /validity window is malformed/],
  };
  for (const [name, [payload, reason]] of Object.entries(cases)) {
    const message = `${SELLER_SESSION_DELEGATION_PREFIX}${canonicalize(payload)}`;
    assert.throws(() => checkSellerSessionDelegation({ payload, message }, f.terms, { now: NOW }), reason, name);
  }
  assert.ok(checkSellerSessionDelegation(f.request({ ...f.payload, notBefore: NOW, expiresAt: NOW + 24 * HOUR }), f.terms, { now: NOW }));
});

test('a message that is not exactly the canonical described payload is refused', () => {
  const f = fixture(), { message } = f.request(), body = message.slice(SELLER_SESSION_DELEGATION_PREFIX.length);
  const refusals = {
    wrongPrefix: { message: `dacs-chatgpt-plugin:seller-session-delegation:v2:${body}` },
    notJson: { message: `${SELLER_SESSION_DELEGATION_PREFIX}{` },
    whitespace: { message: `${SELLER_SESSION_DELEGATION_PREFIX}${JSON.stringify(JSON.parse(body), null, 1)}` },
    reordered: { message: `${SELLER_SESSION_DELEGATION_PREFIX}${JSON.stringify({ version: '1', ...JSON.parse(body) })}` },
    duplicateKey: { message: `${SELLER_SESSION_DELEGATION_PREFIX}{"buyer":"${createEphemeralWallet().claim}",${body.slice(1)}` },
    extraField: { message: `${SELLER_SESSION_DELEGATION_PREFIX}${canonicalize({ ...f.payload, scope: 'all' })}` },
    describedPayloadDiffers: { message, payload: { ...f.payload, expiresAt: f.payload.expiresAt + 1 } },
    wrongKind: { message: sellerSessionDelegationSigningBytes(f.payload).toString('utf8').replace('"kind":"seller-session-delegation"', '"kind":"seller-session-delegation2"') },
  };
  for (const [name, request] of Object.entries(refusals)) {
    assert.throws(() => checkSellerSessionDelegation(request, f.terms, { now: NOW }), { code: 'delegation_refused' }, name);
  }
});

test('the portal checks the delegation before any wallet signature in the Agreement flow', () => {
  const source = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
  assert.match(source, /^import \{ checkSellerSessionDelegation, describeSellerSessionDelegation \} from '\.\/seller-session-delegation\.mjs';$/m);
  // The flow starts in planAgreement (identity, delegation, plan) and ends in signAgreement.
  const flow = source.slice(source.indexOf('async function planAgreement(t)'), source.indexOf('async function countersign(t)'));
  assert.ok(flow.indexOf('async function signAgreement(t)') > 0);
  const check = flow.indexOf('checkSellerSessionDelegation(identity.signRequest.delegation, t)');
  assert.ok(check > 0 && check < flow.indexOf('walletSign('), 'the check precedes the first wallet signature');
  assert.ok(flow.indexOf('describeSellerSessionDelegation(delegation)') < flow.indexOf('walletSign(identity.signRequest.delegation.message)'));
  assert.doesNotMatch(flow, /JSON\.stringify\(identity\.signRequest\.delegation/);
});
