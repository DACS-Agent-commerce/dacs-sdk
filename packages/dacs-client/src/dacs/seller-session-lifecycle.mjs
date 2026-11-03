import { canonicalize, contentHash, decodeDemosAnchorReceiptProof, demosSignedTransactionProofHash, sha256Hex } from '@kynesyslabs/dacs';
import { agreementTerms, boundTermsMismatch, deliverableAddress, deliveryEvidenceAddress, deliveryIsFinal, fixedPriceAgreementLogicalAddress, paymentEvidenceAddress, protocolSupport } from './purchase-protocol.mjs';
import { addressForClaim, verifyDemosSignature } from '../signatures.mjs';

const object=(value)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const HASH=/^[0-9a-f]{64}$/;
// Why a final delegated purchase's record cannot give a seller-free readback,
// or null. Retirement requires the verified delivery that the readback pointer
// (retainedSellerAnswer in protocol-purchases.mjs) is derived from; a stage
// alone proves nothing.
export function finalDeliveryProblem(operation){
  const p=operation.state?.protocol,d=p?.delivery,answer=p?.sellerAnswer,jobId=operation.terms?.protocol?.jobId;
  if(operation.status!=='settled_verified'||!deliveryIsFinal(p))return'delivery is not final';
  if(!object(p.sessionDelegation))return'no retained session delegation';
  if(!object(d)||d.status!==p.stage)return`no verified ${p.stage} delivery is recorded`;
  if(typeof jobId!=='string'||d.deliverableRef?.anchor?.kind!=='storage-program'||d.deliverableRef.anchor.locator!==deliverableAddress(jobId))return'the Deliverable reference is not canonical';
  if(!HASH.test(d.deliverableRef.contentHash??'')||d.payloadHash!==d.deliverableRef.contentHash||!HASH.test(d.evidenceHash??''))return'the Deliverable hash is missing or malformed';
  if(typeof d.fulfilmentId!=='string'||!d.fulfilmentId||!object(d.anchorReceipt))return'the Deliverable fulfilment or receipt is missing';
  if(typeof d.report?.settlementId!=='string'||!d.report.settlementId)return'no settlement pointer is recorded';
  if(answer!==undefined&&(!object(answer)||answer.settlementId!==d.report.settlementId||answer.delivery?.logicalAddress!==d.deliverableRef.anchor.locator
    ||answer.delivery?.contentHash!==d.deliverableRef.contentHash||answer.delivery?.fulfilmentId!==d.fulfilmentId))return'the retained seller answer differs from the verified delivery';
  return null;
}
// The fields readDemDeliveryReady compares between a fresh native Deliverable
// receipt and the answer's; other substrates compare the whole receipt.
const NATIVE_RECEIPT=['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition','transactionRef','blockRef'];
const same=(left,right)=>{try{return canonicalize(left)===canonicalize(right);}catch{return false;}};
const sameDeliveryReceipt=(delivery,receipt)=>object(receipt)&&(delivery.substrate==='source-native-one-node-delivery'
  ?NATIVE_RECEIPT.every((key)=>same(delivery.anchorReceipt[key],receipt[key])):same(delivery.anchorReceipt,receipt));
// The seller can answer delivery-ready before its delivery evidence publishes;
// a later fresh read of the same pointer verifies delivered, because
// readDemDeliveryReady derives the status from the evidence it reads. That is
// the one supported promotion; the evidence hash and receipt still bind it.
const sameStatus=(answered,verified)=>answered===verified||(answered==='delivery-ready'&&verified==='delivered');
// Why the retained Agreement is not the one this purchase verified and agreed
// to, or null: its bytes must hash to the verified hash, its reference must be
// canonical for that hash, and every term must be the purchase's own.
function agreementProblem(operation){
  const agreement=operation.state.protocol.agreement,artifact=agreement?.artifact;
  if(!object(artifact))return'no retained Agreement names the payment-evidence address';
  let hash;
  try{hash=contentHash(artifact);}catch{hash=null;}
  if(!HASH.test(agreement.hash??'')||hash!==agreement.hash)return'the retained Agreement does not hash to its verified hash';
  const ref=agreement.ref;
  if(ref?.anchor?.kind!=='storage-program'||ref.anchor.locator!==fixedPriceAgreementLogicalAddress(operation.terms.protocol.jobId)||ref.contentHash!==agreement.hash)return'the retained Agreement reference is not canonical for its hash';
  let term;
  try{term=boundTermsMismatch(operation,artifact)??(artifact.terms.payoutBindings[0].phaseIndex!==protocolSupport(operation.state.protocol.listing).phases.payment?'phase':null);}catch{term='unreadable';}
  return term?`the retained Agreement differs from the purchase terms (${term})`:null;
}
// Why the retained seller answer would not reproduce this purchase's verified
// state in a seller-free readback, or null. Call after finalDeliveryProblem
// and retainsPaymentProjection. The readback re-reads everything on chain;
// this binds what it will re-read to what the buyer verified, so a foreign,
// stale or inconsistent answer keeps the key.
// projection: false runs every check before the signed projection's, in the
// same order, for a row whose answer or projection is absent. The Agreement,
// payment evidence and payment receipt are the purchase's own verified
// records, so they are checked with or without an answer; the answer's
// delivery and payment-evidence address are checked whenever there is one.
export function retainedAnswerProblem(operation,{projection=true}={}){
  const p=operation.state.protocol,d=p.delivery,answer=p.sellerAnswer,evidence=p.paymentEvidence,seller=operation.terms.seller?.claim;
  if(answer!==undefined){
    if(!sameStatus(answer.delivery?.status,d.status))return`its delivery status differs from the verified ${d.status}`;
    if(answer.delivery.evidenceHash!==d.evidenceHash)return'its delivery evidence hash differs from the verified delivery';
    if(!sameDeliveryReceipt(d,answer.delivery.anchorReceipt))return'its Deliverable receipt differs from the verified delivery';
  }
  const unbound=agreementProblem(operation);
  if(unbound)return unbound;
  let address;
  try{const terms=agreementTerms(p.agreement.artifact);address=paymentEvidenceAddress(terms.jobId,terms.rail,terms.paymentPhaseIndex);}
  catch{return'no retained Agreement names the payment-evidence address';}
  if(evidence?.ref?.anchor?.kind!=='storage-program'||evidence.ref.anchor.locator!==address||!HASH.test(evidence.ref.contentHash??''))return'the verified payment evidence is not at its canonical address';
  if(answer!==undefined&&answer.evidenceAddress!==address)return'its payment-evidence address differs from the canonical address';
  const receipt=evidence.anchorReceipt;let proof;
  try{proof=decodeDemosAnchorReceiptProof(receipt);}catch{return'no verified payment-evidence receipt is retained';}
  if(receipt.logicalAddress!==address||receipt.writer!==seller||receipt.contentHash!==evidence.ref.contentHash)return'the payment-evidence receipt does not bind the canonical seller write';
  if(!projection)return null;
  const signed=answer.signedProjection;
  if(!object(signed.content)||signed.hash!==receipt.transactionRef.value)return'its signed projection names another transaction';
  if(sha256Hex(JSON.stringify(signed.content))!==signed.hash)return'its signed projection content does not hash to its transaction';
  let projected;
  try{projected=demosSignedTransactionProofHash(signed);}catch{projected=null;}
  if(projected!==proof.signedTransactionHash)return'its signed projection is not the one the payment-evidence receipt authenticated';
  let owner;
  try{owner=addressForClaim(seller);}catch{owner=null;}
  if(!owner||signed.content.from!==owner||signed.signature?.type!=='ed25519'||!verifyDemosSignature({address:owner,message:signed.hash,signature:signed.signature.data}))return'its signed projection lacks the seller\'s authorization';
  return null;
}
// Fresh payment readback authenticates the original CREATE only with its
// public signed projection. The retained seller answer is the one durable
// source: the seller wallet journal keeps just the latest CREATE per wallet
// lane, so its reader cannot be relied on for an older purchase. Rows without
// it (verified before the answer was retained) keep their key until a
// seller-backed recheck retains one.
export const retainsPaymentProjection=(operation)=>object(operation.state?.protocol?.sellerAnswer?.signedProjection);
// Chain readback: the logical addresses of verified results
// whose signed CREATE bytes this purchase has not kept yet. A seller-free
// readback of the payment evidence, Deliverable and delivery evidence needs
// each of them (protocol-purchases.mjs keeps them in state.protocol.chainReadback).
// Only canonical addresses are listed: one that cannot be derived names no
// pointer that could ever be kept, so it never holds a key or an ask open
// (an unreadable Agreement already keeps the key through retainedAnswerProblem,
// which retirement runs with or without a retained projection).
export function missingChainPointers(operation){
  const p=operation.state?.protocol,kept=object(p?.chainReadback)?p.chainReadback:{},jobId=operation.terms?.protocol?.jobId,needed=[];
  if(p?.paymentEvidence){try{const terms=agreementTerms(p.agreement.artifact);needed.push(paymentEvidenceAddress(terms.jobId,terms.rail,terms.paymentPhaseIndex));}catch{/* no canonical address */}}
  if(p?.delivery&&typeof jobId==='string'){
    needed.push(deliverableAddress(jobId));
    if(p.delivery.evidenceRef)needed.push(deliveryEvidenceAddress(jobId));
  }
  return needed.filter((address)=>!object(kept[address]));
}
// Chain readback: what in a fresh seller answer's delivery
// pointer is not the delivery this purchase verified, or null. A read rejected
// while they differ may be rejecting the seller's claim, not the chain.
// evidence: also compare the delivery evidence hash.
export function deliveryPointerDiffers(verified,answer,{evidence=false}={}){
  const pointer=answer?.delivery;
  if(!object(verified)||!object(pointer))return'delivery pointer';
  if(pointer.logicalAddress!==verified.deliverableRef?.anchor?.locator)return'Deliverable address';
  if(pointer.contentHash!==verified.payloadHash)return'Deliverable payload hash';
  if(pointer.fulfilmentId!==verified.fulfilmentId)return'fulfilment';
  if(answer.settlementId!==verified.report?.settlementId)return'settlement';
  if(!object(verified.anchorReceipt)||!sameDeliveryReceipt(verified,pointer.anchorReceipt))return'Deliverable receipt';
  if(evidence&&pointer.evidenceHash!==verified.evidenceHash)return'delivery evidence hash';
  return null;
}
// Chain readback: a final purchase still missing a pointer asks
// the seller's idempotent payment route for it (answered from the seller's
// effect cache) at most CHAIN_POINTER_ASK_LIMIT times, no more often than
// CHAIN_POINTER_ASK_INTERVAL_MS. Past that, or once its seller session key is
// retired, nothing can obtain the pointer: the purchase keeps its verified
// result, reads back from its retained answer only, and is held for the
// operator (state.protocol.chainReadbackHeld, reported by ops health).
export const CHAIN_POINTER_ASK_LIMIT=10;
export const CHAIN_POINTER_ASK_INTERVAL_MS=60*1000;
export const CHAIN_READBACK_OPERATOR_ACTION='chain-readback-pointers-missing';
export function chainPointerAskDue(protocol,time){
  const asks=protocol?.chainPointerAsks;
  if(asks===undefined)return true;
  return object(asks)&&Number.isSafeInteger(asks.count)&&asks.count<CHAIN_POINTER_ASK_LIMIT&&time-Date.parse(asks.at)>=CHAIN_POINTER_ASK_INTERVAL_MS;
}
// Why a fresh seller answer may not become the purchase's retained answer, or
// null. protocol is what its readback is about to save, with the answer as
// sellerAnswer. It must bind to that readback's verified payment receipt and
// delivery exactly as retirement requires, so a retirement-safe answer is
// never replaced by one that cannot authenticate the purchase.
export function replacementAnswerProblem(operation,protocol){
  const candidate={...operation,state:{...operation.state,protocol}};
  if(!object(protocol.delivery))return'no verified delivery is recorded';
  if(!retainsPaymentProjection(candidate))return'it carries no signed payment projection';
  return retainedAnswerProblem(candidate);
}

const ENDED=new Set(['expired','terms_changed','superseded','agreement_rejected','payment_failed','payment_mismatch']);
const PAYMENT_OPEN=new Set(['payment_handoff','broadcast_reported','payment_uncertain']);
export function sellerSessionEnd(operation,payload,time){
  const changed=Date.parse(operation.updatedAt),status=operation.status;
  if(!Number.isFinite(changed))return{since:null,reason:'purchase has no readable last-change time'};
  if(ENDED.has(status))return{since:changed,reason:`purchase ${status}`};
  if(status==='settled_verified')return deliveryIsFinal(operation.state?.protocol)
    ?{since:changed,reason:`purchase ${operation.state.protocol.stage}`}
    :{since:null,reason:'paid; seller claim, payment evidence, delivery or delivery evidence is not final'};
  if(status==='agreement_pending'||status==='awaiting_approval'){
    const window=Date.parse(operation.expiresAt);
    return window<=time?{since:Math.max(changed,window),reason:'approval window elapsed'}:{since:null,reason:`purchase ${status} inside its approval window`};
  }
  if(status==='cancelled')return payload.expiresAt<=time
    ?{since:Math.max(changed,payload.expiresAt),reason:'purchase cancelled and delegation expired'}
    :{since:null,reason:'purchase cancelled; delegation still live'};
  return{since:null,reason:PAYMENT_OPEN.has(status)?`purchase ${status}: payment outcome unresolved`:`purchase ${status} is not final`};
}

// Only a real return to unresolved seller work clears the durable clock.
export function sellerSessionTransitionState(current,status,state,time){
  const payload=state?.protocol?.sessionDelegation?.payload;
  if(current.kind!=='purchase'||!payload)return state;
  const next={...current,status,state,updatedAt:new Date(time).toISOString()},end=sellerSessionEnd(next,payload,time);
  const protocol={...state.protocol};delete protocol.sellerSessionFinalAt;
  if(end.since!==null){
    const previous=sellerSessionEnd(current,payload,time);
    protocol.sellerSessionFinalAt=previous.since===null?end.since:(current.state?.protocol?.sellerSessionFinalAt??previous.since);
  }
  return{...state,protocol};
}
