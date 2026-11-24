// One native purchase from the seller's commit answer to the wallet guard, through the real protocol factory and the real
// purchase service on one SQLite file. The seller answers through the real seller HTTPS client and wire verifier: its
// callback adds `sellerReceipt` to the commit answer before the wire signs the status and body. The chain readback, the
// Agreement exchange and the native payment lane are stand-ins at the stored-flow seams; nothing reaches a network.
import { canonicalize, demosSignedTransactionProofHash, finalityCommitmentAddress, fixedPriceAgreementLogicalAddress, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { world as wireWorld, purchase, JOB, PUBLIC_ENDPOINT, T0, validReceipt } from './wire-client-fixture.mjs';
import { committedPurchase } from './wire-committed-purchase.mjs';
const { createProtocolPurchases } = await import('../../src/dacs/protocol-purchases.mjs?stored-flow');
const { createPurchaseService } = await import('../../src/purchases.mjs');
const { createCoordinateStore } = await import('../../src/dacs/wallet-transactions.mjs');
const { createSqlitePurchaseStore } = await import('../../src/seams/purchase-store-not-wired.mjs');
const { agreementTerms } = await import('../../src/dacs/purchase-protocol.mjs');
const { POINTER_MISSING, PUBLIC_SIGNED_CREATES } = await import('../../src/dacs/buyer-chain-readback.mjs');

/** Distinct positive fixture values: the Agreement price and the buyer's two receipt fee ceilings, in OS. */
export const PRICE_OS = 1000000000n, PAY_FEE_OS = 2000n, ANCHOR_FEE_OS = 3000n;
export const EXACT_SUM_OS = PRICE_OS + PAY_FEE_OS + ANCHOR_FEE_OS;
const MANDATE_CAP_OS = 100000000000n;
const STATE = Symbol.for('TEST-stored-request-flows');
const COMMIT_PATH = wire.DACS_SELLER_HTTP_PATHS.commitments;
const COMMITMENT_ADDRESS = finalityCommitmentAddress(JOB);
const IDENTITY = 'c'.repeat(64);
const APPROVAL_PURPOSE = 'TEST-approve';
const HANDOFF_NONCE_FENCE = 6;
const WALL_CLOCK_EXPIRY = '2100-01-01T00:00:00.000Z';
// The signed commitment CREATE the seller offers as its pointer; only the chain readback stand-in reads it.
const SELLER_SIGNED_CREATE = Object.freeze({ version: 'TEST-seller-signed-create' });
const GUARD = Object.freeze({ hash: 'd'.repeat(64), nonce: HANDOFF_NONCE_FENCE + 1 });
const DEM_DECIMALS = 9;
const demText = (os) => {
  const text = os.toString(10).padStart(DEM_DECIMALS + 1, '0');
  return `${text.slice(0, -DEM_DECIMALS)}.${text.slice(-DEM_DECIMALS)}`.replace(/\.?0+$/, '');
};
/** The canonical decimal OS text of a bigint. */
export const osText = (value) => value.toString(10);

/**
 * Builds the world. `priceOs`, `payFeeOs` and `anchorFeeOs` are the Agreement price and the buyer's configured ceilings;
 * `capOs` is the buyer's mandate cap. `receipt(agreementHash)` is the `sellerReceipt` member the seller signs into each
 * ordinary answer (return undefined to omit it). Returns the actions and the counted payment effects.
 */
export async function receiptWorld(t, { priceOs = PRICE_OS, payFeeOs = PAY_FEE_OS, anchorFeeOs = ANCHOR_FEE_OS, capOs = MANDATE_CAP_OS,
  receipt = (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(EXACT_SUM_OS) }) } = {}) {
  const made = await committedPurchase({ jobId: JOB, publicEndpoint: PUBLIC_ENDPOINT, price: demText(priceOs) });
  const w = await wireWorld(t, { pin: made.pin, agreementHash: made.agreementHash, readCommitmentReceipt: validReceipt });
  const payload = { ...w.delegation.payload, expiresAt: made.agreement.terms.deadline };
  const sessionDelegation = { payload, signature: w.buyer.sign(await wire.sellerSessionDelegationSigningBytes(payload, w.binding, w.local)).toString('base64url') };
  const anchorAddress = fixedPriceAgreementLogicalAddress(JOB);
  const p = await purchase(t, w, { paid: true, signedListing: made.listing, configureTerms(terms) {
    terms.listing = { listingId: made.pin.listingId, version: made.pin.version, contentHash: made.pin.contentHash };
    terms.price = { amount: demText(priceOs), currency: 'DEM', amountOs: osText(priceOs) };
    terms.seller.payee = agreementTerms(made.agreement).payee;
    terms.network = 'testnet';
    terms.domain = { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: IDENTITY };
  }, protocolPatch: { stage: 'agreement-signing', planned: { plan: { agreementHash: made.agreementHash }, draft: made.agreement, anchorAddress },
    sessionDelegation, signatures: { agreement: 'TEST-retained-contribution' }, paymentEvidence: null } });
  // The approval window and the handoff link are also checked against the wall clock, so both outlive any test run.
  p.db.prepare('UPDATE operations SET expires_at = ?, handoff_expires_at = ? WHERE id = ?').run(WALL_CLOCK_EXPIRY, WALL_CLOCK_EXPIRY, p.op.id);

  // The buyer's verified Agreement CREATE as its wallet journal keeps it; the commit request carries these exact public bytes.
  const createContent = { from: w.buyer.address, to: 'stor-agreement', data: ['storageProgram', { metadata: { logicalAddress: anchorAddress, artifactKind: 'Agreement' } }] };
  const agreementCreate = { hash: sha256Hex(JSON.stringify(createContent)), content: createContent, signature: { type: 'ed25519', data: '00' } };
  const proof = { proofVersion: '1', chainIdentity: IDENTITY, writer: w.buyer.claim, operation: 'create', signedTransactionHash: demosSignedTransactionProofHash(agreementCreate),
    finalityProofHash: IDENTITY, nativeRead: { programName: logicalToStorageProgramName(anchorAddress), valueHash: IDENTITY, observedAt: 1 } };
  const anchorReceipt = { receiptVersion: '1', substrate: 'demos', finalityProfile: 'demos-bft-confirmed-native-read', logicalAddress: anchorAddress, contentHash: made.agreementHash,
    nativeAddress: 'stor-agreement', transactionRef: { kind: 'demos-storage-program', value: agreementCreate.hash }, writer: w.buyer.claim, nonce: '1', state: 'finalized',
    observationDisposition: 'established', observedAt: 1, blockRef: { id: IDENTITY, height: '1', timestamp: 1 }, evidence: { kind: 'demos-bft-write-proof-v1', value: Buffer.from(canonicalize(proof)).toString('base64url') } };
  const journal = { ...p.config.walletAgreement.journal, entries: async () => [['sr2/adapter/TEST-agreement', { stage: 'verified', authorizationProfile: 'embedded-storage-anchor-create',
    logicalAddress: anchorAddress, writer: w.buyer.claim, transactionHash: agreementCreate.hash, hash: made.agreementHash, authorizedTransaction: agreementCreate }]] };
  const dacsProtocol = { ...p.config, walletAgreement: { ...p.config.walletAgreement, journal } };

  const effects = { payloads: 0, guards: 0, signatures: 0, creates: 0, commitRequests: 0 };
  // The seller: the first commit request creates the commitment, every later one replays the stored answer. `drop`
  // loses each answer after the seller acted; `signFor` changes the request payload the answer is signed over.
  const seller = { drop: false, signFor: (signed) => signed };
  let time = 0;
  const clock = { now: () => time, async sleep(ms) { time += ms; w.state.time += ms; } };
  const ordinaryAnswer = () => {
    const member = receipt(made.agreementHash);
    return { status: 'committed', address: `dacs3:commit:${JOB}`, resumed: effects.creates > 0,
      [PUBLIC_SIGNED_CREATES]: { [COMMITMENT_ADDRESS]: SELLER_SIGNED_CREATE }, ...(member === undefined ? {} : { sellerReceipt: member }) };
  };
  const signedResponses = [];
  const state = {
    payment: { unresolved() {}, withWorkflow: (_operation, work) => work(), withPaymentLane: (_operation, work) => work(),
      verifyAgreement: async () => {}, assertReady: async () => {}, readLane: async () => { effects.guards++; return GUARD; } },
    evidence: { rpcOrigin: new URL(p.config.walletAgreement.rpcUrl).origin, readEvidence: async () => ({ disposition: 'indeterminate', reason: 'TEST-readback-pending' }) },
    // The chain authenticates only a signed CREATE it is given; without one it reports the missing pointer.
    chain: { readCommitment: async ({ signedProjection }) => (signedProjection === undefined
      ? { status: 'indeterminate', reason: 'the original signed FinalityCommitment CREATE is not available yet; nothing is inferred from its absence', pointer: POINTER_MISSING }
      : { status: 'verified', ...made.summary, anchored: made.anchored, chainSignedCreate: signedProjection }) },
    exchange: async () => ({ disposition: 'anchored', result: { agreement: made.agreement, agreementHash: made.agreementHash,
      agreementRef: { anchor: { kind: 'storage-program', locator: anchorAddress }, contentHash: made.agreementHash }, anchorReceipt } }),
    clock,
    async fetch(url, init) {
      if (new URL(url).pathname !== COMMIT_PATH) throw new TypeError(`TEST unexpected seller route ${url}`);
      effects.commitRequests++;
      const body = ordinaryAnswer();
      if (effects.creates === 0) effects.creates++;
      if (seller.drop) throw new TypeError('TEST the seller answer was lost after the seller acted');
      const { payload: signedOver } = JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url'));
      const text = JSON.stringify(body);
      signedResponses.push(body);
      const header = await wire.signWireResponse(seller.signFor(signedOver), 200, text, { signer: w.seller, binding: w.binding, local: w.local, purchaseProfile: w.binding.profile, now: w.state.time });
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: header } });
    },
  };
  const hooks = { beforeNonce: () => {} };
  const chain = { network: 'testnet', pinnedIdentity: IDENTITY, networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
    getAddressNonce: async () => { await hooks.beforeNonce(); return HANDOFF_NONCE_FENCE; }, getTransactionFees: async () => 1n };
  // The host's per-write fee ceiling, above the Agreement price plus the network fee, given to both factories.
  const feeCeilingOs = '50000000000';
  const verifier = { verify: async () => ({ transactable: true, contentHash: made.pin.contentHash, price: { amountOs: osText(priceOs) },
    payee: agreementTerms(made.agreement).payee, checks: [], evidence: { chainMode: 'TEST' } }) };
  let approvals = 0;
  const challenges = { verifyAndConsume({ purpose, consumedBy }) {
    const challengeId = `TEST-challenge-${++approvals}`, at = new Date(T0).toISOString();
    p.db.prepare('INSERT INTO challenges (id,nonce,purpose,binding,message,issued_at,expires_at,consumed_at,consumed_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(challengeId, challengeId, purpose, '{}', 'TEST-message', at, new Date(T0 + 3600000).toISOString(), at, consumedBy);
    return { challengeId, address: w.buyer.address };
  } };
  const receiptLimits = { receiptFeeCeilings: { payFeeCeilingOs: osText(payFeeOs), anchorFeeCeilingOs: osText(anchorFeeOs) }, buyerMandateCapOs: osText(capOs) };
  let protocol, service;
  const build = () => {
    globalThis[STATE] = state;
    const store = createSqlitePurchaseStore(), now = () => w.state.time;
    protocol = createProtocolPurchases({ db: p.db, ops: p.ops, coordinates: createCoordinateStore({ db: p.db, now }), dacsProtocol, admission: w.admission,
      buyerAccess: { assertWallet() {} }, store, now, chain, feeCeilingOs, ...receiptLimits });
    service = createPurchaseService({ db: p.db, ops: p.ops, coordinates: createCoordinateStore({ db: p.db, now }), store, chain, verifier, challenges, protocol,
      accounts: { listWallets: () => [{ address: w.buyer.address }] }, config: { demAmountEncoding: 'os-string' }, purposes: { APPROVE_PURCHASE: APPROVAL_PURPOSE }, now, feeCeilingOs });
  };
  build();
  // Each action runs against this world's seams, which a world built later in the same test replaces.
  const act = (work) => { globalThis[STATE] = state; return work(); };
  const token = () => p.ops.handoffTokenFor(p.op.id);
  const counted = (result) => { if (result?.payload) effects.payloads++; return result; };
  const get = () => p.get();
  return {
    w, p, made, seller, effects, hooks, signedResponses, get,
    get protocol() { return protocol; },
    get service() { return service; },
    /** Sends the buyer's signed Agreement on: the exchange anchors it and the seller is asked to commit. */
    commit: () => act(() => protocol.submitAgreement(get())),
    /** The buyer's explicit retry of the purchase's stored next step. */
    retry: () => act(() => protocol.recheck(get())),
    approve: () => act(async () => counted(await service.approve({ operationId: p.op.id, token: token(), challengeId: 'TEST-challenge', signature: 'TEST-approval' }))),
    prepareHandoff: () => act(async () => counted(await service.prepareHandoff({ operationId: p.op.id, token: token() }))),
    /** Asks for the one-time wallet guard; the wallet signs the guard it is given. */
    async pay() {
      const { record } = await act(() => service.nativePaymentLane({ operationId: p.op.id, token: token(), key: 'TEST-wallet-key' }));
      effects.signatures++;
      return record;
    },
    /** Saves `protocol` members into the durable row as a host database could hold them, keeping its status. */
    change(protocolPatch) {
      const saved = get();
      return p.ops.transition(saved.id, saved.status, saved.status, { state: { protocol: { ...saved.state.protocol, ...protocolPatch, revision: (saved.state.protocol.revision ?? 0) + 1 } }, event: 'TEST-row-changed', data: {} });
    },
    /** A process restart: the database is reopened and both factories are built again on it. */
    restart() { p.reopen(); build(); },
    coordinates: () => p.db.prepare('SELECT count(*) AS n FROM write_coordinates WHERE operation_id = ?').get(p.op.id).n,
    events: () => p.ops.history(p.op.id),
    /** The `sellerReceipt` member the seller signs for a given reserved maximum. */
    receiptFor: (reservedMaximumOs) => ({ agreementHash: made.agreementHash, reservedMaximumOs }),
  };
}
