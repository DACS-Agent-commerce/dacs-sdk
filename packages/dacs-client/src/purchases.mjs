// Fixed-price DEM testnet purchases.
//
// Consent model: the model can only *prepare* exact terms. Approval exists only
// as a consumed wallet-signed challenge whose binding is re-derived from the
// stored terms (owner account, buyer wallet, seller, payee, listing id/version
// and content hash, amount, network domain, rail, operation id, terms hash and
// the purchase commitment). A model argument such as approved:true, a txHash
// or a "done" flag is never consent and never finality.
//
// Network domain: a purchase is bound at prepare time to the configured RPC's
// chain identity (src/dacs/chain.mjs networkIdentity; source-pinned for any
// non-simulated chain) and every later step re-checks it: approval challenge,
// wallet handoff and readback. A mismatched or unpinned chain is refused.
//
// What readback establishes, and what it does not: the configured RPC node
// reports an included native DEM transfer matching the approved payer, payee,
// amount and the pre-saved nonce slot. That is one node's view (not finality),
// and the match is tuple-only: Demos native transfers carry neither a chain
// identity nor a purchase commitment in their signed bytes (SDK 4.0.16
// TransactionContent / INativeSend; the pinned DACS observer requires exactly
// args [to, amount]), so the commitment below is bound only in the
// wallet-signed approval. Nothing here triggers service fulfillment.
//
// DACS protocol purchases (terms.protocol, offline fixture builds only) wrap
// the same payment in src/dacs/protocol-purchases.mjs: they start in
// agreement_pending, reach awaiting_approval only after the seller's
// finalized commitment is read back, re-read it before approval and before
// handoff, and continue after settled_verified with the seller's payment
// claim, DACS-4 evidence, delivery and DACS-5 copies (operation.state.protocol).
// All approval and payment handoffs, including legacy purchases without
// terms.protocol, remain held by the package's purchase-action admission.
import { createHash, timingSafeEqual } from 'node:crypto';
import { contentHash, canonicalize } from './dacs/listing.mjs';
import { walletPurposes } from './seams/wallet-actions-not-wired.mjs';
import { OperationError, requestHashOf } from './client-errors.mjs';
import { buildNativeTransferPayload } from './dacs/wallet-transactions.mjs';
import { purchaseStore } from './seams/purchase-store-not-wired.mjs';
import { newId } from './util/ids.mjs';
import { OutboundError } from './util/http.mjs';
import { nodeProjectedNonce, OS_INTEGER } from './dacs/chain.mjs';
import { normalizeDemosAddress } from './signatures.mjs';
import { projectDiagnostic, projectDiagnosticOperation, DIAGNOSTIC_LIMITS } from './diagnostic-projection.mjs';
import { OFFLINE_AGREEMENT_MODE, isOfflineWalletAgreement, assertAgreementPaymentHeld, protocolApprovalFields, protocolStageHelp, protocolView, diagnosticProtocolView } from './dacs/protocol-purchases.mjs';
import { usesNativeAgreementPayment } from './dacs/native-agreement-payment-consumer.mjs';
import { PURCHASE_LIMITS } from './purchase-limits.mjs';
import { buyerFundingError } from './buyer-funding.mjs';
import { assertPurchaseActionsAdmitted } from './dacs/action-admission.mjs';

export const PURCHASE_PROFILE = 'dacs-chatgpt-plugin/fixed-price-dem-purchase/v1';
export const PURCHASE_RAIL = 'demos-native:DEM';
export const PURCHASE_APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_TRANSFER_OBSERVATION_BYTES = 64 * 1024;
// Diagnostic reads run host-supplied readers that may never settle, so the
// deadline is raced: it aborts the reader's signal and rejects without waiting
// for the reader. (The transport's own passive read honours its signal and
// settles; util/http.mjs observeWithDeadline waits for it and races nothing.)
async function raceWithDeadline(read, { timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let timer, abort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        abort = () => reject(cancellation.reason);
        cancellation.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(new OutboundError('timeout', 'host chain read timed out')), timeoutMs);
        if (cancellation.aborted) abort();
      }),
      Promise.resolve().then(() => { cancellation.throwIfAborted(); return read({ signal: cancellation }); }),
    ]);
  } finally {
    clearTimeout(timer);
    cancellation.removeEventListener('abort', abort);
    controller.abort();
  }
}
// Domain separator of the purchase commitment (approval-bound, not on chain).
export const COMMITMENT_DOMAIN = 'dacs-chatgpt-plugin/fixed-price-dem-purchase-commitment/v1';
// Recorded with every payment observation so no reader mistakes it for more.
export const OBSERVATION_LIMITS = Object.freeze({
  observationScope: 'single-rpc',
  finality: 'not-established',
  attribution: 'tuple-only',
  fulfillment: 'not-triggered',
});
// Unknown payment outcomes block new purchases from the wallet; an open
// publication handoff blocks too because it holds the same nonce slot.
export const BLOCKS_PURCHASE = ['payment_handoff', 'broadcast_reported', 'payment_uncertain', 'publication_handoff'];
// An uncertain publication no longer blocks handoff, but still reserves its old nonce.
const SUPERSESSION_STATES = [...BLOCKS_PURCHASE, 'publication_uncertain'];
const CANCELLABLE = new Set(['agreement_pending', 'awaiting_approval', 'approved', 'payment_handoff', 'payment_uncertain']);
const TERMINAL = new Set(['settled_verified', 'payment_failed', 'payment_mismatch', 'expired', 'terms_changed', 'cancelled', 'superseded', 'agreement_rejected']);
export const PURCHASE_TERMINAL_STATUSES = TERMINAL;
// Only these statuses have a user action in the portal; other statuses never
// receive an approval link, so nothing invites a duplicate payment. A DACS
// purchase after settled_verified keeps its link only for the counter-signature.
export const ACTIONABLE = new Set(['agreement_pending', 'awaiting_approval', 'approved', 'payment_handoff']);
const linkable = (operation) => ACTIONABLE.has(operation.status) || (operation.status === 'settled_verified' && operation.state?.protocol?.stage === 'awaiting-countersignature');
const validIncludedAt = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const demAmount = (os) => {
  const fraction = (os % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${os / 1_000_000_000n}${fraction ? `.${fraction}` : ''}`;
};

export const PURCHASE_STATUS_HELP = {
  agreement_pending: 'Open the approval link to review and sign the DACS Agreement with your wallet. Nothing is paid until the seller\'s finalized commitment is read back and you approve the payment.',
  agreement_rejected: 'The DACS Agreement was refused, could not be bound to these terms, or its commitment did not verify. Nothing was paid. Prepare a new purchase if you still want it.',
  awaiting_approval: 'Open the approval link and approve the exact terms with your wallet.',
  approved: 'Approved; the portal is preparing the wallet transaction (re-open the link to continue).',
  payment_handoff: 'The exact transfer was handed to your wallet. Confirm it there; the portal reports the result.',
  broadcast_reported: 'Your wallet reported a transaction. Waiting for the configured Demos RPC node to report it included (call verify_deal).',
  payment_uncertain: 'The payment is unresolved. Retry is blocked; provide the transaction hash from your wallet history to verify_deal.',
  settled_verified: 'The configured Demos RPC node reports an included transfer matching the approved payer, payee, amount and reserved nonce slot. One node’s view only: not finality, not a purchase-specific receipt (a native DEM transfer carries no purchase commitment), and it does not trigger service fulfillment.',
  payment_failed: 'The chain reports the transfer failed. Prepare a new purchase if you still want it.',
  payment_mismatch: 'A transaction was found but it does not match the approved terms. Nothing was accepted as settlement.',
  expired: 'The approval window expired before approval. Prepare a new purchase.',
  terms_changed: 'The listing changed or failed re-verification after approval; nothing was sent. Prepare a new purchase.',
  superseded: 'This wallet nonce slot was consumed by a transaction that settled another of your operations, so this purchase can never be paid. Nothing was charged for it.',
  cancelled: 'Cancelled while the buyer wallet nonce proved the payment slot was not consumed. A later confirmed read of the old transfer can still settle it.',
};

// A native payment with the settlement terms of a cancelled purchase's payment
// is never offered for signing (prepareHandoffCore); the portal shows this.
export const PAYMENT_TERMS_CANCELLED = 'This payment would carry the same terms as a cancelled purchase\'s payment (this wallet, its nonce, the payee and the amount), so it was not offered to your wallet for signing and nothing was sent. Cancel this purchase (cancel_wallet_handoff) and prepare it again: the new purchase pays at a new nonce.';

// Never let fixture evidence read as live chain settlement.
export function purchaseHelp(status, chainMode) {

  return PURCHASE_STATUS_HELP[status];
}

// The next step for a purchase: a DACS purchase's protocol stage explains the
// statuses the protocol owns; payment statuses keep their own help.
export function purchaseNext(operation, chainMode) {
  if (operation?.terms?.protocol && ['agreement_pending', 'agreement_rejected', 'settled_verified'].includes(operation.status)) {
    const stage = operation.state?.protocol?.stage;
    const view = operation.status === 'settled_verified' && stage === 'committed' ? { state: { protocol: { stage: 'awaiting-claim' } } } : operation;
    return protocolStageHelp(view) ?? purchaseHelp(operation.status, chainMode);
  }
  return purchaseHelp(operation.status, chainMode);
}

const DIAGNOSTIC_HELP = 'Stored purchase state is historical. Purchase actions are held; verify_deal can only diagnose the recorded transaction and cannot establish settlement or delivery.';
export const DIAGNOSTIC_PURCHASE_STATUS_HELP = Object.freeze(Object.fromEntries(Object.keys(PURCHASE_STATUS_HELP).map(status => [status, DIAGNOSTIC_HELP])));
export const diagnosticPurchaseNext = () => DIAGNOSTIC_HELP;

// The chain identity a purchase is bound to, as the wallet approval shows it.
export function networkIdentityLabel(domain) {
  if (!domain) return 'unbound';
  return `genesis ${domain.chainIdentity}`;
}

const sameDomain = (a, b) => Boolean(a && b) && a.network === b.network && a.rail === b.rail && a.mode === b.mode && a.chainIdentity === b.chainIdentity;

// Unique per purchase (operation id), domain-separated, over the terms hash and
// the fields the transfer must match. Bound in the wallet-signed approval only:
// the native DEM transfer cannot carry it.
export function purchaseCommitment(operation) {
  const t = operation.terms;
  return createHash('sha256').update(canonicalize({
    domain: COMMITMENT_DOMAIN,
    operation: operation.id,
    termsHash: operation.termsHash,
    listing: `${t.listing.listingId}@v${t.listing.version}`,
    listingHash: t.listing.contentHash,
    payer: t.buyer.wallet,
    payee: t.seller.payee,
    amountOs: t.price.amountOs,
    network: t.network,
    rail: t.rail,
    domainMode: t.domain?.mode ?? null,
    chainIdentity: t.domain?.chainIdentity ?? null,
  })).digest('hex');
}

export function approvalBinding(operation) {
  const t = operation.terms;
  return {
    operation: operation.id,
    'terms-hash': operation.termsHash,
    network: t.network,
    'network-identity': networkIdentityLabel(t.domain),
    rail: t.rail,
    seller: t.seller.claim,
    payee: t.seller.payee,
    listing: `${t.listing.listingId}@v${t.listing.version}`,
    'listing-hash': t.listing.contentHash,
    amount: `${t.price.amount} DEM`,
    'amount-os': t.price.amountOs,
    commitment: purchaseCommitment(operation),
    account: operation.accountId,
    ...protocolApprovalFields(operation),
  };
}

// Installed hosts have no qualified settlement authority in this candidate.
// CORE §11.1.2(3): profile admission remains held. Host diagnostics are not
// artifact verification or the archival path described in §11.1.2(4).
// verifyDeal accepts an optional signal to cancel its passive chain reads.
export function createPublicPurchaseService(options) {
  return createPurchaseService(options, true);
}

// Retained source integration; not exported by the package entry point.
// D11: `store` is the host's PurchaseStore (purchaseStore admits only the
// package's concrete SQLite adapter); `purposes` holds the host's
// APPROVE_PURCHASE wallet-challenge purpose. Both are checked before any
// statement is prepared. Every action that prepares, approves, hands off or
// signs refuses first while purchase actions are held.
export function createPurchaseService({ db, config, ops, coordinates, accounts, verifier, chain, challenges, protocol = null, now = () => Date.now(), logger = null, store, purposes, chainReadTimeoutMs = 8000 }, diagnosticOnly = false) {
  const { transaction, isUniqueViolation } = purchaseStore(store);
  const PURPOSES = walletPurposes(purposes);
  if (!Number.isSafeInteger(chainReadTimeoutMs) || chainReadTimeoutMs < 1 || chainReadTimeoutMs > 60000) {
    throw new OperationError('invalid_configuration', 'chainReadTimeoutMs must be an integer from 1 to 60000');
  }
  const approvalTtlMs = PURCHASE_APPROVAL_TTL_MS;
  if (!db.prepare('PRAGMA table_info(operations)').all().some(column => column.name === 'handoff_expires_at')) {
    throw new OperationError('schema_migration_required', 'Migrate operations to include handoff_expires_at and provision explicit portal lifetimes before constructing the purchase service.');
  }
  const insertApproval = db.prepare(`INSERT INTO approvals (id, operation_id, challenge_id, signer_address, terms_hash, signature, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const approvalFor = db.prepare('SELECT * FROM approvals WHERE operation_id = ?');
  const portalCapability = db.prepare('SELECT account_id, kind, handoff_token_hash, handoff_expires_at FROM operations WHERE id = ?');
  const limits = config.purchaseLimits ?? PURCHASE_LIMITS;
  // Only pre-payment open states (ACTIONABLE) hold an unpaid slot; any other
  // status, including one added later, frees it. payment_mismatch frees the
  // slot (owner decision 2026-10-08). broadcast_reported and payment_uncertain
  // free the account slot but still block their own wallet through
  // assertNoUnresolved (BLOCKS_PURCHASE), which is unchanged.
  const openPurchases = `kind = 'purchase' AND id != ?
    AND status IN (${[...ACTIONABLE].map((status) => `'${status}'`).join(', ')})
    AND NOT (status IN ('awaiting_approval', 'agreement_pending') AND expires_at <= ?)`;
  const unpaidAccount = db.prepare(`SELECT count(*) AS n FROM operations WHERE ${openPurchases} AND account_id = ?`);
  const unpaidWallet = db.prepare(`SELECT count(*) AS n FROM operations WHERE ${openPurchases} AND json_extract(terms, '$.buyer.wallet') = ?`);
  const starts = db.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'purchase' AND account_id = ? AND created_at > ?");

  function assertPurchaseLimits(accountId, wallet, exceptId = '', starting = false) {
    const at = new Date(now()).toISOString();
    if (unpaidAccount.get(exceptId, at, accountId).n >= limits.maxUnpaidPerAccount) {
      throw new OperationError('unpaid_purchase_account_limit', `This account already has ${limits.maxUnpaidPerAccount} unpaid purchase(s) open. Pay or cancel an open purchase before starting another; no seller write or wallet approval was requested.`);
    }
    if (unpaidWallet.get(exceptId, at, wallet).n >= limits.maxUnpaidPerWallet) {
      throw new OperationError('unpaid_purchase_wallet_limit', `This buyer wallet already has ${limits.maxUnpaidPerWallet} unpaid purchase(s) open. Pay or cancel an open purchase before starting another; no seller write or wallet approval was requested.`);
    }
    if (starting && starts.get(accountId, new Date(now() - 60 * 60 * 1000).toISOString()).n >= limits.maxStartsPerHour) {
      throw new OperationError('purchase_start_limit', `This account has reached ${limits.maxStartsPerHour} purchase starts in the past hour. Wait until an earlier start leaves the one-hour window; no seller write or wallet approval was requested.`);
    }
  }

  async function assertBuyerFunds(wallet, price, mode) {
    if (!mode) return;
    let balance, fee;
    try {
      [balance, fee] = await Promise.all([chain.getAddressBalance(wallet, { encoding: config.demAmountEncoding }), chain.getTransactionFees()]);
      if (typeof balance !== 'bigint' || balance < 0n || typeof fee !== 'bigint' || fee < 0n) throw new Error('invalid funds read');
    } catch (error) {
      // The refusal stays generic; the operator log keeps the cause (kind,
      // code and message only, with any hex address in the message elided).
      logger?.warn('buyer_funds_read_failed', { kind: error?.kind ?? null, errorCode: error?.code ?? null, message: String(error?.message ?? error).replace(/0x[0-9a-f]{8,}/gi, '0x…') });
      throw buyerFundingError(new OperationError('buyer_balance_unavailable', 'The buyer balance or buyer fees could not be read exactly from the bound chain. Try again after the chain read is available; no seller write or wallet approval was requested.'), { wallet, price, config, network: chain.network });
    }
    // The native wallet bounds CREATE artifacts at 24 KiB, charged per 10 KiB.
    // Reserve all three chunks before Vet supplies the Agreement's exact bytes.
    const buyerFees = mode === OFFLINE_AGREEMENT_MODE ? 2n * fee + 3_000_000_000n : fee;
    const required = BigInt(price.amountOs) + buyerFees;
    if (balance < required) throw buyerFundingError(new OperationError('buyer_balance_insufficient', `The buyer balance does not cover the purchase price plus buyer fees. Required ${demAmount(required)} DEM (${price.amount} DEM price + ${demAmount(buyerFees)} DEM buyer fee reserve); available ${demAmount(balance)} DEM. Fund the buyer wallet before continuing; no seller write or wallet approval was requested.`, { balanceOs: balance.toString(), priceOs: price.amountOs, buyerFeesOs: buyerFees.toString(), requiredOs: required.toString() }), { wallet, price, config, network: chain.network });
  }

  function portalUrl(operation, token) {
    return `${config.publicOrigin}/portal/purchase/${operation.id}#t=${token}`;
  }

  function expireIfNeeded(operation) {
    if (approvalElapsed(operation)) {
      return ops.transition(operation.id, operation.status, 'expired', { data: { reason: 'approval window elapsed' } });
    }
    return operation;
  }

  function approvalElapsed(operation) {
    return (operation.status === 'awaiting_approval' || operation.status === 'agreement_pending') && Date.parse(operation.expiresAt) <= now();
  }

  // Diagnostic reads report an elapsed approval window without saving it.
  function projectExpiry(operation) {
    return approvalElapsed(operation) ? { ...operation, status: 'expired' } : operation;
  }

  function selectWallet(accountId, requested) {
    const wallets = accounts.listWallets(accountId).map((w) => w.address);
    if (wallets.length === 0) throw new OperationError('wallet_required', 'link a wallet to your account before purchasing (start_wallet_link)');
    if (requested) {
      if (!wallets.includes(requested)) throw new OperationError('wallet_not_linked', 'that wallet is not linked to your account');
      return requested;
    }
    if (wallets.length > 1) throw new OperationError('wallet_ambiguous', 'several wallets are linked; specify walletAddress');
    return wallets[0];
  }

  // The payment domain of the configured RPC now: a simulated loopback fixture
  // (no real chain identity), or a chain reporting the source-pinned genesis
  // identity. Unpinned or mismatched chains are refused; an unreachable RPC
  // propagates as unavailable.
  async function currentDomain(options) {
    let observed;
    try {
      observed = await chain.networkIdentity(options);
    } catch (error) {
      if (error instanceof OutboundError && error.kind === 'invalid') {
        throw new OperationError('network_identity_unverified', 'the configured Demos RPC did not report a chain identity; nothing was prepared, signed or sent');
      }
      throw error;
    }
    if (observed.mode === 'simulated-fixture') throw new OperationError('network_identity_mismatch', 'simulated purchase profiles are not supported');
    if (!chain.pinnedIdentity) {
      throw new OperationError('network_identity_unpinned', `no chain identity is pinned for network "${chain.network}" in this build, so payments on it are held; nothing was prepared, signed or sent`, { network: chain.network });
    }
    if (observed.identity !== chain.pinnedIdentity) {
      throw new OperationError('network_identity_mismatch', 'the configured Demos RPC reports a different chain than the one pinned for this network; nothing was prepared, signed or sent', { network: chain.network, pinned: chain.pinnedIdentity, observed: observed.identity });
    }
    return { network: chain.network, rail: PURCHASE_RAIL, mode: 'public-chain-read', chainIdentity: observed.identity };
  }

  // The configured RPC must still be the domain this purchase was bound to.
  async function assertBoundDomain(operation, options) {
    const current = await currentDomain(options);
    if (!sameDomain(operation.terms.domain, current)) {
      throw new OperationError('network_identity_mismatch', 'the configured Demos RPC is not the network this purchase is bound to; nothing was signed or sent', { bound: operation.terms.domain ?? null, current });
    }
    return current;
  }

  // Any unresolved wallet handoff (purchase or publication) from this sender
  // blocks a new one: they share the wallet's nonce space.
  function assertNoUnresolved(wallet, exceptOperationId) {
    const blocking = coordinates.unresolvedForSender(wallet, exceptOperationId ?? '', BLOCKS_PURCHASE);
    if (blocking.length > 0) {
      throw new OperationError('unresolved_payment', 'another wallet operation from this wallet has an unresolved outcome; resolve it before starting a new one', { operationId: blocking[0].operationId, status: blocking[0].status });
    }
  }

  async function prepare({ accountId, listingId, version, seller, idempotencyKey, walletAddress, protocol: mode }) {
    assertPurchaseActionsAdmitted();
    const wallet = selectWallet(accountId, walletAddress);
    protocol?.assertBuyerAccess?.(wallet);
    // A legacy request hashes exactly as before; a DACS request adds its mode.
    const request = { listingId, version, seller, wallet, ...(mode ? { protocol: mode } : {}) };
    // Idempotent replay first: the same key and request return the same
    // operation without re-verifying or being blocked by its own state.
    const existing = ops.findByKey(accountId, 'purchase', idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHashOf(request)) {
        throw new OperationError('idempotency_conflict', 'this idempotency key was already used for a different request');
      }
      const operation = expireIfNeeded(existing);
      return { operation, created: false, approvalUrl: linkable(operation) ? portalUrl(operation, ops.handoffTokenFor(operation.id)) : null, verification: null };
    }
    if (mode !== undefined && ![OFFLINE_AGREEMENT_MODE].includes(mode)) throw new OperationError('invalid_protocol', `unknown purchase protocol ${mode}`);
    if (mode && !protocol?.supportsMode(mode)) throw new OperationError('dacs_protocol_unavailable', 'DACS protocol purchases are not configured on this server (offline fixture builds only); nothing was prepared');
    assertNoUnresolved(wallet);
    assertPurchaseLimits(accountId, wallet, '', true);
    const verification = await verifier.verify({ listingId, version, seller });
    if (!verification.transactable) {
      throw new OperationError('listing_not_transactable', 'the listing did not pass independent verification for a v0.1 purchase', { checks: verification.checks, disposition: verification.disposition });
    }
    if (verification.payee === wallet) throw new OperationError('self_purchase', 'the buyer wallet is the seller wallet');
    const domain = await currentDomain();
    const dacs = mode ? protocol.prepareTerms({ verification, domain, sellerClaim: seller, mode }) : null;
    await assertBuyerFunds(wallet, verification.price, mode);
    // Recheck only TLS admission after the asynchronous balance read.
    if (mode) protocol.assertSellerAdmission(seller);
    const preparedAt = new Date(now()).toISOString();
    const approvalExpiresAt = new Date(now() + approvalTtlMs).toISOString();
    const terms = {
      profile: PURCHASE_PROFILE,
      operation: 'purchase',
      network: domain.network,
      rail: domain.rail,
      domain,
      buyer: { accountId, wallet },
      seller: { claim: seller, payee: verification.payee },
      listing: { listingId, version, contentHash: verification.contentHash, anchor: verification.anchor },
      price: verification.price,
      preparedAt,
      approvalExpiresAt,
      ...(dacs ? { protocol: dacs.terms } : {}),
    };
    const { operation, created, handoffToken } = transaction(db, () => {
      const replay = ops.findByKey(accountId, 'purchase', idempotencyKey);
      if (!replay) {
        assertNoUnresolved(wallet);
        assertPurchaseLimits(accountId, wallet, '', true);
      }
      return ops.createIdempotent({
        accountId,
        kind: 'purchase',
        idempotencyKey,
        request,
        status: dacs ? 'agreement_pending' : 'awaiting_approval',
        subjectId: `${seller}/${listingId}/v${version}`,
        terms,
        termsHash: contentHash(terms),
        expiresAt: approvalExpiresAt,
        state: { ...(config.sellerIdentities === 'on' ? { sellerDisplayName: verification.listing.seller.displayName?.slice(0, 200) } : {}), preparedVerification: { checks: verification.checks, evidence: verification.evidence }, ...(dacs ? { protocol: dacs.state } : {}) },
      });
    });
    return { operation: expireIfNeeded(operation), created, approvalUrl: portalUrl(operation, handoffToken), verification };
  }

  function ownedPurchase(accountId, operationId, token) {
    if (typeof accountId !== 'string' || !accountId || typeof operationId !== 'string' || !operationId) {
      throw new OperationError('not_found', 'purchase not found for this account');
    }
    // Public account labels do not authenticate a reader. Reuse the stored,
    // operation-scoped capability before consulting account-scoped host data.
    if (diagnosticOnly && handoffPurchase(operationId, token).accountId !== accountId) {
      throw new OperationError('not_found', 'purchase not found for this account');
    }
    const found = ops.get(accountId, operationId);
    if (!found || found.kind !== 'purchase' || found.accountId !== accountId || found.id !== operationId) {
      throw new OperationError('not_found', 'purchase not found for this account');
    }
    return found;
  }

  const nextFor = (operation, chainMode) => diagnosticOnly
    ? diagnosticPurchaseNext(operation)
    : purchaseNext(operation, chainMode);
  const protocolFor = operation => (diagnosticOnly ? diagnosticProtocolView : protocolView)(operation,
    { now, enabled: config.deliveryDeadlineWatch === 'on' });

  const transferDiagnosticFields = ['status', 'txHash', 'payer', 'payee', 'amountOs', 'blockNumber', 'includedAt', 'sourceDisposition', 'reason'];
  function diagnosticFields(value, fields) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const key of fields) {
      const field = value[key];
      if (field === null || typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field))
        || (typeof field === 'string' && field.length <= (key === 'reason' ? 240 : 1024))) result[key] = field;
    }
    return result;
  }
  function diagnosticCoordinates(coords) {
    if (!coords) return null;
    const record = diagnosticFields(coords, ['operationId', 'kind', 'network', 'from', 'nonceFence', 'expectedNonce', 'target', 'amountOs', 'payloadHash', 'savedAt', 'handoffs', 'reportedTxHash', 'reportedAt', 'verifiedAt']);
    const observation = coords.observation;
    record.observation = observation ? {
      ...diagnosticFields(observation, [...transferDiagnosticFields, 'outcome', 'chainMode', 'observer', 'observedAt', 'nativeNonceResolved', 'nativeLaneResolved', 'supersededBy', 'slotConsumed', 'slotConsumedCarried', 'signedByAlternateKey']),
      ...(observation.observation ? { observation: diagnosticFields(observation.observation, transferDiagnosticFields) } : {}),
    } : null;
    return record;
  }

  // Read-only: an elapsed approval window is reported as expired without
  // persisting the transition (mutating paths persist it).
  function status(accountId, operationId, token) {
    const found = ownedPurchase(accountId, operationId, token);
    const operation = projectExpiry(found);
    const coords = coordinates.get(operation.id);
    const approval = approvalFor.get(operation.id);
    const history = ops.history(operation.id);
    const result = {
      operation: diagnosticOnly ? projectDiagnosticOperation(operation) : operation,
      approval: approval ? { signer: approval.signer_address, approvedAt: approval.approved_at, termsHash: approval.terms_hash } : null,
      coordinates: diagnosticOnly ? diagnosticCoordinates(coords) : coords,
      approvalUrl: !diagnosticOnly && linkable(operation) ? portalUrl(operation, ops.handoffTokenFor(operation.id)) : null,
      next: nextFor(operation, coords?.observation?.chainMode),
      ...(operation.terms.protocol ? { protocol: protocolFor(operation) } : {}),
      history: diagnosticOnly ? history.slice(-DIAGNOSTIC_LIMITS.collectionItems) : history,
    };
    return diagnosticOnly ? projectDiagnostic(result) : result;
  }

  // ---- portal (browser) side; every call carries the handoff token ----

  function handoffPurchase(operationId, token) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256 || typeof token !== 'string' || !token || token.length > 1024) {
      throw new OperationError('not_found', 'unknown or invalid approval link');
    }
    // Portal access is an application capability, independent of DACS action
    // admission and of the operation's approval window. Authenticate stored
    // bytes on every read; a permissive host lookup cannot grant access.
    const capability = portalCapability.get(operationId);
    const expiry = typeof capability?.handoff_expires_at === 'string' ? Date.parse(capability.handoff_expires_at) : NaN;
    const clock = now();
    // A host business clock may shorten a capability, but cannot extend its
    // wall-clock lifetime. Unknown or out-of-range epoch milliseconds deny access.
    const suppliedHash = createHash('sha256').update(`dacs-handoff-hash:${token}`).digest();
    if (!capability || capability.kind !== 'purchase' || !validIncludedAt(clock)
      || !validIncludedAt(expiry) || new Date(expiry).toISOString() !== capability.handoff_expires_at
      || !(expiry > Math.max(clock, Date.now()))
      || !/^[0-9a-f]{64}$/.test(capability.handoff_token_hash ?? '')
      || !timingSafeEqual(suppliedHash, Buffer.from(capability.handoff_token_hash, 'hex'))) {
      throw new OperationError('not_found', 'unknown or invalid approval link');
    }
    const found = ops.getByHandoff(operationId, token);
    if (!found || found.kind !== 'purchase' || found.id !== operationId || found.accountId !== capability.account_id) throw new OperationError('not_found', 'unknown or invalid approval link');
    return found;
  }

  function authorizedPortalPurchase(operationId, token) {
    const found = handoffPurchase(operationId, token);
    protocol?.assertBuyerAccess?.(found.terms.buyer.wallet, found);
    return found;
  }

  // Entry for the portal's approval and payment actions, which save expiry.
  // The public diagnostic service projects it without saving.
  function portalOperation(operationId, token) {
    const found = authorizedPortalPurchase(operationId, token);
    return diagnosticOnly ? projectDiagnosticOperation(projectExpiry(found)) : expireIfNeeded(found);
  }

  // Evidence the portal may show, taken only from what was recorded: the
  // listing verification made at prepare time and any chain observation of
  // the payment. Never inferred from the configured network or RPC URL.
  // Read-only: an elapsed approval window is reported, not saved.
  function portalEvidence(operationId, token) {
    const operation = projectExpiry(authorizedPortalPurchase(operationId, token));
    const coords = coordinates.get(operation.id);
    const listingMode = operation.state?.preparedVerification?.evidence?.chainMode ?? null;
    const directoryMode = operation.state?.preparedVerification?.evidence?.directoryMode ?? null;
    const observation = coords?.observation ?? null;
    const settled = coords?.verifiedAt && operation.status === 'settled_verified';
    const modes = [listingMode, directoryMode, observation?.chainMode].filter(Boolean);
    const evidence = {
      listingMode,
      directoryMode,
      paymentMode: observation?.chainMode ?? null,
      simulated: modes.includes('simulated-fixture'),
      reportedTxHash: coords?.reportedTxHash ?? null,
      networkIdentity: networkIdentityLabel(operation.terms.domain),
      commitment: purchaseCommitment(operation),
      receipt: settled
        ? {
            ...(diagnosticOnly ? { historical: true } : {}),
            txHash: observation.observation?.txHash ?? coords.reportedTxHash,
            blockNumber: observation.observation?.blockNumber ?? null,
            includedAt: validIncludedAt(observation.observation?.includedAt) ? new Date(observation.observation.includedAt).toISOString() : null,
            amountOs: observation.observation?.amountOs ?? null,
            chainMode: observation.chainMode,
            verifiedAt: coords.verifiedAt,
            // What this is not, recorded with the observation itself.
            ...OBSERVATION_LIMITS,
            rpcOrigin: observation.rpcOrigin ?? null,
            commitmentOnChain: false,
          }
        : null,
      next: nextFor(operation, observation?.chainMode),
      actionable: !diagnosticOnly && linkable(operation),
      ...(operation.terms.protocol ? { protocol: protocolFor(operation) } : {}),
    };
    return diagnosticOnly ? projectDiagnostic(evidence) : evidence;
  }

  async function issueApprovalChallenge({ operationId, token, address }) {
    assertPurchaseActionsAdmitted();
    let operation = portalOperation(operationId, token);
    assertAgreementPaymentHeld(operation);
    if (operation.status !== 'awaiting_approval') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    if (address !== operation.terms.buyer.wallet) throw new OperationError('wrong_wallet', 'connect the wallet bound to this purchase');
    assertNoUnresolved(operation.terms.buyer.wallet, operation.id);
    // Preflight: never ask for a signature on terms the listing no longer
    // offers. Handoff re-verification below remains the authoritative check.
    const t = operation.terms;
    const recheck = await verifier.verify({ listingId: t.listing.listingId, version: t.listing.version, seller: t.seller.claim, purchaseId: operation.id });
    const unavailable = recheck.checks?.some((c) => !c.ok && /unavailable/.test(c.detail ?? ''));
    if (unavailable) throw new OperationError('listing_recheck_unavailable', 'the listing could not be re-checked right now; nothing was signed, try again shortly');
    if (!recheck.transactable || recheck.contentHash !== t.listing.contentHash || recheck.price?.amountOs !== t.price.amountOs || recheck.payee !== t.seller.payee) {
      operation = move(operation, 'terms_changed', { stage: 'pre-approval', checks: recheck.checks });
      throw new OperationError('terms_changed', 'the listing changed or no longer verifies; nothing was signed. Prepare a new purchase to see the current terms.', { status: operation.status });
    }
    // Never ask for an approval on a network other than the bound one.
    try {
      await assertBoundDomain(operation);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      operation = move(operation, 'terms_changed', { stage: 'pre-approval', reason: error.code, details: error.details ?? null });
      throw new OperationError(error.code, `${error.message}. Prepare a new purchase on the configured network.`, { status: operation.status });
    }
    // A DACS purchase is approved only against a re-read finalized commitment
    // (independent of the seller); a failed re-read signs nothing. This gate
    // may reuse the purchase's own verified proofs within their short TTL; the
    // handoff gate below re-reads fresh before any payment. With
    // DACS_READBACK_CACHE=1 its Agreement read re-checks the current program
    // state but reuses this purchase's authenticated transaction and block.
    if (operation.terms.protocol) await protocolGate(operation, 'pre-approval');
    return challenges.issue({ purpose: PURPOSES.APPROVE_PURCHASE, address, accountId: operation.accountId, binding: approvalBinding(operation) });
  }

  async function protocolGate(operation, stage) {
    if (!protocol?.available) throw new OperationError('dacs_protocol_unavailable', 'DACS protocol purchases are not configured on this server; nothing was signed or sent');
    try {
      await protocol.recheckCommitment(operation, { reuseVerified: stage === 'pre-approval' });
    } catch (error) {
      if (error instanceof OperationError) ops.record(operation.id, 'commitment_recheck_refused', { stage, reason: error.code });
      throw error;
    }
  }

  async function approve({ operationId, token, challengeId, signature }) {
    assertPurchaseActionsAdmitted();
    const operation = portalOperation(operationId, token);
    assertAgreementPaymentHeld(operation);
    if (operation.status !== 'awaiting_approval') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    const expected = { ...approvalBinding(operation), address: operation.terms.buyer.wallet };
    transaction(db, () => {
      assertNoUnresolved(operation.terms.buyer.wallet, operation.id);
      const consumed = challenges.verifyAndConsume({ challengeId, purpose: PURPOSES.APPROVE_PURCHASE, expectedBinding: expected, signature, consumedBy: operation.id });
      insertApproval.run(newId('apv'), operation.id, consumed.challengeId, consumed.address, operation.termsHash, signature, new Date(now()).toISOString());
      ops.transition(operation.id, 'awaiting_approval', 'approved', { data: { signer: consumed.address, challengeId: consumed.challengeId } });
    });
    return prepareHandoff({ operationId, token });
  }

  // Re-verify the listing and the bound network, fence the buyer nonce, and
  // save coordinates BEFORE the payload leaves the server. Re-entry returns the
  // same payload only while the nonce fence proves nothing was consumed and
  // the configured RPC is still the bound network.
  async function prepareHandoff({ operationId, token }) {
    assertPurchaseActionsAdmitted();
    const operation = portalOperation(operationId, token);
    if (usesNativeAgreementPayment(operation)) return protocol.withNativePaymentLane(operation, () => prepareHandoffCore({ operationId, token }));
    return prepareHandoffCore({ operationId, token });
  }
  async function prepareHandoffCore({ operationId, token }) {
    let operation = portalOperation(operationId, token);
    assertAgreementPaymentHeld(operation);
    const t = operation.terms;
    if (operation.status === 'payment_handoff') {
      const coords = coordinates.get(operation.id);
      if (usesNativeAgreementPayment(operation)) {
        ops.record(operation.id, 'handoff_readback_only', { reason: 'native payment delivery already issued', payloadHash: coords.payloadHash });
        return { operation, payload: null, refused: 'native_payment_already_issued' };
      }
      try {
        await assertBoundDomain(operation);
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        // Not re-issued; the status stays open because the old payload may still land.
        ops.record(operation.id, 'handoff_refused', { reason: error.code });
        return { operation, payload: null };
      }
      const nonce = await chain.getAddressNonce(t.buyer.wallet);
      if (nonce === coords.nonceFence) {
        if (t.protocol) {
          try {
            await protocolGate(operation, 'handoff-reissue');
          } catch (error) {
            if (!(error instanceof OperationError)) throw error;
            return { operation, payload: null, refused: error.code };
          }
        }
        coordinates.countHandoff(operation.id);
        ops.record(operation.id, 'handoff_reissued', { nonce });
        return { operation, payload: coords.payload, expectedNonce: coords.expectedNonce };
      }
      operation = move(operation, 'payment_uncertain', { reason: 'buyer nonce advanced without a reported transaction', nonce, fence: coords.nonceFence });
      return { operation, payload: null };
    }
    if (operation.status !== 'approved') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    // Authoritative: always a fresh chain readback, never the preflight's.
    const recheck = await verifier.verify({ listingId: t.listing.listingId, version: t.listing.version, seller: t.seller.claim, purchaseId: operation.id, fresh: true });
    if (!recheck.transactable || recheck.contentHash !== t.listing.contentHash || recheck.price?.amountOs !== t.price.amountOs || recheck.payee !== t.seller.payee) {
      operation = move(operation, 'terms_changed', { checks: recheck.checks });
      return { operation, payload: null };
    }
    try {
      await assertBoundDomain(operation);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      operation = move(operation, 'terms_changed', { reason: error.code, details: error.details ?? null });
      return { operation, payload: null };
    }
    // No handoff before a fresh independent commitment readback; the payload
    // below pays exactly the committed payee and amount (checked equal to the
    // prepared terms by the readback). Nothing was sent, so it stays approved.
    if (t.protocol) {
      try {
        await protocolGate(operation, 'handoff');
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        ops.record(operation.id, 'handoff_refused', { reason: error.code });
        return { operation, payload: null, refused: error.code };
      }
    }
    const nonceFence = await chain.getAddressNonce(t.buyer.wallet);
    const expectedNonce = nonceFence + 1;
    const payload = buildNativeTransferPayload({
      from: t.buyer.wallet,
      to: t.seller.payee,
      amountOs: t.price.amountOs,
      nonce: expectedNonce,
      timestamp: now(),
      encoding: config.demAmountEncoding,
    });
    // Approved out of order (another purchase's Agreement CREATE landed
    // between this purchase's CREATE and its approval), a native payment can
    // carry the settlement terms of a cancelled purchase's payment. The
    // operator's source refuses that transfer, and sent it would also settle
    // the cancelled purchase, so it is not offered for signing: the purchase
    // stays approved, to be cancelled and prepared again. The source's records
    // are read under this payer's workflow and payment-lane locks, which every
    // cancellation that writes them also holds.
    if (usesNativeAgreementPayment(operation) && await protocol.nativePaymentTermsCancelled(operation, payload)) {
      ops.record(operation.id, 'handoff_refused', { reason: 'payment_terms_cancelled', expectedNonce });
      return { operation, payload: null, refused: 'payment_terms_cancelled', refusal: PAYMENT_TERMS_CANCELLED };
    }
    let issued = false;
    const coords = transaction(db, () => {
      // A concurrent handoff may have saved first; its coordinates win.
      const existing = coordinates.get(operation.id);
      if (existing) return existing;
      assertNoUnresolved(t.buyer.wallet, operation.id);
      const consumed = coordinates.walletConsumedSenderNonce(t.buyer.wallet, t.network, expectedNonce)
        .find(({ operationId }) => sameDomain(ops.get(operation.accountId, operationId)?.terms.domain, t.domain));
      if (consumed) throw new OperationError('nonce_readback_unavailable', 'a verified payment consumed this nonce while handoff was being prepared; retry the handoff to read the current nonce', { operationId: consumed.operationId });
      const saved = coordinates.save({ operationId: operation.id, kind: 'dem-transfer', network: t.network, from: t.buyer.wallet, nonceFence, expectedNonce, target: t.seller.payee, amountOs: t.price.amountOs, payload });
      issued = true;
      ops.transition(operation.id, 'approved', 'payment_handoff', { data: { nonceFence, expectedNonce, payloadHash: saved.payloadHash, recheck: recheck.evidence.chainMode, commitment: purchaseCommitment(operation) } });
      return saved;
    });
    return { operation: ops.get(operation.accountId, operation.id), payload: usesNativeAgreementPayment(operation) && !issued ? null : coords.payload, expectedNonce };
  }

  // Wallet result from the portal. A hash is only a pointer for verification.
  async function nativePaymentLane({ operationId, token, key }) {
    assertPurchaseActionsAdmitted();
    const operation = portalOperation(operationId, token), approval = approvalFor.get(operation.id);
    if (!usesNativeAgreementPayment(operation) || operation.status !== 'payment_handoff' || !coordinates.get(operation.id)
      || !approval || approval.terms_hash !== operation.termsHash || approval.signer_address !== operation.terms.buyer.wallet) throw new OperationError('native_payment_lane_held', 'a normal approved, one-time native handoff is required; CREATE authority is not payment authority');
    await assertBoundDomain(operation); await protocolGate(operation, 'wallet-native-lane-read');
    return { record: await protocol.readNativePaymentLane(operation, key) };
  }
  async function reportWalletResult({ operationId, token, txHash, walletError, walletErrorCode }) {
    if (diagnosticOnly) assertPurchaseActionsAdmitted();
    let operation = portalOperation(operationId, token);
    assertAgreementPaymentHeld(operation);
    if (walletError) {
      // The wallet's error code (portal.js) is the page's word: recorded, and
      // never trusted alone.
      const code = typeof walletErrorCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(walletErrorCode) ? walletErrorCode : null;
      ops.record(operation.id, 'wallet_error', { message: String(walletError).slice(0, 200), ...(code ? { code } : {}) });
      if (usesNativeAgreementPayment(operation)) {
        // A cancellation with this handoff's settlement terms appeared after
        // the handoff (one before it is refused there): the operator's source
        // refuses every transfer with those terms at every gate, keeps no such
        // cancellation once it has claimed or sent one, and keeps each
        // refusal of this handoff's exact transfer apart from that record, so
        // a later cancellation that prunes the record does not erase it
        // (nativePaymentRefused). This attempt sent nothing. With no hash
        // reported the purchase stays payment_handoff, so cancelling it ends
        // it, also once its nonce has been used (refusedHandoff).
        if (operation.status === 'payment_handoff' && !txHash) {
          const refused = await protocol.nativePaymentRefused(operation, coordinates.get(operation.id));
          if (refused) {
            ops.record(operation.id, 'handoff_refused', { reason: 'payment_terms_cancelled', gate: refused.refusal?.gate ?? null });
            return { operation, verification: null };
          }
        }
        if (operation.status === 'payment_handoff') operation = move(operation, 'payment_uncertain', { reason: 'one-time native wallet delivery returned an error; readback only' });
        if (txHash) return continueProtocol(await attachHashAndVerify(operation, txHash, 'portal-wallet-error'));
      }
      return { operation, verification: null };
    }
    return continueProtocol(await attachHashAndVerify(operation, txHash, 'portal'));
  }

  // After a verified transfer observation, a DACS purchase drives its seller
  // claim, evidence and delivery checks. Every retry re-claims the same
  // observed transaction; no step here can send or re-send a payment.
  async function continueProtocol(result) {
    const operation = result.operation;
    if (!operation.terms.protocol || !protocol?.available) return result;
    if (operation.status !== 'settled_verified' && operation.status !== 'agreement_pending') return result;
    const advanced = await protocol.recheck(operation, coordinates.get(operation.id));
    return { ...result, operation: advanced };
  }

  function canonicalHash(value) {
    const match = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(String(value ?? '').trim());
    if (!match) throw new OperationError('invalid_tx_hash', 'transaction hash must be 32-byte hex');
    return match[1].toLowerCase();
  }

  // CAS transition that tolerates a concurrent caller having already moved
  // the operation (returns the current state instead of throwing).
  function move(operation, toStatus, data) {
    if (operation.status === toStatus) return ops.get(operation.accountId, operation.id);
    try {
      return ops.transition(operation.id, operation.status, toStatus, { data });
    } catch (error) {
      if (error instanceof OperationError && error.code === 'invalid_state') return ops.get(operation.accountId, operation.id);
      throw error;
    }
  }

  // attachOnly (the portal's automatic report): the hash is attached only
  // where none is recorded, atomically; a recorded pointer is never replaced
  // and null is returned so the caller reads that pointer back instead.
  async function attachHashAndVerify(operation, rawHash, source, { attachOnly = false } = {}) {
    const hash = canonicalHash(rawHash);
    if (operation.status === 'settled_verified') {
      const coords = coordinates.get(operation.id);
      if (coords.reportedTxHash !== hash && attachOnly) return null;
      if (coords.reportedTxHash !== hash) throw new OperationError('hash_conflict', 'this purchase already settled with a different transaction');
      return verifySettlement(operation);
    }
    if (!['payment_handoff', 'broadcast_reported', 'payment_uncertain', 'cancelled'].includes(operation.status)) {
      throw new OperationError('invalid_state', `purchase is ${operation.status}; there is no transaction to verify`);
    }
    if (!coordinates.get(operation.id)) throw new OperationError('invalid_state', 'nothing was handed to the wallet for this purchase');
    if (!coordinates.reportHash(operation.id, hash)) {
      if (attachOnly) return null;
      if (!coordinates.replaceUnobservedHash(operation.id, hash)) {
        throw new OperationError('hash_conflict', 'a different transaction already occupies or settled this purchase');
      }
      ops.record(operation.id, 'reported_hash_replaced', { txHash: hash, source });
    }
    let current = operation;
    if (current.status === 'payment_handoff' || current.status === 'payment_uncertain') {
      current = move(current, 'broadcast_reported', { txHash: hash, source });
    }
    return verifySettlement(current);
  }

  const same = (observed, expected) => {
    try {
      return normalizeDemosAddress(observed) === normalizeDemosAddress(expected);
    } catch {
      return false;
    }
  };
  const readableAddress = (value) => {
    try {
      normalizeDemosAddress(value);
      return true;
    } catch {
      return false;
    }
  };

  // A reported hash is a pointer. It can only close the purchase (settled,
  // mismatched or failed) once the configured RPC, still reporting the bound
  // network, shows that transaction occupies this purchase's nonce slot: sent
  // by the approved buyer wallet with the pre-saved expected nonce. Any other
  // transaction is rejected as a pointer and the purchase stays unresolved, so
  // a wrong hash can never enable a re-payment. A match is tuple-only and one
  // node's view (OBSERVATION_LIMITS), recorded as such.
  function recordObservation(...args) {
    if (!coordinates.recordObservation(...args)) throw new OperationError('stale_readback', 'the retained purchase pointer changed; observation was not saved');
  }

  const nativeResolutionAvailable = () => protocol?.nativePaymentReadbackAvailable !== false && typeof protocol?.nativePaymentSuperseded === 'function';
  const nativeResolutionHelp = nextStep => nativeResolutionAvailable() ? { nextStep } : {
    nativeReadback: 'unavailable',
    nextStep: 'Native source reconciliation is unavailable in this host. Reconcile the retained journal in the original qualified host.',
  };

  async function resolveNativeSupersession(operation) {
    if (!usesNativeAgreementPayment(operation) || operation.status !== 'superseded') return true;
    const coords = coordinates.get(operation.id);
    if (coords?.observation?.nativeLaneResolved === true) return true;
    if (!nativeResolutionAvailable()) return false;
    const owner = ops.get(operation.accountId, coords?.observation?.supersededBy);
    const settled = owner && coordinates.get(owner.id);
    try {
      if (owner?.status !== 'settled_verified' || !settled?.verifiedAt || settled.reportedTxHash !== coords.observation.txHash
        || settled.from !== coords.from || settled.network !== coords.network || settled.expectedNonce !== coords.expectedNonce || !sameDomain(owner.terms.domain, operation.terms.domain)) {
        throw new OperationError('invalid_state', 'native supersession lacks the matching settled nonce owner');
      }
      if (!await protocol?.nativePaymentSuperseded?.(operation, coords)) throw new OperationError('native_lane_unresolved', 'the source intent could not be resolved');
      transaction(db, () => {
        const saved = coordinates.get(operation.id);
        const current = ops.get(operation.accountId, operation.id);
        const currentOwner = ops.get(operation.accountId, owner.id);
        const currentSettled = coordinates.get(owner.id);
        if (current?.status !== 'superseded' || saved?.reportedTxHash !== coords.reportedTxHash
          || saved?.observation?.supersededBy !== owner.id || saved.observation.txHash !== coords.observation.txHash
          || currentOwner?.status !== 'settled_verified' || !currentSettled?.verifiedAt
          || currentSettled.reportedTxHash !== saved.observation.txHash
          || currentSettled.from !== saved.from || currentSettled.network !== saved.network
          || currentSettled.expectedNonce !== saved.expectedNonce || !sameDomain(currentOwner.terms.domain, current.terms.domain)) {
          throw new OperationError('native_lane_unresolved', 'the retained pointer or settled nonce owner changed during source reconciliation');
        }
        if (saved.observation.nativeLaneResolved === true) return;
        recordObservation(operation.id, { ...saved.observation, nativeLaneResolved: true }, false, saved.reportedTxHash);
        ops.record(operation.id, 'native_supersession_resolved', { supersededBy: owner.id, txHash: saved.observation.txHash });
      });
      return true;
    } catch (error) {
      transaction(db, () => {
        const pending = ops.history(operation.id).findLast((event) => event.type === 'native_supersession_pending');
        if (pending?.data.reason !== error.message) ops.record(operation.id, 'native_supersession_pending', { reason: error.message });
      });
      return false;
    }
  }

  // Native purchases still reserving a settled purchase's nonce: an
  // alternate-signer settlement leaves them open (verifySettlement).
  const nativeNonceCompetitors = (operation, coords) => operation.status !== 'settled_verified' || coords.observation.signedByAlternateKey !== true ? [] : coordinates.unresolvedForSender(coords.from, operation.id, BLOCKS_PURCHASE).flatMap((pending) => {
    const other = ops.get(operation.accountId, pending.operationId), reservation = coordinates.get(pending.operationId);
    return other?.kind === 'purchase' && usesNativeAgreementPayment(other) && BLOCKS_PURCHASE.includes(other.status) && reservation.from === coords.from && reservation.network === coords.network
      && reservation.expectedNonce === coords.expectedNonce && sameDomain(other.terms.domain, operation.terms.domain) ? [{ other, reservation }] : [];
  });

  // A confirmed hash consumed this purchase's own reserved nonce (settled or
  // mismatched). Retained source intents with a different hash at that nonce
  // can never land; release them with the same proof as a supersession.
  async function resolveNativeNonceConsumption(operation) {
    const coords = coordinates.get(operation.id);
    if (coords?.observation?.nativeNonceResolved === true) return true;
    if (!nativeResolutionAvailable()) return false;
    try {
      if (!['settled_verified', 'payment_mismatch'].includes(operation.status) || coords?.observation?.slotConsumed !== true || coords.observation.txHash !== coords.reportedTxHash) {
        throw new OperationError('invalid_state', 'native nonce reconciliation lacks this purchase\'s confirmed slot');
      }
      if (!await protocol?.nativePaymentSuperseded?.(operation, coords)) throw new OperationError('native_lane_unresolved', 'the source intent could not be resolved');
      // Supersede a still-open native purchase only once the source journal
      // shows its reported hash was released by this settlement's
      // supersededByHash proof; never on a vacuous proof (null), a nonce-fence
      // failure or without a reported hash (it resolves through its own paths).
      const released = nativeNonceCompetitors(operation, coords).length ? await protocol?.nativeIntentsSupersededBy?.(operation, coords) : null;
      transaction(db, () => {
        if (coordinates.get(operation.id).observation.nativeNonceResolved === true) return;
        for (const { other, reservation } of released?.length ? nativeNonceCompetitors(operation, coords) : []) {
          if (!reservation.reportedTxHash || !released.includes(reservation.reportedTxHash)) continue;
          recordObservation(other.id, { ...coords.observation, supersededBy: operation.id, nativeLaneResolved: true }, false, reservation.reportedTxHash);
          ops.transition(other.id, other.status, 'superseded', { data: { supersededBy: operation.id, txHash: coords.reportedTxHash } });
          ops.record(other.id, 'native_supersession_resolved', { supersededBy: operation.id, txHash: coords.reportedTxHash });
        }
        coordinates.markNativeNonceResolved(operation.id);
        ops.record(operation.id, 'native_nonce_resolved', { txHash: coords.reportedTxHash });
      });
      return true;
    } catch (error) {
      transaction(db, () => {
        const pending = ops.history(operation.id).findLast((event) => event.type === 'native_nonce_pending');
        if (pending?.data.reason !== error.message) ops.record(operation.id, 'native_nonce_pending', { reason: error.message });
      });
      return false;
    }
  }

  async function withNativeNonceResolution(result) {
    if (!usesNativeAgreementPayment(result.operation)) return result;
    const resolved = await resolveNativeNonceConsumption(result.operation);
    return { ...result, verification: { ...result.verification, nativeNonceResolved: resolved, ...(!resolved ? nativeResolutionHelp('Retry verify_deal on this purchase to finish releasing other retained native source intents at its nonce.') : {}) } };
  }

  async function finishNativeSupersessions(operation) {
    for (const pending of coordinates.unresolvedForSender(operation.terms.buyer.wallet, operation.id, ['superseded'])) {
      const evidence = coordinates.get(pending.operationId).observation;
      if (evidence?.supersededBy !== operation.id || evidence.nativeLaneResolved === true) continue;
      const other = ops.get(operation.accountId, pending.operationId);
      if (other) await resolveNativeSupersession(other);
    }
  }

  // The host reader's result is an observation, not a terms contradiction
  // until its fields have the documented types. Discard malformed data before
  // persisting it (in particular, bigint cannot be serialized as JSON).
  function checkedTransferObservation(value, hash) {
    const invalid = reason => ({ status: 'malformed', reason });
    const exceeded = new RangeError('chain observation exceeds its byte limit');
    try {
      let used = 0;
      const hasSourceDisposition = value != null && Object.hasOwn(value, 'sourceDisposition');
      const containers = new WeakMap();
      const charge = amount => { used += amount; if (used > MAX_TRANSFER_OBSERVATION_BYTES) throw exceeded; };
      const stringBytes = text => {
        if (text.length > MAX_TRANSFER_OBSERVATION_BYTES - used) throw exceeded;
        return Buffer.byteLength(JSON.stringify(text));
      };
      const bytes = JSON.stringify(value, function (key, field) {
        const parent = containers.get(this), array = Array.isArray(field);
        const omitted = field === undefined || ['function', 'symbol'].includes(typeof field);
        if (omitted && !parent?.array) return field;
        if (parent) { charge(parent.count++ ? 1 : 0); if (!parent.array) charge(stringBytes(key) + 1); }
        if (field && typeof field === 'object') {
          // Bound native JSON's key/index enumeration before it allocates it.
          if (array && field.length > MAX_TRANSFER_OBSERVATION_BYTES) throw exceeded;
          let count = 0;
          for (const name in field) if (Object.hasOwn(field, name) && (++count > MAX_TRANSFER_OBSERVATION_BYTES || name.length > MAX_TRANSFER_OBSERVATION_BYTES)) throw exceeded;
          charge(2); containers.set(field, { array, count: 0 });
        } else charge(typeof field === 'string' ? stringBytes(field) : (JSON.stringify(omitted ? null : field)?.length ?? 0));
        return field;
      });
      if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_TRANSFER_OBSERVATION_BYTES) return invalid('chain observation exceeds its byte limit');
      value = JSON.parse(bytes);
      if (hasSourceDisposition && !Object.hasOwn(value, 'sourceDisposition')) return invalid('chain observation omitted its source disposition');
    } catch (error) { return invalid(error === exceeded ? exceeded.message : 'chain observation must be JSON serializable'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('chain observation must be an object');
    if (!['included', 'pending', 'not-found', 'failed', 'invalid', 'unavailable'].includes(value.status)) return invalid('chain observation status is unsupported');
    if (value.reason !== undefined && typeof value.reason !== 'string') return invalid('chain observation reason must be text');
    if (value.status === 'included') {
      if (typeof value.amountOs !== 'string' || !OS_INTEGER.test(value.amountOs)) return invalid('included amountOs must be canonical decimal OS text');
      if (!readableAddress(value.payer) || !readableAddress(value.payee)) return invalid('included payer and payee must be readable Demos addresses');
      if (!Number.isSafeInteger(value.blockNumber) || value.blockNumber < 0) return invalid('included blockNumber must be a nonnegative safe integer');
      if (value.includedAt !== undefined && !validIncludedAt(value.includedAt)) return invalid('included includedAt must be valid nonnegative integer epoch milliseconds');
      try {
        if (typeof value.txHash !== 'string' || canonicalHash(value.txHash) !== hash) return invalid('included txHash differs from the requested hash');
      } catch { return invalid('included txHash must be a transaction hash'); }
    }
    return value;
  }

  async function diagnosticReadback(operation, rawHash, signal) {
    operation = projectExpiry(operation);
    const hash = coordinates.get(operation.id)?.reportedTxHash;
    if (rawHash != null && canonicalHash(rawHash) !== hash) throw new OperationError('invalid_state', 'diagnostic readback only accepts the recorded transaction hash');
    let observation = null;
    if (hash) {
      try {
        observation = await raceWithDeadline(async options => {
          await assertBoundDomain(operation, options);
          options.signal.throwIfAborted();
          const observe = chain.observePassiveTransfer ?? (usesNativeAgreementPayment(operation) ? null : chain.observeTransfer);
          if (typeof observe !== 'function') throw new OperationError('passive_reader_unavailable', 'native diagnostics require a passive chain reader');
          const value = await observe.call(chain, hash, options);
          options.signal.throwIfAborted();
          // Retain only bounded primitive contract fields. Never traverse or
          // serialize arbitrary host extension objects or collections.
          if (!value || typeof value !== 'object' || Array.isArray(value)) return checkedTransferObservation(value, hash);
          const projected = {};
          for (const key of transferDiagnosticFields) {
            const field = value[key];
            if (field === undefined) continue;
            if ((!['string', 'number', 'boolean'].includes(typeof field) && field !== null)
              || (typeof field === 'string' && field.length > (key === 'reason' ? 240 : 1024))) {
              return { status: 'malformed', reason: 'host observation field exceeds its bounded primitive contract' };
            }
            projected[key] = field;
          }
          return checkedTransferObservation(projected, hash);
        }, { timeoutMs: chainReadTimeoutMs, signal });
      } catch (error) {
        observation = { status: 'unavailable', reason: String(error?.message ?? error).slice(0, 240),
          ...(typeof error?.kind === 'string' && error.kind.length <= 64 ? { kind: error.kind } : {}),
          ...(typeof error?.code === 'string' && error.code.length <= 64 ? { code: error.code } : {}) };
      }
    }
    return projectDiagnostic({ operation: projectDiagnosticOperation(operation), verification: { outcome: 'readback_only', authority: 'unqualified_host',
      observation, termsMatch: observation?.status === 'included'
        && (!Object.hasOwn(observation, 'sourceDisposition') || observation.sourceDisposition === 'included')
        ? same(observation.payer, operation.terms.buyer.wallet) && same(observation.payee, operation.terms.seller.payee) && observation.amountOs === operation.terms.price.amountOs
        : null, ...OBSERVATION_LIMITS } });
  }

  async function verifySettlement(operation) {
    if (diagnosticOnly) return diagnosticReadback(operation);
    // Unverified readback cannot undo a nonce-proven cancellation.
    const moveUnverified = (toStatus, data) => operation.status === 'cancelled' ? ops.get(operation.accountId, operation.id) : move(operation, toStatus, data);
    // An unverified re-read replaces the stored observation but keeps the
    // completed native source reconciliation of the same slot, and the same
    // hash's recorded slot consumption with its signer (a confirmed body
    // consumed it; a later pending, unavailable or failed read cannot undo
    // that). slotConsumedCarried marks the carry-over: its pointer is never detached.
    const recordUnverified = (observation) => {
      const stored = coordinates.get(operation.id)?.observation;
      const reconciled = usesNativeAgreementPayment(operation) && stored?.nativeNonceResolved === true && stored.txHash === observation.txHash;
      const consumed = observation.slotConsumed !== true && stored?.slotConsumed === true && stored.txHash === observation.txHash;
      recordObservation(operation.id, {
        ...observation,
        ...(reconciled ? { nativeNonceResolved: true } : {}),
        ...(consumed ? { slotConsumed: true, slotConsumedCarried: true, signedByAlternateKey: stored.signedByAlternateKey } : {}),
      }, false);
    };
    const coords = coordinates.get(operation.id);
    // A recorded settlement is kept: return the stored evidence; never re-observe it away.
    if (operation.status === 'settled_verified' && coords?.verifiedAt) {
      await finishNativeSupersessions(operation);
      return withNativeNonceResolution({ operation, verification: { outcome: 'verified', ...OBSERVATION_LIMITS, ...coords.observation, verifiedAt: coords.verifiedAt } });
    }
    if (operation.status === 'superseded' && coords?.observation?.supersededBy) {
      const native = usesNativeAgreementPayment(operation);
      const resolved = native ? await resolveNativeSupersession(operation) : true;
      return { operation, verification: { outcome: 'superseded', ...coords.observation, ...(native ? { nativeLaneResolved: resolved, ...(!resolved ? nativeResolutionHelp('Retry verify_deal on this purchase to finish releasing its retained native source lane.') : {}) } : {}) } };
    }
    if (!coords?.reportedTxHash) return { operation, verification: { outcome: operation.status === 'payment_uncertain' ? 'hash_required' : 'no_transaction_reported' } };
    const hash = coords.reportedTxHash;
    const t = operation.terms;
    const scope = { ...OBSERVATION_LIMITS, rpcOrigin: chain.rpcOrigin, domain: t.domain ?? null, purchaseCommitment: { value: purchaseCommitment(operation), carriedOnChain: false } };
    // Read back only from the network this purchase is bound to. Nothing was
    // observed when this check fails, so the stored observation (including
    // whether the nonce slot was already shown consumed) is left as it was.
    try {
      await assertBoundDomain(operation);
    } catch (error) {
      const refused = { txHash: hash, observedAt: new Date(now()).toISOString(), chainMode: chain.evidenceMode, ...scope };
      if (!(error instanceof OperationError)) return { operation, verification: { outcome: 'chain_unavailable', reason: String(error?.message ?? error).slice(0, 240), ...refused } };
      ops.record(operation.id, 'readback_refused', { txHash: hash, reason: error.code });
      return { operation, verification: { outcome: 'network_identity_mismatch', reason: error.code, mismatches: [error.message], ...refused } };
    }
    let observation;
    try {
      observation = await (usesNativeAgreementPayment(operation) && chain.observePurchaseTransfer ? chain.observePurchaseTransfer(hash) : chain.observeTransfer(hash));
    } catch (error) {
      observation = { status: 'unavailable', reason: String(error?.message ?? error).slice(0, 240) };
    }
    observation = checkedTransferObservation(observation, hash);
    let body = null, bodyError = null;
    if (!['malformed', 'unavailable', 'pending', 'not-found'].includes(observation.status)) {
      try { body = await chain.getTransaction(hash); } catch (error) { bodyError = error; }
    }
    const decided = transaction(db, () => {
      // BEGIN IMMEDIATE serializes the pointer check with nonce consumption,
      // observation/status changes and every other purchase's lane update.
      const current = ops.get(operation.accountId, operation.id);
      const retained = coordinates.get(operation.id);
      if (!current || retained?.reportedTxHash !== hash) return {
        operation: current ?? operation,
        verification: { outcome: 'stale_readback', txHash: hash, retainedTxHash: retained?.reportedTxHash ?? null },
      };
      // An in-flight read of the same pointer can also predate a completed
      // decision. Keep its evidence and terminal state; cancellation alone
      // still allows the existing confirmed late-landing reconciliation.
      if (retained.verifiedAt || (TERMINAL.has(current.status) && current.status !== 'cancelled')) return {
        operation: current,
        verification: { ...OBSERVATION_LIMITS, ...retained.observation,
          outcome: retained.verifiedAt ? 'verified' : current.status === 'payment_mismatch' ? 'mismatch' : current.status,
          ...(retained.verifiedAt ? { verifiedAt: retained.verifiedAt } : {}) },
      };
      operation = current;
      const result = { txHash: hash, observedAt: new Date(now()).toISOString(), chainMode: chain.evidenceMode, observer: typeof chain.observer === 'string' && chain.observer.trim() ? chain.observer : 'host-supplied chain reader (observer not declared)', ...scope, observation, slotConsumed: false };
      if (observation.status === 'malformed') {
        recordUnverified(result);
        return { operation, verification: { outcome: 'invalid_observation', ...result } };
      }
      if (observation.status === 'unavailable') {
        recordUnverified(result);
        return { operation, verification: { outcome: 'chain_unavailable', ...result } };
      }
      if (observation.status === 'pending' || observation.status === 'not-found') {
        recordUnverified(result);
        return { operation, verification: { outcome: 'awaiting_inclusion', ...result } };
      }
      if (bodyError) {
        recordUnverified(result);
        return { operation, verification: { outcome: 'chain_unavailable', reason: `transaction body unavailable: ${bodyError.message}`, ...result } };
      }
      let bodyHash = null;
      try {
        if (typeof body?.hash === 'string') bodyHash = canonicalHash(body.hash);
      } catch {
        bodyHash = null;
      }
      if (bodyHash !== hash) {
        result.rejectedReason = 'canonical transaction hash is missing, invalid or differs from the requested hash';
        recordUnverified(result);
        return { operation, verification: { outcome: 'transaction_unconfirmed', ...result } };
      }
      const content = body?.content ?? {};
      // The node projects the integer nonce as decimal text on every path
      // (nodeProjectedNonce). A nonce or payer this check cannot read is node
      // data, not a contradiction: the hash, status and nonce slot stay as they
      // were. Only a readable, different payer or nonce rejects the pointer.
      result.txNonce = nodeProjectedNonce(content.nonce);
      const txPayer = content.from_ed25519_address ?? content.from;
      const walletSigned = same(content.from, t.buyer.wallet);
      if (result.txNonce === null || !readableAddress(txPayer)) {
        result.rejectedReason = result.txNonce === null ? 'canonical transaction nonce is missing or unreadable' : 'canonical transaction payer is missing or unreadable';
        recordUnverified(result);
        return { operation, verification: { outcome: 'transaction_unconfirmed', ...result } };
      }
      if (!same(txPayer, t.buyer.wallet) || result.txNonce !== coords.expectedNonce) {
        result.rejectedReason = !same(txPayer, t.buyer.wallet) ? 'payer is not the approved buyer wallet' : 'transaction nonce is not the pre-saved expected nonce';
        recordUnverified(result);
        coordinates.clearRejectedPointer(operation.id, hash);
        ops.record(operation.id, 'pointer_rejected', { txHash: hash, reason: result.rejectedReason });
        const next = operation.status === 'broadcast_reported' ? move(operation, 'payment_uncertain', { reason: result.rejectedReason }) : operation;
        return { operation: next, verification: { outcome: 'pointer_rejected', mismatches: [result.rejectedReason], ...result } };
      }
      // Inclusion can contain failed execution on the pinned node. The fresh
      // canonical body must confirm execution before it proves a consumed slot.
      result.txStatus = body?.status ?? null;
      if (body?.status !== 'confirmed') {
        result.rejectedReason = body?.status === 'failed' ? 'canonical transaction execution failed' : 'canonical transaction status is not confirmed';
        recordUnverified(result);
        if (body?.status === 'failed') {
          if (usesNativeAgreementPayment(operation)) result.nextStep = 'Call cancel_wallet_handoff to resolve this failed payment if the bound-network buyer nonce still equals the saved fence; otherwise keep reading back the same hash.';
          const next = TERMINAL.has(operation.status) ? operation : move(operation, 'payment_uncertain', { reason: result.rejectedReason });
          return { operation: next, verification: { outcome: 'execution_failed', ...result } };
        }
        return { operation, verification: { outcome: body?.status === 'pending' ? 'awaiting_inclusion' : 'transaction_unconfirmed', ...result } };
      }
      // A retained source intent must itself read back included in this same
      // verification; a confirmed body read never outranks its failed verdict.
      if (observation.status === 'included' && Object.hasOwn(observation, 'sourceDisposition') && observation.sourceDisposition !== 'included') {
        result.rejectedReason = 'source readback of the retained transfer disagrees with the confirmed canonical body';
        recordUnverified(result);
        return { operation, verification: { outcome: 'transaction_unconfirmed', ...result } };
      }
      if (observation.status === 'included' && Object.hasOwn(body, 'blockNumber') && body.blockNumber !== observation.blockNumber) {
        result.rejectedReason = 'canonical transaction block number differs from the transfer observation';
        recordUnverified(result);
        return { operation, verification: { outcome: 'invalid_observation', ...result } };
      }
      result.slotConsumed = true;
      // An alternate signing key may leave the wallet's own nonce free.
      if (!walletSigned) result.signedByAlternateKey = true;
      // The wallet's own nonce is used whichever branch follows (settlement,
      // mismatch, an earlier owner or a cancelled purchase): record it durably,
      // apart from this pointer and observation, for the handoff race guard.
      else coordinates.recordWalletNonceConsumption({ from: coords.from, network: coords.network, nonce: coords.expectedNonce, txHash: hash, operationId: operation.id });
      // The slot holds a transaction that already settled a different operation
      // (e.g. a cancelled purchase's payload landed late): this purchase's
      // approved transfer can provably never land.
      const owner = coordinates.verifiedOwnerOf(hash);
      if (owner && owner !== operation.id && observation.status === 'included') {
        recordUnverified({ ...result, supersededBy: owner });
        coordinates.clearRejectedPointer(operation.id, hash);
        const next = moveUnverified('superseded', { supersededBy: owner, txHash: hash });

        return { operation: next, verification: { outcome: 'superseded', supersededBy: owner, ...result } };
      }
      if (observation.status === 'included') {
        const mismatches = [];
        if (!same(observation.payer, t.buyer.wallet)) mismatches.push('payer is not the approved buyer wallet');
        if (!same(observation.payee, t.seller.payee)) mismatches.push('payee is not the listing seller');
        if (observation.amountOs !== t.price.amountOs) mismatches.push('amount differs from the approved price');
        result.mismatches = mismatches;
        if (mismatches.length === 0) {
          try {
            // Serialize evidence and status with cancellation. A cancelled
            // current state still accepts this confirmed transfer's late landing.
            const verified = transaction(db, () => {
              const current = ops.get(operation.accountId, operation.id);
              const saved = coordinates.get(operation.id);
              if (current.status === 'settled_verified' && saved?.verifiedAt) {
                return { operation: current, verification: { outcome: 'verified', ...saved.observation, verifiedAt: saved.verifiedAt } };
              }
              recordObservation(operation.id, result, true);
              const next = ops.transition(operation.id, current.status, 'settled_verified', { data: { txHash: observation.txHash, blockNumber: observation.blockNumber, chainMode: result.chainMode } });
              // Late landing also consumes any replacement's identical slot.
              // Close those reservations atomically so they cannot fence the lane.
              // An alternate signing key may leave the wallet's own nonce free, so
              // then they stay open (signedByAlternateKey) for the lane proof in
              // resolveNativeNonceConsumption.
              for (const pending of walletSigned ? coordinates.unresolvedForSender(saved.from, operation.id, SUPERSESSION_STATES) : []) {
                const other = ops.get(current.accountId, pending.operationId);
                const reservation = coordinates.get(pending.operationId);
                if (!other || reservation.network !== saved.network || reservation.expectedNonce !== saved.expectedNonce) continue;
                if (other.kind === 'purchase' && (!BLOCKS_PURCHASE.includes(other.status) || !sameDomain(other.terms.domain, current.terms.domain))) continue;
                if (other.kind === 'listing_publication' && (!other.state.publicationDomain || other.state.publicationDomain.mode !== current.terms.domain.mode || other.state.publicationDomain.chainIdentity !== current.terms.domain.chainIdentity)) continue;
                if (!['purchase', 'listing_publication'].includes(other.kind)) continue;
                recordObservation(other.id, { ...result, supersededBy: current.id }, false, reservation.reportedTxHash);
                ops.transition(other.id, other.status, other.kind === 'purchase' ? 'superseded' : 'publication_mismatch', { data: { supersededBy: current.id, txHash: hash } });
              }
              const settled = coordinates.get(operation.id);
              return { operation: next, verification: { outcome: 'verified', ...settled.observation, verifiedAt: settled.verifiedAt } };
            });
            // SQLite commits the retry proof before touching the independent source journal.
            return verified;
          } catch (error) {
            if (isUniqueViolation(error)) throw new OperationError('hash_conflict', 'this transaction already settled another operation');
            throw error;
          }
        }
        // The approved nonce slot was consumed by a different transfer, so the
        // approved payment can no longer land: final, flagged, never accepted.
        recordUnverified(result);
        const next = moveUnverified('payment_mismatch', { mismatches });
        const mismatch = { operation: next, verification: { outcome: 'mismatch', ...result } };
        return mismatch;
      }
      if (observation.status === 'failed') {
        // Never final on its own: a differently-signed copy at the same nonce
        // could still have paid. The purchase stays uncertain (blocking retry)
        // until a pointer to an included transfer at this slot is verified.
        recordUnverified({ ...result, slotConsumed: false });
        coordinates.clearRejectedPointer(operation.id, hash);
        return { operation: moveUnverified('payment_uncertain', { reason: `chain reports this transaction ${observation.reason}` }), verification: { outcome: 'failed_unconfirmed', ...result } };
      }
      recordUnverified(result);
      return { operation: moveUnverified('payment_uncertain', { reason: observation.reason }), verification: { outcome: 'invalid_observation', ...result } };
      });
    // External journal reconciliation happens only after the current pointer's
    // decision commits. A stale read never enters these native followups.
    if (decided.verification.outcome === 'verified') {
      await finishNativeSupersessions(decided.operation);
      return withNativeNonceResolution(decided);
    }
    if (decided.verification.outcome === 'superseded' && usesNativeAgreementPayment(decided.operation)) {
      const resolved = await resolveNativeSupersession(decided.operation);
      return { ...decided, verification: { ...decided.verification, nativeLaneResolved: resolved,
        ...(!resolved ? nativeResolutionHelp('Retry verify_deal on this purchase to finish releasing its retained native source lane.') : {}) } };
    }
    return decided.operation.status === 'payment_mismatch' ? withNativeNonceResolution(decided) : decided;
  }

  // verify_deal: owner-scoped independent re-check; an optional hash is a pointer.
  // attachOnly: see attachHashAndVerify. Replacing a recorded pointer stays
  // the explicit verify_deal correction.
  async function verifyDeal({ accountId, operationId, token, txHash, attachOnly = false, signal }) {
    const found = ownedPurchase(accountId, operationId, token);
    try{protocol?.assertBuyerAccess?.(found.terms.buyer.wallet, found);}
    catch(error){
      if(error?.code!=='buyer_access_closed'||error?.details?.buyerAccessMissing)throw error;
      const coords=coordinates.get(found.id);
      if(!coords?.reportedTxHash||(txHash&&canonicalHash(txHash)!==coords.reportedTxHash))throw error;
      if(diagnosticOnly)return diagnosticReadback(found,txHash,signal);
      const native=await protocol?.readIssuedPayment?.(found,coords.reportedTxHash);
      if(native)return {operation:found,verification:{outcome:'readback_only',...native,...OBSERVATION_LIMITS}};
      if(usesNativeAgreementPayment(found))throw error;
      let observation;
      try{await assertBoundDomain(found);observation=await protocol?.observeReportedPayment?.(coords.reportedTxHash)??await chain.observeTransfer(coords.reportedTxHash);}
      catch(readError){observation={status:'unavailable',reason:String(readError?.message??readError).slice(0,240)};}
      observation=checkedTransferObservation(observation,coords.reportedTxHash);
      return {operation:found,verification:{outcome:'readback_only',observation,...OBSERVATION_LIMITS}};
    }
    if (diagnosticOnly) return diagnosticReadback(found, txHash, signal);
    const operation = expireIfNeeded(found);
    if (txHash) {
      assertAgreementPaymentHeld(operation);
      const attached = await attachHashAndVerify(operation, txHash, 'verify_deal', { attachOnly });
      if (attached) return continueProtocol(attached);
    }
    if (operation.status === 'agreement_pending') return continueProtocol({ operation, verification: { outcome: 'agreement_pending' } });
    if (operation.status === 'payment_handoff') {
      const coords = coordinates.get(operation.id);
      // A nonce read from another network proves nothing about this handoff.
      try {
        await assertBoundDomain(operation);
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return { operation, verification: { outcome: 'network_identity_mismatch', reason: error.code, mismatches: [error.message] } };
      }
      const nonce = await chain.getAddressNonce(operation.terms.buyer.wallet);
      if (nonce !== coords.nonceFence) {
        // A handoff whose transfer the operator's source refuses sent nothing
        // through it: it stays payment_handoff, and cancelling it decides from
        // what used its nonce (refusedHandoff).
        if (usesNativeAgreementPayment(operation) && await protocol?.nativePaymentRefused?.(operation, coords)) {
          return { operation, verification: { outcome: 'not_broadcast', detail: 'the operator\'s source refused this handoff\'s transfer (it has a cancelled payment\'s terms), so it was not sent; the buyer nonce was used by another write. Cancel it (cancel_wallet_handoff).' } };
        }
        return { operation: move(operation, 'payment_uncertain', { reason: 'buyer nonce advanced; transaction hash unknown', nonce }), verification: { outcome: 'hash_required' } };
      }
      return { operation, verification: { outcome: 'not_broadcast', detail: 'buyer nonce unchanged since handoff' } };
    }
    return continueProtocol(await verifySettlement(operation));
  }

  // ---- DACS protocol steps in the portal (handoff token + bound wallet) ----
  function protocolOperation(operationId, token) {
    const operation = portalOperation(operationId, token);
    if (!operation.terms.protocol) throw new OperationError('invalid_state', 'this purchase is not a DACS protocol purchase');
    if (!protocol?.available) throw new OperationError('dacs_protocol_unavailable', 'DACS protocol purchases are not configured on this server');
    return operation;
  }

  async function agreementIdentity({ operationId, token, address }) {
    assertPurchaseActionsAdmitted();
    const operation = await admitProtocolStart(operationId, token);
    if (operation.status === 'agreement_pending' && operation.state.protocol.planned) await assertBoundDomain(operation);
    return protocol.identityRequest(operation, address);
  }

  async function admitProtocolStart(operationId, token) {
    const operation = protocolOperation(operationId, token);
    protocol.assertBuyerAccess?.(operation.terms.buyer.wallet);
    if (operation.status === 'agreement_pending' && !operation.state.protocol.planned) {
      assertPurchaseLimits(operation.accountId, operation.terms.buyer.wallet, operation.id);
      await assertBoundDomain(operation);
      await assertBuyerFunds(operation.terms.buyer.wallet, operation.terms.price, OFFLINE_AGREEMENT_MODE);
      const current = protocolOperation(operationId, token);
      if (current.status !== operation.status) throw new OperationError('invalid_state', `purchase is ${current.status}`);
      assertPurchaseLimits(current.accountId, current.terms.buyer.wallet, current.id);
      return current;
    }
    return operation;
  }

  // A plan step already running for this purchase answers before the domain,
  // balance and fee reads: its own signatures wait for it, others are told at once.
  async function agreementPlan({ operationId, token, signature, delegationSignature, intentGeneratedAt }) {
    assertPurchaseActionsAdmitted();
    const running = protocol.runningPlan?.(protocolOperation(operationId, token), signature, delegationSignature, intentGeneratedAt);
    if (running) return running;
    return protocol.planRequest(await admitProtocolStart(operationId, token), signature, delegationSignature, intentGeneratedAt);
  }
  // True while this process runs the purchase's plan step (none is saved yet).
  const planRunning = (operation) => operation.status === 'agreement_pending' && !operation.state?.protocol?.planned && protocol?.planRunning?.(operation) === true;

  async function agreementSubmit({ operationId, token, agreementSignature, anchorSignature }) {
    assertPurchaseActionsAdmitted();
    const operation = protocolOperation(operationId, token);
    if (operation.status === 'agreement_pending') await assertBoundDomain(operation);
    return { operation: await protocol.submitAgreement(operation, { agreementSignature, anchorSignature }) };
  }

  function completionRequest({ operationId, token }) {
    assertPurchaseActionsAdmitted();
    const operation = protocolOperation(operationId, token);
    if (operation.status !== 'settled_verified') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    return { operation, request: protocol.countersignRequest(operation) };
  }

  async function completionCountersign({ operationId, token, bundleSignature, anchorSignature }) {
    assertPurchaseActionsAdmitted();
    const operation = protocolOperation(operationId, token);
    if (operation.status !== 'settled_verified') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    return { operation: await protocol.countersign(operation, { bundleSignature, anchorSignature }) };
  }

  async function protocolRecheck({ operationId, token }) {
    if (diagnosticOnly) assertPurchaseActionsAdmitted();
    const found = handoffPurchase(operationId, token);
    try{protocol?.assertBuyerAccess?.(found.terms.buyer.wallet,found);}
    catch(error){
      if(error.code==='buyer_access_closed'&&!error.details?.buyerAccessMissing&&found.terms.protocol&&await protocol?.readIssued?.(found))return {operation:found,verification:{outcome:'readback_only'}};
      throw error;
    }
    const operation = protocolOperation(operationId, token);
    return continueProtocol({ operation, verification: null });
  }

  // A native handoff whose transfer the operator's source refuses for a
  // cancelled payment's terms sent nothing through the source
  // (nativePaymentRefused), so a cancel that cannot end it yet leaves it
  // payment_handoff, never readback-only for that alone. With its nonce
  // unchanged the source's proof refused it for another retained write not
  // yet read back. Once its nonce is used, the source's readback of the write
  // that used it decides: one with this payment's settlement terms is
  // verified like a reported hash (it may settle it); any other ends it
  // cancelled, as this transfer can never be sent; one not read back yet
  // leaves it payment_handoff. A nonce used outside the source leaves it
  // readback-only. null when the source does not refuse this transfer.
  async function refusedHandoff(operation, coords, nonce) {
    const used = nonce !== coords.nonceFence;
    const refused = await protocol.nativePaymentRefused(operation, coords, { consumer: used });
    if (!refused) return null;
    const by = used ? refused.consumer : 'pending';
    if (by?.hash && by.sameTerms) {
      ops.record(operation.id, 'handoff_nonce_consumed', { txHash: by.hash, sameTerms: true });
      return continueProtocol({ ...await attachHashAndVerify(operation, by.hash, 'source-readback'), cancelled: false });
    }
    if (by?.hash) {
      const ended = move(operation, 'cancelled', { reason: 'native payment refused by the operator source (a cancelled payment\'s terms), and its nonce was used by another write the source read back; nothing was sent', consumedBy: by.hash, nonce, nonceFence: coords.nonceFence });
      return { operation: ended, cancelled: ended.status === 'cancelled' };
    }
    if (by === 'pending') {
      ops.record(operation.id, 'cancel_deferred', { reason: 'another retained write by this wallet is not read back yet', nonce });
      return { operation, cancelled: false, message: `Not cancelled yet: the operator's source refused this payment's transfer, so it was not sent, but another write by this wallet is not read back yet. ${operation.id} stays open; call cancel_wallet_handoff again shortly.` };
    }
    return { operation: move(operation, 'payment_uncertain', { reason: 'cancel refused: the buyer nonce was used outside the operator source; readback only', nonce }), cancelled: false };
  }

  // Cancel only while the buyer nonce proves nothing from this handoff was
  // consumed. The model may call this: cancelling never moves funds, and a
  // late landing of the old payload is still recorded by verify_deal.
  async function cancel({ accountId, operationId }) {
    if (diagnosticOnly) assertPurchaseActionsAdmitted();
    const found = ownedPurchase(accountId, operationId);
    protocol?.assertBuyerAccess?.(found.terms.buyer.wallet, found);
    const operation = expireIfNeeded(found);
    if (!CANCELLABLE.has(operation.status)) throw new OperationError('invalid_state', `purchase is ${operation.status} and cannot be cancelled`);
    const coords = coordinates.get(operation.id);
    if (coords) {
      if (usesNativeAgreementPayment(operation)) {
        // Stored failed hashes cannot re-enter the pinned node's mempool.
        // Re-read the bound hash and nonce before releasing either wallet lane.
        if (operation.status === 'payment_uncertain' && coords.reportedTxHash) {
          const checked = await verifySettlement(operation);
          if (checked.verification.outcome === 'verified') return continueProtocol({ ...checked, cancelled: false });
          if (checked.verification.outcome === 'execution_failed' && checked.operation.status === 'payment_uncertain') {
            await assertBoundDomain(checked.operation);
            const nonce = await chain.getAddressNonce(operation.terms.buyer.wallet);
            if (nonce !== coords.nonceFence) {
              const refused = { reason: 'cancel refused: buyer nonce advanced since handoff', nonce };
              ops.record(operation.id, 'cancel_refused', refused);
              return { operation: move(checked.operation, 'payment_uncertain', refused), cancelled: false };
            }
            if (await protocol?.nativePaymentFailed?.(checked.operation, coordinates.get(operation.id))) {
              const next = move(checked.operation, 'cancelled', { reason: 'native payment execution failed; bound chain nonce still equals the saved fence', txHash: coords.reportedTxHash, nonceFence: coords.nonceFence });
              return { operation: next, cancelled: next.status === 'cancelled' };
            }
          }
        }
        // A wallet decline signs nothing. Cancel only a handoff whose bound
        // chain nonce and retained source journal both prove nothing was sent;
        // otherwise the native payment stays readback-only. The operator's
        // source decides under the payer's lane lock and keeps the cancelled
        // transfer durably, so it is never sent; once the source, in any
        // process, has claimed it (a signature lease naming it, or later) the
        // purchase is not cancelled: the wallet may be signing or sending it.
        // The claim is asked first, with no network read (a live lease holds
        // the source's connection), and again under the lock.
        if (operation.status === 'payment_handoff' && typeof protocol?.cancelNativePayment === 'function') {
          let claimed = await protocol.nativePaymentClaimed(operation, coords);
          if (!claimed) {
            await assertBoundDomain(operation);
            const nonce = await chain.getAddressNonce(operation.terms.buyer.wallet);
            const held = nonce === coords.nonceFence ? await protocol.cancelNativePayment(operation, coords) : { cancelled: false, claimed: null };
            if (held.cancelled) {
              const ended = move(operation, 'cancelled', { reason: 'native payment cancelled before issue; chain nonce and source journal show nothing sent, and the source refuses this transfer', nonceFence: coords.nonceFence });
              return { operation: ended, cancelled: ended.status === 'cancelled' };
            }
            claimed = held.claimed;
            if (!claimed) {
              const refused = await refusedHandoff(operation, coords, nonce);
              if (refused) return refused;
            }
          }
          if (claimed) {
            return { operation: move(operation, 'payment_uncertain', { reason: 'cancel refused: the operator source already claimed this native transfer; readback only', claimed }), cancelled: false,
              message: `Not cancelled: the wallet had already started sending this payment, so it may be on its way. ${operation.id} is read back only (get_purchase_status, verify_deal); nothing is ever resent.` };
          }
        }
        return { operation: move(operation, 'payment_uncertain', { reason: 'issued native delivery cannot be cancelled/reissued; readback only' }), cancelled: false };
      }
      // Only the bound network's nonce can show that nothing was sent.
      await assertBoundDomain(operation);
      const nonce = await chain.getAddressNonce(operation.terms.buyer.wallet);
      if (nonce !== coords.nonceFence) {
        return { operation: move(operation, 'payment_uncertain', { reason: 'cancel refused: buyer nonce advanced since handoff', nonce }), cancelled: false };
      }
    }
    const next = move(operation, 'cancelled', { reason: 'cancelled by account owner', nonceFence: coords?.nonceFence ?? null });
    return { operation: next, cancelled: next.status === 'cancelled' };
  }

  return {
    prepare, status, issueApprovalChallenge, approve, prepareHandoff, nativePaymentLane, reportWalletResult, verifyDeal, cancel, portalOperation, portalEvidence,
    agreementIdentity, agreementPlan, planRunning, agreementSubmit, completionRequest, completionCountersign, protocolRecheck,
  };
}
