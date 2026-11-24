// Paid-write approval for the keystore buyer's composition: a read-only preview of a paid write's complete approval content and the content
// Demos will sign, made outside any effect pass, and the request guard that refuses every keystore send that carries no one-use approval.
// Nothing in the client issues such an approval, so the guard refuses every send. Internal: `node-wallet-session.mjs` binds it.
import { canonicalize } from '@kynesyslabs/dacs';
import { OperationError } from '../client-errors.mjs';
import { POSITIVE_OS_AMOUNT } from '../public-admission.mjs';

const PAID_JSON_MAX_DEPTH = 64;
const PAID_JSON_MAX_BYTES = 256 * 1024;
const RETAINED_NATIVE_STAGES = ['observed', 'failed'];
const RETAINED_CREATE_STAGE = 'broadcast-accepted';
const PAID_APPROVAL_REQUIRED = Object.freeze({ code: 'paid_approval_required', message: 'a keystore paid write needs a one-use approval of its prepared content; nothing was signed or sent' });

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

/**
 * createPaidApproval({session, transport, transactionTransport, relayOrigin, feeCeilingOs, projectPaidWrite}) binds the keystore composition's paid-write
 * approval over its SDK wallet session, its raw Agreement transport, the wallet's transport descriptor and relay origin, the session fee ceiling and the
 * wallet provider's `projectPaidWrite` planner (which only the reviewed session module imports). Returns
 * `{previewFor(anchorJournal), refuseUnpermitted(request)}`. `previewFor` returns one wallet view's `preparePaidWrite(request, {feeCeilingOs})`,
 * which resolves `{content, signedContent, prepared}`: the deeply frozen approval request `{method, address, purpose, content}` (the planner's content
 * plus `feeCeilingOs`) and Demos-finalized `transaction.content`, and an opaque frozen handle. It rejects, before any node read: invalid_params (options,
 * a request that is not bounded plain JSON, a method other than `sendTransaction`), fee_ceiling_above_session, locked; then outcome_unknown for an
 * unfinished retained native or anchor lane, the transport's or journal's own refusal, upstream_unavailable, and the planner's refusals. It never signs,
 * authenticates, confirms, broadcasts or writes a journal record. `refuseUnpermitted` returns the closed `paid_approval_required` envelope for every
 * `sendTransaction`, and undefined for any other method.
 */
export function createPaidApproval({ session, transport, transactionTransport, relayOrigin, feeCeilingOs: sessionCeilingOs, projectPaidWrite }) {
  // The records a later one-use approval checks against, keyed by the handle; the composition's own identity and each view's token bind them.
  const ownerSession = Object.freeze({}), preparedRecords = new WeakMap();
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
    const callbackCanonical = strictPaidJson({ ...projection.callback, content: { ...projection.callback.content, feeCeilingOs } });
    const signedCanonical = strictPaidJson(projection.signedContent), prepared = Object.freeze({});
    preparedRecords.set(prepared, { ownerSession, viewToken, requestCanonical, callbackCanonical, signedCanonical, feeCeilingOs, state: 'prepared' });
    return Object.freeze({ content: frozenCopy(callbackCanonical), signedContent: frozenCopy(signedCanonical), prepared });
  }
  return Object.freeze({
    previewFor(anchorJournal) {
      const viewToken = Object.freeze({});
      return (request, options) => prepare(viewToken, anchorJournal, request, options);
    },
    refuseUnpermitted: request => (request?.method === 'sendTransaction' ? { success: false, data: null, error: { ...PAID_APPROVAL_REQUIRED } } : undefined),
  });
}
