import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { opsHealth } from '../src/ops/health.mjs';
import { appHeldEvidenceJobs, sellerHeldEvidenceJobs } from '../src/devnet-demo/seller-purchase-source.mjs';
import { SELLER_JOURNAL_REFUSALS } from '../src/devnet-demo/operator.mjs';
import { parsePolicyLedger } from '../src/devnet-demo/operator-approval.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { nativePayloadDigest } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

// The operator wiring of sellerApproval.purchaseSource on the owned loopback
// Node2 profile: the policy and the held-evidence resume pass read seller
// records only, and the default reads the app exactly as main does.
const sha=(value)=>createHash('sha256').update(value).digest('hex');
// The two app-database reads this switch replaces, as main prepares them.
const APP_POLICY_SQL="SELECT terms, state, status, expires_at FROM operations WHERE kind = 'purchase' AND json_extract(terms, '$.protocol.jobId') = ?";
const APP_HELD_SQL=`SELECT json_extract(terms, '$.protocol.jobId') AS jobId FROM operations WHERE kind = 'purchase' AND status = 'settled_verified'
          AND json_extract(terms, '$.seller.claim') = ? AND json_extract(state, '$.protocol.stage') = 'delivery-ready' AND json_extract(state, '$.protocol.delivery.evidenceHold.status') = 'pending'`;
// Records every SQL text any database in this process prepares.
const preparedSql=(t)=>{const texts=[],prepare=DatabaseSync.prototype.prepare;t.mock.method(DatabaseSync.prototype,'prepare',function(text){texts.push(text);return prepare.call(this,text);});return texts;};
const ledger=async(h)=>(await readFile(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const evidenceAddress=(job)=>`dacs4:evidence:${job}`;
// A second handle on the running operator's source transport journal (the journal is multi-process).
const transportJournal=(t,h)=>{const journal=openDurableWalletJournal({path:join(h.config.stateDirectory,'node2-transport.sqlite'),mode:'open'});t.after(()=>journal.close());return journal;};
const evidenceCreates=(h,job)=>h.node2.chain.wire.record.accepted.filter(tx=>tx.content.data[1].metadata.logicalAddress===evidenceAddress(job));
const manualTimer=()=>{const registrations=[];return{registrations,every:(run,ms)=>{const handle={run,ms,cancelled:false};registrations.push(handle);return handle;},cancel:(handle)=>{handle.cancelled=true;}};};
// Test-only seam (as in seller-policy-delivery-evidence.test.mjs): the seller
// artifact journal refuses the first delivery evidence intent, before the wallet is asked.
function failEvidenceIntentOnce(){
  const state={fired:0};
  state.wrap=(journal)=>new Proxy(journal,{get(target,key){
    if(key==='put')return async(k,v)=>{
      if(!state.fired&&v?.stage==='intent'&&v.input?.artifactKind==='SettlementEvidence'&&String(v.input?.logicalAddress).startsWith('dacs4:evidence:')){state.fired++;throw Object.assign(new Error('TEST seller journal write failed before the delivery evidence CREATE was sent'),{code:'TEST-journal-unavailable'});}
      return target.put(k,v);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return state;
}

test('Node2 seller records: policy approves the paid writes, holds the pre-payment writes for exact manual approval and never reads the app purchase store',{timeout:540000},async t=>{
  const sql=preparedSql(t),manual=[];
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},sellerDeliveryEvidence:{enabled:true},
    authorizeSellerApproval:({request,notice})=>{manual.push({kind:request.content.artifactKind,notice:notice??null});return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-seller-records-delivered'});
  assert.equal(result.status,'delivered');
  assert.deepEqual(manual.map(m=>m.kind),['Listing','CompositeVerificationRecord','CompositeVerificationRecord','FinalityCommitmentRecord']);
  assert.equal(manual[0].notice,null);for(const m of manual.slice(1))assert.match(m.notice,/cannot show a buyer-side cancellation/);
  const lines=await ledger(h),policy=lines.filter(row=>row.approvalMode==='policy'),attempts=lines.filter(row=>row.format==='dacs-node2-seller-policy-attempt/v1');
  // A held write: the hold, then (after the manual line) its confirmation as a policy reservation.
  assert.deepEqual(policy.map(row=>[JSON.parse(row.requestBytes).content.artifactKind,row.decision,row.policyReason,row.policyHold??null]),[
    ['CompositeVerificationRecord','rejected','seller-record-missing',null],['CompositeVerificationRecord','approved',null,'seller-record-missing'],
    ['CompositeVerificationRecord','rejected','seller-record-missing',null],['CompositeVerificationRecord','approved',null,'seller-record-missing'],
    ['FinalityCommitmentRecord','rejected','cancellation-unknown',null],['FinalityCommitmentRecord','approved',null,'cancellation-unknown'],
    ['SettlementEvidence','approved',null,null],['Deliverable','approved',null,null],['SettlementEvidence','approved',null,null]]);
  assert.ok(lines.every(row=>row.format!=='dacs-node2-operator-approval-evidence/v1'||sha(row.requestBytes)===row.approvalHash));
  // All six writes used the hourly budget once each and were spent.
  assert.equal(attempts.length,6);assert.ok(attempts.every(row=>row.outcome==='spent'));
  // Each held write was approved by hand once and confirmed once; nothing was sent twice.
  const manualLines=lines.filter(row=>row.format==='dacs-node2-operator-approval-evidence/v1'&&!Object.hasOwn(row,'approvalMode'));
  assert.deepEqual(manualLines.map(row=>[JSON.parse(row.requestBytes).content.artifactKind,row.decision]),[['Listing','approved'],['CompositeVerificationRecord','approved'],['CompositeVerificationRecord','approved'],['FinalityCommitmentRecord','approved']]);
  for(const row of policy.filter(row=>row.policyHold))assert.equal(manualLines.filter(line=>line.approvalHash===row.approvalHash).length,1);
  assert.ok(lines.every(row=>!Object.hasOwn(row,'manualApproved')));
  assert.equal(h.node2.chain.wire.record.accepted.length,8);assert.equal(h.node2.chain.record.accepted.length,1);
  assert.deepEqual(sql.filter(text=>text===APP_POLICY_SQL||text===APP_HELD_SQL),[],'neither app-source query was prepared');
  // Each confirmed reservation was sign-authorized on the ledger, with its exact
  // bytes, before its confirmation (so before the wallet could sign it): once,
  // and for a held write after its manual line. The source journal holds no
  // seller-policy record.
  const reserved=policy.filter(row=>row.decision==='approved'),signed=lines.filter(row=>row.format==='dacs-node2-seller-policy-sign-authorization/v1');
  assert.equal(signed.length,reserved.length);
  for(const row of reserved){
    const at=lines.indexOf(row),authorized=signed.filter(line=>line.reservationId===row.reservationId);
    assert.equal(authorized.length,1);assert.ok(lines.indexOf(authorized[0])<at,'sign-authorized before its confirmation');
    assert.deepEqual([authorized[0].approvalHash,authorized[0].requestBytes,authorized[0].attemptId??null],[row.approvalHash,row.requestBytes,row.attemptId??null]);
    if(row.policyHold)assert.ok(lines.indexOf(manualLines.find(line=>line.approvalHash===row.approvalHash))<lines.indexOf(authorized[0]),'a held write after its manual line');
  }
  assert.deepEqual((await transportJournal(t,h).entries()).filter(([key])=>key.startsWith('seller-policy/')),[]);
});

test('Node2 seller records: the resume pass finds the same held evidence job as the app, and a restart publishes it exactly once',{timeout:540000},async t=>{
  const sql=preparedSql(t),approvals=[],notices=[],fault=failEvidenceIntentOnce(),timer=manualTimer();
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'manual',purchaseSource:'seller'},sellerDeliveryEvidence:{enabled:true},wrapPublicJournal:fault.wrap,evidenceResumeTimer:timer,
    authorizeSellerApproval:({request,notice})=>{approvals.push(request);notices.push(notice??null);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-seller-records-resume'});
  assert.equal(fault.fired,1);assert.equal(result.status,'delivery-ready');assert.equal(evidenceCreates(h,result.jobId).length,0);
  // Manual mode runs no policy, so nothing is held and no prompt carries the hold notice.
  assert.ok(approvals.some(request=>request.content.artifactKind==='FinalityCommitmentRecord'));assert.deepEqual(notices.filter(Boolean),[]);
  assert.ok(!sql.includes(APP_HELD_SQL),'the operator never prepared the app held-evidence query');
  // The same held job from both sources (the app query here is the test's own read).
  const fromSeller=sellerHeldEvidenceJobs(h.composition.sellerAgent.durableSessions());
  assert.deepEqual(fromSeller,[{jobId:result.jobId}]);assert.deepEqual(appHeldEvidenceJobs(h.application.db).all(h.prepared.operatorEvidence.seller).map(row=>({...row})),fromSeller);
  const counts=()=>({attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length}),before=counts();
  const operatorSql=sql.length;
  await h.restart();
  assert.deepEqual(await h.operator.resumeHeldDeliveryEvidence(),[{jobId:result.jobId,status:'delivered'}],'the pass after restart published the held evidence');
  assert.equal(evidenceCreates(h,result.jobId).length,1);
  assert.deepEqual(counts(),{attempts:before.attempts+1,approvals:before.approvals+1,payments:before.payments},'one evidence CREATE; nothing else is resent');
  assert.deepEqual(await h.operator.resumeHeldDeliveryEvidence(),[],'a delivered job is not resumed again');assert.deepEqual(counts(),{attempts:before.attempts+1,approvals:before.approvals+1,payments:before.payments});
  assert.ok(!sql.slice(operatorSql).includes(APP_HELD_SQL),'the operator never prepared the app held-evidence query');
  const accountId=h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(result.operationId).account_id;
  await h.application.services.purchases.verifyDeal({accountId,operationId:result.operationId});
  assert.equal(h.application.services.purchases.status(accountId,result.operationId).protocol.stage,'delivered');
});

// One held attempt confirmed by a process that then ended before completing
// it: its hold, its manual line, its sign-authorized line (none for an older
// build) and its confirmed reservation.
async function appendConfirmedAttempt(h,request,{signAuthorized=true}={}){
  const requestBytes=JSON.stringify(request),approvalHash=sha(requestBytes),attemptId=randomUUID(),reservationId=randomUUID(),recordedAt=Date.now();
  const line={format:'dacs-node2-operator-approval-evidence/v1',approvalHash,requestBytes,method:'sendTransaction',address:request.address,totalOs:request.content.debit.totalOs};
  const rows=[{...line,decision:'rejected',attemptId,approvalMode:'policy',policyReason:'cancellation-unknown',reservationId:randomUUID(),recordedAt},{...line,decision:'approved',attemptId,recordedAt},
    ...(signAuthorized?[{format:'dacs-node2-seller-policy-sign-authorization/v1',reservationId,approvalHash,requestBytes,totalOs:request.content.debit.totalOs,recordedAt,attemptId}]:[]),
    {...line,decision:'approved',attemptId,approvalMode:'policy',policyReason:null,reservationId,policyHold:'cancellation-unknown',confirmation:{TEST:'confirmed before the process ended'},recordedAt}];
  await appendFile(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),rows.map(row=>`${JSON.stringify(row)}\n`).join(''));
  return{attemptId,reservationId};
}

test('Node2 seller records: a restart never releases a sign-authorized reservation (Daybreak r6 P1), even one the wallet journals show was never sent; it keeps each held and shows it, and the resume pass does the same',{timeout:540000},async t=>{
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},sellerDeliveryEvidence:{enabled:true},evidenceResumeTimer:manualTimer(),
    authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  assert.deepEqual(h.prepared.operatorEvidence.sellerPolicyHeld,[],'nothing is held at a first start');
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-seller-records-reconcile'});
  assert.equal(result.status,'delivered');
  // This run's policy writes by nonce. Leftovers: one above every journaled
  // nonce (never sent: r5 released it), the newest exact write (issued), the
  // first write's nonce with other bytes (the journals hold another write at
  // that nonce), and one never sent from an older build (no sign-authorized line).
  const writes=(await ledger(h)).filter(row=>row.approvalMode==='policy'&&row.decision==='approved').map(row=>JSON.parse(row.requestBytes)).sort((a,b)=>a.content.nonce-b.content.nonce);
  const later=(offset)=>{const r=structuredClone(writes.at(-1));r.content.nonce+=offset;return r;};
  const other=structuredClone(writes[0]);other.content.timestamp+=1;
  const ids={unsent:await appendConfirmedAttempt(h,later(100)),issued:await appendConfirmedAttempt(h,writes.at(-1)),ambiguous:await appendConfirmedAttempt(h,other),older:await appendConfirmedAttempt(h,later(99),{signAuthorized:false})};
  const oldWallet=`0x${'f'.repeat(64)}`,old=structuredClone(writes.at(-1));old.address=oldWallet;old.content.wallet=oldWallet;old.content.owner=`did:demos:agent:${oldWallet.slice(2)}`;old.content.nonce=1;
  ids.laterLane=await appendConfirmedAttempt(h,old);
  await h.prepared.composition.publicJournal.put('TEST/old-seller-lane',{stage:'broadcast-started',signedTransaction:{content:{from:oldWallet,nonce:2,timestamp:old.content.timestamp+1}}});
  const sent=h.node2.chain.wire.record.broadcastAttempts.length,logged=[],write=process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr,'write',(chunk,...rest)=>{logged.push(String(chunk));return write(chunk,...rest);});
  await h.restart();
  t.mock.restoreAll();
  const releases=async()=>(await ledger(h)).filter(row=>row.format==='dacs-node2-seller-policy-attempt/v1'&&row.reason).map(row=>[row.reservationId,row.attemptId,row.outcome,row.reason]);
  assert.deepEqual(await releases(),[]);
  assert.deepEqual(h.prepared.operatorEvidence.sellerPolicyHeld.map(item=>[item.reservationId,item.attemptId,item.state]),
    [[ids.unsent.reservationId,ids.unsent.attemptId,'issuance-unknown'],[ids.issued.reservationId,ids.issued.attemptId,'issued-outcome-unknown'],[ids.ambiguous.reservationId,ids.ambiguous.attemptId,'issuance-unknown'],[ids.older.reservationId,ids.older.attemptId,'issuance-unknown'],[ids.laterLane.reservationId,ids.laterLane.attemptId,'issuance-unknown']]);
  const held='held (issuance-unknown); counted, read back only, never resent';
  assert.deepEqual(logged.filter(line=>line.startsWith('seller-policy-reservation:')).map(line=>line.replace(/^seller-policy-reservation: \S+ \S+ /,'').trim()),
    [held,'held (issued-outcome-unknown); counted, read back only, never resent',held,held,held]);
  // The resume pass (here the one listen started, then one on demand) reconciles a later leftover too.
  const repeated=[];t.mock.method(process.stderr,'write',(chunk,...rest)=>{repeated.push(String(chunk));return write(chunk,...rest);});
  await h.operator.resumeHeldDeliveryEvidence();
  assert.deepEqual(repeated.filter(line=>line.startsWith('seller-policy-reservation:')),[],'unchanged held list is silent');
  t.mock.restoreAll();
  // The native payment left its source's transfer-claims record on the
  // buyer's lane (code review mm F1). A cancelled payment on that lane, and
  // the transfer the source then refuses, add the other two records; the
  // operator's own source writes both. Health reads none as a seller write.
  const purchase=h.application.db.prepare("SELECT json_extract(terms,'$.buyer.wallet') AS buyer,json_extract(terms,'$.seller.payee') AS payee FROM operations WHERE id = ?").get(result.operationId);
  const lane=(kind)=>`devnet/${kind}/${JSON.stringify([h.prepared.operatorEvidence.network,h.prepared.operatorEvidence.chainIdentity,purchase.buyer])}`;
  const source=h.prepared.devnetAgreementTransport,to=purchase.payee,payload={content:{type:'native',from:purchase.buyer,to,amount:'1000000000',data:['native',{nativeOperation:'send',args:[to,'1000000000']}],nonce:1000,timestamp:Date.now()}};
  assert.deepEqual(await source.cancelNativeTransfer({address:purchase.buyer,operationId:result.operationId,payload,unissued:async()=>true}),{cancelled:true,claimed:null});
  await assert.rejects(source.binding({phase:'signature',address:purchase.buyer,transfer:{nonce:1000,to,amountOs:'1000000000',payloadDigest:await nativePayloadDigest(payload.content)}}),{code:'payment_cancelled'});
  assert.deepEqual((await transportJournal(t,h).entries()).map(([key])=>key).filter(key=>/^devnet\/(transfer-claims|refused-transfers|cancelled-payments)\//.test(key)).sort(),['cancelled-payments','refused-transfers','transfer-claims'].map(lane));
  const health=opsHealth({databasePath:h.prepared.config.databasePath,operatorState:h.config.stateDirectory,sellerApproval:h.config.sellerApproval});
  assert.deepEqual(health.seller.unconfirmed.filter(row=>row.source==='node2-transport.sqlite'),[]);
  assert.equal(health.seller.budget.writes,11,'six spent plus five unresolved reservations');
  const leftover=await appendConfirmedAttempt(h,later(101));
  assert.deepEqual(await h.operator.resumeHeldDeliveryEvidence(),[]);
  assert.deepEqual(await releases(),[]);
  assert.ok(leftover.reservationId);
  assert.equal(opsHealth({databasePath:h.prepared.config.databasePath,operatorState:h.config.stateDirectory,sellerApproval:h.config.sellerApproval}).seller.budget.writes,12,'a later leftover is held and counted too');
  assert.equal(h.node2.chain.wire.record.broadcastAttempts.length,sent,'nothing was sent or resent');
});

test('Node2 switch off: the default purchase source reads the app with main\'s exact queries and never touches the seller record accessors',{timeout:540000},async t=>{
  const sql=preparedSql(t),touched=[];
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy'},sellerDeliveryEvidence:{enabled:true},
    authorizeSellerApproval:({request})=>{assert.equal(request.content.artifactKind,'Listing');return true;},authorizeBuyerApproval:()=>true,
    beforeAttach:({composition})=>{for(const key of ['durableSessionOf','durableSessions'])composition.sellerAgent[key]=()=>{touched.push(key);throw new Error(`TEST ${key} used with the switch off`);};}});
  t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-switch-off'});
  assert.equal(result.status,'delivered');assert.deepEqual(touched,[]);
  assert.equal(Object.hasOwn(h.prepared.operatorEvidence,'sellerPolicyHeld'),false);
  assert.ok(sql.includes(APP_POLICY_SQL),'the policy read the app purchase row with main\'s query');assert.ok(sql.includes(APP_HELD_SQL),'the resume pass uses main\'s held-evidence query');
  // The same ledger as main's own policy delivery test for this profile.
  const lines=await ledger(h),rows=lines.filter(row=>row.format==='dacs-node2-operator-approval-evidence/v1'),policy=rows.filter(row=>row.approvalMode==='policy');
  assert.equal(rows.length,7);assert.equal(policy.length,6);assert.ok(policy.every(row=>row.decision==='approved'&&row.policyReason===null));
  assert.ok(lines.every(row=>!Object.hasOwn(row,'manualApproved')),'no write was held for manual approval');
  assert.equal(h.node2.chain.wire.record.accepted.length,8);
});

test('Node2 manual mode with the default purchase source: vet and commitment prompts carry no notice, as on main',{timeout:540000},async t=>{
  const prompts=[];
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'manual'},
    authorizeSellerApproval:({request,notice})=>{prompts.push({kind:request.content.artifactKind,notice:notice??null});return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-manual-app-notices'});
  assert.equal(result.status,'delivery-ready');
  assert.deepEqual(prompts.map(p=>p.kind).slice(0,4),['Listing','CompositeVerificationRecord','CompositeVerificationRecord','FinalityCommitmentRecord']);
  assert.deepEqual(prompts.filter(p=>p.notice!==null),[]);
});

test('Node2 seller records need the durable seller agent: attaching one without its record accessors fails before listening',{timeout:540000},async()=>{
  // An operator that starts anyway is closed at once, so the failure is the assertion, not a hang.
  const started=startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true,
    beforeAttach:({composition})=>{composition.sellerAgent.durableSessionOf=undefined;}});
  await assert.rejects(started.then(async(h)=>{await h.close();return h;}),{message:'seller purchase records need the durable seller agent'});
});


test('Node2 partial restore: a retained issued reservation with all issuance journals lost refuses startup and is never released (Daybreak P2)',{timeout:540000},async t=>{
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},sellerDeliveryEvidence:{enabled:true},evidenceResumeTimer:manualTimer(),
    authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-partial-restore'});
  assert.equal(result.status,'delivered');
  const issued=(await ledger(h)).filter(row=>row.approvalMode==='policy'&&row.decision==='approved').map(row=>JSON.parse(row.requestBytes)).sort((a,b)=>a.content.nonce-b.content.nonce).at(-1);
  const ids=await appendConfirmedAttempt(h,issued),before=await ledger(h),sent=h.node2.chain.wire.record.broadcastAttempts.length;
  await h.stop();
  for(const name of ['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite'])for(const suffix of ['','-wal','-shm'])await rm(join(h.config.stateDirectory,`${name}${suffix}`),{force:true});
  await assert.rejects(h.restart(),{code:'journal-absent'});
  assert.deepEqual(await ledger(h),before,'no durable release row after a partial restore');
  assert.equal((await ledger(h)).some(row=>row.format==='dacs-node2-seller-policy-attempt/v1'&&row.reservationId===ids.reservationId),false);
  assert.equal(h.node2.chain.wire.record.broadcastAttempts.length,sent,'no send or resend');
  const health=opsHealth({databasePath:h.prepared.config.databasePath,operatorState:h.config.stateDirectory,sellerApproval:h.config.sellerApproval});
  assert.equal(health.seller.budget.writes,7,'health keeps the issued leftover counted even when every journal is absent');
  assert.deepEqual(health.seller.journals,[]);
});

// Final review fe58 finding 2: a running operator would leave every seller
// write before payment waiting for the ledger, so it refuses to start.
test('Node2 malformed ledger: seller records refuse to start, naming the ledger and its line; corrected, the operator starts',{timeout:540000},async t=>{
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const path=join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),good=await readFile(path,'utf8');
  await appendFile(path,'{truncated\n');
  await assert.rejects(h.restart(),(error)=>{
    assert.ok(error.message.startsWith(`${SELLER_JOURNAL_REFUSALS.ledgerUnreadable}: `)&&error.message.includes(`seller-approvals.jsonl line ${good.trim().split('\n').length+1} (`),error.message);
    return true;
  });
  assert.equal(await readFile(path,'utf8'),`${good}{truncated\n`,'nothing was written');
  await writeFile(path,good);await h.restart();
  assert.deepEqual(h.prepared.operatorEvidence.sellerPolicyHeld,[]);
});

// Final review 2 P2: operator close stops seller approval work and waits for
// the work in flight before any journal closes or the state lock is released.
// The next read of the ledger (as the approval reads it, through
// fs/promises) is held until released; the read itself runs after that.
function holdNextLedgerRead(t,path){
  const original=fs.promises.readFile;let reached,release,armed=true;
  const started=new Promise(done=>{reached=done;}),released=new Promise(done=>{release=done;});
  fs.promises.readFile=async function(file,...rest){
    if(armed&&String(file)===path){armed=false;reached();await released;}
    return original.call(this,file,...rest);
  };
  syncBuiltinESMExports();
  const restore=()=>{fs.promises.readFile=original;syncBuiltinESMExports();};
  t.after(restore);
  return{started,release:()=>{release();restore();}};
}
const settledWithin=(promise,ms)=>Promise.race([promise.then(()=>true,()=>true),new Promise(done=>setTimeout(done,ms,false).unref())]);
// A close that failed must not leave the Node2 fixture running.
const closeAll=async(h)=>{try{await h.close();}catch{await h.node2.close().catch(()=>{});}};
const kindOf=(row)=>row.format==='dacs-node2-seller-policy-sign-authorization/v1'?'sign':row.format==='dacs-node2-seller-policy-attempt/v1'?`end:${row.reason??row.outcome}`:row.approvalMode?'hold':'manual';
const vetLines=async(h)=>(await ledger(h)).filter(row=>row.requestBytes&&JSON.parse(row.requestBytes).content.artifactKind==='CompositeVerificationRecord'||row.format==='dacs-node2-seller-policy-attempt/v1').map(kindOf);

test('Node2 seller records (final review 2 P2): close waits for a seller approval read in flight before the journals close and the state lock is released, and that write is then not sign-authorized',{timeout:540000},async t=>{
  let h,read=null;
  h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},authorizeSellerApproval:({request})=>{
    // The human approves the first held vet record; the ledger read of its sign authorization is then held.
    if(request.content.artifactKind==='CompositeVerificationRecord'&&!read)read=holdNextLedgerRead(t,join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'));
    return true;
  },authorizeBuyerApproval:()=>true});t.after(()=>closeAll(h));
  const purchase=h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-seller-records-close-read'});purchase.catch(()=>{});
  for(let i=0;i<6000&&!read;i++)await new Promise(done=>setTimeout(done,10));
  assert.ok(read,'the first held vet record reached the manual prompt');
  await read.started;
  const lock=join(h.config.stateDirectory,'seller-state.lock'),closing=h.operator.close().then(()=>null,error=>error);
  const closedEarly=await settledWithin(closing,500),lockEarly=fs.existsSync(lock);
  read.release();
  const closeError=await closing;
  assert.deepEqual({closedEarly,lockEarly},{closedEarly:false,lockEarly:true},'close waited for the approval read: the journals were still open and the state lock held');
  assert.equal(closeError,null);
  assert.equal(fs.existsSync(lock),false,'then the state lock was released');
  assert.deepEqual(await vetLines(h),['hold','manual'],'the read returned after the stop: no sign-authorized line, and nothing else written');
  assert.equal(await settledWithin(purchase,60000),true,'the purchase ends');
});

test('Node2 seller records (final review 2, Daybreak P3 1): a manual answer given after close began is not recorded and nothing is sign-authorized; the attempt stays open and held',{timeout:540000},async t=>{
  let answer=null;
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},authorizeSellerApproval:({request})=>
    request.content.artifactKind==='CompositeVerificationRecord'?new Promise(done=>{answer??=done;}):true,authorizeBuyerApproval:()=>true});
  t.after(async()=>{answer?.(false);await closeAll(h);});
  const purchase=h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-seller-records-close-prompt'});purchase.catch(()=>{});
  for(let i=0;i<6000&&!answer;i++)await new Promise(done=>setTimeout(done,10));
  assert.ok(answer,'the first held vet record is at the manual prompt');
  // The human approves just after close began.
  const closing=h.operator.close().then(()=>null,error=>error);
  answer(true);
  const closeError=await closing;
  await settledWithin(purchase,60000);
  assert.deepEqual(await vetLines(h),['hold'],'no manual line and no sign-authorized line after close began');
  assert.equal(closeError,null);
  const {attempts}=parsePolicyLedger(await readFile(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8'));
  assert.deepEqual([...attempts.values()].map(attempt=>[attempt.outcome,attempt.manual,attempt.reservation]),[[null,false,null]],'its attempt stays open and held (approval-unknown at the next start)');
});

// Final review 3 (Daybreak P2): a replacement operator in a fresh process,
// which shares no in-memory state with this one. It prints the state lock
// refusal, or the held attempts it lists, and closes.
const operatorModule=fileURLToPath(new URL('../src/devnet-demo/operator.mjs',import.meta.url));
function replacementOperator(t,configPath){
  const code=`import { createDevnetDemoOperator } from ${JSON.stringify(operatorModule)};
let operator;
try{operator=await createDevnetDemoOperator({configPath:process.argv[1],authorizeSellerApproval:()=>false,authorizeBuyerApproval:()=>false});}
catch(error){process.stdout.write(JSON.stringify({refused:{code:error.code??null,reason:error.reason??null}}));process.exit(3);}
const held=(await operator.prepareDevnetDemo()).operatorEvidence.sellerPolicyHeld;
await operator.close();process.stdout.write(JSON.stringify({held}));process.exit(0);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,configPath],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',(d)=>{out+=d;});child.stderr.on('data',(d)=>{err+=d;});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  return new Promise(done=>child.on('exit',(code)=>done({code,out,err})));
}
// What the state lock covers, by content: the ledger and binding bytes and
// every row of the issuance journals, the party Vet store and the seller
// transport store, read through a connection of this test.
async function sellerStateContent(state){
  const out={};
  for(const name of ['evidence/seller-approvals.jsonl','evidence/seller-issuance-journals.json'])out[name]=sha(await readFile(join(state,name)));
  for(const name of ['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite','seller-party-vet.sqlite','seller-transport.sqlite']){
    const db=new DatabaseSync(join(state,name));
    try{out[name]=JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(({name:table})=>[table,db.prepare(`SELECT * FROM "${table}"`).all()]));}finally{db.close();}
  }
  return out;
}
const vetIntents=async(journal)=>(await journal.entries()).map(([,value])=>value).filter(value=>value?.input?.artifactKind==='CompositeVerificationRecord').map(value=>[value.stage,value.error??null]);

test('Node2 seller records (final review 3, Daybreak P2): with a sign authorization read held past the 10 s close bound, this process keeps the state lock until the old lane has ended and every journal closed; a fresh-process replacement refuses until then, and the old process writes nothing after the handoff',{timeout:540000},async t=>{
  let h,read=null;
  const logged=[],write=process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr,'write',(chunk,...rest)=>{logged.push(String(chunk));return write(chunk,...rest);});
  h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},authorizeSellerApproval:({request})=>{
    // The human approves the first held vet record; the ledger read of its sign authorization is then held.
    if(request.content.artifactKind==='CompositeVerificationRecord'&&!read)read=holdNextLedgerRead(t,join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'));
    return true;
  },authorizeBuyerApproval:()=>true});t.after(()=>closeAll(h));
  const purchase=h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-seller-records-close-bound'});purchase.catch(()=>{});
  for(let i=0;i<6000&&!read;i++)await new Promise(done=>setTimeout(done,10));
  assert.ok(read,'the first held vet record reached its sign authorization');
  await read.started;
  const state=h.config.stateDirectory,lock=join(state,'seller-state.lock'),holder=await readFile(lock,'utf8'),sent=h.node2.chain.wire.record.broadcastAttempts.length;
  const oldArtifacts=h.prepared.composition.publicJournal;
  const began=Date.now(),closeError=await h.operator.close().then(()=>null,error=>error);
  assert.ok(Date.now()-began>=10_000,'close returned at its 10 s bound');
  assert.equal(closeError?.code,'journal-busy','the old wallet lane is still active');
  assert.equal(fs.existsSync(lock)&&await readFile(lock,'utf8'),holder,'this process still holds the state lock');
  assert.deepEqual(await vetIntents(oldArtifacts),[['intent',null]],'the old workflow has not ended its vet intent yet');
  const lines=logged.join('');
  assert.ok(lines.includes('seller-policy: seller approval work was still in flight 10 s after close began; it is stopped, so it approves nothing more and writes nothing more to the approval ledger\n'),lines);
  assert.ok(lines.includes('seller-state: seller work is still in flight after close; this process keeps seller-state.lock until it has ended and every journal has closed\n'),lines);
  // A replacement in a fresh process: no in-memory serialization with this one.
  const refused=await replacementOperator(t,h.configPath);
  assert.equal(refused.code,3,refused.err);
  assert.deepEqual(JSON.parse(refused.out),{refused:{code:'seller_state_locked',reason:'held'}},'it refuses at the state lock while the old lane is active');
  assert.equal(await readFile(lock,'utf8'),holder);
  // The read returns: the stopped approval answers with an error and the old
  // lane unwinds; only then do its journals close and the lock go.
  read.release();
  for(let i=0;i<6000&&fs.existsSync(lock);i++)await new Promise(done=>setTimeout(done,5));
  assert.equal(fs.existsSync(lock),false,'the lock is released once the old lane has ended');
  const atHandoff=await sellerStateContent(state);
  const artifactsView=openDurableWalletJournal({path:join(state,'seller-artifacts.sqlite'),mode:'open'});
  try{assert.deepEqual(await vetIntents(artifactsView),[['issued','internal_error']],'the old workflow journalled its stopped-approval error before the handoff');}finally{artifactsView.close();}
  await assert.rejects(oldArtifacts.entries(),{code:'journal-closed'},'the old process artifact journal is closed');
  assert.ok(logged.join('').includes('seller-state: the seller work left at close has ended and every journal has closed; seller-state.lock is released\n'));
  assert.equal(await settledWithin(purchase,60000),true,'the old purchase ends');
  await new Promise(done=>setTimeout(done,500));
  assert.deepEqual(await sellerStateContent(state),atHandoff,'the old process writes no ledger, journal, party Vet or seller transport record after the handoff');
  const ledgerAtHandoff=await readFile(join(state,'evidence','seller-approvals.jsonl'),'utf8');
  // The fresh-process replacement now takes the state, lists the exact
  // attempt held (approved by hand, never sign-authorized) and sends nothing.
  const replaced=await replacementOperator(t,h.configPath);
  assert.equal(replaced.code,0,replaced.err);
  const [attemptId,attempt]=parsePolicyLedger(ledgerAtHandoff).attempts.entries().next().value;
  assert.deepEqual([attempt.outcome,attempt.manual,attempt.reservation],[null,true,null]);
  assert.deepEqual(JSON.parse(replaced.out).held.map(item=>[item.attemptId,item.reservationId,item.state]),[[attemptId,null,'approved-sign-unknown']]);
  assert.equal(await readFile(join(state,'evidence','seller-approvals.jsonl'),'utf8'),ledgerAtHandoff,'the replacement wrote nothing to the ledger');
  assert.equal(h.node2.chain.wire.record.broadcastAttempts.length,sent,'nothing was sent or resent');
  assert.equal(fs.existsSync(lock),false,'the replacement released the lock at its close');
});

test('Node2 seller records compose with Start intent, deadline watch and walkthrough switches',{timeout:540000},async t=>{
  const previous=Object.fromEntries(['DACS_INTENT_APPROVAL','DACS_DELIVERY_DEADLINE_WATCH','DACS_SHOWCASE_WALKTHROUGH','DACS_SELLER_IDENTITIES','DACS_IDENTITY_GITHUB_SIGNALS'].map(key=>[key,process.env[key]]));
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  process.env.DACS_INTENT_APPROVAL='on';process.env.DACS_DELIVERY_DEADLINE_WATCH='on';process.env.DACS_SHOWCASE_WALKTHROUGH='on';process.env.DACS_SELLER_IDENTITIES='on';process.env.DACS_IDENTITY_GITHUB_SIGNALS='on';
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy',purchaseSource:'seller'},sellerDeliveryEvidence:{enabled:true},authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  assert.equal(h.prepared.config.intentApproval,'on');assert.equal(h.prepared.config.deliveryDeadlineWatch,'on');assert.equal(h.prepared.config.showcaseWalkthrough,'on');
  // As on main, the dedicated operator profile keeps the application identity
  // gallery and remote GitHub signals off, regardless of these ambient switches.
  assert.equal(h.prepared.config.sellerIdentities,'off');assert.equal(h.prepared.config.identityGithubSignals,'off');
  const intent=await fetch(`${h.config.publicOrigin}/portal/assets/intent/intent.mjs`);
  assert.equal(intent.status,200);assert.match(await intent.text(),/intent/);
  // The intent gate applies to embedded-wallet Start; the existing exact local
  // operator buyer still completes the seller-records flow without resends.
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-intent-combined'});
  // The driver returns at delivery-ready or delivered, whichever it sees first
  // (operator-buyer.mjs); the seller's evidence readback may still be landing.
  // Verify until delivered, within a bounded wait.
  assert.ok(['delivery-ready','delivered'].includes(result.status),result.status);
  const accountId=h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(result.operationId).account_id;
  let stage=result.status;
  for(const deadline=Date.now()+120_000;stage!=='delivered'&&Date.now()<deadline;){
    await new Promise(resolve=>setTimeout(resolve,250));
    await h.application.services.purchases.verifyDeal({accountId,operationId:result.operationId});
    stage=h.application.services.purchases.status(accountId,result.operationId).protocol?.stage;
  }
  assert.equal(stage,'delivered');
  assert.deepEqual(h.prepared.operatorEvidence.sellerPolicyHeld,[]);
});

// Decision 2 (code review int58 P2): an operator already running main turns on seller records.
const journalIds=(h)=>Object.fromEntries(['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite'].map(name=>{const journal=openDurableWalletJournal({path:join(h.config.stateDirectory,name),mode:'open'});const id=journal.journalId;journal.close();return[name,id];}));
const turnOnSellerRecords=async(h)=>{h.config.sellerApproval={mode:'policy',purchaseSource:'seller'};await writeFile(h.configPath,`${JSON.stringify(h.config)}\n`,{mode:0o600});};
const evidenceFile=(h,name)=>join(h.config.stateDirectory,'evidence',name);
const assertBound=async(h,before,ids)=>{
  assert.deepEqual(JSON.parse(await readFile(evidenceFile(h,'seller-issuance-journals.json'),'utf8')).journals,ids,'the journals main created are kept and bound');
  const text=await readFile(evidenceFile(h,'seller-approvals.jsonl'),'utf8');
  assert.ok(text.startsWith(before),'main\'s ledger lines are unchanged');
  assert.deepEqual(text.slice(before.length).trim().split('\n').map(JSON.parse).map(({format,journals})=>({format,journals})),[{format:'dacs-seller-approval-ledger-journals/v1',journals:ids}]);
};

test('Node2 decision 2: an operator that ran main\'s default manual mode turns on seller records and keeps its journals',{timeout:540000},async t=>{
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'manual'},authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-enrol-manual'});
  assert.ok(['delivery-ready','delivered'].includes(result.status));
  await h.stop();
  const before=await readFile(evidenceFile(h,'seller-approvals.jsonl'),'utf8'),ids=journalIds(h);
  assert.ok(before.trim().split('\n').length>=4,'main wrote its manual approval lines');
  await turnOnSellerRecords(h);await h.restart();
  await assertBound(h,before,ids);assert.deepEqual(h.prepared.operatorEvidence.sellerPolicyHeld,[]);
});

test('Node2 decision 2: main\'s policy mode with the app as source turns on seller records once no reservation is unresolved; until then it is refused and nothing is bound',{timeout:540000},async t=>{
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy'},sellerDeliveryEvidence:{enabled:true},authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'p1-enrol-policy-app'});
  assert.equal(result.status,'delivered');
  await h.stop();
  // A reservation whose wallet outcome was unknown: main never completes it.
  const ledgerPath=evidenceFile(h,'seller-approvals.jsonl'),lines=(await readFile(ledgerPath,'utf8')).trim().split('\n').map(JSON.parse);
  const approved=lines.filter(row=>row.approvalMode==='policy'&&row.decision==='approved');
  assert.ok(approved.length>0&&approved.every(row=>lines.some(done=>done.format==='dacs-node2-seller-policy-attempt/v1'&&done.reservationId===row.reservationId)),'every reservation of the run is completed');
  const unknown={...approved.at(-1),reservationId:randomUUID()};
  await appendFile(ledgerPath,`${JSON.stringify(unknown)}\n`);
  const before=await readFile(ledgerPath,'utf8'),ids=journalIds(h);
  await turnOnSellerRecords(h);
  await assert.rejects(h.restart(),{message:SELLER_JOURNAL_REFUSALS.unboundHeld});
  assert.equal(await readFile(ledgerPath,'utf8'),before);
  await assert.rejects(readFile(evidenceFile(h,'seller-issuance-journals.json')),{code:'ENOENT'});
  assert.deepEqual(journalIds(h),ids,'the journals are untouched');
  // The documented resolution by hand: read back, then one completion line.
  await appendFile(ledgerPath,`${JSON.stringify({format:'dacs-node2-seller-policy-attempt/v1',reservationId:unknown.reservationId,approvalHash:unknown.approvalHash,outcome:'spent',recordedAt:Date.now()})}\n`);
  const resolved=await readFile(ledgerPath,'utf8');
  await h.restart();
  await assertBound(h,resolved,ids);assert.deepEqual(h.prepared.operatorEvidence.sellerPolicyHeld,[]);
});
