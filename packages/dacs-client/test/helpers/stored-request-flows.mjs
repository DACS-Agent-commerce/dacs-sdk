import * as moduleApi from 'node:module';
import { sellerSessionDelegationSigningBytes } from '@kynesyslabs/dacs/wire';
import { contentHash, finalityCommitmentAddress, fixedPriceAgreementLogicalAddress } from '@kynesyslabs/dacs';
import { storedWorld, PATHS, bodyFor } from './stored-request-fixture.mjs';
import { createSqlitePurchaseStore } from '../../src/seams/purchase-store-not-wired.mjs';
import { agreementTerms } from '../../src/dacs/purchase-protocol.mjs';
import { signatureCommitmentAnchor } from '../../src/dacs/commit-on-signature.mjs';
import { resolve } from './stored-request-flow-loader.mjs';
if (moduleApi.registerHooks) moduleApi.registerHooks({ resolve });
else moduleApi.register(new URL('./stored-request-flow-loader.mjs', import.meta.url));
const { createProtocolPurchases } = await import('../../src/dacs/protocol-purchases.mjs?stored-flow');

const FLOW_PATHS = { agreement: PATHS.proposals, commit: PATHS.commitments, signature: PATHS.commitmentSignature, payment: PATHS.payments, replay: PATHS.commitments };

/**
 * Runs one of the five seller flows through the real protocol service: `sellerFor`, the request records, wire
 * verification, SQLite saves and the note reducers. The coordinator and the authenticated source readbacks are
 * supplied at their existing seams.
 */
export async function sellerFlow(t, kind) {
  const s = await storedWorld(t, { paid: true, configureTerms(terms, listing) {
    const { signature, ...unsigned } = listing;
    terms.listing = { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(unsigned) };
    terms.price = { amount: '1', currency: 'DEM', amountOs: '1000000000' };
    terms.seller.payee = terms.seller.claim.slice('did:demos:agent:'.length);
    if (kind === 'commit') delete terms.protocol.sellerAgreementProjection;
  } });
  return run(s, kind);
}

async function run(s, kind) {
  const { p, w, made } = s, jobId = w.job.jobId, address = fixedPriceAgreementLogicalAddress(jobId);
  const agreement = { artifact: made.agreement, hash: made.agreementHash,
    ref: { anchor: { kind: 'storage-program', locator: address }, contentHash: made.agreementHash },
    anchorReceipt: { logicalAddress: address }, terms: agreementTerms(made.agreement) };
  if (kind === 'replay') agreement.signedProjection = { version: 'TEST-approved-create' };
  const payload = { ...w.delegation.payload, expiresAt: made.agreement.terms.deadline };
  const delegation = { payload, signature: w.buyer.sign(await sellerSessionDelegationSigningBytes(payload, w.binding, w.local)).toString('base64url') };
  s.patch({ planned: { plan: { agreementHash: made.agreementHash }, draft: made.agreement, anchorAddress: address },
    agreement, sessionDelegation: delegation, signatures: { agreement: 'TEST-retained-contribution' }, commitment: made.summaryWithBytes,
    paymentEvidence: null });
  const state = globalThis[Symbol.for('TEST-stored-request-flows')] = {
    clock: s.clock, signature: null,
    payment: { unresolved() {}, withWorkflow: (_op, work) => work(), verifyAgreement: async () => {} },
    evidence: { rpcOrigin: new URL(p.config.walletAgreement.rpcUrl).origin, readEvidence: async () => ({ disposition: 'indeterminate', reason: 'TEST-readback-pending' }) },
    chain: { readCommitment: async () => ({ status: 'indeterminate', reason: 'TEST-readback-pending' }) },
    async fetch(_url, init) { s.fetches.push(init); return s.reply(init); },
    exchange: async ({ seller }) => { await seller.propose(bodyFor(PATHS.proposals)); return { disposition: 'indeterminate', stage: 'proposal', reason: 'TEST-retained' }; },
  };
  const config = { ...p.config, walletAgreement: { ...p.config.walletAgreement } };
  if (kind === 'commit') {
    state.exchange = async () => ({ disposition: 'anchored', result: { agreement: made.agreement, agreementHash: made.agreementHash,
      agreementRef: agreement.ref, anchorReceipt: agreement.anchorReceipt } });
  }
  if (kind === 'signature') {
    config.commitOnSignature = true;
    config.walletAgreement.onCreateAuthorized = (_id, notify) => notify({ version: 1 });
    config.walletAgreement.bridgeFor = () => ({ anchor: async () => ({ status: 'indeterminate' }) });
    state.exchange = async ({ seller, anchorAdapter }) => {
      await signatureCommitmentAnchor(anchorAdapter, seller, true).anchorAgreement({ artifact: made.agreement, agreementHash: made.agreementHash, logicalAddress: address });
      await state.signature;
      return { disposition: 'indeterminate', stage: 'agreement-anchor', reason: 'TEST-retained' };
    };
  }
  const service = createProtocolPurchases({ db: p.db, ops: p.ops, dacsProtocol: config, admission: w.admission,
    coordinates: { unresolvedForSender: () => [] }, buyerAccess: { assertWallet() {} }, store: createSqlitePurchaseStore(), now: () => w.state.time });
  let result;
  if (kind === 'payment') {
    s.patch({ stage: 'payment-observed' }, 'settled_verified');
    result = await service.recheck(p.get(), { verifiedAt: 'TEST-verified', reportedTxHash: 'a'.repeat(64), observation: { observation: { blockNumber: 1 } } });
  } else if (kind === 'replay') {
    s.patch({ stage: 'seller-committed' }, 'awaiting_approval');
    state.chain.readCommitment = async () => ({ status: 'verified', ...made.summary, chainSignedCreate: { version: 'TEST-verified-create' } });
    await service.recheckCommitment(p.get());
    result = p.get();
  } else result = await service.submitAgreement(p.get());
  return { s, result, path: FLOW_PATHS[kind], service, commitmentAddress: finalityCommitmentAddress(jobId) };
}
