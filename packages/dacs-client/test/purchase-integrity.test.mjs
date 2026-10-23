// D15 offline races. The test passes the source SQLite store as the D11
// PurchaseStore parameter, as a host application does.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase, transaction, isUniqueViolation } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
const store={transaction,isUniqueViolation},purposes={APPROVE_PURCHASE:'approve-purchase'};
const CHAIN='f'.repeat(64), WALLET='0x'+'a'.repeat(64), PAYEE='0x'+'7'.repeat(64), A='1'.repeat(64), B='2'.repeat(64), AMOUNT='2500000000';
function world(t,{aStatus='included',bStatus='pending'}={}) {
 const dir=mkdtempSync(join(tmpdir(),'d15-race-')),file=join(dir,'state.sqlite'),connections=[];
 t.after(()=>{for(const db of connections)db.close();rmSync(dir,{recursive:true,force:true});});
 const open=()=>{const db=openDatabase(file);connections.push(db);return {db,ops:createOperationStore({db,handoffSecret:'TEST-only-d15-offline-secret-0000000000'}),coordinates:createCoordinateStore({db})};};
 let active=open();active.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer','TEST','TEST-buyer',new Date().toISOString());
 let enter,release;const readingA=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const included=hash=>({status:'included',txHash:hash,payer:WALLET,payee:PAYEE,amountOs:AMOUNT,blockNumber:10});
 const chain={network:'testnet',pinnedIdentity:CHAIN,rpcOrigin:'https://rpc.invalid',evidenceMode:'TEST-stub',networkIdentity:async()=>({identity:CHAIN,mode:'public-chain-read'}),
  async observeTransfer(hash){if(hash===A){enter();await gate;return aStatus==='included'?included(A):{status:aStatus};}return bStatus==='included'?included(B):{status:bStatus};},
  getTransaction:async hash=>({hash,status:'confirmed',blockNumber:10,content:{from:WALLET,nonce:7}})};
 const service=()=>createPurchaseService({...active,config:{},chain,store,purposes});let purchases=service();
 const terms={buyer:{wallet:WALLET},seller:{payee:PAYEE,claim:'TEST-seller'},price:{amountOs:AMOUNT,amount:'2.5'},listing:{listingId:'TEST-listing',version:1,contentHash:CHAIN},network:'testnet',rail:'demos-native:DEM',domain:{network:'testnet',rail:'demos-native:DEM',mode:'public-chain-read',chainIdentity:CHAIN}};
 const make=(key,status)=>{
  const op=active.ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:key,request:{key},status,terms,termsHash:CHAIN,expiresAt:new Date(Date.now()+3600000).toISOString()}).operation;
  active.coordinates.save({operationId:op.id,kind:'native-dem-transfer',network:'testnet',from:WALLET,nonceFence:6,expectedNonce:7,target:PAYEE,amountOs:AMOUNT,payload:{content:{nonce:7}}});return op;
 };
 const op=make('delayed-A','broadcast_reported'),other=make('other-lane','payment_handoff');
 assert.equal(active.coordinates.reportHash(op.id,A),true);
 return {op,other,readingA,release,
  verify:hash=>purchases.verifyDeal({accountId:'TEST-buyer',operationId:op.id,...(hash?{txHash:hash}:{})}),
  reportB:()=>active.coordinates.replaceUnobservedHash(op.id,B),
  restart:()=>{active=open();purchases=service();},
  state:()=>({operation:active.ops.get('TEST-buyer',op.id),coordinate:active.coordinates.get(op.id),other:active.ops.get('TEST-buyer',other.id),otherCoordinate:active.coordinates.get(other.id),consumptions:active.db.prepare('SELECT * FROM wallet_nonce_consumptions WHERE tx_hash = ?').all(A)}),
  coords:()=>active.coordinates};
}
for(const restart of [false,true])for(const order of ['reported-B','observed-B'])for(const aStatus of ['included','pending']) {
 test(`D15 completion-orders/existing-b-observation/other-purchase-lane${restart?'/restart':''}: ${order}, stale A ${aStatus}`,async t=>{
  const w=world(t,{aStatus}),pending=w.verify();await w.readingA;
  try {
   if(order==='reported-B')assert.equal(w.reportB(),true);else await w.verify(B);
   if(restart)w.restart();
   const before=w.state();w.release();const answer=await pending,after=w.state();
   assert.equal(after.coordinate.reportedTxHash,B,'B remains the retained pointer');
   assert.deepEqual(after.coordinate.observation,before.coordinate.observation,'stale A cannot overwrite B observation');
   assert.equal(after.operation.status,before.operation.status,'stale A cannot settle or change B status');
   assert.equal(after.coordinate.verifiedAt,before.coordinate.verifiedAt,'stale A cannot verify B');
   assert.deepEqual(after.consumptions,[],'stale A cannot write durable nonce consumption');
   assert.deepEqual(after.other,before.other,'stale A cannot supersede another purchase');
   assert.deepEqual(after.otherCoordinate,before.otherCoordinate,'stale A cannot consume another lane');
   assert.equal(answer.verification.outcome,'stale_readback','caller receives the current pointer without a stale success');
  } finally {w.release();await pending;}
 });
}
for(const restart of [false,true])test(`D15 completion-orders${restart?'/restart':''}: B settles before included A returns`,async t=>{
 const w=world(t,{bStatus:'included'}),pending=w.verify();await w.readingA;
 try {assert.equal((await w.verify(B)).verification.outcome,'verified');assert.equal(w.state().other.status,'superseded');assert.equal(w.state().otherCoordinate.observation.txHash,B);assert.equal(w.state().otherCoordinate.observation.supersededBy,w.op.id);if(restart)w.restart();const before=w.state();w.release();await pending;const after=w.state();assert.deepEqual(after.coordinate,before.coordinate);assert.deepEqual(after.consumptions,[],'stale A cannot record consumption after B settled');}finally{w.release();await pending;}
});
for(const verified of [false,true])test(`D15 coordinate CAS: stale A ${verified?'verified':'unverified'} observation cannot replace B`,t=>{
 const w=world(t);assert.equal(w.reportB(),true);w.coords().recordObservation(w.op.id,{txHash:B,status:'pending'},false);const before=w.state();w.coords().recordObservation(w.op.id,{txHash:A,status:'included'},verified);assert.deepEqual(w.state().coordinate,before.coordinate);
});
