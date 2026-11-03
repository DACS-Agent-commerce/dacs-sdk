import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
const evidenceRows=async path=>(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
const evidenceAddress=(job)=>`dacs4:evidence:${job}`;
// Test-only seam: the seller artifact journal refuses the first delivery
// evidence intent write. That failure happens before the wallet is asked, so
// nothing is signed or sent and no intent is journaled.
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
const accountOf=(h,operationId)=>h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(operationId).account_id;
const statusOf=(h,operationId)=>h.application.services.purchases.status(accountOf(h,operationId),operationId).protocol;
const evidenceCreates=(h,job)=>h.node2.chain.wire.record.accepted.filter(tx=>tx.content.data[1].metadata.logicalAddress===evidenceAddress(job));
// Stands in for the operator's 5-minute evidence resume interval: tick() runs
// the registered pass the way the interval would and returns its promise.
const manualTimer=()=>{
  const registrations=[];
  return{registrations,every:(run,ms)=>{const handle={run,ms,cancelled:false};registrations.push(handle);return handle;},cancel:(handle)=>{handle.cancelled=true;},
    tick(){const live=registrations.filter(r=>!r.cancelled);assert.equal(live.length,1,'exactly one evidence resume interval is registered');assert.equal(live[0].ms,5*60*1000);return live[0].run();}};
};
const until=async(check,what,ms=60000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error(`timed out waiting for ${what}`);await new Promise(r=>setTimeout(r,100));}};


import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { copyFile } from 'node:fs/promises';
import { createPurchaseService } from '../src/purchases.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

test('paid foreign recovery requires exact manual approval with a closed-access notice',{timeout:540000},async t=>{
  const approvals=[],fault=failEvidenceIntentOnce(),timer=manualTimer();
  const h=await startOperatorPurchaseNode2({openBuyerAccess:true,sellerApproval:{mode:'policy'},sellerDeliveryEvidence:{enabled:true},wrapPublicJournal:fault.wrap,evidenceResumeTimer:timer,authorizeSellerApproval:input=>{approvals.push(input);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'review-foreign-evidence'});
  assert.equal(result.status,'delivery-ready');assert.equal(evidenceCreates(h,result.jobId).length,0);
  // A different configured custody buyer after restart makes this genuinely
  // authenticated retained purchase foreign to closed access.
  const replacement=join(h.root,'replacement-custody');
  await bootstrapTestWalletCustody({directory:replacement,publicOrigin:h.config.publicOrigin});
  await copyFile(join(replacement,'buyer-wallet.json'),join(h.config.custodyDirectory,'buyer-wallet.json'));
  h.config.openBuyerAccess=false;await writeFile(h.configPath,JSON.stringify(h.config));
  const before=h.node2.chain.wire.record.broadcastAttempts.length;
  await h.restart();
  const resumed=await h.operator.resumeHeldDeliveryEvidence();
  await timer.tick();
  assert.notEqual(h.prepared.operatorEvidence.buyer,result.buyer);
  assert.equal(h.composition.dacsProtocol.buyerAccess.allowsWallet(`0x${result.buyer.slice('did:demos:agent:'.length)}`),false);
  const accountId=accountOf(h,result.operationId),operation=h.application.services.ops.get(accountId,result.operationId),history=h.application.services.ops.history(result.operationId);
  const source=h.prepared.composition.sourceCapability,coords=h.application.services.coordinates.get(result.operationId);
  for(const [key,value] of await source.journal.entries())if(value.hash===coords.reportedTxHash)await source.journal.put(key,{...value,stage:'broadcast-started'});
  const sourceBefore=await source.journal.entries();
  const token=h.application.services.ops.handoffTokenFor(result.operationId);
  const recheck=await h.application.services.purchases.protocolRecheck({operationId:result.operationId,token});
  assert.equal(recheck.verification.outcome,'readback_only');
  const verified=await h.application.services.purchases.verifyDeal({accountId,operationId:result.operationId});
  assert.equal(verified.verification.outcome,'readback_only');assert.equal(verified.verification.observation.status,'included',JSON.stringify(verified.verification));
  assert.deepEqual(h.application.services.ops.get(accountId,result.operationId),operation);assert.deepEqual(h.application.services.ops.history(result.operationId),history);
  // A refused legacy buyer's reported pointer that names this other wallet's
  // retained native transfer is observed read-only: no persisting readback.
  const pointer=structuredClone(operation);pointer.id='foreign-legacy-pointer';pointer.terms.buyer.wallet=createEphemeralWallet().address;delete pointer.terms.protocol;
  const pointerService=createPurchaseService({db:{prepare:()=>({})},config:{},ops:{get:()=>pointer,getByHandoff:()=>pointer},coordinates:{get:()=>({reportedTxHash:coords.reportedTxHash})},
    protocol:h.application.services.protocol,chain:source.chainReader()});
  const pointed=await pointerService.verifyDeal({accountId:'foreign-legacy',operationId:pointer.id});
  assert.equal(pointed.verification.outcome,'readback_only');assert.equal(pointed.verification.observation.status,'included',JSON.stringify(pointed.verification));
  assert.equal(JSON.stringify(await source.journal.entries()),JSON.stringify(sourceBefore),'the source journal is byte-identical after the foreign pointer');
  const wallet=operation.terms.buyer.wallet;
  const raw=await fetch(`${h.config.publicOrigin}/portal/api/devnet-native-wallet-binding`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phase:'readback',address:wallet,hash:coords.reportedTxHash})});
  const readonly=await raw.json();assert.equal(readonly.status,'readback-only');assert.equal(readonly.noResend,true);assert.equal(readonly.observation.status,'included');
  assert.deepEqual(await source.journal.entries(),sourceBefore);
  assert.equal(evidenceCreates(h,result.jobId).length,1);
  assert.equal(h.node2.chain.wire.record.broadcastAttempts.length,before+1);
  const rows=await evidenceRows(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'));
  const evidence=rows.filter(row=>row.requestBytes&&!row.confirmation&&JSON.parse(row.requestBytes).content?.logicalAddress===evidenceAddress(result.jobId));
  assert.deepEqual(evidence.map(row=>[row.approvalMode??'manual',row.decision,row.policyReason??null]),[['policy','rejected','purchase'],['manual','approved',null]]);
  const manual=approvals.filter(input=>input.request.content?.logicalAddress===evidenceAddress(result.jobId));
  assert.equal(manual.length,1);assert.match(manual[0].notice,/buyer is outside closed access/i);
  t.diagnostic(JSON.stringify({buyer:result.buyer,custody:h.prepared.operatorEvidence.buyer,resumed,evidenceDecisions:evidence.map(row=>[row.approvalMode??'manual',row.decision,row.policyReason??null])}));
});


test('closed prepayment recheck refuses already observed Agreement without another read',{timeout:180000},async t=>{
  let reads=0,requests=0;
  const h=await startOperatorPurchaseNode2({openBuyerAccess:true,sellerApproval:{mode:'policy'},
    rpcFault:()=>{reads++;return null;},authorizeSellerApproval:()=>true,authorizeBuyerApproval:({scope})=>{requests++;return scope.kind!=='native-payment';}});
  t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'anchored-before-closure'});
  assert.equal(result.status,'declined');assert.equal(h.node2.chain.record.broadcasts.length,0);
  // This case has known inclusion receipts; the unknown-outcome case above
  // deliberately retains broadcast-started instead. Normalize the fixture's
  // source records to observed before closing access.
  const originalSource=h.prepared.composition.sourceCapability;
  for(const [key,value] of await originalSource.journal.entries())if(value.signedTransaction?.content?.from===`0x${h.prepared.operatorEvidence.buyer.slice('did:demos:agent:'.length)}`){
    assert.ok(h.node2.chain.wire.record.accepted.some(tx=>tx.hash===value.hash));
    await originalSource.journal.put(key,{...value,stage:'observed'});
  }
  const replacement=join(h.root,'replacement-custody');
  await bootstrapTestWalletCustody({directory:replacement,publicOrigin:h.config.publicOrigin});
  await copyFile(join(replacement,'buyer-wallet.json'),join(h.config.custodyDirectory,'buyer-wallet.json'));
  h.config.openBuyerAccess=false;await writeFile(h.configPath,JSON.stringify(h.config));await h.restart();
  const svc=h.application.services,accountId=accountOf(h,result.operationId),operation=svc.ops.get(accountId,result.operationId),history=svc.ops.history(result.operationId),token=svc.ops.handoffTokenFor(result.operationId);
  const source=h.prepared.composition.sourceCapability,before=await source.journal.entries(),effects={reads,requests,broadcasts:h.node2.chain.wire.record.broadcastAttempts.length};
  const closed=error=>error.code==='buyer_access_closed';
  await assert.rejects(svc.purchases.protocolRecheck({operationId:result.operationId,token}),closed);
  await assert.rejects(svc.protocol.recheck(operation),closed);
  assert.deepEqual({reads,requests,broadcasts:h.node2.chain.wire.record.broadcastAttempts.length},effects);
  assert.deepEqual(svc.ops.get(accountId,result.operationId),operation);assert.deepEqual(svc.ops.history(result.operationId),history);assert.deepEqual(await source.journal.entries(),before);
});
