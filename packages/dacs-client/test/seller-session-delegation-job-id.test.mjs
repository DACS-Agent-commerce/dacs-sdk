// The portal refuses a seller session delegation unless the job ID is a canonical
// JID-1 value on both the delegation and the purchase terms (CORE JID-1, JID-3, JID-4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCanonicalJobId as sdkIsCanonicalJobId } from '@kynesyslabs/dacs';
import * as portal from '../src/public/portal/seller-session-delegation.mjs';

const { checkSellerSessionDelegation, SELLER_SESSION_DELEGATION_PREFIX } = portal;

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const HOUR = 3600000;
const BUYER_KEY = 'a'.repeat(64);
const SELLER_CLAIM = `did:demos:agent:${'b'.repeat(64)}`;
const SESSION_KEY = 'c'.repeat(64);
const LISTING = { listingId: 'operator-native-report', version: 1, contentHash: 'd'.repeat(64) };
const CANONICAL_JOB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_CANONICAL_JOB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/job-id-grammar-v0.1.json', import.meta.url), 'utf8')).vectors;
const canonicalJobIds = vectors.filter((v) => v.operation === 'validate' && v.expected === 'pass').map((v) => v.jobId);
const malformedJobIds = [
  { name: 'not-a-job', jobId: 'not-a-job' },
  { name: 'empty', jobId: '' },
  ...vectors.filter((v) => v.operation === 'lookup-bundle' && v.expected === 'error' && typeof v.jobId === 'string'),
];

// Sorted-key compact JSON with no string normalization, so a malformed job ID reaches the check unchanged.
function sortedJson(value) {
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function delegationFor(delegationJobId, termsJobId) {
  const payload = {
    version: '1', kind: 'seller-session-delegation', buyer: `did:demos:agent:${BUYER_KEY}`, sessionPublicKey: SESSION_KEY,
    seller: SELLER_CLAIM, listingPin: LISTING, jobId: delegationJobId, notBefore: NOW - 1000, expiresAt: NOW + HOUR,
  };
  const request = { payload, message: `${SELLER_SESSION_DELEGATION_PREFIX}${sortedJson(payload)}` };
  const terms = { buyer: { wallet: `0x${BUYER_KEY}` }, seller: { claim: SELLER_CLAIM }, listing: LISTING, protocol: { jobId: termsJobId } };
  return { request, terms };
}

test('the vector set holds canonical and malformed job IDs to run', () => {
  assert.ok(canonicalJobIds.length >= 3);
  assert.ok(malformedJobIds.length >= 15);
});

for (const jobId of canonicalJobIds) {
  test(`a canonical matching job ID is accepted: ${jobId}`, () => {
    const { request, terms } = delegationFor(jobId, jobId);
    assert.equal(checkSellerSessionDelegation(request, terms, { now: NOW }).jobId, jobId);
  });
}

for (const { name, jobId } of malformedJobIds) {
  test(`a malformed job ID in both the delegation and the terms is refused: ${name}`, () => {
    const { request, terms } = delegationFor(jobId, jobId);
    assert.throws(() => checkSellerSessionDelegation(request, terms, { now: NOW }),
      (error) => error.code === 'delegation_refused' && /the job differs from this purchase/.test(error.message));
  });
}

// The portal module runs in a browser, so its local check must give the SDK's answer on every form.
test('the local job ID check agrees with the SDK on every fixture entry and malformed form', () => {
  const forms = [
    ...vectors.flatMap((v) => [v.jobId, v.otherJobId, v.sessionId]),
    ...malformedJobIds.map((entry) => entry.jobId),
    CANONICAL_JOB_ID, OTHER_CANONICAL_JOB_ID, undefined, null, 0, {}, [CANONICAL_JOB_ID],
  ];
  assert.ok(forms.some((form) => sdkIsCanonicalJobId(form)));
  assert.ok(forms.some((form) => !sdkIsCanonicalJobId(form)));
  for (const form of forms) {
    assert.equal(portal.isCanonicalJobId(form), sdkIsCanonicalJobId(form), `disagreement on ${JSON.stringify(form)}`);
  }
});

test('the portal module imports nothing bare and nothing from node:', () => {
  const source = readFileSync(new URL('../src/public/portal/seller-session-delegation.mjs', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.match(specifier, /^\.{1,2}\//, `${specifier} is not a relative import`);
  }
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|node:/);
});

test('two different canonical job IDs are a mismatch', () => {
  const { request, terms } = delegationFor(CANONICAL_JOB_ID, OTHER_CANONICAL_JOB_ID);
  assert.throws(() => checkSellerSessionDelegation(request, terms, { now: NOW }),
    (error) => error.code === 'delegation_refused' && /the job differs from this purchase/.test(error.message));
});
