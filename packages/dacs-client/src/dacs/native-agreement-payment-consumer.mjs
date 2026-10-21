import { sameIncludedFact } from '../util/purchase-readback-cache.mjs';
import { createImmutableReadbacks } from '../util/immutable-readbacks.mjs';
// Bounded consumer capability, not a new protocol/wallet profile. The normal
// wallet still approves/signs/confirms the native transfer. Coordinates retain
// a one-time handoff; the existing public SR-2 journal serializes CREATE plans.
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { isDevnetAgreementTransport } from '../wallet/devnet-native-transport.mjs';
import { createDemosSr2Adapter } from './demos-sr2-adapter.mjs';
import { createSellerSr2AgreementAnchor, SELLER_SR2_PUBLIC_PROJECTION } from './seller-sr2-agreement-consumer.mjs';
import { claimForAddress } from '../signatures.mjs';
import { OperationError } from '../client-errors.mjs';

export const NATIVE_AGREEMENT_PAYMENT = 'native-dem-once-after-public-agreement-and-fixture-commitment';
export const usesNativeAgreementPayment = (op) => op?.terms?.protocol?.profile === 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1'
  && op.terms.protocol.nativePayment === NATIVE_AGREEMENT_PAYMENT
  && op.terms.protocol.sellerAgreementProjection === SELLER_SR2_PUBLIC_PROJECTION;
export function nativeAgreementPaymentConfig(value, { walletConfig, sellerSr2Commitment, coordinates, fetchImpl, now, readbackCache = null }) {
  if (value === undefined || value === null) return null;
  const sourceCapability = isDevnetAgreementTransport(value) ? value : null;
  if (!sourceCapability) throw new TypeError('native Agreement transport capability required');
  const rpc = new URL(walletConfig?.rpcUrl ?? 'https://held.invalid');
  if ((walletConfig.sourceCapability !== sourceCapability || rpc.href !== sourceCapability.pins.endpoint) || !sellerSr2Commitment?.publicProjection
    || !walletConfig?.journal || !coordinates) throw new TypeError('native Agreement payment requires the existing loopback wallet, public projection, fixture commitment and durable coordinates');
  const journal = walletConfig.journal;
  const immutable=createImmutableReadbacks({ now });
  const reader = createSellerSr2AgreementAnchor({ reader:createDemosSr2Adapter({rpcUrl:rpc.href,sourceCapability,journal:{get:()=>null,put:()=>{throw new Error('read-only source observer');},records:()=>[],withWalletLock:(_k,work)=>work()},fetchImpl,now}) });
  const workflowKey = (op) => `plugin/native-payment/${JSON.stringify([op.terms.network, op.terms.buyer.wallet])}`;
  const laneKey = (op) => `sr2/wallet/${JSON.stringify([op.terms.network, sourceCapability.pins.chainIdentity, op.terms.buyer.wallet])}`;
  function unresolved(op) {
    if(sourceCapability && (op.terms.domain.mode !== 'public-chain-read' || op.terms.domain.chainIdentity !== sourceCapability.pins.chainIdentity || op.terms.network !== sourceCapability.pins.network || canonicalize(op.terms.protocol.transportBinding) !== canonicalize(sourceCapability.transportBinding))) throw new OperationError('network_identity_mismatch','these terms do not carry the exact source capability binding');
    const pending = coordinates.unresolvedForSender(op.terms.buyer.wallet, op.id, ['payment_handoff', 'broadcast_reported', 'payment_uncertain', 'publication_handoff']);
    if (pending.length) throw new OperationError('unresolved_payment', 'the shared wallet nonce lane has an unresolved handoff; no CREATE or payment may be issued');
  }
  async function assertReady(op) {
    unresolved(op);
    const records = await journal.entries();
    const writer = claimForAddress(op.terms.buyer.wallet);
    if (records.some(([key, r]) => key.startsWith('sr2/adapter/') && r.writer === writer && !['verified', 'denied-unsigned'].includes(r.stage))) {
      throw new OperationError('wallet_fenced', 'an existing CREATE intent occupies the shared wallet lane; read it back first');
    }
    const lane = await journal.get(laneKey(op));
    if (lane && lane.stage !== 'broadcast-accepted') throw new OperationError('wallet_fenced', 'the shared CREATE journal has an unresolved wallet outcome');
  }
  // The payment handoff gate and the wallet guard read always re-read the
  // chain's current Agreement state. Only callers off the payment path
  // (pre-approval gate, post-payment evidence) pass reuseVerified to accept
  // this purchase's own verified proof within the short TTL. A fresh read that
  // no longer verifies evicts that proof. With the purchase cache on, a hit at
  // a payment gate still re-runs the storage search, native GET and exact
  // data/metadata/owner/provenance comparison; it skips only the transaction
  // and block authentication pinned by the cached block hash.
  async function verifyAgreement(op, { reuseVerified = false } = {}) {
    const a = op.state.protocol.agreement;
    const cacheKey={purchaseId:op.id,locator:a.ref.anchor.locator,contentHash:a.hash,scope:{agreement:a,writer:op.terms.buyer.wallet,binding:op.terms.protocol.transportBinding}};
    // With the purchase cache on, the short TTL also keys the exact scope bytes (Demos signs JSON.stringify bytes).
    const ttlKey=readbackCache?{...cacheKey,scope:{...cacheKey.scope,bytes:sha256Hex(JSON.stringify(cacheKey.scope))}}:cacheKey;
    if(sourceCapability&&reuseVerified&&immutable.get(ttlKey)){await sourceCapability.observeBinding();return;}
    const request = { logicalAddress: a.ref.anchor.locator, writer: claimForAddress(op.terms.buyer.wallet), agreementHash: a.hash, signedProjection: a.signedProjection };
    const readVerified = () => reader.readAgreement(request);
    const checkCurrent = !reuseVerified ? async (hit) => { const current = await reader.recheckAgreement({ ...request, receipt: hit.native.receipt }); return current.disposition === 'present' ? undefined : current; }
      : async () => { await sourceCapability.observeBinding(); };
    const result = readbackCache ? await readbackCache.read({ purchaseId: op.id, receipt: a.anchorReceipt, scope: cacheKey.scope }, readVerified, checkCurrent) : await readVerified();
    if (result.disposition !== 'present' || (readbackCache && !sameIncludedFact(a.anchorReceipt, result.native?.receipt)) || result.native.nativeAddress !== a.anchorReceipt.nativeAddress
      || result.native.txRef.writeTxHash !== a.anchorReceipt.transactionRef.value) {
      immutable.delete(ttlKey);
      // The payment gate carries the reader's authentication mark. An
      // unmarked failure cannot lower an already verified delivery.
      throw Object.assign(new OperationError('agreement_unverified', 'fresh native Agreement/projection readback did not verify; no payment is issued'),
        { readbackDisposition: result.disposition === 'present' || (result.disposition === 'rejected' && result.authenticated === true) ? 'rejected' : 'indeterminate',
          readbackAuthenticated: result.disposition === 'present' || result.authenticated === true });
    }
    immutable.put(ttlKey,true);
  }
  return { withWorkflow: (op, work) => journal.withWalletLock(workflowKey(op), work),
    withPaymentLane: (op, work) => journal.withWalletLock(laneKey(op), work), unresolved, assertReady, verifyAgreement,
    async readLane(op, key) {
      if (`sr2/wallet/${key}` !== laneKey(op)) throw new OperationError('wallet_lane_mismatch', 'only this purchase wallet lane may be read');
      await assertReady(op); await verifyAgreement(op);
      const record = await journal.get(laneKey(op));
      if (!record || record.stage !== 'broadcast-accepted' || record.hash !== op.state.protocol.agreement.anchorReceipt.transactionRef.value) throw new OperationError('wallet_fenced', 'the retained verified CREATE lane differs from this Agreement');
      // Public read-only guard projection of an ACTUAL retained record. This
      // does not approve payment, write a wallet record or extend CREATE scope.
      return { stage: record.stage, hash: record.hash, nonce: record.nonce };
    } };
}
