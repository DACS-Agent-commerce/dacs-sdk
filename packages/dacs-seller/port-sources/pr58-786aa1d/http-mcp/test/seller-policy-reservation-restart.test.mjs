import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalize, contentHash, finalityCommitmentAddress } from '@kynesyslabs/dacs';
import * as operatorModule from '../src/devnet-demo/operator.mjs';
import * as approvalModule from '../src/devnet-demo/operator-approval.mjs';
import { sellerJournalIssuance } from '../src/devnet-demo/seller-issuance.mjs';
import { SELLER_STATE_LOCK_REFUSALS } from '../src/devnet-demo/seller-state-lock.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';

// Daybreak's r6 reservation/restart table, one test per row. Each write runs
// the operator's own order: preparation (sign authority) -> the wallet signs
// -> confirmation -> approved line -> broadcast-started -> broadcast ->
// completion. A crash is a stop without completion; restart is a fresh start
// on the same state directory (journals as the operator opens them) and its
// reconciliation, with the operator's journal reader (operator.mjs).
// Round 7 (Daybreak r6 P1): restart releases nothing. The held-write rows
// (a pre-payment write the policy holds for exact manual approval) are open
// attempts, and each stays held and counted as well.
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const names=['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite'];
const address=`0x${'a'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`,buyer=`did:demos:agent:${'1'.repeat(64)}`;
const pin={listingId:'restart-listing',version:1,contentHash:'b'.repeat(64)},agreementHash='e'.repeat(64);
const sourceBinding={source:'devnet-agreement-transport/v1',bindingVersion:'dacs-demos-network-binding/v1',bindingId:'c'.repeat(64),network:'demos-devnet',chainIdentity:'d'.repeat(64),endpoint:'https://node2.test.invalid/',pinVersion:'TEST-pin',transportAuthority:'TEST-authority'};
const JOB='01ARZ3NDEKTSV4RRFFQ69G5FAW',HELD_JOB='01ARZ3NDEKTSV4RRFFQ69G5FAX',T0=1_800_000_000_000;
const purchase={jobId:JOB,seller,buyer,listingPin:pin,sourceBinding,agreementHash,amountOs:'1000000000',paymentObserved:true,prePaymentOpen:false};
// A job still open before payment: seller records hold its commitment for exact manual approval.
const openPurchase={...purchase,jobId:HELD_JOB,paymentObserved:false,prePaymentOpen:true};
const scriptPath=resolve(fileURLToPath(new URL('../scripts/devnet-demo-seller-release.mjs',import.meta.url)));
// Read through the module namespaces, so that each row also runs (and fails
// on its own) against code without the round-7 release exports.
const {openSellerIssuanceJournals,releaseSellerPolicyAttempt,SELLER_JOURNAL_REFUSALS}=operatorModule;
const {composeSellerApproval,createExactOperatorApproval,heldPolicyBudget,parsePolicyLedger,releaseHeldSellerAttempt,SELLER_LEDGER_HEADER_FORMAT}=approvalModule;

// A paid Deliverable CREATE, as the embedded wallet shows it (same shape as
// test/seller-policy-purchase-source.test.mjs), at a given nonce.
function deliverable(nonce,fulfilmentId='TEST-fulfilment'){
  const artifact={reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:JOB,agreementHash,listing:pin,title:'Restart report',settlementId:'demos:TEST',producer:seller,content:{mediaType:'text/plain; charset=utf-8',text:`TEST ${nonce}`}};
  const logicalAddress=`dacs4:deliverable:${JOB}`,programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=deriveStorageAddress(address,programName,1);
  const tx=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce,timestamp:nonce*10});
  const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:JOB,phase:'deliver-storage-program',phaseIndex:3,listing:pin,agreementHash,fulfilmentId,purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(artifact)};
  tx.content.data[1].metadata.deliveryBinding=deliveryBinding;
  Object.assign(tx.content.data[1].metadata,{contentHash:contentHash(artifact),envelopeHash:sha(canonicalize(artifact)),artifactKind:'Deliverable',networkBinding:sourceBinding});
  const exactStorageBytes=JSON.stringify(artifact);
  return{method:'sendTransaction',address,purpose:'Create immutable Deliverable for this exact job',content:{kind:'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind:'Deliverable',jobId:JOB,owner:seller,wallet:address,
    logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',envelopeHash:sha(canonicalize(artifact)),deliveryBinding,
    storageBytes:Buffer.byteLength(exactStorageBytes),exactStorageBytes,exactCreate:JSON.stringify(tx.content.data[1]),nonce,timestamp:nonce*10,
    debit:{storageFeeDem:'1',sellerAmountDem:'0',sdkGasDem:'1',networkFeeDem:'1',rpcFeeDem:'1',additionalFeeDem:'0',totalDem:'4',totalOs:'4000000000',note:'TEST'},
    network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,networkBinding:sourceBinding,evidence:{},sending:{}}};
}
// The held job's commitment CREATE before payment, at a given nonce.
function commitment(nonce){
  const artifact={finalityCommitmentVersion:'1',jobId:HELD_JOB,pattern:'fixed-price',agreementHash};
  const logicalAddress=finalityCommitmentAddress(HELD_JOB),programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=deriveStorageAddress(address,programName,1);
  const tx=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce,timestamp:nonce*10});
  Object.assign(tx.content.data[1].metadata,{contentHash:contentHash(artifact),envelopeHash:sha(canonicalize(artifact)),artifactKind:'FinalityCommitmentRecord',networkBinding:sourceBinding});
  const exactStorageBytes=JSON.stringify(artifact);
  return{method:'sendTransaction',address,purpose:'Create immutable commitment',content:{kind:'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind:'FinalityCommitmentRecord',jobId:HELD_JOB,owner:seller,wallet:address,
    logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',envelopeHash:sha(canonicalize(artifact)),
    storageBytes:Buffer.byteLength(exactStorageBytes),exactStorageBytes,exactCreate:JSON.stringify(tx.content.data[1]),nonce,timestamp:nonce*10,
    debit:{storageFeeDem:'1',sellerAmountDem:'0',sdkGasDem:'1',networkFeeDem:'1',rpcFeeDem:'1',additionalFeeDem:'0',totalDem:'4',totalOs:'4000000000',note:'TEST'},
    network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,networkBinding:sourceBinding,evidence:{},sending:{}}};
}
const confirmationFor=(r)=>({result:200,response:{data:{valid:true,gas_operation:null,transaction:{content:{type:'storageProgram',amount:'0',from:r.address,nonce:r.content.nonce,timestamp:r.content.timestamp,data:['storageProgram',JSON.parse(r.content.exactCreate)],
  transaction_fee:{network_fee:'1000000000',rpc_fee:'1000000000',additional_fee:'0'},gcr_edits:[{type:'balance',operation:'remove',account:r.address,amount:'1000000000'},{type:'balance',operation:'remove',account:r.address,amount:'1000000000'}]}}}}});
// The wallet's broadcast-started marker: the exact signed write, retained before any broadcast.
const marker=(r)=>({stage:'broadcast-started',hash:'f'.repeat(64),nonce:r.content.nonce,signedTransaction:{content:{from:address,nonce:r.content.nonce,timestamp:r.content.timestamp,data:['storageProgram',JSON.parse(r.content.exactCreate)]}}});

let processes=0;
async function state(t,label){
  const directory=await mkdtemp(join(tmpdir(),`seller-reservation-restart-${label}-`)),opened=[];
  // A write still waiting for the ledger ends with the test (operator close).
  t.after(async()=>{s.approval?.stop?.();for(const close of opened.splice(0).reverse())close();await rm(directory,{recursive:true,force:true});});
  const ledger=join(directory,'evidence','seller-approvals.jsonl');
  const s={directory,ledger,
    // The human at the exact manual prompt (the held job's writes only); by default nobody answers.
    answer:()=>{throw new Error('TEST forbids manual approval');},
    limits:{maxWritesPerHour:1},
    // Between two reads of an unreadable ledger, and two decisions of one write.
    ledgerRetryMs:5,
    async start(issuance){
      s.journals=await openSellerIssuanceJournals({directory,sellerRecords:true,opened,now:()=>T0});
      const [transport,artifacts,sellerWallet]=s.journals;
      // Each start is a new process: a fresh module instance, so no in-memory hold survives a crash.
      const fresh=await import(`../src/devnet-demo/operator-approval.mjs?process=${++processes}`);
      s.approval=fresh.createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:ledger,now:()=>T0,sellerApproval:{mode:'policy',...s.limits},ledgerRetryMs:s.ledgerRetryMs,
        policy:{address,seller,sourceBinding,listingPin:()=>pin,purchaseSource:'seller',resolvePurchase:(jobId)=>structuredClone(jobId===HELD_JOB?openPurchase:purchase),
          issuance:issuance??((request)=>sellerJournalIssuance({journals:[artifacts,sellerWallet,transport]},request))}});
      // Exact manual approval on the same ledger, as the operator wires it.
      const manual=fresh.createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:ledger,now:()=>T0,authorize:async({request})=>s.answer(request)});
      s.manual=manual;s.wallet=fresh.composeSellerApproval({mode:'policy',policy:s.approval,manual});
      return s;
    },
    // The process ends: no completion is written, every handle closes.
    crash(){for(const close of opened.splice(0).reverse())close();s.approval=s.wallet=null;},
    sellerWallet:()=>s.journals[2],
    snapshot:async(to)=>{await mkdir(to,{recursive:true});for(const name of names)await copyFile(join(directory,name),join(to,name));},
    restore:async(from)=>{for(const name of names){for(const suffix of ['','-wal','-shm'])await rm(`${join(directory,name)}${suffix}`,{force:true});await copyFile(join(from,name),join(directory,name));}},
    budget:async()=>heldPolicyBudget(parsePolicyLedger(await readFile(ledger,'utf8')).rows,T0).writes,
  };
  return s;
}
// After restart: nothing released, the reservation (or the open attempt,
// given as {attemptId}) held with this state, the ledger unchanged by
// reconciliation, and its one-write budget still taken.
async function assertHeld(s,id,label){
  const before=await readFile(s.ledger,'utf8'),result=await s.approval.reconcile();
  assert.deepEqual(result.released,[],'restart releases nothing');
  if(typeof id==='string')assert.deepEqual(result.held.map(item=>[item.reservationId,item.state]),[[id,label]]);
  else assert.deepEqual(result.held.map(item=>[item.attemptId,item.reservationId,item.state]),[[id.attemptId,id.reservationId??null,label]]);
  assert.equal(await readFile(s.ledger,'utf8'),before,'reconciliation wrote nothing');
  assert.equal(await s.budget(),1,'the reservation still holds the budget');
  assert.equal(await s.approval.prepare(deliverable(90,'TEST-next')),false,'and a further policy write is refused by it');
  assert.equal(JSON.parse((await readFile(s.ledger,'utf8')).trim().split('\n').at(-1)).policyReason,'hourly-write-limit');
}
const signAuthorized=async(s)=>{const rows=(await readFile(s.ledger,'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.format==='dacs-node2-seller-policy-sign-authorization/v1');assert.equal(rows.length,1);return rows[0];};

test('restart row: crash after preparation granted sign authority, before confirmation (Daybreak "sign -> checkpoint" and "checkpoint -> approved line"): held',async t=>{
  const s=await (await state(t,'sign')).start(),r=deliverable(5);
  assert.equal(await s.wallet(r),true,'sign authority');
  const authorized=await signAuthorized(s);
  assert.equal(authorized.requestBytes,JSON.stringify(r),'the exact operation it authorizes');
  s.crash();await s.start();
  await assertHeld(s,authorized.reservationId,'issuance-unknown');
});

test('restart row: crash after the approved line, before broadcast-started (Daybreak: released in r5): held',async t=>{
  const s=await (await state(t,'approved')).start(),r=deliverable(6);
  assert.equal(await s.wallet(r),true);assert.equal(await s.wallet.confirm(confirmationFor(r)),true);
  const authorized=await signAuthorized(s);
  s.crash();await s.start();
  await assertHeld(s,authorized.reservationId,'issuance-unknown');
});

test('restart rows: crash after broadcast-started, and after the broadcast before completion: held as issued',async t=>{
  const s=await (await state(t,'marker')).start(),r=deliverable(7);
  assert.equal(await s.wallet(r),true);assert.equal(await s.wallet.confirm(confirmationFor(r)),true);
  await s.sellerWallet().put('TEST/seller-lane',marker(r));
  const authorized=await signAuthorized(s);
  s.crash();await s.start();
  await assertHeld(s,authorized.reservationId,'issued-outcome-unknown');
});

test('restart row: a same-ID journal snapshot taken before signing, restored after the write went out: held',async t=>{
  const s=await (await state(t,'before')).start();s.crash();
  await s.snapshot(join(s.directory,'older'));
  await s.start();const r=deliverable(8);
  assert.equal(await s.wallet(r),true);assert.equal(await s.wallet.confirm(confirmationFor(r)),true);
  await s.sellerWallet().put('TEST/seller-lane',marker(r));
  const authorized=await signAuthorized(s);
  s.crash();await s.restore(join(s.directory,'older'));await s.start();
  await assertHeld(s,authorized.reservationId,'issuance-unknown');
});

test('restart row: a same-ID journal snapshot taken after confirmation, before broadcast-started, restored after the write went out (Daybreak: released in r5): held',async t=>{
  const s=await (await state(t,'after')).start(),r=deliverable(9);
  assert.equal(await s.wallet(r),true);assert.equal(await s.wallet.confirm(confirmationFor(r)),true);
  s.crash();await s.snapshot(join(s.directory,'after-confirmation'));
  await s.start();await s.sellerWallet().put('TEST/seller-lane',marker(r));
  const authorized=await signAuthorized(s);
  s.crash();await s.restore(join(s.directory,'after-confirmation'));await s.start();
  await assertHeld(s,authorized.reservationId,'issuance-unknown');
});

test('restart rows: foreign journals behind a forged matching header and binding, with or without a copied round-5 checkpoint record (Daybreak: released in r5): held',async t=>{
  const a=await (await state(t,'own')).start(),r=deliverable(10);
  assert.equal(await a.wallet(r),true);assert.equal(await a.wallet.confirm(confirmationFor(r)),true);
  await a.sellerWallet().put('TEST/seller-lane',marker(r));
  const authorized=await signAuthorized(a);a.crash();
  // A foreign state B; A's ledger is restored over it with its header and binding rewritten to name B's journals.
  const b=await (await state(t,'foreign')).start();
  // A copied exact checkpoint record of round 5, which r5 took as release proof.
  await b.journals[0].put(`seller-policy/reservation-checkpoint/${authorized.reservationId}`,{format:'dacs-seller-policy-reservation-checkpoint/v1',reservationId:authorized.reservationId,approvalHash:authorized.approvalHash,wallet:address,nonce:r.content.nonce,timestamp:r.content.timestamp});
  b.crash();
  const bBinding=await readFile(join(b.directory,'evidence','seller-issuance-journals.json'),'utf8'),bIds=JSON.parse(bBinding).journals;
  const rows=(await readFile(a.ledger,'utf8')).trim().split('\n').map(JSON.parse);
  const forged=rows.map(row=>row.format===SELLER_LEDGER_HEADER_FORMAT?{...row,journals:bIds}:row).map(row=>`${JSON.stringify(row)}\n`).join('');
  await writeFile(b.ledger,forged);
  await b.start();
  await assertHeld(b,authorized.reservationId,'issuance-unknown');
  // The preserved header against B's journals is refused instead (Daybreak: safe).
  b.crash();await writeFile(b.ledger,await readFile(a.ledger,'utf8'));
  await assert.rejects(b.start(),{message:SELLER_JOURNAL_REFUSALS.headerMismatch});
});

test('restart row: a preparation refused before sign authority leaves nothing reserved; restart has nothing to release or hold',async t=>{
  const s=await (await state(t,'refused')).start();
  const first=deliverable(11);
  assert.equal(await s.wallet(first),true);assert.equal(await s.wallet.confirm(confirmationFor(first)),true);await s.wallet.settle(first,'released');
  // The one-write budget is free again; a refused preparation retains no sign-authorized line.
  const r=deliverable(12);r.content.debit.rpcFeeDem='8';
  assert.equal(await s.approval.prepare(r),false);
  const lines=(await readFile(s.ledger,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.at(-1).decision,'rejected');assert.equal(lines.filter(row=>row.format.endsWith('sign-authorization/v1')).length,1,'only the first write was sign-authorized');
  s.crash();await s.start();
  assert.deepEqual(await s.approval.reconcile(),{released:[],held:[]});
});

test('restart: a journal reader that throws, answers junk, "none" or a "not found" style string never releases a sign-authorized reservation',async t=>{
  for(const [label,issuance] of [['throws',()=>{throw new Error('TEST journal lost');}],['junk',()=>({released:true})],['none',()=>'none'],['not found',()=>'not found'],['released',async()=>'released']]){
    const s=await (await state(t,`reader-${label.replace(' ','-')}`)).start(),r=deliverable(13);
    assert.equal(await s.wallet(r),true);assert.equal(await s.wallet.confirm(confirmationFor(r)),true);
    const authorized=await signAuthorized(s);
    s.crash();await s.start(issuance);
    await assertHeld(s,authorized.reservationId,'issuance-unknown');
  }
});

test('restart row: a corrupt bound journal refuses startup before reconciliation, and the ledger is untouched',async t=>{
  const s=await (await state(t,'corrupt')).start(),r=deliverable(14);
  assert.equal(await s.wallet(r),true);
  s.crash();const ledger=await readFile(s.ledger,'utf8');
  await writeFile(join(s.directory,names[0]),'TEST not a journal');
  await assert.rejects(s.start(),/seller issuance journal node2-transport\.sqlite refused/);
  assert.equal(await readFile(s.ledger,'utf8'),ledger);
});

test('a live process: the wallet\'s own completion ends the sign-authorized reservation; released before confirmation it carries the reason',async t=>{
  const s=await (await state(t,'live')).start(),r=deliverable(15);
  assert.equal(await s.wallet(r),true);
  await s.wallet.settle(r,'released');
  const end=(await readFile(s.ledger,'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([end.format,end.reservationId,end.outcome,end.reason],['dacs-node2-seller-policy-attempt/v1',(await signAuthorized(s)).reservationId,'released','wallet-released']);
  assert.equal(await s.budget(),0);
  // Released once: a second completion for the same request writes nothing.
  const before=await readFile(s.ledger,'utf8');await s.wallet.settle(r,'released');assert.equal(await readFile(s.ledger,'utf8'),before);
  assert.equal(randomUUID().length,36);
});

test('the sign-authorized line is synced to disk before preparation answers true',async t=>{
  const s=await (await state(t,'synced')).start(),r=deliverable(16);
  // Each fsync of the ledger records what the file held then.
  const original=fs.fsyncSync,synced=[];let answered=false;
  fs.fsyncSync=function(fd,...rest){
    let path=null;try{path=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}
    if(path===s.ledger)synced.push({answered,text:fs.readFileSync(s.ledger,'utf8')});
    return original.call(this,fd,...rest);
  };
  syncBuiltinESMExports();
  try{assert.equal(await s.wallet(r),true);answered=true;}
  finally{fs.fsyncSync=original;syncBuiltinESMExports();}
  const before=synced.filter(entry=>!entry.answered);
  assert.equal(before.length,1,'one ledger sync before the answer');
  assert.ok(before[0].text.includes('"format":"dacs-node2-seller-policy-sign-authorization/v1"')&&before[0].text.includes(JSON.stringify(JSON.stringify(r))),'it holds the sign-authorized line with the exact bytes');
});

// Round 7 (Daybreak r6 P1): the held-write rows. The held job's commitment
// waits at the exact manual prompt; each crash point leaves an open attempt,
// held and counted after restart. Restart writes nothing for any of them.
const ledgerRows=async(s)=>(await readFile(s.ledger,'utf8')).trim().split('\n').map(JSON.parse);
const holdOf=async(s)=>(await ledgerRows(s)).filter(row=>row.policyReason==='cancellation-unknown'&&row.decision==='rejected').at(-1);

test('restart row (r7): crash while a held write waits at the manual prompt, with only its hold line: held (approval-unknown) and counted, never released',async t=>{
  const s=await (await state(t,'held-prompt')).start();
  assert.equal(await s.approval.prepare(commitment(20)),false,'held for exact manual approval');
  const hold=await holdOf(s);
  s.crash();await s.start();
  await assertHeld(s,{attemptId:hold.attemptId},'approval-unknown');
});

test('restart row (r7, code r6 P3-3): crash after the operator approved a held write by hand, before its sign-authorized line: held (approved-sign-unknown) and counted',async t=>{
  const s=await (await state(t,'held-approved')).start();
  s.answer=()=>true;s.approval.authorizeSign=async()=>{throw new Error('TEST the process ends before the sign-authorized line');};
  await assert.rejects(s.wallet(commitment(21)),/TEST the process ends/);
  const hold=await holdOf(s);
  assert.deepEqual((await ledgerRows(s)).slice(-2).map(row=>[row.attemptId,row.approvalMode??'manual',row.decision]),[[hold.attemptId,'policy','rejected'],[hold.attemptId,'manual','approved']]);
  s.crash();await s.start();
  await assertHeld(s,{attemptId:hold.attemptId},'approved-sign-unknown');
});

test('restart row (r7): crash after a held write\'s sign-authorized line, before its confirmation: held and counted as that reservation',async t=>{
  const s=await (await state(t,'held-signed')).start();
  s.answer=()=>true;assert.equal(await s.wallet(commitment(22)),true,'the wallet may sign');
  const authorized=await signAuthorized(s);
  assert.equal(authorized.attemptId,(await holdOf(s)).attemptId);
  s.crash();await s.start();
  await assertHeld(s,{attemptId:authorized.attemptId,reservationId:authorized.reservationId},'issuance-unknown');
});

test('restart row (r7, Daybreak r6 P1 probe): the ledger snapshot taken at the manual prompt, restored after the wallet may have signed: held (approval-unknown) and counted, nothing released',async t=>{
  const s=await (await state(t,'rollback')).start();
  let older;
  s.answer=async()=>{older=await readFile(s.ledger,'utf8');return true;};
  assert.equal(await s.wallet(commitment(23)),true,'the wallet may now sign');
  assert.equal(parsePolicyLedger(await readFile(s.ledger,'utf8')).rows.filter(row=>row.signAuthorized).length,1,'the current ledger holds sign authority');
  s.crash();await writeFile(s.ledger,older);await s.start();
  const hold=await holdOf(s);
  assert.equal(parsePolicyLedger(older).rows.filter(row=>row.signAuthorized).length,0,'the restored ledger lacks it');
  await assertHeld(s,{attemptId:hold.attemptId},'approval-unknown');
});

test('restart row (r7, code r6 P3-4 mutant R2): crash after a refused confirmation, before its completion line: the sign-authorized reservation stays held and counted',async t=>{
  const s=await (await state(t,'refused')).start(),r=deliverable(24);
  assert.equal(await s.wallet(r),true);
  const over=confirmationFor(r);over.response.data.transaction.content.gcr_edits[1].amount='9000000000';
  assert.equal(await s.wallet.confirm(over),false,'a debit above the declaration is refused');
  const authorized=await signAuthorized(s),rows=await ledgerRows(s);
  assert.deepEqual([rows.at(-2).reservationId,rows.at(-2).decision,rows.at(-1).reason],[authorized.reservationId,'rejected','confirmation-refused']);
  // The process ended between the refused confirmation line and its completion line.
  s.crash();await writeFile(s.ledger,rows.slice(0,-1).map(row=>`${JSON.stringify(row)}\n`).join(''));await s.start();
  await assertHeld(s,authorized.reservationId,'issuance-unknown');
});

// An operator config naming this state directory with seller records. The
// release reads only stateDirectory and sellerApproval from it.
async function operatorConfig(s){
  const path=join(s.directory,'operator.json');
  await writeFile(path,JSON.stringify({format:'dacs-node2-demo-operator/v1',authority:'TEST-RUN-release',publicOrigin:'http://127.0.0.1:41001',sellerOrigin:'https://127.0.0.1:41002',sellerTls:{keyPath:join(s.directory,'k'),certificatePath:join(s.directory,'c')},directoryOrigin:'http://127.0.0.1:41003',
    stateDirectory:s.directory,custodyDirectory:join(s.directory,'custody'),networkAdmissionPath:join(s.directory,'admission.json'),
    listing:{listingId:'operator-native-report',listingVersion:1,displayName:'Operator Seller',title:'t',description:'d',category:'services.market-report',tags:[],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
    sellerFeeBudget:{maxTotalOs:'10000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'x'},sellerApproval:{mode:'policy',purchaseSource:'seller'}}),{mode:0o600});
  return path;
}

test('operator release (r7): only an explicit release naming the attemptId ends a held attempt; it is refused for an unknown or completed attempt and beside a running operator, and logged on the ledger',async t=>{
  const s=await state(t,'release');s.limits={maxWritesPerHour:3};await s.start();
  assert.equal(await s.approval.prepare(commitment(30)),false,'held at the prompt');
  const prompt=await holdOf(s);
  s.answer=()=>false;assert.equal(await s.wallet(commitment(32)),false,'declined by hand');
  const declined=(await ledgerRows(s)).at(-1);
  assert.deepEqual([declined.outcome,declined.reason],['released','manual-declined']);
  // Last, since the wallet's next approval would replace an unconfirmed one.
  s.answer=()=>true;assert.equal(await s.wallet(commitment(31)),true,'approved by hand and sign-authorized');
  const signed=await signAuthorized(s);
  const config=await operatorConfig(s),running=await readFile(s.ledger,'utf8');
  // Beside the running operator, which holds the state lock: refused, nothing written.
  await assert.rejects(releaseSellerPolicyAttempt({configPath:config,attemptId:prompt.attemptId}),{code:'seller_state_locked',message:SELLER_STATE_LOCK_REFUSALS.held});
  assert.equal(await readFile(s.ledger,'utf8'),running);
  // Restart holds both open attempts and counts them.
  s.crash();await s.start();
  assert.deepEqual((await s.approval.reconcile()).held.map(item=>[item.attemptId,item.state]),[[prompt.attemptId,'approval-unknown'],[signed.attemptId,'issuance-unknown']]);
  assert.equal(await s.budget(),2);
  s.crash();
  // Refused with nothing written: an unknown attemptId, one that already ended, or no attemptId.
  for(const [attemptId,message] of [[randomUUID(),/is not on the approval ledger; nothing was released/],[declined.attemptId,/already ended released; nothing was released/],['TEST',/exact attemptId/]]){
    await assert.rejects(releaseSellerPolicyAttempt({configPath:config,attemptId}),message);
    assert.equal(await readFile(s.ledger,'utf8'),running);
  }
  // Released: one synced line naming the attempt, and its reservation once it was sign-authorized.
  const released=await releaseSellerPolicyAttempt({configPath:config,attemptId:signed.attemptId,now:()=>T0+1});
  assert.deepEqual([released.attemptId,released.reservationId,released.state,released.reason],[signed.attemptId,signed.reservationId,'sign-authorized','operator-released']);
  assert.deepEqual((await ledgerRows(s)).at(-1),{format:'dacs-node2-seller-policy-attempt/v1',reservationId:signed.reservationId,approvalHash:signed.approvalHash,attemptId:signed.attemptId,outcome:'released',reason:'operator-released',recordedAt:T0+1});
  assert.equal(await s.budget(),1);
  await assert.rejects(releaseSellerPolicyAttempt({configPath:config,attemptId:signed.attemptId}),/already ended released/,'a second release is refused');
  // The command, for the attempt held at the prompt. Its children keep Node's
  // warnings: the refusal is matched as one whole stderr line, wherever it is.
  const cli=spawnSync(process.execPath,[scriptPath,`--config=${config}`,`--attempt=${prompt.attemptId}`],{encoding:'utf8',timeout:120000});
  assert.equal(cli.status,0,cli.stderr);
  const answer=JSON.parse(cli.stdout);
  assert.deepEqual([answer.status,answer.attemptId,answer.reservationId,answer.state,answer.reason],['released',prompt.attemptId,null,'approval-unknown','operator-released']);
  assert.deepEqual((({attemptId,outcome,reason})=>({attemptId,outcome,reason}))((await ledgerRows(s)).at(-1)),{attemptId:prompt.attemptId,outcome:'released',reason:'operator-released'});
  assert.equal(await s.budget(),0,'released attempts count nothing');
  const refusal=`seller-policy-release refused: seller policy attempt ${prompt.attemptId} already ended released; nothing was released`;
  const refusals=(stderr)=>stderr.split('\n').filter(line=>line===refusal).length;
  const again=spawnSync(process.execPath,[scriptPath,`--config=${config}`,`--attempt=${prompt.attemptId}`],{encoding:'utf8',timeout:120000});
  assert.equal(again.status,1);assert.equal(refusals(again.stderr),1,again.stderr);
  // Final review 2 P1: a Node warning printed before the refusal (here one the
  // child emits itself, with NODE_USE_ENV_PROXY set as well) changes nothing.
  const warned=spawnSync(process.execPath,['--import=data:text/javascript,process.emitWarning("TEST warning before the refusal")',scriptPath,`--config=${config}`,`--attempt=${prompt.attemptId}`],
    {encoding:'utf8',timeout:120000,env:{...process.env,NODE_USE_ENV_PROXY:'1'}});
  assert.equal(warned.status,1);
  assert.ok(warned.stderr.indexOf('Warning: TEST warning before the refusal')>=0&&warned.stderr.indexOf('Warning: TEST warning before the refusal')<warned.stderr.indexOf(refusal),warned.stderr);
  assert.equal(refusals(warned.stderr),1,warned.stderr);
  // The next start holds nothing.
  await s.start();assert.deepEqual(await s.approval.reconcile(),{released:[],held:[]});
  assert.equal(await releaseHeldSellerAttempt({evidencePath:s.ledger,attemptId:prompt.attemptId}).catch(error=>error.message),`seller policy attempt ${prompt.attemptId} already ended released; nothing was released`);
});

// Code review r6 P3-2: a sign-authorized line that is written but not synced.
function failLedgerSync(s){
  const original=fs.fsyncSync;let failed=0;
  fs.fsyncSync=function(fd,...rest){
    let path=null;try{path=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}
    if(path===s.ledger&&!failed++)throw Object.assign(new Error('TEST EIO'),{code:'EIO'});
    return original.call(this,fd,...rest);
  };
  syncBuiltinESMExports();
  return()=>{fs.fsyncSync=original;syncBuiltinESMExports();};
}

test('a sign-authorized line whose sync fails (code review r6 P3-2): preparation refuses, the line is ended released, its refusal takes a fresh reservationId, and the ledger stays readable',async t=>{
  const s=await (await state(t,'sync-fails')).start();
  const restore=failLedgerSync(s);
  try{assert.equal(await s.approval.prepare(deliverable(40)),false,'nothing may be signed');}finally{restore();}
  const rows=await ledgerRows(s),sign=rows.find(row=>row.format.endsWith('sign-authorization/v1')),refusal=rows.at(-1);
  assert.ok(sign,'the line was written before its sync failed');
  assert.deepEqual(rows.filter(row=>row.reservationId===sign.reservationId).map(row=>[row.format,row.outcome??null,row.reason??null]),
    [['dacs-node2-seller-policy-sign-authorization/v1',null,null],['dacs-node2-seller-policy-attempt/v1','released','sign-authorization-failed']]);
  assert.deepEqual([refusal.decision,refusal.policyReason],['rejected','sign-authorization-unavailable']);assert.notEqual(refusal.reservationId,sign.reservationId);
  assert.equal(await s.budget(),0,'it holds nothing');
  assert.equal(await s.approval.prepare(deliverable(41)),true,'the ledger reads: the next write is decided normally');
});

// Final review fe58 finding 2: before payment a refusal would be final for the artifact.
test('a held write approved by hand whose sign-authorized line does not sync (code review r6 P3-2) is not signed then: its attempt ends released, and it is not refused but decided again, as a new hold for a new exact manual approval',async t=>{
  const s=await (await state(t,'held-sync-fails')).start();
  let asked=0;s.answer=()=>{asked++;return true;};
  const restore=failLedgerSync(s);
  try{assert.equal(await s.wallet(commitment(43)),true,'not refused');}finally{restore();}
  assert.equal(asked,2,'the operator approved it again');
  const rows=await ledgerRows(s),[first,second]=[...new Set(rows.filter(row=>row.attemptId).map(row=>row.attemptId))];
  const kinds=(id)=>rows.filter(row=>row.attemptId===id).map(row=>row.format.endsWith('attempt/v1')?`end:${row.outcome}:${row.reason}`:row.format.endsWith('sign-authorization/v1')?'sign':row.approvalMode?'hold':'manual');
  assert.deepEqual(kinds(first),['hold','manual','sign','end:released:sign-authorization-failed'],'the line that did not sync is never signed');
  assert.deepEqual(kinds(second),['hold','manual','sign']);
  assert.equal(await s.budget(),1,'only the second attempt holds the budget');
  s.crash();await s.start();
  assert.deepEqual((await s.approval.reconcile()).held.map(item=>[item.attemptId,item.state]),[[second,'issuance-unknown']]);
});

test('the sign-authorized line is written whole even when the file takes it a few bytes at a time (code review r6 P3-2)',async t=>{
  const s=await (await state(t,'short-writes')).start();
  const original=fs.writeSync;let calls=0;
  fs.writeSync=function(fd,data,...rest){
    let path=null;try{path=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}
    if(path!==s.ledger)return original.call(this,fd,data,...rest);
    calls++;
    if(typeof data==='string')return original.call(this,fd,data.slice(0,7));
    const [offset=0,length=data.length-offset]=rest;return original.call(this,fd,data,offset,Math.min(length,7));
  };
  syncBuiltinESMExports();
  try{assert.equal(await s.approval.prepare(deliverable(42)),true);}finally{fs.writeSync=original;syncBuiltinESMExports();}
  assert.ok(calls>1,'the line took several writes');
  assert.equal(parsePolicyLedger(await readFile(s.ledger,'utf8')).rows.find(row=>row.signAuthorized)?.request.content.nonce,42,'and it reads whole');
});

// Final review fe58 finding 2: an approval ledger that does not read. Seller
// records refuse to start on it, naming the file and line. At runtime a write
// before payment is never refused because of it (that refusal would be final
// for its artifact): it waits, unsigned, and is decided once the ledger reads.
const until=async(check,label)=>{for(let i=0;i<2000;i++){if(check())return;await new Promise(done=>setTimeout(done,5));}assert.fail(`timed out: ${label}`);};
function stderrLines(t){
  const lines=[],write=process.stderr.write;
  t.mock.method(process.stderr,'write',function(chunk,...rest){lines.push(String(chunk));return write.call(this,chunk,...rest);});
  return lines;
}
const unreadableAt=(s,line)=>(text)=>text.startsWith(`seller-policy-ledger unreadable: ${s.ledger} line ${line} (`);
// The corrected ledger replaces the broken one whole, so a waiting read never sees it half written.
const replaceLedger=async(s,text)=>{await writeFile(`${s.ledger}.TEST`,text);fs.renameSync(`${s.ledger}.TEST`,s.ledger);};

test('seller records refuse to start on an approval ledger that does not read, naming the file and the line; nothing is written, and the corrected ledger starts',async t=>{
  const s=await (await state(t,'start-unreadable')).start();
  s.answer=()=>true;
  assert.equal(await s.wallet(commitment(50)),true);
  s.crash();
  const good=await readFile(s.ledger,'utf8'),count=good.trim().split('\n').length,hold=JSON.parse(good.trim().split('\n')[1]);
  // A JSON typo, and a completion appended by hand that names no reservation on the ledger.
  for(const typo of ['{truncated',JSON.stringify({format:'dacs-node2-seller-policy-attempt/v1',reservationId:randomUUID(),approvalHash:hold.approvalHash,outcome:'spent',recordedAt:T0})]){
    await writeFile(s.ledger,`${good}${typo}\n`);
    await assert.rejects(s.start(),(error)=>{
      assert.equal(error.message.startsWith(`${SELLER_JOURNAL_REFUSALS.ledgerUnreadable}: ${s.ledger} line ${count+1} (`),true,error.message);
      return true;
    });
    assert.equal(await readFile(s.ledger,'utf8'),`${good}${typo}\n`,'nothing was written');
  }
  // With the line corrected, the same state starts (the refusal released the state lock) and holds what it held.
  await writeFile(s.ledger,good);await s.start();
  assert.deepEqual((await s.approval.reconcile()).held.map(item=>item.attemptId),[hold.attemptId]);
});

test('the review repro: a ledger that stops reading at runtime holds an open job\'s commitment unsigned instead of refusing it, says so on stderr, and decides it once the ledger reads',async t=>{
  const s=await (await state(t,'runtime-unreadable')).start(),stderr=stderrLines(t);
  const asked=[];s.answer=(request)=>{asked.push(request.content.nonce);return true;};
  // Readable: the commitment is held for the human, who approves it.
  const first=commitment(30);
  assert.equal(await s.wallet(first),true);assert.deepEqual(asked,[30]);
  await s.wallet.settle(first,'released');
  // One malformed line appended while the operator runs.
  const good=await readFile(s.ledger,'utf8'),line=good.trim().split('\n').length+1;
  await appendFile(s.ledger,'{truncated\n');
  let answer;const pending=s.wallet(commitment(31)).then(value=>{answer=value;return value;});
  await until(()=>answer!==undefined||stderr.some(unreadableAt(s,line)),'the unreadable ledger is reported');
  await new Promise(done=>setTimeout(done,100));
  assert.equal(answer,undefined,'neither refused nor approved');assert.deepEqual(asked,[30],'and not yet at the prompt');
  assert.equal(await readFile(s.ledger,'utf8'),`${good}{truncated\n`,'nothing was written');
  assert.match(stderr.find(unreadableAt(s,line)),/FinalityCommitmentRecord write for job 01ARZ3NDEKTSV4RRFFQ69G5FAX waits, unsigned and not refused/);
  // The line is corrected: the same write is decided, held and approved by the human.
  await replaceLedger(s,good);
  assert.equal(await pending,true);assert.deepEqual(asked,[30,31]);
  assert.ok(stderr.some(text=>text.startsWith('seller-policy-ledger readable again: deciding the FinalityCommitmentRecord write for job 01ARZ3NDEKTSV4RRFFQ69G5FAX')));
  const rows=(await ledgerRows(s)).slice(good.trim().split('\n').length);
  assert.deepEqual(rows.map(row=>row.format.endsWith('sign-authorization/v1')?'sign':row.approvalMode?`hold:${row.policyReason}`:'manual'),['hold:cancellation-unknown','manual','sign']);
});

const within=(promise,ms,label)=>Promise.race([promise,new Promise((_,fail)=>setTimeout(()=>fail(new Error(`not within ${ms} ms: ${label}`)),ms).unref())]);
test('a write waiting for an unreadable ledger is never decided after the approval stops (operator close): it ends at once with an error and nothing is written',async t=>{
  const unstarted=await state(t,'stop-unreadable');unstarted.ledgerRetryMs=60_000;
  const s=await unstarted.start(),stderr=stderrLines(t);
  const good=await readFile(s.ledger,'utf8');await appendFile(s.ledger,'{truncated\n');
  let settled=false;const pending=s.wallet(commitment(32)).finally(()=>{settled=true;});
  await until(()=>settled||stderr.some(text=>text.startsWith('seller-policy-ledger unreadable: ')),'the wait began');
  assert.equal(settled,false,'it waits, undecided');
  s.approval.stop();
  await assert.rejects(within(pending,2000,'stop ends the wait'),{message:'seller policy stopped while its approval ledger could not be read; nothing was decided, written or signed'});
  await replaceLedger(s,good);await new Promise(done=>setTimeout(done,50));
  assert.equal(await readFile(s.ledger,'utf8'),good,'nothing was written, then or later');
  // The same for a held write the human approved, waiting for its sign authorization: not even its release is written.
  const u=await (await state(t,'stop-sign-unreadable')).start();
  u.answer=()=>{fs.appendFileSync(u.ledger,'{truncated\n');return true;};
  let done=false;const signing=u.wallet(commitment(35)).finally(()=>{done=true;});
  await until(()=>done||stderr.filter(text=>text.startsWith(`seller-policy-ledger unreadable: ${u.ledger}`)).length>0,'the sign authorization waits');
  assert.equal(done,false,'it waits, undecided');
  const waiting=await readFile(u.ledger,'utf8');
  u.approval.stop();
  await assert.rejects(signing,{message:'seller policy stopped while its approval ledger could not be read; nothing was decided, written or signed'});
  await replaceLedger(u,waiting.replace('{truncated\n',''));await new Promise(done=>setTimeout(done,50));
  assert.equal(await readFile(u.ledger,'utf8'),waiting.replace('{truncated\n',''),'no release line after the stop');
  assert.deepEqual(stderr.filter(text=>text.startsWith('seller-policy-sign-authorization')),[],'nor a release or a new decision attempted');
});

test('a held write the human approved while the ledger stopped reading waits for its sign authorization: its attempt is neither released nor refused, and it is sign-authorized once the ledger reads',async t=>{
  const s=await (await state(t,'sign-unreadable')).start(),stderr=stderrLines(t);
  let asked=0;
  // The ledger stops reading while the human is at the prompt.
  s.answer=()=>{if(!asked++)fs.appendFileSync(s.ledger,'{truncated\n');return true;};
  let answer,failure;const pending=s.wallet(commitment(33)).then(value=>{answer=value;return value;},error=>{failure=error;return 'failed';});
  await until(()=>answer!==undefined||failure||stderr.some(text=>text.startsWith('seller-policy-ledger unreadable: ')),'the sign authorization waits');
  await new Promise(done=>setTimeout(done,100));
  assert.equal(answer,undefined);assert.equal(failure,undefined);
  const rows=(await readFile(s.ledger,'utf8')).trim().split('\n').filter(line=>line!=='{truncated').map(JSON.parse);
  assert.deepEqual(rows.slice(1).map(row=>row.approvalMode?'hold':'manual'),['hold','manual']);
  assert.equal(rows.some(row=>row.format.endsWith('attempt/v1')||row.format.endsWith('sign-authorization/v1')),false,'not released, not sign-authorized');
  await replaceLedger(s,(await readFile(s.ledger,'utf8')).replace('{truncated\n',''));
  assert.equal(await pending,true);assert.equal(asked,1,'asked once');
  const hold=await holdOf(s),mine=(await ledgerRows(s)).filter(row=>row.attemptId===hold.attemptId);
  assert.deepEqual(mine.map(row=>row.format.endsWith('sign-authorization/v1')?'sign':row.approvalMode?'hold':'manual'),['hold','manual','sign'],'one attempt');
});

test('seller records: the confirmation of a sign-authorized write does not read the ledger again, so a ledger that stopped reading does not refuse it',async t=>{
  const s=await (await state(t,'confirm-unreadable')).start();
  s.answer=()=>true;
  const r=commitment(34);
  assert.equal(await s.wallet(r),true);
  await appendFile(s.ledger,'{truncated\n');
  assert.equal(await s.wallet.confirm(confirmationFor(r)),true,'its sign-authorized reservation already holds the budget');
  const last=JSON.parse((await readFile(s.ledger,'utf8')).trim().split('\n').at(-1));
  assert.deepEqual([last.decision,last.policyReason,last.policyHold],['approved',null,'cancellation-unknown']);
});

// Final review 2 P2: stop() (operator close) fences all approval work, not
// only the waits it finds registered. The next read of this ledger (as the
// approval reads it, through fs/promises) is held until released; `reached`
// resolves when it starts. The read itself runs after the release.
function holdLedgerRead(t,s){
  const original=fs.promises.readFile;let reached,release,armed=true;
  const started=new Promise(done=>{reached=done;}),released=new Promise(done=>{release=done;});
  fs.promises.readFile=async function(path,...rest){
    if(armed&&String(path)===s.ledger){armed=false;reached();await released;}
    return original.call(this,path,...rest);
  };
  syncBuiltinESMExports();
  const restore=()=>{fs.promises.readFile=original;syncBuiltinESMExports();};
  t.after(restore);
  return{started,release:()=>{release();restore();}};
}
const outcomeOf=(promise)=>promise.then(value=>({value}),error=>({error}));
const STOPPED={code:'seller_approval_stopped',message:'seller approval stopped (operator close): this write is not approved, and nothing more is written for it'};

test('final review 2 P2 (the Daybreak probe): a write whose retry read is under way when the approval stops is not decided once that read returns the corrected ledger: no hold, manual or sign line, no prompt, an error; stop() resolves only after that read',async t=>{
  const s=await (await state(t,'stop-retry-read')).start(),stderr=stderrLines(t);
  let asked=0;s.answer=()=>{asked++;return true;};
  const good=await readFile(s.ledger,'utf8');await appendFile(s.ledger,'{truncated\n');
  const pending=outcomeOf(s.wallet(commitment(36)));
  await until(()=>stderr.some(text=>text.startsWith('seller-policy-ledger unreadable: ')),'the write waits');
  // Its next retry read starts; the ledger is corrected while it is under way.
  const read=holdLedgerRead(t,s);
  await within(read.started,5000,'the retry read starts');
  await replaceLedger(s,good);
  let idle=false;const stopping=Promise.resolve(s.approval.stop()).then(()=>{idle=true;});
  await new Promise(done=>setTimeout(done,50));
  const idleBeforeRead=idle;
  read.release();
  const outcome=await pending;await stopping;
  assert.equal(await readFile(s.ledger,'utf8'),good,'nothing was written after the stop: no hold, manual or sign-authorized line');
  assert.equal(asked,0,'the human was not asked');
  assert.deepEqual([outcome.error?.code,outcome.error?.message],[STOPPED.code,STOPPED.message],`not answered: ${JSON.stringify(outcome.value)}`);
  assert.equal(idleBeforeRead,false,'stop() waited for the read in flight');
});

test('final review 2 P2: requests queued behind a write waiting for the ledger are not decided or completed after the stop, even though the ledger reads by then: each ends with an error and nothing is written',async t=>{
  const unstarted=await state(t,'stop-queued');unstarted.ledgerRetryMs=60_000;unstarted.limits={maxWritesPerHour:3};
  const s=await unstarted.start(),stderr=stderrLines(t);
  // A paid Deliverable sign-authorized earlier, whose wallet completion comes later.
  const earlier=deliverable(41);assert.equal(await s.approval.prepare(earlier),true);
  const good=await readFile(s.ledger,'utf8');await appendFile(s.ledger,'{truncated\n');
  const waiting=outcomeOf(s.wallet(commitment(37)));
  await until(()=>stderr.some(text=>text.startsWith('seller-policy-ledger unreadable: ')),'the first write waits');
  // Queued behind it on the same ledger: a paid Deliverable the policy would
  // approve, and the earlier one's completion.
  const queued=outcomeOf(s.approval.prepare(deliverable(38))),completion=outcomeOf(s.approval.settle(earlier,'released'));
  await replaceLedger(s,good);
  await s.approval.stop();
  const [first,second,third]=[await waiting,await queued,await completion];
  assert.equal(await readFile(s.ledger,'utf8'),good,'nothing was written: no hold for the first, no sign-authorized line for the queued one, no completion line');
  assert.equal(first.error?.message,'seller policy stopped while its approval ledger could not be read; nothing was decided, written or signed');
  assert.deepEqual([second.error?.code,second.error?.message],[STOPPED.code,STOPPED.message],`not answered: ${JSON.stringify(second.value)}`);
  assert.deepEqual([third.error?.code,third.error?.message],[STOPPED.code,STOPPED.message],'the completion is not written: the reservation stays held');
});

test('final review 2 P2: a held write the human approved, whose sign-authorization retry read is under way when the approval stops, is not sign-authorized: no sign or release line, an error',async t=>{
  const s=await (await state(t,'stop-sign-read')).start(),stderr=stderrLines(t);
  s.answer=()=>{fs.appendFileSync(s.ledger,'{truncated\n');return true;};
  const pending=outcomeOf(s.wallet(commitment(39)));
  await until(()=>stderr.some(text=>text.startsWith(`seller-policy-ledger unreadable: ${s.ledger}`)),'the sign authorization waits');
  const read=holdLedgerRead(t,s);
  await within(read.started,5000,'the retry read starts');
  const corrected=(await readFile(s.ledger,'utf8')).replace('{truncated\n','');
  await replaceLedger(s,corrected);
  const stopping=s.approval.stop();
  read.release();
  const outcome=await pending;await stopping;
  assert.equal(await readFile(s.ledger,'utf8'),corrected,'no sign-authorized line, and no release, after the stop');
  assert.deepEqual([outcome.error?.code,outcome.error?.message],[STOPPED.code,STOPPED.message],`not answered: ${JSON.stringify(outcome.value)}`);
  assert.deepEqual(stderr.filter(text=>text.startsWith('seller-policy-sign-authorization')),[],'nor a release or a new decision attempted');
});

// Stops the approval inside the sync of the next ledger line it syncs (a
// sign-authorized line): the line is on disk, and stop() lands before the answer.
function stopDuringLedgerSync(s){
  const original=fs.fsyncSync;let fired=false;
  fs.fsyncSync=function(fd,...rest){
    const result=original.call(this,fd,...rest);
    let path=null;try{path=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}
    if(path===s.ledger&&!fired){fired=true;s.approval.stop();}
    return result;
  };
  syncBuiltinESMExports();
  return()=>{fs.fsyncSync=original;syncBuiltinESMExports();};
}

test('final review 2 P2: a stop that lands while a sign-authorized line is synced: the line stays on the ledger, held and counted, but the answer is an error, never true',async t=>{
  // A paid Deliverable the policy approves.
  const s=await (await state(t,'stop-in-sync')).start();
  let restore=stopDuringLedgerSync(s),outcome;
  try{outcome=await outcomeOf(s.approval.prepare(deliverable(44)));}finally{restore();}
  assert.deepEqual([outcome.error?.code,outcome.value],[STOPPED.code,undefined],'not answered true: the wallet may not sign');
  assert.equal((await signAuthorized(s)).requestBytes,JSON.stringify(deliverable(44)));assert.equal(await s.budget(),1,'its line holds the budget');
  // A held write the human approved.
  const u=await (await state(t,'stop-in-sync-held')).start();u.answer=()=>true;
  restore=stopDuringLedgerSync(u);
  try{outcome=await outcomeOf(u.wallet(commitment(45)));}finally{restore();}
  assert.deepEqual([outcome.error?.code,outcome.value],[STOPPED.code,undefined],'not answered true: the wallet may not sign');
  assert.deepEqual((await ledgerRows(u)).slice(1).map(row=>row.format.endsWith('sign-authorization/v1')?'sign':row.approvalMode?'hold':'manual'),['hold','manual','sign']);
});

test('final review 2 (Daybreak P3 1): a manual answer given after the approvals stop is not recorded and does not sign: no manual or sign line, an error; the held attempt stays held (approval-unknown)',async t=>{
  const s=await (await state(t,'stop-late-answer')).start();
  let answer;s.answer=()=>new Promise(done=>{answer=done;});
  const pending=outcomeOf(s.wallet(commitment(40)));
  await until(()=>answer!==undefined,'the write is at the manual prompt');
  const atPrompt=await readFile(s.ledger,'utf8');
  // Operator close stops both: the policy and the exact manual approval.
  await Promise.all([s.approval.stop(),s.manual.stop?.()]);
  answer(true);
  const outcome=await pending;
  assert.equal(await readFile(s.ledger,'utf8'),atPrompt,'no manual line and no sign-authorized line after the stop');
  assert.deepEqual([outcome.error?.code,outcome.error?.message],[STOPPED.code,STOPPED.message],`not answered: ${JSON.stringify(outcome.value)}`);
  const hold=await holdOf(s);
  s.crash();await s.start();
  await assertHeld(s,{attemptId:hold.attemptId},'approval-unknown');
});

// Final review 3 (code review P3-2): the two stop checks no earlier test pinned.
test('final review 3: a stop that lands while a wallet completion reads the ledger writes no completion: an error, and the sign-authorized reservation stays held and counted',async t=>{
  const s=await (await state(t,'stop-completion-read')).start(),r=deliverable(16);
  assert.equal(await s.wallet(r),true);
  const {reservationId}=await signAuthorized(s),before=await readFile(s.ledger,'utf8');
  const read=holdLedgerRead(t,s);
  const settling=outcomeOf(s.wallet.settle(r,'spent'));
  await within(read.started,5000,'the completion reads the ledger');
  let idle=false;const stopping=s.approval.stop().then(()=>{idle=true;});
  await new Promise(done=>setTimeout(done,50));
  assert.equal(idle,false,'stop() waits for the completion in flight');
  read.release();
  const outcome=await settling;await stopping;
  assert.equal(await readFile(s.ledger,'utf8'),before,'no completion line after the stop');
  assert.deepEqual([outcome.error?.code,outcome.error?.message],[STOPPED.code,STOPPED.message],`not answered: ${JSON.stringify(outcome.value)}`);
  s.crash();await s.start();
  await assertHeld(s,reservationId,'issuance-unknown');
});

test('final review 3: a stop that lands while a sign-authorized line whose sync failed is read back writes no release for it: the line stays open, held and counted, and preparation answers with an error',async t=>{
  const s=await (await state(t,'stop-failed-sign-read')).start();
  // The sync of the sign-authorized line fails once; the read that follows is held.
  const original=fs.fsyncSync;let read=null;
  fs.fsyncSync=function(fd,...rest){
    let path=null;try{path=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}
    if(path===s.ledger&&!read){read=holdLedgerRead(t,s);throw Object.assign(new Error('TEST EIO'),{code:'EIO'});}
    return original.call(this,fd,...rest);
  };
  syncBuiltinESMExports();
  const restore=()=>{fs.fsyncSync=original;syncBuiltinESMExports();};t.after(restore);
  const pending=outcomeOf(s.approval.prepare(deliverable(43)));
  await until(()=>read!==null,'the sign-authorized line fails to sync');
  await within(read.started,5000,'the failed line is read back');
  restore();
  const stopping=s.approval.stop();
  read.release();
  const outcome=await pending;await stopping;
  assert.equal(outcome.error?.code,'EIO',`not answered: ${JSON.stringify(outcome.value)}`);
  const sign=await signAuthorized(s);
  assert.deepEqual((await ledgerRows(s)).filter(row=>row.reservationId===sign.reservationId).map(row=>row.format),['dacs-node2-seller-policy-sign-authorization/v1'],'no release line after the stop');
  s.crash();await s.start();
  await assertHeld(s,sign.reservationId,'issuance-unknown');
});
