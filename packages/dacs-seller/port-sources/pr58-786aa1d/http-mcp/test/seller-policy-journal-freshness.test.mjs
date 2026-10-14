import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSellerIssuanceJournals, SELLER_JOURNAL_REFUSALS } from '../src/devnet-demo/operator.mjs';
import { createExactOperatorApproval, heldPolicyBudget, parsePolicyLedger } from '../src/devnet-demo/operator-approval.mjs';
import { sellerJournalIssuance } from '../src/devnet-demo/seller-issuance.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

// Restart reconciliation against restored issuance journals (Daybreak P2,
// int58; r6 P1). Journals are opened as the operator opens them, and the
// journal reader is the operator's own (seller-issuance.mjs, wired in
// operator.mjs). Since r6 no journal state releases a reservation: the
// reader only labels what restart holds.
const names=['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite'];
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const wallet=`0x${'a'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`;

async function state(t,label){
  const directory=await mkdtemp(join(tmpdir(),`seller-journal-freshness-${label}-`));
  const opened=[];t.after(async()=>{for(const close of opened.splice(0).reverse())close();await rm(directory,{recursive:true,force:true});});
  const s={directory,opened,ledger:join(directory,'evidence','seller-approvals.jsonl'),binding:join(directory,'evidence','seller-issuance-journals.json'),
    boot:async()=>{s.journals=await openSellerIssuanceJournals({directory,sellerRecords:true,opened});return s.journals;},
    stop:()=>{for(const close of opened.splice(0).reverse())close();},
    // The operator's journal order (operator.mjs).
    issuance:(request)=>{const [transport,artifacts,sellerWallet]=s.journals;return sellerJournalIssuance({journals:[artifacts,sellerWallet,transport]},request);},
    reconcile:()=>createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:s.ledger,now:()=>2_000,
      sellerApproval:{mode:'policy',maxWritesPerHour:1,maxTotalOsPerHour:'10000000000',maxWriteTotalOs:'10000000000'},
      policy:{address:wallet,seller,sourceBinding:{},purchaseSource:'seller',resolvePurchase:()=>null,listingPin:()=>null,issuance:s.issuance}}).reconcile(),
    // Copies the three closed journal files (the operator has stopped).
    snapshot:async(to)=>{await mkdir(to,{recursive:true});for(const name of names)await copyFile(join(directory,name),join(to,name));},
    restore:async(from)=>{for(const name of names){for(const suffix of ['','-wal','-shm'])await rm(`${join(directory,name)}${suffix}`,{force:true});await copyFile(join(from,name),join(directory,name));}},
  };
  return s;
}
// One confirmed policy reservation with no completion, as decide() writes it.
function reservation(nonce){
  const request={method:'sendTransaction',address:wallet,content:{artifactKind:'FinalityCommitmentRecord',jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',wallet,nonce,timestamp:nonce*10,exactCreate:`{"TEST":${nonce}}`,debit:{totalOs:'4000000000'}}};
  const requestBytes=JSON.stringify(request),reservationId=randomUUID(),approvalHash=sha(requestBytes);
  const line=`${JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash,requestBytes,method:'sendTransaction',address:wallet,totalOs:'4000000000',decision:'approved',approvalMode:'policy',policyReason:null,reservationId,recordedAt:1_000})}\n`;
  return {request,reservationId,approvalHash,line};
}
const budget=async(s)=>heldPolicyBudget(parsePolicyLedger(await readFile(s.ledger,'utf8')).rows,2_000).writes;
const signedRecord=(nonce)=>({stage:'broadcast-started',hash:'f'.repeat(64),nonce,signedTransaction:{content:{from:wallet,nonce,timestamp:nonce*10,data:['storageProgram',{TEST:'another write'}]}}});

test('Daybreak P2: a complete foreign journal set restored with its own matching binding is refused against the preserved ledger, and the reservation stays held',async t=>{
  const a=await state(t,'a'),b=await state(t,'b');
  await a.boot();a.stop();await b.boot();b.stop();
  assert.notEqual(await readFile(a.binding,'utf8'),await readFile(b.binding,'utf8'),'the two journal identities differ');
  const r=reservation(1);await appendFile(a.ledger,r.line);
  const ledger=await readFile(a.ledger,'utf8');
  assert.equal(await budget(a),1,'the one-write budget starts held');
  // The restore replaces all three journals and the binding with state B's, consistently.
  await b.snapshot(join(a.directory,'from-b'));await a.restore(join(a.directory,'from-b'));await copyFile(b.binding,a.binding);
  await assert.rejects(a.boot(),{message:SELLER_JOURNAL_REFUSALS.headerMismatch});
  assert.equal(await readFile(a.ledger,'utf8'),ledger,'the ledger is not rewritten');assert.equal(await budget(a),1,'the budget is unchanged');
  // The same restore over a ledger rewritten without its header (Daybreak's own probe) is refused too.
  await writeFile(a.ledger,r.line);
  await assert.rejects(a.boot(),{message:SELLER_JOURNAL_REFUSALS.unboundHeld});
  assert.equal(await readFile(a.ledger,'utf8'),r.line);assert.equal(await budget(a),1);
  // Behind the startup refusal: read directly, B's journals still cannot release it.
  a.journals=names.map(name=>{const j=openDurableWalletJournal({path:join(a.directory,name),mode:'open'});a.opened.push(()=>j.close());return j;});
  assert.equal(await a.issuance(r.request,{reservationId:r.reservationId,approvalHash:r.approvalHash}),'unknown');
  const result=await a.reconcile();
  assert.deepEqual(result.released,[]);assert.deepEqual(result.held.map(item=>[item.reservationId,item.state]),[[r.reservationId,'issuance-unknown']]);
  assert.equal(await readFile(a.ledger,'utf8'),r.line);assert.equal(await budget(a),1);
});

test('no positive control since r6: a reservation with nothing issued after it is never released at restart (its write may have been signed)',async t=>{
  const s=await state(t,'control');await s.boot();
  const r=reservation(3);await appendFile(s.ledger,r.line);s.stop();
  await s.boot();const ledger=await readFile(s.ledger,'utf8');
  const result=await s.reconcile();
  assert.deepEqual(result.released,[]);assert.deepEqual(result.held.map(item=>[item.reservationId,item.state]),[[r.reservationId,'issuance-unknown']]);
  assert.equal(await readFile(s.ledger,'utf8'),ledger);assert.equal(await budget(s),1);
});

test('an older snapshot of the same journals, taken before the reservation, passes the identity checks and still keeps the reservation held',async t=>{
  const s=await state(t,'snapshot');await s.boot();s.stop();
  await s.snapshot(join(s.directory,'older'));
  await s.boot();
  const r=reservation(4);await appendFile(s.ledger,r.line);
  // The write went out: its broadcast-started marker is retained.
  await s.journals[2].put('TEST/seller-lane',{...signedRecord(4),signedTransaction:{content:{from:wallet,nonce:4,timestamp:40,data:['storageProgram',JSON.parse(r.request.content.exactCreate)]}}});
  s.stop();
  await s.restore(join(s.directory,'older'));
  const ledger=await readFile(s.ledger,'utf8');
  const journals=await s.boot();
  assert.equal(journals.length,3,'same creation IDs: the binding and header checks pass');
  const result=await s.reconcile();
  assert.deepEqual(result.released,[]);assert.deepEqual(result.held.map(item=>[item.reservationId,item.state]),[[r.reservationId,'issuance-unknown']]);
  assert.equal(await readFile(s.ledger,'utf8'),ledger,'the ledger is not rewritten');assert.equal(await budget(s),1,'the budget is unchanged');
});

test('a reservation confirmed by an older build (no sign-authorized line) stays held, with the budget and ledger unchanged',async t=>{
  const s=await state(t,'missing');await s.boot();
  const r=reservation(5);await appendFile(s.ledger,r.line);s.stop();
  await s.boot();const ledger=await readFile(s.ledger,'utf8');
  assert.equal(await s.issuance(r.request,{reservationId:r.reservationId,approvalHash:r.approvalHash}),'unknown');
  const result=await s.reconcile();
  assert.deepEqual(result.released,[]);assert.deepEqual(result.held.map(item=>[item.reservationId,item.state]),[[r.reservationId,'issuance-unknown']]);
  assert.equal(await readFile(s.ledger,'utf8'),ledger);assert.equal(await budget(s),1);
});

test('the journal reader only labels: issued for this reservation\'s exact signed bytes, otherwise unknown, and no record is ever release proof',async t=>{
  const s=await state(t,'exact');await s.boot();
  const [transport,artifacts,sellerWallet]=s.journals;
  const r=reservation(9);
  assert.equal(await s.issuance(r.request),'unknown','nothing retained');
  // A round-5 checkpoint record, or a signed write of another nonce: still unknown.
  await transport.put(`seller-policy/reservation-checkpoint/${r.reservationId}`,{format:'dacs-seller-policy-reservation-checkpoint/v1',reservationId:r.reservationId,approvalHash:r.approvalHash,wallet,nonce:9,timestamp:90});
  await transport.put('TEST/later-write',signedRecord(2));
  assert.equal(await s.issuance(r.request),'unknown');
  // Its exact signed bytes, in any of the three journals: issued.
  await sellerWallet.put('TEST/seller-lane',{...signedRecord(9),signedTransaction:{content:{from:wallet,nonce:9,timestamp:90,data:['storageProgram',JSON.parse(r.request.content.exactCreate)]}}});
  assert.equal(await s.issuance(r.request),'issued');
  assert.equal(await sellerJournalIssuance({journals:[artifacts,transport]},r.request),'unknown','a journal it was not given is not read');
  // Neither answer releases it.
  await appendFile(s.ledger,r.line);
  assert.deepEqual((await s.reconcile()).released,[]);
});
