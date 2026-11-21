// The client's held Node wallet session: the reviewed SDK wallet session on Node demosdk, whose
// only route to the node is the client's native transport in the same process (no socket of its
// own, no SDK retry, one RPC-authentication stamp source). Every `wallet.request` is held behind
// the admission wrapper until the purchase hold is lifted.
//
// The transport-owner factory is a port of the old operator's `operator-network.mjs`
// (frontend d6f0e16, lines 197-224), in queued-fence mode.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { assertTp1Binding, bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../client-errors.mjs';
import { isTp1AuthorityLabel } from '../dacs/tp1-authority-label.mjs';
import { AUTHORITY_READ_DEADLINE_MS, admitPublicFactory, notAdmittedError, purchaseActionsAdmitted } from '../public-admission.mjs';
import { claimForAddress } from '../signatures.mjs';
import { observeWithDeadline, OutboundError, settleOnAbort } from '../util/http.mjs';
import { createAuthorityReader } from './authority-reader.mjs';
import { createDevnetAgreementTransport, createDevnetDemoTransport, createSourceObserver, registerHeldTransportFacade, DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE, DEVNET_NODE2_BLOCK_LAYOUT, TP1_REVIEWED_BLOCK_TWO_HASH } from './devnet-native-transport.mjs';
import { createEffectBoundary } from './effect-boundary.mjs';
import { createEffectFence } from './effect-fence.mjs';
import { createEffectHistory } from './effect-history.mjs';
import { loadNodeDemos } from './node-demos-loading.mjs';
import { createPaymentEvidenceCreateAdapter } from './node-payment-evidence-adapter.mjs';
import { assertCurrentAuthorization, isPassContext, passContext, runInPassContext } from './pass-context.mjs';
import { createSignerReservations } from './signer-reservation.mjs';
import { createDevnetAgreementWalletTransport, createSdkWalletSession, EmbeddedWalletError, normalizeMnemonic } from '../public/portal/embedded-wallet/sdk-provider.mjs';

// A comparison value inside the descriptor only: `_doPost` checks the URL it is given equals the
// descriptor's `rpcUrl` and never fetches it, and `bindingRelay` replaces the binding fetches.
const NODE_WALLET_RELAY_ORIGIN = 'https://node-wallet.invalid';
const NODE_WALLET_NETWORK = TP1_APPROVED_IDENTITY_RECORD.network;
const IDENTITY_RECORD_DIGEST = createHash('sha256').update(canonicalize(TP1_APPROVED_IDENTITY_RECORD)).digest('hex');
const TRANSPORT_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const PASSIVE_METHODS = ['getPublicAccount', 'getWriteProfile', 'isLocked', 'lock'];
// The facade members that only read or observe; every other function member is an effect entry (DN-4). `binding` is split by phase.
const PASSIVE_TRANSPORT_METHODS = ['readRpc', 'observeBinding', 'chainReader', 'nativeTransferClaimed', 'nativeTransferCancelled',
  'nativeTransferRefused', 'nativeNonceConsumer', 'isWalletIdle', 'profile', 'onPurchaseStep', 'onStorageWriteResend', 'reserveRpcAuth', 'close'];
const READBACK_PHASE = 'readback';
const NODE_INFO_MESSAGES = Object.freeze(['getNetworkInfo', 'getNetworkParameters']);
const AUTHORITY_READ_MESSAGES = Object.freeze(['getBlockByNumber', 'getNetworkInfo']);
const AUTHORITY_READ_MAX_LIST_ENTRIES = 1024;
const AUTHORITY_READ_CONCURRENCY = 4;
const PAYMENT_EVIDENCE_APPROVAL_MEMBERS = ['prepare', 'open', 'reopen', 'confirm', 'settle'];
const OBSERVER_PROVENANCE_PREFIX = `dacs-node-observer:${TP1_APPROVED_IDENTITY_RECORD.recordId}`;
const RPC_FAILED = 'node_wallet_rpc_failed';
const RPC_INVALID = 'node_wallet_rpc_invalid';
const STAGE_NOT_DISPATCHED = 'not_dispatched';
const STAGE_DISPATCHED_NO_ACK = 'dispatched_no_ack';
const OS_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_OS_AMOUNT = /^[1-9][0-9]*$/;
// The `extra` values of a JSON-RPC `execute` body that put a transaction in front of the node; the gate runs at each.
const GATED_EXECUTE_STAGES = ['confirmTx', 'broadcastTx'];
const TP1_LABEL_PREFIX = 'TP1-';
const TP1_LABEL_DIGEST_LENGTH = 32;
const SIGNATURE_DOMAIN = Buffer.from('demos-tx:v1:');
const CHAIN_ID_FIELD = /^[0-9]+:$/;
const TRANSACTION_HASH_SHAPE = /^(?:demos-tx:v1:[0-9]+:)?[0-9a-f]{64}$/i;

// The error each failed request's closed envelope was made from, keyed by that envelope object.
const causes = new WeakMap();
const recordCause = (envelope, error) => { causes.set(envelope, error); };
const internalCauseOf = envelope => causes.get(envelope);
const refuseContent = cause => new EmbeddedWalletError('payload_mismatch', 'the finalized transaction differs from what was approved; nothing was signed', { cause });

// Every lease an owner hands out and has not yet seen released; `release` removes it.
const liveLeases = new WeakSet();
// The fence of the effect pass whose work is running: a fence acquisition inside it reuses that fence instead of queueing behind it.
const passFence = new AsyncLocalStorage();
// Every token `admitTp1Authority` has made; a copy of one is not in it.
const tokens = new WeakSet();
// Each seller composition's signer reservations, over its own journal; never a member of the composition.
const sellerReservations = new WeakMap();

const fail = (code, cause) => { throw new OperationError(code, code, undefined, cause === undefined ? undefined : { cause }); };

/**
 * Makes the context of a job pass for `effectPass({..., context})`; the seller composition takes no other pass. The host that owns the job
 * gives its class (`'job-create'`, `'payment-evidence'` or `'job-resume'`), optionally the job's operation id, and `currentAuthorization`,
 * a synchronous function that returns `true` while the job's authority is current and throws its cause otherwise. Throws `TypeError` for any other class.
 */
export { passContext } from './pass-context.mjs';

/** Removes dead holders' lock rows from a client durable journal, given the host's state-ownership proof; see `signer-reservation.mjs`. */
export { releaseAbandonedJournalLocks } from './signer-reservation.mjs';

/** Capability identity checks (return a boolean, never throw) and the transport's profile and publication constants, re-exported so a kit imports one source. */
export { isDevnetAgreementTransport, isDevnetSettlementTransport, isDevnetDemoTransport,
  DEVNET_AGREEMENT_PROFILE, DEVNET_AGREEMENT_KIND, DEVNET_AGREEMENT_SOURCE, DEVNET_SETTLEMENT_KIND, DEVNET_SETTLEMENT_POLICY,
  DEVNET_DELIVERY_KIND, DEVNET_DELIVERY_POLICY, DEVNET_DEMO_ARTIFACT_KIND, DEVNET_DEMO_ARTIFACT_POLICY, DEVNET_DEMO_ARTIFACT_TYPES } from './devnet-native-transport.mjs';

/**
 * Returns a frozen facade over a registered transport, itself registered so the `isDevnet*Transport` checks accept it. Active members (`rpc`, `walletBinding`,
 * `recoverStorageWrite`, `cancelNativeTransfer` and `binding` for every phase but `readback`) run the admission wrapper and reject `profile_not_admitted` while held;
 * the passive members listed in the README keep their signatures. `readback` is read once, before the call, so a request changed afterwards cannot move it
 * between the two classes. Options: `{admission, transport}`. Throws TypeError(admission_required | admission_input_untrusted | an unregistered transport) and
 * OperationError(runtime_unsupported); active calls reject with `profile_not_admitted`, `runtime_unsupported` or the transport's own error.
 */
export function createHeldTransportFacade({ admission, transport } = {}) {
  const wrapped = admitPublicFactory(() => transport, { passive: PASSIVE_TRANSPORT_METHODS, purchase: true })({ admission });
  const members = Object.fromEntries(Object.entries(wrapped).filter(([name]) => name !== 'actionsAdmitted'));
  const facade = Object.freeze({ ...members, binding(request, ...args) {
    try {
      return request?.phase === READBACK_PHASE ? transport.binding({ ...request, phase: READBACK_PHASE }, ...args) : wrapped.binding(request, ...args);
    } catch (error) { return Promise.reject(error); }
  } });
  registerHeldTransportFacade(facade, transport);
  return facade;
}

// `signCreate` and `broadcast` are active: each call refuses profile_not_admitted while held and checks the binding before it runs.
// The two reads are passive and keep working while held.
function createHeldAdapter(admission, adapter) {
  const wrapped = admitPublicFactory(() => adapter, { passive: ['readAccountNonce', 'readTransactionState'], purchase: true })({ admission });
  return Object.freeze(Object.fromEntries(Object.entries(wrapped).filter(([name]) => name !== 'actionsAdmitted')));
}

/**
 * Returns `{next(identity)}`: a stamp source whose stamps for one identity are strictly increasing
 * milliseconds, also when the clock repeats a millisecond or steps backward. `next` throws
 * OperationError(invalid_clock) when the clock gives a value that is not a positive safe integer.
 */
export function createRpcStampSource(clock) {
  const last = new Map();
  return Object.freeze({ next(identity) {
    const at = clock.now(), stamp = Math.max(at, (last.get(identity) ?? 0) + 1);
    if (!Number.isSafeInteger(at) || at < 1 || !Number.isSafeInteger(stamp)) fail('invalid_clock');
    last.set(identity, stamp);
    return stamp;
  } });
}

function readCanonicalRoot(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch (cause) { fail('transport_mismatch', cause); }
  if (url.href !== endpoint || url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) fail('transport_mismatch');
  return url;
}

/**
 * Returns the owner of the one connection to `endpoint`: `{local, currentLocal(), getContext(), acquireConnectionFence(claim), fetchImpl, close()}`.
 * Fences are granted one at a time in request order; `release` frees a fence once. Inside `runInEffectPass`, an acquisition shares the pass's own fence
 * and is granted at once; its `release` frees nothing. `fetchImpl` reaches only the endpoint origin and refuses redirects.
 * Throws OperationError(transport_mismatch) for an endpoint that is not a canonical HTTPS root or an authority that is not a plain token. After `close()`,
 * `currentLocal`, `getContext`, `fetchImpl` and `acquireConnectionFence` throw transport_closed and queued waiters are rejected.
 */
export function createNodeTransportOwner({ endpoint, transportAuthority, fetchImpl = globalThis.fetch } = {}) {
  const url = readCanonicalRoot(endpoint);
  if (typeof transportAuthority !== 'string' || TRANSPORT_AUTHORITY.exec(transportAuthority)?.[0] !== transportAuthority || typeof fetchImpl !== 'function') fail('transport_mismatch');
  const local = Object.freeze({ endpoint, transportAuthority, connectionId: randomUUID() });
  const context = Object.freeze({ network: NODE_WALLET_NETWORK, ...local });
  const held = new Set();
  let closed = false, tail = Promise.resolve();
  const currentLocal = () => { if (closed) fail('transport_closed'); return local; };
  async function acquireConnectionFence() {
    currentLocal();
    // Inside an effect pass that holds this owner's fence, the transport's own acquisitions share it; its release frees nothing.
    if (held.has(passFence.getStore())) return Object.freeze({ context, release() {} });
    const preceding = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await preceding;
    if (closed) { unlock(); fail('transport_closed'); }
    const lease = Object.freeze({ context, release() {
      if (!liveLeases.delete(lease)) return;
      held.delete(lease);
      unlock();
    } });
    liveLeases.add(lease); held.add(lease);
    return lease;
  }
  return Object.freeze({ local, currentLocal, getContext: () => { currentLocal(); return context; }, acquireConnectionFence,
    fetchImpl(input, init) {
      currentLocal();
      if (new URL(input).origin !== url.origin) fail('transport_mismatch');
      return fetchImpl(input, { ...init, redirect: 'error' });
    },
    close() { closed = true; for (const lease of held) lease.release(); } });
}

// Runs one authority or node read under the 10 s deadline; a timeout is tp1_authority_timeout with the timer's error as cause.
async function withinAuthorityDeadline(read, signal) {
  try { return await observeWithDeadline(read, { timeoutMs: AUTHORITY_READ_DEADLINE_MS, signal }); }
  catch (error) {
    if (error instanceof OutboundError && error.kind === 'timeout') throw new OperationError('tp1_authority_timeout', 'the authority read did not answer within the deadline', undefined, { cause: error });
    throw error;
  }
}

/**
 * Returns the fence-free, read-only observer for a node owner: {observe({signal}),
 * readNodeInfo(message, {signal}), provenance()}. Its expected identity and block-one fallback
 * come only from TP1_APPROVED_IDENTITY_RECORD. It acquires no connection fence, takes no
 * journal lock and signs nothing, so it works while a fence is held and before any journal or
 * custody is opened. observe resolves {local, chainIdentity, provenance} for the owner's current
 * connection once the node's chain matches the record; readNodeInfo resolves the node's answer
 * to getNetworkInfo or getNetworkParameters and refuses every other message (readonly_only).
 * Every node reply is limited to 4 MiB before decoding and each call to one 10 s deadline
 * (tp1_authority_timeout, cause kept); a caller's abort rejects with its own reason and starts
 * no further read. A reader failure keeps its original error. provenance() names the connection
 * generation (the owner's connectionId) and throws transport_closed after close.
 * Throws TypeError for an owner without currentLocal, getContext and fetchImpl.
 */
export function createNodeObserver({ owner, clock = { now: () => Date.now() } } = {}) {
  const source = createSourceObserver({ record: TP1_APPROVED_IDENTITY_RECORD, owner, now: () => clock.now(), timeoutMs: AUTHORITY_READ_DEADLINE_MS });
  const provenanceOf = connectionId => `${OBSERVER_PROVENANCE_PREFIX}:${connectionId}`;
  return Object.freeze({
    provenance: () => provenanceOf(owner.currentLocal().connectionId),
    observe: ({ signal } = {}) => withinAuthorityDeadline(async ({ signal: stop }) => {
      const { endpoint, transportAuthority, connectionId, chainIdentity } = await source.bind({ signal: stop });
      return { local: { endpoint, transportAuthority, connectionId }, chainIdentity, provenance: provenanceOf(connectionId) };
    }, signal),
    async readNodeInfo(message, { signal } = {}) {
      if (!NODE_INFO_MESSAGES.includes(message)) fail('readonly_only');
      const answer = await withinAuthorityDeadline(({ signal: stop }) => source.post({ method: 'nodeCall', params: [{ message, data: {} }] }, {}, { signal: stop }), signal);
      if (answer?.result !== 200) fail('upstream_unavailable');
      return answer.response;
    },
  });
}

// True when no array or object anywhere in `value` has more than `limit` entries. Iterative, and members are pushed
// one at a time, so neither nesting nor width can overflow the stack.
function listsWithin(value, limit) {
  const pending = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === null || typeof next !== 'object') continue;
    const members = Object.values(next);
    if (members.length > limit) return false;
    for (const member of members) pending.push(member);
  }
  return true;
}

// Runs at most `limit` reads at once. The rest wait in order, and a waiter leaves with the signal's reason when its signal aborts.
function createReadQueue(limit) {
  let running = 0;
  const waiting = [];
  const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };
  return async function runQueued(read, signal) {
    signal.throwIfAborted();
    if (running < limit) running += 1;
    else {
      await new Promise((resolve, reject) => {
        const turn = () => { signal.removeEventListener('abort', leave); resolve(); };
        const leave = () => { waiting.splice(waiting.indexOf(turn), 1); reject(signal.reason); };
        waiting.push(turn);
        signal.addEventListener('abort', leave, { once: true });
      });
    }
    try { return await read(); } finally { release(); }
  };
}

/**
 * Returns the session's stage-one authority capability for a node owner: `{authorityRpc(body, {signal}), claim(), context(),
 * connectionGeneration()}`, with no sign or send. `authorityRpc` sends one node read over the owner's current transport and resolves
 * the decoded reply. Only `getBlockByNumber` and `getNetworkInfo` are sent (readonly_only for anything else). It takes no connection fence,
 * journal lock or signer, so it works while an effect pass holds the fence. A reply is limited to 4 MiB before decoding and 1024
 * entries per array or object after (authority_list_too_large). At most four reads run at once; the rest queue inside the same 10 s deadline
 * (tp1_authority_timeout, cause kept). A caller's abort rejects with its own reason. A failed fetch, body read or decode rejects with
 * its original error. `claim` is read synchronously by the production reader; `connectionGeneration()` is the owner's connection id.
 * Throws TypeError for an owner the observer refuses or a `claim` that is not a function.
 */
export function createNodeAuthorityCapability({ owner, claim } = {}) {
  if (typeof claim !== 'function') throw new TypeError('the wallet claim reader must be a function');
  const source = createSourceObserver({ record: TP1_APPROVED_IDENTITY_RECORD, owner, timeoutMs: AUTHORITY_READ_DEADLINE_MS });
  const runQueued = createReadQueue(AUTHORITY_READ_CONCURRENCY);
  async function authorityRpc(body, { signal } = {}) {
    const request = body?.method === 'nodeCall' && body.params?.length === 1 ? body.params[0] : undefined;
    if (!AUTHORITY_READ_MESSAGES.includes(request?.message)) fail('readonly_only');
    const read = { method: 'nodeCall', params: [{ message: request.message, data: request.data }] };
    const answer = await withinAuthorityDeadline(({ signal: stop }) => runQueued(() => source.post(read, {}, { signal: stop }), stop), signal);
    if (!listsWithin(answer, AUTHORITY_READ_MAX_LIST_ENTRIES)) fail('authority_list_too_large');
    return answer;
  }
  return Object.freeze({ authorityRpc, claim, context: () => owner.getContext(), connectionGeneration: () => owner.currentLocal().connectionId });
}

/**
 * Returns the label `TP1-` plus the first 32 hex digits of `binding.recordDigest`, which is stable across restarts and connections.
 * Throws tp1_binding_required when the digest does not yield a canonical label. A label names an authority and grants none.
 */
export function tp1AuthorityLabel(binding) {
  const label = TP1_LABEL_PREFIX + String(binding?.recordDigest).slice(0, TP1_LABEL_DIGEST_LENGTH);
  if (!isTp1AuthorityLabel(label)) fail('tp1_binding_required');
  return label;
}

/**
 * Resolves a frozen, registered token {label} once the wire's binding check passes for `binding` on `currentLocal()` within 10 s and the
 * connection is unchanged afterwards. Rejects tp1_binding_required (a missing binding or reader), the wire's binding refusal codes, tp1_local_binding_changed or
 * tp1_authority_timeout (cause kept). A token is not current authority: every effect still runs its own checks.
 */
export async function admitTp1Authority({ binding, currentLocal } = {}) {
  if (!binding || typeof currentLocal !== 'function') fail('tp1_binding_required');
  const local = currentLocal();
  await withinAuthorityDeadline(({ signal }) => settleOnAbort(assertTp1Binding(binding, local), signal));
  if (canonicalize(currentLocal()) !== canonicalize(local)) fail('tp1_local_binding_changed');
  const token = Object.freeze({ label: tp1AuthorityLabel(binding) });
  tokens.add(token);
  return token;
}

/** Returns true only for a token made by `admitTp1Authority`; a label string, a copy or any other value is false. Never throws. */
export const isTp1AuthorityToken = value => tokens.has(value);

/** Returns the label string of a token, or a canonical `TP1-` or `TEST-` label unchanged. Throws authority_unbound for anything else. */
export function authorityLabelOf(value) {
  if (tokens.has(value)) return value.label;
  if (typeof value === 'string' && (isTp1AuthorityLabel(value) || value.startsWith('TEST-'))) return value;
  return fail('authority_unbound');
}

// A transport failure seen by the SDK: a closed public message, the transport's own error as `cause`,
// and whether the request reached the network (`stage`).
class NodeRpcFailure extends Error {
  constructor(cause, stage) {
    super(RPC_FAILED, { cause });
    this.code = RPC_FAILED; this.stage = stage;
  }
}

// Whether `message` is what demosdk signs for a transaction with this hash: the bare hash, or, once the
// node's signatureDomain fork is active, `demos-tx:v1:<decimal chain id>:<hash>`.
function signsTransactionHash(message, hash) {
  const signed = Buffer.from(message), hashBytes = Buffer.from(hash, 'utf8');
  if (signed.equals(hashBytes)) return true;
  const hashStart = signed.length - hashBytes.length;
  return hashStart > SIGNATURE_DOMAIN.length && signed.subarray(0, SIGNATURE_DOMAIN.length).equals(SIGNATURE_DOMAIN)
    && signed.subarray(hashStart).equals(hashBytes) && CHAIN_ID_FIELD.test(signed.subarray(SIGNATURE_DOMAIN.length, hashStart).toString('latin1'));
}

// Whether `message` has the shape of a transaction signature's input: a bare SHA-256 hex hash, or that hash after the signatureDomain prefix.
// A transaction signature is the same Ed25519 signature over those bytes, so a general request to sign them would hand out a spendable signature.
function hasTransactionHashShape(message) {
  return TRANSACTION_HASH_SHAPE.test(Buffer.from(message).toString('latin1'));
}

const isOsAmount =value => typeof value === 'string' && OS_AMOUNT.test(value);

// Runs synchronously, so nothing can change the transaction between these checks and the inner signature. Returns the approved debit.
function checkFinalContent({ transaction, finalContent }, message) {
  if (typeof transaction?.hash !== 'string' || !(message instanceof Uint8Array) || !signsTransactionHash(message, transaction.hash)) throw new Error('the signed message is not the transaction hash');
  if (createHash('sha256').update(JSON.stringify(transaction.content)).digest('hex') !== transaction.hash) throw new Error('the transaction hash is not the SHA-256 of its content');
  const debit = finalContent(transaction.content);
  if (!isOsAmount(debit?.totalDebitOs) || !isOsAmount(debit.feeDebitOs)) throw new Error('the finalized debit is not canonical OS amounts');
  if (BigInt(debit.feeDebitOs) > BigInt(debit.totalDebitOs)) throw new Error('the finalized fee debit exceeds the total debit');
  return debit;
}

const refuseGate = (code, message, cause) => new EmbeddedWalletError(code, message, cause === undefined ? {} : { cause });
// A host step's own error keeps its code and becomes the cause; the session's sign catch then passes it on instead of sdk_error.
const gateRefusal = error => (error instanceof EmbeddedWalletError ? error
  : refuseGate(typeof error?.code === 'string' ? error.code : 'effect_gate_refused', 'the effect gate refused; nothing was signed or sent', error));
const assertSynchronousCheck = result => {
  if (typeof result?.then !== 'function') return;
  result.then(undefined, () => {});
  throw refuseGate('effect_gate_refused', 'a synchronous effect check must not be asynchronous');
};
const assertFeeWithinCeiling = ({ feeDebitOs }, ceilingOs) => {
  if (BigInt(feeDebitOs) > BigInt(ceilingOs)) throw refuseGate('write-fee-cap', 'the finalized fee is above the ceiling for this write; nothing was signed');
};
// The gated stage of a JSON-RPC `execute` body, or null for every other request (reads, other methods, a body that is not JSON).
const executeStageOf = body => {
  try {
    const request = JSON.parse(body), stage = request?.params?.[0]?.extra;
    return request?.method === 'execute' && GATED_EXECUTE_STAGES.includes(stage) ? stage : null;
  } catch { return null; }
};

/**
 * The composition's one effect gate: `{effectPass, runInEffectPass, pass}`. `pass({phase, signal, checkContent}, inner)` finds the current pass and, after
 * SDK preparation, awaits `qualify`, the pass's refreshAuthority and its finalStop on the pass's remaining deadline. Then, in the same synchronous run, it
 * checks the hold, the connection, the lease, the pass's synchronous checks and (when given) the final content against the fee ceiling, and invokes
 * `inner()`. Any refusal throws before `inner`. With no pass the awaits are skipped, and `passRequired` refuses that case.
 * A pass may carry a `context` made by `passContext`: `runInEffectPass` runs its work in that context, which is where the native transport reads the
 * job class and the pass's current-authorization check, and the gate's synchronous run asks the same check last. With `passRequired` (the seller's
 * composition) a pass needs a job context; otherwise a pass with no context runs as a plain pass. Any other context, and one `passContext` did not make,
 * is refused `effect_pass_invalid`.
 */
function createEffectGate({ owner, expectedLocal, clock, qualify, passRequired }) {
  const scope = new AsyncLocalStorage(), passes = new WeakMap();
  const liveFence = fence => { try { return liveLeases.has(fence) && fence.context === owner.getContext(); } catch { return false; } };
  const effectPass = options => {
    const { fence, deadline, refreshAuthority, finalStop, synchronousChecks, feeCeilingOs, context = passContext() } = options ?? {};
    // Array.from turns a hole into undefined, which the function check below refuses.
    const checks = Array.isArray(synchronousChecks) ? Array.from(synchronousChecks) : [undefined];
    const remainingMs = typeof deadline === 'number' ? deadline - clock.now() : NaN;
    if (!liveFence(fence) || ![refreshAuthority, finalStop, ...checks].every(step => typeof step === 'function')
      || !(remainingMs > 0 && remainingMs <= AUTHORITY_READ_DEADLINE_MS) || typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)
      || !isPassContext(context) || (passRequired && context.operationClass === null)) fail('effect_pass_invalid');
    const handle = Object.freeze({});
    passes.set(handle, Object.freeze({ fence, deadline, refreshAuthority, finalStop, synchronousChecks: Object.freeze(checks), feeCeilingOs, context }));
    return handle;
  };
  const runInEffectPass = (handle, work) => {
    if (typeof work !== 'function') fail('invalid_params');
    const pass = passes.get(handle);
    return scope.run(handle, () => passFence.run(pass?.fence, () => pass ? runInPassContext(pass.context, work) : work()));
  };
  async function awaitStep(step, { deadline, phase, signal, timeoutCode }) {
    const late = cause => refuseGate(timeoutCode, 'the effect pass deadline passed', cause);
    const remainingMs = deadline - clock.now();
    if (remainingMs <= 0) throw late();
    let result;
    try { result = await observeWithDeadline(({ signal: stop }) => settleOnAbort(step({ phase, signal: stop }), stop), { timeoutMs: remainingMs, signal }); }
    catch (error) { throw error instanceof OutboundError && error.kind === 'timeout' ? late(error) : error; }
    if (clock.now() > deadline) throw late();
    return result;
  }
  // Returns the connection generation `qualify` observed, or undefined when none is installed.
  async function awaitSteps(pass, { phase, signal }) {
    const run = (step, timeoutCode) => awaitStep(step, { deadline: pass.deadline, phase, signal, timeoutCode });
    const generation = qualify ? await run(qualify, 'deployment_unqualified') : undefined;
    await run(pass.refreshAuthority, 'tp1_authority_timeout');
    await run(pass.finalStop, 'stop_check_timeout');
    return generation;
  }
  function admitSynchronously(pass, generation, { phase, checkContent }) {
    if (!purchaseActionsAdmitted()) throw notAdmittedError();
    const local = owner.currentLocal();
    if (canonicalize(local) !== canonicalize(expectedLocal) || (qualify && generation !== local.connectionId)) fail('tp1_local_binding_changed');
    if (pass && !liveFence(pass.fence)) fail('effect_pass_invalid');
    for (const check of pass?.synchronousChecks ?? []) assertSynchronousCheck(check({ phase }));
    if (pass) assertCurrentAuthorization(pass.context);
    const debit = checkContent?.();
    if (pass && debit) assertFeeWithinCeiling(debit, pass.feeCeilingOs);
  }
  async function pass(request, inner) {
    try {
      const handle = scope.getStore(), current = passes.get(handle);
      if (handle === undefined && passRequired) throw refuseGate('effect_pass_required', 'an effect pass is required; nothing was signed or sent');
      if (handle !== undefined && !(current && liveFence(current.fence))) throw refuseGate('effect_pass_invalid', 'the effect pass is not registered to this composition or its fence is no longer live');
      const generation = current ? await awaitSteps(current, request) : undefined;
      admitSynchronously(current, generation, request);
    } catch (error) { throw gateRefusal(error); }
    return inner();
  }
  return { effectPass, runInEffectPass, pass };
}

// The SDK's crypto, except that a transaction signature made inside `sign` runs through the effect gate, its content check first;
// outside `sign` (RPC authentication) every call passes through.
function guardedCrypto(inner, signScope, gate) {
  const sign = (algorithm, message) => {
    const scope = signScope.getStore();
    if (!scope) return inner.sign(algorithm, message);
    const checkContent = () => { try { return checkFinalContent(scope, message); } catch (cause) { throw cause instanceof EmbeddedWalletError ? cause : refuseContent(cause); } };
    return gate.pass({ phase: 'sign', checkContent }, () => inner.sign(algorithm, message));
  };
  return new Proxy(inner, { get(target, key) {
    if (key === 'sign') return sign;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function nodeDemosClass(Demos, { transport, rpcUrl, stamps, attempts, gate, boundary, pinVersion }) {
  const signScope = new AsyncLocalStorage(), guards = new WeakMap();
  return class NodeDemos extends Demos {
    constructor() {
      super();
      this.storagePrograms.read = async () => fail('node_wallet_read_unsupported');
    }

    get crypto() { return guards.get(this) ?? null; }
    set crypto(inner) { guards.set(this, inner && guardedCrypto(inner, signScope, gate)); }

    /** Signs like the SDK, but refuses before the inner signature unless `options.finalContent(content)` accepts the finalized content. */
    sign(transaction, { finalContent, ...sdkOptions } = {}) {
      return signScope.run({ transaction, finalContent }, () => super.sign(transaction, sdkOptions));
    }

    /**
     * Signs like the SDK. Only the session's own RPC authentication passes `raw`; a call without it is a general signing request, which
     * rejects `payload_mismatch` before any signature when the message has the shape of a transaction hash. A general signature is an
     * effect of its own (an identity presentation, a delegation, an Agreement or its anchor authorization): it is made and released
     * through the effect boundary, which records it and refuses without a signature when a stop, a re-hold or a reconnect came first.
     */
    async signMessage(message, options) {
      if (options?.raw === true) return super.signMessage(message, options);
      if (hasTransactionHashShape(message)) {
        throw new EmbeddedWalletError('payload_mismatch', 'a general signing request may not sign a transaction hash; nothing was signed');
      }
      let answer;
      // One lane per signature: Ed25519 signs the same message to the same bytes, and the history keys a record by its lane and bytes.
      const operationId = `wallet-message:${randomUUID()}`;
      const operation = { operationId, lane: operationId, kind: 'signature', paidWrite: false, pinVersion };
      await boundary.signerFor(operation, { sign: async () => { answer = await super.signMessage(message, options); return answer.data; } }).sign(Buffer.from(message));
      return answer;
    }

    async connect(url) {
      if (url !== rpcUrl) fail('transport_mismatch');
      this.rpc_url = url;
    }

    // One call into the transport, never retried. An authenticated request is re-stamped from the
    // strictly increasing source and re-signed, so the SDK's wall-clock stamp never reaches the node.
    async _doPost(url, request, headers) {
      const attempt = { dispatched: false };
      try {
        if (url !== rpcUrl) fail('transport_mismatch');
        const stamped = { ...headers };
        if (stamped.signature) {
          stamped.timestamp = String(stamps.next(stamped.identity));
          // `raw`: demosdk 4.0.18 refuses to sign a bare 64-hex hash without it; 4.0.16 ignores it.
          const authHash = createHash('sha256').update(`${stamped.identity}:${stamped.timestamp}`).digest('hex');
          stamped.signature = (await this.signMessage(authHash, { raw: true })).data;
        }
        return { data: await attempts.run(attempt, () => transport.rpc(request, stamped)) };
      } catch (cause) {
        throw new NodeRpcFailure(cause, attempt.dispatched ? STAGE_DISPATCHED_NO_ACK : STAGE_NOT_DISPATCHED);
      }
    }

    // The SDK's `call` returns a post failure as {result: 500, response: error}; confirm rethrows it.
    async confirm(tx) {
      const answer = await this.call('execute', '', tx, 'confirmTx');
      if (answer?.response instanceof NodeRpcFailure) throw answer.response;
      if (answer?.result !== 200 || typeof answer.response?.data?.valid !== 'boolean') fail(RPC_INVALID);
      if (!answer.response.data.valid) throw new Error('[Confirm] Transaction is not valid');
      return answer;
    }

    // As the SDK: a failed post comes back as the result-500 object carrying the failure.
    async broadcast(validity) {
      if (validity?.response?.data?.valid !== true) throw new Error('[Broadcast] Transaction is not valid');
      const answer = await this.call('execute', '', validity, 'broadcastTx');
      try { return { ...answer, response: JSON.parse(answer.response) }; } catch { return answer; }
    }
  };
}

// The pins come from the admitted binding alone (DN-10), and only for the SDK-held approved record.
function readExpectedPins(binding, owner) {
  const { profile, local, recordDigest } = binding;
  if (recordDigest !== IDENTITY_RECORD_DIGEST || typeof profile?.chainIdentity !== 'string' || typeof profile.pinVersion !== 'string'
    || typeof local?.endpoint !== 'string' || typeof local.transportAuthority !== 'string') fail('admission_required');
  if (typeof owner?.fetchImpl !== 'function') fail('invalid_transport_owner');
  return { network: NODE_WALLET_NETWORK, chainIdentity: profile.chainIdentity, pinVersion: profile.pinVersion, endpoint: local.endpoint, transportAuthority: local.transportAuthority };
}

function decodeMnemonic(keyBytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(keyBytes); } catch (cause) { return fail('invalid_mnemonic', cause); }
}

// Binding reads for the SDK session go to the transport in process; a refusal keeps its code and the original error as `cause`.
function createBindingRelay(transport) {
  return async (body, headers) => {
    try { return new Response(JSON.stringify(await transport.walletBinding(body, headers))); }
    catch (error) { return Object.assign(new Response(JSON.stringify({ error: error.code ?? 'network_binding_unavailable' }), { status: 409 }), { cause: error }); }
  };
}

// P52's construction checks (admission shape, untrusted options, Node floor) run before anything is built or imported.
const checkConstruction = admitPublicFactory(options => ({ options }), { purchase: true });

/**
 * Returns a Promise for `{wallet, walletFactory({anchorJournal}), internalCauseOf(envelope), effectPass(pass), runInEffectPass(handle, work), effectBoundary, transport, close()}`.
 * `effectBoundary` is the client's effect boundary, built here from `stopped` and `feeCeilingOs` and held by the native transport; `transport` is the held facade of
 * `createHeldTransportFacade`.
 * `effectPass` and `runInEffectPass` are the effect gate's host contract (see `createEffectGate`); a buyer may sign and send without a pass. `wallet.request` is wrapped by the admission wrapper and the four
 * passive methods keep their signatures. `walletFactory` is synchronous and returns another view of the same wallet that records anchors in the
 * selected caller-owned journal. `internalCauseOf` returns the error a failed request's envelope was closed over (its `cause` chain holds the original
 * failure, which the public envelope never carries), or undefined. Before the SDK's inner transaction signature the session checks that the signed message
 * is the transaction hash, that the hash is the SHA-256 of the content and that the finalized content is exactly the approved send; otherwise the request
 * fails `payload_mismatch` and nothing is signed. A general `sign` request for a transaction-hash-shaped message (bare or signatureDomain-prefixed
 * SHA-256 hex) also fails `payload_mismatch`, because that signature would be a valid transaction signature. `close()` locks the wallet and closes its transport; the host closes its owner and journal.
 * Options: `{admission, owner, journal, key, approve, clock, stopped, feeCeilingOs}`; `stopped()` is the host's stop check and `feeCeilingOs` its fee ceiling
 * (a positive decimal OS amount), both required with no default; `key` is the UTF-8 mnemonic as a Uint8Array, and it and every copy of it are zero-filled
 * on every outcome. Rejects with TypeError(admission_required | admission_input_untrusted | a missing or malformed `stopped` or `feeCeilingOs`), OperationError(runtime_unsupported | invalid_mnemonic | invalid_params (any `qualify`) |
 * node_wallet_sdk_unreviewed | node_wallet_sdk_preloaded | transport errors), or the SDK session's own refusal.
 */
export function createNodeWalletSession(options = {}) {
  return buildNodeComposition(options, false);
}

/** A Listing CREATE is the seller's own public offer; the confirmed-write policy decides only its other writes. */
function isListingCreate({ content }) {
  const write = content.data?.[1];
  return content.type === 'storageProgram' && write?.operation === 'CREATE_STORAGE_PROGRAM' && write.metadata?.artifactKind === 'Listing';
}

// The transport's confirmed-write callback: a confirmation by another sender, or a Listing CREATE, passes without the policy; every other one calls it once,
// and `false` or a throw refuses `approval_required` (the transport broadcasts nothing then).
function routeConfirmedWrite(approveConfirmedWrite, ownAddress) {
  return async answer => {
    const transaction = answer.response.data.transaction;
    if (transaction.content.from !== ownAddress() || isListingCreate(transaction)) return true;
    try { return await approveConfirmedWrite(answer); }
    catch (cause) { return fail('approval_required', cause); }
  };
}

/**
 * Returns a Promise for `{wallet, walletFactory, transport, observer, paymentEvidenceAdapter, internalCauseOf, effectPass, runInEffectPass, effectBoundary, close}`: the session
 * of `createNodeWalletSession` over a seller transport.
 * `transport` is the registered held facade of `createHeldTransportFacade`; `observer` is `createNodeObserver({owner, clock})` over the same owner, with no fence.
 * `paymentEvidenceAdapter` is `{signCreate, broadcast, readAccountNonce, readTransactionState}`: the first two are active members under the hold and run in the caller's
 * effect pass (`signCreate` signs one payment-evidence storage CREATE on the signer reservation and sends nothing; `broadcast` confirms and dispatches the stored bytes),
 * and the two reads are passive (see `node-payment-evidence-adapter.mjs`).
 * Options are those of `createNodeWalletSession` plus `publications: {settlementPublication, deliveryPublication, demoArtifactPublication}`, the required
 * `approveConfirmedWrite`, a function or an explicit `null` (manual mode, no callback installed), and the optional `qualify({phase, signal})` the effect gate awaits
 * first. A confirmation by another sender, or of a Listing CREATE, is answered `true` without calling the policy; every other seller confirmation calls it once,
 * and `false` or a throw (kept as `cause`) refuses `approval_required`. Every signature and execute transmission needs a current effect pass (`effect_pass_required`).
 * Also requires `stateOwnership` `{directory, held()}`, the host's proof that it holds the state lock for the directory containing `journal`. Before it
 * returns, the composition removes the lock rows of dead holders from `journal` and retires every signer reservation that has no signed bytes. It also requires
 * `paymentEvidenceApproval` `{prepare, open, reopen, confirm, settle}`, the kit's approval ledger for payment-evidence CREATEs; `open` and `settle` serve the
 * signer reservation.
 * Rejects as `createNodeWalletSession` does, with TypeError(approveConfirmedWrite) for any other policy value, OperationError(invalid_params) for a `qualify`
 * that is not a function, the transport's own refusal of the publications, `state_ownership_required` (cause kept when the proof itself failed) without a
 * valid proof, and `invalid_params` when a ledger member is not a function.
 */
export function createNodeSellerComposition(options = {}) {
  return buildNodeComposition(options, true);
}

const localDigestOf = local => createHash('sha256').update(canonicalize(local)).digest('hex');

/**
 * Returns a Promise for the buyer's Node wallet composition: what `createNodeWalletSession` returns plus `binding` (the wire's
 * `Tp1Binding`) and `effectBoundary`. It is built in stages from an unopened `owner`: the authority capability, the production
 * authority reader (see `createAuthorityReader`), `await bindTp1Profile` (its first act is the reader's connection read), the effect
 * boundary over that binding, then the session itself. Nothing effect-capable exists before the last stage. Requires `identityRecord`,
 * `listings`, `purchases`, `participantImplementations`, `stopped`, `feeCeilingOs`, `journal`, `key` and the other options of
 * `createNodeWalletSession` except `admission`, which the composition makes. `stopped` and `feeCeilingOs` are taken at the last stage, after
 * the binding is read, and the session finalizes the boundary from them (see `createNodeWalletSession`). It always zero-fills `key`. Rejects
 * with the failing stage's own error (TypeError for a missing input, the wire's tp1_* refusal with the reader's cause, a transport error, or
 * the session's); a failed stage leaves no composition. The host's `owner` and `journal` stay open.
 */
export async function composeNodeWalletSession({ owner, journal, key, identityRecord, listings, purchases, participantImplementations, ...session } = {}) {
  let walletClaim;
  try {
    const authority = createNodeAuthorityCapability({ owner, claim: () => walletClaim ?? fail('session_not_finalized') });
    const readAuthority = createAuthorityReader({ authority, identityRecord, claim: authority.claim, listings, purchases, participantImplementations });
    const binding = await bindTp1Profile({ record: identityRecord, local: owner.currentLocal(), readAuthority });
    const composition = await createNodeWalletSession({ ...session, owner, journal, key, admission: { binding, currentLocal: owner.currentLocal } });
    try { walletClaim = claimForAddress(composition.wallet.getPublicAccount().address); }
    catch (error) { await composition.close(); throw error; }
    return Object.freeze({ ...composition, binding });
  } finally {
    if (key instanceof Uint8Array) key.fill(0);
  }
}

// What the native transport and the effect history call on the journal.
const JOURNAL_METHODS = ['get', 'put', 'entries', 'withWalletLock', 'appendUnderLock', 'withOwnedOrAcquiredLane'];

// The session's finalization step: the host's stop check and fee ceiling are required (no defaults), and the client's effect boundary is built
// over the admitted binding, the journal and the owner's connection fence. Nothing is opened yet, so a TypeError here leaves nothing to close.
function finalizeEffectBoundary({ owner, journal, admission, stopped, feeCeilingOs }) {
  if (!JOURNAL_METHODS.every(name => typeof journal?.[name] === 'function')) throw new TypeError(`the journal needs ${JOURNAL_METHODS.join(', ')}`);
  if (typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)) throw new TypeError('feeCeilingOs must be a positive decimal OS amount');
  const fence = createEffectFence({ acquire: () => owner.acquireConnectionFence(), currentLocal: () => localDigestOf(owner.currentLocal()) });
  return createEffectBoundary({ binding: admission.binding, currentLocal: owner.currentLocal, stopped, feeCeilingOs, history: createEffectHistory({ journal }), fence });
}

async function buildNodeComposition(options, seller) {
  const key = options?.key;
  let keyCopy, transport, session, sellerAddress, evidenceDemos;
  try {
    const { owner, journal, approve, approveConfirmedWrite, publications, qualify, stateOwnership, paymentEvidenceApproval, stopped, feeCeilingOs, clock = { now: () => Date.now() } } = checkConstruction(options).options;
    const admission = { ...options.admission };
    if (seller && approveConfirmedWrite !== null && typeof approveConfirmedWrite !== 'function') throw new TypeError('approveConfirmedWrite must be a function or an explicit null');
    if (!(key instanceof Uint8Array)) fail('invalid_mnemonic');
    keyCopy = Uint8Array.from(key);
    if (qualify !== undefined && (!seller || typeof qualify !== 'function')) fail('invalid_params');
    if (seller && typeof stateOwnership?.held !== 'function') fail('state_ownership_required');
    if (seller && !PAYMENT_EVIDENCE_APPROVAL_MEMBERS.every(name => typeof paymentEvidenceApproval?.[name] === 'function')) fail('invalid_params');
    const { Demos, validateMnemonic } = await loadNodeDemos();
    const expected = readExpectedPins(admission.binding, owner);
    const effectBoundary = finalizeEffectBoundary({ owner, journal, admission, stopped, feeCeilingOs });
    const attempts = new AsyncLocalStorage(), selectedJournal = new AsyncLocalStorage();
    const gate = createEffectGate({ owner, expectedLocal: admission.binding.local, clock, qualify, passRequired: seller });
    // A confirmTx or broadcastTx body is gated and the real fetch runs synchronously after the gate. A refused body is not dispatched, although
    // this attempt's earlier reads (the nonce check) were; an effect body this attempt already sent stays dispatched.
    const fetchImpl = (input, init) => {
      const attempt = attempts.getStore(), stage = executeStageOf(init?.body);
      const send = () => { if (attempt) attempt.dispatched = true; return owner.fetchImpl(input, init); };
      if (!stage) return send();
      if (attempt) attempt.dispatched = attempt.effectSent === true;
      return gate.pass({ phase: stage, signal: init.signal }, () => { if (attempt) attempt.effectSent = true; return send(); });
    };
    const stamps = createRpcStampSource(clock);
    const transportOptions = { expected, transportOwner: owner, journal, fetchImpl, boundary: effectBoundary, now: () => clock.now(), stamps,
      fallback: { blockZeroUnavailable: 'literal-error', documentation: TP1_APPROVED_IDENTITY_RECORD.provenance.documentation },
      blockZeroErrorEnvelope: DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,
      blockOneLayout: DEVNET_NODE2_BLOCK_LAYOUT, reviewedBlockTwoHash: TP1_REVIEWED_BLOCK_TWO_HASH };
    transport = seller
      ? createDevnetDemoTransport({ ...transportOptions, settlementPublication: publications?.settlementPublication, deliveryPublication: publications?.deliveryPublication,
        demoArtifactPublication: publications?.demoArtifactPublication,
        ...(approveConfirmedWrite === null ? {} : { approveConfirmedWrite: routeConfirmedWrite(approveConfirmedWrite, () => sellerAddress) }) })
      : createDevnetAgreementTransport(transportOptions);
    const transactionTransport = createDevnetAgreementWalletTransport(transport.profile(NODE_WALLET_RELAY_ORIGIN), { relayOrigin: NODE_WALLET_RELAY_ORIGIN });
    const anchorJournal = Object.fromEntries(['get', 'put', 'withWalletLock'].map(name => [name, (...args) => (selectedJournal.getStore() ?? journal)[name](...args)]));
    const NodeDemos = nodeDemosClass(Demos, { transport, rpcUrl: transactionTransport.rpcUrl, stamps, attempts, gate, boundary: effectBoundary, pinVersion: expected.pinVersion });
    session = createSdkWalletSession({ DemosCtor: NodeDemos, approve, transactionTransport,
      validateMnemonic, anchorJournal, relayOrigin: NODE_WALLET_RELAY_ORIGIN, bindingRelay: createBindingRelay(transport), stamp: identity => stamps.next(identity), recordCause });
    const mnemonic = decodeMnemonic(keyCopy);
    await session.importMnemonic(mnemonic);
    // Routing identity outlives signing custody, which passive wallet.lock() clears.
    if (seller) sellerAddress = session.getPublicAccount().address;
    const walletFactory = ({ anchorJournal: selected = journal } = {}) => admitPublicFactory(() => ({
      request: request => selectedJournal.run(selected, () => session.request(request)),
      ...Object.fromEntries(PASSIVE_METHODS.map(name => [name, (...args) => session[name](...args)])),
    }), { passive: PASSIVE_METHODS, purchase: true })({ admission });
    const reservations = seller ? createSignerReservations({ journal, pins: expected, openApproval: requestText => paymentEvidenceApproval.open(requestText),
      settleApproval: (ledgerId, outcome, reason, requestText) => paymentEvidenceApproval.settle({ ledgerId, requestText }, outcome, reason) }) : null;
    await reservations?.recover({ stateOwnership });
    const observer = seller ? createNodeObserver({ owner, clock }) : null;
    // The adapter signs with its own Demos instance over the same phrase, and refuses once the session is locked.
    if (seller) {
      evidenceDemos = new NodeDemos();
      await evidenceDemos.connectWallet(normalizeMnemonic(mnemonic), { algorithm: 'ed25519' });
    }
    const paymentEvidenceAdapter = seller ? createHeldAdapter(admission, createPaymentEvidenceCreateAdapter({ reservations, approval: paymentEvidenceApproval,
      demos: evidenceDemos, observer, journal, pins: expected, clock, rpcUrl: transactionTransport.rpcUrl, isWalletLocked: () => session.isLocked(),
      owner, fetchImpl, stamps, recordCause })) : null;
    const composition = Object.freeze({ wallet: walletFactory(), walletFactory, internalCauseOf, effectPass: gate.effectPass, runInEffectPass: gate.runInEffectPass, effectBoundary,
      transport: createHeldTransportFacade({ admission, transport }), ...(seller ? { observer, paymentEvidenceAdapter } : {}),
      async close() { session.lock(); evidenceDemos?.disconnect(); await transport.close(); } });
    if (seller) sellerReservations.set(composition, reservations);
    return composition;
  } catch (error) {
    try { session?.lock(); evidenceDemos?.disconnect(); await transport?.close(); } catch { /* the construction error is the one to report */ }
    throw error;
  } finally {
    keyCopy?.fill(0);
    if (key instanceof Uint8Array) key.fill(0);
  }
}
