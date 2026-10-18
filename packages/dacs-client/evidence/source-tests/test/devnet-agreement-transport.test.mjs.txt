import test from 'node:test';
import assert from 'node:assert/strict';
import {devnetAgreementTransportFlow} from './helpers/devnet-agreement-transport-flow.mjs';
import {isDevnetNativeTransport,isDevnetAgreementTransport} from '../src/wallet/devnet-native-transport.mjs';
import {devnetAgreementRepeatBuyer} from './helpers/devnet-agreement-transport-repeat.mjs';
test('actual MCP/portal source Agreement CREATE then independently read mixed fixture commitment and approved native DEM payment over marker-free owned HTTPS; durable restart and no resend', {timeout:90000},async t=>{
 const w=await devnetAgreementTransportFlow(t);
 assert.equal(isDevnetAgreementTransport(w.h.capability),true);assert.equal(isDevnetNativeTransport(w.h.capability),false);
 assert.equal(w.op().terms.domain.mode,'public-chain-read');assert.deepEqual(w.op().terms.protocol.transportBinding,w.h.capability.transportBinding);
 const committed=await w.agreement();assert.equal(committed.status,'awaiting_approval',JSON.stringify(committed));
 const create=w.h.chain.wire.record.accepted[0];assert.equal(create.content.nonce,1);assert.deepEqual(create.content.data[1].metadata.networkBinding,w.op().terms.protocol.transportBinding);
 const plan=(await w.h.journal.entries()).find(([key])=>key.startsWith('sr2/adapter/'))[1];assert.equal(plan.evidenceMode,'explicit-pinned-transport-single-node');assert.equal(plan.stage,'verified');assert.equal(plan.authorizedTransaction.hash,create.hash);
 const {handoff}=await w.approve();assert.equal(handoff.status,'payment_handoff',JSON.stringify(handoff));assert.equal(handoff.payload.content.nonce,2);
 const sent=await w.send(handoff.payload);assert.equal(sent.success,true,JSON.stringify(sent));
 const result=await w.api('report',{txHash:sent.data.hash});assert.equal(result.status,'settled_verified',JSON.stringify(result));assert.equal(result.evidence.receipt.finality,'not-established');
 assert.equal(w.h.chain.wire.record.accepted.length,1);assert.equal(w.h.chain.record.broadcasts.length,1);assert.equal(w.h.chain.record.accepted.length,1);
 assert.ok(w.h.responseMarkers.every(x=>x===null));assert.equal(w.op().state.protocol.commitment.substrate,'simulated-fixture');
 const approval=w.approvals.find(r=>r.content?.action==='native DEM transfer').content;assert.equal(approval.debit.totalOs,'8500000000');assert.equal(approval.networkBinding.chainIdentity,w.h.expected.chainIdentity);
 await w.h.restart();assert.equal((await w.verify()).status,'settled_verified');assert.equal((await w.api('handoff')).error,'invalid_state');assert.equal(w.h.chain.record.broadcasts.length,1);
 t.diagnostic(JSON.stringify({operation:w.id,createHash:create.hash,paymentHash:sent.data.hash,nonces:[1,2],sourcePin:w.h.expected.chainIdentity,totalDebitOs:approval.debit.totalOs,creates:1,nativeSends:1,restarts:w.h.restarts(),substrate:'native Agreement/payment; fixture seller commitment',finality:'not-established',markerRequired:false}));
});
for(const outcome of ['drop-after-apply','drop-before-apply'])test('source native unknown '+outcome+': durable original signed intent, independent readback only and no repeated handoff/send',async t=>{
 const w=await devnetAgreementTransportFlow(t);await w.agreement();const {handoff}=await w.approve();w.h.chain.paymentFaults.payment=outcome;
 const sent=await w.send(handoff.payload);assert.equal(sent.error.code,'outcome_unknown',JSON.stringify(sent));assert.equal(w.h.chain.record.broadcasts.length,1);
 const result=await w.api('report',{walletError:sent.error.message,txHash:sent.data.hash});assert.equal(result.status,outcome==='drop-after-apply'?'settled_verified':'broadcast_reported',JSON.stringify(result));
 await w.h.restart();assert.equal((await w.verify()).status,result.status);assert.equal((await w.api('handoff')).error,'invalid_state');
 assert.equal((await w.send(handoff.payload)).success,false);assert.equal(w.h.chain.record.broadcasts.length,1);
 const retained=(await w.h.journal.entries()).find(([key,r])=>key.startsWith('devnet/native-transfer/')&&r.hash===sent.data.hash)[1];
 assert.equal(retained.signedTransaction.hash,sent.data.hash);assert.equal(retained.stage,outcome==='drop-after-apply'?'observed':'broadcast-started');
 t.diagnostic(JSON.stringify({outcome,hash:sent.data.hash,status:result.status,retained:retained.stage,sends:1,restarts:w.h.restarts(),noResend:true}));
});
test('same source-bound buyer two purchases across restart: CREATE/payment nonce and block 1/2/3/4, stable original hashes and older receipts never release newer work',async t=>{
 const b=await devnetAgreementRepeatBuyer(t),transactions=[],receipts=[];
 for(const tag of ['first','second']){
   const p=await b.purchase(tag);assert.equal(p.prepared.status,'agreement_pending',JSON.stringify(p.prepared));
   const agreement=await p.agreement();assert.equal(agreement.delivered.state,'completed',JSON.stringify(agreement));assert.equal(agreement.verified.status,'awaiting_approval',JSON.stringify(agreement));
   const h=await p.approve();assert.equal(h.status,'payment_handoff');assert.equal(h.payload.content.nonce,transactions.length+2);
   const sent=await p.send(h.payload);assert.equal(sent.success,true,JSON.stringify(sent));
   const reported=await p.api('report',{txHash:sent.data.hash});assert.equal(reported.status,'settled_verified',JSON.stringify(reported));
   const i=transactions.length/2;transactions.push(b.h.chain.wire.record.accepted[i],b.h.chain.record.accepted[i]);receipts.push(structuredClone(p.op().state.protocol.agreement.anchorReceipt));
   await b.h.restart();assert.equal((await p.verify()).status,'settled_verified');
 }
 const read=(message,data)=>b.h.capability.readRpc('/',{method:'nodeCall',params:[{message,data}]}).then(r=>r.response);
 const snapshots=[];
 for(const [i,tx]of transactions.entries()){
   const observed=await read('getTxByHash',{hash:tx.hash}),block=await read('getBlockByNumber',{blockNumber:i+1});
   assert.equal(observed.hash,tx.hash);assert.equal(observed.blockNumber,i+1);assert.equal(observed.content.nonce,String(i+1));assert.deepEqual(block.content.ordered_transactions,[tx.hash]);snapshots.push({observed,block});
 }
 assert.equal(new Set(transactions.map(tx=>tx.hash)).size,4);assert.equal(new Set(snapshots.map(s=>s.block.hash)).size,4);
 await b.h.restart();
 for(const [i,tx]of transactions.entries()){assert.deepEqual(await read('getTxByHash',{hash:tx.hash}),snapshots[i].observed);assert.deepEqual(await read('getBlockByNumber',{blockNumber:i+1}),snapshots[i].block);}
 assert.equal(b.h.chain.wire.record.accepted.length,2);assert.equal(b.h.chain.record.broadcasts.length,2);assert.equal(b.approvals.filter(r=>r.content?.action==='native DEM transfer').length,2);
 t.diagnostic(JSON.stringify({nonces:transactions.map(tx=>tx.content.nonce),hashes:transactions.map(tx=>tx.hash),blocks:snapshots.map(s=>s.block.number),creates:2,payments:2,restarts:b.h.restarts(),finality:'not-established'}));
});
