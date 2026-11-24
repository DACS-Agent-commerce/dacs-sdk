// Test-only node signer for enrollment answers. It derives an Ed25519 key from a readable seed label with node:crypto and
// signs answers on its own, without the verifier, so a verified answer in a test is an independent proof. No private key bytes
// are stored anywhere; the checked-in vectors under ../vectors/enrollment/ are what this file produces.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';

/** The readable label whose SHA-256 is the test-only node key's seed. */
export const TEST_ONLY_SEED_LABEL = 'dacs-sdk/enrollment-proof-test-only/v1';
const SIGNING_DOMAIN = 'dacs-enrollment-answer/v1\n';
// PKCS#8 DER header for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The Ed25519 key derived from `label`: its private KeyObject and its 43-character base64url public key. */
export function testOnlyNodeKey(label = TEST_ONLY_SEED_LABEL) {
  const seed = createHash('sha256').update(label, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: spki.subarray(spki.length - 32).toString('base64url') };
}

/** The operator pin for a key: the approved chain identity and the key's base64url public key. */
export const trustedNodeFor = (key) => ({ chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, publicKey: key.publicKey });

/** The text a node signs: the domain line, then canonical JSON of every response member except `signature`. */
export function signingInputFor(response) {
  const signed = Object.fromEntries(Object.entries(response).filter(([member]) => member !== 'signature'));
  return SIGNING_DOMAIN + canonicalize(signed);
}

/** Returns `unsigned` with a node signature over its signing input by `key`. */
export function signResponse(unsigned, key = testOnlyNodeKey()) {
  const signature = sign(null, Buffer.from(signingInputFor(unsigned), 'utf8'), key.privateKey).toString('base64url');
  return { ...unsigned, signature };
}

/** The node's four-member success envelope around a signed response. */
export const successEnvelope = (response) => ({ result: 200, response, require_reply: false, extra: '' });

/** A request, its selected block and one current TP-1 entry, each a fresh object. */
export function enrollmentScenario() {
  const request = {
    sellerClaim: `did:demos:agent:${'5e'.repeat(32)}`,
    participantClaim: `did:demos:agent:${'b7'.repeat(32)}`,
    listingPin: { listingId: 'enrollment-test-listing', version: 3, contentHash: 'c4'.repeat(32) },
    nonce: sha256Hex('enrollment test nonce one'),
  };
  const observedBlock = { height: 120345, blockHash: sha256Hex('enrollment test block 120345') };
  return { request, observedBlock, entry: entryFor(request.participantClaim) };
}

/** A current, unrevoked TP-1 entry for `claim`. */
export function entryFor(claim, evidence = 'registry row 41 at block 120300') {
  return {
    claim,
    profile: { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion },
    modules: { ...TESTNET_PROFILE_TP1.tuple },
    evidence,
    revoked: false,
  };
}

/** The unsigned response a node gives for `request` at `observedBlock` with `entries`. */
export const unsignedResponse = ({ request, observedBlock }, entries) => ({
  version: 1, request, chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity,
  height: observedBlock.height, blockHash: observedBlock.blockHash, complete: true, entries,
});

/** Every checked-in vector file's content, regenerated from the seed label. */
export function enrollmentVectors() {
  const scenario = enrollmentScenario();
  const cases = {
    'current-entry': [scenario.entry],
    'complete-empty': [],
    'revoked-entry': [{ ...scenario.entry, evidence: 'registry row 41 revoked at block 120310', revoked: true }],
  };
  const answers = {}, signingInputs = {}, digests = {};
  for (const [name, entries] of Object.entries(cases)) {
    const response = signResponse(unsignedResponse(scenario, entries));
    const answer = JSON.stringify(successEnvelope(response));
    answers[name] = { answer, request: scenario.request, observedBlock: scenario.observedBlock };
    signingInputs[name] = signingInputFor(response);
    digests[name] = { answerSha256: sha256Hex(answer), signingInputSha256: sha256Hex(signingInputs[name]) };
  }
  const testPublicKey = { seedLabel: TEST_ONLY_SEED_LABEL, trustedNode: trustedNodeFor(testOnlyNodeKey()) };
  return { 'answers.json': answers, 'signing-inputs.json': signingInputs, 'digests.json': digests, 'test-public-key.json': testPublicKey };
}
