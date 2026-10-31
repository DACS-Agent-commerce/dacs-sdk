import { createProtocolPurchases as createInternalProtocolPurchases } from './dacs/protocol-purchases.mjs';
import { assertPurchaseActionsAdmitted } from './dacs/action-admission.mjs';
// Public buyer API. Root import leaves SQLite unloaded; constructing the SQLite store loads it.
/** createPurchaseService(options) returns authenticated diagnostic status/readback methods; requires db, ops, coordinates, chain, store and purposes. Actions throw OperationError(profile_not_admitted); missing/expired capabilities throw not_found. purchaseNext(operation) returns held guidance, PURCHASE_STATUS_HELP is its status map, and networkIdentityLabel(domain) returns a genesis label; these formatters do not write. */
export { createPublicPurchaseService as createPurchaseService, diagnosticPurchaseNext as purchaseNext, DIAGNOSTIC_PURCHASE_STATUS_HELP as PURCHASE_STATUS_HELP, networkIdentityLabel } from './purchases.mjs';
/** createProtocolPurchases({db,ops,coordinates,store,...}) returns held protocol methods; actions refuse with profile_not_admitted. protocolView(operation,options) returns redacted historical guidance; usesAgreementContext/usesNativeDemDelivery(operation) return booleans. Projection has no writes; invalid seams throw. */
export { diagnosticProtocolView as protocolView, usesAgreementContext, usesNativeDemDelivery } from './dacs/protocol-purchases.mjs';
/** createDeliveryDeadlineWatch({db,ops,coordinates,store,enabled=false,now}) returns observe/sweep/start/stop/setDeliveryCheck methods. When enabled, observe may call ops.transition and persist overdue/delivery events despite purchase actions being held; invalid/async stores throw NotWiredError. */
export { createDeliveryDeadlineWatch } from './dacs/delivery-deadline-watch.mjs';
/** createCoordinateStore({db,now}) returns save/get/reportHash/recordObservation and nonce lookup methods over PURCHASE_STATE_SCHEMA. Mutators write SQLite coordinates; invalid state and uniqueness failures throw SQLite errors. The purchase hold does not disable this host utility. */
export { createCoordinateStore } from './dacs/wallet-transactions.mjs';
/** createDirectoryClient({origin,timeoutMs,maxBytes,fetchImpl}) returns bounded search/findSummary/getListingDetail reads. It performs HTTP reads and throws OutboundError for invalid or unavailable responses; directory summaries confer no purchase authority. */
export { createDirectoryClient } from './dacs/directory.mjs';
/** createListingVerifier(options) returns {verify(request)}; verify always rejects with OperationError(profile_not_admitted) before resolution in this candidate. NotConfiguredError(message) identifies missing verifier configuration; constructor/configuration errors can also throw. */
export { createListingVerifier, NotConfiguredError } from './public-verification.mjs';
/** DEM_DECIMAL and OS_INTEGER are RegExp constants for canonical DEM and OS text; test(value) returns a boolean without reads or writes. */
export { DEM_DECIMAL, OS_INTEGER } from './dacs/chain.mjs';
/** deliveryEvidenceAddress(jobId) returns the canonical evidence address and may reject invalid identifiers. vetNotPerformedRef(jobId,party) returns the explicit unperformed-Vet reference; neither reads, writes or authorizes Vet. */
export { deliveryEvidenceAddress, vetNotPerformedRef } from './dacs/purchase-protocol.mjs';
/** sellerFailureCause(value) returns a recognized seller failure label or undefined; it has no side effects and does not throw for unknown labels. */
export { sellerFailureCause } from './dacs/seller-http.mjs';
/** usesNativePaymentEvidence(operation) returns whether its retained protocol selects native evidence; it performs no network or storage work. */
export { usesNativePaymentEvidence } from './dacs/native-payment-evidence-consumer.mjs';
/** AGREEMENT_CONTEXT_SOURCE is the operator capability source constant; isOperatorContextAuthority(value) returns whether a label is syntactically admissible. Neither grants authority or writes state. */
export { AGREEMENT_CONTEXT_SOURCE, isOperatorContextAuthority } from './dacs/agreement-context-consumer.mjs';
/** DEM_DELIVERY_CONTEXT_SOURCE is the delivery capability source constant; demDeliveryContextUsage(capability) returns provider capacity, null, or {status:"error"} and invokes the supplied usage callback. isDemDeliveryContextAuthority(value) returns a label predicate; neither admits purchase actions. */
export { DEM_DELIVERY_CONTEXT_SOURCE, demDeliveryContextUsage, isDemDeliveryContextAuthority } from './dacs/dem-delivery-context-consumer.mjs';
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
/** SellerRefusedError(code,message,status), SellerUnavailableError(message,causeCode="other") and SellerTlsUnusableError(message) return transport Errors preserving refusal versus unavailable causes; construction performs no requests. */
export { SellerRefusedError, SellerUnavailableError, SellerTlsUnusableError } from './dacs/seller-http.mjs';
/** DemosSr2BridgeError(code,message) returns an Error for refused wallet bridge input or state; construction neither signs nor submits. */
export { DemosSr2BridgeError } from './dacs/demos-sr2-wallet-bridge.mjs';
/** DemosSr2Error(code,message) returns an Error for SR-2 admission/readback failures; construction performs no network or storage work. */
export { DemosSr2Error } from './dacs/demos-sr2-adapter.mjs';
/** NetworkBindingError(code,message) returns an Error for a refused network binding; construction performs no reads, writes or binding admission. */
export { NetworkBindingError } from './dacs/network-binding.mjs';
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

const PASSIVE_PROTOCOL_METHODS = new Set(['assertBuyerAccess', 'supportsMode', 'readIssued', 'readIssuedPayment', 'observeReportedPayment']);
/** createProtocolPurchases(options) returns passive protocol readers and refusal methods; actions throw profile_not_admitted before host effects. */
export function createProtocolPurchases(options) {
  const protocol = createInternalProtocolPurchases(options);
  const methods = Object.fromEntries(Object.entries(protocol).filter(([, value]) => typeof value === 'function')
    .map(([name, method]) => [name, PASSIVE_PROTOCOL_METHODS.has(name) ? method : assertPurchaseActionsAdmitted]));
  return Object.freeze({ available: protocol.available, actionsAdmitted: false,
    nativePaymentReadbackAvailable: protocol.nativePaymentReadbackAvailable, ...methods });
}
