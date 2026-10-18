import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, rename, stat, writeFile } from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSellerIssuanceJournals, SELLER_JOURNAL_REFUSALS } from '../src/devnet-demo/operator.mjs';
import { SELLER_LEDGER_HEADER_FORMAT, parsePolicyLedger } from '../src/devnet-demo/operator-approval.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

const names=['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite'];
const sha=(value)=>createHash('sha256').update(value).digest('hex');
async function state(t){
  const directory=await mkdtemp(join(tmpdir(),'seller-issuance-identity-'));
  const opened=[];t.after(async()=>{for(const close of opened.reverse())close();await rm(directory,{recursive:true,force:true});});
  const boot=()=>openSellerIssuanceJournals({directory,sellerRecords:true,opened,now:()=>7});
  const stop=()=>{for(const close of opened.splice(0).reverse())close();};
  const ledger=join(directory,'evidence','seller-approvals.jsonl'),binding=join(directory,'evidence','seller-issuance-journals.json');
  return {directory,boot,stop,ledger,binding,opened};
}
const ids=(journals)=>Object.fromEntries(names.map((n,i)=>[n,journals[i].journalId]));
const headerLine=(journals)=>`${JSON.stringify({format:SELLER_LEDGER_HEADER_FORMAT,journals:ids(journals),recordedAt:7})}\n`;
// Ledger lines exactly as main (60d7eb9) writes them.
const request=(artifactKind,nonce)=>({method:'sendTransaction',address:`0x${'a'.repeat(64)}`,content:{artifactKind,jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',wallet:`0x${'a'.repeat(64)}`,nonce,timestamp:nonce,exactCreate:'{}',debit:{totalOs:'4000000000'}}});
const mainLine=(artifactKind,nonce,extra={})=>{const requestBytes=JSON.stringify(request(artifactKind,nonce));
  return JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(requestBytes),requestBytes,method:'sendTransaction',address:`0x${'a'.repeat(64)}`,totalOs:'4000000000',decision:'approved',...extra,recordedAt:nonce});};
const mainManualLedger=()=>`${mainLine('Listing',1)}\n${mainLine('FinalityCommitmentRecord',2)}\n`;
const mainPolicy=(nonce,reservationId)=>mainLine('SettlementEvidence',nonce,{approvalMode:'policy',policyReason:null,reservationId});
const completion=(nonce,reservationId,outcome)=>JSON.stringify({format:'dacs-node2-seller-policy-attempt/v1',reservationId,approvalHash:sha(JSON.stringify(request('SettlementEvidence',nonce))),outcome,recordedAt:nonce+1});
const listing=async(directory)=>(await readdir(directory)).sort();

test('first seller start durably binds all three creation IDs in the binding and the ledger header; intact journals reopen with the same identities',async t=>{
  const s=await state(t),journals=await s.boot();
  assert.deepEqual(JSON.parse(await readFile(s.binding,'utf8')),{format:'dacs-seller-issuance-journals/v1',journals:ids(journals)});
  // The header is the ledger's first line, written before any approval.
  assert.equal(await readFile(s.ledger,'utf8'),headerLine(journals));
  assert.deepEqual(parsePolicyLedger(await readFile(s.ledger,'utf8')).header,{format:SELLER_LEDGER_HEADER_FORMAT,journals:ids(journals),recordedAt:7});
  s.stop();
  assert.deepEqual((await s.boot()).map(j=>j.journalId),journals.map(j=>j.journalId));
  assert.equal(await readFile(s.ledger,'utf8'),headerLine(journals),'the header is never rewritten or repeated');
  assert.ok((await listing(join(s.directory,'evidence'))).every(name=>!name.endsWith('.tmp')),'no temporary file is left behind');
});

test('Ledger binding: a ledger written by main in manual mode starts seller records, keeping the existing journals and binding them',async t=>{
  const s=await state(t);
  // main's operator had already created its journals and written manual lines.
  for(const name of names)openDurableWalletJournal({path:join(s.directory,name),mode:'create'}).close();
  const existing=names.map(name=>{const j=openDurableWalletJournal({path:join(s.directory,name),mode:'open'});const id=j.journalId;j.close();return id;});
  await mkdir(join(s.directory,'evidence'),{mode:0o700});await writeFile(s.ledger,mainManualLedger());
  const journals=await s.boot();
  assert.deepEqual(journals.map(j=>j.journalId),existing,'the existing journals are kept, not recreated');
  assert.deepEqual(JSON.parse(await readFile(s.binding,'utf8')).journals,ids(journals));
  // Append-only: main's lines are unchanged and the header follows them.
  assert.equal(await readFile(s.ledger,'utf8'),`${mainManualLedger()}${headerLine(journals)}`);
  s.stop();assert.deepEqual((await s.boot()).map(j=>j.journalId),existing);
});

test('Ledger binding: a ledger written by main in policy mode with the app as source starts when every reservation is completed, and is refused while one is not',async t=>{
  const [spent,released,unknown]=[randomUUID(),randomUUID(),randomUUID()];
  const completed=`${mainLine('Listing',1)}\n${mainPolicy(2,spent)}\n${completion(2,spent,'spent')}\n${mainPolicy(3,released)}\n${completion(3,released,'released')}\n`;
  const s=await state(t);await mkdir(join(s.directory,'evidence'),{mode:0o700});await writeFile(s.ledger,completed);
  const journals=await s.boot();
  assert.equal(await readFile(s.ledger,'utf8'),`${completed}${headerLine(journals)}`);s.stop();
  // A reservation whose wallet outcome was unknown has no completion: restart
  // would decide it from the journals, so nothing is bound or created.
  const open=`${completed}${mainPolicy(4,unknown)}\n`;
  const r=await state(t);await mkdir(join(r.directory,'evidence'),{mode:0o700});await writeFile(r.ledger,open);
  await assert.rejects(r.boot(),{message:SELLER_JOURNAL_REFUSALS.unboundHeld});
  assert.ok(names.every(n=>!existsSync(join(r.directory,n))),'no journal was created');
  assert.equal(existsSync(r.binding),false);assert.equal(await readFile(r.ledger,'utf8'),open);
});

test('Ledger binding: an unbound ledger holding an unresolved seller-records reservation, or one that cannot be read, stays refused with existing journals untouched',async t=>{
  const s=await state(t);
  for(const name of names)openDurableWalletJournal({path:join(s.directory,name),mode:'create'}).close();
  await mkdir(join(s.directory,'evidence'),{mode:0o700});
  const reservation=randomUUID(),held=`${mainPolicy(5,reservation).replace('"reservationId"','"policyHold":"cancellation-unknown","confirmation":{"TEST":true},"reservationId"')}\n`;
  for(const [text,message] of [[held,SELLER_JOURNAL_REFUSALS.unboundHeld],['TEST retained ledger\n',SELLER_JOURNAL_REFUSALS.unboundUnreadable],['',null]]){
    await writeFile(s.ledger,text);
    if(message===null){await s.boot();s.stop();continue;}
    const before=await listing(s.directory);
    await assert.rejects(s.boot(),{message});
    assert.equal(await readFile(s.ledger,'utf8'),text);assert.equal(existsSync(s.binding),false);assert.deepEqual(await listing(s.directory),before);
  }
  // The empty ledger was bound: it now holds only its header.
  assert.equal(parsePolicyLedger(await readFile(s.ledger,'utf8')).header.format,SELLER_LEDGER_HEADER_FORMAT);
});

test('Ledger binding: the refusal names a ledger written without seller records and both ways out; a ledger with a binding but no header follows the same rule against its bound journals',async t=>{
  assert.match(SELLER_JOURNAL_REFUSALS.unboundHeld,/no issuance journal header \(it was written without seller records, for example by main in manual mode or in policy mode with the app as source\)/);
  assert.match(SELLER_JOURNAL_REFUSALS.unboundHeld,/keep the state directory and its journals, then resolve each reservation by hand or archive the ledger/);
  assert.doesNotMatch(`${SELLER_JOURNAL_REFUSALS.unboundHeld} ${SELLER_JOURNAL_REFUSALS.unboundUnreadable}`,/fresh state/);
  // An earlier build of this change wrote the binding but no header.
  const s=await state(t),journals=await s.boot();s.stop();const binding=await readFile(s.binding,'utf8');
  const reservation=randomUUID(),held=`${mainPolicy(6,reservation)}\n`;
  await writeFile(s.ledger,held);
  await assert.rejects(s.boot(),{message:SELLER_JOURNAL_REFUSALS.unboundHeld});s.stop();
  assert.equal(await readFile(s.ledger,'utf8'),held);assert.equal(await readFile(s.binding,'utf8'),binding);
  // Resolved by hand, it is stamped with the journals its binding names.
  const resolved=`${held}${completion(6,reservation,'spent')}\n`;await writeFile(s.ledger,resolved);
  assert.deepEqual((await s.boot()).map(j=>j.journalId),journals.map(j=>j.journalId));s.stop();
  assert.equal(await readFile(s.ledger,'utf8'),`${resolved}${headerLine(journals)}`);assert.equal(await readFile(s.binding,'utf8'),binding);
});

test('each missing bound journal refuses startup and stays absent, with or without an approval ledger',async t=>{
  for(const name of names){
    const s=await state(t);await s.boot();const ledger=await readFile(s.ledger,'utf8');s.stop();
    await rm(join(s.directory,name));await assert.rejects(s.boot(),{code:'journal-absent'});s.stop();
    assert.equal(existsSync(join(s.directory,name)),false);assert.equal(await readFile(s.ledger,'utf8'),ledger);
    await rm(s.ledger);await assert.rejects(s.boot(),{code:'journal-absent'});
  }
});

test('each valid recreated journal at the same path is refused by its bound creation identity',async t=>{
  for(const name of names){
    const s=await state(t);await s.boot();const ledger=await readFile(s.ledger,'utf8');s.stop();
    const path=join(s.directory,name);await rm(path);
    openDurableWalletJournal({path,mode:'create'}).close();
    await assert.rejects(s.boot(),{code:'journal-integrity',message:`seller issuance journal ${name} refused: the journal identity differs from the expected journal`});
    assert.equal(await readFile(s.ledger,'utf8'),ledger);
  }
});

test('swapped valid journal files are refused, and a lost or malformed binding is never reenrolled against a bound ledger',async t=>{
  const s=await state(t);await s.boot();const ledger=await readFile(s.ledger,'utf8');s.stop();
  const a=join(s.directory,names[0]),b=join(s.directory,names[1]),temp=join(s.directory,'swap');
  await rename(a,temp);await rename(b,a);await rename(temp,b);
  await assert.rejects(s.boot(),{code:'journal-integrity'});
  await rm(s.binding);await assert.rejects(s.boot(),{message:SELLER_JOURNAL_REFUSALS.headerWithoutBinding});
  await writeFile(s.binding,'');await assert.rejects(s.boot(),{message:SELLER_JOURNAL_REFUSALS.headerWithoutBinding});
  for(const text of ['null','{}','{"format":"dacs-seller-issuance-journals/v1","journals":{}}','{']){
    await writeFile(s.binding,text);await assert.rejects(s.boot(),{message:SELLER_JOURNAL_REFUSALS.bindingUnreadable});
  }
  assert.equal(await readFile(s.ledger,'utf8'),ledger);assert.equal(existsSync(s.binding),true);
});

test('a ledger header that differs from the binding, or a repeated or malformed header, refuses startup and is never rewritten',async t=>{
  const s=await state(t),journals=await s.boot();const ledger=await readFile(s.ledger,'utf8');s.stop();
  const other={...ids(journals),'seller-wallet.sqlite':'0'.repeat(32)};
  const cases=[
    [`${JSON.stringify({format:SELLER_LEDGER_HEADER_FORMAT,journals:other,recordedAt:7})}\n`,SELLER_JOURNAL_REFUSALS.headerMismatch],
    [`${ledger}${ledger}`,SELLER_JOURNAL_REFUSALS.headerMalformed],
    [`${JSON.stringify({format:SELLER_LEDGER_HEADER_FORMAT,journals:ids(journals)})}\n`,SELLER_JOURNAL_REFUSALS.headerMalformed],
  ];
  for(const [text,message] of cases){await writeFile(s.ledger,text);await assert.rejects(s.boot(),{message});s.stop();assert.equal(await readFile(s.ledger,'utf8'),text);}
  assert.throws(()=>parsePolicyLedger(`${ledger}${ledger}`),/seller approval evidence is malformed/);
});

test('torn binding (code-review P3): an empty binding with no ledger is rewritten whole; with a ledger it still refuses',async t=>{
  const s=await state(t),journals=await s.boot();s.stop();
  await rm(s.ledger);await writeFile(s.binding,'');
  assert.deepEqual((await s.boot()).map(j=>j.journalId),journals.map(j=>j.journalId),'the existing journals are bound again, never recreated');
  assert.deepEqual(JSON.parse(await readFile(s.binding,'utf8')).journals,ids(journals));
  assert.equal(await readFile(s.ledger,'utf8'),headerLine(journals));s.stop();
  // A ledger without a header beside a torn binding: nothing proves which journals it had.
  await writeFile(s.binding,'');await writeFile(s.ledger,'');
  await assert.rejects(s.boot(),{message:SELLER_JOURNAL_REFUSALS.bindingUnreadable});
  assert.equal(await readFile(s.binding,'utf8'),'');assert.equal(await readFile(s.ledger,'utf8'),'');
});

test('app mode keeps main journal creation semantics and writes no identity binding or header',async t=>{
  const s=await state(t),opened=s.opened;
  await mkdir(join(s.directory,'evidence'),{mode:0o700});await writeFile(s.ledger,'TEST existing app ledger');
  assert.equal((await openSellerIssuanceJournals({directory:s.directory,opened})).length,3);
  assert.equal(existsSync(s.binding),false);
  assert.equal(await readFile(s.ledger,'utf8'),'TEST existing app ledger');
});

test('Ledger binding: a non-empty ledger without its final newline gets one before the header, never a glued line',async t=>{
  const s=await state(t);await mkdir(join(s.directory,'evidence'),{mode:0o700});
  const unterminated=mainManualLedger().slice(0,-1);await writeFile(s.ledger,unterminated);
  const journals=await s.boot();s.stop();
  assert.equal(await readFile(s.ledger,'utf8'),`${unterminated}\n${headerLine(journals)}`);
  assert.equal(parsePolicyLedger(await readFile(s.ledger,'utf8')).header.recordedAt,7);
  // A header whose own newline was never written is ended before anything is appended.
  await writeFile(s.ledger,`${unterminated}\n${headerLine(journals).slice(0,-1)}`);
  await s.boot();s.stop();
  assert.equal(await readFile(s.ledger,'utf8'),`${unterminated}\n${headerLine(journals)}`);
});

// an earlier review round (a review): this test changed. A 1-byte cut was
// repaired; now only a fragment longer than the 16 bytes every ledger line
// format starts with ('{"format":"dacs-') is taken for a torn header.
test('Ledger binding: a torn header append (a prefix of the header line for this binding, longer than any prefix it shares with another line format) is cut off under the lock and the header written whole; any other trailing fragment still refuses',async t=>{
  const s=await state(t),journals=await s.boot();s.stop();
  const header=headerLine(journals),before=mainManualLedger();
  for(const cut of [17,20,header.indexOf('"journals"')+5,header.indexOf('"recordedAt":')+13,header.length-2]){
    await writeFile(s.ledger,`${before}${header.slice(0,cut)}`);
    await s.boot();s.stop();
    assert.equal(await readFile(s.ledger,'utf8'),`${before}${header}`,`cut at ${cut}`);
  }
  // Not a prefix of this header: another binding's ids, or a torn approval line.
  // Too short to be told from another line: the first 16 bytes or fewer.
  const other=header.replace(/[0-9a-f]{32}/,'0'.repeat(32)).slice(0,header.indexOf('"recordedAt"'));
  for(const tail of [other,'{"format":"dacs-node2-operator-approval-evidence/v1","appr',header.slice(0,1),header.slice(0,16)]){
    await writeFile(s.ledger,`${before}${tail}`);
    await assert.rejects(s.boot(),{message:SELLER_JOURNAL_REFUSALS.unboundUnreadable},JSON.stringify(tail));
    assert.equal(await readFile(s.ledger,'utf8'),`${before}${tail}`);
  }
});

test('a review: the 16-byte fragment every ledger line format shares is never cut as a torn header; the start refuses and the ledger stays as it was',async t=>{
  const s=await state(t);await s.boot();s.stop();
  const requestBytes=JSON.stringify(request('FinalityCommitmentRecord',1));
  const manual=JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(requestBytes),requestBytes,method:'sendTransaction',address:`0x${'a'.repeat(64)}`,totalOs:'4000000000',decision:'approved',recordedAt:7});
  const ambiguous='{"format":"dacs-',text=`${manual}\n${ambiguous}`;
  for(const format of [SELLER_LEDGER_HEADER_FORMAT,'dacs-node2-seller-policy-sign-authorization/v1','dacs-node2-seller-policy-attempt/v1','dacs-node2-operator-approval-evidence/v1'])
    assert.ok(JSON.stringify({format}).startsWith(ambiguous),format);
  await writeFile(s.ledger,text);
  await assert.rejects(s.boot(),{message:SELLER_JOURNAL_REFUSALS.unboundUnreadable});
  assert.equal(await readFile(s.ledger,'utf8'),text,'nothing was cut or written');
  // One byte more is the header's own ('{"format":"dacs-s'): repaired.
  await writeFile(s.ledger,`${manual}\n${ambiguous}s`);
  const journals=await s.boot();s.stop();
  assert.equal(await readFile(s.ledger,'utf8'),`${manual}\n${headerLine(journals)}`);
});

test('Ledger binding: the header of an existing ledger is written by replacing the whole file (a synced temporary file renamed over it), so a crash cannot leave part of a header; a failed replacement leaves the ledger as it was',async t=>{
  const s=await state(t),journals=await s.boot();s.stop();
  await writeFile(s.ledger,mainManualLedger());
  const before=(await stat(s.ledger)).ino;
  // The replacement fails at its rename: the ledger is untouched and no temporary file is left.
  const promises=fs.promises,original=promises.rename;
  promises.rename=async(from,to)=>{if(to===s.ledger)throw Object.assign(new Error('TEST rename fails'),{code:'EIO'});return original(from,to);};
  syncBuiltinESMExports();
  try{await assert.rejects(s.boot(),/TEST rename fails/);}finally{promises.rename=original;syncBuiltinESMExports();s.stop();}
  assert.equal(await readFile(s.ledger,'utf8'),mainManualLedger(),'no header, whole or partial');
  assert.equal((await stat(s.ledger)).ino,before);
  assert.ok((await listing(join(s.directory,'evidence'))).every(name=>!name.endsWith('.tmp')),'no temporary file is left behind');
  // The next start replaces it whole: a new file with the same lines, then the header.
  await s.boot();s.stop();
  assert.equal(await readFile(s.ledger,'utf8'),`${mainManualLedger()}${headerLine(journals)}`);
  assert.notEqual((await stat(s.ledger)).ino,before,'renamed into place, not appended');
  assert.equal((await stat(s.ledger)).mode&0o777,0o600);
});

test('Ledger binding: two enrolments at once write exactly one header; the second refuses on the state lock',async t=>{
  const s=await state(t),journals=await s.boot();s.stop();
  // Binding present, header absent: the state a crash between the two leaves.
  await writeFile(s.ledger,mainManualLedger());
  const other=[];t.after(()=>{for(const close of other.reverse())close();});
  const results=await Promise.allSettled([s.boot(),openSellerIssuanceJournals({directory:s.directory,sellerRecords:true,opened:other,now:()=>7})]);
  assert.deepEqual(results.map(r=>r.status).sort(),['fulfilled','rejected']);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'seller_state_locked');
  assert.equal(await readFile(s.ledger,'utf8'),`${mainManualLedger()}${headerLine(journals)}`);
  s.stop();for(const close of other.splice(0).reverse())close();
  // Started again with the header present, it is read and validated, not appended.
  await s.boot();s.stop();assert.equal(await readFile(s.ledger,'utf8'),`${mainManualLedger()}${headerLine(journals)}`);
});

test('a review: an approved policy line from before reservation ids, with no completion, does not block enrolment (restart holds it unlabelled); one with a reservationId does',async t=>{
  const legacy=`${mainLine('SettlementEvidence',2,{approvalMode:'policy',policyReason:null})}\n`;
  const s=await state(t);await mkdir(join(s.directory,'evidence'),{mode:0o700});await writeFile(s.ledger,legacy);
  const journals=await s.boot();s.stop();
  assert.equal(await readFile(s.ledger,'utf8'),`${legacy}${headerLine(journals)}`);
  const r=await state(t);await mkdir(join(r.directory,'evidence'),{mode:0o700});
  const reserved=`${mainPolicy(2,randomUUID())}\n`;await writeFile(r.ledger,reserved);
  await assert.rejects(r.boot(),{message:SELLER_JOURNAL_REFUSALS.unboundHeld});
});
