// Paid-write approval for the keystore buyer's composition. A read-only preview, made outside any effect pass, gives a paid write's complete
// approval content and the content Demos will sign. The host approves those exact bytes and authorizes them into a one-use permit, which one
// `wallet.request` inside the pass spends: the wallet's approval callback and its final signature check compare against the prepared copies.
// A keystore send without a valid permit is refused before anything is signed or sent. Internal: `node-wallet-session.mjs` binds it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalize } from '@kynesyslabs/dacs';
import { OperationError } from '../client-errors.mjs';
import { POSITIVE_OS_AMOUNT } from '../public-admission.mjs';

const PAID_JSON_MAX_DEPTH = 64;
const PAID_JSON_MAX_BYTES = 256 * 1024;
const RETAINED_NATIVE_STAGES = ['observed', 'failed'];
const RETAINED_CREATE_STAGE = 'broadcast-accepted';
const REFUSALS = Object.freeze({
  paid_approval_required: 'a keystore paid write needs a one-use approval of its prepared content; nothing was signed or sent',
  paid_approval_used: 'this paid-write approval was already used; nothing was signed or sent',
  paid_approval_mismatch: 'the paid write differs from the content approved for this wallet view; nothing was signed or sent',
});

const fail = (code, message) => { throw new OperationError(code, message); };
const refuseJson = () => fail('invalid_params', 'a paid write is bounded plain JSON: no undefined, symbol, function, accessor, hole, cycle, non-plain container or non-NFC string');

function checkPlainJson(value, ancestors) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string') { if (value !== value.normalize('NFC')) refuseJson(); return; }
  if (typeof value !== 'object' || ancestors.has(value) || ancestors.size >= PAID_JSON_MAX_DEPTH) refuseJson();
  const isArray = Array.isArray(value), keys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) refuseJson();
  if (isArray && keys.length !== value.length + 1) refuseJson();
  ancestors.add(value);
  for (const key of keys) {
    if (isArray && key === 'length') continue;
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || (isArray && !(String(Number(key)) === key && Number(key) < value.length))) refuseJson();
    checkPlainJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

// The canonical text of a paid write's request or projection, after every own member and array position is checked as bounded plain JSON.
function strictPaidJson(value) {
  checkPlainJson(value, new Set());
  let text;
  // The canonical form also refuses what it cannot carry exactly, such as an integer beyond the safe range.
  try { text = canonicalize(value); } catch { refuseJson(); }
  if (Buffer.byteLength(text) > PAID_JSON_MAX_BYTES) refuseJson();
  return text;
}

// A deeply frozen copy of checked canonical text: what a host displays, detached from the caller's objects.
const frozenCopy = text => JSON.parse(text, (_key, value) => (value !== null && typeof value === 'object' ? Object.freeze(value) : value));

function passCeilingOf(options, sessionCeilingOs) {
  const feeCeilingOs = options?.feeCeilingOs;
  if (options === null || typeof options !== 'object' || Reflect.ownKeys(options).length !== 1 || typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)) {
    fail('invalid_params', 'preparePaidWrite takes {feeCeilingOs}, a positive decimal OS amount');
  }
  if (BigInt(feeCeilingOs) > BigInt(sessionCeilingOs)) fail('fee_ceiling_above_session', 'the intended pass fee ceiling is above the session fee ceiling');
  return feeCeilingOs;
}

async function nodeValue(transport, message, data, accept) {
  const answer = await transport.readRpc('/', { method: 'nodeCall', params: [{ message, data }] });
  if (answer?.result !== 200 || !accept(answer.response)) fail('upstream_unavailable', `the pinned node did not answer ${message}; nothing was prepared`);
  return answer.response;
}

// The retained rows of the wallet's lanes, read under their locks with no claim or write: a native row must be finished, and for a CREATE
// the selected anchor journal's row must hold an accepted broadcast. The native lock is released before the anchor lock is taken.
async function refuseUncertainLanes({ transport, anchorJournal, address, create }) {
  const { network, chainIdentity } = transport.pins;
  const native = await transport.inspectWalletNonceLane({ owner: address, network, chainIdentity });
  if (native && !RETAINED_NATIVE_STAGES.includes(native.stage)) fail('outcome_unknown', 'an issued native transfer is retained; read it back before preparing another paid write');
  if (!create) return;
  const lane = JSON.stringify([network, chainIdentity, address]);
  const retained = await anchorJournal.withWalletLock(lane, () => anchorJournal.get(lane));
  if (retained && retained.stage !== RETAINED_CREATE_STAGE) fail('outcome_unknown', 'an issued anchor owns this wallet nonce lane; read it back before preparing another paid write');
}

// The approval request a host approves: the planner's callback with the intended pass ceiling added to its content.
const withCeiling = (callback, feeCeilingOs) => ({ ...callback, content: { ...callback.content, feeCeilingOs } });
// Canonical text, or null for a value that is not bounded plain JSON: such a value never equals an approved copy.
const canonicalOrNull = value => { try { return strictPaidJson(value); } catch { return null; } };
const refusalEnvelope = error => ({ success: false, data: null, error: { code: error.code, message: error.message } });

/**
 * createPaidApproval({session, transport, transactionTransport, relayOrigin, feeCeilingOs, projectPaidWrite, EmbeddedWalletError}) binds the keystore
 * composition's paid-write approval over its SDK wallet session, its raw Agreement transport, the wallet's transport descriptor and relay origin, the
 * session fee ceiling, and the wallet provider's `projectPaidWrite` planner and error class (which only the reviewed session module imports): the
 * provider passes on only its own errors' codes. Returns `{viewFor, approvalCheck, signedContentCheck}`.
 *
 * `viewFor(anchorJournal, send)` returns one wallet view's `{preparePaidWrite, authorizePaidWrite, request}`, where `send(request)` is the view's own
 * provider request. `preparePaidWrite(request, {feeCeilingOs})` resolves `{content, signedContent, prepared}`: the deeply frozen approval request
 * `{method, address, purpose, content}` (the planner's content plus `feeCeilingOs`) and Demos-finalized `transaction.content`, and an opaque frozen
 * handle. It rejects, before any node read: invalid_params (options, a request that is not bounded plain JSON, a method other than `sendTransaction`),
 * fee_ceiling_above_session, locked; then outcome_unknown for an unfinished retained native or anchor lane, the transport's or journal's own refusal,
 * upstream_unavailable, and the planner's refusals. It never signs, authenticates, confirms, broadcasts or writes a journal record.
 * `authorizePaidWrite(prepared, approvedContent)` resolves an opaque frozen one-use permit when `prepared` is this view's handle and `approvedContent`
 * is its complete `content`; it rejects EmbeddedWalletError(paid_approval_mismatch) for another view's or session's handle or other content, and
 * (paid_approval_used) once the handle has authorized a permit. `request(request, {paidApproval: permit})` sends a `sendTransaction` only with this
 * view's authorized permit for exactly the prepared request, and answers the closed envelope otherwise, before the provider is entered:
 * paid_approval_required (no permit or an unknown one), paid_approval_used, paid_approval_mismatch (another view, another request), invalid_params
 * (another option member, a request that is not bounded plain JSON). An entered request spends the permit, whatever its outcome. Other methods pass to `send`.
 *
 * The provider calls `approvalCheck(callback)` where it would ask the host to approve a write: inside an entered request it returns true after it
 * compares the callback with the approved content and consumes the permit; with no entered request it returns undefined for any other method. It
 * throws EmbeddedWalletError(paid_approval_mismatch | paid_approval_used | paid_approval_required for a `sendTransaction` with no entered request).
 * `signedContentCheck(content, debit)` runs synchronously before the inner transaction signature: it returns `debit` plus the approved pass ceiling as
 * `requiredCeilingOs` when `content` is exactly the prepared Demos content and the callback consumed this request's permit, and throws
 * EmbeddedWalletError(paid_approval_mismatch, the cause kept) otherwise, or (paid_approval_required) outside an entered request.
 */
export function createPaidApproval({ session, transport, transactionTransport, relayOrigin, feeCeilingOs: sessionCeilingOs, projectPaidWrite, EmbeddedWalletError }) {
  // The records a later one-use approval checks against, keyed by the handle; the composition's own identity and each view's token bind them.
  // A record moves prepared → authorized → inFlight → consumed, and never back; `permits` maps each minted permit to its record.
  const ownerSession = Object.freeze({}), preparedRecords = new WeakMap(), permits = new WeakMap(), requestScope = new AsyncLocalStorage();
  const refusePaid = (code, cause) => new EmbeddedWalletError(code, REFUSALS[code], cause === undefined ? {} : { cause });
  async function prepare(viewToken, anchorJournal, request, options) {
    const feeCeilingOs = passCeilingOf(options, sessionCeilingOs);
    const requestCanonical = strictPaidJson(request), copy = frozenCopy(requestCanonical);
    if (copy?.method !== 'sendTransaction' || !Array.isArray(copy.params) || copy.params.length !== 1) fail('invalid_params', 'preparePaidWrite expects {method: "sendTransaction", params: [transaction]}');
    const address = session.getPublicAccount()?.address, transaction = copy.params[0];
    if (!address) fail('locked', 'the wallet is locked');
    await refuseUncertainLanes({ transport, anchorJournal, address, create: typeof transaction?.kind === 'string' });
    const binding = await transport.observeBinding();
    const chainNonce = await nodeValue(transport, 'getAddressNonce', { address }, value => Number.isSafeInteger(value) && value >= 0) + 1;
    const fee = await nodeValue(transport, 'getNetworkParameters', {}, value => typeof value?.networkFee === 'number' && typeof value?.rpcFee === 'number');
    const postFork = (await nodeValue(transport, 'getNetworkInfo', {}, value => typeof value?.forks?.osDenomination?.activated === 'boolean')).forks.osDenomination.activated;
    const projection = await projectPaidWrite({ request: copy, transaction, address, binding, fee, postFork, chainNonce, transactionTransport, relayOrigin, scopedPaidWrite: true });
    if (session.getPublicAccount()?.address !== address) fail('locked', 'the wallet was locked or replaced while the paid write was prepared');
    const callbackCanonical = strictPaidJson(withCeiling(projection.callback, feeCeilingOs));
    const signedCanonical = strictPaidJson(projection.signedContent), prepared = Object.freeze({});
    preparedRecords.set(prepared, { ownerSession, viewToken, requestCanonical, callbackCanonical, signedCanonical, feeCeilingOs, state: 'prepared' });
    return Object.freeze({ content: frozenCopy(callbackCanonical), signedContent: frozenCopy(signedCanonical), prepared });
  }
  async function authorize(viewToken, prepared, approvedContent) {
    const record = preparedRecords.get(prepared);
    if (record?.viewToken !== viewToken) throw refusePaid('paid_approval_mismatch');
    if (record.state !== 'prepared') throw refusePaid('paid_approval_used');
    if (canonicalOrNull(approvedContent) !== record.callbackCanonical) throw refusePaid('paid_approval_mismatch');
    record.state = 'authorized';
    const permit = Object.freeze({});
    permits.set(permit, record);
    return permit;
  }
  // The checks before the provider is entered. A refusal here leaves the permit authorized for its own unchanged request.
  function admitEntry(viewToken, request, options) {
    if (options.length === 0 || options[0] === undefined) throw refusePaid('paid_approval_required');
    const [option] = options;
    if (options.length !== 1 || option === null || typeof option !== 'object' || Reflect.ownKeys(option).length !== 1 || !Object.hasOwn(option, 'paidApproval')) {
      fail('invalid_params', 'a keystore paid write takes exactly {paidApproval: permit} as its second argument');
    }
    const record = permits.get(option.paidApproval);
    if (!record) throw refusePaid('paid_approval_required');
    if (record.state !== 'authorized') throw refusePaid('paid_approval_used');
    const requestCanonical = strictPaidJson(request);
    if (record.viewToken !== viewToken || requestCanonical !== record.requestCanonical) throw refusePaid('paid_approval_mismatch');
    return record;
  }
  async function enter(viewToken, send, request, options) {
    if (request?.method !== 'sendTransaction') return send(request);
    let record;
    try { record = admitEntry(viewToken, request, options); } catch (error) { return refusalEnvelope(error); }
    // Entered synchronously, so a concurrent or nested request cannot borrow the permit; every exit retires it.
    record.state = 'inFlight';
    try { return await requestScope.run(record, () => send(JSON.parse(record.requestCanonical))); } finally { record.state = 'consumed'; }
  }
  return Object.freeze({
    viewFor(anchorJournal, send) {
      const viewToken = Object.freeze({});
      return {
        preparePaidWrite: (request, options) => prepare(viewToken, anchorJournal, request, options),
        authorizePaidWrite: (prepared, approvedContent) => authorize(viewToken, prepared, approvedContent),
        request: (request, ...options) => enter(viewToken, send, request, options),
      };
    },
    approvalCheck(callback) {
      const record = requestScope.getStore();
      if (!record) {
        if (callback?.method === 'sendTransaction') throw refusePaid('paid_approval_required');
        return undefined;
      }
      if (record.state !== 'inFlight') throw refusePaid('paid_approval_used');
      if (canonicalOrNull(withCeiling(callback, record.feeCeilingOs)) !== record.callbackCanonical) throw refusePaid('paid_approval_mismatch');
      record.state = 'consumed';
      return true;
    },
    signedContentCheck(content, debit) {
      const record = requestScope.getStore();
      if (!record) throw refusePaid('paid_approval_required');
      if (record.state !== 'consumed') throw refusePaid('paid_approval_mismatch', new Error('the approval callback did not consume this request\'s permit'));
      let signedCanonical;
      try { signedCanonical = strictPaidJson(content); } catch (cause) { throw refusePaid('paid_approval_mismatch', cause); }
      if (signedCanonical !== record.signedCanonical) throw refusePaid('paid_approval_mismatch', new Error('the finalized Demos content differs from the prepared content'));
      return { ...debit, requiredCeilingOs: record.feeCeilingOs };
    },
  });
}
