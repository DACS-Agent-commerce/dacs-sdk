import { compositeVerificationAddress, contentHash, finalityCommitmentAddress, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalize, isCanonicalJobId } from '@kynesyslabs/dacs';
import { acquireSellerStateLock } from './seller-state-lock.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');
const OS=/^(0|[1-9][0-9]*)$/,POSITIVE_OS=/^[1-9][0-9]*$/,HASH=/^[0-9a-f]{64}$/;
const EVIDENCE_FORMAT='dacs-node2-operator-approval-evidence/v1';
const ATTEMPT_FORMAT='dacs-node2-seller-policy-attempt/v1';
const SIGN_FORMAT='dacs-node2-seller-policy-sign-authorization/v1';
const CONTEXT_FORMAT='dacs-node2-seller-context-admission/v1';
export const SELLER_POLICY_MAX_WRITES=6;
export const SELLER_POLICY_WINDOW_MS=3_600_000;
// Policy-mode limits, all configurable. maxWriteTotalOs caps one write's
// complete debit; its unchanged 4 DEM default is L4's declared Node2 debit
// on 2026-10-07 (storage 1, SDK gas 1, network 1, RPC 1). Until measured live,
// count the larger of that request declaration and confirmed sender removals.
// The hourly limits are a budget across all jobs in a rolling hour: 24
// policy-approved writes and 96 DEM, about four complete six-write purchases
// at the 4 DEM cap. Outstanding attempts hold their full debit; completed
// attempts count for an hour after completion.
export const SELLER_POLICY_DEFAULTS=Object.freeze({maxWriteTotalOs:'4000000000',maxWritesPerHour:24,maxTotalOsPerHour:'96000000000'});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&canonicalize(Object.keys(value).sort())===canonicalize([...keys].sort());
// The seller kit has one purchase source. Reject stale app configuration.
export function sellerPurchaseSource(value){
  if(value!==undefined&&value!=='seller')throw new TypeError('sellerApproval.purchaseSource must be "seller"');
  return 'seller';
}
// With seller records, an otherwise approvable write before payment is held
// for exact manual approval: the seller has no record of the job before the
// proposal reaches it, and is never told of a buyer-side cancellation.
const HOLD_REASONS=new Set(['seller-record-missing','cancellation-unknown']);
// Validates the optional operator config field. Manual stays exactly
// {mode:'manual'}; policy may set its limits, each defaulting as above.
// purchaseSource is validated on its own and is not part of the settings.
export function sellerApprovalSettings(value){
  if(value===undefined)return Object.freeze({mode:'manual'});
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'purchaseSource')){const{purchaseSource,...rest}=value;sellerPurchaseSource(purchaseSource);value=rest;}
  if(!value||typeof value!=='object'||Array.isArray(value)||!['manual','policy'].includes(value.mode)||(value.mode==='manual'&&!exact(value,['mode'])))throw new TypeError('sellerApproval must name exact manual or policy mode');
  if(value.mode==='manual')return Object.freeze({mode:'manual'});
  if(Object.keys(value).some(key=>key!=='mode'&&!Object.hasOwn(SELLER_POLICY_DEFAULTS,key)))throw new TypeError('sellerApproval policy accepts only maxWriteTotalOs, maxWritesPerHour and maxTotalOsPerHour');
  const limits={...SELLER_POLICY_DEFAULTS,...value};
  if(typeof limits.maxWriteTotalOs!=='string'||!POSITIVE_OS.test(limits.maxWriteTotalOs))throw new TypeError('sellerApproval.maxWriteTotalOs must be a positive canonical OS string');
  if(!Number.isSafeInteger(limits.maxWritesPerHour)||limits.maxWritesPerHour<1||limits.maxWritesPerHour>1000)throw new TypeError('sellerApproval.maxWritesPerHour must be an integer from 1 to 1000');
  if(typeof limits.maxTotalOsPerHour!=='string'||!POSITIVE_OS.test(limits.maxTotalOsPerHour)||BigInt(limits.maxTotalOsPerHour)<BigInt(limits.maxWriteTotalOs))throw new TypeError('sellerApproval.maxTotalOsPerHour must be a positive canonical OS string of at least maxWriteTotalOs');
  return Object.freeze({mode:'policy',...limits});
}

// A held write is one attempt with one durable attemptId: its hold line (a
// refused policy line with a hold reason) opens it, and its manual line and
// its confirmation (a policy reservation with policyHold) carry the same id.
// Every attempt ends in one terminal row: released, with one of these
// reasons, for anything refused or released before issuance, or the outcome
// of its reservation. Lines without an attemptId keep the older counting.
// 'unconfirmed-at-restart' and 'unsent-at-restart' were written by earlier
// builds, whose restart released attempts; they still read.
const ATTEMPT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RELEASE_REASONS=new Set(['manual-declined','replaced','confirmation-mismatch','confirmation-refused','wallet-released','unconfirmed-at-restart','unsent-at-restart','sign-authorization-failed','operator-released']);

// Seller records: the ledger names the three issuance journals it is bound to
// in one header line, written by operator.mjs before any approval and never
// rewritten. Restart decides reservations from exactly those journals.
export const SELLER_LEDGER_HEADER_FORMAT='dacs-seller-approval-ledger-journals/v1';
// Every other line format of the ledger (operator.mjs repairs a torn header
// only where it cannot be the start of one of these).
export const SELLER_LEDGER_LINE_FORMATS=Object.freeze([EVIDENCE_FORMAT,ATTEMPT_FORMAT,SIGN_FORMAT,CONTEXT_FORMAT]);
export const SELLER_ISSUANCE_JOURNALS=Object.freeze(['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite']);
export const sellerIssuanceJournalIds=(value)=>exact(value,SELLER_ISSUANCE_JOURNALS)&&SELLER_ISSUANCE_JOURNALS.every(name=>/^[a-f0-9]{32}$/.test(value[name]??''));
// The reservations restart reconciliation looks up in the issuance journals:
// approved policy lines with a reservationId and no completion. It never
// releases them; it labels what stays held. Everything else it holds without
// them (open held attempts) or holds unlabelled (older approvals).
// operator.mjs binds an unbound ledger only when none exist.
export const decidedFromJournals=(row)=>row.policy&&row.decision==='approved'&&row.outcome===null&&typeof row.reservationId==='string';

// Seller records: a sign-authorized line is retained, and synced, before the
// policy lets the wallet sign. It opens
// the reservation with the exact request bytes it authorizes; the
// confirmation line carries the same reservationId, and only a completion
// line ends it.
// Reads decisions, held attempts and exact attempt completions for the policy
// limits. Lines written before request bytes
// were retained (older manual approvals) carry no requestBytes: they cannot be
// attributed to a job and were never policy decisions, so they count towards
// neither limit. Any other malformed line fails closed.
// Exported read-only for the operator health report, which must count the
// same ledger as admission.
export function parsePolicyLedger(text){
  const malformed=()=>{throw new Error('seller approval evidence is malformed');};
  const rows=[],byReservationId=new Map(),attempts=new Map();
  let header=null,lineNumber=0,seenEntry=false;
  // A line that fails keeps its error; ledgerLine (1-based) names that line.
  try{for(const line of text.split('\n')){
    lineNumber++;
    if(!line.trim())continue;
    const row=JSON.parse(line),first=!seenEntry;seenEntry=true;
    if(row?.format===SELLER_LEDGER_HEADER_FORMAT){
      if(header||!first||!exact(row,['format','journals','recordedAt'])||!sellerIssuanceJournalIds(row.journals)||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0)malformed();
      header=row;continue;
    }
    if(row?.format===SIGN_FORMAT){
      if(!exact(row,['format','reservationId','approvalHash','requestBytes','totalOs','recordedAt',...(Object.hasOwn(row,'attemptId')?['attemptId']:[])])
        ||!ATTEMPT_ID.test(row.reservationId??'')||byReservationId.has(row.reservationId)||typeof row.requestBytes!=='string'||sha(row.requestBytes)!==row.approvalHash
        ||(typeof row.totalOs!=='string'||!OS.test(row.totalOs))||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0)malformed();
      const request=JSON.parse(row.requestBytes);
      if(request?.content?.debit?.totalOs!==row.totalOs)malformed();
      // A held write is sign-authorized once, while its attempt is open.
      const attempt=Object.hasOwn(row,'attemptId')?attempts.get(row.attemptId):null;
      if(attempt===undefined||(attempt&&(attempt.outcome!==null||attempt.reservation||attempt.approvalHash!==row.approvalHash)))malformed();
      const entry={decision:'approved',policy:true,held:Boolean(attempt),signAuthorized:true,confirmed:null,jobId:request?.content?.jobId??null,artifactKind:request?.content?.artifactKind??null,totalOs:row.totalOs,recordedAt:row.recordedAt,
        reservationId:row.reservationId,approvalHash:row.approvalHash,outcome:null,attemptId:attempt?row.attemptId:null,request};
      rows.push(entry);byReservationId.set(row.reservationId,entry);
      if(attempt)attempt.reservation=entry;
      continue;
    }
    if(row?.format===CONTEXT_FORMAT){contextLedgerLine(row,rows,malformed);continue;}
    if(row?.format===ATTEMPT_FORMAT){
      if(!exact(row,['format','approvalHash','outcome','recordedAt',...['reservationId','attemptId','reason'].filter(key=>Object.hasOwn(row,key))])||!HASH.test(row.approvalHash??'')
        ||!['spent','released'].includes(row.outcome)||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0
        ||(Object.hasOwn(row,'reservationId')&&(typeof row.reservationId!=='string'||!row.reservationId))||(Object.hasOwn(row,'reason')&&(row.outcome!=='released'||!RELEASE_REASONS.has(row.reason))))malformed();
      const attempt=Object.hasOwn(row,'attemptId')?attempts.get(row.attemptId):null;
      if(attempt===undefined||(attempt&&(attempt.outcome!==null||attempt.approvalHash!==row.approvalHash)))malformed();
      if(Object.hasOwn(row,'reservationId')){
        const reservation=byReservationId.get(row.reservationId);
        if(!reservation?.policy||reservation.decision!=='approved'||reservation.approvalHash!==row.approvalHash||reservation.outcome!==null||row.recordedAt<reservation.recordedAt||reservation.attemptId!==(row.attemptId??null))malformed();
        reservation.outcome=row.outcome;reservation.completedAt=row.recordedAt;
      // An attempt with no confirmed reservation can only be released.
      }else if(!attempt||attempt.reservation||row.outcome!=='released'||!Object.hasOwn(row,'reason'))malformed();
      if(attempt){attempt.outcome=row.outcome;attempt.reason=row.reason??null;}
      continue;
    }
    if(!row||typeof row!=='object'||Array.isArray(row)||row.format!==EVIDENCE_FORMAT||!['approved','rejected'].includes(row.decision)||!HASH.test(row.approvalHash??''))malformed();
    if(!Object.hasOwn(row,'requestBytes')){if(Object.hasOwn(row,'approvalMode')||Object.hasOwn(row,'attemptId'))malformed();continue;}
    if(typeof row.requestBytes!=='string'||sha(row.requestBytes)!==row.approvalHash)malformed();
    const policyRow=Object.hasOwn(row,'approvalMode');
    if(policyRow&&(row.approvalMode!=='policy'||(row.decision==='approved'&&(!Number.isSafeInteger(row.recordedAt)||(typeof row.totalOs!=='string'||!OS.test(row.totalOs))))))malformed();
    // A confirmation of a sign-authorized reservation carries its reservationId.
    const authorized=Object.hasOwn(row,'reservationId')?byReservationId.get(row.reservationId):undefined;
    const linked=authorized?.signAuthorized===true&&authorized.confirmed===null&&authorized.outcome===null&&policyRow&&Boolean(row.confirmation)
      &&authorized.approvalHash===row.approvalHash&&authorized.attemptId===(row.attemptId??null);
    if(Object.hasOwn(row,'reservationId')&&(!policyRow||typeof row.reservationId!=='string'||!row.reservationId||(byReservationId.has(row.reservationId)&&!linked)))malformed();
    // A held write the operator approved, completed at confirmation as a policy reservation.
    if(Object.hasOwn(row,'policyHold')&&(!policyRow||!HOLD_REASONS.has(row.policyHold)||!row.confirmation))malformed();
    let attempt=null,opened=false;
    if(Object.hasOwn(row,'attemptId')){
      if(typeof row.attemptId!=='string'||!ATTEMPT_ID.test(row.attemptId)||Object.hasOwn(row,'manualApproved'))malformed();
      attempt=attempts.get(row.attemptId);
      if(policyRow&&!Object.hasOwn(row,'policyHold')){
        // The hold opens the attempt.
        if(attempt||row.decision!=='rejected'||!HOLD_REASONS.has(row.policyReason))malformed();
        attempt={approvalHash:row.approvalHash,jobId:null,manual:false,reservation:null,outcome:null,reason:null};attempts.set(row.attemptId,attempt);opened=true;
      }else if(!attempt||attempt.outcome!==null||attempt.approvalHash!==row.approvalHash||(attempt.reservation&&!(linked&&attempt.reservation===authorized)))malformed();
    }
    const request=JSON.parse(row.requestBytes),declared=request?.content?.debit?.totalOs;
    // An open attempt holds its declared debit (below).
    if(opened){
      if((typeof declared!=='string'||!OS.test(declared))||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0)malformed();
      Object.assign(attempt,{totalOs:declared,recordedAt:row.recordedAt,request,holdReason:row.policyReason});
    }
    // A manual confirmation annotates its existing approval, not a second write.
    if(Object.hasOwn(row,'manualApproved')){if(row.manualApproved!==true||policyRow||!row.confirmation)malformed();continue;}
    if(policyRow&&row.decision==='approved'&&(typeof declared!=='string'||!OS.test(declared)))malformed();
    const totalOs=policyRow&&row.decision==='approved'&&BigInt(declared)>BigInt(row.totalOs)?declared:row.totalOs;
    // The confirmation decides nothing about the hold: the reservation stays
    // one row, counted until its completion line, whatever the decision.
    if(linked){authorized.confirmed=row.decision;if(row.decision==='approved')authorized.totalOs=totalOs;continue;}
    const entry={decision:row.decision,policy:policyRow,held:Object.hasOwn(row,'policyHold'),jobId:request?.content?.jobId??null,artifactKind:request?.content?.artifactKind??null,totalOs,recordedAt:row.recordedAt,
      reservationId:row.decision==='approved'?row.reservationId:null,approvalHash:row.approvalHash,outcome:null,attemptId:attempt?row.attemptId:null,request};
    rows.push(entry);
    if(typeof entry.reservationId==='string')byReservationId.set(entry.reservationId,entry);
    if(attempt){
      attempt.jobId??=entry.jobId;
      if(!policyRow&&row.decision==='approved')attempt.manual=true;
      if(entry.held&&row.decision==='approved')attempt.reservation=entry;
    }
  }}catch(error){if(error&&typeof error==='object')error.ledgerLine??=lineNumber;throw error;}
  // An attempt without its completion line holds one write and its declared
  // debit against both limits, whether or not it reached sign authority: a
  // ledger restored from an older copy can lack its manual approval and sign
  // line. From its reservation (sign-authorized line, or an earlier build's
  // confirmation) on, that row holds it instead.
  for(const[attemptId,attempt]of attempts)if(attempt.outcome===null&&!attempt.reservation)
    rows.push({decision:'approved',policy:true,held:true,openAttempt:true,jobId:attempt.jobId,artifactKind:attempt.request?.content?.artifactKind??null,totalOs:attempt.totalOs,recordedAt:attempt.recordedAt,reservationId:null,approvalHash:attempt.approvalHash,outcome:null,attemptId,request:attempt.request});
  return{rows,attempts,header};
}

// Context route reservations (createSellerContextAdmission) in the ledger: a
// hold line opens one, a release line ends it (a repeated release changes
// nothing), a refusal line is the decision log only. A hold enters the rows
// as {contextHold, jobId, writes, totalOs, recordedAt, released};
// contextHoldRows turns it into outstanding writes.
function contextLedgerLine(row,rows,malformed){
  if(row.event==='refused'){
    if(!exact(row,['format','event','jobId','buyer','reason','recordedAt'])||typeof row.reason!=='string'||!Number.isSafeInteger(row.recordedAt))malformed();
    return;
  }
  if(row.event==='hold'){
    if(!exact(row,['format','event','holdId','jobId','effect','writes','totalOs','recordedAt'])||typeof row.holdId!=='string'||!row.holdId||rows.some(entry=>entry.contextHold===row.holdId)
      ||!isCanonicalJobId(row.jobId)||!HASH.test(row.effect??'')||!Number.isSafeInteger(row.writes)||row.writes<1||row.writes>SELLER_POLICY_MAX_WRITES||(typeof row.totalOs!=='string'||!POSITIVE_OS.test(row.totalOs))
      ||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0)malformed();
    rows.push({contextHold:row.holdId,jobId:row.jobId,effect:row.effect,writes:row.writes,totalOs:row.totalOs,recordedAt:row.recordedAt,released:false});
    return;
  }
  const hold=rows.find(entry=>entry.contextHold===row.holdId);
  if(row.event!=='release'||!exact(row,['format','event','holdId','jobId','recordedAt'])||!hold||hold.jobId!==row.jobId||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0||row.recordedAt<hold.recordedAt)malformed();
  hold.released=true;
}

// Each open context hold counts its unconverted writes as outstanding policy
// reservations at the write fee cap it was taken with. A policy-approved Vet
// write of that job made since the hold (or prepared now) converts one;
// `converting` is the write being decided, which takes one of its job's held
// writes instead of adding a new one.
function contextHoldRows(ledger,converting=null){
  const vet=(row,jobId)=>row.decision==='approved'&&row.policy&&row.outcome!=='released'&&row.jobId===jobId&&row.artifactKind==='CompositeVerificationRecord';
  let taken=converting?.artifactKind!=='CompositeVerificationRecord';
  const rows=[],converted=new Set();
  for(const hold of ledger.filter(row=>row.contextHold&&!row.released)){
    let remaining=hold.writes;
    // One write consumes one slot across all holds, including holds retained
    // across a shutdown and a replacement reservation for the same job.
    // Projected attempts lost their original append position during parsing,
    // so equal timestamps cannot establish that they followed this hold.
    for(const row of ledger){
      if(remaining>0&&!converted.has(row)&&vet(row,hold.jobId)&&(row.recordedAt===undefined||row.recordedAt>hold.recordedAt||(row.recordedAt===hold.recordedAt&&!row.openAttempt&&ledger.indexOf(row)>ledger.indexOf(hold)))){
        remaining--;converted.add(row);
      }
    }
    if(!taken&&converting.jobId===hold.jobId&&remaining>0){remaining-=1;taken=true;}
    for(let index=0;index<remaining;index++)rows.push({decision:'approved',policy:true,outcome:null,jobId:hold.jobId,totalOs:hold.totalOs,contextSlot:hold.contextHold});
  }
  return rows;
}
// The rows the policy limits count: `ledger` (parsed, with any preparations)
// plus each open context hold's unconverted writes. budgetRefusal, context
// admission and the operator health report all count these, so they cannot
// drift. Exported read-only for the health report.
export function withContextHolds(ledger,converting=null){
  return [...ledger,...contextHoldRows(ledger,converting)];
}

// The policy approvals both hourly limits hold at `at`: an approval without a
// completion stays held (parsePolicyLedger lists an open held attempt as
// one), a spent one for an hour after completion, a released one not at all.
// Exported read-only for the operator health report.
export function heldPolicyBudget(ledger,at){
  const held=ledger.filter(row=>row.policy&&row.decision==='approved'&&row.outcome!=='released'&&(row.outcome===null||row.completedAt>at-SELLER_POLICY_WINDOW_MS));
  return {writes:held.length,totalOs:held.reduce((sum,row)=>sum+BigInt(row.totalOs),0n)};
}
// Preparations hold budget in this process's memory before their approved
// row exists. Another process (such as the health CLI) always sees none.
// A held preparation's hold line is already on the ledger, which counts its
// attempt: pass the parsed attempts so that it is not counted twice.
export function provisionalPolicyHolds(evidencePath,attempts=new Map()){
  return [...(provisionalHolds.get(resolve(evidencePath))??[])].filter(hold=>!attempts.has(hold.attemptId)).map(hold=>({...hold}));
}

async function budgetRefusal({evidencePath,jobId,artifactKind=null,totalOs,at,limits,manualApproved=false,provisional=null,ledgerHeld=false,writes=1,snapshot=null}){
  // A manual confirmation completes a write the operator already approved exactly.
  if(manualApproved)return null;
  // Seller records: a matching sign-authorized reservation already holds both
  // limits on the ledger, so its confirmation does not read the ledger again.
  if(provisional&&ledgerHeld)return null;
  const{rows:ledger,attempts}=snapshot??await readPolicyLedger(evidencePath);
  // A matching preparation already holds both limits. The fee rule forbids
  // confirmation from increasing its declared ceiling; convert it once.
  if(provisional)return null;
  ledger.push(...provisionalPolicyHolds(evidencePath,attempts));
  // A released attempt counts towards neither limit.
  const live=withContextHolds(ledger,{jobId,artifactKind}).filter(row=>row.decision==='approved'&&row.outcome!=='released'&&attempts.get(row.attemptId)?.outcome!=='released');
  // An attempt (its hold, manual line and reservation) is one write for the
  // job. Older lines: a held reservation and the manual line for the same
  // bytes are one write.
  const manualLines=new Set(live.filter(row=>!row.policy&&!row.attemptId).map(row=>row.approvalHash));
  const jobRows=live.filter(row=>row.jobId===jobId&&!(row.held&&!row.attemptId&&manualLines.has(row.approvalHash)));
  if(jobRows.filter(row=>!row.attemptId).length+new Set(jobRows.map(row=>row.attemptId).filter(Boolean)).size+writes>SELLER_POLICY_MAX_WRITES)return 'job-write-limit';
  // Old approvals lack completion proof and remain held, as do unknown outcomes.
  const recent=heldPolicyBudget(live,at);
  if(recent.writes+writes>limits.maxWritesPerHour)return 'hourly-write-limit';
  if(recent.totalOs+BigInt(totalOs)>BigInt(limits.maxTotalOsPerHour))return 'hourly-dem-limit';
  return null;
}

// Combines the two approval paths for the seller wallet. Listing writes are
// always manual. A policy refusal is final for that artifact (the wallet
// journals it as denied), so refusing a write after payment would strand a
// purchase the buyer has already paid for: payment evidence, delivery evidence
// and the Deliverable go to exact manual approval instead before signing.
// A pre-payment write the policy held (seller records) goes there too. Its
// budget reservation is kept across the manual gate: confirmation completes
// it as the policy's own reservation, and a decline releases it. The manual
// line carries the hold's attemptId, so the two are one attempt.
// A refused fee at confirmation never goes to a manual override.
export function composeSellerApproval({mode,policy,manual}){
  let prepared=null;
  // The policy holds the same copy through preparation and confirmation;
  // settle maps the wallet's request back to that copy.
  const confirmedCopies=new WeakMap(),atManualGate=new WeakSet();
  const approve=async(request)=>{
    const previous=prepared;prepared=null;
    if(previous?.policy||previous?.held)await policy.settle?.(previous.request,'released','replaced');
    const kind=request?.content?.artifactKind;
    if(mode!=='policy'||kind==='Listing')return manual(request);
    const deferred=typeof policy.prepare==='function';
    const copy=deferred?structuredClone(request):request;
    if((await (deferred?policy.prepare(copy):policy(request)))===true){
      if(deferred){prepared={request:copy,policy:true,origin:request};confirmedCopies.set(request,copy);}
      return true;
    }
    const held=policy.heldForManual?.(copy)===true;
    if(!AFTER_PAYMENT.has(kind)&&!held)return false;
    let accepted=false;
    const attemptId=held?policy.heldAttempt?.(copy)??null:null;
    if(held)atManualGate.add(request);
    try{accepted=(await (attemptId?manual(request,undefined,{attemptId}):manual(request)))===true;}
    finally{atManualGate.delete(request);if(held&&deferred&&!accepted)await policy.settle?.(copy,'released','manual-declined');}
    if(!accepted)return false;
    // Seller records: the approved held write is sign-authorized on the ledger
    // before this answer lets the wallet sign it. If that line cannot be
    // retained, nothing was signed and the attempt ends released. The write is
    // not refused (before payment a refusal is final for its artifact): after
    // a pause it is decided again from the start, as a new hold for a new
    // exact manual approval.
    if(deferred&&held&&typeof policy.authorizeSign==='function'&&(await policy.authorizeSign(copy))!==true){
      try{await policy.settle?.(copy,'released','sign-authorization-failed');}
      catch(error){process.stderr.write(`seller-policy-sign-authorization: the attempt ${attemptId} could not be ended released (${String(error?.code??error?.message).slice(0,120)}); it stays held and counted\n`);}
      process.stderr.write(`seller-policy-sign-authorization failed: the ${kind} write for job ${copy?.content?.jobId} was not signed and is not refused; it is decided again, as a new hold for exact manual approval\n`);
      await policy.pause?.();
      return approve(request);
    }
    if(deferred&&held){prepared={request:copy,held:true,origin:request};confirmedCopies.set(request,copy);}
    else if(deferred)prepared={request:structuredClone(request),policy:false};
    return true;
  };
  // True while this exact request is at manual approval because the policy held it.
  approve.heldForManual=(request)=>atManualGate.has(request);
  // The operator serializes this seller wallet. Consume one prepared decision
  // at confirmation; a failed/repeated confirmation cannot reuse it.
  approve.confirm=async(validity)=>{
    const current=prepared;prepared=null;
    if(!current)return false;
    const c=validity?.response?.data?.transaction?.content,r=current.request.content;
    if(c?.from!==r.wallet||c.nonce!==r.nonce||c.timestamp!==r.timestamp||JSON.stringify(c.data?.[1])!==r.exactCreate){
      if(current.policy||current.held)await policy.settle?.(current.request,'released','confirmation-mismatch');
      return false;
    }
    return policy(current.request,validity,current.held?{held:true}:{manualApproved:!current.policy});
  };
  approve.settle=(request,outcome)=>{
    if(outcome==='released'&&prepared?.origin===request)prepared=null;
    return policy.settle?.(confirmedCopies.get(request)??request,outcome);
  };
  return approve;
}

// Seller records: how long a write before payment waits between reads of an
// approval ledger that cannot be read (createExactOperatorApproval).
export const SELLER_LEDGER_RETRY_MS=5_000;
const LEDGER_STOPPED='seller policy stopped while its approval ledger could not be read; nothing was decided, written or signed';
const APPROVAL_STOPPED='seller approval stopped (operator close): this write is not approved, and nothing more is written for it';
const stoppedError=(message)=>Object.assign(new Error(message),{code:'seller_approval_stopped'});

// A shutdown that ends a manual approval does not decide it: the approval
// throws this code, records no evidence line, and the wallet signs nothing.
export const OPERATOR_CLOSING='operator_closing';
const closingError=()=>Object.assign(new Error('the operator is closing: this seller approval was not decided, nothing was signed, and the next start asks again'),{code:OPERATOR_CLOSING});

// Seller records: the operator's explicit release of one held attempt, named
// by its attemptId, with the operator stopped (operator.mjs takes the state
// lock), after a chain readback shows that its write can never be included
// (docs, "Resolving a held reservation by hand"). Refused, with nothing
// written, for an unknown attemptId, an attempt that already has its
// completion line, or a ledger that cannot be read. Otherwise it appends one
// synced completion line, released ('operator-released'): for the attempt,
// or for its reservation once it reached sign authority. Returns what it
// released.
export function releaseHeldSellerAttempt({evidencePath,attemptId,now=Date.now}){
  if(typeof attemptId!=='string'||!ATTEMPT_ID.test(attemptId))return Promise.reject(new TypeError('a held seller attempt is named by its exact attemptId'));
  return serializedPolicy(evidencePath,async()=>{
    let text='';
    try{text=await readFile(evidencePath,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    const{rows,attempts}=parsePolicyLedger(text),attempt=attempts.get(attemptId);
    if(!attempt)throw new Error(`seller policy attempt ${attemptId} is not on the approval ledger; nothing was released`);
    if(attempt.outcome!==null)throw new Error(`seller policy attempt ${attemptId} already ended ${attempt.outcome}; nothing was released`);
    const reservation=attempt.reservation,recordedAt=now();
    if(!Number.isSafeInteger(recordedAt)||recordedAt<(reservation?.recordedAt??0))throw new Error('seller policy release time is unavailable; nothing was released');
    // Never glued onto a last line written by hand without its newline.
    const line=`${text.endsWith('\n')?'':'\n'}${JSON.stringify({format:ATTEMPT_FORMAT,...(reservation?{reservationId:reservation.reservationId}:{}),approvalHash:attempt.approvalHash,attemptId,outcome:'released',reason:'operator-released',recordedAt})}\n`;
    const handle=openSync(evidencePath,'a',0o600);
    try{
      const bytes=Buffer.from(line,'utf8');
      for(let done=0;done<bytes.length;){const written=writeSync(handle,bytes,done,bytes.length-done);if(!(written>0))throw new Error('seller policy release was not written');done+=written;}
      fsyncSync(handle);
    }finally{closeSync(handle);}
    const hold=rows.find(row=>row.attemptId===attemptId);
    return{attemptId,reservationId:reservation?.reservationId??null,approvalHash:attempt.approvalHash,jobId:hold?.jobId??null,artifactKind:hold?.request?.content?.artifactKind??null,
      state:reservation?'sign-authorized':attempt.manual?'approved-sign-unknown':'approval-unknown',reason:'operator-released',recordedAt};
  });
}

// Admission for the seller context route (
// seller-context-route.mjs), on the same evidence file as the approvals.
// reserve: in policy mode, under the policy lock, all of the step's writes at
// the write fee cap must fit the job and hourly limits together with every
// outstanding reservation; then one durable hold line reserves them, tied to
// the context effect. The per-write policy converts it write by write
// (contextHoldRows), so the second Vet write is never refused for a budget the
// first one used. Manual mode reserves nothing: each write is approved by hand.
// release: ends what is unused of a hold once the step has ended, definite or
// uncertain (all of the job's open holds when holdId is absent). A step a
// shutdown cut runs again only under a new hold for the writes still to make
// (seller-context-route.mjs resume); every write it made keeps its own policy row.
// Refusals add no decision-log line. A hold line's
// Exact retries bind holdId to job, effect, write count and fee cap.
// Conflicting/released reuse refuses without appending; unreadable ledgers
// throw seller_context_ledger_unreadable with the underlying cause.
// Concurrent ledger transactions throw seller_state_locked. A new hold must
// strictly follow unfinished Vet attempts for its job (hold-time-order).
export function createSellerContextAdmission({evidencePath,sellerApproval,now=()=>Date.now()}){
  const settings=sellerApprovalSettings(sellerApproval),policyMode=settings.mode==='policy';
  const append=(line)=>appendContextLine(evidencePath,line);
  return Object.freeze({
    reserve:({jobId,effect,writes,hold})=>!policyMode?Promise.resolve(null):serializedPolicy(evidencePath,async()=>{
      if(!isCanonicalJobId(jobId)||typeof effect!=='string'||!HASH.test(effect)||!Number.isSafeInteger(writes)||writes<1||writes>SELLER_POLICY_MAX_WRITES||typeof hold!=='string'||!hold)return 'request-shape';
      let snapshot;
      try{snapshot=await readPolicyLedger(evidencePath);}
      catch(cause){throw Object.assign(new Error('seller context approval ledger cannot be read',{cause}),{code:'seller_context_ledger_unreadable'});}
      const retained=snapshot.rows.find(row=>row.contextHold===hold);
      if(retained){
        if(retained.jobId!==jobId||retained.effect!==effect||retained.writes!==writes||retained.totalOs!==settings.maxWriteTotalOs)return 'hold-conflict';
        if(retained.released)return 'hold-released';
        syncContextLedger(evidencePath);return null;
      }
      const at=now();
      if(!Number.isSafeInteger(at)||at<0)throw new RangeError('context hold time must be a nonnegative safe integer');
      // Earlier Vet reservations must not convert this newer hold when the
      // clock moves backward, including sign-authorized and spent writes.
      if(snapshot.rows.some(row=>row.policy&&row.decision==='approved'&&row.outcome!=='released'&&row.jobId===jobId&&row.artifactKind==='CompositeVerificationRecord'&&row.recordedAt>=at))return 'hold-time-order';
      const refusal=await budgetRefusal({evidencePath,jobId,totalOs:BigInt(settings.maxWriteTotalOs)*BigInt(writes),at,limits:settings,writes,snapshot});
      if(refusal)return refusal;
      await append({event:'hold',holdId:hold,jobId,effect,writes,totalOs:settings.maxWriteTotalOs,recordedAt:at});
      return null;
    }),
    release:({jobId,hold})=>!policyMode?Promise.resolve():releaseSellerContextHolds({evidencePath,jobId,holdId:hold,now}).then(()=>{}),
  });
}

// Sync both a retained append and its publication directory. Parent creation
// is one leaf only; its existing parent's entry is synchronized as well.
function syncContextLedger(evidencePath){
  for(const path of [evidencePath,dirname(resolve(evidencePath)),dirname(dirname(resolve(evidencePath)))]){
    const handle=openSync(path,'r');try{fsyncSync(handle);}finally{closeSync(handle);}
  }
}
const appendContextLine=async(evidencePath,line)=>{
  await mkdir(dirname(evidencePath),{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  let text='';try{text=await readFile(evidencePath,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const bytes=Buffer.from(`${text.length&&!text.endsWith('\n')?'\n':''}${JSON.stringify({format:CONTEXT_FORMAT,...line})}\n`);
  const handle=openSync(evidencePath,'a',0o600);
  try{
    for(let done=0;done<bytes.length;){const written=writeSync(handle,bytes,done,bytes.length-done);if(!(written>0))throw new Error('context line was not written');done+=written;}
    fsyncSync(handle);
  }finally{closeSync(handle);}
  syncContextLedger(evidencePath);
};

// Ends a job's open context holds (only holdId when given) with one release
// line each, under the policy lock, and returns the released hold ids. The
// route calls it when a step ends; scripts/release-seller-context-hold.mjs is
// the operator's path for a hold a crash left open. A ledger it cannot read is
// refused before anything is written.
export function releaseSellerContextHolds({evidencePath,jobId,holdId,now=()=>Date.now()}){
  return serializedPolicy(evidencePath,async()=>{
    const at=now(),released=[];
    const rows=(await readPolicyLedger(evidencePath)).rows;
    const openHolds=rows.filter(row=>row.contextHold&&!row.released&&row.jobId===jobId&&(holdId===undefined||row.contextHold===holdId));
    if(!Number.isSafeInteger(at)||at<0||openHolds.some(row=>at<row.recordedAt))throw new RangeError('context release cannot predate its hold');
    if(!openHolds.length&&rows.some(row=>row.contextHold&&row.jobId===jobId))syncContextLedger(evidencePath);
    for(const open of openHolds){
      await appendContextLine(evidencePath,{event:'release',holdId:open.contextHold,jobId,recordedAt:at});
      released.push(open.contextHold);
    }
    return released;
  });
}

// The logical address an artifact of this kind must use for its job.
function expectedLogicalAddress(c,artifact,policy){
  if(c.artifactKind==='CompositeVerificationRecord')return compositeVerificationAddress(c.jobId,artifact.evaluatedParty);
  if(c.artifactKind==='FinalityCommitmentRecord')return finalityCommitmentAddress(c.jobId);
  if(c.artifactKind==='Deliverable')return `dacs4:deliverable:${c.jobId}`;
  if(artifact.phase==='pay-dem'){
    // The host reads this index from protocolSupport(its verified Listing).
    // Missing phase context cannot authorize an automatic payment-evidence write.
    const index=typeof policy.paymentPhaseIndex==='function'?policy.paymentPhaseIndex():null;
    return Number.isSafeInteger(index)&&!Object.is(index,-0)&&index>=0?paymentEvidenceAddress(c.jobId,'demos-native:DEM',index):null;
  }
  return artifact.phase==='deliver-storage-program'?`dacs4:evidence:${c.jobId}`:null;
}

/** Validate an exact seller request; return null or its retained refusal reason.
 * Rejects malformed JSON and propagates purchase resolver errors. */
export async function policyRefusal(request,policy,limits,{confirmedTotal,countedTotal,manualApproved=false,held=null}={}){
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
  const sellerRecords=true,purchase=await policy.resolvePurchase(c.jobId);
  // No seller record of the job yet (vet records): every check that needs no
  // purchase still refuses, as with the app, before the write is held.
  if(sellerRecords&&purchase===null&&BEFORE_PAYMENT.has(c.artifactKind)){
    if(c.artifactKind==='CompositeVerificationRecord'&&!CLAIM.test(artifact.evaluatedParty??''))return 'evaluated-party';
    if(c.logicalAddress!==expectedLogicalAddress(c,artifact,policy))return 'logical-address';
    const pin=policy.listingPin();
    if([artifact.listingPin,artifact.listing,artifact.listingRef].some(value=>value&&!same(value,pin)))return 'listing';
    return 'seller-record-missing';
  }
  // A vet record held with no record may reach confirmation once the proposal
  // draft has reached the seller but before it retained the buyer's signed
  // Agreement CREATE. That record has no binding to compare yet; everything
  // else it holds is still checked, as is the request's own binding above.
  const unbound=sellerRecords&&held!==null&&c.artifactKind==='CompositeVerificationRecord'&&purchase?.sourceBinding===null;
  if(!exact(purchase,['jobId','seller','buyer','listingPin','sourceBinding','agreementHash','amountOs','paymentObserved','prePaymentOpen'])||purchase.jobId!==c.jobId||purchase.seller!==policy.seller
    ||!CLAIM.test(purchase.buyer??'')||typeof purchase.paymentObserved!=='boolean'||(purchase.prePaymentOpen!==null&&typeof purchase.prePaymentOpen!=='boolean')||!POSITIVE_OS.test(purchase.amountOs??'')
    ||!same(purchase.listingPin,policy.listingPin())||!(unbound||(sellerRecords?sameNetwork(purchase.sourceBinding,policy.sourceBinding):same(purchase.sourceBinding,policy.sourceBinding))))return 'purchase';
  if(AFTER_PAYMENT.has(c.artifactKind)&&!purchase.paymentObserved)return 'payment-not-observed';
  if(BEFORE_PAYMENT.has(c.artifactKind)&&purchase.paymentObserved)return 'payment-already-observed';
  // A cancelled, expired or otherwise ended purchase gets no more seller writes before payment.
  if(BEFORE_PAYMENT.has(c.artifactKind)&&purchase.prePaymentOpen===false)return 'purchase-closed';
  if(c.artifactKind==='SettlementEvidence'&&artifact.phase==='pay-dem'&&(!exact(artifact.paymentAmount,['amount','currency'])||artifact.paymentAmount.currency!=='DEM'
    ||demOs(artifact.paymentAmount.amount)!==BigInt(purchase.amountOs)))return 'payment-amount';
  if(c.artifactKind==='CompositeVerificationRecord'&&artifact.evaluatedParty!==purchase.buyer&&artifact.evaluatedParty!==policy.seller)return 'evaluated-party';
  if(c.logicalAddress!==expectedLogicalAddress(c,artifact,policy))return 'logical-address';
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
  if(sellerRecords&&BEFORE_PAYMENT.has(c.artifactKind))return 'cancellation-unknown';
  return null;
}


/** Return exact confirmed sender removals in OS, or null for an invalid confirmation. */
// Node 61b8e75 applies storage/gas balance removals for CREATEs; its
// additional transaction_fee distribution is native-only. Numbers are legacy
// whole DEM, canonical strings are OS. Never round or coerce fee values.
export function confirmedWriteOs(validity,request){
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


async function readPolicyLedger(evidencePath){
  let text='';
  try{text=await readFile(evidencePath,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  return parsePolicyLedger(text);
}

function serializedPolicy(evidencePath,work){
  const key=resolve(evidencePath),result=(policyTails.get(key)??Promise.resolve()).then(async()=>{
    // Reuse the process lock separately from the operator's lifetime lock.
    // Every ledger writer shares it, including releases and exact retries.
    await mkdir(dirname(key),{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const directory=`${key}.policy-lock`;
    await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const lock=await acquireSellerStateLock(directory);
    try{return await work();}finally{lock.release();}
  }),tail=result.catch(()=>{});
  policyTails.set(key,tail);
  void tail.then(()=>{if(policyTails.get(key)===tail)policyTails.delete(key);});
  return result;
}

const policyTails=new Map();

const provisionalHolds=new Map();

const KINDS=new Set(['CompositeVerificationRecord','FinalityCommitmentRecord','SettlementEvidence','Deliverable']);

const BEFORE_PAYMENT=new Set(['CompositeVerificationRecord','FinalityCommitmentRecord']);

const AFTER_PAYMENT=new Set(['SettlementEvidence','Deliverable']);

const CLAIM=/^did:demos:agent:[0-9a-f]{64}$/;

const same=(a,b)=>canonicalize(a)===canonicalize(b);

const demOs=(value)=>typeof value==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value)?BigInt(value.split('.')[0])*1_000_000_000n+BigInt((value.split('.')[1]??'').padEnd(9,'0')):null;

// Seller records compare the network and the chain identity only. The seller's
// Agreement reader (demos-sr2-adapter.mjs) still requires the full transport
// binding, so today a seller record always carries the seller's own endpoint.
const sameNetwork=(a,b)=>typeof a?.network==='string'&&typeof a.chainIdentity==='string'&&a.network===b.network&&a.chainIdentity===b.chainIdentity;

/** Await fresh purchase authority; return null for an open request or a refusal reason.
 * Resolver errors propagate; callers must append synchronously after this resolves. */
export async function stillOpenBeforePayment(request,policy,held){
  if(!BEFORE_PAYMENT.has(request.content.artifactKind))return null;
  const purchase=await policy.resolvePurchase(request.content.jobId);
  if(sellerPurchaseSource(policy.purchaseSource)==='seller'&&held&&purchase===null)return null;
  return purchase?.jobId===request.content.jobId&&(purchase.prePaymentOpen===true||(held&&purchase.prePaymentOpen===null))&&purchase.paymentObserved===false?null:'purchase-closed';
}
