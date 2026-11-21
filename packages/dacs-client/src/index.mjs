import { createProtocolPurchases as createInternalProtocolPurchases, registerPlanFlightReader } from './dacs/protocol-purchases.mjs';
import { createPublicPurchaseService } from './purchases.mjs';
import { admitPublicFactory } from './public-admission.mjs';
import { buildPublicSellerClient } from './dacs/seller-http.mjs';
// Public buyer API. Root import leaves SQLite unloaded; constructing the SQLite store loads it.
/** purchaseNext(operation,chainMode) returns the next-step text, protocolView(operation,options) returns the protocol projection or null, and PURCHASE_STATUS_HELP is a frozen status-to-text map. Each reads the one hold constant at every call or read: historical held text while held, the full text once admitted. They do not write; once admitted purchaseNext on a missing operation throws TypeError. */
export { purchaseNext, protocolView, PURCHASE_STATUS_HELP } from './public-guidance.mjs';
/** networkIdentityLabel(domain) returns a genesis label for a network domain; it does not write. */
export { networkIdentityLabel } from './purchases.mjs';
/** usesAgreementContext/usesNativeDemDelivery(operation) return booleans from the operation's retained protocol terms; they do not write. */
export { usesAgreementContext, usesNativeDemDelivery } from './dacs/protocol-purchases.mjs';
/** createDeliveryDeadlineWatch({db,ops,coordinates,store,enabled=false,now}) returns observe/sweep/start/stop/setDeliveryCheck methods. When enabled, observe may call ops.transition and persist overdue/delivery events despite purchase actions being held; invalid/async stores throw NotWiredError. */
export { createDeliveryDeadlineWatch } from './dacs/delivery-deadline-watch.mjs';
/** createCoordinateStore({db,now}) returns save/get/reportHash/recordObservation and nonce lookup methods over PURCHASE_STATE_SCHEMA. Mutators write SQLite coordinates; invalid state and uniqueness failures throw SQLite errors. The purchase hold does not disable this host utility. */
export { createCoordinateStore } from './dacs/wallet-transactions.mjs';
/** createDirectoryClient({origin,timeoutMs,maxBytes,fetchImpl}) returns bounded search/findSummary/getListingDetail reads. It performs HTTP reads and throws OutboundError for invalid or unavailable responses; directory summaries confer no purchase authority. */
export { createDirectoryClient } from './dacs/directory.mjs';
/** createListingVerifier({admission,directory,chain,...}) returns {verify(request)}; verify rejects with OperationError(profile_not_admitted) before resolution while purchase actions are held or the binding check fails. Construction throws TypeError(admission_required|admission_input_untrusted) or OperationError(runtime_unsupported). NotConfiguredError(message) identifies missing verifier configuration. */
export { createListingVerifier, NotConfiguredError } from './public-verification.mjs';
/** DEM_DECIMAL and OS_INTEGER are RegExp constants for canonical DEM and OS text; test(value) returns a boolean without reads or writes. */
export { DEM_DECIMAL, OS_INTEGER } from './dacs/chain.mjs';
/** deliveryEvidenceAddress(jobId) returns the canonical evidence address and may reject invalid identifiers. vetNotPerformedRef(jobId,party) returns the explicit unperformed-Vet reference; neither reads, writes or authorizes Vet. */
export { deliveryEvidenceAddress, vetNotPerformedRef } from './dacs/purchase-protocol.mjs';
/** sellerFailureCause(value) returns a recognized seller failure label (tls, network, response-auth, status-4xx, status-5xx, client-sign, timeout, address, redirect, oversized, other) or undefined; it has no side effects and does not throw for unknown labels. */
export { sellerFailureCause } from './dacs/seller-http.mjs';
/** usesNativePaymentEvidence(operation) returns whether its retained protocol selects native evidence; it performs no network or storage work. */
export { usesNativePaymentEvidence } from './dacs/native-payment-evidence-consumer.mjs';
/** AGREEMENT_CONTEXT_SOURCE is the operator capability source constant; isOperatorContextAuthority(value) returns whether a label is syntactically admissible. Neither grants authority or writes state. */
export { AGREEMENT_CONTEXT_SOURCE, isOperatorContextAuthority } from './dacs/agreement-context-consumer.mjs';
/** DEM_DELIVERY_CONTEXT_SOURCE is the delivery capability source constant; demDeliveryContextUsage(capability) returns provider capacity, null, or {status:"error"} and invokes the supplied usage callback. isDemDeliveryContextAuthority(value) returns a label predicate; neither admits purchase actions. */
export { DEM_DELIVERY_CONTEXT_SOURCE, demDeliveryContextUsage, isDemDeliveryContextAuthority } from './dacs/dem-delivery-context-consumer.mjs';
/** createDemDeliveryContext({authority,resolveBuyer,resolveSeller,release=null,usage=null,readBack=null}) returns a frozen opaque capability that supplies the buyer and seller for DEM delivery context. readBack({jobId,buyer}) reads a job's retained seller Vet record writes back without signing or sending; a purchase recheck uses it after a plan step ended indeterminate. It throws TypeError unless authority is a TEST- label and the resolvers (and the optional release, usage and readBack) are functions; the TEST- label stays until the testnet authority is wired. It reads, writes and admits nothing at construction. */
export { createDemDeliveryContext } from './dacs/dem-delivery-context-consumer.mjs';
/** createNativeDemDeliveryCapability({authority,submit,reconcile,read,verifyReceipt}) returns a frozen opaque capability for native DEM deliverable publication and readback. It throws TypeError unless authority is a TEST- label and all four operations are functions; the TEST- label stays until the testnet authority is wired. Construction calls none of them. */
export { createNativeDemDeliveryCapability } from './dacs/native-dem-delivery-consumer.mjs';
/** createNativePaymentEvidenceConsumer({rpcUrl,sourceCapability,anchorEvidence,fetchImpl,now}) returns a frozen capability with observeDemosTransfer and readEvidence over one pinned RPC origin. It throws TypeError unless sourceCapability is the exact opaque settlement-evidence capability whose endpoint equals rpcUrl, rpcUrl has no credentials, path, query or fragment, and anchorEvidence is a function when given; an unparseable rpcUrl throws TypeError. Construction makes no request. */
export { createNativePaymentEvidenceConsumer } from './dacs/native-payment-evidence-consumer.mjs';
/** createSourceDemoSellerTransport({authority,sessionSignerFor,sessionPolicyFor,endpointProofFor,effectBoundary}) returns an opaque wire transport capability. The resolvers supply {claim,sign}, {expiresAt} and a proof from verifyEndpointProof for the purchase; `effectBoundary` is the Node composition's, and every request signature passes through it. Throws TypeError for missing resolvers, a missing effect boundary or a non-TEST authority. Construction sends nothing. */
export { createSourceDemoSellerTransport } from './dacs/source-demo-seller-transport.mjs';
/** createDevnetNativeCommitmentCapability({authority,anchor}) returns a frozen opaque capability for the native seller commitment; DEVNET_NATIVE_COMMITMENT_MARKER is its source constant. It throws TypeError unless authority is a TEST-RUN- label and anchor carries the same authority with readRetained and verifyReceipt functions; the TEST-RUN- label stays until the testnet authority is wired. Construction reads and writes nothing. */
export { createDevnetNativeCommitmentCapability, DEVNET_NATIVE_COMMITMENT_MARKER } from './devnet-demo/commitment-consumer.mjs';
/** OFFLINE_AGREEMENT_MODE is the retained wallet Agreement mode constant; isOfflineWalletAgreement(operation) returns whether the operation's terms select that profile. Neither reads, writes or throws. */
export { OFFLINE_AGREEMENT_MODE, isOfflineWalletAgreement } from './dacs/protocol-purchases.mjs';
/** deriveStorageAddress(owner,programName,nonce,salt='') returns the deterministic stor- storage address text for that tuple. It throws TypeError when owner is not text; it performs no reads or writes. */
export { deriveStorageAddress } from './dacs/wallet-transactions.mjs';
/** SR2_WALLET_KIND is the wallet Agreement request-kind constant; reading it has no side effects. */
export { SR2_WALLET_KIND } from './dacs/demos-sr2-wallet-bridge.mjs';
/** rpcAuthRefusal(error) and transferRefusal(error) return [409,responseBody] for recognized refusals or null without writes. DEVNET_AGREEMENT_KIND/PROFILE and DEVNET_NATIVE_BINDING_PATH/RPC_PATH are transport routing constants; none enables held actions. */
export { rpcAuthRefusal, transferRefusal, DEVNET_AGREEMENT_KIND, DEVNET_AGREEMENT_PROFILE, DEVNET_NATIVE_BINDING_PATH, DEVNET_NATIVE_RPC_PATH } from './wallet/devnet-native-transport.mjs';
/** sellerSessionTransitionState(current,status,state,time) returns a cloned transition state with session lifetime markers; it does not persist it. Invalid or uncloneable state can throw. */
export { sellerSessionTransitionState } from './dacs/seller-session-lifecycle.mjs';
/** createPurchaseReadbackCache({loadPurchase,limit=256}) returns read/stageChange/close methods for a bounded in-memory cache. read invokes host verification/currentness callbacks and propagates errors; invalid options throw TypeError. It never persists settlement. */
export { createPurchaseReadbackCache } from './util/purchase-readback-cache.mjs';
/** OutboundError(kind,message,{status}) returns an Error carrying the outbound failure kind/status; constructing it performs no network or storage operation. */
export { OutboundError } from './util/http.mjs';
/** OperationError(code,message,details) and NotWiredError(seam) return Errors identifying operation refusals or unavailable host seams; constructing them has no side effects. */
export { OperationError, NotWiredError } from './client-errors.mjs';
/** StaleProtocolCheck(operation) returns an Error for a protocol decision overtaken by retained state; construction performs no writes. */
export { StaleProtocolCheck } from './dacs/protocol-purchases.mjs';
/** SellerRefusedError(code,message,status,answerClass="definite"), SellerUnavailableError(message,causeCode="other",{answerClass="unknown",code}) and SellerTlsUnusableError(message) return transport Errors preserving refusal versus unavailable causes and the class of the seller's answer; construction performs no requests. */
export { SellerRefusedError, SellerUnavailableError, SellerTlsUnusableError } from './dacs/seller-http.mjs';
/** DemosSr2BridgeError(code,message) returns an Error for refused wallet bridge input or state; construction neither signs nor submits. */
export { DemosSr2BridgeError } from './dacs/demos-sr2-wallet-bridge.mjs';
/** DemosSr2Error(code,message) returns an Error for SR-2 admission/readback failures; construction performs no network or storage work. */
export { DemosSr2Error } from './dacs/demos-sr2-adapter.mjs';
/** NetworkBindingError(code,message) returns an Error for a refused network binding; construction performs no reads, writes or binding admission. */
export { NetworkBindingError } from './dacs/network-binding.mjs';
/** createDemosNetworkBinder({expected,reader,fallback,now,maxAgeMs,timeoutMs,exclusive}) returns the shared read-only chain-identity binder: bind() resolves a fresh observation of the chain compared with the independently reviewed pin, and never authorizes. Overlapping observations are independent unless `exclusive` is set, which makes an overlapping call reject binding_busy. It throws NetworkBindingError for an invalid pin, reader or policy; bind rejects with NetworkBindingError and keeps the reader's own cause. It performs only the reads the supplied reader makes. */
export { createDemosNetworkBinder } from './dacs/network-binding.mjs';
/** createAuthorityReader({authority,identityRecord,claim,listings,purchases,participantImplementations}) returns the client's production Tp1AuthorityReader for bindTp1Profile and every wire check. It reads the chain through authority.authorityRpc and local evidence (the Listing registry, saved purchase rows and enrollment) on every call, and takes no fence, lock or signer. It answers no participants for missing, revoked, ambiguous or unrelated evidence, and no decision for a connection it cannot authenticate; a transport failure rejects with its original error. It throws TypeError at construction when an input is missing, and needs no completed binding. */
export { createAuthorityReader } from './wallet/authority-reader.mjs';
/** BuyerChainReadbackUnsupported(message) returns an Error for an unsupported buyer readback capability; constructing it performs no reads. */
export { BuyerChainReadbackUnsupported } from './dacs/buyer-chain-readback.mjs';
/** WalletFormatError(message) returns an Error for malformed wallet addresses or signatures; constructing it performs no wallet operation. */
export { WalletFormatError } from './signatures.mjs';
/** canonicalize(value) returns canonical JSON and contentHash(artifact) returns its signed-scope hash; malformed inputs throw. normalizeDemAmount(value) returns {amount,amountOs} or throws (including price_unverifiable); logicalListingAddress(listing) returns its logical address. verifyComponent({signedBytes,signature}) returns a signature-validity boolean; SDK_PROVENANCE is the pinned implementation metadata constant. These utilities do not read, write or sign. */
export { canonicalize, contentHash, normalizeDemAmount, SDK_PROVENANCE, logicalListingAddress, verifyComponent } from './dacs/listing.mjs';
/** fundingHelpSentence(help) returns funding-page/address guidance or a period; it formats the supplied fields without network or storage work. */
export { fundingHelpSentence } from './buyer-funding.mjs';
/** createSqlitePurchaseStore() returns synchronous transaction(db,callback) and isUniqueViolation(error) methods. transaction requires a real node:sqlite DatabaseSync with the host schema, commits/rolls back callback writes, and throws callback/SQLite errors or NotWiredError for invalid/async boundaries; the classifier returns a boolean. */
export { createSqlitePurchaseStore } from './seams/purchase-store-not-wired.mjs';
/** PURCHASE_STATE_SCHEMA is the host SQLite DDL string required by the buyer factories; db.exec(PURCHASE_STATE_SCHEMA) creates persistent schema objects and may throw SQLite errors. Reading the constant has no effect. */
export { PURCHASE_STATE_SCHEMA } from './purchase-state-schema.mjs';

const PASSIVE_PROTOCOL_METHODS = ['assertBuyerAccess', 'supportsMode', 'readIssued', 'readIssuedPayment', 'observeReportedPayment'];
const PASSIVE_SERVICE_METHODS = ['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning'];
/** createPurchaseService({admission,stopped,db,ops,coordinates,chain,store,purposes,passiveOnly,...}) returns the purchase service; `admission` is {binding,currentLocal} from the host composition and `stopped()` is the host's stop check (true or a Promise of true when writes are stopped), required, with no default. status, portalOperation, portalEvidence, verifyDeal and planRunning are passive readers (planRunning stays synchronous); every other method returns a Promise that rejects OperationError(profile_not_admitted) while purchase actions are held or the binding check fails, with the cause kept, and OperationError(writes_stopped | stop_check_failed | stop_check_invalid | stop_check_timeout) while the stop check says stopped or does not answer true or false within 10 seconds. `passiveOnly: true` returns only the passive readers, which then read without writing even after the hold lifts. actionsAdmitted is a construction-time snapshot. Construction throws TypeError(admission_required|admission_input_untrusted|stopped_required|passive_only_invalid) or OperationError(runtime_unsupported); missing/expired capabilities reject not_found. */
export const createPurchaseService = admitPublicFactory(createPublicPurchaseService, { purchase: true, stopSeam: true, passive: PASSIVE_SERVICE_METHODS });
/** createPublicSellerClient({admission,publicEndpoint,authentication,timeoutMs,commitOnSignature}) returns {origin,propose,agreementState,commit,submitPayment,bundleRequest,countersign,confirmBuyerCopy} (plus commitOnSignature when that option is true): signed POSTs to one public https seller origin through a pinned connector that admits only public addresses and reads at most 512 KiB. `origin` is passive; every method returns a Promise that rejects OperationError(profile_not_admitted) before any signing or request while purchase actions are held or the binding check fails, and once admitted resolves the verified answer or rejects SellerRefusedError or SellerUnavailableError. Construction throws TypeError(admission_required|admission_input_untrusted), and TypeError for an endpoint that is not a public https origin, a missing wire authentication or any other option: no fetch, resolver, CA, connector or transmit callback is accepted. It sends nothing at construction. */
export const createPublicSellerClient = admitPublicFactory(buildPublicSellerClient);
/** createProtocolPurchases({admission,stopped,db,ops,coordinates,store,passiveOnly,...}) returns the protocol object; `admission` is {binding,currentLocal} and `stopped()` is the host's stop check, required, with no default. assertBuyerAccess, supportsMode, readIssued, readIssuedPayment and observeReportedPayment are passive readers; every other function member returns a Promise that rejects OperationError(profile_not_admitted) before host effects while purchase actions are held or the binding check fails, and OperationError(writes_stopped | stop_check_failed | stop_check_invalid | stop_check_timeout) while the stop check says stopped or does not answer true or false within 10 seconds. A stop observed before a seller request is sent, or at a later retry, records a suspension on the purchase. `passiveOnly: true` returns only the passive readers and the non-function members. actionsAdmitted is a construction-time snapshot. Construction throws TypeError(admission_required|admission_input_untrusted|stopped_required|passive_only_invalid) or OperationError(runtime_unsupported). */
export const createProtocolPurchases = admitPublicFactory(createInternalProtocolPurchases,
  { purchase: true, stopSeam: true, passive: PASSIVE_PROTOCOL_METHODS, onCreated: registerPlanFlightReader });
