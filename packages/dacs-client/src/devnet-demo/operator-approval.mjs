import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { canonicalize, compositeVerificationAddress, contentHash, finalityCommitmentAddress, isCanonicalJobId, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { stopRequested, stopSignal } from './stop-request.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');
const OS=/^(0|[1-9][0-9]*)$/,POSITIVE_OS=/^[1-9][0-9]*$/,HASH=/^[0-9a-f]{64}$/,CLAIM=/^did:demos:agent:[0-9a-f]{64}$/;
const EVIDENCE_FORMAT='dacs-node2-operator-approval-evidence/v1';
const ATTEMPT_FORMAT='dacs-node2-seller-policy-attempt/v1';
const policyTails=new Map();
const provisionalHolds=new Map();
// The compose CLI's stop handler reads this: a stop while this process waits
// at a seller APPROVE prompt ends it unanswered instead of waiting for an answer.
// The Listing's prompt is not counted: a stop declines it (stopSignal below).
let ttyPrompts=0;
export const ttyApprovalPending=()=>ttyPrompts>0;
function serializedPolicy(evidencePath,work){
  const key=resolve(evidencePath),result=(policyTails.get(key)??Promise.resolve()).then(work),tail=result.catch(()=>{});
  policyTails.set(key,tail);
  void tail.then(()=>{if(policyTails.get(key)===tail)policyTails.delete(key);});
  return result;
}
const KINDS=new Set(['CompositeVerificationRecord','FinalityCommitmentRecord','SettlementEvidence','Deliverable']);
// Vet records and the commitment are written before the buyer pays; payment
// and delivery evidence and the Deliverable only once payment is observed.
const BEFORE_PAYMENT=new Set(['CompositeVerificationRecord','FinalityCommitmentRecord']),AFTER_PAYMENT=new Set(['SettlementEvidence','Deliverable']);
export const SELLER_POLICY_MAX_WRITES=6;
export const SELLER_POLICY_WINDOW_MS=3_600_000;
// Policy-mode limits, all configurable. maxWriteTotalOs caps one write's
// complete debit; its unchanged 4 DEM default is L4's declared Node2 debit
// on 2026-10-07 (storage 1, SDK gas 1, network 1, RPC 1). Until measured live,
// count the larger of that request declaration and confirmed sender removals.
// The hourly limits are a budget across all jobs in a rolling hour: 24
// policy-approved writes and 96 DEM, about four complete six-write purchases
// at the 4 DEM cap. Outstanding attempts hold their full debit; completed
// attempts count for an hour after completion. A post-payment refusal goes to
// exact manual approval, so it cannot strand a paid purchase.
export const SELLER_POLICY_DEFAULTS=Object.freeze({maxWriteTotalOs:'4000000000',maxWritesPerHour:24,maxTotalOsPerHour:'96000000000'});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&canonicalize(Object.keys(value).sort())===canonicalize([...keys].sort());
const same=(a,b)=>canonicalize(a)===canonicalize(b);
const demOs=(value)=>typeof value==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value)?BigInt(value.split('.')[0])*1_000_000_000n+BigInt((value.split('.')[1]??'').padEnd(9,'0')):null;

// Node 61b8e75 applies storage/gas balance removals for CREATEs; its
// additional transaction_fee distribution is native-only. Numbers are legacy
// whole DEM, canonical strings are OS. Never round or coerce fee values.
function confirmedWriteOs(validity,request){
  const data=validity?.response?.data,c=data?.transaction?.content,r=request.content;
  const postFork=c?.amount==='0';
  const wireOs=(value)=>postFork?(typeof value==='string'&&OS.test(value)?BigInt(value):null)
    :Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0)?BigInt(value)*1_000_000_000n:null;
  if(validity?.result!==200||data?.valid!==true||data.gas_operation!=null||data.custom_charges!=null
    ||c?.type!=='storageProgram'||(c.amount!==0&&c.amount!=='0')||c.from!==r.wallet||c.nonce!==r.nonce||c.timestamp!==r.timestamp
    ||JSON.stringify(c.data?.[1])!==r.exactCreate||!Array.isArray(c.gcr_edits))return null;
  const fee=c.transaction_fee;
  if(!fee||['network_fee','rpc_fee','additional_fee'].some(key=>wireOs(fee[key])===null))return null;
  const removals=c.gcr_edits.filter(edit=>edit?.type==='balance');
  if(removals.length!==2||removals.some(edit=>edit.operation!=='remove'||edit.account!==r.wallet))return null;
  const amounts=removals.map(edit=>wireOs(edit.amount));
  if(amounts.some(value=>value===null)||amounts[0]!==demOs(r.debit.storageFeeDem))return null;
  return amounts.reduce((sum,value)=>sum+value,0n);
}

// Validates the optional operator config field. Manual stays exactly
// {mode:'manual'}; policy may set its limits, each defaulting as above.
export function sellerApprovalSettings(value){
  if(value===undefined)return Object.freeze({mode:'manual'});
  if(!value||typeof value!=='object'||Array.isArray(value)||!['manual','policy'].includes(value.mode)||(value.mode==='manual'&&!exact(value,['mode'])))throw new TypeError('sellerApproval must name exact manual or policy mode');
  if(value.mode==='manual')return Object.freeze({mode:'manual'});
  if(Object.keys(value).some(key=>key!=='mode'&&!Object.hasOwn(SELLER_POLICY_DEFAULTS,key)))throw new TypeError('sellerApproval policy accepts only maxWriteTotalOs, maxWritesPerHour and maxTotalOsPerHour');
  const limits={...SELLER_POLICY_DEFAULTS,...value};
  if(typeof limits.maxWriteTotalOs!=='string'||!POSITIVE_OS.test(limits.maxWriteTotalOs))throw new TypeError('sellerApproval.maxWriteTotalOs must be a positive canonical OS string');
  if(!Number.isSafeInteger(limits.maxWritesPerHour)||limits.maxWritesPerHour<1||limits.maxWritesPerHour>1000)throw new TypeError('sellerApproval.maxWritesPerHour must be an integer from 1 to 1000');
  if(typeof limits.maxTotalOsPerHour!=='string'||!POSITIVE_OS.test(limits.maxTotalOsPerHour)||BigInt(limits.maxTotalOsPerHour)<BigInt(limits.maxWriteTotalOs))throw new TypeError('sellerApproval.maxTotalOsPerHour must be a positive canonical OS string of at least maxWriteTotalOs');
  return Object.freeze({mode:'policy',...limits});
}

// Returns null when the exact request is within policy, otherwise a short
// refusal reason that is retained on the evidence line.
async function policyRefusal(request,policy,limits,{confirmedTotal,countedTotal,manualApproved=false}={}){
  const c=request?.content,d=c?.debit;
  if(!exact(request,['method','address','purpose','content'])||request.method!=='sendTransaction'||typeof request.purpose!=='string'
    ||!exact(c,['kind','action','artifactKind','jobId','owner','wallet','logicalAddress','storageAddress','programName','contentHash','contentHashProfile','envelopeHash',...(c?.artifactKind==='Deliverable'?['deliveryBinding']:[]),'storageBytes','exactStorageBytes','exactCreate','nonce','timestamp','debit','network','chainIdentity','networkBinding','evidence','sending'])
    ||!['devnet-demo-artifact-storage-create','devnet-settlement-evidence-storage-create'].includes(c.kind)||c.contentHashProfile!=='SDK CF-1 signed scope (top-level signature/signatures omitted)'
    ||c.action!=='immutable DACS storage anchor CREATE'||!KINDS.has(c.artifactKind)||!isCanonicalJobId(c.jobId)
    ||request.address!==policy.address||c.wallet!==policy.address||c.owner!==policy.seller
    ||c.network!==policy.sourceBinding.network||c.chainIdentity!==policy.sourceBinding.chainIdentity||!same(c.networkBinding,policy.sourceBinding)
    ||!Number.isSafeInteger(c.nonce)||c.nonce<1||!Number.isSafeInteger(c.timestamp)||c.timestamp<0)return 'request-shape';
  if(!exact(d,['storageFeeDem','sellerAmountDem','sdkGasDem','networkFeeDem','rpcFeeDem','additionalFeeDem','totalDem','totalOs','note'])
    ||d.sellerAmountDem!=='0'||typeof d.totalOs!=='string'||!OS.test(d.totalOs??''))return 'debit';
  const fees=['storageFeeDem','sdkGasDem','networkFeeDem','rpcFeeDem','additionalFeeDem'].map(key=>demOs(d[key]));
  if(fees.some(value=>value===null)||fees[0]<=0n||fees[4]!==0n
    ||fees.reduce((a,b)=>a+b,0n)!==BigInt(d.totalOs)||demOs(d.totalDem)!==BigInt(d.totalOs))return 'debit';
  const declared=BigInt(d.totalOs),cap=BigInt(limits.maxWriteTotalOs);
  const total=countedTotal===undefined?declared:countedTotal;
  if(total===null)return 'debit';
  // Preparation checks the configured cap. Confirmation also bounds an
  // unexpected debit by the declaration; manual approval authorizes exactly it.
  const allowance=manualApproved||(confirmedTotal!==undefined&&declared<cap)?declared:cap;
  if(total>allowance)return 'write-fee-cap';
  if(manualApproved)return null;
  const op=JSON.parse(c.exactCreate),artifact=JSON.parse(c.exactStorageBytes),metadata=op?.metadata;
  if(!exact(op,['operation','storageAddress','programName','salt','data','encoding','acl','storageLocation','metadata'])
    ||op.operation!=='CREATE_STORAGE_PROGRAM'||op.salt!==''||op.encoding!=='json'||op.storageLocation!=='onchain'||!exact(op.acl,['mode'])||op.acl.mode!=='public'
    ||op.storageAddress!==c.storageAddress||op.programName!==c.programName||c.programName!==c.logicalAddress.replace(/:/g,'%3A')
    ||!same(op.data,artifact)||artifact.jobId!==c.jobId||contentHash(artifact)!==c.contentHash||sha(canonicalize(artifact))!==c.envelopeHash
    ||c.storageBytes!==Buffer.byteLength(c.exactStorageBytes)||fees[0]!==BigInt(Math.max(1,Math.ceil(c.storageBytes/10240)))*1_000_000_000n
    ||metadata?.logicalAddress!==c.logicalAddress||metadata.artifactKind!==c.artifactKind||metadata.contentHash!==c.contentHash||metadata.envelopeHash!==c.envelopeHash
    ||!same(metadata.networkBinding,policy.sourceBinding))return 'create-bytes';
  const purchase=await policy.resolvePurchase(c.jobId);
  if(!exact(purchase,['jobId','seller','buyer','listingPin','sourceBinding','agreementHash','amountOs','paymentObserved','prePaymentOpen'])||purchase.jobId!==c.jobId||purchase.seller!==policy.seller
    ||!CLAIM.test(purchase.buyer??'')||typeof purchase.paymentObserved!=='boolean'||typeof purchase.prePaymentOpen!=='boolean'||!POSITIVE_OS.test(purchase.amountOs??'')
    ||!same(purchase.listingPin,policy.listingPin())||!same(purchase.sourceBinding,policy.sourceBinding))return 'purchase';
  if(AFTER_PAYMENT.has(c.artifactKind)&&!purchase.paymentObserved)return 'payment-not-observed';
  if(BEFORE_PAYMENT.has(c.artifactKind)&&purchase.paymentObserved)return 'payment-already-observed';
  // A cancelled, expired or otherwise ended purchase gets no more seller writes before payment.
  if(BEFORE_PAYMENT.has(c.artifactKind)&&!purchase.prePaymentOpen)return 'purchase-closed';
  if(c.artifactKind==='SettlementEvidence'&&artifact.phase==='pay-dem'&&(!exact(artifact.paymentAmount,['amount','currency'])||artifact.paymentAmount.currency!=='DEM'
    ||demOs(artifact.paymentAmount.amount)!==BigInt(purchase.amountOs)))return 'payment-amount';
  if(c.artifactKind==='CompositeVerificationRecord'&&artifact.evaluatedParty!==purchase.buyer&&artifact.evaluatedParty!==policy.seller)return 'evaluated-party';
  const expectedAddress=c.artifactKind==='CompositeVerificationRecord'?compositeVerificationAddress(c.jobId,artifact.evaluatedParty):c.artifactKind==='FinalityCommitmentRecord'?finalityCommitmentAddress(c.jobId):c.artifactKind==='Deliverable'?`dacs4:deliverable:${c.jobId}`:artifact.phase==='pay-dem'?paymentEvidenceAddress(c.jobId,'demos-native:DEM',2):artifact.phase==='deliver-storage-program'?`dacs4:evidence:${c.jobId}`:null;
  if(c.logicalAddress!==expectedAddress)return 'logical-address';
  if(artifact.listingPin&&!same(artifact.listingPin,purchase.listingPin))return 'listing';
  if(artifact.listing&&!same(artifact.listing,purchase.listingPin))return 'listing';
  if(artifact.listingRef&&!same(artifact.listingRef,purchase.listingPin))return 'listing';
  if(artifact.agreementHash&&artifact.agreementHash!==purchase.agreementHash)return 'agreement';
  if(c.artifactKind==='Deliverable'){
    const binding=c.deliveryBinding;
    if(!exact(binding,['version','profile','jobId','phase','phaseIndex','listing','agreementHash','fulfilmentId','purchaseAmount','payloadHash'])
      ||binding.version!=='1'||binding.profile!=='dacs-native-delivery-publication/v1'||binding.jobId!==c.jobId||binding.phase!=='deliver-storage-program'
      ||!Number.isSafeInteger(binding.phaseIndex)||binding.phaseIndex<0||!same(binding.listing,purchase.listingPin)||binding.agreementHash!==purchase.agreementHash
      ||typeof binding.fulfilmentId!=='string'||!binding.fulfilmentId||binding.fulfilmentId.length>128||binding.payloadHash!==c.contentHash
      ||!exact(binding.purchaseAmount,['amount','currency'])||binding.purchaseAmount.currency!=='DEM'||demOs(binding.purchaseAmount.amount)!==BigInt(purchase.amountOs)
      ||!same(metadata.deliveryBinding,binding))return 'delivery-binding';
  }
  return null;
}

// Reads decisions and exact attempt completions for the policy limits.
// Lines written before request bytes
// were retained (older manual approvals) carry no requestBytes: they cannot be
// attributed to a job and were never policy decisions, so they count towards
// neither limit. Any other malformed line fails closed.
async function readPolicyLedger(evidencePath){
  let text='';
  try{text=await readFile(evidencePath,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  return parsePolicyLedger(text);
}
// Exported read-only for the operator health report, which must count the
// same ledger as admission.
export function parsePolicyLedger(text){
  const malformed=()=>{throw new Error('seller approval evidence is malformed');};
  const rows=[],byReservationId=new Map();
  for(const line of text.split('\n')){
    if(!line.trim())continue;
    const row=JSON.parse(line);
    if(row?.format===ATTEMPT_FORMAT){
      if(!exact(row,['format','reservationId','approvalHash','outcome','recordedAt'])||typeof row.reservationId!=='string'||!row.reservationId||!HASH.test(row.approvalHash??'')
        ||!['spent','released'].includes(row.outcome)||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0)malformed();
      const reservation=byReservationId.get(row.reservationId);
      if(!reservation?.policy||reservation.decision!=='approved'||reservation.approvalHash!==row.approvalHash||reservation.outcome!==null||row.recordedAt<reservation.recordedAt)malformed();
      reservation.outcome=row.outcome;reservation.completedAt=row.recordedAt;
      continue;
    }
    if(!row||typeof row!=='object'||Array.isArray(row)||row.format!==EVIDENCE_FORMAT||!['approved','rejected'].includes(row.decision)||!HASH.test(row.approvalHash??''))malformed();
    if(!Object.hasOwn(row,'requestBytes')){if(Object.hasOwn(row,'approvalMode'))malformed();continue;}
    if(typeof row.requestBytes!=='string'||sha(row.requestBytes)!==row.approvalHash)malformed();
    const policyRow=Object.hasOwn(row,'approvalMode');
    if(policyRow&&(row.approvalMode!=='policy'||(row.decision==='approved'&&(!Number.isSafeInteger(row.recordedAt)||!OS.test(row.totalOs??'')))))malformed();
    if(Object.hasOwn(row,'reservationId')&&(!policyRow||typeof row.reservationId!=='string'||!row.reservationId||byReservationId.has(row.reservationId)))malformed();
    const request=JSON.parse(row.requestBytes),declared=request?.content?.debit?.totalOs;
    // A manual confirmation annotates its existing approval, not a second write.
    if(Object.hasOwn(row,'manualApproved')){if(row.manualApproved!==true||policyRow||!row.confirmation)malformed();continue;}
    if(policyRow&&row.decision==='approved'&&!OS.test(declared??''))malformed();
    const totalOs=policyRow&&row.decision==='approved'&&BigInt(declared)>BigInt(row.totalOs)?declared:row.totalOs;
    const entry={decision:row.decision,policy:policyRow,jobId:request?.content?.jobId??null,totalOs,recordedAt:row.recordedAt,
      reservationId:row.decision==='approved'?row.reservationId:null,approvalHash:row.approvalHash,outcome:null};
    rows.push(entry);
    if(typeof entry.reservationId==='string')byReservationId.set(entry.reservationId,entry);
  }
  return rows;
}

// The policy approvals both hourly limits hold at `at`: an approval without a
// completion stays held, a spent one for an hour after completion, a released
// one not at all. Exported read-only for the operator health report.
export function heldPolicyBudget(ledger,at){
  const held=ledger.filter(row=>row.policy&&row.decision==='approved'&&row.outcome!=='released'&&(row.outcome===null||row.completedAt>at-SELLER_POLICY_WINDOW_MS));
  return {writes:held.length,totalOs:held.reduce((sum,row)=>sum+BigInt(row.totalOs),0n)};
}
// Preparations hold budget in this process's memory before their approved
// row exists. Another process (such as the health CLI) always sees none.
export function provisionalPolicyHolds(evidencePath){
  return [...(provisionalHolds.get(resolve(evidencePath))??[])].map(hold=>({...hold}));
}

// The final pre-payment check, synchronous so that no cancellation can land
// between it and the answer. A resolver that is not synchronous fails closed.
function stillOpenBeforePayment(request,policy){
  if(!BEFORE_PAYMENT.has(request.content.artifactKind))return null;
  const purchase=policy.resolvePurchase(request.content.jobId);
  if(typeof purchase?.then==='function'){purchase.catch?.(()=>{});return 'policy-check-failed';}
  return purchase?.jobId===request.content.jobId&&purchase.prePaymentOpen===true&&purchase.paymentObserved===false?null:'purchase-closed';
}

async function budgetRefusal({evidencePath,jobId,totalOs,at,limits,manualApproved=false,provisional=null}){
  // A manual confirmation completes a write the operator already approved exactly.
  if(manualApproved)return null;
  const ledger=await readPolicyLedger(evidencePath);
  // A matching preparation already holds both limits. The fee rule forbids
  // confirmation from increasing its declared ceiling; convert it once.
  if(provisional)return null;
  ledger.push(...(provisionalHolds.get(resolve(evidencePath))??[]));
  if(ledger.filter(row=>row.decision==='approved'&&row.outcome!=='released'&&row.jobId===jobId).length>=SELLER_POLICY_MAX_WRITES)return 'job-write-limit';
  // Old approvals lack completion proof and remain held, as do unknown outcomes.
  const recent=heldPolicyBudget(ledger,at);
  if(recent.writes>=limits.maxWritesPerHour)return 'hourly-write-limit';
  if(recent.totalOs+BigInt(totalOs)>BigInt(limits.maxTotalOsPerHour))return 'hourly-dem-limit';
  return null;
}

// Combines the two approval paths for the seller wallet. Listing writes are
// always manual. A policy refusal is final for that artifact (the wallet
// journals it as denied), so refusing a write after payment would strand a
// purchase the buyer has already paid for: payment evidence, delivery evidence
// and the Deliverable go to exact manual approval instead before signing.
// A refused fee at confirmation never goes to a manual override.
export function composeSellerApproval({mode,policy,manual}){
  let prepared=null;
  // The policy holds the same copy through preparation and confirmation;
  // settle maps the wallet's request back to that copy.
  const confirmedCopies=new WeakMap();
  const approve=async(request)=>{
    const previous=prepared;prepared=null;
    if(previous?.policy)await policy.settle?.(previous.request,'released');
    const kind=request?.content?.artifactKind;
    if(mode!=='policy'||kind==='Listing')return manual(request);
    const deferred=typeof policy.prepare==='function';
    const copy=deferred?structuredClone(request):request;
    if((await (deferred?policy.prepare(copy):policy(request)))===true){
      if(deferred){prepared={request:copy,policy:true,origin:request};confirmedCopies.set(request,copy);}
      return true;
    }
    if(AFTER_PAYMENT.has(kind)&&(await manual(request))===true){
      if(deferred)prepared={request:structuredClone(request),policy:false};
      return true;
    }
    return false;
  };
  // The operator serializes this seller wallet. Consume one prepared decision
  // at confirmation; a failed/repeated confirmation cannot reuse it.
  approve.confirm=async(validity)=>{
    const current=prepared;prepared=null;
    if(!current)return false;
    const c=validity?.response?.data?.transaction?.content,r=current.request.content;
    if(c?.from!==r.wallet||c.nonce!==r.nonce||c.timestamp!==r.timestamp||JSON.stringify(c.data?.[1])!==r.exactCreate){
      if(current.policy)await policy.settle?.(current.request,'released');return false;
    }
    return policy(current.request,validity,{manualApproved:!current.policy});
  };
  approve.settle=(request,outcome)=>{
    if(outcome==='released'&&prepared?.origin===request)prepared=null;
    return policy.settle?.(confirmedCopies.get(request)??request,outcome);
  };
  return approve;
}

// A shutdown that ends a manual approval does not decide it: the approval
// throws this code, records no evidence line, and the wallet signs nothing.
export const OPERATOR_CLOSING='operator_closing';
const closingError=()=>Object.assign(new Error('the operator is closing: this seller approval was not decided, nothing was signed, and the next start asks again'),{code:OPERATOR_CLOSING});

// signal (optional): an AbortSignal, or a function returning the one for an
// approval asked now. Once it aborts, a manual decision still waiting for its
// answer, and any later one, ends with OPERATOR_CLOSING: no decision is
// recorded, nothing is signed or sent, and a later answer is ignored.
export function createExactOperatorApproval({maxTotalOs,evidencePath,authorize,sellerApproval,policy,sellerNotice=()=>null,signal=null,now=()=>Date.now()}){
  if(!OS.test(maxTotalOs??'')||BigInt(maxTotalOs)<=0n)throw new TypeError('maxTotalOs must be a positive canonical OS string');
  if(signal!==null&&!(signal instanceof AbortSignal)&&typeof signal!=='function')throw new TypeError('seller approval signal must be an AbortSignal or a function returning one');
  const askSignal=()=>{const current=typeof signal==='function'?signal():signal;if(current!==null&&!(current instanceof AbortSignal))throw new TypeError('seller approval signal must be an AbortSignal');return current;};
  const STOPPED=Symbol('stopped');
  const unlessStopped=(answer,stopSignal)=>!stopSignal?answer:new Promise((resolve,reject)=>{
    const stop=()=>resolve(STOPPED);stopSignal.addEventListener('abort',stop,{once:true});
    Promise.resolve(answer).then(resolve,reject).finally(()=>stopSignal.removeEventListener('abort',stop));
  });
  const settings=sellerApprovalSettings(sellerApproval),policyMode=settings.mode==='policy';
  if(policyMode&&(!policy||typeof policy.resolvePurchase!=='function'||typeof policy.listingPin!=='function'||!policy.sourceBinding||!/^0x[0-9a-f]{64}$/.test(policy.address??'')||policy.seller!==`did:demos:agent:${policy.address.slice(2)}`))throw new TypeError('seller policy requires exact operator-owned purchase and source context');
  const reservations=new WeakMap();
  const preparations=new WeakMap(),path=resolve(evidencePath);
  const dropPreparation=(request)=>{
    const hold=preparations.get(request);if(!hold)return;
    const holds=provisionalHolds.get(path);holds.delete(hold);if(!holds.size)provisionalHolds.delete(path);
    preparations.delete(request);
  };
  const decide=async(input,validity,{preparing=false,manualApproved=false,provisional=null}={})=>{
    const confirmedTotal=validity===undefined?undefined:confirmedWriteOs(validity,input);
    const declaredTotal=input?.content?.debit?.totalOs;
    const declared=typeof declaredTotal==='string'&&OS.test(declaredTotal)?BigInt(declaredTotal):null;
    const countedTotal=confirmedTotal===undefined?declared:confirmedTotal===null||declared===null?null:confirmedTotal>declared?confirmedTotal:declared;
    const total=countedTotal?.toString();
    const withinBudget=input?.method==='sendTransaction'&&OS.test(total??'')&&BigInt(total)<=BigInt(maxTotalOs);
    if(!policyMode&&!withinBudget)return false;
    const requestBytes=JSON.stringify(input),request=policyMode?JSON.parse(requestBytes):input,approvalHash=sha(requestBytes),at=policyMode?now():null,reservationId=policyMode?randomUUID():null;
    const notice=policyMode?null:sellerNotice(request);
    let accepted=false,policyReason=null;
    if(policyMode){
      // Every policy decision, approved or refused, is retained below with the
      // exact request bytes, approval hash and reason (null when approved).
      try{policyReason=confirmedTotal===null?'debit':!withinBudget?'operator-fee-budget':await policyRefusal(request,policy,settings,{confirmedTotal,countedTotal,manualApproved});}catch{policyReason='policy-check-failed';}
      if(!policyReason){try{policyReason=await budgetRefusal({evidencePath,jobId:request.content.jobId,totalOs:total,at,limits:settings,manualApproved,
        provisional:provisional?.approvalHash===approvalHash&&BigInt(total)<=BigInt(provisional.totalOs)?provisional:null});}catch{policyReason='evidence-unreadable';}}
      accepted=policyReason===null;
    }else{
      const closeSignal=askSignal();
      if(closeSignal?.aborted)throw closingError();
      if(authorize){
        const answer=await unlessStopped(authorize(Object.freeze({approvalHash,request:structuredClone(request),...(notice?{notice}:{})})),closeSignal);
        if(answer===STOPPED)throw closingError();
        accepted=answer===true;
      }else{
        if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('exact seller approval requires an interactive TTY');
        // A stop declines the Listing's prompt, before it is shown or while it
        // waits: the wallet then refuses before signing, the anchor records the
        // intent as denied and releases its locks, and the next start asks again.
        // No decision is recorded; the owner made none. The operator's close
        // (signal above) still ends any prompt, a Listing's too, as operator_closing.
        const listing=request?.content?.artifactKind==='Listing';
        if(listing&&stopRequested())return false;
        if(notice)process.stderr.write(`${notice}\n`);
        process.stderr.write(`${JSON.stringify({approvalHash,request})}\n`);
        const signals=[...(listing?[stopSignal]:[]),...(closeSignal?[closeSignal]:[])];
        const ui=createInterface({input:process.stdin,output:process.stderr});if(!listing)ttyPrompts++;
        try{accepted=(await ui.question(`Type APPROVE ${approvalHash} to authorize this exact seller transaction: `,signals.length?{signal:signals.length===1?signals[0]:AbortSignal.any(signals)}:{}))===`APPROVE ${approvalHash}`;}
        catch(error){if(listing&&stopRequested())return false;if(!closeSignal?.aborted)throw error;throw closingError();}
        finally{if(!listing)ttyPrompts--;ui.close();}
      }
    }
    if(preparing&&accepted)return true;
    await mkdir(dirname(evidencePath),{recursive:true,mode:0o700});
    // From here to the answer nothing awaits: a purchase cancelled or expired
    // while the policy read the ledger is refused here, and the evidence line
    // records this final decision.
    if(policyMode&&accepted){try{policyReason=stillOpenBeforePayment(request,policy);}catch{policyReason='policy-check-failed';}accepted=policyReason===null;}
    appendFileSync(evidencePath,`${JSON.stringify({format:EVIDENCE_FORMAT,approvalHash,requestBytes,method:request?.method??null,address:request?.address??null,totalOs:total??null,decision:accepted?'approved':'rejected',
      ...(policyMode&&!manualApproved?{approvalMode:'policy',policyReason,reservationId}:{}),...(validity===undefined?{}:{confirmation:validity,declaredTotalOs:declaredTotal??null,confirmedRemovalsOs:confirmedTotal?.toString()??null,countedTotalOs:total??null,...(manualApproved?{manualApproved:true}:{})}),recordedAt:policyMode?at:now()})}\n`,{encoding:'utf8',mode:0o600});
    if(policyMode&&accepted&&!manualApproved)reservations.set(input,{reservationId,approvalHash});
    return accepted;
  };
  const approve=async(request,validity,options={})=>{
    try{
      if(!policyMode)return await decide(request);
      const snapshot=structuredClone(request);
      return await serializedPolicy(evidencePath,async()=>{
        if(options.preparing)dropPreparation(request);
        const accepted=await decide(snapshot,validity,{...options,provisional:preparations.get(request)});
        if(accepted&&options.preparing){
          const hold={decision:'approved',policy:true,outcome:null,jobId:snapshot.content.jobId,totalOs:snapshot.content.debit.totalOs,approvalHash:sha(JSON.stringify(snapshot))};
          if(!provisionalHolds.has(path))provisionalHolds.set(path,new Set());
          provisionalHolds.get(path).add(hold);preparations.set(request,hold);
        }else if(!options.preparing)dropPreparation(request);
        if(accepted&&reservations.has(snapshot))reservations.set(request,reservations.get(snapshot));
        return accepted;
      });
    }catch(error){
      if(process.env.DACS_TEST_TRACE==='1')process.stderr.write(`devnet-operator-approval-error:${error.code??'failed'}:${String(error.message).slice(0,200)}\n`);
      throw error;
    }
  };
  approve.prepare=(request)=>approve(request,undefined,{preparing:true});
  // Only the packaged wallet reports completion. Unknown outcomes have no
  // release proof and keep their reservation, including across restarts.
  approve.settle=async(request,outcome)=>{
    if(!['spent','released','unknown'].includes(outcome))throw new TypeError('seller attempt outcome must be spent, released or unknown');
    if(outcome==='unknown')return;
    return serializedPolicy(evidencePath,async()=>{
      if(outcome==='released')dropPreparation(request);
      const reservation=reservations.get(request);if(!reservation)return;
      const ledger=await readPolicyLedger(evidencePath),row=ledger.find(entry=>entry.reservationId===reservation.reservationId);
      if(!row||row.outcome!==null)throw new Error('seller policy reservation is unavailable');
      const recordedAt=now();
      if(!Number.isSafeInteger(recordedAt)||recordedAt<row.recordedAt)throw new Error('seller policy completion time is unavailable');
      appendFileSync(evidencePath,`${JSON.stringify({format:ATTEMPT_FORMAT,...reservation,outcome,recordedAt})}\n`,{encoding:'utf8',mode:0o600});
      reservations.delete(request);
    });
  };
  return approve;
}
