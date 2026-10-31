import { dirname, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync, truncateSync, writeSync } from 'node:fs';
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
    if(Object.hasOwn(row,'policyHold')&&(!policyRow||!HOLD_REASONS.has(row.policyHold)||!row.confirmation))malformed();
    let attempt=null,opened=false;
    if(Object.hasOwn(row,'attemptId')){
      if(typeof row.attemptId!=='string'||!ATTEMPT_ID.test(row.attemptId)||Object.hasOwn(row,'manualApproved'))malformed();
      attempt=attempts.get(row.attemptId);
      if(policyRow&&!Object.hasOwn(row,'policyHold')){
        // The hold opens the attempt.
        if(attempt||row.decision!=='rejected'||!HOLD_REASONS.has(row.policyReason))malformed();
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
// releasedLine (the first release line), originLine}; contextHoldRows turns it into outstanding writes.
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
  hold.released=true;hold.releasedLine??=lineNumber;
}

// Each open context hold counts its unconverted writes as outstanding policy
// reservations at the write fee cap it was taken with. A policy-approved Vet
// write of that job converts one only if its write started on a later ledger
// line than the hold (originLine): every ledger line is appended under the
// policy lock, so line order is the order admission saw, and approving,
// signing or completing an attempt never moves it. Clocks play no part. A row
// without an originLine converts nothing. Writes are taken in line order, not
// in the order the rows are listed (an open attempt is listed last). A write
// that started while a released hold was open may have been that hold's, so it
// takes the hold that ends first and an open hold keeps its slot counted.
// `converting` is the write being decided, which has no line yet: it takes one
// of its job's held writes instead of adding a new one.
function contextHoldRows(ledger,converting=null){
  const vet=(row,jobId)=>row.decision==='approved'&&row.policy&&row.outcome!=='released'&&row.jobId===jobId&&row.artifactKind==='CompositeVerificationRecord';
  let taken=converting?.artifactKind!=='CompositeVerificationRecord';
  const holds=ledger.filter(row=>row.contextHold).map(hold=>({hold,remaining:hold.writes,end:hold.released?hold.releasedLine??Infinity:Infinity}));
  const writes=ledger.filter(row=>!row.contextHold&&Number.isSafeInteger(row.originLine)).sort((a,b)=>a.originLine-b.originLine);
  // One write consumes one slot across all holds, including holds retained
  // across a shutdown and a replacement hold for the same job.
  for(const row of writes){
    let chosen=null;
    for(const slot of holds){
      if(slot.remaining>0&&vet(row,slot.hold.jobId)&&row.originLine>slot.hold.originLine&&row.originLine<slot.end&&(!chosen||slot.end<chosen.end))chosen=slot;
    }
    if(chosen)chosen.remaining--;
  }
  const rows=[];
  for(const{hold,remaining}of holds.filter(slot=>!slot.hold.released)){
    let open=remaining;
    if(!taken&&converting.jobId===hold.jobId&&open>0){open-=1;taken=true;}
    for(let index=0;index<open;index++)rows.push({decision:'approved',policy:true,outcome:null,jobId:hold.jobId,totalOs:hold.totalOs,contextSlot:hold.contextHold});
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
function budgetRefusal({jobId,totalOs,at,limits,writes,snapshot}){
  const{rows:ledger,attempts}=snapshot;
  // A released attempt counts towards neither limit.
  const live=withContextHolds(ledger).filter(row=>row.decision==='approved'&&row.outcome!=='released'&&attempts.get(row.attemptId)?.outcome!=='released');
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
