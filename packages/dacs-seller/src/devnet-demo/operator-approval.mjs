import { appendApprovalLedgerLine, syncApprovalLedger as syncContextLedger } from './approval-ledger-append.mjs';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { truncateSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stopRequested, stopSignal } from './stop-request.mjs';
import { admitRawJson, canonicalDemosAgentPublicKey, canonicalize, compositeVerificationAddress, contentHash, finalityCommitmentAddress, isCanonicalJobId, isCompositeVerificationRecord, isFinalityCommitmentRecord, isSettlementEvidence, paymentEvidenceAddress, sameCanonicalClaimIdentity } from '@kynesyslabs/dacs';
import { acquireSellerStateLock } from './seller-state-lock.mjs';
import { isPaymentTxRef } from './seller-purchase-source.mjs';
import { isDevnetPurchasedReport } from './deliverable.mjs';
import { buildStorageProgramCreatePayload } from '../dacs/wallet-transactions.mjs';
import { DEVNET_DEMO_ARTIFACT_KIND, DEVNET_DEMO_ARTIFACT_POLICY } from '../dacs/devnet-source.mjs';

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
// The closed manual table: the only policy reasons exact manual approval may
// waive, by when the write happens. Before payment, the seller-records holds;
// after payment, a write the buyer paid for that only a limit refuses. Every
// other reason is final, and an error is never a reason.
const MANUAL_REASONS=Object.freeze({before:HOLD_REASONS,after:new Set(['write-fee-cap','job-write-limit','hourly-write-limit','hourly-dem-limit'])});
const HELD_REASONS=new Set([...MANUAL_REASONS.before,...MANUAL_REASONS.after]);
const paymentPhase=(kind)=>BEFORE_PAYMENT.has(kind)?'before':'after';
const manualReason=(kind,reason)=>MANUAL_REASONS[paymentPhase(kind)].has(reason);
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
        reservationId:row.reservationId,approvalHash:row.approvalHash,outcome:null,attemptId:attempt?row.attemptId:null,request,originLine:attempt?attempt.originLine:lineNumber};
      rows.push(entry);byReservationId.set(row.reservationId,entry);
      if(attempt)attempt.reservation=entry;
      continue;
    }
    if(row?.format===CONTEXT_FORMAT){contextLedgerLine(row,rows,malformed,lineNumber);continue;}
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
    if(Object.hasOwn(row,'policyHold')&&(!policyRow||!HELD_REASONS.has(row.policyHold)||!row.confirmation))malformed();
    let attempt=null,opened=false;
    if(Object.hasOwn(row,'attemptId')){
      if(typeof row.attemptId!=='string'||!ATTEMPT_ID.test(row.attemptId)||Object.hasOwn(row,'manualApproved'))malformed();
      attempt=attempts.get(row.attemptId);
      if(policyRow&&!Object.hasOwn(row,'policyHold')){
        // The hold opens the attempt.
        if(attempt||row.decision!=='rejected'||!HELD_REASONS.has(row.policyReason))malformed();
        attempt={approvalHash:row.approvalHash,jobId:null,manual:false,reservation:null,outcome:null,reason:null,originLine:lineNumber};attempts.set(row.attemptId,attempt);opened=true;
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
      reservationId:row.decision==='approved'?row.reservationId:null,approvalHash:row.approvalHash,outcome:null,attemptId:attempt?row.attemptId:null,request,originLine:attempt?attempt.originLine:lineNumber};
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
  // originLine: the ledger line a row's write started on. Every row of a held
  // attempt keeps its opening line; any other row has its own.
  for(const[attemptId,attempt]of attempts)if(attempt.outcome===null&&!attempt.reservation)
    rows.push({decision:'approved',policy:true,held:true,openAttempt:true,jobId:attempt.jobId,artifactKind:attempt.request?.content?.artifactKind??null,totalOs:attempt.totalOs,recordedAt:attempt.recordedAt,reservationId:null,approvalHash:attempt.approvalHash,outcome:null,attemptId,request:attempt.request,originLine:attempt.originLine});
  return{rows,attempts,header};
}

// Context route reservations (createSellerContextAdmission) in the ledger: a
// hold line opens one, a release line ends it (a repeated release changes
// nothing), a refusal line is the decision log only. A hold enters the rows
// as {contextHold, jobId, effect, writes, totalOs, recordedAt, released,
// originLine}; contextHoldRows turns it into outstanding writes.
function contextLedgerLine(row,rows,malformed,lineNumber){
  if(row.event==='refused'){
    if(!exact(row,['format','event','jobId','buyer','reason','recordedAt'])||typeof row.reason!=='string'||!Number.isSafeInteger(row.recordedAt))malformed();
    return;
  }
  if(row.event==='hold'){
    if(!exact(row,['format','event','holdId','jobId','effect','writes','totalOs','recordedAt'])||typeof row.holdId!=='string'||!row.holdId||rows.some(entry=>entry.contextHold===row.holdId)
      ||!isCanonicalJobId(row.jobId)||!HASH.test(row.effect??'')||!Number.isSafeInteger(row.writes)||row.writes<1||row.writes>SELLER_POLICY_MAX_WRITES||(typeof row.totalOs!=='string'||!POSITIVE_OS.test(row.totalOs))
      ||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0)malformed();
    rows.push({contextHold:row.holdId,jobId:row.jobId,effect:row.effect,writes:row.writes,totalOs:row.totalOs,recordedAt:row.recordedAt,released:false,originLine:lineNumber});
    return;
  }
  const hold=rows.find(entry=>entry.contextHold===row.holdId);
  if(row.event!=='release'||!exact(row,['format','event','holdId','jobId','recordedAt'])||!hold||hold.jobId!==row.jobId||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0||row.recordedAt<hold.recordedAt)malformed();
  hold.released=true;
}

// Each open context hold counts its unconverted writes as outstanding policy
// reservations at the write fee cap it was taken with. A policy-approved Vet
// write of that job converts one only if its write started on a later ledger
// line than the hold (originLine): every ledger line is appended under the
// policy lock, so line order is the order admission saw, and approving,
// signing or completing an attempt never moves it. Clocks play no part. A row
// without an originLine converts nothing. `converting` is the write being
// decided, which has no line yet: it takes one of its job's held writes
// instead of adding a new one.
function contextHoldRows(ledger,converting=null){
  const vet=(row,jobId)=>row.decision==='approved'&&row.policy&&row.outcome!=='released'&&row.jobId===jobId&&row.artifactKind==='CompositeVerificationRecord';
  let taken=converting?.artifactKind!=='CompositeVerificationRecord';
  const rows=[],converted=new Set();
  for(const hold of ledger.filter(row=>row.contextHold&&!row.released)){
    let remaining=hold.writes;
    // One write consumes one slot across all holds, in ledger order, including
    // holds retained across a shutdown and a replacement hold for the same job.
    for(const row of ledger){
      if(remaining>0&&!converted.has(row)&&vet(row,hold.jobId)&&row.originLine>hold.originLine){remaining--;converted.add(row);}
    }
    if(!taken&&converting.jobId===hold.jobId&&remaining>0){remaining-=1;taken=true;}
    for(let index=0;index<remaining;index++)rows.push({decision:'approved',policy:true,outcome:null,jobId:hold.jobId,totalOs:hold.totalOs,contextSlot:hold.contextHold});
  }
  return rows;
}
// The rows the policy limits count: `ledger` (parsed) plus each open context
// hold's unconverted writes. budgetRefusal, context admission and the operator
// health report all count these, so they cannot drift. Exported read-only for
// the health report.
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

// Whether `writes` more writes of jobId, `totalOs` in total, fit the limits on
// a parsed ledger snapshot: null when they do, else the limit they exceed
// ('job-write-limit', 'hourly-write-limit' or 'hourly-dem-limit').
function budgetRefusal({jobId,totalOs,at,limits,writes,snapshot,converting=null}){
  const{rows:ledger,attempts}=snapshot;
  // A released attempt counts towards neither limit.
  const live=withContextHolds(ledger,converting).filter(row=>row.decision==='approved'&&row.outcome!=='released'&&attempts.get(row.attemptId)?.outcome!=='released');
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

/** Combine exact manual approval with the seller policy for one seller wallet; returns the wallet's approve(request),
 * with confirm(validity) and settle(request, outcome). Listing writes and manual mode always ask manual. In policy
 * mode the policy decides (policy.decide): an approved write is already sign-authorized; a held write is asked of
 * manual only when its (phase, reason) is in the closed manual table, and the answer goes to the policy's sign gate
 * (policy.authorizeHeld); every other refusal is final. Policy errors reject; a manual answer or sign gate that
 * throws first releases the held attempt (policy.releaseHeld). confirm checks the one policy-approved write in flight
 * at the policy's confirmation gate, and is false for any other approval. */
export function composeSellerApproval({mode,policy,manual}){
  let prepared=null;
  const approve=async(request)=>{
    const previous=prepared;prepared=null;
    if(previous)await policy.settle(previous,'released','replaced');
    const kind=request?.content?.artifactKind,requestBytes=JSON.stringify(request);
    if(mode!=='policy'||kind==='Listing'){
      if((await manual(JSON.parse(requestBytes)))!==true||JSON.stringify(request)!==requestBytes)return false;
      freezeRequest(request);return true;
    }
    const decision=await policy.decide(request);
    let answer=decision.outcome==='approved'?'signed':'refused';
    if(decision.outcome==='held'&&manualReason(kind,decision.reason)){
      // A shutdown or error that ends the manual answer or its sign gate decides nothing: the attempt is released
      // and the error kept.
      try{answer=await policy.authorizeHeld(request,(await manual(JSON.parse(requestBytes),undefined,{attemptId:decision.attemptId}))===true);}
      catch(error){
        await policy.releaseHeld(request,[OPERATOR_CLOSING,'seller_approval_stopped'].includes(error?.code)?'operator-released':'sign-authorization-failed').catch(()=>{});
        throw error;
      }
    }
    // The sign line could not be retained: nothing was signed and the attempt is released, so the write is
    // decided again after a pause (before payment a refusal would be final for its artifact).
    if(answer==='unsigned'){
      process.stderr.write(`seller-policy-sign-authorization failed: the ${kind} write for job ${request.content.jobId} was not signed; it is decided again\n`);
      await policy.pause();return approve(request);
    }
    if(answer==='signed')prepared=request;
    return answer==='signed';
  };
  approve.confirm=async(validity)=>{const current=prepared;prepared=null;return current?policy(current,validity):false;};
  approve.settle=(request,outcome)=>{if(outcome==='released'&&prepared===request)prepared=null;return policy.settle(request,outcome);};
  return approve;
}

// How long a policy decision waits between reads of an approval ledger that cannot be read.
const SELLER_LEDGER_RETRY_MS=5_000;
const LEDGER_STOPPED='seller policy stopped while its approval ledger could not be read; nothing was decided, written or signed';
const APPROVAL_STOPPED='seller approval stopped (operator close): this write is not approved, and nothing more is written for it';
const stoppedError=(message)=>Object.assign(new Error(message),{code:'seller_approval_stopped'});

// A shutdown that ends a manual approval does not decide it: the approval
// throws this code, records no evidence line, and the wallet signs nothing.
export const OPERATOR_CLOSING='operator_closing';
const closingError=()=>Object.assign(new Error('the operator is closing: this seller approval was not decided, nothing was signed, and the next start asks again'),{code:OPERATOR_CLOSING});

/** Create exact manual approval, or bounded seller policy approval with durable attempts and sign reservations.
 * Manual mode: approve(request, undefined, {attemptId}) asks authorize (or the TTY) and records the answer.
 * Policy mode: decide(request) resolves {outcome:'approved'|'held'|'refused', reason, attemptId}, and rejects with
 * code seller_approval_pending while the same request's held attempt waits for its manual answer; prepare(request)
 * resolves its approval as a boolean and opens no attempt (a hold is logged as a refusal); authorizeHeld(request,
 * accepted) ends a held attempt at the sign gate ('signed', 'refused', or 'unsigned' when its sign line could not be
 * retained); releaseHeld ends it unanswered, also after stop(); approve(request, validity) is the confirmation gate;
 * settle(request, outcome) completes a reservation; reconcile() labels unresolved ones; stop() ends waits and
 * pending manual answers. A manual answer for a held attempt is recorded only while that attempt is open and unsigned
 * in its ledger, for the same bytes; otherwise it is false and writes nothing. Purchase resolver and policy input
 * errors reject with nothing decided or written; an unreadable ledger is waited for until stop(). */
export function createExactOperatorApproval({maxTotalOs,evidencePath,authorize,sellerApproval,policy,sellerNotice=()=>null,signal=null,now=()=>Date.now(),ledgerRetryMs=SELLER_LEDGER_RETRY_MS}){
  if(!OS.test(maxTotalOs??'')||BigInt(maxTotalOs)<=0n)throw new TypeError('maxTotalOs must be a positive canonical OS string');
  if(signal!==null&&!(signal instanceof AbortSignal)&&typeof signal!=='function')throw new TypeError('seller approval signal must be an AbortSignal or a function returning one');
  const askSignal=()=>{const current=typeof signal==='function'?signal():signal;if(current!==null&&!(current instanceof AbortSignal))throw new TypeError('seller approval signal must be an AbortSignal');return current;};
  const settings=sellerApprovalSettings(sellerApproval),policyMode=settings.mode==='policy';
  if(policyMode&&(!policy||typeof policy.resolvePurchase!=='function'||typeof policy.listingPin!=='function'||!policy.sourceBinding||!/^0x[0-9a-f]{64}$/.test(policy.address??'')||policy.seller!==`did:demos:agent:${policy.address.slice(2)}`))throw new TypeError('seller policy requires exact operator-owned purchase and source context');
  if(policyMode)sellerPurchaseSource(policy.purchaseSource);
  // One record per request object: its exact bytes, its held attempt (attemptId and hold reason) and its open
  // sign reservation. open: the attempt and reservation ids this process still owns (reconcile skips them).
  const records=new WeakMap(),open=new Set();
  const STOPPED=Symbol('stopped');
  let stopped=false,idle=null;const pauses=new Set(),flights=new Set(),halt=new AbortController();
  const live=()=>{if(stopped)throw stoppedError(APPROVAL_STOPPED);};
  const fly=(flight)=>{
    const forget=()=>{flights.delete(flight);};
    flights.add(flight);flight.then(forget,forget);
    return flight;
  };
  const track=(work)=>stopped?Promise.reject(stoppedError(APPROVAL_STOPPED)):fly(work());
  const locked=(work)=>track(()=>serializedPolicy(evidencePath,async()=>{live();return work();}));
  const pause=()=>new Promise((done,fail)=>{
    if(stopped)return fail(stoppedError(LEDGER_STOPPED));
    const entry={fail,timer:setTimeout(()=>{pauses.delete(entry);done();},ledgerRetryMs)};pauses.add(entry);
  });
  // An unreadable ledger holds the write, unsigned and not refused, until a fresh decision is possible.
  const readableLedger=async(request)=>{
    for(let waited=0;;waited++){
      live();
      try{const snapshot=await readPolicyLedger(evidencePath);live();return snapshot;}
      catch(error){
        if(stopped)throw stoppedError(LEDGER_STOPPED);
        if(waited%Math.max(1,Math.ceil(60_000/ledgerRetryMs))===0)process.stderr.write(`seller-policy-ledger unreadable: ${resolve(evidencePath)}${Number.isSafeInteger(error?.ledgerLine)?` line ${error.ledgerLine}`:''} (${String(error?.code??error?.message).slice(0,120)}); the ${request?.content?.artifactKind} write for job ${request?.content?.jobId} waits, unsigned and not refused, and is decided again once the ledger reads\n`);
        await pause();
      }
    }
  };
  const declaredOs=(request)=>{const total=request?.content?.debit?.totalOs;return typeof total==='string'&&OS.test(total)?BigInt(total):null;};
  // Every check before a sign line, on one ledger snapshot read under the policy lock: the operator maximum, the
  // policy (its fee cap at the declared total), no open sign authority for this wallet nonce, then the fee cap and
  // the limits. waiver: the manually approved class of a held attempt ('before': the holds, 'after': the cap and
  // limits). Resolves null when the write may be signed, else a reason; a manual-table reason only when nothing
  // else refuses.
  const signRefusal=async(copy,snapshot,waiver=null)=>{
    const c=copy?.content,total=declaredOs(copy);
    if(total!==null&&total>BigInt(maxTotalOs))return 'operator-fee-budget';
    const reason=await policyRefusal(copy,policy,total===null?settings:{...settings,maxWriteTotalOs:total.toString()},{held:waiver==='before'});
    live();
    if(reason&&!HOLD_REASONS.has(reason))return reason;
    if(snapshot.rows.some(row=>row.signAuthorized&&row.outcome===null&&row.request?.content?.wallet===c.wallet&&row.request.content.nonce===c.nonce))return 'sign-authorization-open';
    if(waiver==='after')return null;
    return (total>BigInt(settings.maxWriteTotalOs)?'write-fee-cap':budgetRefusal({jobId:c.jobId,totalOs:total,at:clock(),limits:settings,writes:1,snapshot,converting:c}))??reason;
  };
  // Policy ledger lines need a nonnegative integer time; a clock without one decides nothing.
  const clock=()=>{const at=now();if(!Number.isSafeInteger(at)||at<0)throw new RangeError('seller policy time must be a nonnegative safe integer');return at;};
  // The end of the sign gate: purchase authority reread after the last ledger await, and the request still the
  // exact bytes checked. Resolves null when the write may be signed, else the refusal.
  const reread=async(request,record)=>{
    const reason=await stillAuthorizedToSign(JSON.parse(record.bytes),policy,HOLD_REASONS.has(record.reason));
    live();
    return reason??(JSON.stringify(request)===record.bytes?null:'request-changed');
  };
  // The only writer of sign lines: the exact bytes frozen, then one synchronous, synced sign line. When the line
  // cannot be retained it rejects, after releasing whichever of its reservation or attempt is open.
  const appendSign=async(request,record)=>{
    freezeRequest(request);
    const ids={reservationId:randomUUID(),approvalHash:sha(record.bytes),...(record.attemptId?{attemptId:record.attemptId}:{})};
    try{appendApprovalLedgerLine(evidencePath,{format:SIGN_FORMAT,...ids,requestBytes:record.bytes,totalOs:JSON.parse(record.bytes).content.debit.totalOs,recordedAt:clock()});}
    catch(error){
      records.delete(request);open.delete(record.attemptId);
      try{
        const{rows,attempts}=await readPolicyLedger(evidencePath),line=rows.some(row=>row.reservationId===ids.reservationId&&row.outcome===null);
        if(line||attempts.get(record.attemptId)?.outcome===null)appendAttempt({...(line?ids:{attemptId:ids.attemptId,approvalHash:ids.approvalHash}),outcome:'released',reason:'sign-authorization-failed',recordedAt:clock()});
      }catch{/* the attempt stays open and counted; a retry or restart sees it */}
      throw error;
    }
    record.reservation=ids;open.add(ids.reservationId);records.set(request,record);
  };
  const appendAttempt=(row)=>appendApprovalLedgerLine(evidencePath,{format:ATTEMPT_FORMAT,...row});
  // Whether a held attempt is still open with no sign line, for these exact bytes: the only state a line for it
  // (its release or manual answer) may be appended to.
  const heldOpen=(snapshot,attemptId,approvalHash)=>{const attempt=snapshot.attempts.get(attemptId);return attempt?.outcome===null&&!attempt.reservation&&attempt.approvalHash===approvalHash;};
  // Ends a held attempt unanswered: the record is forgotten, and the release appended only if the ledger
  // (snapshot, or a fresh read) still has the attempt open and unsigned.
  const endAttempt=async(request,record,reason,snapshot=null)=>{
    open.delete(record.attemptId);records.delete(request);
    if(heldOpen(snapshot??await readPolicyLedger(evidencePath),record.attemptId,sha(record.bytes)))
      appendAttempt({attemptId:record.attemptId,approvalHash:sha(record.bytes),outcome:'released',reason,recordedAt:clock()});
  };
  const pendingError=()=>Object.assign(new Error('this seller write is already held for its manual answer; nothing more is decided for it until that answer ends'),{code:'seller_approval_pending'});
  // decide: the policy's answer for one exact write. A refusal and a hold are logged; only a hold in the manual
  // table opens an attempt (unless attempt is false), which counts its declared debit until it ends.
  const decide=(request,{attempt=true}={})=>locked(async()=>{
    const previous=records.get(request);
    if(previous?.attemptId&&!previous.reservation)throw pendingError();
    const bytes=JSON.stringify(request),copy=JSON.parse(bytes),snapshot=await readableLedger(copy);
    const record={bytes,attemptId:null,reason:null,reservation:null};
    const reason=await signRefusal(copy,snapshot)??await reread(request,record);
    if(reason===null){await appendSign(request,record);return{outcome:'approved'};}
    const attemptId=attempt&&manualReason(copy?.content?.artifactKind,reason)?randomUUID():null;
    appendApprovalLedgerLine(evidencePath,{format:EVIDENCE_FORMAT,approvalHash:sha(bytes),requestBytes:bytes,method:copy?.method??null,address:copy?.address??null,totalOs:declaredOs(copy)?.toString()??null,
      decision:'rejected',approvalMode:'policy',policyReason:reason,...(attemptId?{attemptId}:{}),recordedAt:clock()});
    if(attemptId){records.set(request,{...record,attemptId,reason});open.add(attemptId);}
    return{outcome:attemptId?'held':'refused',reason,attemptId};
  });
  // The sign gate for a held attempt's manual answer: only its recorded class is waived; every other check runs
  // again (the attempt's own hold no longer counts against its limits).
  const authorizeHeld=(request,accepted)=>locked(async()=>{
    const record=records.get(request);
    if(!record?.attemptId||record.reservation)return 'refused';
    if(accepted!==true){await endAttempt(request,record,'manual-declined');return 'refused';}
    const snapshot=await readableLedger(request),attempt=snapshot.attempts.get(record.attemptId);
    if(attempt?.outcome!==null||attempt.reservation){records.delete(request);open.delete(record.attemptId);return 'refused';}
    snapshot.rows=snapshot.rows.filter(row=>row.attemptId!==record.attemptId);
    const copy=JSON.parse(record.bytes),reason=await signRefusal(copy,snapshot,paymentPhase(copy.content.artifactKind))??await reread(request,record);
    if(reason){await endAttempt(request,record,'confirmation-refused',snapshot);return 'refused';}
    try{await appendSign(request,record);}catch(error){if(stopped)throw error;return 'unsigned';}
    return 'signed';
  });
  // The confirmation gate: the node's executed CREATE of exactly this request within the operator maximum, its own
  // open sign line, and purchase authority reread before the confirmation line. A refusal releases the reservation.
  const confirm=(request,validity)=>locked(async()=>{
    const record=records.get(request),ids=record?.reservation;
    if(!ids)return false;
    const copy=JSON.parse(record.bytes),declared=declaredOs(copy),confirmed=confirmedWriteOs(validity,copy),counted=confirmed!==null&&confirmed>declared?confirmed:declared;
    const row=await openSignLine(record);
    if(row.confirmed!==null)return false;
    const reason=confirmed===null?'confirmation-mismatch':counted>BigInt(maxTotalOs)?'operator-fee-budget':await stillAuthorizedToSign(copy,policy,HOLD_REASONS.has(record.reason));
    live();
    if(reason){completeReservation(request,record,row,'released',reason==='confirmation-mismatch'?reason:'confirmation-refused');return false;}
    // Retained: the executed transaction confirmedWriteOs checked member by member, not the rest of the node's answer.
    const tx=validity.response.data.transaction;
    appendApprovalLedgerLine(evidencePath,{format:EVIDENCE_FORMAT,approvalHash:ids.approvalHash,requestBytes:record.bytes,method:copy.method,address:copy.address,totalOs:counted.toString(),decision:'approved',approvalMode:'policy',policyReason:null,
      reservationId:ids.reservationId,...(record.attemptId?{attemptId:record.attemptId,policyHold:record.reason}:{}),confirmation:{hash:tx.hash??null,content:tx.content},declaredTotalOs:declared.toString(),
      confirmedRemovalsOs:confirmed.toString(),countedTotalOs:counted.toString(),recordedAt:clock()});
    return true;
  });
  // The record's sign line, still open, from a fresh ledger read (an unreadable ledger rejects).
  const openSignLine=async(record)=>{
    const row=(await readPolicyLedger(evidencePath)).rows.find(entry=>entry.signAuthorized&&entry.reservationId===record.reservation.reservationId);
    live();
    if(row?.outcome!==null)throw new Error('seller policy reservation is unavailable');
    return row;
  };
  const completeReservation=(request,record,row,outcome,reason)=>{
    const at=clock();
    if(at<row.recordedAt)throw new RangeError('seller policy completion cannot predate its sign authorization');
    appendAttempt({...record.reservation,outcome,...(outcome==='released'?{reason:RELEASE_REASONS.has(reason)?reason:'wallet-released'}:{}),recordedAt:at});
    open.delete(record.reservation.reservationId);open.delete(record.attemptId);records.delete(request);
  };
  // Exact manual approval of one request: the operator's answer, recorded with the exact bytes it approved.
  const decideManually=async(request,attemptId)=>{
    const declared=declaredOs(request);
    if(request?.method!=='sendTransaction'||declared===null||declared>BigInt(maxTotalOs))return false;
    const requestBytes=JSON.stringify(request),copy=JSON.parse(requestBytes),approvalHash=sha(requestBytes),notice=sellerNotice(copy);
    const closeSignal=AbortSignal.any([askSignal()??halt.signal,halt.signal]);
    if(closeSignal.aborted)throw closingError();
    let accepted;
    if(authorize){
      const answer=await new Promise((done,fail)=>{
        const stop=()=>done(STOPPED);closeSignal.addEventListener('abort',stop,{once:true});
        Promise.resolve(authorize(Object.freeze({approvalHash,request:copy,...(notice?{notice}:{})}))).then(done,fail).finally(()=>closeSignal.removeEventListener('abort',stop));
      });
      if(answer===STOPPED||closeSignal.aborted)throw closingError();
      accepted=answer===true;
    }else{
      if(!process.stdin.isTTY||!process.stderr.isTTY)throw new Error('exact seller approval requires an interactive TTY');
      const listing=copy.content?.artifactKind==='Listing';
      if(listing&&stopRequested())return false;
      if(notice)process.stderr.write(`${notice}\n`);
      process.stderr.write(`${JSON.stringify({approvalHash,request:copy})}\n`);
      const ui=createInterface({input:process.stdin,output:process.stderr});
      try{accepted=(await ui.question(`Type APPROVE ${approvalHash} to authorize this exact seller transaction: `,{signal:listing?AbortSignal.any([stopSignal,closeSignal]):closeSignal}))===`APPROVE ${approvalHash}`;}
      catch(error){if(listing&&stopRequested())return false;if(!closeSignal.aborted)throw error;throw closingError();}
      finally{ui.close();}
    }
    live();
    if(closeSignal.aborted)throw closingError();
    accepted&&=JSON.stringify(request)===requestBytes;
    const record=()=>{
      if(accepted)freezeRequest(request);
      appendApprovalLedgerLine(evidencePath,{format:EVIDENCE_FORMAT,approvalHash,requestBytes,method:copy.method,address:copy.address??null,totalOs:declared.toString(),decision:accepted?'approved':'rejected',...(attemptId?{attemptId}:{}),recordedAt:now()});
      return accepted;
    };
    // A held attempt's answer is recorded only while this ledger still has that attempt open and unsigned for
    // these bytes; an attempt that has ended (or another ledger's) gets no line and no approval.
    return attemptId?serializedPolicy(evidencePath,async()=>heldOpen(await readPolicyLedger(evidencePath),attemptId,approvalHash)&&record()):record();
  };
  const approve=(request,validity,options={})=>{
    if(!policyMode)return track(()=>decideManually(request,typeof options?.attemptId==='string'&&ATTEMPT_ID.test(options.attemptId)?options.attemptId:null));
    return validity===undefined?approve.prepare(request):confirm(request,validity);
  };
  approve.decide=decide;
  approve.prepare=async(request)=>(await decide(request,{attempt:false})).outcome==='approved';
  approve.authorizeHeld=authorizeHeld;
  // Not refused after stop(): a shutdown that ends a manual answer still releases its attempt.
  approve.releaseHeld=(request,reason)=>fly(serializedPolicy(evidencePath,async()=>{const record=records.get(request);if(record?.attemptId&&!record.reservation)await endAttempt(request,record,reason);}));
  approve.pause=pause;
  approve.stop=()=>{
    stopped=true;halt.abort();for(const entry of pauses){clearTimeout(entry.timer);entry.fail(stoppedError(LEDGER_STOPPED));}pauses.clear();
    return idle??=(async()=>{while(flights.size)await Promise.allSettled([...flights]);})();
  };
  approve.settle=async(request,outcome,reason='wallet-released')=>{
    if(!['spent','released','unknown'].includes(outcome))throw new TypeError('seller attempt outcome must be spent, released or unknown');
    if(outcome==='unknown')return;
    return locked(async()=>{
      const record=records.get(request);
      if(record?.reservation)completeReservation(request,record,await openSignLine(record),outcome,reason);
      else if(record?.attemptId&&outcome==='released')await endAttempt(request,record,RELEASE_REASONS.has(reason)?reason:'wallet-released');
    });
  };
  // Restart only labels unresolved attempts; it never resends or releases them.
  approve.reconcile=()=>locked(async()=>{
    if(!policyMode)return{released:[],held:[]};
    const{rows,attempts}=await readPolicyLedger(evidencePath),held=[];
    const describe=(row,extra)=>({jobId:row?.jobId??null,artifactKind:row?.request?.content?.artifactKind??null,...extra});
    for(const[attemptId,attempt]of attempts){
      if(attempt.outcome!==null||attempt.reservation||open.has(attemptId))continue;
      held.push(describe(rows.find(row=>row.attemptId===attemptId),{attemptId,reservationId:null,approvalHash:attempt.approvalHash,state:attempt.manual?'approved-sign-unknown':'approval-unknown'}));
    }
    for(const row of rows){
      if(row.openAttempt||!row.policy||row.decision!=='approved'||row.outcome!==null||open.has(row.reservationId))continue;
      const ids={attemptId:row.attemptId,reservationId:row.reservationId??null,approvalHash:row.approvalHash};
      if(!decidedFromJournals(row)){held.push(describe(row,{...ids,state:'no-completion-record'}));continue;}
      let issuance='unknown';
      try{if(typeof policy.issuance==='function')issuance=await policy.issuance(structuredClone(row.request),Object.freeze({reservationId:row.reservationId,approvalHash:row.approvalHash}));}catch{issuance='unknown';}
      held.push(describe(row,{...ids,state:issuance==='issued'?'issued-outcome-unknown':'issuance-unknown'}));
    }
    return{released:[],held};
  });
  return approve;
}

// Freeze the wallet-facing request so its retained bytes survive later asynchronous work.
function freezeRequest(value){
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))freezeRequest(child);
    Object.freeze(value);
  }
}

// Admission of a context step's Vet writes to the policy budgets, on the same
// evidence file as the approvals. No production code calls it yet.
// reserve: in policy mode, under the policy lock, all of the step's writes at
// the write fee cap must fit the job and hourly limits together with every
// outstanding reservation; then one synced hold line reserves them, tied to
// the context effect. Each Vet write that starts on a later ledger line
// converts one held write (contextHoldRows), so the step's second write is
// never refused for a budget its first one used, and a write that started
// before the hold never uses the hold's capacity. Manual mode reserves
// nothing: each write is approved by hand. Resolves null once reserved, or
// the refusal: 'request-shape', 'hold-conflict' (the holdId is bound to
// another job, effect, write count or fee cap), 'hold-released', or a limit
// (budgetRefusal). Refusals append nothing; an exact retry syncs the retained
// line and resolves null. Reserve and release first cut a context line a crash
// tore (cutTornContextLine). Rejects with seller_context_ledger_unreadable, with
// its cause, for a ledger it cannot read, and a RangeError for an invalid clock.
// release: ends what is unused of the step's hold (all of the job's open holds
// when hold is absent) once the step has ended, definite or uncertain
// (releaseSellerContextHolds). A step a shutdown cut runs again only under a
// new hold for the writes still to make. Both reject with seller_state_locked
// while another process holds the ledger.
export function createSellerContextAdmission({evidencePath,sellerApproval,now=()=>Date.now()}){
  const settings=sellerApprovalSettings(sellerApproval),policyMode=settings.mode==='policy';
  const append=(line)=>appendContextLine(evidencePath,line);
  return Object.freeze({
    reserve:({jobId,effect,writes,hold})=>!policyMode?Promise.resolve(null):serializedPolicy(evidencePath,async()=>{
      if(!isCanonicalJobId(jobId)||typeof effect!=='string'||!HASH.test(effect)||!Number.isSafeInteger(writes)||writes<1||writes>SELLER_POLICY_MAX_WRITES||typeof hold!=='string'||!hold)return 'request-shape';
      await cutTornContextLine(evidencePath);
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
      const refusal=budgetRefusal({jobId,totalOs:BigInt(settings.maxWriteTotalOs)*BigInt(writes),at,limits:settings,writes,snapshot});
      if(refusal)return refusal;
      await append({event:'hold',holdId:hold,jobId,effect,writes,totalOs:settings.maxWriteTotalOs,recordedAt:at});
      return null;
    }),
    release:({jobId,hold})=>!policyMode?Promise.resolve():releaseSellerContextHolds({evidencePath,jobId,holdId:hold,now}).then(()=>{}),
  });
}

const appendContextLine=(evidencePath,line)=>appendApprovalLedgerLine(evidencePath,{format:CONTEXT_FORMAT,...line});
// A crash in appendContextLine can leave its line torn: the ledger's last
// line, unterminated, not complete JSON, and starting as a context line does.
// That append never returned, so it reserved or released nothing; under the
// policy lock it is cut (by bytes) and synced, and the retry appends it whole.
// Any other unterminated or malformed line is left for the parser to refuse.
const TORN_CONTEXT_PREFIX=Buffer.from(`{"format":${JSON.stringify(CONTEXT_FORMAT)},`);
async function cutTornContextLine(evidencePath){
  let bytes;
  try{bytes=await readFile(evidencePath);}catch(error){if(error.code==='ENOENT')return;throw error;}
  const start=bytes.lastIndexOf(0x0a)+1,tail=bytes.subarray(start);
  if(!tail.subarray(0,TORN_CONTEXT_PREFIX.length).equals(TORN_CONTEXT_PREFIX))return;
  try{JSON.parse(tail.toString('utf8'));return;}catch{/* torn: cut below */}
  truncateSync(evidencePath,start);
  syncContextLedger(evidencePath);
}

// Ends a job's open context holds (only holdId when given) with one synced
// release line each, under the policy lock, and resolves the released hold
// ids. A ledger it cannot read, or a clock before a hold it would end, is
// refused before anything is written. With nothing open it syncs the job's
// retained lines and resolves [].
export function releaseSellerContextHolds({evidencePath,jobId,holdId,now=()=>Date.now()}){
  return serializedPolicy(evidencePath,async()=>{
    const at=now(),released=[];
    await cutTornContextLine(evidencePath);
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

// The closed table of seller writes, keyed by artifact kind (SettlementEvidence
// also by phase). Each row names the request kind; the artifact's exact
// members and their authorities without a purchase (artifact: the seller signs
// or produces it) and against the purchase (bound: null or a refusal reason);
// and its logical address. BEFORE_PAYMENT and AFTER_PAYMENT say when the write
// may happen. CREATE metadata adds artifactBinding for the demo request kind
// and deliveryBinding for a Deliverable (expectedCreate). Party members carry
// the Agreement's own claim spellings (p.buyer, p.seller), as the addresses
// and records derived from them do; the seller signs with policy.seller.
const SETTLEMENT_EVIDENCE_KIND='devnet-settlement-evidence-storage-create';
const WRITE_KINDS=new Map([
  ['CompositeVerificationRecord',{kind:DEVNET_DEMO_ARTIFACT_KIND,
    artifact:(a,c,policy)=>isCompositeVerificationRecord(a)&&a.signature.signer===policy.seller,
    bound:(a,p)=>[p.buyer,p.seller].includes(a.evaluatedParty)?null:'evaluated-party',
    address:(c,a)=>compositeVerificationAddress(c.jobId,a.evaluatedParty)}],
  ['FinalityCommitmentRecord',{kind:DEVNET_DEMO_ARTIFACT_KIND,
    artifact:(a,c,policy)=>isFinalityCommitmentRecord(a)&&a.pattern==='fixed-price'&&a.signature.signer===policy.seller,
    bound:(a,p)=>!same(a.listingRef,p.listingPin)?'listing':a.agreementHash!==p.agreementHash?'agreement':same([...a.parties].sort(),[p.buyer,p.seller].sort())?null:'parties',
    address:c=>finalityCommitmentAddress(c.jobId)}],
  ['Deliverable',{kind:DEVNET_DEMO_ARTIFACT_KIND,
    artifact:(a,c,policy)=>isDevnetPurchasedReport(a,{producer:policy.seller}),
    bound:(a,p,c,policy)=>!same(a.listing,p.listingPin)?'listing':a.agreementHash!==p.agreementHash?'agreement':deliveryBindingRefusal(c,p,policy),
    address:c=>`dacs4:deliverable:${c.jobId}`}],
  ['SettlementEvidence:pay-dem',{kind:SETTLEMENT_EVIDENCE_KIND,
    artifact:(a,c,policy)=>exact(a,PAYMENT_EVIDENCE_KEYS)&&isSettlementEvidence(a)&&a.outcome==='success'&&a.paymentTxRefs.length===1&&exact(a.paymentTxRefs[0],['kind','txHash','blockNumber'])&&a.paymentTxRefs[0].kind==='demos'
      &&a.settlementFinality.model==='bft-final'&&a.settlementFinality.finalityObservedAt===a.observedAt&&a.signature.signer===policy.seller,
    bound:(a,p)=>!same(a.paymentAmount,{amount:demString(BigInt(p.amountOs)),currency:'DEM'})?'payment-amount':same(a.paymentTxRefs[0],p.paymentTxRef)?null:'payment-tx',
    address:(c,a,policy)=>{const index=listingPhaseIndex(policy.paymentPhaseIndex);return index===null?null:paymentEvidenceAddress(c.jobId,'demos-native:DEM',index);}}],
  ['SettlementEvidence:deliver-storage-program',{kind:DEVNET_DEMO_ARTIFACT_KIND,
    artifact:(a,c,policy)=>exact(a,DELIVERY_EVIDENCE_KEYS)&&isSettlementEvidence(a)&&a.outcome==='success'&&HASH.test(a.dacsSdkAuditSourceHash)&&HASH.test(a.deliverableContentHash)
      &&same(a.deliverableAnchor,{kind:'storage-program',locator:`dacs4:deliverable:${c.jobId}`})&&a.signature.signer===policy.seller,
    bound:(a,p,c,policy)=>deliveredHash(policy,c.jobId)===a.deliverableContentHash?null:'deliverable',
    address:c=>`dacs4:evidence:${c.jobId}`}],
]);

// The payload hash of the seller's verified, retained Deliverable for the job
// (the hash delivery evidence commits to), read like listingPin; null when the
// host supplies none, so no delivery evidence is approved without it.
function deliveredHash(policy,jobId){
  const hash=typeof policy.deliveredPayloadHash==='function'?policy.deliveredPayloadHash(jobId):null;
  return typeof hash==='string'&&HASH.test(hash)?hash:null;
}
const writeKind=(c,artifact)=>WRITE_KINDS.get(c.artifactKind==='SettlementEvidence'?`SettlementEvidence:${artifact.phase}`:c.artifactKind)??null;

// A Deliverable's delivery binding: its purchase, the verified Listing's
// delivery phase and its payload. Only fulfilmentId is the seller's own.
function deliveryBindingRefusal(c,p,policy){
  const binding=c.deliveryBinding,phaseIndex=listingPhaseIndex(policy.deliveryPhaseIndex);
  return phaseIndex!==null&&typeof binding?.fulfilmentId==='string'&&binding.fulfilmentId.length>0&&binding.fulfilmentId.length<=128
    &&same(binding,{version:'1',profile:DELIVERY_PROFILE,jobId:c.jobId,phase:'deliver-storage-program',phaseIndex,listing:p.listingPin,agreementHash:p.agreementHash,
      fulfilmentId:binding.fulfilmentId,purchaseAmount:{amount:demString(BigInt(p.amountOs)),currency:'DEM'},payloadHash:c.contentHash})?null:'delivery-binding';
}

// The host reads phase indexes from protocolSupport(its verified Listing).
// Missing phase context (null) cannot authorize an automatic phase write.
function listingPhaseIndex(read){
  const index=typeof read==='function'?read():null;
  return Number.isSafeInteger(index)&&!Object.is(index,-0)&&index>=0?index:null;
}

// CORE CF-5: a request's exact JSON (its CREATE and stored artifact) admitted
// as raw UTF-8: no duplicate member, unsafe number, lone surrogate or nesting
// over 128, as the SDK admits received bytes. Throws for anything else.
function admittedJson(text){
  if(typeof text!=='string'||!text.isWellFormed())throw new TypeError('exact request JSON is not well-formed text');
  return admitRawJson(Buffer.from(text,'utf8'));
}

// The request as the packaged wallet shows it, before any member is used:
// exact members, this seller's wallet and network, and well-typed coordinates.
// purpose, evidence, sending and debit.note are display text.
function requestShapeValid(request,policy){
  const c=request?.content;
  return exact(request,['method','address','purpose','content'])&&request.method==='sendTransaction'&&request.address===policy.address&&typeof request.purpose==='string'
    &&exact(c,[...REQUEST_CONTENT_KEYS,...(c?.artifactKind==='Deliverable'?['deliveryBinding']:[])])&&c.action===CREATE_ACTION&&c.contentHashProfile===CONTENT_HASH_PROFILE
    &&KINDS.has(c.artifactKind)&&isCanonicalJobId(c.jobId)&&c.owner===policy.seller&&c.wallet===policy.address
    &&typeof c.logicalAddress==='string'&&c.logicalAddress.length>0&&c.logicalAddress.length<=256&&c.programName===c.logicalAddress.replace(/:/g,'%3A')
    &&Number.isSafeInteger(c.nonce)&&c.nonce>=1&&Number.isSafeInteger(c.timestamp)&&c.timestamp>=0&&typeof c.evidence==='string'&&typeof c.sending==='string'
    &&c.network===policy.sourceBinding.network&&c.chainIdentity===policy.sourceBinding.chainIdentity&&same(c.networkBinding,policy.sourceBinding);
}

// The declared debit in OS, [storage fee, SDK gas, network fee, RPC fee], or
// null unless exact: canonical DEM strings, no seller amount or additional fee,
// the SDK's fixed gas, and both totals the sum of the parts.
function debitOs(d){
  if(!exact(d,['storageFeeDem','sellerAmountDem','sdkGasDem','networkFeeDem','rpcFeeDem','additionalFeeDem','totalDem','totalOs','note'])
    ||d.sellerAmountDem!=='0'||d.additionalFeeDem!=='0'||typeof d.note!=='string'||typeof d.totalOs!=='string'||!OS.test(d.totalOs))return null;
  const fees=['storageFeeDem','sdkGasDem','networkFeeDem','rpcFeeDem'].map(key=>demOs(d[key]));
  return fees.includes(null)||fees[0]<=0n||fees[1]!==OS_PER_DEM||fees.reduce((a,b)=>a+b,0n)!==BigInt(d.totalOs)||demOs(d.totalDem)!==BigInt(d.totalOs)?null:fees;
}

// The one CREATE this seller should sign for the request's coordinates and
// artifact: the seller CREATE builder's operation with the row's exact
// metadata, or null when the builder refuses them.
function expectedCreate(row,c,artifact,policy){
  let op;
  try{op=buildStorageProgramCreatePayload({from:c.wallet,storageAddress:c.storageAddress,programName:c.programName,logicalAddress:c.logicalAddress,signedListing:artifact,nonce:c.nonce,timestamp:c.timestamp}).content.data[1];}catch{return null;}
  Object.assign(op.metadata,{contentHash:c.contentHash,envelopeHash:c.envelopeHash,artifactKind:c.artifactKind,networkBinding:policy.sourceBinding,
    ...(row.kind===DEVNET_DEMO_ARTIFACT_KIND?{artifactBinding:{version:'1',policy:DEVNET_DEMO_ARTIFACT_POLICY,authority:policy.artifactAuthority,artifactKind:c.artifactKind,jobId:c.jobId,logicalAddress:c.logicalAddress,writer:policy.seller}}:{}),
    ...(c.artifactKind==='Deliverable'?{deliveryBinding:c.deliveryBinding}:{})});
  return op;
}

// Whether the request carries exactly the expected CREATE (in the wallet's
// canonical bytes) and its artifact's stored bytes, hashes and byte count.
function createMatches(row,c,artifact,policy){
  if(row.kind===DEVNET_DEMO_ARTIFACT_KIND&&typeof policy.artifactAuthority!=='string')return false;
  const op=expectedCreate(row,c,artifact,policy);
  try{
    return op!==null&&c.exactCreate===canonicalize(op)&&c.exactStorageBytes===JSON.stringify(op.data)&&c.contentHash===contentHash(artifact)
      &&c.envelopeHash===sha(c.exactStorageBytes)&&c.storageBytes===Buffer.byteLength(c.exactStorageBytes);
  }catch{return false;}
}

// The resolver's projection as one closed state: none (no seller record of
// the job), closed (a buyer outside closed access, or an ended purchase),
// draft (a proposal with no signed Agreement), agreed-unpaid, paid, or
// indeterminate (any other projection, or unknown payment authority). The
// parties are the Agreement's primary claims, checked as the SDK compares
// them: a canonical Demos agent buyer, this seller by CF-3 identity, and two
// distinct identities. The Agreement's transport binding is the policy's, whole.
// Payment names the transaction the observer verified, and only then.
function purchaseState(p,policy,jobId){
  if(p===null)return 'none';
  if(p===false)return 'closed';
  if(!exact(p,PURCHASE_KEYS)||p.jobId!==jobId||canonicalDemosAgentPublicKey(p.buyer)===null||!sameCanonicalClaimIdentity(p.seller,policy.seller)||sameCanonicalClaimIdentity(p.buyer,p.seller)
    ||!same(p.listingPin,policy.listingPin())||typeof p.amountOs!=='string'||!POSITIVE_OS.test(p.amountOs)||![true,false,null].includes(p.prePaymentOpen))return 'indeterminate';
  if(p.agreementHash===null)return p.sourceBinding===null&&p.paymentObserved===null&&p.paymentTxRef===null?'draft':'indeterminate';
  if(typeof p.agreementHash!=='string'||!HASH.test(p.agreementHash)||!same(p.sourceBinding,policy.sourceBinding)||typeof p.paymentObserved!=='boolean'
    ||(p.paymentObserved?!isPaymentTxRef(p.paymentTxRef):p.paymentTxRef!==null))return 'indeterminate';
  return p.paymentObserved?'paid':p.prePaymentOpen===false?'closed':'agreed-unpaid';
}

// What a purchase state allows this write: null, a refusal, or a hold for
// exact manual approval (HOLD_REASONS): a Vet record before the seller holds
// an Agreement, or a write before payment while buyer cancellation is
// unknown. A held write (its exact bytes manually approved) is not held again.
function stateRefusal(state,p,c,held){
  if(state==='indeterminate')return 'purchase';
  if(state==='closed')return 'purchase-closed';
  if(AFTER_PAYMENT.has(c.artifactKind))return state==='paid'?null:state==='agreed-unpaid'?'payment-not-observed':'purchase';
  if(state==='paid')return 'payment-already-observed';
  if(state!=='agreed-unpaid')return c.artifactKind!=='CompositeVerificationRecord'?'purchase':held?null:'seller-record-missing';
  return p.prePaymentOpen===true||held?null:'cancellation-unknown';
}

// Fresh purchase authority for an admitted write: its state and, with a seller
// record, the bindings its artifact names (row.bound). A hold is returned only
// when every other check passes.
async function purchaseRefusal(row,c,artifact,policy,held){
  const p=await policy.resolvePurchase(c.jobId),state=purchaseState(p,policy,c.jobId),reason=stateRefusal(state,p,c,held);
  if(reason&&!HOLD_REASONS.has(reason))return reason;
  return (state==='none'?null:row.bound(artifact,p,c,policy))??reason;
}

/** Validate one exact seller write request; return null when policy may approve it, else a reason.
 * Checks, in order: the request's shape ('request-shape'), its exact debit ('debit') under limits.maxWriteTotalOs
 * ('write-fee-cap'), its write kind (WRITE_KINDS, 'request-shape'), its exact CREATE and stored bytes against the
 * one expected CREATE ('create-bytes'), the artifact's members ('artifact') and logical address ('logical-address'),
 * then fresh purchase authority (purchaseRefusal). 'seller-record-missing' and 'cancellation-unknown' are holds for
 * exact manual approval, returned only once everything else passes; held (these exact bytes were manually approved)
 * waives them and nothing else. Payment evidence must name the purchase's verified paymentTxRef ('payment-tx');
 * delivery evidence the hash policy.deliveredPayloadHash(jobId) returns ('deliverable'). Never throws for a
 * malformed request; purchase resolver and policy input errors propagate. */
export async function policyRefusal(request,policy,limits,{held=false}={}){
  if(!requestShapeValid(request,policy))return 'request-shape';
  const c=request.content,fees=debitOs(c.debit);
  if(fees===null)return 'debit';
  if(BigInt(c.debit.totalOs)>BigInt(limits.maxWriteTotalOs))return 'write-fee-cap';
  let artifact;
  try{admittedJson(c.exactCreate);artifact=admittedJson(c.exactStorageBytes);}catch{return 'create-bytes';}
  if(!artifact||typeof artifact!=='object'||Array.isArray(artifact))return 'create-bytes';
  const row=writeKind(c,artifact);
  if(row?.kind!==c.kind)return 'request-shape';
  if(!createMatches(row,c,artifact,policy)||fees[0]!==BigInt(Math.max(1,Math.ceil(c.storageBytes/STORAGE_CHUNK_BYTES)))*OS_PER_DEM)return 'create-bytes';
  if(artifact.jobId!==c.jobId||!row.artifact(artifact,c,policy))return 'artifact';
  if(c.logicalAddress!==row.address(c,artifact,policy))return 'logical-address';
  return purchaseRefusal(row,c,artifact,policy,held===true);
}

/** Return the sender removals in OS (storage fee plus SDK gas) a node confirmed for exactly this policy-checked
 * request, or null. Node 61b8e75 executes the request's CREATE: its exact content keys, destination, network and
 * chain identity, data ['storageProgram', exactCreate], the declared fees, and exactly its four sender edits in
 * order (confirmedEditsMatch). Wire amounts are whole-DEM numbers before the denomination fork, OS strings after
 * it (amount '0'). Bound to its transaction hash, the executed answer may also carry the nonce, timestamp and
 * nonce step as decimal strings, and a gas_operation with exactly the declared fees, as the client reader accepts
 * (sdk-provider.mjs anchorContentMatches). Never rounds or coerces a fee. */
export function confirmedWriteOs(validity,request){
  const data=validity?.response?.data,tx=data?.transaction,c=tx?.content,r=request?.content,fees=debitOs(r?.debit);
  const postFork=c?.amount==='0',hashBound=typeof tx?.hash==='string'&&HASH.test(tx.hash);
  const wireOs=(value)=>postFork?(typeof value==='string'&&OS.test(value)?BigInt(value):null)
    :Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0)?BigInt(value)*OS_PER_DEM:null;
  const integer=(value,expected)=>value===expected||(hashBound&&value===String(expected));
  const feesMatch=(value,keys)=>exact(value,keys)&&['network_fee','rpc_fee','additional_fee'].every((key,i)=>wireOs(value[key])===[fees[2],fees[3],0n][i]);
  if(fees===null||validity?.result!==200||data?.valid!==true||data.custom_charges!=null
    ||!(data.gas_operation==null||(exact(data.gas_operation,['fees'])&&feesMatch(data.gas_operation.fees,['network_fee','rpc_fee','additional_fee'])))
    ||!exact(c,CONFIRMED_CONTENT_KEYS)||c.type!=='storageProgram'||!(postFork||c.amount===0)||c.from!==r.wallet||c.from_ed25519_address!==r.wallet
    ||c.to!==r.storageAddress||!integer(c.nonce,r.nonce)||!integer(c.timestamp,r.timestamp)||c.network!==r.network||c.chainIdentity!==r.chainIdentity
    ||!Array.isArray(c.data)||c.data.length!==2||c.data[0]!=='storageProgram'||JSON.stringify(c.data[1])!==r.exactCreate
    ||!feesMatch(c.transaction_fee,['network_fee','rpc_fee','additional_fee','rpc_address'])||c.transaction_fee.rpc_address!==null)return null;
  return confirmedEditsMatch(c.gcr_edits,r,c.data[1].metadata,fees,wireOs,integer,hashBound?tx.hash:null)?fees[0]+fees[1]:null;
}

// The executed edits of one storage CREATE, in order: the storage fee removal,
// this exact CREATE at its address, the SDK gas removal and a one-step nonce
// increment, each the wallet's and none rolled back (as sdk-provider.mjs
// anchorEditsMatch checks them in the client).
function confirmedEditsMatch(edits,r,metadata,[storageFee,gas],wireOs,integer,txHash){
  if(!Array.isArray(edits)||edits.length!==4)return false;
  const expected=[['balance','remove',storageFee],['storageProgram'],['balance','remove',gas],['nonce','add']];
  return edits.every((e,i)=>{
    if(e?.type!==expected[i][0]||e.isRollback!==false||!(e.txhash===''||(txHash!==null&&e.txhash===txHash)))return false;
    if(i===1)return exact(e,['type','target','isRollback','txhash','context'])&&e.target===r.storageAddress
      &&exact(e.context,['operation','sender','data'])&&e.context.operation==='CREATE_STORAGE_PROGRAM'&&e.context.sender===r.wallet
      &&exact(e.context.data,['variables','metadata'])&&JSON.stringify(e.context.data.variables)===r.exactCreate&&JSON.stringify(e.context.data.metadata)===JSON.stringify(metadata);
    return exact(e,['type','operation','isRollback','account','txhash','amount'])&&e.operation===expected[i][1]&&e.account===r.wallet
      &&(i===3?integer(e.amount,1):wireOs(e.amount)===expected[i][2]);
  });
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

const KINDS=new Set(['CompositeVerificationRecord','FinalityCommitmentRecord','SettlementEvidence','Deliverable']);

const BEFORE_PAYMENT=new Set(['CompositeVerificationRecord','FinalityCommitmentRecord']);

const AFTER_PAYMENT=new Set(['SettlementEvidence','Deliverable']);

const CREATE_ACTION='immutable DACS storage anchor CREATE';
const CONTENT_HASH_PROFILE='SDK CF-1 signed scope (top-level signature/signatures omitted)';
const DELIVERY_PROFILE='dacs-native-delivery-publication/v1';
const OS_PER_DEM=1_000_000_000n;
// The node charges 1 DEM of storage fee per started 10 KiB of stored bytes.
const STORAGE_CHUNK_BYTES=10_240;

// The request content members besides a Deliverable's deliveryBinding.
const REQUEST_CONTENT_KEYS=['kind','action','artifactKind','jobId','owner','wallet','logicalAddress','storageAddress','programName','contentHash','contentHashProfile','envelopeHash',
  'storageBytes','exactStorageBytes','exactCreate','nonce','timestamp','debit','network','chainIdentity','networkBinding','evidence','sending'];

// Exact pay-dem and delivery SettlementEvidence members, as the packaged wallet admits them.
const PAYMENT_EVIDENCE_KEYS=['evidenceVersion','jobId','phase','outcome','paymentTxRefs','paymentAmount','settlementFinality','observedAt','signature'];
const DELIVERY_EVIDENCE_KEYS=['evidenceVersion','jobId','phase','outcome','dacsSdkAuditSourceHash','deliverableContentHash','deliverableAnchor','observedAt','signature'];

// The purchase resolver's projection members (seller-purchase-source.mjs).
const PURCHASE_KEYS=['jobId','seller','buyer','listingPin','sourceBinding','agreementHash','amountOs','paymentObserved','paymentTxRef','prePaymentOpen'];

// The executed CREATE content keys (Node 61b8e75, as the client checks them).
const CONFIRMED_CONTENT_KEYS=['type','from','from_ed25519_address','to','amount','data','nonce','timestamp','transaction_fee','network','chainIdentity','gcr_edits'];

// Canonical equality; anything that is not JSON is unequal.
const same=(a,b)=>{try{return canonicalize(a)===canonicalize(b);}catch{return false;}};

// A canonical DEM decimal string in OS, or null; demString is its inverse.
const demOs=(value)=>typeof value==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{0,8}[1-9])?$/.test(value)?BigInt(value.split('.')[0])*OS_PER_DEM+BigInt((value.split('.')[1]??'').padEnd(9,'0')):null;
const demString=(os)=>{const fraction=(os%OS_PER_DEM).toString().padStart(9,'0').replace(/0+$/,'');return fraction?`${os/OS_PER_DEM}.${fraction}`:`${os/OS_PER_DEM}`;};

// The write kind and artifact of a request policyRefusal admitted; throws for one it refuses as malformed.
function admittedWrite(request){
  const c=request.content,artifact=admittedJson(c.exactStorageBytes),row=writeKind(c,artifact);
  if(!row)throw new TypeError('the request names no seller write kind');
  return{c,artifact,row};
}

/** Await fresh purchase authority for a write before payment (null for any other write): null while its purchase
 * is still open and still the one its exact artifact names, else a refusal or hold reason (as policyRefusal; held:
 * true when these exact bytes were manually approved). Throws for a request policyRefusal refuses as malformed;
 * resolver errors propagate; callers must append synchronously after this resolves. */
export async function stillOpenBeforePayment(request,policy,held=false){
  const{c,artifact,row}=admittedWrite(request);
  return BEFORE_PAYMENT.has(c.artifactKind)?purchaseRefusal(row,c,artifact,policy,held===true):null;
}

/** Await fresh purchase authority immediately before sign authority, for any write: as stillOpenBeforePayment
 * before payment; after payment, null while the purchase is still paid and still the one its exact artifact
 * names (listing, Agreement, amount, payment transaction, delivered payload and delivery binding), else a refusal reason. Throws as stillOpenBeforePayment. */
export async function stillAuthorizedToSign(request,policy,held=false){
  const{c,artifact,row}=admittedWrite(request);
  return purchaseRefusal(row,c,artifact,policy,held===true);
}
