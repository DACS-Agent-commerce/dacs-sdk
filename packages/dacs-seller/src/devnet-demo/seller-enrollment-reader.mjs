// The seller's verified enrollment source. Each call asks the operator's node for a participant's signed enrollment answer
// (`getParticipantEnrollmentProof`, see `../dacs/enrollment-proof.mjs`) with a fresh nonce, and returns only entries the
// pinned node key signed for that request at a block the reader itself read on the same connection to the approved chain.
// It keeps no answer between calls, signs and sends nothing, and turns no refusal into an empty list.
import { randomBytes } from 'node:crypto';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createNodeAuthorityCapability, createNodeObserver, createNodeTransportOwner, fetchBoundedNodeJson, listsWithin } from '@kynesyslabs/dacs-client/node-wallet';
import { parseTrustedNodePin, verifyEnrollmentAnswer } from '../dacs/enrollment-proof.mjs';
import { pinValid } from '../dacs/seller-transport-auth.mjs';
import { OperationError } from '../operations.mjs';

const ENROLLMENT_METHOD = 'getParticipantEnrollmentProof';
const REQUEST_VERSION = 1;
// One deadline covers a call's whole read: its wait behind an earlier call, every node read and verification.
const READ_DEADLINE_MS = 10_000;
// The request and the enrollment reply are each at most 1 MiB; the decoded reply at most 1024 members per array or object
// and 32 levels deep.
const MAX_BYTES = 1024 * 1024;
const MAX_MEMBERS = 1024;
const MAX_DEPTH = 32;
const NONCE_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/;
const BYTE_LIMIT_MESSAGE = 'response exceeds byte limit';
const CONNECTION_CHANGED_CODES = ['identity_mismatch', 'transport_closed'];
const ENROLLMENT_CODES = ['enrollment_unverified', 'enrollment_invalid', 'enrollment_timeout', 'enrollment_too_large',
  'enrollment_connection_changed', 'enrollment_unavailable'];
// The verifier refuses every answer without a well-formed signed height and block hash before it compares blocks, so this
// stand-in for a block that was never read cannot bind an answer.
const UNREAD_BLOCK = Object.freeze({ height: 0, blockHash: '0'.repeat(64) });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

function refusal(code, message, cause) {
  const error = new OperationError(code, `enrollment refused: ${message}`);
  if (cause !== undefined) error.cause = cause;
  return error;
}

// True when no array or object in `value` is nested more than `limit` levels deep. Iterative, so depth cannot overflow the stack.
function depthWithin(value, limit) {
  const pending = [[value, 1]];
  while (pending.length > 0) {
    const [next, depth] = pending.pop();
    if (next === null || typeof next !== 'object') continue;
    if (depth > limit) return false;
    for (const member of Object.values(next)) pending.push([member, depth + 1]);
  }
  return true;
}

const isTimeout = (error) => error?.code === 'tp1_authority_timeout' || error?.kind === 'timeout';

// The refusal code for a failed chain observation or selected-block read. The observer reports a failed identity read as its
// own `unavailable` error with the read's error as cause, so a timeout is found there too.
function chainReadCode(error) {
  if (isTimeout(error) || isTimeout(error?.cause)) return 'enrollment_timeout';
  return CONNECTION_CHANGED_CODES.includes(error?.code) ? 'enrollment_connection_changed' : 'enrollment_unavailable';
}

// The refusal code for a failed enrollment request through the bounded bridge.
function bridgeCode(error) {
  if (isTimeout(error)) return 'enrollment_timeout';
  if (error?.kind !== 'invalid') return 'enrollment_unavailable';
  return error.code === 'BYTE-LIMIT-EXCEEDED' || error.message === BYTE_LIMIT_MESSAGE ? 'enrollment_too_large' : 'enrollment_invalid';
}

// Runs one stage; a failure rejects with an enrollment refusal naming the stage, its own code kept, the original error as cause.
async function atStage(stage, codeFor, run) {
  try {
    return await run();
  } catch (error) {
    const own = error instanceof OperationError && ENROLLMENT_CODES.includes(error.code) ? error.code : undefined;
    throw refusal(own ?? codeFor(error), `the ${stage} failed`, error);
  }
}

// The signed block an answer names, or null when it names none that can be read.
function signedBlockOf(answer) {
  const response = isObject(answer) ? answer.response : undefined;
  const readable = isObject(response) && Number.isSafeInteger(response.height) && response.height >= 0 && typeof response.blockHash === 'string' && HEX64.test(response.blockHash);
  return readable ? { height: response.height, blockHash: response.blockHash } : null;
}

/**
 * Opens the seller's verified enrollment reader over one node connection. Options: `endpoint`, `transportAuthority` and
 * `fetchImpl` (as `createNodeTransportOwner` takes them), the seller's `claim`, its Listing's full `listingPin`
 * `{listingId, version, contentHash}`, the operator's required `trustedNode` pin `{chainIdentity, publicKey}` (no default)
 * and an optional `clock` `{now()}` for the chain observer. Returns frozen `{entriesFor(participantClaim, {sessionId, signal}),
 * close()}`. `entriesFor` resolves every entry the pinned node signed for the participant, revoked ones included, or `[]`
 * for a signed complete empty set; `sessionId` is never sent and a caller `signal` ends the call. Calls run one at a time,
 * each inside one 10 s deadline. It rejects OperationError `enrollment_invalid` (a missing participant claim, a malformed
 * answer), `enrollment_unverified`, `enrollment_timeout`, `enrollment_too_large`, `enrollment_connection_changed` (a changed
 * connection or chain, or `close()`) or `enrollment_unavailable` (a failed read or a caller abort), with the original error as
 * `cause`. `close()` ends the active and queued calls and closes the connection. Throws OperationError `enrollment_invalid`
 * for a malformed pin, seller claim or Listing pin and `enrollment_unverified` for a pin of another chain, before any read,
 * and the transport owner's own error for a bad endpoint or authority.
 */
export function openVerifiedEnrollmentReader({ endpoint, transportAuthority, fetchImpl, claim, listingPin, trustedNode, clock } = {}) {
  parseTrustedNodePin(trustedNode);
  if (!isNonEmptyString(claim)) throw refusal('enrollment_invalid', 'the seller claim is not a nonempty string');
  if (!pinValid(listingPin)) throw refusal('enrollment_invalid', 'the Listing pin is not {listingId, version, contentHash}');
  const owner = createNodeTransportOwner({ endpoint, transportAuthority, fetchImpl });
  let observer, capability;
  try {
    observer = createNodeObserver({ owner, clock });
    capability = createNodeAuthorityCapability({ owner, claim: () => claim });
  } catch (error) {
    owner.close();
    throw error;
  }
  const closing = new AbortController();
  let closed = false, tail = Promise.resolve();

  // Resolves when every earlier call has finished; rejects with the signal's reason once it aborts.
  function takeTurn(signal) {
    const preceding = tail;
    let release;
    const finished = new Promise((resolve) => { release = resolve; });
    tail = preceding.then(() => finished);
    const ready = new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      preceding.then(() => { signal.removeEventListener('abort', stop); resolve(); });
    });
    return { ready, release };
  }

  // The observed connection is the owner's, on the approved chain, and unchanged since `before`.
  async function observeConnection(signal, before = null) {
    const observation = await observer.observe({ signal });
    if (observation.chainIdentity !== TP1_APPROVED_IDENTITY_RECORD.chainIdentity || observation.local.connectionId !== owner.currentLocal().connectionId ||
      (before !== null && (observation.provenance !== before.provenance || observation.chainIdentity !== before.chainIdentity))) {
      throw refusal('enrollment_connection_changed', 'the node connection or chain changed');
    }
    return observation;
  }

  async function readAnswer(request, signal) {
    const body = { method: 'nodeCall', params: [{ message: ENROLLMENT_METHOD, data: { version: REQUEST_VERSION, ...request } }] };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BYTES) throw refusal('enrollment_too_large', 'the request is over 1 MiB');
    const answer = await fetchBoundedNodeJson(owner, body, { maxBytes: MAX_BYTES, timeoutMs: READ_DEADLINE_MS, signal });
    if (!listsWithin(answer, MAX_MEMBERS) || !depthWithin(answer, MAX_DEPTH)) throw refusal('enrollment_too_large', 'the answer is too wide or too deep');
    return answer;
  }

  async function readBlock(height, signal) {
    const reply = await capability.authorityRpc({ method: 'nodeCall', params: [{ message: 'getBlockByNumber', data: { blockNumber: height } }] }, { signal });
    const block = reply?.result === 200 ? reply.response : undefined;
    if (!isObject(block) || !Number.isSafeInteger(block.number) || typeof block.hash !== 'string' || !HEX64.test(block.hash)) {
      throw refusal('enrollment_unavailable', `the node did not answer block ${height}`);
    }
    return { height: block.number, blockHash: block.hash };
  }

  async function readVerified(participantClaim, signal) {
    const before = await atStage('first chain observation', chainReadCode, () => observeConnection(signal));
    const request = { sellerClaim: claim, participantClaim, listingPin, nonce: randomBytes(NONCE_BYTES).toString('hex') };
    const answer = await atStage('enrollment read', bridgeCode, () => readAnswer(request, signal));
    const signedBlock = signedBlockOf(answer);
    let observedBlock = UNREAD_BLOCK;
    if (signedBlock !== null) {
      observedBlock = await atStage('selected-block read', chainReadCode, () => readBlock(signedBlock.height, signal));
      await atStage('second chain observation', chainReadCode, () => observeConnection(signal, before));
    }
    return atStage('verification', () => 'enrollment_invalid', () => {
      signal.throwIfAborted();
      return verifyEnrollmentAnswer(answer, { request, trustedNode, observedBlock });
    });
  }

  // Close first, then the deadline, then the caller's abort decide a call that ended early; otherwise its stage's refusal stands.
  function finalRefusal(error, call) {
    if (closed) return refusal('enrollment_connection_changed', 'the reader was closed before the read finished', error.cause ?? error);
    if (call.deadline.aborted) return refusal('enrollment_timeout', 'the read did not finish within 10 s', error.cause ?? error);
    if (call.caller?.aborted) return refusal('enrollment_unavailable', 'the caller abandoned the read', call.caller.reason);
    return error;
  }

  async function entriesFor(participantClaim, { signal: caller } = {}) {
    if (!isNonEmptyString(participantClaim)) throw refusal('enrollment_invalid', 'the participant claim is not a nonempty string');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('the enrollment read did not finish within 10 s', 'TimeoutError')), READ_DEADLINE_MS);
    const call = { deadline: deadline.signal, caller };
    const signal = AbortSignal.any(caller ? [deadline.signal, closing.signal, caller] : [deadline.signal, closing.signal]);
    const turn = takeTurn(signal);
    try {
      await atStage('wait for an earlier read', () => 'enrollment_unavailable', () => turn.ready);
      return await readVerified(participantClaim, signal);
    } catch (error) {
      throw finalRefusal(error, call);
    } finally {
      clearTimeout(timer);
      turn.release();
    }
  }

  return Object.freeze({
    entriesFor,
    close() {
      if (closed) return;
      closed = true;
      closing.abort(new Error('the enrollment reader was closed'));
      owner.close();
    },
  });
}
