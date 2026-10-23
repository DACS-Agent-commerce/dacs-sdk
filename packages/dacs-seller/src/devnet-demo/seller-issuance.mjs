import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { openDurableWalletJournal } from '../wallet/durable-journal.mjs';
import { acquireSellerStateLock } from './seller-state-lock.mjs';
import { decidedFromJournals, parsePolicyLedger, SELLER_ISSUANCE_JOURNALS, SELLER_LEDGER_HEADER_FORMAT, SELLER_LEDGER_LINE_FORMATS, sellerIssuanceJournalIds } from './operator-approval.mjs';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());

// Seller records (sellerApproval.purchaseSource "seller"): what the bound
// issuance journals show for one unresolved policy reservation. Restart never
// releases a reservation on this answer (operator-approval.mjs: its
// sign-authorized line precedes signing); it only labels what stays held.
// The source journal's 'seller-policy/' keys are reserved: no build writes
// them, and ops health refuses any record there (src/ops/health.mjs).
export const SELLER_POLICY_JOURNAL_PREFIX='seller-policy/';

// 'issued' when a journal retains this reservation's exact signed bytes,
// otherwise 'unknown'. Neither answer is release proof.
export async function sellerJournalIssuance({journals},request){
  const c=request?.content,listed=await Promise.all(journals.map(journal=>journal.entries()));
  const signed=listed.flat().map(([,value])=>value?.signedTransaction?.content).filter(content=>content?.from===c?.wallet);
  return signed.some(s=>s.nonce===c.nonce&&s.timestamp===c.timestamp&&JSON.stringify(s.data?.[1])===c.exactCreate)?'issued':'unknown';
}

export const SELLER_JOURNAL_REFUSALS=Object.freeze({
  bindingUnreadable:'seller issuance journal identity binding is unreadable; restore the ledger and its original journals together',
  headerMalformed:'seller approval ledger journal header is malformed or repeated; nothing may be sent',
  headerWithoutBinding:'seller issuance journal identity binding is absent or unreadable for an approval ledger whose header names its journals; restore the binding, the ledger and all three journals from one state',
  headerMismatch:'seller approval ledger header names other issuance journals than seller-issuance-journals.json; nothing may be sent: restore the ledger, the binding and all three journals from one state',
  unboundHeld:'seller approval ledger has no issuance journal header (it was written without seller records, for example by main in manual mode or in policy mode with the app as source) and holds unresolved policy reservations, which restart keeps held; nothing was bound: keep the state directory and its journals, then resolve each reservation by hand or archive the ledger (see "Turning on seller records" in docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md)',
  unboundUnreadable:'seller approval ledger has no issuance journal header (it was written without seller records) and cannot be read, so it cannot be bound to the current journals; nothing was bound: keep the state directory and its journals, and archive the ledger only after accounting for its writes (see "Turning on seller records" in docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md)',
  // Followed by the ledger's path and the first line that does not read (sellerLedgerUnreadable).
  ledgerUnreadable:'seller approval ledger cannot be read; nothing was started',
});
const sellerLedgerUnreadable=(ledgerPath,error)=>`${SELLER_JOURNAL_REFUSALS.ledgerUnreadable}: ${ledgerPath} line ${error?.ledgerLine??'?'} (${String(error?.message).slice(0,160)}). With the operator stopped, correct that line and start again (see "Resolving a held reservation by hand" in docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md)`;
const syncDirectory=async(path)=>{const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}};
// The longest prefix a ledger header line shares with a line of any other
// ledger format: `{"format":"dacs-`. A torn fragment no longer than this
// could be the start of any line, so it is never taken for a torn header.
const commonPrefix=(a,b)=>{let i=0;while(i<a.length&&a[i]===b[i])i++;return i;};
const HEADER_SHARED_PREFIX=Math.max(...SELLER_LEDGER_LINE_FORMATS.map(format=>commonPrefix(`{"format":${JSON.stringify(SELLER_LEDGER_HEADER_FORMAT)}`,`{"format":${JSON.stringify(format)}`)));
// A new file whole or not at all: a synced temporary file, linked into place
// (never over an existing file) or renamed over it, then the synced directory.
async function publishFile(path,text,{replace=false}={}){
  const temporary=`${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
  try{if(replace)await rename(temporary,path);else{await link(temporary,path);await unlink(temporary);}}
  catch(error){await unlink(temporary).catch(()=>{});throw error;}
  await syncDirectory(dirname(path));
}
export async function openSellerIssuanceJournals({directory,opened=[],now=Date.now}){
  const names=SELLER_ISSUANCE_JOURNALS;
  const evidenceDirectory=join(directory,'evidence'),bindingPath=join(evidenceDirectory,'seller-issuance-journals.json'),ledgerPath=join(evidenceDirectory,'seller-approvals.jsonl');
  const openJournals=(ids)=>names.map(name=>{
    const path=join(directory,name);
    let value;
    try{value=openDurableWalletJournal({path,mode:ids?'open':existsSync(path)?'open':'create',...(ids?{expectedJournalId:ids[name]}:{})});}
    catch(error){error.message=`seller issuance journal ${name} refused: ${error.message}`;throw error;}
    opened.push(()=>value.close());return value;
  });
  // Held until the operator closes (journals.stateLock.release). A start that
  // fails here closes the journals it opened, then releases it.
  const lock=await acquireSellerStateLock(directory,{now});opened.push(()=>lock.release());
  const mark=opened.length;
  try{return Object.assign(await bindSellerIssuanceJournals({directory,names,evidenceDirectory,bindingPath,ledgerPath,openJournals,now}),{stateLock:lock});}
  catch(error){for(const close of opened.splice(mark).reverse()){try{close();}catch{}}lock.release();throw error;}
}
async function bindSellerIssuanceJournals({directory,names,evidenceDirectory,bindingPath,ledgerPath,openJournals,now}){
  // An empty binding is a first start's write that never completed.
  let binding=null,torn=false;
  try{
    const text=await readFile(bindingPath,'utf8');
    if(!text.trim())torn=true;
    else{
      binding=JSON.parse(text);
      if(!exact(binding,['format','journals'])||binding.format!=='dacs-seller-issuance-journals/v1'||!sellerIssuanceJournalIds(binding.journals))
        throw new Error('seller issuance journal identity binding is malformed; nothing may be sent');
    }
  }catch(error){if(error.code!=='ENOENT')throw new Error(SELLER_JOURNAL_REFUSALS.bindingUnreadable,{cause:error});binding=null;}
  // Bound journals open first: a missing, recreated or swapped one refuses
  // before the ledger is read.
  let journals=binding?openJournals(binding.journals):null;
  // The ledger's exact bytes: an existing one is rewritten whole below.
  let kept=null;
  try{kept=await readFile(ledgerPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  let ledger=kept?.toString('utf8')??null;
  // A header append that a crash cut short (earlier builds appended it) leaves
  // a prefix of the header line, with no newline, as the ledger's last line.
  // It is cut off, and the header written whole, only when it is a prefix of
  // the exact header line for this binding (format and journal ids) and longer
  // than HEADER_SHARED_PREFIX, so that it cannot be the start of another line.
  // Anything shorter or different stays, and the ledger refuses below.
  if(binding&&kept?.length&&kept.at(-1)!==0x0a){
    const at=kept.lastIndexOf(0x0a)+1,tail=kept.subarray(at).toString('utf8');
    const start=`{"format":${JSON.stringify(SELLER_LEDGER_HEADER_FORMAT)},"journals":${JSON.stringify(binding.journals)},"recordedAt":`;
    if(tail.length>HEADER_SHARED_PREFIX&&(start.startsWith(tail)||(tail.startsWith(start)&&/^[0-9]*$/.test(tail.slice(start.length))))){kept=kept.subarray(0,at);ledger=kept.toString('utf8');}
  }
  // The header is found line by line, so that the header faults below are
  // named as such; a ledger with a matching header must then read whole.
  const headers=[];
  for(const line of (ledger??'').split('\n')){
    let row;try{row=JSON.parse(line);}catch{continue;}
    if(row?.format!==SELLER_LEDGER_HEADER_FORMAT)continue;
    if(!exact(row,['format','journals','recordedAt'])||!sellerIssuanceJournalIds(row.journals)||!Number.isSafeInteger(row.recordedAt)||row.recordedAt<0)throw new Error(SELLER_JOURNAL_REFUSALS.headerMalformed);
    headers.push(row);
  }
  if(headers.length>1)throw new Error(SELLER_JOURNAL_REFUSALS.headerMalformed);
  if(headers.length===1){
    if(!binding)throw new Error(SELLER_JOURNAL_REFUSALS.headerWithoutBinding);
    if(canonicalize(headers[0].journals)!==canonicalize(binding.journals))throw new Error(SELLER_JOURNAL_REFUSALS.headerMismatch);
    // A ledger that does not read (a line appended by hand with a typo, for
    // example) refuses here, naming its line: running on it would leave every
    // seller write before payment waiting for the ledger.
    try{parsePolicyLedger(ledger);}catch(error){throw new Error(sellerLedgerUnreadable(ledgerPath,error),{cause:error});}
    // A header whose newline was never written ends it before anything is appended.
    if(!ledger.endsWith('\n')){
      let last=null;try{last=JSON.parse(ledger.slice(ledger.lastIndexOf('\n')+1));}catch{}
      if(last?.format===SELLER_LEDGER_HEADER_FORMAT){const handle=await open(ledgerPath,'a',0o600);try{await handle.writeFile('\n');await handle.sync();}finally{await handle.close();}}
    }
    return journals;
  }
  if(torn&&ledger!==null)throw new Error(SELLER_JOURNAL_REFUSALS.bindingUnreadable);
  if(ledger!==null){
    let rows;
    try{({rows}=parsePolicyLedger(ledger));}catch(error){throw new Error(SELLER_JOURNAL_REFUSALS.unboundUnreadable,{cause:error});}
    if(rows.some(decidedFromJournals))throw new Error(SELLER_JOURNAL_REFUSALS.unboundHeld);
  }
  // Bind: the current journals (main's semantics: existing ones are opened,
  // absent ones created), then the binding, then the header. Each is synced
  // before the next, and all before any approval.
  journals??=openJournals(null);
  const ids=Object.fromEntries(names.map((name,i)=>[name,journals[i].journalId]));
  await mkdir(evidenceDirectory,{recursive:true,mode:0o700});await syncDirectory(directory);
  if(!binding)await publishFile(bindingPath,`${JSON.stringify({format:'dacs-seller-issuance-journals/v1',journals:ids})}\n`,{replace:torn});
  const header=`${JSON.stringify({format:SELLER_LEDGER_HEADER_FORMAT,journals:ids,recordedAt:now()})}\n`;
  if(ledger===null)await publishFile(ledgerPath,header);
  // An existing ledger is replaced whole: its exact bytes (less a torn header),
  // a newline if its last line lacks one, then the header. A crash leaves
  // either the old ledger or the new one, never a partial header.
  else await publishFile(ledgerPath,Buffer.concat([kept,Buffer.from(`${kept.length&&kept.at(-1)!==0x0a?'\n':''}${header}`,'utf8')]),{replace:true});
  return journals;
}
