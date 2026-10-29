// Explicit source capability, DEFAULT ABSENT. No environment/model option,
// default chain pin, signer, key custody or review approval exists here.
// The caller supplies independently trusted pins, the actual transport owner
// and an existing durable public journal. Tests may supply labelled TEST
// authority; that is not provided live authority or independent validation.
import { isNativeDeliveryEvidence } from '../dacs/delivery-evidence.mjs';
import { classifyStorageWriteSubmission, storageWriteAbsent, storageWriteAccountNonce, storageWriteConfirmationMatches, storageWriteIdentityMatches, rpcEnvelope, STORAGE_WRITE_SUBMISSION_PROFILE } from '../devnet-demo/storage-write-recovery.mjs';
import { storageConfirmationShapeMatches, nativePayloadDigest } from './payload-helpers.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { createDemosNetworkBinder } from '../dacs/network-binding.mjs';
import { fetchBoundedJson, observeWithDeadline } from '../util/http.mjs';
import { verifyDemosSignature } from '../signatures.mjs';
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
// and one whose settlement terms the source cannot read (confirmTx): this
// attempt was not sent, so relays say so with 409, never the 500 that reads as
// an unknown outcome. The cancelled payment may be another purchase's with the
// same terms, so the refusal names the terms, not the purchase.
const PAYMENT_CANCELLED = 'this transfer has the terms of a cancelled payment; the operator\'s source refuses it, so this attempt was not sent (an earlier attempt may have been; readback shows it)';
const TRANSFER_REFUSALS = Object.freeze({
  payment_cancelled: PAYMENT_CANCELLED,
  transfer_mismatch: 'this transaction is not the transfer its signature lease named; the operator\'s source refuses it, so this attempt was not sent',
  transfer_unreadable: 'the operator\'s source cannot read one payer, payee and amount in this transfer, paid by its signer; it refuses it, so this attempt was not sent',
});
export const transferRefusal = (error) => Object.hasOwn(TRANSFER_REFUSALS,error?.code ?? '')
  ? [409,{ error:error.code,message:TRANSFER_REFUSALS[error.code],result:409,response:TRANSFER_REFUSALS[error.code],require_reply:false,extra:null }] : null;
const clone = (v) => structuredClone(v);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const envelope = (response, result = 200) => ({ result, response, require_reply: false, extra: null });

export const isDevnetNativeTransport = (v) => Boolean(v && capabilities.has(v));
export const isDevnetAgreementTransport = (v) => Boolean(v && (agreementCapabilities.has(v) || settlementCapabilities.has(v) || deliveryCapabilities.has(v) || demoCapabilities.has(v)));
export const isDevnetSettlementTransport = (v) => Boolean(v && (settlementCapabilities.has(v) || deliveryCapabilities.has(v) || demoCapabilities.has(v)));
export const isDevnetDeliveryTransport = (v) => Boolean(v && (deliveryCapabilities.has(v) || demoCapabilities.has(v)));
export const isDevnetDemoTransport = (v) => Boolean(v && demoCapabilities.has(v));

// transportOwner owns the ACTUAL endpoint/connection. acquireConnectionFence()
// returns { context, release() }, holding that connection until release; its
// { address } argument names the wallet the fence is for, if any. The
// consumer retains it across browser-local signature, SDK confirm and one
// broadcast. Copying expected values into getContext is not authority; the
// independently trusted caller must bind these methods to its actual egress.
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
function constructTransport({ expected, transportOwner, journal, fallback = null, blockZeroErrorEnvelope = null, blockOneLayout = null, reviewedBlockTwoHash = null,
  fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 10000,
  leaseMs = 30000, inclusionWaitMs = 120000, inclusionPollMs = 500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  settlementPublication = null, deliveryPublication = null, demoArtifactPublication = null, approveConfirmedWrite = null } = {}, agreement = false, settlement = false, delivery = false, demo = false) {
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
    if(started!==undefined) fields.durationMs=Math.max(0,fields.timestampMs-started);
    for(const listener of stepListeners) { try { listener(fields); } catch { /* telemetry cannot authorize or interrupt a write */ } }
  };
  let closed = false;
  // close() aborts the cancellable reads it drains (observePassiveTransfer).
  const closing = new AbortController();
  // The protected binder validates the exact source-supplied HTTPS pin schema.
  // There is no observed-node pin admission or default fallback here.
  const pinned = expected ? Object.freeze({ ...expected }) : expected;
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
    || settlementPublication.phase !== 'pay-dem' || settlementPublication.railId !== 'demos-native:DEM' || settlementPublication.phaseIndex !== 2
    || typeof settlementPublication.authority !== 'string' || !settlementPublication.authority.startsWith('TEST-'))) throw new TypeError('an exact explicit TEST SettlementEvidence publication policy is required');
  if (!settlement && settlementPublication !== null) throw new TypeError('SettlementEvidence policy requires the separate settlement transport constructor');
  const publication = settlement ? Object.freeze(clone(settlementPublication)) : null;
  if (delivery && (!deliveryPublication || JSON.stringify(Object.keys(deliveryPublication).sort()) !== JSON.stringify(['artifactKind','authority','phase','phaseIndex','policy'])
    || deliveryPublication.policy !== DEVNET_DELIVERY_POLICY || deliveryPublication.artifactKind !== 'Deliverable'
    || deliveryPublication.phase !== 'deliver-storage-program' || !Number.isSafeInteger(deliveryPublication.phaseIndex) || deliveryPublication.phaseIndex < 0
    || typeof deliveryPublication.authority !== 'string' || !deliveryPublication.authority.startsWith('TEST-'))) throw new TypeError('an exact explicit TEST Deliverable publication policy is required');
  if (!delivery && deliveryPublication !== null) throw new TypeError('Deliverable policy requires the separate delivery transport constructor');
  const deliveryDeclaration = delivery ? Object.freeze(clone(deliveryPublication)) : null;
  if (demo && (!demoArtifactPublication || JSON.stringify(Object.keys(demoArtifactPublication).sort()) !== JSON.stringify(['artifactKinds','authority','policy'])
    || demoArtifactPublication.policy !== DEVNET_DEMO_ARTIFACT_POLICY
    || ![DEVNET_DEMO_ARTIFACT_TYPES,[...DEVNET_DEMO_ARTIFACT_TYPES,'SettlementEvidence']].some(kinds=>canonicalize(demoArtifactPublication.artifactKinds)===canonicalize(kinds))
    || typeof demoArtifactPublication.authority !== 'string' || !/^TEST-RUN-[A-Za-z0-9._-]{8,80}$/.test(demoArtifactPublication.authority))) throw new TypeError('an exact run-scoped TEST demo artifact publication policy is required');
  if (!demo && demoArtifactPublication !== null) throw new TypeError('demo artifact policy requires the separate demo transport constructor');
  const demoDeclaration = demo ? Object.freeze(clone(demoArtifactPublication)) : null;
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
  const raw = async (body, headers = {}, { signal } = {}) => {
    signal?.throwIfAborted();
    await context();
    return fetchBoundedJson(pinned.endpoint, { method:'POST', body, headers, fetchImpl,
      timeoutMs, signal, maxBytes:4*1024*1024, expectedOrigin:new URL(pinned.endpoint).origin });
  };
  // The pinned observer reads transaction and block facts concurrently.
  // Serialize their actual connection fences; this creates no write permit.
  const observe = async (path,body) => journal.withWalletLock('devnet/source-read/'+declaration?.bindingId,()=>fenced(async()=>{
    await binder.bind();
    if(path !== '/' && !/^\/storage-program\/stor-[0-9a-f]{40}$/.test(path)) fail('readonly_only','only bounded native storage reads are supported');
    if(body !== undefined && (path !== '/' || body?.method !== 'nodeCall' || !['getBlockByNumber','getTxByHash','getTransactionStatus','getAddressNonce','getAddressInfo','searchStoragePrograms','getNetworkInfo','getNetworkParameters'].includes(body?.params?.[0]?.message))) fail('readonly_only','only source-bound preparation/inclusion reads are supported');
    return fetchBoundedJson(path==='/'?pinned.endpoint:`${new URL(pinned.endpoint).origin}${path}`,{method:body===undefined?'GET':'POST',body,fetchImpl,timeoutMs,maxBytes:4*1024*1024,expectedOrigin:new URL(pinned.endpoint).origin});
  }));
  const node = async (message, data, options) => {
    const answer = await raw({ method:'nodeCall', params:[{ message, data }] }, {}, options);
    if (answer?.result !== 200) fail('upstream_unavailable', 'the pinned node did not return a usable observation');
    return answer.response;
  };
  const makeBinder = (strictEnvelope=false, signal) => createDemosNetworkBinder({ expected:pinned, fallback, now, timeoutMs, maxAgeMs:60000, reader:{
    getContext:context,
    async getBlockByNumber(height, policy) {
      if (policy.cache !== 'no-store' || policy.redirect !== 'error') fail('invalid_policy','fresh bounded identity observation is required');
      signal?.throwIfAborted();
      const c = await context();
      const answer = await raw({ method:'nodeCall', params:[{ message:'getBlockByNumber', data:{ blockNumber:height } }] }, {}, { signal });
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
      const node2LiteralBlockZeroError = height === 0 && fallback !== null && reviewedShape;
      if(strictEnvelope && !rpcEnvelope(answer,200,'') && !(node2LiteralBlockZeroError && observedFourField)) fail('malformed_observation','storage recovery requires an exact identity RPC envelope');
      if(strictEnvelope && !node2LiteralBlockZeroError && !storageWriteIdentityMatches(answer.response)) fail('malformed_observation','storage recovery requires an exact identity block shape');
      let value = node2LiteralBlockZeroError ? 'error' : answer;
      if (height === 1 && blockOneLayout === DEVNET_NODE2_BLOCK_LAYOUT) {
        const first = rpcEnvelope(answer,200,'') ? answer.response : null;
        const firstIdentity = first?.content?.previousHash;
        if (first?.number !== 1 || first?.id !== 2 || first?.status !== 'confirmed' || !HASH.test(first?.hash ?? '') || !HASH.test(firstIdentity ?? '') || first.hash === firstIdentity
          || (Object.hasOwn(first,'previousHash') && first.previousHash !== firstIdentity)
          || ['chainIdentity','genesisHash'].some((key)=>Object.hasOwn(first,key)&&first[key]!==firstIdentity)) fail('malformed_observation','the reviewed Node2 block-one layout differs');
        const secondAnswer = await raw({ method:'nodeCall', params:[{ message:'getBlockByNumber', data:{ blockNumber:2 } }] }, {}, { signal });
        if(strictEnvelope && !storageWriteIdentityMatches(secondAnswer?.response)) fail('malformed_observation','storage recovery requires an exact identity block shape');
        const second = rpcEnvelope(secondAnswer,200,'') ? secondAnswer.response : null;
        const secondPrevious = second?.content?.previousHash;
        if (second?.number !== 2 || second?.id !== 3 || second?.status !== 'confirmed' || !HASH.test(second?.hash ?? '') || second.hash === first.hash || secondPrevious !== first.hash
          || (Object.hasOwn(second,'previousHash') && second.previousHash !== first.hash)
          || ['chainIdentity','genesisHash'].some((key)=>Object.hasOwn(second,key)&&second[key]!==firstIdentity)) fail('malformed_observation','the reviewed Node2 block-two continuation differs');
        if (second.hash !== reviewedBlockTwoHash) fail('identity_mismatch','the fresh Node2 block-two hash differs from exact admission review');
        const { id:_databaseId, ...binderBlock } = first;
        value = { ...answer, response:binderBlock };
      }
      return { value, context:c, observedAt:now(), fromCache:false, redirected:false };
    },
  } });
  const binder = makeBinder(),storageRecoveryBinder = makeBinder(true);
  const lane = (address) => `devnet/native-wallet/${JSON.stringify([pinned.network,pinned.chainIdentity,address])}`;
  const intent = (hash) => `devnet/native-transfer/${hash}`;
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
    return { l, release: async () => { l.busy--; if (l.busy === 0 && l.releaseRequested) await stopLease(l,true); } };
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
  async function fenced(work, address) {
    await releaseExpiredLeases();
    const f = await transportOwner.acquireConnectionFence({ address });
    if (!f || typeof f.release !== 'function') fail('invalid_transport_owner','actual connection fence acquisition failed');
    try {
      if (!sameContext(await context(),f.context)) fail('connection_changed','the acquired connection differs from actual egress');
      return await work();
    } finally { await f.release(); }
  }
  async function retain(key, record) {
    await journal.put(key,record);
    if (JSON.stringify(await journal.get(key)) !== JSON.stringify(record)) fail('journal_error','the public issued transfer was not retained exactly');
  }
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
      || !HASH.test(tx.hash ?? '') || sha(JSON.stringify(c)) !== tx.hash || tx.signature?.type !== 'ed25519'
      || !verifyDemosSignature({ address:c.from,message:tx.hash,signature:tx.signature.data })) fail('native_only','only the original signed native DEM send or explicitly admitted immutable CREATE is relayed');
    senderAuth(c.from, headers);
    return tx;
  }
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
  async function readback(address, hash, writeProof, failedNonceFence, consumedByHash) {
    if (!ADDRESS.test(address ?? '') || !HASH.test(hash ?? '')) fail('invalid_params','a public native writer and hash are required');
    return journal.withWalletLock(lane(address), async () => {
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
      return fenced(async () => {
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
        if (status?.state !== 'included' || !Number.isSafeInteger(status.blockNumber)) return { disposition:'pending',hash,nonce:r.nonce,noResend:true };
        const proofStarted=now(),cached=writeProofs.get(hash);
        writeProofs.delete(hash);
        const reused=cached && writeProof && canonicalize(writeProof)===canonicalize({disposition:'included',receipt:cached.receipt,noResend:true}) && sameContext(cached.context,await context()) && cached.signed===JSON.stringify(r.signedTransaction) && cached.receipt.blockNumber===status.blockNumber;
        const tx=reused?null:await node('getTxByHash',{hash});
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
      });
    });
  }
  // Server-only recovery: never exposed through binding() or the wallet RPC.
  // The original operator authority supplies fresh RPC auth, not a new CREATE.
  async function recoverStorageWrite({ signedTransaction:tx, signRpc }) {
    const address=tx?.content?.from,hash=tx?.hash,op=tx?.content?.data?.[1];
    const operatorArtifact=demo && op?.metadata?.artifactBinding?.authority===demoDeclaration.authority;
    const sellerEvidence=settlement && op?.metadata?.artifactKind==='SettlementEvidence' && op?.data?.phase==='pay-dem';
    if(tx?.content?.type!=='storageProgram' || (!operatorArtifact&&!sellerEvidence) || typeof signRpc!=='function'
      || !ADDRESS.test(address ?? '') || !HASH.test(hash ?? '')) fail('storage_recovery_only','only an original operator storage CREATE may be recovered');
    return journal.withWalletLock(lane(address),async()=>{
      let r=await journal.get(intent(hash));
      const latest=await journal.get(lane(address));
      if(!r || JSON.stringify(r.signedTransaction)!==JSON.stringify(tx) || latest?.hash!==hash
        || JSON.stringify(latest.signedTransaction)!==JSON.stringify(tx) || r.nonce!==tx.content.nonce
        || r.stage!=='broadcast-accepted' || r.storageWriteSubmission!=='accepted'
        || r.storageWriteSubmissionProfile!==STORAGE_WRITE_SUBMISSION_PROFILE
        || (r.storageWriteResends ?? 0)!==0 || !Object.hasOwn(r,'storageWriteGas')) return {disposition:'pending',hash,noResend:true};
      return fenced(async()=>{
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
          return storageWriteAbsent(status,found) && nonce===storageWriteAccountNonce(r.nonce)-1
            && storageWriteAccountNonce(r.nonce)>0;
        };
        try {
          binding=await storageRecoveryBinder.recover(r.networkBinding);
          if(!await absent()) return {disposition:'pending',hash,noResend:true};
          const headers=async()=>{
            const identity=`ed25519:${address}`,timestamp=String(now());
            return {identity,timestamp,signature:await signRpc(sha(`${identity}:${timestamp}`))};
          };
          const confirmBody={method:'execute',params:[{extra:'confirmTx',data:clone(tx)}]},auth=await headers();
          signedTransaction(confirmBody,auth);
          const confirmation=await raw(confirmBody,auth);
          if(!rpcEnvelope(confirmation,200,null) || !storageWriteConfirmationMatches(confirmation.response)
            || confirmation.response.data.valid!==true
            || !storageConfirmationShapeMatches(confirmation.response.data)
            || JSON.stringify(confirmation.response.data.transaction)!==JSON.stringify(tx)
            || canonicalize(confirmation.response.data.gas_operation ?? null)!==canonicalize(r.storageWriteGas)) return {disposition:'pending',hash,noResend:true};
          binding=await storageRecoveryBinder.beforeBroadcast(binding);
          const broadcastAuth=await headers();
          if(!await absent() || !sameContext(originalContext,await context())) return {disposition:'pending',hash,noResend:true};
          // Reserve the sole attempt before dispatch. A crash consumes it too;
          // reopening the journal can never start another retransmission loop.
          r={...r,storageWriteResends:1,networkBinding:binding};
          await retain(intent(hash),r); await retain(lane(address),r);
          if(await readNonce()!==storageWriteAccountNonce(r.nonce)-1
            || !sameContext(originalContext,await context())) return {disposition:'pending',hash,noResend:true};
          // Still under this lane's lock, just before the sole dispatch: report
          // the resent bytes' own signed job. Telemetry only; it cannot stop or
          // change the resend.
          const notice={hash,writer:address,jobId:op?.metadata?.artifactBinding?.jobId ?? op?.data?.jobId ?? null,artifactKind:op?.metadata?.artifactKind ?? null};
          // An async listener runs here too; its rejection is consumed, never left unhandled.
          for(const listener of resendListeners) { try { const result=listener({...notice}); void Promise.resolve(result).catch(()=>{}); } catch { /* telemetry cannot authorize or interrupt a write */ } }
          const answer=await raw({method:'execute',params:[{extra:'broadcastTx',data:confirmation}]},broadcastAuth);
          r={...r,storageWriteSubmission:classifyStorageWriteSubmission(answer,hash)};
          await retain(intent(hash),r); await retain(lane(address),r);
          return {disposition:'pending',hash,noResend:true};
        } catch(error) {
          // Journal failures must reach the caller; uncertain reads/dispatch
          // leave the original nonce lane fenced for authenticated readback.
          if(error?.code?.startsWith('journal')) throw error;
          return {disposition:'pending',hash,noResend:true};
        }
      });
    });
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
        await releaseExpiredLeases();
        if (byAddress.has(address)) fail('wallet_fenced','a signature connection lease already exists');
        const previous=await journal.get(lane(address));
        if (previous && !['observed','failed'].includes(previous.stage)) fail('outcome_unknown','the retained native transfer must be read back; it is never resent');
        const transfer=declaredTransfer(request.transfer);
        if (await cancelledTransfer(address,transfer)) await refuseCancelled(address,transfer,'signature');
        const fence=await transportOwner.acquireConnectionFence({ address });
        let l;
        try {
          if (!fence || typeof fence.release !== 'function' || !sameContext(await context(),fence.context)) fail('invalid_transport_owner','actual signature connection fence is unavailable');
          const retained=await journal.get(lane(address));
          if(retained && !['observed','failed'].includes(retained.stage)) fail('outcome_unknown','an issued native transfer appeared while acquiring the connection fence');
          const binding=await binder.beforeSignature(await binder.recover(request.binding));
          const grant=async () => {
            if (byAddress.has(address)) fail('wallet_fenced','a signature connection lease already exists');
            const latest=await journal.get(lane(address));
            if (latest && !['observed','failed'].includes(latest.stage)) fail('outcome_unknown','an issued native transfer appeared while acquiring the connection fence');
            if (await cancelledTransfer(address,transfer)) await refuseCancelled(address,transfer,'signature');
            const lease={ id:randomBytes(16).toString('hex'),address,fence,binding,expiresAt:now()+leaseMs,confirmed:null,readyHash:null,signStarted:now(),busy:0,transfer:null };
            // Claimed durably before it is returned: a cancellation in any
            // process sees it (transferClaimed).
            if (transfer) await claimTransfer(lease,transfer);
            // Expiry refuses further actions. Its connection is freed by the next
            // fence acquisition (releaseExpiredLeases), never underneath a running
            // confirm or broadcast. Provider release / app close ends it earlier.
            l=lease; leases.set(l.id,l); byAddress.set(address,l);
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
          l.binding=await binder.beforeBroadcast(l.binding);
          if(!sameContext(await context(),l.fence.context)) fail('connection_changed','the connection changed before broadcast');
          l.readyHash=request.hash;
          return { binding:l.binding,leaseId:l.id };
        } finally { await release(); }
      }
      fail('invalid_params','unknown native binding phase');
    },
    async rpc(body, headers) {
      const call=body?.params?.length === 1 ? body.params[0] : null;
      if(body?.method === 'nodeCall' && ['getNetworkInfo','getNetworkParameters','getAddressNonce'].includes(call?.message)) return raw(body,headers);
      if(body?.method !== 'execute' || !['confirmTx','broadcastTx'].includes(call?.extra)) fail('native_only','this transport exposes only native sends and their preparation reads');
      const tx=signedTransaction(body,headers), { l, release }=await claimLease(tx.content.from);
      try {
      if(call.extra === 'confirmTx') {
        l.confirmed=null;l.readyHash=null;
        if(await journal.get(intent(tx.hash)))fail('outcome_unknown','an issued native hash is readback-only, never reconfirmed or resent');
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
        const started=now();
        const answer=await raw(body,headers);
        step(tx,'validate','complete',started);
        if(answer?.result === 200 && answer.response?.data?.valid === true) {
          if(JSON.stringify(answer.response.data.transaction) !== JSON.stringify(tx)) fail('signed_bytes_changed','the new native transport requires byte-identical signed confirmation');
          if(approveConfirmedWrite&&(await approveConfirmedWrite(answer))!==true)fail('approval_required','the seller policy refused the confirmed write');
          l.confirmed=clone(tx);
        }
        return answer;
      }
      if(l.readyHash !== tx.hash || JSON.stringify(l.confirmed) !== JSON.stringify(tx)) fail('native_confirmation_required','the original signed transaction and fresh broadcast binding are required');
      let accepted;
      try {
        accepted = await journal.withWalletLock(lane(tx.content.from),async () => {
          const previous=await journal.get(lane(tx.content.from));
          if((previous && (!['observed','failed'].includes(previous.stage) || previous.hash === tx.hash)) || await journal.get(intent(tx.hash))) fail('outcome_unknown','issued native transfers cannot be resent');
          // Under the lock of the journal claim below: a cancelled transfer is never claimed.
          const claiming=await identityOf(tx.content);
          if(await cancelledTransfer(tx.content.from,claiming)) await refuseCancelled(tx.content.from,claiming,'broadcast');
          const binding=await binder.beforeBroadcast(l.binding);
          if(!sameContext(await context(),l.fence.context)) fail('connection_changed','the fenced connection changed');
          if(tx.content.type==='native' && nonceFromNode(await node('getAddressNonce',{address:tx.content.from}))>=tx.content.nonce) fail('nonce_consumed','the bound sender nonce was already consumed; no native intent was issued');
          const issued={ stage:'broadcast-started',hash:tx.hash,nonce:tx.content.nonce,signedTransaction:clone(tx),networkBinding:clone(binding) };
          if(tx.content.type==='storageProgram') issued.storageWriteGas=clone(call.data?.response?.data?.gas_operation ?? null);
          await retain(lane(tx.content.from),issued);
          await retain(intent(tx.hash),issued);
          const started=now();
          let answer;
          try { answer=await raw(body,headers); } // one call, never retry on unknown
          catch(error){step(tx,'broadcast','unknown',started);throw error;}
          step(tx,'broadcast','complete',started);
          const answered={ ...issued,stage:answer?.result === 200 ? 'broadcast-accepted' : 'broadcast-answered' };
          if(tx.content.type==='storageProgram') {
            answered.storageWriteSubmission=classifyStorageWriteSubmission(answer,tx.hash);
            answered.storageWriteSubmissionProfile=STORAGE_WRITE_SUBMISSION_PROFILE;
          }
          await retain(intent(tx.hash),answered); await retain(lane(tx.content.from),answered);
          return answer;
        });
        if (accepted?.result === 200) {
          const started=now(),deadline=started+inclusionWaitMs;
          for (let polls = Math.ceil(inclusionWaitMs / inclusionPollMs); !closed && polls > 0 && now()<deadline; polls--) {
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
                const proofStarted=now(),issued=await journal.get(intent(tx.hash));
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
            const remaining=deadline-now();
            if(remaining>0)await sleep(Math.min(inclusionPollMs,remaining));
          }
        }
      } finally { await stopLease(l,true); } // the lane journal holds whatever was sent
      return accepted;
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
  // and the one body the core validated must match its signed content.
  // Resolves the core observation, an included one as {...,sourceDisposition:
  // 'included'}; rejects invalid_params, readback_unverified, a binding
  // failure, or the abort reason (caller, close(), or OutboundError 'timeout').
  // Abort contract: fetchImpl and transportOwner honour AbortSignal and settle.
  // An abort stops new steps and aborts requests; it abandons no running work,
  // and close() aborts and then waits for it.
  async function observePassiveTransfer(hash, options={}) {
    if(typeof hash!=='string' || !HASH.test(hash)) fail('invalid_params','a canonical native transaction hash is required');
    const stop=AbortSignal.any([closing.signal,...(options.signal?[options.signal]:[])]);
    return tracked(()=>observeWithDeadline(({signal})=>passiveRead(hash,signal),{timeoutMs:PASSIVE_TRANSFER_TIMEOUT_MS,signal:stop}));
  }
  async function passiveRead(hash, signal) {
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
    const result=await journal.withWalletLock('devnet/source-read/'+declaration.bindingId,()=>{ signal.throwIfAborted(); return fenced(async()=>{
      signal.throwIfAborted();
      const c=await context(), binder=makeBinder(false,signal);
      await (retained ? binder.recover(issued.networkBinding) : binder.bind());
      // The core reads body and block together; the fence is held until both settle.
      const observation=await observePayDemTransferCore(hash,client).finally(()=>Promise.allSettled(reads));
      signal.throwIfAborted();
      if(!sameContext(await context(),c)) fail('connection_changed','the connection changed during passive observation');
      return observation;
    }); });
    // The core converts read errors to observations; keep this boundary's refusal after draining reads.
    if(nestedEnvelope) refuseEnvelope();
    if(result.status!=='included') return result;
    if(!retained || body===undefined) fail('readback_unverified','the included native transfer has no retained original signed transaction');
    // node() removed the RPC envelope; the core must interpret this same body.
    if(Object.hasOwn(body,'response')) fail('readback_unverified','the included native transfer has an additional response envelope');
    if(!executedMatches(body.content,issued.signedTransaction.content,hash)) fail('readback_unverified','the included native transfer differs from the retained original signed transaction');
    return {...result,sourceDisposition:'included'};
  }
  const capability = Object.freeze({
    ...(settlement?{recoverStorageWrite:(request)=>tracked(()=>recoverStorageWrite(request)),
      onStorageWriteResend(listener) { if(typeof listener!=='function')throw new TypeError('resend listener required');resendListeners.add(listener);return()=>resendListeners.delete(listener); }}:{}),
    ...(agreement?{pins:pinned,transportBinding:declaration,journal,...(publication?{settlementPublication:publication}:{}),...(deliveryDeclaration?{deliveryPublication:deliveryDeclaration}:{}),...(demoDeclaration?{demoArtifactPublication:demoDeclaration}:{}),
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
      observeBinding:()=>tracked(()=>journal.withWalletLock('devnet/source-read/'+declaration.bindingId,()=>fenced(()=>binder.bind()))),
      readRpc:(path,body)=>tracked(()=>observe(path,body)),
      chainReader:()=>{
        const reader=createDemosChainReader({rpcUrl:pinned.endpoint,network:pinned.network,pinnedIdentity:pinned.chainIdentity,fetchImpl:async(url,options={})=>new Response(JSON.stringify(await capability.readRpc(new URL(url).pathname,options.body?JSON.parse(options.body):undefined)),{status:200,headers:{'content-type':'application/json'}})});
        async function observeTransfer(hash,purchase=false){
          const result=await reader.observeTransfer(hash);
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
        return {...reader,observeTransfer:hash=>observeTransfer(hash),observePurchaseTransfer:hash=>observeTransfer(hash,true),observePassiveTransfer};
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
