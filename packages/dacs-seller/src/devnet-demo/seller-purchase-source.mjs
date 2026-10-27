// Seller-owned purchase projections. Only a trusted fresh observer can establish payment; nothing here writes or signs.
import { contentHash } from '@kynesyslabs/dacs';
import { addressForClaim } from '../dacs/demos-claims.mjs';

const demOs=(value)=>typeof value==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value)?BigInt(value.split('.')[0])*1_000_000_000n+BigInt((value.split('.')[1]??'').padEnd(9,'0')):null;

// The buyer's signed Agreement CREATE, which the seller authenticated on its
// own chain readback before committing and retained. Its binding names the
// network and chain identity the purchase runs on; null when none is retained.
function agreementBinding(projection){
  const content=projection?.content,binding=content?.data?.[1]?.metadata?.networkBinding;
  if(typeof content?.network!=='string'||typeof content.chainIdentity!=='string'||binding?.network!==content.network||binding.chainIdentity!==content.chainIdentity)return null;
  return structuredClone(binding);
}

/** Whether ref is exactly a Demos payment transaction reference: {kind:'demos', txHash (64 lower-case hex), blockNumber (safe integer >= 0)}. */
export const isPaymentTxRef = (ref) => ref !== null && typeof ref === 'object' && !Array.isArray(ref) && Object.keys(ref).sort().join() === 'blockNumber,kind,txHash'
  && ref.kind === 'demos' && typeof ref.txHash === 'string' && /^[0-9a-f]{64}$/.test(ref.txHash) && Number.isSafeInteger(ref.blockNumber) && ref.blockNumber >= 0 && !Object.is(ref.blockNumber, -0);

const PAYMENT_OBSERVATION_LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 1024 });
// The observer must read current chain authority, cap wire bytes before decode,
// and honor signal. Only a fresh reading of this exact job/Agreement is usable,
// and a verified reading must name the payment transaction it verified.
async function freshPaymentReading(observePayment, projection, agreement, now) {
  if (typeof observePayment !== 'function' || !agreement || contentHash(agreement) !== projection.agreementHash) return null;
  const observedAt = now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) return null;
  const controller = new AbortController(); let timer;
  const query = { jobId: projection.jobId, agreementHash: projection.agreementHash, agreement: structuredClone(agreement), observedAt, fresh: true };
  try {
    const reading = await Promise.race([Promise.resolve().then(() => controller.signal.aborted ? null : observePayment(query, { ...PAYMENT_OBSERVATION_LIMITS, signal: controller.signal })),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, PAYMENT_OBSERVATION_LIMITS.timeoutMs); })]);
    const checkedAt = now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < observedAt) return null;
    if (contentHash(query.agreement) !== projection.agreementHash || reading?.jobId !== projection.jobId || reading.agreementHash !== projection.agreementHash ||
        !Number.isSafeInteger(reading.observedAt) || reading.observedAt < observedAt || reading.observedAt > checkedAt) return null;
    if (reading.disposition === 'verified') return isPaymentTxRef(reading.paymentTxRef) ? { observed: true, txRef: structuredClone(reading.paymentTxRef) } : null;
    return reading.disposition === 'absent' ? { observed: false, txRef: null } : null;
  } catch { return null; }
  finally { clearTimeout(timer); controller.abort(); }
}

// Seller source: the same purchase shape as the app source, from the seller's
// own durable session. null: the seller has no record of this job (the vet
// records are written before the proposal reaches it), including a session
// that holds neither a proposal draft nor an Agreement yet. false: the record
// names a buyer outside closed access, which the app source refuses too.
// The seller is never told of a buyer-side cancellation; operator-approval.mjs
// holds pre-payment writes for that reason. Seller records alone always keep
// prePaymentOpen null (unknown); false is reserved for known closed purchases.
// Missing current payment authority is null.
/** Resolve snapshots asynchronously; observePayment must return a fresh {disposition,jobId,agreementHash,observedAt},
 * and a verified reading also its paymentTxRef (isPaymentTxRef). paymentObserved is true for verified, false for
 * authoritative absence, and null for indeterminate authority (including a verified reading without a valid
 * paymentTxRef); paymentTxRef is the verified transaction when paymentObserved is true, else null. */
export function sellerRecordsPurchaseResolver({sessionOf,buyerAccess,now,observePayment}){
  return async(jobId)=>{
    const session=sessionOf(jobId);
    const agreement=session?.agreement??session?.proposal?.plan?.draft??null;
    if(!agreement)return null;
    const party=(role)=>agreement?.parties?.find((entry)=>entry.role===role)?.primaryClaim??null;
    const presented=session.buyerBundle?.presentedBy,buyer=party('buyer');
    let buyerAddress;
    try {
      buyerAddress=addressForClaim(buyer);
      if(buyerAddress!==addressForClaim(presented))return false;
    } catch { return false; }
    if(!buyerAccess().allowsWallet(buyerAddress))return false;
    const ref=agreement?.listingRef,price=agreement?.terms?.price,amount=price?.currency==='DEM'?demOs(price.amount):null;
    const projection={jobId:session.jobId,seller:party('seller'),buyer,listingPin:ref?{listingId:ref.listingId,version:ref.version,contentHash:ref.contentHash}:null,
      sourceBinding:agreementBinding(session.agreementSignedProjection),agreementHash:session.agreementHash??null,amountOs:amount===null?null:amount.toString(),
      paymentObserved:null,paymentTxRef:null,prePaymentOpen:null};
    const payment=await freshPaymentReading(observePayment,projection,session.agreement,now);
    Object.assign(projection,{paymentObserved:payment?.observed??null,paymentTxRef:payment?.txRef??null});
    return projection;
  };
}

// Seller source: jobs whose verified Deliverable still awaits its delivery
// evidence readback. The seller reached delivery-ready and has not read the
// evidence back (it would then be delivered).
export function sellerHeldEvidenceJobs(sessions){
  return sessions.filter((session)=>session?.settlementCredit!=='indeterminate'&&session?.stage==='delivery-ready'&&session.deliveryReady&&session.nativeEvidenceWork).map((session)=>({jobId:session.jobId}));
}

// Shown with the manual approval of a pre-payment write the seller policy held.
export function sellerHoldNotice(request){
  return['CompositeVerificationRecord','FinalityCommitmentRecord'].includes(request?.content?.artifactKind)
    ?'Seller policy reads purchases from seller records only. They cannot show a buyer-side cancellation, nor, before the Agreement proposal, the purchase itself. Approve this exact pre-payment seller transaction only if you know the purchase is still open.'
    :null;
}
