// Explicit source capability, DEFAULT ABSENT. No environment/model option,
// default chain pin, signer, key custody or review approval exists here.
// The caller supplies independently trusted pins, the actual transport owner
// and an existing durable public journal. Tests may supply labelled TEST
// authority; that is not provided live authority or independent validation.
import { isNativeDeliveryEvidence } from '../dacs/delivery-evidence.mjs';
import { classifyStorageWriteSubmission, storageWriteAbsent, storageWriteAccountNonce, storageWriteConfirmationMatches, storageWriteIdentityMatches, rpcEnvelope, STORAGE_WRITE_SUBMISSION_PROFILE } from '../devnet-demo/storage-write-recovery.mjs';
import { storageConfirmationShapeMatches, nativePayloadDigest } from './payload-helpers.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createDemosNetworkBinder } from '../dacs/network-binding.mjs';
import { chainIdentityRead } from './chain-identity-read.mjs';
import { fetchBoundedJson, observeWithDeadline, settleOnAbort } from '../util/http.mjs';
import { verifyDemosSignature } from '../signatures.mjs';
import { canonicalChainIdentity, createEffectHistory, nativeWalletLaneKey } from './effect-history.mjs';
import { assertCurrentAuthorization, currentPassContext, insideEffectPass, runInPassContext } from './pass-context.mjs';
import { classifyDispatchHistory, nothingSent } from './native-dispatch-history.mjs';
import { signerReservationKey } from './signer-reservation.mjs';
import { authorityLabel } from '../dacs/tp1-authority-token.mjs';
import { createDemosChainReader, nonceFromNode, nodeProjectedNonce } from '../dacs/chain.mjs';
import { demosTransactionContentMatches } from '@kynesyslabs/dacs';
import { observePayDemTransferCore } from '@kynesyslabs/dacs/seller';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, isCompositeVerificationRecord, isFinalityCommitmentRecord, isListing, isSettlementEvidence, paymentEvidenceAddress, signedBytes } from '@kynesyslabs/dacs';

export const DEVNET_NATIVE_RPC_PATH = '/portal/api/devnet-native-wallet-rpc';
export const DEVNET_NATIVE_BINDING_PATH = '/portal/api/devnet-native-wallet-binding';
export const DEVNET_NATIVE_PROFILE = 'devnet-native';
// Separate from the protected binder fallback policy: this exact token records
// the run-reviewed Node2 RPC representation which the transport may unwrap.
export const DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE = 'node2-result-400-error-require-reply-false-block-number-not-provided/v1';
export const DEVNET_NODE2_BLOCK_LAYOUT = 'node2-number-id-plus-one-empty-extra/v1';
// Reviewed hash of TP-1 block two. Its predecessor is the recorded block one;
// this pin is never learned from a live read.
export const TP1_REVIEWED_BLOCK_TWO_HASH = 'ee41ad17448a9723b1040b41a4d375ab9071f5a9bcdd363bc22dba150faf1bd5';
const NODE2_CONTENT_FIELDS = ['ordered_transactions','encrypted_transactions_hashes','per_address_transactions','web2data','previousHash','timestamp','peerlist','l2ps_partecipating_nodes','l2ps_banned_nodes','native_tables_hashes'];
function reviewedNode2Block(answer) {
  const block = answer?.response, content = block?.content;
  return rpcEnvelope(answer,200,'') && storageWriteIdentityMatches(block)
    && content !== null && typeof content === 'object' && !Array.isArray(content)
    && Object.keys(content).length === NODE2_CONTENT_FIELDS.length && NODE2_CONTENT_FIELDS.every(key=>Object.hasOwn(content,key)) ? block : null;
}
const capabilities = new WeakSet();
const agreementCapabilities = new WeakSet();
const settlementCapabilities = new WeakSet();
const deliveryCapabilities = new WeakSet();
const demoCapabilities = new WeakSet();
export const DEVNET_AGREEMENT_PROFILE = 'devnet-agreement';
export const DEVNET_AGREEMENT_KIND = 'devnet-agreement-storage-create';
export const DEVNET_SETTLEMENT_KIND = 'devnet-settlement-evidence-storage-create';
export const DEVNET_SETTLEMENT_POLICY = 'dacs-native-settlement-publication/v1';
export const DEVNET_DELIVERY_KIND = 'devnet-deliverable-storage-create';
export const DEVNET_DELIVERY_POLICY = 'dacs-native-delivery-publication/v1';
export const DEVNET_DEMO_ARTIFACT_KIND = 'devnet-demo-artifact-storage-create';
export const DEVNET_DEMO_ARTIFACT_POLICY = 'dacs-devnet-demo-artifacts/v1';
export const DEVNET_DEMO_ARTIFACT_TYPES = Object.freeze(['CompositeVerificationRecord', 'Deliverable', 'FinalityCommitmentRecord', 'Listing']);
export const DEVNET_AGREEMENT_SOURCE = 'devnet-agreement-transport/v1';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const ADDRESS = /^0x[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const CONTEXT = ['network', 'endpoint', 'transportAuthority', 'connectionId'];
const sameContext = (a,b) => CONTEXT.every((k) => a?.[k] === b?.[k]);
// A lane or intent record the broadcast finished at its last check, before anything was sent: it holds no lane and
// its bytes may be confirmed and broadcast again.
const withheldBroadcast = (record) => record?.stage === 'failed' && record.failure?.withheld === true;
// RPC auth headers are fresh and single-use. Wallets stamp them with their own
// clock in ms and sign a new set for every request (the embedded wallet for
// bind and signature, the SDK for confirmTx and broadcastTx), so a set more
// than AUTH_WINDOW_MS from now() either way, or one already used, is refused.
// The window covers the SDK's own same-header transport retries (at most four,
// backoff capped at 8 s) and up to a minute and a half of wallet clock skew.
// Used sets are remembered per identity until they are stale. Past
// AUTH_PER_IDENTITY an identity forgets its own oldest, and nothing it stamped
// at or before that is accepted again; no other identity is affected. All
// identities share AUTH_MEMORY entries; when that is full, the identity holding
// the most forgets its oldest, and if none holds more than one, a new set is
// refused (wallet_auth_busy) until entries go stale. The operator's own wallets
// (reserveRpcAuth) keep their memory outside that shared pool.
const AUTH_WINDOW_MS = 120000, AUTH_PER_IDENTITY = 256, AUTH_MEMORY = 4096, AUTH_RESERVED = 4;
// Refused transfers kept per payer lane (refusedKey).
const REFUSALS_KEPT = 64;
// One passive observation's deadline (observePassiveTransfer): its lock wait,
// connection fence, binding reads and status, body and block reads.
const PASSIVE_TRANSFER_TIMEOUT_MS = 10_000;
// The largest reply any source read admits, identity blocks included. A caller's
// `maxBytes` (readRpc) can only lower it. The binder accepts a read up to a minute old.
const SOURCE_READ_MAX_BYTES = 4 * 1024 * 1024;
const IDENTITY_MAX_AGE_MS = 60000;
// What a transaction signature covers once the node's signatureDomain fork is active: this prefix, the node's chain id and the hash.
const SIGNATURE_DOMAIN_PREFIX = 'demos-tx:v1:';
// An answer that the fork is not active is reused for this long; an active fork never goes back.
const INACTIVE_SIGNATURE_DOMAIN_REUSE_MS = 60000;
// The longest failure code or message from the node that a failed storage
// write's result repeats; a longer one is left out as unknown.
const NODE_FAILURE_TEXT_MAX_LENGTH = 512;
// Characters a repeated failure code or message must not hold: control and
// formatting characters (line breaks, terminal escapes, direction overrides),
// and line and paragraph separators. Text with one is left out.
const NODE_FAILURE_TEXT_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// A refused header set is the wallet's to fix, usually its clock. Relays answer
// these codes with 409 (never a status the SDK resends) and this message only.
const AUTH_REFUSALS = Object.freeze({
  wallet_auth_stale:'the wallet\'s RPC auth timestamp is more than 2 minutes from the operator\'s clock, or older than headers this wallet already used; check this device\'s clock and try again. Nothing was read, signed or sent.',
  wallet_auth_replayed:'these RPC auth headers were already used; the wallet signs new ones for every request. Nothing was read, signed or sent.',
  wallet_auth_busy:'the operator is remembering too many recent wallet requests; try again in a few minutes. Nothing was read, signed or sent.',
});
export const rpcAuthRefusal = (error) => Object.hasOwn(AUTH_REFUSALS,error?.code ?? '')
  ? [409,{ error:error.code,message:AUTH_REFUSALS[error.code],result:409,response:AUTH_REFUSALS[error.code],require_reply:false,extra:null }] : null;
// A transfer with a cancelled payment's terms is refused before the node sees
// it (the signature lease, confirmTx, the wallet's pre-broadcast request or the
// broadcast claim), and so are a transfer other than the one its lease named
// and one whose settlement terms the source cannot read (confirmTx); the
// broadcast of a confirmation whose node fee view is not the signed fees is
// refused before it is sent. Each such attempt was not sent, so relays say so
// with 409, never the 500 that reads as an unknown outcome. The cancelled
// payment may be another purchase's with the same terms, so the refusal names
// the terms, not the purchase.
const PAYMENT_CANCELLED = 'this transfer has the terms of a cancelled payment; the operator\'s source refuses it, so this attempt was not sent (an earlier attempt may have been; readback shows it)';
const TRANSFER_REFUSALS = Object.freeze({
  payment_cancelled: PAYMENT_CANCELLED,
  transfer_mismatch: 'this transaction is not the transfer its signature lease named; the operator\'s source refuses it, so this attempt was not sent',
  transfer_unreadable: 'the operator\'s source cannot read one payer, payee and amount in this transfer, paid by its signer; it refuses it, so this attempt was not sent',
  fee_view_mismatch: 'the node confirmed this transaction with fees other than the fees it was signed with; the operator\'s source refuses it, so this attempt was not sent',
});
export const transferRefusal = (error) => Object.hasOwn(TRANSFER_REFUSALS,error?.code ?? '')
  ? [409,{ error:error.code,message:TRANSFER_REFUSALS[error.code],result:409,response:TRANSFER_REFUSALS[error.code],require_reply:false,extra:null }] : null;
const clone = (v) => structuredClone(v);
const isTestLabel = (value) => typeof value === 'string' && value.startsWith('TEST-');
const isTestRunLabel = (value) => typeof value === 'string' && /^TEST-RUN-[A-Za-z0-9._-]{8,80}$/.test(value);
// A publication policy as the transport declares it: a frozen copy whose authority is its label. A token counts only for `binding`.
const declaredPolicy = (policy, binding, isFixtureLabel, requirement) => Object.freeze(clone({ ...policy, authority: authorityLabel(policy.authority, binding, isFixtureLabel, requirement) }));
// What the transport calls on the effect boundary (the required `boundary` option of the transport constructors).
const BOUNDARY_METHODS = ['holdFence', 'withOperation', 'signPass', 'dispatchPass', 'signAuthentication'];
// The lease's expiry timer fires this long after the lease expires, so a timer that fires early still finds it expired.
const LEASE_EXPIRY_MARGIN_MS = 1;
// The fee members of a confirmation's gas operation, each a canonical decimal OS string.
const FEE_MEMBERS = ['network_fee', 'rpc_fee', 'additional_fee'];
// The only own keys of a wallet nonce lane's scope.
const NONCE_LANE_SCOPE_KEYS = ['owner', 'network', 'chainIdentity'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const ONLY_ORIGINAL_SENDS = 'only the original signed native DEM send or explicitly admitted immutable CREATE is relayed';
const envelope = (response, result = 200) => ({ result, response, require_reply: false, extra: null });
// A node's reply without any top-level `writeProof`. Only this transport may add
// one, after it has read the inclusion itself; a reply of any other shape is
// returned unchanged.
const withoutNodeWriteProof = (answer) => {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer) || !Object.hasOwn(answer, 'writeProof')) return answer;
  const withoutProof = { ...answer };
  delete withoutProof.writeProof;
  return withoutProof;
};

export const isDevnetNativeTransport = (v) => Boolean(v && capabilities.has(v));
export const isDevnetAgreementTransport = (v) => Boolean(v && (agreementCapabilities.has(v) || settlementCapabilities.has(v) || deliveryCapabilities.has(v) || demoCapabilities.has(v)));
export const isDevnetSettlementTransport = (v) => Boolean(v && (settlementCapabilities.has(v) || deliveryCapabilities.has(v) || demoCapabilities.has(v)));
export const isDevnetDeliveryTransport = (v) => Boolean(v && (deliveryCapabilities.has(v) || demoCapabilities.has(v)));
export const isDevnetDemoTransport = (v) => Boolean(v && demoCapabilities.has(v));

/** Registers `facade` in the capability set that holds `inner`, so the is* checks accept it; throws TypeError unless `inner` is registered. Not in the package `exports` map. */
export function registerHeldTransportFacade(facade, inner) {
  const set = [capabilities, agreementCapabilities, settlementCapabilities, deliveryCapabilities, demoCapabilities].find(candidate => candidate.has(inner));
  if (!set) throw new TypeError('a registered inner transport is required');
  set.add(facade);
}

/** nativeWalletLaneKey(pins, address) returns the journal key of the native write lane every native write of `address` takes (effect-history.mjs). */
export { nativeWalletLaneKey };

// transportOwner owns the ACTUAL endpoint/connection. acquireConnectionFence()
// returns { context, release() }, holding that connection until release; its
// { address } argument names the wallet the fence is for, if any. The
// consumer retains it across browser-local signature, SDK confirm and one
// broadcast. Copying expected values into getContext is not authority; the
// independently trusted caller must bind these methods to its actual egress.
//
// The required `boundary` option is the client's effect boundary (effect-boundary.mjs),
// built over the same journal and over a fence that acquires the owner's. A missing or
// malformed one is a TypeError. The signature lease holds the boundary's fence from the
// lease to the broadcast, and each confirmation is retained as its own stage in the
// dispatch history (the exact signed bytes, `confirm-started`, then
// `confirm-acknowledged` or `confirm-unknown`) before and after the node sees it. An
// acknowledged confirmation is final for its bytes: the node is not asked to confirm them again.
// While nothing may have sent the bytes, a new lease for them continues their operation and is
// answered from that retained confirmation; after a possible send they are read back only.
// The seller policy, if any, is asked after the acknowledgement is retained; its refusal
// leaves the acknowledgement and nothing is broadcast.
// The broadcast then carries that retained confirmation, byte for byte with its gas, as the
// boundary's dispatch stage: its whole debit (the amount plus every fee, from the node's fee
// view or else from the confirmed transaction) is checked against the fee ceiling first, and a
// refusal leaves `dispatch-withheld`. A refusal at the last check, after the lane record is written and
// before the request, finishes the lane as `failed` (withheld): nothing was sent, and a new lease may confirm
// and broadcast the same bytes. CREATE recovery holds the boundary's fence for the
// artifact's own operation and runs its confirmation and sole resend as the
// `recovery-confirm` and `recovery-dispatch` stages. Every effectful request is made by
// `transmit`, which finishes all its awaits (the transport context included) first and then
// calls the boundary's final check and `fetchImpl` in one synchronous run; the check includes
// the pass's current-authorization check from the private context in `pass-context.mjs`,
// which also names the job's operation id.
//
// The optional `reopenGrants` option is `{ consume(capability) }` over the trusted composition's registry of one-use
// capabilities (withheld-reopen-grants.mjs). With it the transport has `reopenWithheldBroadcast({ capability, signRpc })`, the
// one explicit send of a broadcast whose whole dispatch history shows it never reached the node (a withheld pass,
// not an acknowledged, unknown or unpaired one): the lease, the retained confirmation (or a new one) and the broadcast of the
// retained bytes, under the retained operation's id. Every other issued native hash stays readback-only.
//
// A demo transport also has `withWalletNonceLock({owner, network, chainIdentity}, work)`, the wallet nonce lane: it runs `work`
// holding the lock row of `nativeWalletLaneKey(pins, owner)` in this journal, the row every native write of that wallet takes,
// a buyer's included. Inside it, this transport's readback, CREATE recovery and broadcast claim for that wallet continue in the
// held lane; a lease that names a transfer, a transfer's confirmation claim and a cancellation still refuse journal-reentrant.
// It is taken before the connection fence, so it is refused inside an effect pass (nonce_lane_order), and a fence holder that
// then needs the lane waits at most the journal's lock timeout. Every Agreement transport also has
// `inspectWalletNonceLane({owner, network, chainIdentity})`, which reads that lane's retained stage under the same lock and the
// same refusals, and takes no work; the held facade does not carry it.
export function createDevnetNativeTransport(options) { return constructTransport(options,false); }
export function createDevnetAgreementTransport(options) { return constructTransport(options,true); }
// Separate opt-in composition. The Agreement-only constructor above remains
// incapable of publishing SettlementEvidence. This TEST/operator capability
// declares one exact SDK pay-dem publication policy in signed terms/metadata.
export function createDevnetSettlementTransport(options) { return constructTransport(options,true,true); }
// Narrowest source profile that additionally admits the already prepared SDK
// storage-program deliverable. Its policy is explicit and absent by default.
export function createDevnetDeliveryTransport(options) { return constructTransport(options,true,true,true); }
export function createDevnetDemoTransport(options) { return constructTransport(options,true,true,true,true); }
// The identity block reader behind every binder: the transport's, in normal and strict recovery
// modes, the observer's and the production authority reader's. Each dependency is a parameter and
// strictEnvelope has no default.
export function sourceBlockReader({ chainIdentity, reviewedReads, fallback, blockZeroErrorEnvelope, blockOneLayout, reviewedBlockTwoHash, strictEnvelope, signal, context, post, now }) {
  if (typeof strictEnvelope !== 'boolean') throw new TypeError('the identity reader requires an explicit strictEnvelope');
  return {
    getContext: context,
    getChainIdentity: chainIdentityRead({ context, post, signal, now }),
    async getBlockByNumber(height, policy) {
      if (policy.cache !== 'no-store' || policy.redirect !== 'error') fail('invalid_policy','fresh bounded identity observation is required');
      signal?.throwIfAborted();
      const c = await context();
      const answer = await post({ method:'nodeCall', params:[{ message:'getBlockByNumber', data:{ blockNumber:height } }] }, {}, { signal });
      // The binder owns the reviewed block-one predecessor policy and accepts
      // only its literal `error` marker. Legacy admissions retain their exact
      // two-field representation. A separately recorded/reviewed envelope
      // token admits only Node2's observed four-field representation; it does
      // not make the two shapes interchangeable. Normalize no other height,
      // status, response shape, transport failure or malformed answer. A
      // non-null fallback reached here has already been synchronously schema-
      // checked and snapshotted by createDemosNetworkBinder above.
      const plain = answer !== null && typeof answer === 'object' && !Array.isArray(answer);
      const legacyTwoField = plain && Object.keys(answer).length === 2 && Object.hasOwn(answer,'result') && Object.hasOwn(answer,'response')
        && answer.result === 400 && answer.response === 'error';
      const observedFourField = rpcEnvelope(answer,400,'Block number not provided') && answer.response === 'error';
      const reviewedShape = blockZeroErrorEnvelope === null ? legacyTwoField
        : blockZeroErrorEnvelope === DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE && observedFourField;
      if (height === 0 && blockZeroErrorEnvelope !== null && (answer === 'error' || answer?.response === 'error') && !reviewedShape) fail('malformed_observation','the reviewed Node2 block-zero error envelope differs');
      const node2LiteralBlockZeroError = height === 0 && fallback !== null && reviewedShape;
      if(strictEnvelope && !rpcEnvelope(answer,200,'') && !(node2LiteralBlockZeroError && observedFourField)) fail('malformed_observation','storage recovery requires an exact identity RPC envelope');
      // String zero is the two-field genesis projection, which the binder validates field by field;
      // every numeric height keeps the full block schema.
      if(strictEnvelope && height !== '0' && !node2LiteralBlockZeroError && !storageWriteIdentityMatches(answer.response)) fail('malformed_observation','storage recovery requires an exact identity block shape');
      let value = node2LiteralBlockZeroError ? 'error' : answer;
      if (height === 1 && blockOneLayout === DEVNET_NODE2_BLOCK_LAYOUT) {
        const first = reviewedNode2Block(answer);
        const firstIdentity = first?.content?.previousHash;
        if (first?.number !== 1 || first?.id !== 2 || first?.status !== 'confirmed' || !HASH.test(first?.hash ?? '') || !HASH.test(firstIdentity ?? '') || first.hash === firstIdentity
          || (Object.hasOwn(first,'previousHash') && first.previousHash !== firstIdentity)
          || ['chainIdentity','genesisHash'].some((key)=>Object.hasOwn(first,key)&&first[key]!==firstIdentity)) fail('malformed_observation','the reviewed Node2 block-one layout differs');
        signal?.throwIfAborted();
        const secondAnswer = await post({ method:'nodeCall', params:[{ message:'getBlockByNumber', data:{ blockNumber:2 } }] }, {}, { signal });
        if(strictEnvelope && !storageWriteIdentityMatches(secondAnswer?.response)) fail('malformed_observation','storage recovery requires an exact identity block shape');
        const second = reviewedNode2Block(secondAnswer);
        const secondPrevious = second?.content?.previousHash;
        if (second?.number !== 2 || second?.id !== 3 || second?.status !== 'confirmed' || !HASH.test(second?.hash ?? '') || second.hash === first.hash || secondPrevious !== first.hash
          || (Object.hasOwn(second,'previousHash') && second.previousHash !== first.hash)
          || ['chainIdentity','genesisHash'].some((key)=>Object.hasOwn(second,key)&&second[key]!==firstIdentity)) fail('malformed_observation','the reviewed Node2 block-two continuation differs');
        if (second.hash !== reviewedBlockTwoHash) fail('identity_mismatch','the fresh Node2 block-two hash differs from exact admission review');
        if (firstIdentity !== chainIdentity) fail('identity_mismatch','the fresh Node2 block-one predecessor differs from the pinned chain identity');
        const reads = canonicalize([first,second]);
        if (reviewedReads.value !== undefined && reads !== reviewedReads.value) fail('identity_mismatch','the reviewed Node2 blocks changed between identity reads');
        reviewedReads.value = reads;
        const { id:_databaseId, ...binderBlock } = first;
        value = { ...answer, response:binderBlock };
      }
      return { value, context:c, observedAt:now(), fromCache:false, redirected:false };
    },
  };
}
/**
 * Returns the fence-free, read-only identity observer for the SDK-approved `record` over an
 * unopened transport `owner`: `bind({signal})` resolves a fresh network binding and
 * `post(body, headers, {signal})` one bounded node reply (4 MiB before decoding, `timeoutMs`
 * per read). Neither takes a connection fence or a journal lock, and neither signs. Both reject
 * with the reader's or fetch's own error, or the caller's abort reason. Throws TypeError for an
 * owner without currentLocal, getContext and fetchImpl, or a `timeoutMs` that is not a positive integer.
 * The pin names its genesis representation: the literal-error fallback taken from `record`, or, with
 * `stabilisedGenesis` (see `createDemosNetworkBinder`), the stabilised one in its place.
 */
export function createSourceObserver({ record, owner, stabilisedGenesis = null, blockZeroErrorEnvelope = null, blockOneLayout = null, reviewedBlockTwoHash = null, now = () => Date.now(), timeoutMs }) {
  if (typeof owner?.currentLocal !== 'function' || typeof owner.getContext !== 'function' || typeof owner.fetchImpl !== 'function') throw new TypeError('an unopened transport owner is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('the observer read deadline must be a positive integer of milliseconds');
  const { endpoint, transportAuthority } = owner.currentLocal();
  const expected = { network:record.network, chainIdentity:canonicalChainIdentity(record.chainIdentity), pinVersion:record.pinVersion, endpoint, transportAuthority };
  const fallback = stabilisedGenesis === null ? { blockZeroUnavailable:'literal-error', documentation:record.provenance.documentation } : null;
  const post = (body, headers = {}, { signal } = {}) => fetchBoundedJson(endpoint, { method:'POST', body, headers, fetchImpl:(...args) => owner.fetchImpl(...args),
    timeoutMs, signal, maxBytes:SOURCE_READ_MAX_BYTES, expectedOrigin:new URL(endpoint).origin });
  const reviewedReads = {};
  const bind = ({ signal } = {}) => createDemosNetworkBinder({ expected, fallback, stabilisedGenesis, now, timeoutMs, maxAgeMs:IDENTITY_MAX_AGE_MS,
    reader:sourceBlockReader({ chainIdentity:expected.chainIdentity, reviewedReads, fallback, blockZeroErrorEnvelope, blockOneLayout, reviewedBlockTwoHash, strictEnvelope:false, signal, context:async () => owner.getContext(), post, now }) }).bind();
  return Object.freeze({ bind, post });
}
function constructTransport({ expected, transportOwner, journal, fallback = null, stabilisedGenesis = null, blockZeroErrorEnvelope = null, blockOneLayout = null, reviewedBlockTwoHash = null,
  fetchImpl = globalThis.fetch, now = () => Date.now(), stamps = { next: () => now() }, monotonicNow = () => performance.now(), timeoutMs = 10000,
  leaseMs = 30000, inclusionWaitMs = 120000, inclusionPollMs = 500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  settlementPublication = null, deliveryPublication = null, demoArtifactPublication = null, authorityBinding, approveConfirmedWrite = null, boundary, reopenGrants = null } = {}, agreement = false, settlement = false, delivery = false, demo = false) {
  if (!BOUNDARY_METHODS.every((name) => typeof boundary?.[name] === 'function')) throw new TypeError(`the effect boundary needs ${BOUNDARY_METHODS.join(', ')}`);
  if (reopenGrants !== null && typeof reopenGrants?.consume !== 'function') throw new TypeError('reopenGrants is null or an object with a consume function');
  if (!transportOwner || typeof transportOwner.getContext !== 'function' || typeof transportOwner.acquireConnectionFence !== 'function') throw new TypeError('actual transport-owner context and connection fencing are required');
  if (!journal || !['get','put','entries','withWalletLock'].every((k) => typeof journal[k] === 'function')) throw new TypeError('an explicit durable public native-transfer journal is required');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000) throw new TypeError('native connection lease must be bounded from1000 to60000ms');
  if (!Number.isSafeInteger(inclusionWaitMs) || inclusionWaitMs < 0 || inclusionWaitMs > 300000 || !Number.isSafeInteger(inclusionPollMs) || inclusionPollMs < 1 || typeof sleep !== 'function') throw new TypeError('the accepted-broadcast inclusion wait must be bounded from0 to300000ms');
  const leases = new Map();
  const byAddress = new Map();
  const inFlight = new Set();
  const stepListeners = new Set(), resendListeners = new Set(), writeProofs = new Map();
  const step = (tx, name, phase, started) => {
    const op=tx?.content?.data?.[1], fields={timestampMs:now(),step:name,phase,hash:tx.hash,writer:tx.content.from,nonce:tx.content.nonce,jobId:op?.data?.jobId ?? op?.metadata?.artifactBinding?.jobId ?? null,artifactKind:op?.metadata?.artifactKind ?? 'native-transfer'};
    if(started!==undefined) fields.durationMs=Math.max(0,monotonicNow()-started);
    for(const listener of stepListeners) { try { listener(fields); } catch { /* telemetry cannot authorize or interrupt a write */ } }
  };
  let closed = false;
  // close() aborts the cancellable reads it drains (observePassiveTransfer).
  const closing = new AbortController();
  // The protected binder validates the exact source-supplied HTTPS pin schema.
  // There is no observed-node pin admission or default fallback here.
  // The chain identity is canonicalised here once; every key, binding and comparison below uses this form.
  const pinned = expected ? Object.freeze({ ...expected, chainIdentity:canonicalChainIdentity(expected.chainIdentity) }) : expected;
  if (blockZeroErrorEnvelope !== null && blockZeroErrorEnvelope !== DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE) throw new TypeError('the native block-zero error envelope policy is unsupported');
  if (blockZeroErrorEnvelope !== null && fallback === null) throw new TypeError('the native block-zero error envelope requires an explicit binder fallback');
  if (blockOneLayout !== null && blockOneLayout !== DEVNET_NODE2_BLOCK_LAYOUT) throw new TypeError('the native block-one layout policy is unsupported');
  if (blockOneLayout !== null && (fallback === null || blockZeroErrorEnvelope !== DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE)) throw new TypeError('the native block-one layout requires the exact observed block-zero fallback');
  if (reviewedBlockTwoHash !== null && !HASH.test(reviewedBlockTwoHash)) throw new TypeError('the reviewed native block-two hash must be canonical');
  if (blockOneLayout === DEVNET_NODE2_BLOCK_LAYOUT && reviewedBlockTwoHash === null) throw new TypeError('the native block-one layout requires the exact reviewed block-two hash');
  if (reviewedBlockTwoHash !== null && blockOneLayout !== DEVNET_NODE2_BLOCK_LAYOUT) throw new TypeError('the reviewed block-two hash requires the exact native block-one layout');
  if(agreement && new URL(pinned?.endpoint ?? 'https://held.invalid').pathname !== '/') throw new TypeError('the explicit Agreement source supports the SDK root RPC contract only');
  if (settlement && (!settlementPublication || JSON.stringify(Object.keys(settlementPublication).sort()) !== JSON.stringify(['artifactKind','authority','phase','phaseIndex','policy','railId'])
    || settlementPublication.policy !== DEVNET_SETTLEMENT_POLICY || settlementPublication.artifactKind !== 'SettlementEvidence'
    || settlementPublication.phase !== 'pay-dem' || settlementPublication.railId !== 'demos-native:DEM' || settlementPublication.phaseIndex !== 2)) throw new TypeError('an exact explicit SettlementEvidence publication policy is required');
  if (!settlement && settlementPublication !== null) throw new TypeError('SettlementEvidence policy requires the separate settlement transport constructor');
  const publication = settlement ? declaredPolicy(settlementPublication, authorityBinding, isTestLabel, 'a TEST or token authority is required for the SettlementEvidence publication policy') : null;
  if (delivery && (!deliveryPublication || JSON.stringify(Object.keys(deliveryPublication).sort()) !== JSON.stringify(['artifactKind','authority','phase','phaseIndex','policy'])
    || deliveryPublication.policy !== DEVNET_DELIVERY_POLICY || deliveryPublication.artifactKind !== 'Deliverable'
    || deliveryPublication.phase !== 'deliver-storage-program' || !Number.isSafeInteger(deliveryPublication.phaseIndex) || deliveryPublication.phaseIndex < 0)) throw new TypeError('an exact explicit Deliverable publication policy is required');
  if (!delivery && deliveryPublication !== null) throw new TypeError('Deliverable policy requires the separate delivery transport constructor');
  const deliveryDeclaration = delivery ? declaredPolicy(deliveryPublication, authorityBinding, isTestLabel, 'a TEST or token authority is required for the Deliverable publication policy') : null;
  if (demo && (!demoArtifactPublication || JSON.stringify(Object.keys(demoArtifactPublication).sort()) !== JSON.stringify(['artifactKinds','authority','policy'])
    || demoArtifactPublication.policy !== DEVNET_DEMO_ARTIFACT_POLICY
    || ![DEVNET_DEMO_ARTIFACT_TYPES,[...DEVNET_DEMO_ARTIFACT_TYPES,'SettlementEvidence']].some(kinds=>canonicalize(demoArtifactPublication.artifactKinds)===canonicalize(kinds)))) throw new TypeError('an exact demo artifact publication policy is required');
  if (!demo && demoArtifactPublication !== null) throw new TypeError('demo artifact policy requires the separate demo transport constructor');
  const demoDeclaration = demo ? declaredPolicy(demoArtifactPublication, authorityBinding, isTestRunLabel, 'a run-scoped TEST or token authority is required for the demo artifact publication policy') : null;
  // Keep the binder's established identity unchanged: the separate signed
  // publication declaration narrows what this capability may relay, but does
  // not invent a different observed network.
  const declaration = agreement ? Object.freeze({ source:DEVNET_AGREEMENT_SOURCE,bindingVersion:'dacs-demos-network-binding/v1',bindingId:sha(JSON.stringify(['dacs-demos-network-binding/v1',...['network','chainIdentity','pinVersion','endpoint','transportAuthority'].map(k=>pinned?.[k])])),...pinned,...(publication?{settlementPublication:publication}:{}),...(deliveryDeclaration?{deliveryPublication:deliveryDeclaration}:{}),...(demoDeclaration?{demoArtifactPublication:demoDeclaration}:{}) }) : null;
  const context = async () => {
    if (closed) fail('transport_closed', 'the native transport is closed');
    const c = await transportOwner.getContext();
    if (c?.network !== pinned?.network || c?.endpoint !== pinned?.endpoint || c?.transportAuthority !== pinned?.transportAuthority) fail('transport_mismatch', 'actual egress differs from the supplied trusted binding');
    return c;
  };
  const post = (body, headers, signal) => fetchBoundedJson(pinned.endpoint, { method:'POST', body, headers, fetchImpl,
    timeoutMs, signal, maxBytes:SOURCE_READ_MAX_BYTES, expectedOrigin:new URL(pinned.endpoint).origin });
  // A read: no effect boundary check, nothing it sends changes state.
  const raw = async (body, headers = {}, { signal } = {}) => {
    signal?.throwIfAborted();
    await context();
    return post(body, headers, signal);
  };
  // The one request of an effectful call (confirmation, broadcast, recovery's confirmation and resend).
  // Every await, the transport context included, finishes first. Then `final` (the effect boundary's last
  // check) runs its stop await, its synchronous checks and the pass's current-authorization check, and
  // calls the request in the same synchronous run, so no await separates the checks from `fetchImpl`.
  const transmit = async (body, headers, { final, pass }) => {
    await context();
    return final(() => assertCurrentAuthorization(pass), () => post(body, headers));
  };
  // The node's reply as `rpc` hands it to a wallet: never with a node-supplied `writeProof`.
  const rawWithoutWriteProof = async (body, headers) => withoutNodeWriteProof(await raw(body, headers));
  const transmitWithoutWriteProof = async (body, headers, send) => withoutNodeWriteProof(await transmit(body, headers, send));
  // The pinned observer reads transaction and block facts concurrently.
  // Serialize their actual connection fences; this creates no write permit.
  // The work runs under the journal lock and the connection fence. An abort rejects the caller
  // at once, even while it still waits for either; the locked work then starts no request, and
  // a request in flight is abandoned at the abort, so both are released then. close() still
  // waits for the locked work, which is the tracked promise.
  const sourceRead = (signal, work) => {
    const locked = tracked(() => journal.withWalletLock('devnet/source-read/'+declaration?.bindingId,()=>{
      signal?.throwIfAborted();
      return fenced(async()=>{ signal?.throwIfAborted(); return work(); });
    }));
    return signal ? settleOnAbort(locked, signal) : locked;
  };
  const observe = async (path,body,{signal,maxBytes=SOURCE_READ_MAX_BYTES}={}) => {
    if(!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>SOURCE_READ_MAX_BYTES) fail('invalid_params','a read byte limit is an integer from 1 to 4 MiB');
    return sourceRead(signal,async()=>{
      await makeBinder(false,signal).bind();
      if(path !== '/' && !/^\/storage-program\/stor-[0-9a-f]{40}$/.test(path)) fail('readonly_only','only bounded native storage reads are supported');
      if(body !== undefined && (path !== '/' || body?.method !== 'nodeCall' || !['getBlockByNumber','getTxByHash','getTransactionStatus','getAddressNonce','getAddressInfo','getTransactionHistory','searchStoragePrograms','getNetworkInfo','getNetworkParameters'].includes(body?.params?.[0]?.message))) fail('readonly_only','only source-bound preparation/inclusion reads are supported');
      return fetchBoundedJson(path==='/'?pinned.endpoint:`${new URL(pinned.endpoint).origin}${path}`,{method:body===undefined?'GET':'POST',body,fetchImpl,timeoutMs,signal,maxBytes,expectedOrigin:new URL(pinned.endpoint).origin});
    });
  };
  const node = async (message, data, options) => {
    const answer = await raw({ method:'nodeCall', params:[{ message, data }] }, {}, options);
    if (answer?.result !== 200) fail('upstream_unavailable', 'the pinned node did not return a usable observation');
    return answer.response;
  };
  const reviewedReads = {};
  const makeBinder = (strictEnvelope=false, signal, bindTimeoutMs=timeoutMs) => createDemosNetworkBinder({ expected:pinned, fallback, stabilisedGenesis, now, timeoutMs:bindTimeoutMs, maxAgeMs:IDENTITY_MAX_AGE_MS, exclusive:true,
    reader:sourceBlockReader({ chainIdentity:pinned.chainIdentity, reviewedReads, fallback, blockZeroErrorEnvelope, blockOneLayout, reviewedBlockTwoHash, strictEnvelope, signal, context, post:raw, now }) });
  const binder = makeBinder(),storageRecoveryBinder = makeBinder(true);
  const lane = (address) => nativeWalletLaneKey(pinned, address);
  // The wallet's lane for a readback, a CREATE recovery or a broadcast claim: continued when this context already holds it (a caller's nonce lane), else acquired.
  const laneLock = (address, work) => (typeof journal.withOwnedOrAcquiredLane === 'function'
    ? journal.withOwnedOrAcquiredLane(lane(address), work) : journal.withWalletLock(lane(address), work));
  /**
   * Runs `work` holding the native lane of `scope.owner`, exactly `{owner, network, chainIdentity}` on the pinned network and chain, and
   * resolves or rejects as `work` does once the lane is released. Rejects before `work` runs: invalid_params, nonce_lane_unavailable (a
   * journal without owned lanes), nonce_lane_order (inside an effect pass), the journal's own refusals (journal-busy after its lock wait,
   * journal-reentrant, journal-closed, journal-integrity) and transport_closed. A hold lost while `work` runs rejects journal-fenced.
   */
  async function withWalletNonceLock(scope, work) {
    if (typeof work !== 'function') fail('invalid_params','the nonce lane work is a function');
    const owner = nonceLaneOwner(scope);
    if (typeof journal.withOwnedOrAcquiredLane !== 'function') fail('nonce_lane_unavailable','this journal cannot keep the wallet lane through the wallet\'s own writes');
    refuseInsidePass();
    return journal.withWalletLock(lane(owner), () => {
      if (closed) fail('transport_closed','the native transport is closed');
      return work();
    });
  }
  // The owner of a nonce lane scope: exactly {owner, network, chainIdentity}, a native address on the pinned network and chain.
  function nonceLaneOwner(scope) {
    const keys = scope !== null && typeof scope === 'object' ? Reflect.ownKeys(scope) : [];
    if (keys.length !== NONCE_LANE_SCOPE_KEYS.length || !NONCE_LANE_SCOPE_KEYS.every((key) => keys.includes(key))) fail('invalid_params','the nonce lane scope is exactly {owner, network, chainIdentity}');
    const { owner, network, chainIdentity } = scope;
    if (typeof owner !== 'string' || !ADDRESS.test(owner) || network !== pinned.network || canonicalChainIdentity(chainIdentity) !== pinned.chainIdentity) fail('invalid_params','the nonce lane scope names a native address on the pinned network and chain');
    return owner;
  }
  const refuseInsidePass = () => { if (insideEffectPass()) fail('nonce_lane_order','the wallet nonce lane is taken before an effect pass, never inside one'); };
  /**
   * Resolves the stage of the wallet's retained native lane row as a frozen `{stage}` (null for a row without a string stage), or null when there is
   * none, read under the lane's lock with no network read and no record write. Rejects as `withWalletNonceLock` does before its work runs, except that
   * any journal with `withWalletLock` serves it.
   */
  async function inspectWalletNonceLane(scope) {
    const owner = nonceLaneOwner(scope);
    refuseInsidePass();
    return journal.withWalletLock(lane(owner), async () => {
      if (closed) fail('transport_closed','the native transport is closed');
      const retained = await journal.get(lane(owner));
      return retained == null ? null : Object.freeze({ stage: typeof retained.stage === 'string' ? retained.stage : null });
    });
  }
  const intent = (hash) => `devnet/native-transfer/${hash}`;
  // A retained lane or intent stamped by another pin version belongs to a retired
  // pin: it is read back only, never reconfirmed, resent or re-keyed.
  const refuseRetiredPin = (retained) => {
    if (retained?.networkBinding && retained.networkBinding.pinVersion !== pinned.pinVersion) fail('pin_version_retired','the retained native transfer was issued under another pin version; it is read back only, never resent');
  };
  // The scope `{ operationId, lane, hash }` of the explicit reopen that is running, set only by reopenWithheldBroadcast. Each
  // entry point reads it once, as it reads the pass context, and hands it to the guards: it is never read inside a lock's callback.
  const reopening = new AsyncLocalStorage();
  // An unfinished retained lane is read back, never resent.
  const refuseUnfinished = async (retained, message, scope) => {
    if (!retained || ['observed','failed'].includes(retained.stage)) return;
    refuseRetiredPin(retained);
    await refuseIssued(retained.hash,message,scope);
  };
  // Every guard that refuses to resend an issued native hash admits it only inside the explicit reopen of that exact hash, and
  // then only when the whole dispatch history shows no possible transmission. Any other refusal keeps the cause it was given.
  async function refuseIssued(hash, message, scope) {
    if(scope?.hash !== hash) fail('outcome_unknown',message);
    await requireNeverTransmitted(scope,message);
  }
  // The retained signed transaction of `scope`, or `outcome_unknown` with the classification's cause.
  async function requireNeverTransmitted(scope, message) {
    const { status, message:why, cause, tx }=await nativeEligibility(scope);
    if(status !== 'never-transmitted') throw Object.assign(new Error(`${why}; ${message}`,cause === undefined ? undefined : { cause }),{ code:'outcome_unknown',eligibility:status });
    return tx;
  }
  const unavailable = (message, cause) => ({ status:'unavailable',message,cause });
  // Lane and intent rows that hold no broadcast answer: still at broadcast-started, or finished at the last check as withheld.
  const unanswered = (stored) => stored.stage === 'broadcast-started' || withheldBroadcast(stored);
  // What a reopen's scope `{ operationId, lane, hash }` can send: 'never-transmitted' with the retained signed transaction (the
  // operation's signed record on that lane, never a caller's), 'earlier-possible' (readback-only for good) or 'unavailable' (missing,
  // conflicting or incomplete evidence). Read from the whole history of the operation and from the lane and intent rows; it writes nothing.
  // `reopen_scope_invalid` when the history holds a different transaction than the capability's hash or lane.
  async function nativeEligibility({ operationId, lane:laneKey, hash }) {
    let records;
    try { records=await createEffectHistory({ journal }).readOperation({ lane:laneKey,operationId }); }
    catch(cause) { return unavailable('the dispatch history cannot be read',cause); }
    const signed=records.find((record) => record.state === 'signed');
    if(!signed) return unavailable('the history holds no signed record of this operation on this lane');
    let tx;
    try { tx=JSON.parse(Buffer.from(signed.bytes,'base64').toString('utf8')); } catch(cause) { return unavailable('the signed record is not a transaction',cause); }
    if(tx?.hash !== hash || !ADDRESS.test(tx.content?.from ?? '') || lane(tx.content.from) !== laneKey) fail('reopen_scope_invalid','the capability names no retained native transaction of this operation and lane');
    const artifactHash=sha(JSON.stringify(tx));
    if(records.some((record) => record.artifactHash !== artifactHash)) return unavailable('the operation holds more than one artifact on this lane');
    if(records.some((record) => record.pinVersion !== pinned.pinVersion)) fail('pin_version_retired','the history was written under another pin version; it is read back only, never resent');
    const row=await journal.get(lane(tx.content.from)), retained=await journal.get(intent(hash));
    const names=(stored) => stored?.hash === hash && JSON.stringify(stored.signedTransaction) === JSON.stringify(tx);
    if(retained || row?.hash === hash) {
      if(!names(row) || !names(retained)) return unavailable('the lane and intent rows do not name the one retained transaction');
      refuseRetiredPin(row); refuseRetiredPin(retained);
      if(!unanswered(row) || !unanswered(retained)) return { status:'earlier-possible',message:'a broadcast answer is retained' };
      // One row at broadcast-started and the other finished as withheld conflict: a reopen keeps rows at broadcast-started as they
      // are, so the withheld row would still say nothing was sent while the bytes are on the wire.
      if(row.stage !== retained.stage) return unavailable('the lane and intent rows are at different stages');
    } else if(row && !['observed','failed'].includes(row.stage)) return unavailable('the lane holds another unfinished transfer');
    return { ...classifyDispatchHistory(records),tx };
  }
  // A stored evidence CREATE owns the signer's next nonce until the chain has used it: a write sent before could take it and leave that
  // CREATE unexecutable. The reserved CREATE itself is not refused. Before the broadcast this only tells the wallet early that nothing
  // was sent; the broadcast claim runs it again under the signer's reservation lock, which decides.
  const refuseWhileReserved = async (from, hash) => {
    const reserved = (await journal.get(signerReservationKey(pinned, from)))?.active;
    if (reserved && reserved.signed?.txHash !== hash && nonceFromNode(await node('getAddressNonce', { address: from })) < reserved.nonce) fail('signer_lane_busy', 'a stored payment-evidence write holds this signer; nothing was sent');
  };
  // A broadcast holds the signer's reservation lock inside the lane lock through its send, so a process killed there leaves both lock
  // rows. Readback, holding the lane, takes and releases the reservation lock once: the journal takes a row over only when its holder
  // is proven dead. A live holder, such as an evidence CREATE in progress, keeps the lock, and readback goes on without it. No
  // reservation record is read or written.
  const clearDeadReservationLock = (from) => journal.withWalletLock(signerReservationKey(pinned, from), () => {})
    .catch((error) => { if (error?.code !== 'journal-busy') throw error; });
  // Cancelled native payments. The plugin cancels a payment handoff only
  // through cancelNativeTransfer, which keeps its transfer on the payer's lane
  // in this durable journal: its settlement terms (below), the digest of the
  // exact payload the plugin prepared (evidence only) and the purchase.
  // Cancelling and sending exclude each other under the lane lock:
  // cancelNativeTransfer refuses once the source, in any process on this
  // journal, has claimed a transfer with those terms (a lease's durable claim,
  // below, or a retained unobserved transfer), and from then on a signature
  // lease that names those terms, its confirmTx, its pre-broadcast request
  // and its broadcast claim are refused, also after a restart and in another
  // process. Every other write on the lane (an Agreement CREATE, another
  // nonce, payee or amount) is unaffected. None of these records (this one,
  // the claims and the refused transfers below) holds a hash or signed
  // transaction, so journal readers that look for issued writes never see them.
  const cancelledKey = (address) => `devnet/cancelled-payments/${JSON.stringify([pinned.network,pinned.chainIdentity,address])}`;
  // Transfer claims. A signature lease that names its transfer is claimed
  // here, durably, before the lease is returned; a lease that names none
  // claims the transfer it confirms, before the node sees it. Each claim is
  // marked before its confirmTx goes out. Release removes it; expiry ends it,
  // also after its confirmTx: an expired lease can confirm or broadcast
  // nothing more (claimLease), and a broadcast it started first retains its
  // issued transfer on the lane, under the lane lock and after the last
  // cancellation check, before the network send, so a cancellation sees that
  // record instead. Written only under this record's own lock, taken inside
  // the lane lock to add a claim, so no process loses another's claim.
  const claimsKey = (address) => `devnet/transfer-claims/${JSON.stringify([pinned.network,pinned.chainIdentity,address])}`;
  // Refused transfers. Each gate that refuses a transfer for a cancelled
  // payment's terms first keeps that refusal here: the exact transfer (its
  // terms and payload digest, which name one handoff's payload), the gate and
  // the time, nothing being broadcast at any gate. A cancellation record is
  // pruned once the chain has used its nonce (cancelNativeTransfer); this
  // record is not, so the plugin can still tell that a handoff's transfer was
  // refused, and sent nothing, after a later cancellation pruned the record
  // it was refused for (nativeTransferRefused). One entry per payload, the
  // last REFUSALS_KEPT; only the payer's own signed requests reach a gate.
  const refusedKey = (address) => `devnet/refused-transfers/${JSON.stringify([pinned.network,pinned.chainIdentity,address])}`;
  // A native send's settlement terms, read as settlement reads them
  // (@kynesyslabs/dacs observePayDemTransferCore, which purchases.mjs settles
  // on): the payer (from_ed25519_address when present, else from), the nonce
  // (an integer, or its decimal text as a node projects it), the payee
  // (content.to, which must equal the send's own payee argument) and the
  // amount in OS (the send's amount argument; a decimal OS string with
  // content.amount the same OS as a string or number, or a whole-DEM number
  // equal to content.amount). Addresses are compared as 0x and lowercase hex.
  // A term settlement cannot read is null; null for anything not native.
  const nativeAddress = (v) => { const m = typeof v === 'string' ? /^(?:0x)?([0-9a-fA-F]{64})$/.exec(v.trim()) : null; return m ? `0x${m[1].toLowerCase()}` : null; };
  const decimalOs = (v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) > 0n ? v : null;
  const settledAmountOs = (projected, argument) => {
    if (typeof argument === 'string') return decimalOs(argument) !== null && (decimalOs(projected) ?? (Number.isSafeInteger(projected) && projected > 0 ? String(projected) : null)) === argument ? argument : null;
    return Number.isSafeInteger(argument) && argument > 0 && projected === argument ? (BigInt(argument) * 1_000_000_000n).toString() : null;
  };
  const transferOf = (content) => {
    if (content?.type !== 'native') return null;
    const args = Array.isArray(content.data) && content.data[0] === 'native' && Array.isArray(content.data[1]?.args) && content.data[1].args.length === 2 ? content.data[1].args : null;
    const nonce = nodeProjectedNonce(content.nonce);
    const to = nativeAddress(content.to);
    return { payer:nativeAddress(content.from_ed25519_address === undefined ? content.from : content.from_ed25519_address),nonce,
      to:to !== null && args && nativeAddress(args[0]) === to ? to : null,amountOs:args ? settledAmountOs(content.amount,args[1]) : null };
  };
  // Every term read, and paid by the transaction's own signer, whose lane the
  // source keeps its records and claims on.
  const readable = (transfer, from) => !!transfer && transfer.payer !== null && transfer.payer === nativeAddress(from) && transfer.nonce !== null && transfer.to !== null && transfer.amountOs !== null;
  // A prepared payload's or a signed transaction's transfer: its settlement
  // terms with its payload digest (sdk-provider.mjs nativePayloadDigest;
  // signing keeps it); null for anything else. Only the Agreement capability
  // is cancelled through (cancelNativeTransfer), so only it keeps records and
  // claims: the native-only capability names, claims and refuses nothing.
  const identityOf = async (content) => {
    const transfer = agreement ? transferOf(content) : null;
    if (!transfer) return null;
    const { payer, ...terms } = transfer;
    return { ...terms,payloadDigest:await nativePayloadDigest(content),readable:readable(transfer,content.from) };
  };
  const termsOf = ({ nonce, to, amountOs, payloadDigest }) => ({ nonce,to,amountOs,payloadDigest });
  // The transfer a wallet names with its signature-phase request
  // (sdk-provider.mjs sendTransaction), its terms normalized as above;
  // anything malformed names none.
  const declaredTransfer = (t) => agreement && t && typeof t === 'object' && Number.isSafeInteger(t.nonce) && nativeAddress(t.to) !== null && decimalOs(t.amountOs) !== null && HASH.test(t.payloadDigest ?? '')
    ? { nonce:t.nonce,to:nativeAddress(t.to),amountOs:t.amountOs,payloadDigest:t.payloadDigest } : null;
  // The same settlement terms: any transfer that settles one settles the
  // other (its time, data encoding, address case, fee and signature aside), so
  // cancellations and claims match on these alone. The payload digest is kept
  // as evidence and binds a lease to the exact payload it named (samePayload).
  const sameTransfer = (a, b) => !!a && !!b && a.nonce === b.nonce && a.to === b.to && a.amountOs === b.amountOs;
  const samePayload = (a, b) => sameTransfer(a,b) && a.payloadDigest === b.payloadDigest;
  const cancelledTransfer = async (address, transfer) => {
    if (!transfer) return null;
    const held = await journal.get(cancelledKey(address));
    return held?.transfers?.find((t) => sameTransfer(t,transfer)) ?? null;
  };
  // Keeps the refusal (refusedKey), then refuses. A refusal that cannot be
  // kept still refuses: the plugin then has only the cancellation record.
  const refuseCancelled = async (address, transfer, gate) => {
    try {
      await journal.withWalletLock(refusedKey(address),async () => {
        const refusals = (await journal.get(refusedKey(address)))?.refusals ?? [];
        if (refusals.some((r) => samePayload(r,transfer))) return;
        await retain(refusedKey(address),{ refusedTransfers:'dacs-chatgpt-plugin/refused-native-transfers/v1',refusals:[...refusals,{ ...termsOf(transfer),gate,refusedAt:new Date(now()).toISOString() }].slice(-REFUSALS_KEPT) });
      });
    } catch { /* the refusal stands */ }
    fail('payment_cancelled',PAYMENT_CANCELLED);
  };
  const live = (claim) => Date.parse(claim.expiresAt) > now();
  const writeClaims = (address, change) => journal.withWalletLock(claimsKey(address),async () => {
    const claims = (await journal.get(claimsKey(address)))?.claims ?? [];
    const next = change(claims.filter(live));
    if (JSON.stringify(next) !== JSON.stringify(claims)) await retain(claimsKey(address),{ transferClaims:'dacs-chatgpt-plugin/native-transfer-claims/v1',claims:next });
  });
  // Adds the lease's claim, or marks it before its confirmTx goes out.
  const claimTransfer = async (lease, transfer, confirming = false) => {
    await writeClaims(lease.address,(claims) => [...claims.filter((c) => c.leaseId !== lease.id),
      { leaseId:lease.id,...termsOf(transfer),expiresAt:new Date(lease.expiresAt).toISOString(),...(confirming ? { confirmTxAt:new Date(now()).toISOString() } : {}) }]);
    lease.transfer = termsOf(transfer);
  };
  // Claims at or below a nonce the chain has used can do nothing more. Tidying
  // only: a claim left behind keeps one cancellation from answering true.
  const pruneClaims = async (address, used) => {
    try { if ((await journal.get(claimsKey(address)))?.claims?.some((c) => c.nonce <= used)) await writeClaims(address,(claims) => claims.filter((c) => c.nonce > used)); }
    catch { /* the claims stay */ }
  };
  // A live claim on this transfer's terms, or a retained transfer with those
  // terms not yet read back. A transfer read back as failed (readback) is
  // resolved, as an observed one is. Another retained write is no claim on
  // this transfer: the plugin's proof (unissued) refuses the cancellation.
  const transferClaimed = async (address, transfer) => {
    if ((await journal.get(claimsKey(address)))?.claims?.some((c) => sameTransfer(c,transfer) && live(c))) return 'signature-lease';
    const latest = await journal.get(lane(address));
    return latest && !['observed','failed'].includes(latest.stage) && sameTransfer(transferOf(latest.signedTransaction?.content),transfer) ? latest.stage : null;
  };
  // released: the wallet released the lease, or its broadcast was claimed or
  // refused, so its claim goes. Expiry ends it at the next write (writeClaims)
  // and close() keeps it until then. A claim that cannot be removed stays,
  // which only keeps a cancellation from answering cancelled: true.
  const stopLease = async (lease, released = false) => {
    if (!lease || leases.get(lease.id) !== lease) return;
    leases.delete(lease.id); byAddress.delete(lease.address);
    clearTimeout(lease.expiryTimer);
    try { if (released && lease.transfer) await writeClaims(lease.address,(claims) => claims.filter((c) => c.leaseId !== lease.id)); }
    catch { /* fail closed: the claim stays */ }
    finally { await lease.fence.release(); }
  };
  // A wallet's explicit release never frees the fence under a running confirm
  // or broadcast: the lease refuses new work at once and stops when the last
  // running call exits. Only close(), after draining, stops it outright.
  const releaseLease = async (lease) => {
    if (lease.busy > 0) { lease.releaseRequested = true; return; }
    await stopLease(lease,true);
  };
  // An expired lease frees its connection fence unless a confirm or broadcast
  // call is running under it. Nothing can be confirmed or sent under an
  // expired lease (claimLease refuses it), and no journal or lane changes, so
  // a retained unknown outcome stays fenced for readback.
  const releaseExpiredLeases = async () => { for (const l of [...leases.values()]) if (l.expiresAt <= now() && l.busy === 0) await stopLease(l); };
  // The caller must call release() once its work under the lease settles.
  const claimLease = async (address) => {
    const l = byAddress.get(address);
    const current = () => l && leases.get(l.id) === l && l.expiresAt > now() && !l.releaseRequested;
    if (!current() || !sameContext(await context(),l.fence.context) || !current()) fail('network_binding_required','the signature/broadcast connection fence is absent or changed');
    l.busy++;
    return { l, release: async () => { l.busy--; if (l.busy === 0 && (l.releaseRequested || l.expiresAt <= now())) await stopLease(l,l.releaseRequested === true); } };
  };
  // The SDK's RPC authentication: the sender's ed25519 signature over
  // sha256("ed25519:<address>:<timestamp>"). It proves control of the key, and
  // each set is accepted once while fresh (AUTH_WINDOW_MS above). Memory is per
  // identity: its used timestamps and a floor at or below which nothing it
  // stamped is accepted. Sets are forgotten only from an identity keeping at
  // least one more, so its floor stays below a remembered set and goes stale
  // no later than they do; an identity with none left needs no record.
  const authRecords = new Map();
  let sharedAuth = 0;
  const forget = (r, at) => { r.used.delete(at); if (!r.reserved) sharedAuth--; };
  const forgetOldest = (r) => {
    let oldest=Infinity;
    for (const at of r.used) if (at < oldest) oldest=at;
    forget(r,oldest); r.floor=Math.max(r.floor,oldest);
  };
  const pruneAuth = (identity, r, t) => {
    for (const at of r.used) if (at < t - AUTH_WINDOW_MS) forget(r,at);
    if (r.used.size === 0 && !r.reserved) authRecords.delete(identity);
  };
  const senderAuth = (address, headers) => {
    const identity=headers?.identity, timestamp=headers?.timestamp;
    if (identity !== `ed25519:${address}` || !/^[0-9]{1,16}$/.test(timestamp ?? '')
      || !verifyDemosSignature({ address,message:sha(`${identity}:${timestamp}`),signature:headers.signature })) fail('wallet_auth_required','the SDK request signature must belong to the native sender');
    const at=Number(timestamp), t=now();
    if (Math.abs(at - t) > AUTH_WINDOW_MS) fail('wallet_auth_stale',AUTH_REFUSALS.wallet_auth_stale);
    let r=authRecords.get(identity);
    if (r) { pruneAuth(identity,r,t); r=authRecords.get(identity); }
    if (r && at <= r.floor) fail('wallet_auth_stale',AUTH_REFUSALS.wallet_auth_stale);
    // Keyed by the signed identity and timestamp, not by the signature's encoding.
    if (r?.used.has(at)) fail('wallet_auth_replayed',AUTH_REFUSALS.wallet_auth_replayed);
    if (r && r.used.size >= AUTH_PER_IDENTITY) forgetOldest(r);
    if (!r?.reserved && sharedAuth >= AUTH_MEMORY) {
      for (const [k,v] of [...authRecords]) pruneAuth(k,v,t);
      r=authRecords.get(identity);
      // Make room from the identity holding the most; if none holds two, refuse.
      while (sharedAuth >= AUTH_MEMORY) {
        let most=null;
        for (const v of authRecords.values()) if (!v.reserved && (!most || v.used.size > most.used.size)) most=v;
        if (!most || most.used.size < 2) fail('wallet_auth_busy',AUTH_REFUSALS.wallet_auth_busy);
        forgetOldest(most);
      }
    }
    // Either eviction may have raised this identity's own floor past this set.
    if (r && at <= r.floor) fail('wallet_auth_stale',AUTH_REFUSALS.wallet_auth_stale);
    if (!r) { r={ used:new Set(),floor:-Infinity,reserved:false }; authRecords.set(identity,r); }
    r.used.add(at); if (!r.reserved) sharedAuth++;
  };
  // The operator's own wallets (custody buyer, in-process seller) keep their
  // used sets outside the shared memory: no other identity can make them stale
  // or busy. Each still forgets only its own oldest, past its own quota.
  const reserveRpcAuth = (address) => {
    if (!ADDRESS.test(address ?? '')) throw new TypeError('a native wallet address is required');
    const identity=`ed25519:${address}`, r=authRecords.get(identity);
    if (r?.reserved) return;
    if ([...authRecords.values()].filter((v)=>v.reserved).length >= AUTH_RESERVED) throw new TypeError('reserved RPC auth memory is only for the operator\'s own wallets');
    if (r) { sharedAuth-=r.used.size; r.reserved=true; }
    else authRecords.set(identity,{ used:new Set(),floor:-Infinity,reserved:true });
  };
  // Ends a wait for a lock or a connection fence with the abort reason as soon
  // as `signal` aborts. `wait` receives a function to call when the grant
  // arrives; an abort after that no longer ends the wait, so granted work runs
  // to completion. After an abort the wait itself goes on in the background
  // until the lock or fence is granted or the journal gives up on the lock
  // with 'journal-busy' (after its lockTimeoutMs). No work runs after the
  // abort, and a lock or fence granted after it is released without any.
  function untilAborted(signal, wait) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const giveUp = () => reject(signal.reason);
      const granted = () => signal.removeEventListener('abort', giveUp);
      signal.addEventListener('abort', giveUp, { once: true });
      wait(granted).then(resolve, reject).finally(granted);
    });
  }
  const lockUnlessAborted = (signal, key, work) => untilAborted(signal, granted =>
    journal.withWalletLock(key, () => { granted(); signal.throwIfAborted(); return work(); }));
  const fenceUnlessAborted = (signal, address) => untilAborted(signal, granted =>
    Promise.resolve().then(() => transportOwner.acquireConnectionFence({ address })).then(f => {
      granted();
      if (!signal.aborted) return f;
      // The caller already has the abort reason; a failed release has no one to report to.
      Promise.resolve().then(() => f?.release?.()).catch(() => {});
    }));
  async function fenced(work, address, signal) {
    await releaseExpiredLeases();
    const f = await (signal ? fenceUnlessAborted(signal, address) : transportOwner.acquireConnectionFence({ address }));
    if (!f || typeof f.release !== 'function') fail('invalid_transport_owner','actual connection fence acquisition failed');
    try {
      if (!sameContext(await context(),f.context)) fail('connection_changed','the acquired connection differs from actual egress');
      return await work();
    } finally { await f.release(); }
  }
  // The signature lease's connection fence. With a boundary it is the boundary's hold on the
  // owner's fence: admission, stop, fee and binding are checked before the wait and again once
  // it is held, and the lease's confirmation passes run inside the hold.
  const acquireLeaseFence = async (address, operationId, transfer) => {
    const hold = await boundary.holdFence({ operationId, lane:lane(address), kind:'native', paidWrite:true, debitOs:transfer?.amountOs ?? '0', pinVersion:pinned.pinVersion });
    try { return { hold, context:await context(), release:() => hold.release() }; }
    catch (error) { await hold.release().catch(() => {}); throw error; }
  };
  async function retain(key, record) {
    await journal.put(key,record);
    if (JSON.stringify(await journal.get(key)) !== JSON.stringify(record)) fail('journal_error','the public issued transfer was not retained exactly');
  }
  // The node's signature domain for the connection a request runs on: null while the signatureDomain fork is inactive,
  // else its chain id. The answer is evidence for that connection only. An active one is kept and never replaced by an
  // inactive one, an inactive one is reused for a minute, and a read that fails or is malformed is never kept. Called only under a lease, so a request refused
  // before it holds one reads nothing.
  let signatureDomainEvidence = null;
  const readSignatureDomain = async () => {
    const connection = await context(), kept = signatureDomainEvidence;
    if (kept && sameContext(kept.connection, connection) && (kept.chainId !== null || now() - kept.readAt < INACTIVE_SIGNATURE_DOMAIN_REUSE_MS)) return kept.chainId;
    let info;
    try { info = await node('getNetworkInfo', {}); } catch (cause) {
      throw Object.assign(new Error('the node\'s signature domain could not be read', { cause }), { code:'signature_domain_unreadable' });
    }
    const active = info?.forks?.signatureDomain?.activated, chainId = info?.chainId;
    if (typeof active !== 'boolean' || (active && !(Number.isSafeInteger(chainId) && chainId >= 0))) fail('signature_domain_malformed','the node\'s getNetworkInfo does not say whether the signature domain is active, or gives no chain id for it');
    if (!sameContext(await context(), connection)) fail('connection_changed','the connection changed while the signature domain was read');
    // Another request may have kept an active answer for this connection while this read was in flight. The fork does
    // not deactivate, so a late inactive answer never replaces it: the kept active domain is the one that applies.
    const current = signatureDomainEvidence;
    if (!active && current && current.chainId !== null && sameContext(current.connection, connection)) return current.chainId;
    signatureDomainEvidence = { connection, readAt:now(), chainId:active ? chainId : null };
    return signatureDomainEvidence.chainId;
  };
  // Refuses unless the signature is the sender's over what the node's signature domain says it covers: the hash while the
  // fork is inactive, `demos-tx:v1:<chain id>:<hash>` once it is active. No other form is accepted.
  const verifyTransactionSignature = async (tx) => {
    const chainId = await readSignatureDomain();
    const message = chainId === null ? tx.hash : `${SIGNATURE_DOMAIN_PREFIX}${chainId}:${tx.hash}`;
    if (!verifyDemosSignature({ address:tx.content.from, message, signature:tx.signature.data })) fail('native_only',ONLY_ORIGINAL_SENDS);
  };
  function signedTransaction(body, headers) {
    const call=body.params?.[0], tx=call.extra === 'confirmTx' ? call.data : call.data?.response?.data?.transaction;
    const c=tx?.content;
    const native=c?.type === 'native' && c.data?.[0] === 'native' && c.data?.[1]?.nativeOperation === 'send' && Array.isArray(c.data[1].args) && c.data[1].args.length === 2 && c.data[1].args[0] === c.to;
    const op=c?.data?.[1];
    const createKind=op?.metadata?.artifactKind;
    const settlementArtifact=createKind==='SettlementEvidence' && settlement && !Object.hasOwn(op.data ?? {},'artifactType') && isSettlementEvidence(op.data)
      && op.data.phase===publication.phase && op.data.outcome==='success' && op.data.paymentAmount?.currency==='DEM'
      && op.metadata.logicalAddress===paymentEvidenceAddress(op.data.jobId,publication.railId,publication.phaseIndex)
      && contentHash(op.data)===op.metadata.contentHash && op.data.signature?.signer===`did:demos:agent:${c?.from?.replace(/^0x/,'')}`
      && verifyDemosSignature({address:c?.from,message:Buffer.from(signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence,op.metadata.contentHash)).toString('utf8'),signature:op.data.signature?.value});
    const db=op?.metadata?.deliveryBinding;
    const deliveryArtifact=createKind==='Deliverable' && delivery && !Object.hasOwn(op.data ?? {},'artifactType')
      && op.data?.reportVersion==='1' && op.data?.kind==='dacs-chatgpt-plugin/fixture-test-report'
      && canonicalize(db)===canonicalize({ version:'1',profile:DEVNET_DELIVERY_POLICY,jobId:op.data?.jobId,phase:deliveryDeclaration.phase,
        phaseIndex:deliveryDeclaration.phaseIndex,listing:op.data?.listing,agreementHash:op.data?.agreementHash,fulfilmentId:db?.fulfilmentId,
        purchaseAmount:db?.purchaseAmount,payloadHash:op.metadata?.contentHash })
      && typeof db?.fulfilmentId==='string' && db.fulfilmentId.length>0 && db.fulfilmentId.length<=128
      && db.purchaseAmount?.currency==='DEM' && typeof db.purchaseAmount?.amount==='string'
      && contentHash(op.data)===op.metadata.contentHash && op.metadata.logicalAddress===`dacs4:deliverable:${op.data.jobId}`;
    const ab=op?.metadata?.artifactBinding;
    const demoShape=createKind==='Listing' ? isListing(op?.data)
      : createKind==='CompositeVerificationRecord' ? isCompositeVerificationRecord(op?.data)
      : createKind==='FinalityCommitmentRecord' ? isFinalityCommitmentRecord(op?.data)
      : createKind==='SettlementEvidence' ? isNativeDeliveryEvidence(op?.data,`did:demos:agent:${c?.from?.replace(/^0x/,'')}`,op?.metadata?.logicalAddress)
      : createKind==='Deliverable' && op?.data?.reportVersion==='1' && op?.data?.kind==='dacs-chatgpt-plugin/devnet-purchased-report'
        && typeof op.data?.content?.mediaType==='string' && typeof op.data?.content?.text==='string';
    const demoArtifact=demo && demoDeclaration.artifactKinds.includes(createKind) && demoShape
      && canonicalize(ab)===canonicalize({version:'1',policy:DEVNET_DEMO_ARTIFACT_POLICY,authority:demoDeclaration.authority,
        artifactKind:createKind,jobId:op.data?.jobId ?? `listing:${op.data?.listingId}`,logicalAddress:op.metadata?.logicalAddress,writer:`did:demos:agent:${c?.from?.replace(/^0x/,'')}`})
      && contentHash(op.data)===op.metadata.contentHash
      && (createKind!=='CompositeVerificationRecord' || op.data?.signature?.signer===ab.writer)
      && (createKind!=='FinalityCommitmentRecord' || op.data?.signature?.signer===ab.writer)
      && (createKind!=='Listing' || op.data?.seller?.identity?.presentedBy===ab.writer)
      && (createKind!=='Deliverable' || (op.data?.producer===ab.writer && op.metadata.logicalAddress===`dacs4:deliverable:${op.data.jobId}`
        && canonicalize(db)===canonicalize({version:'1',profile:DEVNET_DELIVERY_POLICY,jobId:op.data.jobId,phase:deliveryDeclaration.phase,
          phaseIndex:deliveryDeclaration.phaseIndex,listing:op.data.listing,agreementHash:op.data.agreementHash,fulfilmentId:db?.fulfilmentId,
          purchaseAmount:db?.purchaseAmount,payloadHash:op.metadata.contentHash}) && typeof db?.fulfilmentId==='string' && db.fulfilmentId.length>0 && db.fulfilmentId.length<=128
        && db.purchaseAmount?.currency==='DEM' && typeof db.purchaseAmount?.amount==='string'));
    const create=agreement && c?.type==='storageProgram' && c.data?.[0]==='storageProgram' && op?.operation==='CREATE_STORAGE_PROGRAM' && (createKind==='Agreement' || settlementArtifact || deliveryArtifact || demoArtifact)
      && op.storageAddress===c.to && op.salt==='' && op.encoding==='json' && op.acl?.mode==='public' && c.network===pinned.network && c.chainIdentity===pinned.chainIdentity
      && canonicalize(op.metadata.networkBinding)===canonicalize(declaration);
    if (!c || !ADDRESS.test(c.from ?? '') || (!native && !create)
      || !HASH.test(tx.hash ?? '') || sha(JSON.stringify(c)) !== tx.hash || tx.signature?.type !== 'ed25519') fail('native_only',ONLY_ORIGINAL_SENDS);
    senderAuth(c.from, headers);
    return tx;
  }
  // Whether the node's answer is a valid confirmation of these exact bytes. Any other answer
  // is not one; a changed byte throws. The seller policy is asked after the answer is retained.
  const acceptsConfirmation = (answer, tx) => {
    if (answer?.result !== 200 || answer.response?.data?.valid !== true) return false;
    if (JSON.stringify(answer.response.data.transaction) !== JSON.stringify(tx)) fail('signed_bytes_changed','the new native transport requires byte-identical signed confirmation');
    return true;
  };
  // Throws `approval_required` unless the seller policy, if any, approves this confirmation.
  const approveConfirmation = async (answer) => {
    if (approveConfirmedWrite && (await approveConfirmedWrite(answer)) !== true) fail('approval_required','the seller policy refused the confirmed write');
  };
  // The exact signed bytes as the boundary's signed record. A repeated request for the same bytes reuses it.
  const retainSigned = async (operation, bytes) => {
    try { return await boundary.signPass(operation, async () => bytes); } catch (error) {
      if (error?.code === 'eb_operation_signed' && error.details?.artifactHash === sha(bytes)) return { ...operation, artifactHash:error.details.artifactHash };
      throw error;
    }
  };
  // The boundary's operation for a lease's transaction: the lease's operation, on the sender's lane.
  const operationOf = (lease, tx) => ({ operationId:lease.operationId, lane:lane(tx.content.from), kind:tx.content.type === 'native' ? 'native' : 'create', paidWrite:true,
    debitOs:tx.content.type === 'native' ? transferOf(tx.content)?.amountOs : '0', pinVersion:pinned.pinVersion });
  // Runs `confirmOnce(bytes, final)` as the boundary's confirm stage inside the lease's hold: the signed
  // bytes, `confirm-started` before the node sees them, then `confirm-acknowledged` with the
  // node's answer and gas when `accepted()`, or `confirm-unknown` with the cause.
  const confirmAsStage = async (lease, tx, confirmOnce, accepted) => {
    return lease.fence.hold.run(async () => boundary.dispatchPass(await retainSigned(operationOf(lease, tx), Buffer.from(JSON.stringify(tx))), confirmOnce,
      { explicit:true, stage:'confirm', material:(answer) => accepted() ? { confirmation:answer, gasOperation:answer.response.data.gas_operation ?? null } : undefined }));
  };
  // Every record of one signed artifact names the same operation. When an earlier lease signed these exact bytes and
  // nothing in their history may have sent them (then the same request again), the lease takes over that operation: its
  // fence hold moves to the earlier operation id on the same connection. An acknowledged confirmation is then answered from
  // its retained record, and any other is asked of the node again. Once the history holds a dispatch that may have been
  // sent, the lease keeps its own operation, so the history refuses its signed record (`eb_history_conflict`) and the bytes
  // are read back only. A transport holds one lease per address, so no other lease of this transport adds a record for
  // these bytes between this read and the takeover.
  const continueSignedOperation = async (lease, tx) => {
    const records=await historyOf({ lane:lane(tx.content.from),artifactHash:sha(JSON.stringify(tx)) });
    const earlier=records.find((record) => record.state === 'signed');
    if (!earlier || earlier.operationId === lease.operationId || !nothingSent(records)) return;
    const connection=lease.fence.context;
    await lease.fence.release();
    lease.operationId=earlier.operationId;
    lease.fence=await acquireLeaseFence(lease.address,earlier.operationId,transferOf(tx.content));
    if (!sameContext(lease.fence.context,connection)) fail('connection_changed','the connection changed before the signed bytes were confirmed');
  };
  // The artifact's records in the boundary's dispatch history, in commit order.
  const historyOf = (artifact) => createEffectHistory({ journal }).read(artifact);
  // The latest confirm-acknowledged record of an artifact, exactly as retained, or undefined. With `current`, a later
  // confirm-unknown ends it: an unknown confirmation never counts as confirmed, so the artifact has none.
  const retainedConfirmation = async (artifact, { current = false } = {}) => {
    const latest = (await historyOf(artifact)).findLast((record) => record.state === 'confirm-acknowledged' || (current && record.state === 'confirm-unknown'));
    return latest?.state === 'confirm-acknowledged' ? latest : undefined;
  };
  // The reference block a node confirmation carries, or null when it carries none: never read from a height.
  const referenceBlockOf = (confirmation) => {
    const block = confirmation?.response?.data?.reference_block;
    return Number.isSafeInteger(block) && block >= 0 ? block : null;
  };
  // A storage write's kept reference block for a caller, or nothing for a native transfer, which keeps none.
  const keptReferenceBlock = (row) => row.signedTransaction.content.type === 'storageProgram' ? { referenceBlock:row.storageWriteReferenceBlock ?? null } : {};
  // The whole debit a signed transaction commits the sender to, in OS: the declared amount plus the three fees of its
  // own signed `transaction_fee` (each a decimal OS string, or a whole-DEM number as an amount is read). The node's fee
  // view never enters it. `null` when any fee cannot be read, which refuses the broadcast or the recovery resend.
  const signedDebitOs = (declaredOs, transactionFee) => {
    const fees = FEE_MEMBERS.map((member) => signedFeeOs(transactionFee?.[member]));
    return canonicalDecimal(declaredOs) && fees.every(canonicalDecimal) ? String(fees.reduce((sum, fee) => sum + BigInt(fee), BigInt(declaredOs))) : null;
  };
  const signedFeeOs = (fee) => (canonicalDecimal(fee) ? fee : Number.isSafeInteger(fee) && fee >= 0 ? String(BigInt(fee) * 1_000_000_000n) : null);
  // Whether a confirmation's fee view is absent (`null`), or names each signed fee exactly as a canonical decimal OS string.
  const feeViewIsSigned = (gasOperation, transactionFee) => gasOperation === null || FEE_MEMBERS.every((member) => {
    const fee = gasOperation?.fees?.[member];
    return canonicalDecimal(fee) && fee === signedFeeOs(transactionFee?.[member]);
  });
  // Execution projection only: nonce/timestamp may be normalized
  // by RPC, post-fork root amount/fee OS strings may be returned as safe JSON
  // numbers, and empty GCR txhash carriers may become the original hash. The
  // numeric exception is directional and path-specific: it never applies to
  // data, GCR edits or arbitrary amount-like fields, and ambiguous/unsafe
  // numeric forms remain different. This does not alter any signed or
  // confirmed bytes sent to the node.
  const canonicalDecimal = (value) => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);
  const projectedDecimal = (actual, expected) => Number.isSafeInteger(actual) && actual >= 0 && !Object.is(actual,-0)
    && canonicalDecimal(expected) && String(actual) === expected;
  function executedMatches(actual, expected, hash, path=[]) {
    const key=path.at(-1) ?? '';
    if (path.length === 1 && ['nonce','timestamp'].includes(key) && typeof actual === 'string' && canonicalDecimal(actual)
      && Number.isSafeInteger(expected) && expected >= 0 && actual === String(expected)) return true;
    if (path.length === 1 && key === 'amount' && projectedDecimal(actual,expected)) return true;
    if (path.length === 2 && path[0] === 'transaction_fee' && ['network_fee','rpc_fee','additional_fee'].includes(key)
      && projectedDecimal(actual,expected)) return true;
    if (path.length === 3 && path[0] === 'gcr_edits' && /^(?:0|[1-9][0-9]*)$/.test(path[1])
      && key === 'txhash' && expected === '' && actual === hash) return true;
    if (actual === expected) return true;
    if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
    const a=Object.keys(actual).sort(), b=Object.keys(expected).sort();
    return JSON.stringify(a) === JSON.stringify(b) && b.every((k) => executedMatches(actual[k],expected[k],hash,[...path,k]));
  }
  function storageExecutionMatches(actual,expected,hash,binding){
    const retainedBinding=typeof expected?.network==='string'&&expected.network.length>0&&expected.network===pinned.network
      &&typeof expected?.chainIdentity==='string'&&expected.chainIdentity.length>0&&expected.chainIdentity===pinned.chainIdentity
      &&binding?.network===pinned.network&&binding?.chainIdentity===pinned.chainIdentity;
    if(!retainedBinding)return false;
    const hasNetwork=Object.hasOwn(actual??{},'network'),hasChainIdentity=Object.hasOwn(actual??{},'chainIdentity');
    // Node2's confirmed storageProgram projection omits this exact pair. Restore
    // it only in a comparison copy after the fresh binder has recovered the
    // same active admission. Partial omission and every other difference stay
    // visible to the SDK matcher; retained and fetched bytes are untouched.
    const comparison=!hasNetwork&&!hasChainIdentity?{...actual,network:expected.network,chainIdentity:expected.chainIdentity}:actual;
    return demosTransactionContentMatches(expected,comparison,hash);
  }
  const includedInBlock=(block,hash,blockNumber)=>block?.number===blockNumber&&block.status==='confirmed'&&Array.isArray(block.content?.ordered_transactions)&&block.content.ordered_transactions.includes(hash);
  async function inclusionReceipt(address,hash,r,binding,status,body) {
    const tx=body === undefined ? await node('getTxByHash',{ hash }) : body, block=await node('getBlockByNumber',{ blockNumber:status.blockNumber });
    const create=r.signedTransaction.content.type==='storageProgram';
    const included=tx?.hash===hash&&tx.status==='confirmed'&&tx.blockNumber===status.blockNumber&&includedInBlock(block,hash,status.blockNumber);
    if (!included || !(create?storageExecutionMatches(tx.content,r.signedTransaction.content,hash,binding):executedMatches(tx.content,r.signedTransaction.content,hash))) fail('readback_unverified','the included native transfer differs from the retained original signed transaction');
    if(create){
      const c=r.signedTransaction.content,op=c.data[1];
      const native=await fetchBoundedJson(`${new URL(pinned.endpoint).origin}/storage-program/${c.to}`,{fetchImpl,timeoutMs,maxBytes:1024*1024,expectedOrigin:new URL(pinned.endpoint).origin});
      // Node2's public storage-object projection may omit both transaction
      // provenance fields. This is accepted only as a pair after the
      // admitted status/tx/block/full signed CREATE checks above. A rich
      // projection remains exact; partial omission and wrong present
      // values stay fail-closed. Fetched and retained bytes are untouched.
      const hasCreatedByTx=Object.hasOwn(native??{},'createdByTx'),hasInteractionTxs=Object.hasOwn(native??{},'interactionTxs');
      const creationProvenance=(!hasCreatedByTx&&!hasInteractionTxs)||(hasCreatedByTx&&hasInteractionTxs&&native.createdByTx===hash&&Array.isArray(native.interactionTxs)&&native.interactionTxs.includes(hash));
      if(native?.success!==true || native.owner!==address || native.storageAddress!==c.to || native.programName!==op.programName || !creationProvenance
        || canonicalize(native.data)!==canonicalize(op.data) || canonicalize(native.metadata)!==canonicalize(op.metadata)) fail('readback_unverified','the native Agreement CREATE/provenance differs from its original signed bytes');
    }
    const receipt={ hash,nonce:r.nonce,blockNumber:status.blockNumber,blockHash:block.hash ?? null,
      payer:r.signedTransaction.content.from,payee:r.signedTransaction.content.to,amount:r.signedTransaction.content.amount,
      network:pinned.network,chainIdentity:pinned.chainIdentity,attribution:'tuple-only',finality:'not-established',commitmentOnChain:false };
    return receipt;
  }
  // A storage CREATE the node recorded as failed (status included or failed,
  // body failed). Its execution applied nothing. The result is final: the
  // write is never resent or re-made here, and its rows stay as they were.
  // The body must name this hash, sit in the status block when the status
  // names one, and match the retained signed bytes; otherwise it differs.
  // The named confirmed block is then read and must list the hash. A block that
  // cannot be read, or does not list it, leaves the write pending, not failed.
  // The node's code and message are repeated only when short, printable text.
  async function failedStorageWrite(hash,r,binding,status,tx) {
    if(tx.hash!==hash || !Number.isSafeInteger(tx.blockNumber) || tx.blockNumber<0 || (status.blockNumber!==undefined && status.blockNumber!==tx.blockNumber)
      || !storageExecutionMatches(tx.content,r.signedTransaction.content,hash,binding)) fail('readback_unverified','the failed storage write differs from the retained signed transaction');
    const block=await node('getBlockByNumber',{ blockNumber:tx.blockNumber }).catch(() => null);
    if(!includedInBlock(block,hash,tx.blockNumber)) return { disposition:'pending',hash,nonce:r.nonce,noResend:true,...keptReferenceBlock(r) };
    const attrs=tx.attrs ?? {},text=(value)=>typeof value==='string' && value.length<=NODE_FAILURE_TEXT_MAX_LENGTH && !NODE_FAILURE_TEXT_UNSAFE.test(value) ? value : null;
    const failure={ blockNumber:tx.blockNumber,code:text(attrs.code),message:text(attrs.message),
      referenceBlock:Number.isSafeInteger(attrs.reference_block) && attrs.reference_block>=0 ? attrs.reference_block : null };
    const cause=failure.code===null ? '' : ` (${failure.code}${failure.message===null ? '' : `: ${failure.message}`})`;
    return { disposition:'failed',hash,nonce:r.nonce,noResend:true,resolved:false,failure,
      reason:`the node recorded storage write ${hash} as failed in block ${tx.blockNumber}${cause}; nothing was applied. It is never resent or re-made automatically.` };
  }
  async function readback(address, hash, writeProof, failedNonceFence, consumedByHash) {
    if (!ADDRESS.test(address ?? '') || !HASH.test(hash ?? '')) fail('invalid_params','a public native writer and hash are required');
    return fenced(() => laneLock(address, async () => {
      await clearDeadReservationLock(address);
      const latest=await journal.get(lane(address));
      const r=await journal.get(intent(hash)) ?? (latest?.hash === hash ? latest : null);
      if (!r || r.hash !== hash || r.signedTransaction?.content?.from !== address) fail('not_issued','this hash is not the retained native transfer by this writer');
      if(!agreement && r.signedTransaction.content.type!=='native') fail('native_only','the native-only capability does not read or release Agreement CREATE');
      if(consumedByHash!==undefined){
        if(!agreement || r.signedTransaction.content.type!=='native' || !HASH.test(consumedByHash ?? '') || consumedByHash===hash || !Number.isSafeInteger(r.nonce) || r.nonce<0)fail('invalid_params','supersession requires a different native hash at the retained nonce');
        if(r.stage==='observed')fail('readback_unverified','an observed intent cannot be superseded');
        if(r.stage==='failed'){
          const f=r.failure,fence=f?.supersededByHash===undefined && Number.isSafeInteger(f?.nonceFence) && f.nonceFence>=0;
          if((f?.supersededByHash!==consumedByHash && !fence) || !Number.isSafeInteger(f.blockNumber) || f.blockNumber<0 || r.networkBinding?.network!==pinned.network || r.networkBinding.chainIdentity!==pinned.chainIdentity)fail('readback_unverified','the retained failure does not prove this supersession');
          // This bound inclusion (or nonce-fence) proof was retained before the interrupted lane write.
          if(latest?.hash===hash && latest.stage!=='failed'){
            if(latest.stage==='observed')fail('readback_unverified','an observed lane cannot be superseded');
            await retain(lane(address),r);
          }
          return {disposition:'failed',hash,nonce:r.nonce,noResend:true,resolved:true,consumedByHash};
        }
      }
        const binding=await binder.recover(r.networkBinding);
        if(consumedByHash!==undefined){
          const status=await node('getTransactionStatus',{hash:consumedByHash});
          const tx=await node('getTxByHash',{hash:consumedByHash});
          const c=tx?.content;
          if(status?.state!=='included' || !Number.isSafeInteger(status.blockNumber) || status.blockNumber<0 || tx?.hash!==consumedByHash || tx.status!=='confirmed' || tx.blockNumber!==status.blockNumber
            || c?.type!=='native' || (c.from_ed25519_address??c.from)!==address || !executedMatches(c.nonce,r.nonce,consumedByHash,['nonce'])
            || (Object.hasOwn(c,'network') && c.network!==pinned.network) || (Object.hasOwn(c,'chainIdentity') && c.chainIdentity!==pinned.chainIdentity))fail('readback_unverified','the competing transaction does not prove this bound sender nonce was consumed');
          const block=await node('getBlockByNumber',{blockNumber:status.blockNumber});
          if(!includedInBlock(block,consumedByHash,status.blockNumber))fail('readback_unverified','the competing transaction is absent from its confirmed block');
          // Nonce owner as settlement reads it; an alternate signing key's body also needs the bound account nonce consumed.
          if(c.from!==address && !(nonceFromNode(await node('getAddressNonce',{address}))>=r.nonce))fail('readback_unverified','the bound sender nonce is not yet consumed');
          // Nonce first, then r's status: r cannot land once the nonce is consumed, so the node's absent answer for r proves another transfer consumed it.
          // Only exactly {state:'unknown'} is absent; pending, unavailable or any other answer is refused and retried later.
          if(c.from!==address){const own=await node('getTransactionStatus',{hash});if(own?.state!=='unknown' || Object.keys(own).length!==1)fail('readback_unverified','the retained native transfer may itself have consumed the bound sender nonce');}
          writeProofs.delete(hash);
          const failed={...r,stage:'failed',failure:{supersededByHash:consumedByHash,blockNumber:status.blockNumber},networkBinding:binding};
          // Intent first; retrying the same proof also repairs an interrupted lane write.
          await retain(intent(hash),failed);
          if(latest?.hash===hash)await retain(lane(address),failed);
          return {disposition:'failed',hash,nonce:r.nonce,noResend:true,resolved:true,consumedByHash};
        }
        const status=await node('getTransactionStatus',{ hash });
        const storageWrite=r.signedTransaction.content.type==='storageProgram';
        if (storageWrite && status?.state==='failed') {
          const tx=await node('getTxByHash',{hash});
          if(tx?.status==='failed') return failedStorageWrite(hash,r,binding,status,tx);
        }
        if (status?.state !== 'included' || !Number.isSafeInteger(status.blockNumber)) {
          // A broadcast withheld at its last check was never sent: it is finished, and an interrupted lane write is repaired.
          if (!withheldBroadcast(r)) return { disposition:'pending',hash,nonce:r.nonce,noResend:true,...keptReferenceBlock(r) };
          if (latest?.hash === hash && latest.stage !== 'failed') await retain(lane(address),r);
          return { disposition:'failed',hash,nonce:r.nonce,noResend:true,resolved:true };
        }
        const proofStarted=monotonicNow(),cached=writeProofs.get(hash);
        writeProofs.delete(hash);
        const reused=cached && writeProof && canonicalize(writeProof)===canonicalize({disposition:'included',receipt:cached.receipt,noResend:true}) && sameContext(cached.context,await context()) && cached.signed===JSON.stringify(r.signedTransaction) && cached.receipt.blockNumber===status.blockNumber;
        const tx=reused?null:await node('getTxByHash',{hash});
        if(storageWrite && tx?.status==='failed') return failedStorageWrite(hash,r,binding,status,tx);
        if(agreement && r.signedTransaction.content.type==='native' && tx?.status==='failed'){
          if(!Number.isSafeInteger(status.blockNumber) || status.blockNumber<0 || tx.hash!==hash || tx.blockNumber!==status.blockNumber || !executedMatches(tx.content,r.signedTransaction.content,hash))fail('readback_unverified','the failed native transfer differs from the retained signed transaction');
          let resolved=r.stage==='failed';
          if(failedNonceFence!==undefined){
            if(!Number.isSafeInteger(failedNonceFence) || failedNonceFence<0 || r.nonce!==failedNonceFence+1)fail('invalid_params','the failed transfer must match the saved nonce fence');
            const nonce=nonceFromNode(await node('getAddressNonce',{address}));
            if(nonce!==failedNonceFence)return {disposition:'failed',hash,nonce:r.nonce,noResend:true,resolved:false};
            const block=await node('getBlockByNumber',{blockNumber:status.blockNumber});
            if(!includedInBlock(block,hash,status.blockNumber))fail('readback_unverified','the failed native transfer is absent from its confirmed block');
            // Retain the failed intent forever (no resend). Release only this
            // current lane after the bound read proves no nonce was consumed.
            const failed={...r,stage:'failed',failure:{blockNumber:status.blockNumber,nonceFence:failedNonceFence},networkBinding:binding};
            await retain(intent(hash),failed);
            if(latest?.hash===hash)await retain(lane(address),failed);
            resolved=true;
          }
          return {disposition:'failed',hash,nonce:r.nonce,noResend:true,resolved};
        }
        const receipt=reused?clone(cached.receipt):await inclusionReceipt(address,hash,r,binding,status,tx);
        if(!reused)step(r.signedTransaction,'readback-verified','complete',proofStarted);
        const observed={ ...r,stage:'observed',receipt,networkBinding:binding };
        await retain(intent(hash),observed);
        if(latest?.hash === hash)await retain(lane(address),observed);
        if(agreement) await pruneClaims(address,r.nonce);
        return { disposition:'included',receipt,noResend:true };
    }));
  }
  // The one explicit send of a native broadcast whose history shows no possible transmission. The capability alone names it: the
  // bytes are the retained ones, and `signRpc` only signs the RPC authentication. The lease, confirmation and broadcast run as for
  // any send, under the retained operation's id and the private pass context the capability was registered with, and each guard
  // admits these bytes only inside this scope. The capability is consumed before anything else can fail.
  async function reopenWithheldBroadcast({ capability, signRpc } = {}) {
    const { operationId, lane:laneKey, hash, privateContext }=reopenGrants.consume(capability);
    if(typeof signRpc !== 'function') fail('invalid_params','a reopen signs its RPC authentication with signRpc');
    const scope=Object.freeze({ operationId,lane:laneKey,hash });
    const tx=await requireNeverTransmitted(scope,'the retained native broadcast cannot be reopened'), address=tx.content.from;
    const authenticate=async () => {
      const identity=`ed25519:${address}`,timestamp=String(stamps.next(identity));
      return { identity,timestamp,signature:await signRpc(sha(`${identity}:${timestamp}`)) };
    };
    return reopening.run(scope,() => runInPassContext(privateContext,async () => {
      const { binding }=await implementation.binding({ phase:'bind',address });
      const { leaseId }=await implementation.binding({ phase:'signature',address,binding });
      try {
        const confirmation=await implementation.rpc({ method:'execute',params:[{ extra:'confirmTx',data:clone(tx) }] },await authenticate());
        if(confirmation?.result !== 200 || confirmation.response?.data?.valid !== true) fail('native_confirmation_required','the node did not confirm the retained transaction');
        await implementation.binding({ phase:'broadcast',address,leaseId,hash });
        return await implementation.rpc({ method:'execute',params:[{ extra:'broadcastTx',data:confirmation }] },await authenticate());
      } finally { await implementation.binding({ phase:'release',address,leaseId }); }
    }));
  }
  // Server-only recovery: never exposed through binding() or the wallet RPC.
  // The original operator authority supplies fresh RPC auth, not a new CREATE.
  async function recoverStorageWrite({ signedTransaction:tx, signRpc }) {
    const address=tx?.content?.from,hash=tx?.hash,op=tx?.content?.data?.[1];
    const operatorArtifact=demo && op?.metadata?.artifactBinding?.authority===demoDeclaration.authority;
    const sellerEvidence=settlement && op?.metadata?.artifactKind==='SettlementEvidence' && op?.data?.phase==='pay-dem';
    if(tx?.content?.type!=='storageProgram' || (!operatorArtifact&&!sellerEvidence) || typeof signRpc!=='function'
      || !ADDRESS.test(address ?? '') || !HASH.test(hash ?? '')) fail('storage_recovery_only','only an original operator storage CREATE may be recovered');
    const pass=currentPassContext(), pending={disposition:'pending',hash,noResend:true};
    // Recovery is a pass of the artifact's own operation, read from its signed record: it holds
    // the boundary's fence, and its confirmation and resend are boundary passes. An artifact the history does
    // not hold is read back only.
    const signed=(await historyOf({ lane:lane(address),artifactHash:sha(JSON.stringify(tx)) }).catch(() => [])).find((record) => record.state === 'signed');
    if(!signed) return pending;
    const underConnection=(work) => boundary.withOperation(signed,work).catch((error) => { if(error?.code?.startsWith('journal')) throw error; return pending; });
    return underConnection(()=>laneLock(address,async()=>{
      let r=await journal.get(intent(hash));
      const latest=await journal.get(lane(address));
      if(!r || JSON.stringify(r.signedTransaction)!==JSON.stringify(tx) || latest?.hash!==hash
        || JSON.stringify(latest.signedTransaction)!==JSON.stringify(tx) || r.nonce!==tx.content.nonce
        || r.stage!=='broadcast-accepted' || r.storageWriteSubmission!=='accepted'
        || r.storageWriteSubmissionProfile!==STORAGE_WRITE_SUBMISSION_PROFILE
        || (r.storageWriteResends ?? 0)!==0 || !Object.hasOwn(r,'storageWriteGas')) return pending;
        let binding;
        const originalContext=await context();
        const readNonce=async()=>{
          const answer=await raw({method:'nodeCall',params:[{message:'getAddressNonce',data:{address}}]});
          return rpcEnvelope(answer,200,null)?storageWriteAccountNonce(answer.response):null;
        };
        const absent=async()=>{
          const status=await raw({method:'nodeCall',params:[{message:'getTransactionStatus',data:{hash}}]});
          const found=await raw({method:'nodeCall',params:[{message:'getTxByHash',data:{hash}}]});
          const nonce=await readNonce();
          return storageWriteAbsent(status,found,r.storageWriteReferenceBlock) && nonce===storageWriteAccountNonce(r.nonce)-1
            && storageWriteAccountNonce(r.nonce)>0;
        };
        try {
          // The chain and the absence of the write are read here, before the confirmation. Between the confirmation and
          // the resend the node receives no write and no other confirmation. Only local checks run, plus at most one
          // getNetworkInfo read for the signature-domain check, made only when the kept answer is older than a minute.
          // That read never changes the kept reference block.
          binding=await storageRecoveryBinder.recover(r.networkBinding);
          if(!await absent()) return pending;
          const headers=async()=>{
            const identity=`ed25519:${address}`,timestamp=String(stamps.next(identity));
            return {identity,timestamp,signature:await boundary.signAuthentication(()=>signRpc(sha(`${identity}:${timestamp}`)))};
          };
          const confirmBody={method:'execute',params:[{extra:'confirmTx',data:clone(tx)}]},auth=await headers();
          signedTransaction(confirmBody,auth);
          await verifyTransactionSignature(tx);
          const confirms=(answer) => rpcEnvelope(answer,200,null) && storageWriteConfirmationMatches(answer.response)
            && answer.response.data.valid===true
            && storageConfirmationShapeMatches(answer.response.data)
            && JSON.stringify(answer.response.data.transaction)===JSON.stringify(tx)
            && canonicalize(answer.response.data.gas_operation ?? null)===canonicalize(r.storageWriteGas);
          const confirmation=await boundary.dispatchPass(signed,(bytes,final) => transmit(confirmBody,auth,{ final,pass }),{ explicit:true,stage:'recovery-confirm',material:(answer) => confirms(answer) ? {} : undefined });
          if(!confirms(confirmation)) return pending;
          const broadcastAuth=await headers();
          if(!sameContext(originalContext,await context())) return pending;
          const resendOnce=async(bytes,final)=>{
            // The domain may have changed since the confirmation or while the dispatch record was written: the signature
            // is checked again here, on a fresh read once the kept answer is past its lifetime, with nothing awaited
            // between that check and the reservation. A refusal reserves and sends nothing.
            await verifyTransactionSignature(tx);
            // Reserve the sole attempt before dispatch. A crash consumes it too;
            // reopening the journal can never start another retransmission loop.
            // The reservation also keeps the reference block of this exact-byte reconfirmation.
            r={...r,storageWriteResends:1,networkBinding:binding,storageWriteReferenceBlock:referenceBlockOf(confirmation)};
            await retain(intent(hash),r); await retain(lane(address),r);
            if(!sameContext(originalContext,await context())) fail('recovery_not_resendable','the connection changed after the resend was reserved');
            // Still under this lane's lock, just before the sole dispatch: report
            // the resent bytes' own signed job. Telemetry only; it cannot stop or
            // change the resend.
            const notice={hash,writer:address,jobId:op?.metadata?.artifactBinding?.jobId ?? op?.data?.jobId ?? null,artifactKind:op?.metadata?.artifactKind ?? null};
            // An async listener runs here too; its rejection is consumed, never left unhandled.
            for(const listener of resendListeners) { try { const result=listener({...notice}); void Promise.resolve(result).catch(()=>{}); } catch { /* telemetry cannot authorize or interrupt a write */ } }
            return transmit({method:'execute',params:[{extra:'broadcastTx',data:confirmation}]},broadcastAuth,{ final,pass });
          };
          // The resend's fee ceiling reads the debit of the signed transaction it resends, as the broadcast's does;
          // a refusal there comes before the attempt is reserved, and nothing is sent.
          const answer=await boundary.dispatchPass(signed,resendOnce,{ explicit:true,stage:'recovery-dispatch',confirmedDebitOs:signedDebitOs(signed.debitOs,tx.content.transaction_fee) });
          r={...r,storageWriteSubmission:classifyStorageWriteSubmission(answer,hash)};
          await retain(intent(hash),r); await retain(lane(address),r);
          return pending;
        } catch(error) {
          // Journal failures must reach the caller; uncertain reads/dispatch
          // leave the original nonce lane fenced for authenticated readback.
          if(error?.code?.startsWith('journal')) throw error;
          return pending;
        }
    }));
  }
  const implementation = {
    profile(publicOrigin) { return { profile:agreement?DEVNET_AGREEMENT_PROFILE:DEVNET_NATIVE_PROFILE,network:pinned.network,
      rpcUrl:`${publicOrigin}${DEVNET_NATIVE_RPC_PATH}`,bindingUrl:`${publicOrigin}${DEVNET_NATIVE_BINDING_PATH}`,
      ...(agreement?{transportBinding:declaration,agreementBroker:{enabled:true,kind:'explicit-pinned-source'},...(publication?{settlementPublication:publication}:{}),...(deliveryDeclaration?{deliveryPublication:deliveryDeclaration}:{}),...(demoDeclaration?{demoArtifactPublication:demoDeclaration}:{})}:{}),
      capabilities:{ native:true,identity:false,publication:false,agreementCreate:agreement,settlementEvidenceCreate:settlement,deliverableCreate:delivery,demoArtifactCreate:demo },
      evidenceMode:'explicit-pinned-transport-single-node',authority:pinned.transportAuthority,
      limits:'source capability only; no default live authority, independent review, native purchase commitment or finality' }; },
    async binding(request) {
      const { phase,address }=request ?? {};
      if (!ADDRESS.test(address ?? '')) fail('invalid_params','the native wallet address is required');
      if (phase === 'readback') return readback(address,request.hash,request.writeProof,request.failedNonceFence,request.consumedByHash);
      if (phase === 'release') { const l=byAddress.get(address); if(l?.id === request.leaseId) await releaseLease(l); return { released:true }; }
      if (phase === 'bind') {
        const binding=await fenced(() => binder.bind(), address);
        const r=await journal.get(lane(address));
        return { binding,pending:r && !['observed','failed'].includes(r.stage) ? { hash:r.hash,nonce:r.nonce,stage:r.stage } : null };
      }
      if (phase === 'signature') {
        const reopen=reopening.getStore();
        await releaseExpiredLeases();
        if (byAddress.has(address)) fail('wallet_fenced','a signature connection lease already exists');
        const previous=await journal.get(lane(address));
        await refuseUnfinished(previous,'the retained native transfer must be read back; it is never resent',reopen);
        const transfer=declaredTransfer(request.transfer);
        if (await cancelledTransfer(address,transfer)) await refuseCancelled(address,transfer,'signature');
        // A seller job's pass names the job's own operation id; any other lease is its own operation.
        const leaseId=randomBytes(16).toString('hex'), operationId=currentPassContext().operationId ?? leaseId, fence=await acquireLeaseFence(address,operationId,transfer);
        let l;
        try {
          if (!fence || typeof fence.release !== 'function' || !sameContext(await context(),fence.context)) fail('invalid_transport_owner','actual signature connection fence is unavailable');
          const retained=await journal.get(lane(address));
          await refuseUnfinished(retained,'an issued native transfer appeared while acquiring the connection fence',reopen);
          const binding=await binder.beforeSignature(await binder.recover(request.binding));
          const grant=async () => {
            if (byAddress.has(address)) fail('wallet_fenced','a signature connection lease already exists');
            const latest=await journal.get(lane(address));
            await refuseUnfinished(latest,'an issued native transfer appeared while acquiring the connection fence',reopen);
            if (await cancelledTransfer(address,transfer)) await refuseCancelled(address,transfer,'signature');
            const lease={ id:leaseId,operationId,address,fence,binding,expiresAt:now()+leaseMs,confirmed:null,readyHash:null,signStarted:monotonicNow(),busy:0,transfer:null };
            // Claimed durably before it is returned: a cancellation in any
            // process sees it (transferClaimed).
            if (transfer) await claimTransfer(lease,transfer);
            // Expiry refuses further actions. Its connection is freed by the next
            // fence acquisition (releaseExpiredLeases) or by the
            // lease's own timer, and when the last running call ends, never
            // underneath a running confirm or broadcast. Provider release / app
            // close ends it earlier.
            l=lease; leases.set(l.id,l); byAddress.set(address,l);
            // Other operations take the owner's fence directly, so an abandoned lease frees it at its expiry.
            l.expiryTimer=setTimeout(() => { void releaseExpiredLeases().catch(() => {}); },leaseMs+LEASE_EXPIRY_MARGIN_MS).unref();
            return { binding,leaseId:l.id,expiresAt:l.expiresAt };
          };
          // A lease that names its transfer is granted under the lane lock: a
          // cancellation (cancelNativeTransfer) either sees its claim or the
          // lease sees the cancellation's record. One that names none (an
          // Agreement CREATE, a seller write, an older page) claims nothing
          // until its confirmTx, so it is granted as before, without the lock.
          return await (transfer ? journal.withWalletLock(lane(address),grant) : grant());
        } catch(error) { if(!l) await fence?.release?.(); throw error; }
      }
      if (phase === 'broadcast') {
        const { l, release }=await claimLease(address);
        try {
          if(l.id !== request.leaseId || !HASH.test(request.hash ?? '') || l.confirmed?.hash !== request.hash) fail('native_confirmation_required','the exact signed native confirmation is required');
          // Told here, before the wallet broadcasts, the wallet knows nothing
          // was sent (the SDK reports any broadcastTx refusal as unknown). The
          // broadcast claim below still decides, under the lane lock.
          const confirmed=await identityOf(l.confirmed.content);
          if(await cancelledTransfer(address,confirmed)) await refuseCancelled(address,confirmed,'pre-broadcast');
          await refuseWhileReserved(address,request.hash);
          // A CREATE's chain read ran before its confirmation; nothing here reads the node for it.
          if(l.confirmed.content.type !== 'storageProgram')l.binding=await binder.beforeBroadcast(l.binding);
          if(!sameContext(await context(),l.fence.context)) fail('connection_changed','the connection changed before broadcast');
          l.readyHash=request.hash;
          return { binding:l.binding,leaseId:l.id };
        } finally { await release(); }
      }
      fail('invalid_params','unknown native binding phase');
    },
    async rpc(body, headers) {
      const call=body?.params?.length === 1 ? body.params[0] : null;
      if(body?.method === 'nodeCall' && ['getNetworkInfo','getNetworkParameters','getAddressNonce'].includes(call?.message)) return rawWithoutWriteProof(body,headers);
      if(body?.method !== 'execute' || !['confirmTx','broadcastTx'].includes(call?.extra)) fail('native_only','this transport exposes only native sends and their preparation reads');
      // The pass's private context, read once here: it alone says which job class and current-authorization check the transmission has.
      const pass=currentPassContext(), reopen=reopening.getStore();
      const tx=signedTransaction(body,headers), { l, release }=await claimLease(tx.content.from);
      try {
      await verifyTransactionSignature(tx);
      const create=tx.content.type === 'storageProgram';
      if(call.extra === 'confirmTx') {
        l.confirmed=null;l.readyHash=null;
        const issuedBefore=await journal.get(intent(tx.hash));
        if(issuedBefore && !withheldBroadcast(issuedBefore)){refuseRetiredPin(issuedBefore);await refuseIssued(tx.hash,'an issued native hash is readback-only, never reconfirmed or resent',reopen);}
        const transfer=await identityOf(tx.content);
        // A transfer whose settlement terms cannot be read, or whose payer is
        // not its signer, is not one the cancellation records can name.
        if(transfer && !transfer.readable)fail('transfer_unreadable',TRANSFER_REFUSALS.transfer_unreadable);
        // Exactly the payload the lease named, if it named one: a wallet
        // cannot name one transfer and sign another.
        if(l.transfer && !samePayload(l.transfer,transfer))fail('transfer_mismatch',TRANSFER_REFUSALS.transfer_mismatch);
        // Before the node sees a transfer, under the lane lock: refused if
        // cancelled, otherwise claimed (a lease that named none) and marked as
        // having reached confirmTx, so a cancellation in any process sees it.
        if(transfer)await journal.withWalletLock(lane(tx.content.from),async()=>{
          if(await cancelledTransfer(tx.content.from,transfer))await refuseCancelled(tx.content.from,transfer,'confirmTx');
          await claimTransfer(l,transfer,true);
        });
        step(tx,'sign','complete',l.signStarted);
        await continueSignedOperation(l,tx);
        // A CREATE's chain read happens here, under the operation's fence and before its confirmation. After the
        // confirmation the node receives only its broadcast, plus at most one getNetworkInfo read for the broadcast's
        // signature-domain check, made only when the kept answer is older than a minute.
        if(create)l.binding=await binder.beforeBroadcast(l.binding);
        // An acknowledged confirmation is final for its bytes: in the operation that holds it, a repeated
        // confirmation is answered from the retained record and the node is not asked again.
        const retained=await retainedConfirmation({ lane:lane(tx.content.from),artifactHash:sha(JSON.stringify(tx)) },{ current:reopen?.hash === tx.hash });
        if(retained?.operationId === l.operationId) {
          await approveConfirmation(retained.confirmation);
          l.confirmed=clone(tx);
          return retained.confirmation;
        }
        const started=monotonicNow();
        let accepted=false;
        const confirmOnce=async(bytes,final)=>{
          const answer=await transmitWithoutWriteProof(body,headers,{ final,pass });
          step(tx,'validate','complete',started);
          accepted=acceptsConfirmation(answer,tx);
          return answer;
        };
        const answer=await confirmAsStage(l,tx,confirmOnce,() => accepted);
        // The node's acknowledgement is retained first, so a refusal here never sends the bytes to the node again.
        if(accepted) { await approveConfirmation(answer); l.confirmed=clone(tx); }
        return answer;
      }
      if(l.readyHash !== tx.hash || JSON.stringify(l.confirmed) !== JSON.stringify(tx)) fail('native_confirmation_required','the original signed transaction and fresh broadcast binding are required');
      // The broadcast carries the retained confirmation exactly, gas included, and its signed debit is checked against the ceiling.
      const artifact={ ...operationOf(l,tx),artifactHash:sha(JSON.stringify(tx)) };
      const retained=await retainedConfirmation(artifact);
      if(JSON.stringify(call.data) !== JSON.stringify(retained?.confirmation)) fail('native_confirmation_required','the retained node confirmation, gas included, is required');
      let accepted;
      try {
        // A node fee view other than the signed fees is refused before any lane or dispatch record; the lease ends.
        if(!feeViewIsSigned(retained.gasOperation,tx.content.transaction_fee)) fail('fee_view_mismatch',TRANSFER_REFUSALS.fee_view_mismatch);
        accepted = await laneLock(tx.content.from,async () => {
          // The signer's reservation lock is the one lock an evidence CREATE takes to claim the signer, and each side checks the other's
          // record inside it. It is held from the reservation check through the dispatch pass, which writes this lane record, so a stored
          // evidence CREATE and this write never take the same nonce, and a refusal before the dispatch leaves no lane record.
          return journal.withWalletLock(signerReservationKey(pinned,tx.content.from),async () => {
            await refuseWhileReserved(tx.content.from,tx.hash);
            const previous=await journal.get(lane(tx.content.from));
            const issuedBefore=await journal.get(intent(tx.hash));
            const rowsIssued=(previous && (!['observed','failed'].includes(previous.stage) || (previous.hash === tx.hash && !withheldBroadcast(previous)))) || (issuedBefore && !withheldBroadcast(issuedBefore));
            if(rowsIssued) { refuseRetiredPin(previous); refuseRetiredPin(issuedBefore); }
            // Inside a reopen the history is read again under the lane lock, with or without rows; outside one, issued rows refuse.
            if(rowsIssued || reopen?.hash === tx.hash) await refuseIssued(tx.hash,'issued native transfers cannot be resent',reopen);
            // The reopened hash's rows, both still at broadcast-started, already name these bytes: retaining them again would overwrite
            // them, so only the answer updates them.
            const rowsKept=rowsIssued && previous?.hash === tx.hash;
            // Under the lock of the journal claim below: a cancelled transfer is never claimed.
            const claiming=await identityOf(tx.content);
            if(await cancelledTransfer(tx.content.from,claiming)) await refuseCancelled(tx.content.from,claiming,'broadcast');
            const binding=create ? l.binding : await binder.beforeBroadcast(l.binding);
            if(!sameContext(await context(),l.fence.context)) fail('connection_changed','the fenced connection changed');
            if(tx.content.type==='native' && nonceFromNode(await node('getAddressNonce',{address:tx.content.from}))>=tx.content.nonce) fail('nonce_consumed','the bound sender nonce was already consumed; no native intent was issued');
            const issued=rowsKept ? clone(previous) : { stage:'broadcast-started',hash:tx.hash,nonce:tx.content.nonce,signedTransaction:clone(tx),networkBinding:clone(binding) };
            if(!rowsKept && create) { issued.storageWriteGas=clone(call.data?.response?.data?.gas_operation ?? null); issued.storageWriteReferenceBlock=referenceBlockOf(call.data); }
            // The one transmission, with the lane's intent retained just before it.
            const dispatch=async(bytes,final)=>{
              if(!rowsKept) {
                await retain(lane(tx.content.from),issued);
                await retain(intent(tx.hash),issued);
              }
              const started=monotonicNow();
              let answer,sending=false,withheld=false;
              // Notes a refusal by the last check, which comes before the request: then nothing was sent.
              const last=async(check,effect)=>{
                try { return await final(check,() => { sending=true; return effect(); }); } catch(error) { withheld=!sending; throw error; }
              };
              try { answer=await transmitWithoutWriteProof(body,headers,{ final:last,pass }); } // one call, never retry on unknown; the inclusion poll below is the only source of a writeProof
              catch(error){
                // Refused before the request, the lane is finished here while its locks are held, so it holds no
                // lane and is not read back as pending. Intent first, as readback repairs an interrupted lane write.
                if(withheld) {
                  const finished={ ...issued,stage:'failed',failure:{ withheld:true } };
                  await retain(intent(tx.hash),finished).then(() => retain(lane(tx.content.from),finished)).catch(() => {});
                } else step(tx,'broadcast','unknown',started);
                throw error;
              }
              step(tx,'broadcast','complete',started);
              const answered={ ...issued,stage:answer?.result === 200 ? 'broadcast-accepted' : 'broadcast-answered' };
              if(tx.content.type==='storageProgram') {
                answered.storageWriteSubmission=classifyStorageWriteSubmission(answer,tx.hash);
                answered.storageWriteSubmissionProfile=STORAGE_WRITE_SUBMISSION_PROFILE;
              }
              await retain(intent(tx.hash),answered); await retain(lane(tx.content.from),answered);
              return answer;
            };
            // The wallet's broadcast is a fresh request of its own: a dispatch an earlier lease withheld before its send goes on.
            // The pass's authority is checked before the lane and intent are retained, so a job withdrawn by now leaves the lane free.
            return l.fence.hold.run(() => boundary.dispatchPass(artifact,dispatch,{ explicit:true,stage:'dispatch',confirmedDebitOs:signedDebitOs(artifact.debitOs,tx.content.transaction_fee),authorize:() => assertCurrentAuthorization(pass) }));
          });
        });
        if (accepted?.result === 200) {
          const started=monotonicNow(),deadline=started+inclusionWaitMs;
          for (let polls = Math.ceil(inclusionWaitMs / inclusionPollMs); !closed && polls > 0 && monotonicNow()<deadline; polls--) {
            let status;
            try {
              if (!sameContext(await context(),l.fence.context)) break;
              status = await node('getTransactionStatus',{ hash:tx.hash });
            } catch { break; }
            if (status?.state === 'included' && Number.isSafeInteger(status.blockNumber)) {
              step(tx,'inclusion','complete',started);
              try {
                // Bind the proof to the connection it is read on: capture the
                // context before the reads (still the lease's fenced one) and
                // keep the proof only if that connection is current after them.
                const observedContext=await context();
                if(!sameContext(observedContext,l.fence.context)) fail('connection_changed','the fenced connection changed before the inclusion proof');
                const proofStarted=monotonicNow(),issued=await journal.get(intent(tx.hash));
                const binding=await binder.recover(issued.networkBinding);
                const receipt=await inclusionReceipt(tx.content.from,tx.hash,issued,binding,status);
                if(!sameContext(await context(),observedContext)) fail('connection_changed','the connection changed while the inclusion proof was read');
                step(tx,'readback-verified','complete',proofStarted);
                if(writeProofs.size>=256)writeProofs.delete(writeProofs.keys().next().value);
                writeProofs.set(tx.hash,{receipt:clone(receipt),context:clone(observedContext),signed:JSON.stringify(tx)});
                accepted={...accepted,writeProof:{disposition:'included',receipt,noResend:true}};
              } catch { /* accepted hash remains readback-only if proof is unavailable */ }
              break;
            }
            const remaining=deadline-monotonicNow();
            if(remaining>0)await sleep(Math.min(inclusionPollMs,remaining));
          }
        }
      } finally { await stopLease(l,true); } // the lane journal holds whatever was sent
      return create ? { ...accepted,referenceBlock:referenceBlockOf(retained.confirmation) } : accepted;
      } finally { await release(); }
    },
    // Binding requests from a wallet, through any HTTP relay. bind and
    // signature need the sender's own RPC auth headers, as confirmTx and
    // broadcastTx do; broadcast and release need the lease's secret id, and
    // readback only reads. Server-side callers use binding() directly; only
    // they may pass the lane proofs failedNonceFence and consumedByHash.
    async walletBinding(request, headers) {
      if (request && typeof request === 'object' && ['failedNonceFence','consumedByHash'].some((k) => Object.hasOwn(request,k))) fail('invalid_params','server-only lane proofs are not accepted from a wallet relay');
      if (['bind','signature'].includes(request?.phase)) senderAuth(request.address, headers);
      return implementation.binding(request);
    },
  };
  function tracked(work) {
    if(closed) return Promise.reject(Object.assign(new Error('the native transport is closed'),{code:'transport_closed'}));
    const task=Promise.resolve().then(work);
    inFlight.add(task);
    void task.then(()=>inFlight.delete(task),()=>inFlight.delete(task));
    return task;
  }
  // Passive diagnostics: one closed read-only sequence. It writes no journal
  // record or claim and does no lane or nonce recovery; it only recovers the
  // retained network binding (or binds afresh) under the source-read lock and
  // one connection fence, then reads status, body and block once each through
  // the SDK core. Included facts need this exact hash's retained native intent,
  // and the one body the core validated must match its signed content. Only an
  // explicit allowUnretained:true (non-native diagnostics) permits an absent
  // intent, returning unqualified core facts without sourceDisposition.
  // Resolves the core observation, a retained included one as {...,sourceDisposition:
  // 'included'}; rejects invalid_params, readback_unverified, a binding
  // failure, or the abort reason (caller, close(), or OutboundError 'timeout').
  // Abort contract: fetchImpl and transportOwner honour AbortSignal and settle.
  // An abort stops new steps and aborts requests, and close() aborts and then
  // waits for reads that are running. An abort or the deadline ends a wait for
  // the source-read lock or the connection fence at once. After that, no read
  // runs, and a lock or fence granted after the abort is released without a
  // read. close() does not wait for an ended lock or fence wait, which goes on
  // until the lock or fence is granted or the journal gives up on the lock
  // with 'journal-busy'.
  async function observePassiveTransfer(hash, options={}) {
    if(typeof hash!=='string' || !HASH.test(hash)) fail('invalid_params','a canonical native transaction hash is required');
    const stop=AbortSignal.any([closing.signal,...(options.signal?[options.signal]:[])]);
    return tracked(()=>observeWithDeadline(({signal})=>passiveRead(hash,signal,options.allowUnretained===true),{timeoutMs:PASSIVE_TRANSFER_TIMEOUT_MS,signal:stop}));
  }
  async function passiveRead(hash, signal, allowUnretained) {
    const issued=await journal.get(intent(hash));
    const retained=Boolean(issued?.hash===hash && issued.signedTransaction?.hash===hash && issued.signedTransaction.content?.type==='native' && issued.networkBinding);
    const reads=[]; let body, nestedEnvelope=false;
    const refuseEnvelope=()=>fail('readback_unverified','the passive observation has an additional response envelope');
    const read=(message,data)=>{ const answer=node(message,data,{signal}).then(value=>{
      if(message!=='getTxByHash' && value && Object.hasOwn(value,'response')) { nestedEnvelope=true; refuseEnvelope(); }
      return value;
    }); reads.push(answer); return answer; };
    const client={ getTransactionStatus:(h)=>read('getTransactionStatus',{hash:h}), getBlockByNumber:(n)=>read('getBlockByNumber',{blockNumber:n}),
      getTxByHash:async(h)=>{ const tx=await read('getTxByHash',{hash:h}); body=clone(tx); return tx; } };
    const result=await lockUnlessAborted(signal,'devnet/source-read/'+declaration.bindingId,()=>fenced(async()=>{
      signal.throwIfAborted();
      const c=await context(), binder=makeBinder(false,signal);
      await (retained ? binder.recover(issued.networkBinding) : binder.bind());
      // The core reads body and block together; the fence is held until both settle.
      const observation=await observePayDemTransferCore(hash,client).finally(()=>Promise.allSettled(reads));
      signal.throwIfAborted();
      if(!sameContext(await context(),c)) fail('connection_changed','the connection changed during passive observation');
      return observation;
    },undefined,signal));
    // The core converts read errors to observations; keep this boundary's refusal after draining reads.
    if(nestedEnvelope) refuseEnvelope();
    if(result.status!=='included') return result;
    if(allowUnretained && issued==null) return result;
    if(!retained || body===undefined) fail('readback_unverified','the included native transfer has no retained original signed transaction');
    // node() removed the RPC envelope; the core must interpret this same body.
    if(Object.hasOwn(body,'response')) fail('readback_unverified','the included native transfer has an additional response envelope');
    if(!executedMatches(body.content,issued.signedTransaction.content,hash)) fail('readback_unverified','the included native transfer differs from the retained original signed transaction');
    return {...result,sourceDisposition:'included'};
  }
  const capability = Object.freeze({
    ...(reopenGrants?{reopenWithheldBroadcast:(request)=>tracked(()=>reopenWithheldBroadcast(request))}:{}),
    ...(demo?{withWalletNonceLock:(scope,work)=>tracked(()=>withWalletNonceLock(scope,work))}:{}),
    ...(settlement?{recoverStorageWrite:(request)=>tracked(()=>recoverStorageWrite(request)),
      onStorageWriteResend(listener) { if(typeof listener!=='function')throw new TypeError('resend listener required');resendListeners.add(listener);return()=>resendListeners.delete(listener); }}:{}),
    ...(agreement?{pins:pinned,transportBinding:declaration,journal,...(publication?{settlementPublication:publication}:{}),...(deliveryDeclaration?{deliveryPublication:deliveryDeclaration}:{}),...(demoDeclaration?{demoArtifactPublication:demoDeclaration}:{}),
      inspectWalletNonceLane:(scope)=>tracked(()=>inspectWalletNonceLane(scope)),
      // What the source, in any process on this journal, has claimed of one
      // prepared transfer (payload: the unsigned transfer the plugin handed
      // to the wallet), with no network read: 'signature-lease', the stage of
      // a retained transfer with its terms, or null.
      nativeTransferClaimed:(address,payload)=>tracked(async()=>{
        const transfer=await identityOf(payload?.content);
        if(!transfer?.readable || !ADDRESS.test(address ?? '')) fail('invalid_params','an exact native transfer is required');
        return transferClaimed(address,transfer);
      }),
      // Whether this source keeps a cancelled payment (cancelNativeTransfer)
      // with the settlement terms of one prepared transfer by this payer, so
      // it refuses that transfer at every gate: the same records and
      // comparison as those refusals (cancelledTransfer), read from this
      // durable journal with no network read, lock or write.
      nativeTransferCancelled:(address,payload)=>tracked(async()=>{
        const transfer=await identityOf(payload?.content);
        if(!transfer?.readable || !ADDRESS.test(address ?? '') || payload.content.from!==address) fail('invalid_params','an exact native transfer by this payer is required');
        return (await cancelledTransfer(address,transfer)) !== null;
      }),
      // Whether this source refuses one prepared transfer by this payer for a
      // cancelled payment's terms, read from this durable journal with no
      // network read, lock or write: { cancelled, refusal }, cancelled while
      // it keeps such a cancellation (as nativeTransferCancelled), refusal
      // ({ gate, refusedAt }) once it refused this exact payload for one
      // (refusedKey), which outlives that record; null when neither. Either
      // way nothing with these terms was sent through this source: such a
      // record is kept only while nothing with them is claimed or retained
      // unread (cancelNativeTransfer), every gate refuses them while it is
      // kept, and it is pruned only once the chain has used their nonce.
      nativeTransferRefused:(address,payload)=>tracked(async()=>{
        const transfer=await identityOf(payload?.content);
        if(!transfer?.readable || !ADDRESS.test(address ?? '') || payload.content.from!==address) fail('invalid_params','an exact native transfer by this payer is required');
        const refused=(await journal.get(refusedKey(address)))?.refusals?.find((r)=>samePayload(r,transfer)) ?? null;
        const cancelled=(await cancelledTransfer(address,transfer)) !== null;
        return refused || cancelled ? { cancelled,refusal:refused ? { gate:refused.gate,refusedAt:refused.refusedAt } : null } : null;
      }),
      // What used the nonce of one prepared transfer by this payer, as this
      // source retained and reads it back, sending nothing: { hash, sameTerms }
      // for its retained write by this payer at that nonce on the pinned
      // network that reads back included (readback; an observed one already
      // did), sameTerms when that write has this transfer's settlement terms;
      // 'pending' while such a write is retained but not read back included
      // or failed; null when it retained none but failed ones (the nonce was
      // used outside this source).
      nativeNonceConsumer:(address,payload)=>tracked(async()=>{
        const transfer=await identityOf(payload?.content);
        if(!transfer?.readable || !ADDRESS.test(address ?? '') || payload.content.from!==address) fail('invalid_params','an exact native transfer by this payer is required');
        const retained=new Map();
        for(const [key,r] of await journal.entries()) {
          const issued=key.startsWith('devnet/native-transfer/');
          if((issued || key===lane(address)) && r?.signedTransaction?.content?.from===address && r.nonce===transfer.nonce && HASH.test(r.hash ?? '')
            && r.networkBinding?.network===pinned.network && r.networkBinding.chainIdentity===pinned.chainIdentity && (issued || !retained.has(r.hash))) retained.set(r.hash,r);
        }
        let pending=false;
        for(const [hash,r] of retained) {
          if(r.stage==='failed') continue;
          let read;
          try { read=r.stage==='observed' ? { disposition:'included' } : await readback(address,hash); }
          catch { pending=true; continue; }
          if(read.disposition==='included') return { hash,sameTerms:sameTransfer(transferOf(r.signedTransaction.content),transfer) };
          if(read.disposition!=='failed') pending=true;
        }
        return pending ? 'pending' : null;
      }),
      // The plugin's cancellation of one native payment handoff (operationId,
      // and payload as above), under the payer's lane lock. Once the source
      // has claimed that transfer it is not cancelled: a payment may be on its
      // way. Otherwise unissued(), the plugin's proof that nothing was sent,
      // decides, and a cancellation keeps the transfer's settlement terms
      // (and its payload digest), durably, before it is reported, so the
      // source never confirms or sends a transfer that could settle it,
      // however it was re-signed. The payload must carry its own time, as the
      // one the wallet names does.
      cancelNativeTransfer:({address,operationId,payload,unissued})=>tracked(async()=>{
        const transfer=await identityOf(payload?.content);
        if(!transfer?.readable || !Number.isSafeInteger(payload.content.timestamp) || payload.content.timestamp<=0 || !ADDRESS.test(address ?? '') || payload.content.from!==address
          || typeof operationId!=='string' || !operationId || typeof unissued!=='function') fail('invalid_params','an exact prepared native transfer by this payer is required');
        return journal.withWalletLock(lane(address),async()=>{
          const claimed=await transferClaimed(address,transfer);
          if(claimed) return { cancelled:false,claimed };
          if(await unissued()!==true) return { cancelled:false,claimed:null };
          // Transfers below this nonce can no longer be valid: the chain already used it.
          const held=(await journal.get(cancelledKey(address)))?.transfers?.filter((t)=>t.nonce>=transfer.nonce) ?? [];
          await retain(cancelledKey(address),{ cancelledPayments:'dacs-chatgpt-plugin/cancelled-native-payments/v2',transfers:[...held,{ ...termsOf(transfer),operationId,cancelledAt:new Date(now()).toISOString() }] });
          await pruneClaims(address,transfer.nonce-1);
          return { cancelled:true,claimed:null };
        });
      }),
      // Server-only, read-free proof: even an acquiring lease or finishing RPC can still issue evidence.
      // An expired lease with no running confirm/broadcast can issue nothing (claimLease); fenced() frees it.
      isWalletIdle:(address)=>{ const l=byAddress.get(address); return ADDRESS.test(address??'') && !closed && (!l || (l.expiresAt<=now() && l.busy===0)) && inFlight.size===0; },
      // observeBinding({signal, timeoutMs}) and readRpc(path, body, {signal, maxBytes}) take the
      // journal lock and the fence (sourceRead); a deadline or reply limit above the transport's is refused.
      observeBinding:async({signal,timeoutMs:bindTimeoutMs=timeoutMs}={})=>{
        if(!Number.isSafeInteger(bindTimeoutMs) || bindTimeoutMs<1 || bindTimeoutMs>timeoutMs) fail('invalid_params','an observation deadline is an integer from 1 to the transport timeout');
        return sourceRead(signal,()=>makeBinder(false,signal,bindTimeoutMs).bind());
      },
      readRpc:(path,body,options)=>observe(path,body,options),
      chainReader:()=>{
        const reader=createDemosChainReader({rpcUrl:pinned.endpoint,network:pinned.network,pinnedIdentity:pinned.chainIdentity,fetchImpl:async(url,options={})=>new Response(JSON.stringify(await capability.readRpc(new URL(url).pathname,options.body?JSON.parse(options.body):undefined,{signal:options.signal})),{status:200,headers:{'content-type':'application/json'}})});
        async function observeTransfer(hash,purchase=false,options){
          const result=await reader.observeTransfer(hash,options);
          options?.signal?.throwIfAborted();
          if(result.status==='included'){
            const issued=await journal.get(intent(hash));
            if(issued?.signedTransaction?.content?.type==='native'){
              const observed=await capability.binding({phase:'readback',address:issued.signedTransaction.content.from,hash});
              if(observed.disposition!=='included' && !(purchase && observed.disposition==='failed'))fail('readback_unverified','included payment facts do not resolve the retained original signed transfer');
              if(purchase)return {...result,sourceDisposition:observed.disposition};
            }
          }
          return result;
        }
        // Only buyer verification may inspect a failed execution's included slot;
        // it carries the source verdict so a later body read cannot outrank it.
        return {...reader,observeTransfer:(hash,options)=>observeTransfer(hash,false,options),observePurchaseTransfer:(hash,options)=>observeTransfer(hash,true,options),observePassiveTransfer};
      }}:{}),
    onPurchaseStep(listener) { if(typeof listener!=='function')throw new TypeError('timeline listener required');stepListeners.add(listener);return()=>stepListeners.delete(listener); },
    profile:implementation.profile,
    binding:(request)=>tracked(()=>implementation.binding(request)),
    walletBinding:(request,headers)=>tracked(()=>implementation.walletBinding(request,headers)),
    rpc:(body,headers)=>tracked(()=>implementation.rpc(body,headers)),
    reserveRpcAuth,
    async close() {
      closed=true; // admit no new work while draining bounded in-flight RPC
      closing.abort(Object.assign(new Error('the native transport is closed'),{code:'transport_closed'}));
      await Promise.allSettled([...inFlight]);
      for(const l of [...leases.values()]) await stopLease(l);
    },
  });
  (demo?demoCapabilities:delivery?deliveryCapabilities:settlement?settlementCapabilities:agreement?agreementCapabilities:capabilities).add(capability); return capability;
}
