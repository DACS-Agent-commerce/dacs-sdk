// A node's signed answer to `getParticipantEnrollmentProof`: every enrollment entry of one participant under one seller and
// Listing pin, from one registry snapshot at a stated chain block. The seller asks with a JSON-RPC `nodeCall` whose data is
// `{version: 1, sellerClaim, participantClaim, listingPin, nonce}` (a fresh 64-hex nonce per call). The node answers its
// four-member envelope `{result: 200, response, require_reply: false, extra}`, where `response` is
// `{version: 1, request, chainIdentity, height, blockHash, complete: true, entries, signature}`. The node signs the UTF-8
// bytes of `dacs-enrollment-answer/v1\n` followed by the canonical JSON of every response member except `signature`, with
// an Ed25519 key the operator pins. Revoked entries are answered too, and a signed complete empty set means no entry at
// that snapshot. The signature attests the node's snapshot at that block; it is not a finality proof.
import { canonicalize, ed25519Verify, isCanonicalBase64Url, publicKeyFromRaw } from '@kynesyslabs/dacs';
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../operations.mjs';
import { isCanonicalEd25519Signature, isSmallOrderPublicKey } from './demos-claims.mjs';
import { pinValid } from './seller-transport-auth.mjs';

const SIGNING_DOMAIN = 'dacs-enrollment-answer/v1\n';
const ANSWER_VERSION = 1;
const MAX_ENTRIES = 16;
const MAX_SIGNING_INPUT_BYTES = 1024 * 1024;
const PUBLIC_KEY_CHARACTERS = 43;
const HEX64 = /^[0-9a-f]{64}$/;

const ENVELOPE_MEMBERS = ['result', 'response', 'require_reply', 'extra'];
const RESPONSE_MEMBERS = ['version', 'request', 'chainIdentity', 'height', 'blockHash', 'complete', 'entries', 'signature'];
const REQUEST_MEMBERS = ['sellerClaim', 'participantClaim', 'listingPin', 'nonce'];
const ENTRY_MEMBERS = ['claim', 'profile', 'modules', 'evidence', 'revoked'];
const PIN_MEMBERS = ['chainIdentity', 'publicKey'];
const BLOCK_MEMBERS = ['height', 'blockHash'];
const APPROVED_PROFILE = Object.freeze({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
  chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasMembers = (value, members) => isObject(value) && Object.keys(value).length === members.length && members.every((member) => Object.hasOwn(value, member));
const isHeight = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isHex64 = (value) => typeof value === 'string' && HEX64.test(value);
// True when `value` has exactly the members of `expected`, each with the same string value.
const equalsStrings = (value, expected) => hasMembers(value, Object.keys(expected)) && Object.entries(expected).every(([member, text]) => value[member] === text);

function refuse(code, message, cause) {
  const error = new OperationError(code, `enrollment refused: ${message}`);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

const requestValid = (request) => hasMembers(request, REQUEST_MEMBERS) && isNonEmptyString(request.sellerClaim) &&
  isNonEmptyString(request.participantClaim) && pinValid(request.listingPin) && isHex64(request.nonce);

/**
 * Parses the operator's pin of the attesting node, `{chainIdentity, publicKey}`, where `publicKey` is the node key's 32 raw
 * Ed25519 bytes as 43 unpadded canonical base64url characters. Returns frozen `{chainIdentity, keyObject}`. Throws
 * OperationError `enrollment_invalid` for any other shape, encoding, length or a small-order key, and `enrollment_unverified`
 * for a pin naming a chain other than the approved TP-1 chain.
 */
export function parseTrustedNodePin(trustedNode) {
  if (!hasMembers(trustedNode, PIN_MEMBERS) || typeof trustedNode.chainIdentity !== 'string') refuse('enrollment_invalid', 'the trusted node pin is not {chainIdentity, publicKey}');
  const { chainIdentity, publicKey } = trustedNode;
  if (typeof publicKey !== 'string' || publicKey.length !== PUBLIC_KEY_CHARACTERS || !isCanonicalBase64Url(publicKey)) {
    refuse('enrollment_invalid', 'the trusted node key is not 43 canonical base64url characters');
  }
  const raw = Buffer.from(publicKey, 'base64url');
  if (isSmallOrderPublicKey(raw)) refuse('enrollment_invalid', 'the trusted node key is a small-order point');
  let keyObject;
  try {
    keyObject = publicKeyFromRaw(raw);
  } catch (error) {
    refuse('enrollment_invalid', 'the trusted node key is not an Ed25519 public key', error);
  }
  if (chainIdentity !== TP1_APPROVED_IDENTITY_RECORD.chainIdentity) refuse('enrollment_unverified', 'the trusted node pin names another chain');
  return Object.freeze({ chainIdentity, keyObject });
}

// The node's envelope and closed signed response shape; non-200 is an unavailable answer, not a malformed one.
function signedResponse(envelope) {
  if (!hasMembers(envelope, ENVELOPE_MEMBERS)) refuse('enrollment_invalid', 'the answer is not the four-member node envelope');
  if (envelope.result !== 200) refuse('enrollment_unavailable', `the node answered result ${String(envelope.result)}`);
  if (envelope.require_reply !== false) refuse('enrollment_invalid', 'the answer asks for a reply');
  const { response } = envelope;
  if (!hasMembers(response, RESPONSE_MEMBERS)) refuse('enrollment_invalid', 'the signed response has missing or extra members');
  if (response.version !== ANSWER_VERSION) refuse('enrollment_invalid', 'the signed response is not version 1');
  if (response.complete !== true) refuse('enrollment_invalid', 'the signed response is not a complete set');
  if (!requestValid(response.request) || typeof response.chainIdentity !== 'string' || !isHeight(response.height) ||
    !isHex64(response.blockHash) || !Array.isArray(response.entries)) {
    refuse('enrollment_invalid', 'the signed response has a malformed member');
  }
  if (response.entries.length > MAX_ENTRIES) refuse('enrollment_too_large', `the signed response has more than ${MAX_ENTRIES} entries`);
  if (!isCanonicalEd25519Signature(response.signature)) refuse('enrollment_invalid', 'the signature is not 86 canonical base64url characters');
  return response;
}

// A closed TP-1 entry for the requested participant, copied and frozen; anything else refuses the whole answer.
function verifiedEntry(entry, participantClaim) {
  if (!hasMembers(entry, ENTRY_MEMBERS) || entry.claim !== participantClaim || !isNonEmptyString(entry.evidence) ||
    typeof entry.revoked !== 'boolean' || !equalsStrings(entry.profile, APPROVED_PROFILE) || !equalsStrings(entry.modules, TESTNET_PROFILE_TP1.tuple)) {
    refuse('enrollment_invalid', 'an entry is not a TP-1 enrollment of the requested participant');
  }
  return Object.freeze({ claim: entry.claim, profile: Object.freeze({ ...entry.profile }), modules: Object.freeze({ ...entry.modules }),
    evidence: entry.evidence, revoked: entry.revoked });
}

function signingInput(response) {
  const { signature: _signature, ...signed } = response;
  let text;
  try {
    text = SIGNING_DOMAIN + canonicalize(signed);
  } catch (error) {
    refuse('enrollment_invalid', 'the signed response has no canonical form', error);
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_SIGNING_INPUT_BYTES) refuse('enrollment_too_large', 'the signing input is over 1 MiB');
  return bytes;
}

// The signed answer is for this request, on the pinned chain, at the block the caller observed.
function assertBound(response, { request, pin, observedBlock }) {
  const echo = response.request;
  if (echo.nonce !== request.nonce || echo.sellerClaim !== request.sellerClaim || echo.participantClaim !== request.participantClaim ||
    canonicalize(echo.listingPin) !== canonicalize(request.listingPin)) {
    refuse('enrollment_unverified', 'the answer is for another request');
  }
  if (response.chainIdentity !== pin.chainIdentity || response.chainIdentity !== TP1_APPROVED_IDENTITY_RECORD.chainIdentity) {
    refuse('enrollment_unverified', 'the answer is for another chain');
  }
  if (response.height !== observedBlock.height || response.blockHash !== observedBlock.blockHash) {
    refuse('enrollment_unverified', 'the answer is not at the observed block');
  }
}

/**
 * Verifies a decoded node envelope (after raw JSON admission) against the caller's `request`
 * `{sellerClaim, participantClaim, listingPin, nonce}`, the operator's `trustedNode` pin and `observedBlock`
 * `{height, blockHash}` read from the live chain. Makes no network call. Returns a frozen array of every signed entry,
 * revoked ones included, or `[]` for a signed complete empty set. Throws OperationError: `enrollment_unavailable` for a
 * non-200 result; `enrollment_invalid` for a malformed pin, request, envelope, response or entry (one bad entry refuses all);
 * `enrollment_too_large` for over 16 entries or a signing input over 1 MiB; `enrollment_unverified` for a bad signature,
 * another signer or pinned chain, or an answer for another request, chain or block.
 */
export function verifyEnrollmentAnswer(envelope, { request, trustedNode, observedBlock } = {}) {
  const pin = parseTrustedNodePin(trustedNode);
  if (!requestValid(request)) refuse('enrollment_invalid', 'the request is malformed');
  if (!hasMembers(observedBlock, BLOCK_MEMBERS) || !isHeight(observedBlock.height) || !isHex64(observedBlock.blockHash)) {
    refuse('enrollment_invalid', 'the observed block is malformed');
  }
  const response = signedResponse(envelope);
  const entries = response.entries.map((entry) => verifiedEntry(entry, request.participantClaim));
  const message = signingInput(response);
  if (!ed25519Verify(message, Buffer.from(response.signature, 'base64url'), pin.keyObject)) {
    refuse('enrollment_unverified', 'the node signature does not verify under the pinned key');
  }
  assertBound(response, { request, pin, observedBlock });
  return Object.freeze(entries);
}
