// The node-signed enrollment answer and its verifier. Every positive proof here is signed by the test-only helper with
// node:crypto, never produced by the verifier, and each refusal starts from a valid answer and changes one condition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { parseTrustedNodePin, verifyEnrollmentAnswer } from '../src/dacs/enrollment-proof.mjs';
import { OperationError } from '../src/operations.mjs';
import { BAD_KEYS } from './helpers/ed25519-edge-cases.mjs';
import { TEST_ONLY_SEED_LABEL, enrollmentScenario, enrollmentVectors, entryFor, signResponse, signingInputFor, successEnvelope,
  testOnlyNodeKey, trustedNodeFor, unsignedResponse } from './helpers/enrollment-signing.mjs';

const MIB = 1024 * 1024;
const vectorFile = (name) => JSON.parse(readFileSync(new URL(`./vectors/enrollment/${name}`, import.meta.url), 'utf8'));
const answers = vectorFile('answers.json');
const { trustedNode } = vectorFile('test-public-key.json');
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// The same bytes spelled with the lowest unused bit of the last character set: a noncanonical encoding.
const withSpareBitSet = (text) => text.slice(0, -1) + BASE64URL_ALPHABET[BASE64URL_ALPHABET.indexOf(text.at(-1)) ^ 1];

/** The stored vector as a verifier call: its decoded envelope and the request, pin and block it was signed for. */
function storedVector(name) {
  const { answer, request, observedBlock } = answers[name];
  return { envelope: JSON.parse(answer), options: { request, trustedNode, observedBlock } };
}

/** A freshly signed envelope for the base scenario, after `change` edits the unsigned response. */
function signedVariant(change, key = testOnlyNodeKey()) {
  const scenario = enrollmentScenario();
  const unsigned = unsignedResponse(scenario, [scenario.entry]);
  change(unsigned, scenario);
  return { envelope: successEnvelope(signResponse(unsigned, key)), options: { request: scenario.request, trustedNode, observedBlock: scenario.observedBlock } };
}

function assertRefused(call, code, label) {
  assert.throws(call, (error) => {
    assert.ok(error instanceof OperationError, `${label}: ${error}`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    return true;
  }, label);
}

const verify = ({ envelope, options }) => verifyEnrollmentAnswer(envelope, options);

test('the checked-in enrollment vectors are what the test-only seed label regenerates', () => {
  for (const [file, content] of Object.entries(enrollmentVectors())) assert.deepEqual(vectorFile(file), content, file);
  assert.equal(vectorFile('test-public-key.json').seedLabel, TEST_ONLY_SEED_LABEL);
  for (const [name, { answer }] of Object.entries(answers)) {
    const inputs = vectorFile('signing-inputs.json'), digests = vectorFile('digests.json');
    assert.equal(signingInputFor(JSON.parse(answer).response), inputs[name], name);
    assert.deepEqual(digests[name], { answerSha256: sha256Hex(answer), signingInputSha256: sha256Hex(inputs[name]) }, name);
  }
});

test('a node-signed complete enrollment answer returns its verified entry at the observed chain height', () => {
  const vector = storedVector('current-entry');
  const entries = verify(vector);
  assert.deepEqual(entries, [entryFor(vector.options.request.participantClaim)]);
  assert.equal(vector.envelope.response.height, vector.options.observedBlock.height);
  assert.ok(Object.isFrozen(entries) && Object.isFrozen(entries[0]) && Object.isFrozen(entries[0].profile) && Object.isFrozen(entries[0].modules));
});

test('a changed entry with the original signature refuses instead of admitting the buyer', () => {
  const revokedVector = storedVector('revoked-entry');
  revokedVector.envelope.response.entries[0].revoked = false;
  assertRefused(() => verify(revokedVector), 'enrollment_unverified', 'revoked flag cleared');
  const current = storedVector('current-entry');
  current.envelope.response.entries[0].evidence = 'registry row 99 at block 120300';
  assertRefused(() => verify(current), 'enrollment_unverified', 'evidence changed');
});

test('independently signed wrong nonce claim Listing pin chain identity observed height or block hash and an invalid or wrong signer pin refuse', () => {
  const otherClaim = `did:demos:agent:${'c9'.repeat(32)}`;
  const signedCases = {
    nonce: (r) => { r.request = { ...r.request, nonce: sha256Hex('an older request') }; },
    'seller claim': (r) => { r.request = { ...r.request, sellerClaim: otherClaim }; },
    'participant claim': (r) => { r.request = { ...r.request, participantClaim: otherClaim }; },
    'Listing pin version': (r) => { r.request = { ...r.request, listingPin: { ...r.request.listingPin, version: 4 } }; },
    'Listing pin content hash': (r) => { r.request = { ...r.request, listingPin: { ...r.request.listingPin, contentHash: 'c5'.repeat(32) } }; },
    'Listing id': (r) => { r.request = { ...r.request, listingPin: { ...r.request.listingPin, listingId: 'another-listing' } }; },
    'chain identity': (r) => { r.chainIdentity = sha256Hex('another chain'); },
    height: (r) => { r.height += 1; },
    'block hash': (r) => { r.blockHash = sha256Hex('another block'); },
  };
  for (const [label, change] of Object.entries(signedCases)) assertRefused(() => verify(signedVariant(change)), 'enrollment_unverified', label);

  const otherKey = testOnlyNodeKey('dacs-sdk/enrollment-proof-test-only/another-node');
  assertRefused(() => verify(signedVariant(() => {}, otherKey)), 'enrollment_unverified', 'answer signed by another node');
  const vector = storedVector('current-entry');
  assertRefused(() => verifyEnrollmentAnswer(vector.envelope, { ...vector.options, trustedNode: trustedNodeFor(otherKey) }), 'enrollment_unverified', 'pin names another node');

  const publicKey = trustedNode.publicKey;
  const badPins = {
    absent: [undefined, 'enrollment_invalid'],
    'extra key': [{ ...trustedNode, keyVersion: 1 }, 'enrollment_invalid'],
    'missing key': [{ chainIdentity: trustedNode.chainIdentity }, 'enrollment_invalid'],
    'wrong identity': [{ ...trustedNode, chainIdentity: sha256Hex('another chain') }, 'enrollment_unverified'],
    'noncanonical encoding': [{ ...trustedNode, publicKey: withSpareBitSet(publicKey) }, 'enrollment_invalid'],
    'wrong length': [{ ...trustedNode, publicKey: Buffer.alloc(33, 7).toString('base64url') }, 'enrollment_invalid'],
    'padded encoding': [{ ...trustedNode, publicKey: `${publicKey}=` }, 'enrollment_invalid'],
    'small order': [{ ...trustedNode, publicKey: Buffer.from(BAD_KEYS['small-order y = 1'], 'hex').toString('base64url') }, 'enrollment_invalid'],
  };
  for (const [label, [pin, code]] of Object.entries(badPins)) {
    assertRefused(() => verifyEnrollmentAnswer(vector.envelope, { ...vector.options, trustedNode: pin }), code, `verifier pin: ${label}`);
    assertRefused(() => parseTrustedNodePin(pin), code, `pin parser: ${label}`);
  }
  const parsed = parseTrustedNodePin(trustedNode);
  assert.equal(parsed.chainIdentity, TP1_APPROVED_IDENTITY_RECORD.chainIdentity);
  assert.equal(parsed.keyObject.asymmetricKeyType, 'ed25519');
});

test('independently signed wrong profile module tuple empty evidence wrong entry claim mixed entries non-200 result version incomplete oversized entry set or signing input noncanonical signature and missing or extra envelope or response member refuse', () => {
  const otherClaim = `did:demos:agent:${'c9'.repeat(32)}`;
  const firstEntry = (change) => (r) => { r.entries = [{ ...r.entries[0] }]; change(r.entries[0]); };
  const signedCases = {
    'profile revision': [firstEntry((e) => { e.profile = { ...e.profile, revision: 'TP-2' }; }), 'enrollment_invalid'],
    'profile pin version': [firstEntry((e) => { e.profile = { ...e.profile, pinVersion: 'another-pin' }; }), 'enrollment_invalid'],
    'profile extra member': [firstEntry((e) => { e.profile = { ...e.profile, note: 'x' }; }), 'enrollment_invalid'],
    'module version': [firstEntry((e) => { e.modules = { ...e.modules, CORE: '0.4' }; }), 'enrollment_invalid'],
    'missing module': [firstEntry((e) => { delete e.modules['DACS-5']; }), 'enrollment_invalid'],
    'extra module': [firstEntry((e) => { e.modules = { ...e.modules, 'DACS-6': '0.1' }; }), 'enrollment_invalid'],
    'empty evidence': [firstEntry((e) => { e.evidence = ''; }), 'enrollment_invalid'],
    'revoked not a boolean': [firstEntry((e) => { e.revoked = 'no'; }), 'enrollment_invalid'],
    'entry for another claim': [firstEntry((e) => { e.claim = otherClaim; }), 'enrollment_invalid'],
    'entry extra member': [firstEntry((e) => { e.since = 120300; }), 'enrollment_invalid'],
    'mixed valid and malformed entries': [(r) => { r.entries = [r.entries[0], { ...r.entries[0], evidence: '' }]; }, 'enrollment_invalid'],
    'version 2': [(r) => { r.version = 2; }, 'enrollment_invalid'],
    incomplete: [(r) => { r.complete = false; }, 'enrollment_invalid'],
    'extra response member': [(r) => { r.nextPage = 2; }, 'enrollment_invalid'],
    'missing response member': [(r) => { delete r.complete; }, 'enrollment_invalid'],
    'seventeen entries': [(r, s) => { r.entries = Array.from({ length: 17 }, (_, i) => entryFor(s.request.participantClaim, `registry row ${i}`)); }, 'enrollment_too_large'],
    'signing input over 1 MiB': [firstEntry((e) => { e.evidence = 'e'.repeat(MIB); }), 'enrollment_too_large'],
  };
  for (const [label, [change, code]] of Object.entries(signedCases)) assertRefused(() => verify(signedVariant(change)), code, label);

  const sixteen = signedVariant((r, s) => { r.entries = Array.from({ length: 16 }, (_, i) => entryFor(s.request.participantClaim, `registry row ${i}`)); });
  assert.equal(verify(sixteen).length, 16);
  const atCap = signedVariant(firstEntry((e) => { e.evidence = 'e'; }));
  const padding = MIB - Buffer.byteLength(signingInputFor(atCap.envelope.response), 'utf8');
  assert.equal(verify(signedVariant(firstEntry((e) => { e.evidence = 'e'.repeat(1 + padding); }))).length, 1, 'a signing input of exactly 1 MiB verifies');

  const envelopeCases = {
    'result 500': [(env) => { env.result = 500; }, 'enrollment_unavailable'],
    'result 404 with an error text': [(env) => { env.result = 404; env.response = 'unknown message'; }, 'enrollment_unavailable'],
    'require_reply true': [(env) => { env.require_reply = true; }, 'enrollment_invalid'],
    'missing extra': [(env) => { delete env.extra; }, 'enrollment_invalid'],
    'extra envelope member': [(env) => { env.proof = 'x'; }, 'enrollment_invalid'],
    'response not an object': [(env) => { env.response = JSON.stringify(env.response); }, 'enrollment_invalid'],
    'entry text with no canonical form': [(env) => { env.response.entries[0].evidence = 'row \ud800'; }, 'enrollment_invalid'],
  };
  for (const [label, [change, code]] of Object.entries(envelopeCases)) {
    const vector = storedVector('current-entry');
    change(vector.envelope);
    assertRefused(() => verify(vector), code, label);
  }

  const vector = storedVector('current-entry');
  const { signature } = vector.envelope.response;
  const sameBytes = withSpareBitSet(signature);
  assert.deepEqual(Buffer.from(sameBytes, 'base64url'), Buffer.from(signature, 'base64url'));
  vector.envelope.response.signature = sameBytes;
  assertRefused(() => verify(vector), 'enrollment_invalid', 'signature with nonzero spare bits');
});

test('a signed complete empty enrollment returns an empty array and a revoked entry remains visible', () => {
  const empty = verify(storedVector('complete-empty'));
  assert.deepEqual(empty, []);
  assert.ok(Object.isFrozen(empty));
  const revokedVector = storedVector('revoked-entry');
  const [revoked] = verify(revokedVector);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.claim, revokedVector.options.request.participantClaim);
  assert.equal(verify(signedVariant((r) => { r.entries = [{ ...r.entries[0], revoked: true }, r.entries[0]]; })).length, 2, 'a revoked and a later current entry both stay');
});
