// Seller-owned purchase state only. Nothing here writes, signs or reads the chain.
import { addressForClaim } from '../dacs/demos-claims.mjs';

const CLAIM=/^did:demos:agent:[0-9a-f]{64}$/;
const demOs=(value)=>typeof value==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value)?BigInt(value.split('.')[0])*1_000_000_000n+BigInt((value.split('.')[1]??'').padEnd(9,'0')):null;

// The app's purchase approval window (purchases.mjs approvalTtlMs). The seller
// cannot see when the buyer prepared the purchase, so it counts the window from
// the earliest time it holds for the job: the Agreement draft's generatedAt or
// its own admission of the proposal.
export const SELLER_PURCHASE_OPEN_WINDOW_MS=30*60*1000;

// The buyer's signed Agreement CREATE, which the seller authenticated on its
// own chain readback before committing and retained. Its binding names the
// network and chain identity the purchase runs on; null when none is retained.
function agreementBinding(projection){
  const content=projection?.content,binding=content?.data?.[1]?.metadata?.networkBinding;
  if(typeof content?.network!=='string'||typeof content.chainIdentity!=='string'||binding?.network!==content.network||binding.chainIdentity!==content.chainIdentity)return null;
  return structuredClone(binding);
}

// The seller's own payment intake verified a payment for this job.
const intakeVerified=(work,jobId)=>work?.intake?.disposition==='verified'&&['claim','already-claimed'].includes(work.intake.fulfilment)&&work.intake.jobId===jobId;

// Seller source: the same purchase shape as the app source, from the seller's
// own durable session. null: the seller has no record of this job (the vet
// records are written before the proposal reaches it), including a session
// that holds neither a proposal draft nor an Agreement yet. false: the record
// names a buyer outside closed access, which the app source refuses too.
// The seller is never told of a buyer-side cancellation; operator-approval.mjs
// holds pre-payment writes for that reason, so prePaymentOpen here only says
// the job is not known to be closed.
export function sellerRecordsPurchaseResolver({sessionOf,buyerAccess,now}){
  return(jobId)=>{
    const session=sessionOf(jobId);
    const agreement=session?.agreement??session?.proposal?.plan?.draft??null;
    if(!agreement)return null;
    const party=(role)=>agreement?.parties?.find((entry)=>entry.role===role)?.primaryClaim??null;
    const presented=session.buyerBundle?.presentedBy,buyer=CLAIM.test(presented??'')&&party('buyer')===presented?presented:null;
    if(buyer&&!buyerAccess().allowsWallet(addressForClaim(buyer)))return false;
    const ref=agreement?.listingRef,price=agreement?.terms?.price,amount=price?.currency==='DEM'?demOs(price.amount):null;
    const paymentObserved=session.settlementCredit!=='indeterminate'&&(intakeVerified(session.nativeEvidenceWork,session.jobId)||intakeVerified(session.paymentWork,session.jobId)||typeof session.payment?.settlementId==='string');
    const admitted=session.proposalAdmission?.observedAt,generatedAt=session.proposal?.plan?.draft?.generatedAt,deadline=agreement?.terms?.deadline,at=now();
    const since=Number.isSafeInteger(admitted)&&Number.isSafeInteger(generatedAt)?Math.min(admitted,generatedAt):null;
    // Closed before payment: expired, past the Agreement deadline, or already
    // committed (the buyer may be paying, and no pre-payment write follows).
    const prePaymentOpen=!paymentObserved&&!session.commitment&&since!==null&&since+SELLER_PURCHASE_OPEN_WINDOW_MS>at&&Number.isSafeInteger(deadline)&&deadline>at;
    return{jobId:session.jobId,seller:party('seller'),buyer,listingPin:ref?{listingId:ref.listingId,version:ref.version,contentHash:ref.contentHash}:null,
      sourceBinding:agreementBinding(session.agreementSignedProjection),agreementHash:session.agreementHash??null,amountOs:amount===null?null:amount.toString(),
      paymentObserved,prePaymentOpen};
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
