// D16 launch review: buyer verification settles only an executed transfer.
// An included observation is not enough: the fresh canonical body must be
// confirmed, carry the requested hash and observed block, and agree with any
// source readback. Anything else settles nothing, records no consumed nonce
// and keeps the same hash for readback. A test-only module hook supplies SQLite
// transactions to the inert D11 stub, as in purchase-integrity.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
registerHooks({resolve(specifier,context,next){
  if(specifier.endsWith('/seams/purchase-store-not-wired.mjs')) return {url:new URL('./helpers/purchase-integrity-database.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const { createPurchaseService } = await import('../src/purchases.mjs');
const { createCoordinateStore } = await import('../src/dacs/wallet-transactions.mjs');
const CHAIN='f'.repeat(64), WALLET='0x'+'a'.repeat(64), PAYEE='0x'+'7'.repeat(64), HASH='1'.repeat(64), AMOUNT='2500000000';
const INCLUDED={status:'included',payer:WALLET,payee:PAYEE,amountOs:AMOUNT,blockNumber:10};
function world(t,{observation=INCLUDED,body={}}={}) {
 const dir=mkdtempSync(join(tmpdir(),'executed-only-')),db=openDatabase(join(dir,'state.sqlite'));
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const ops=createOperationStore({db,handoffSecret:'TEST-'.repeat(8)}),coordinates=createCoordinateStore({db}),reads=[];
 db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer','TEST','TEST-buyer',new Date().toISOString());
 const chain={network:'testnet',pinnedIdentity:CHAIN,rpcOrigin:'https://rpc.invalid',evidenceMode:'TEST-stub',networkIdentity:async()=>({identity:CHAIN,mode:'public-chain-read'}),
  async observeTransfer(hash){reads.push('observe');return {...observation,txHash:hash};},
  async getTransaction(hash){reads.push('body');return {hash,status:'confirmed',blockNumber:10,content:{from:WALLET,nonce:7},...body};}};
 const terms={buyer:{wallet:WALLET},seller:{payee:PAYEE,claim:'TEST-seller'},price:{amountOs:AMOUNT,amount:'2.5'},listing:{listingId:'TEST-listing',version:1,contentHash:CHAIN},network:'testnet',rail:'demos-native:DEM',domain:{network:'testnet',rail:'demos-native:DEM',mode:'public-chain-read',chainIdentity:CHAIN}};
 const op=ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:'TEST-once',request:{},status:'broadcast_reported',terms,termsHash:CHAIN,expiresAt:new Date(Date.now()+3600000).toISOString()}).operation;
 coordinates.save({operationId:op.id,kind:'native-dem-transfer',network:'testnet',from:WALLET,nonceFence:6,expectedNonce:7,target:PAYEE,amountOs:AMOUNT,payload:{content:{nonce:7}}});
 assert.equal(coordinates.reportHash(op.id,HASH),true);
 const purchases=createPurchaseService({db,ops,coordinates,config:{},chain});
 return {reads,verify:()=>purchases.verifyDeal({accountId:'TEST-buyer',operationId:op.id}),
  state:()=>({operation:ops.get('TEST-buyer',op.id),coordinate:coordinates.get(op.id),consumed:db.prepare('SELECT count(*) AS n FROM wallet_nonce_consumptions').get().n})};
}
function assertUnsettled(w,status) {
 const s=w.state();
 assert.equal(s.operation.status,status);
 assert.ok(!s.coordinate.verifiedAt,'no verification is recorded');
 assert.equal(s.consumed,0,'no wallet nonce consumption is recorded');
 assert.equal(s.coordinate.reportedTxHash,HASH,'the same hash stays retained for readback');
}

test('executed-only control: a confirmed body in the observed block settles, labelled a single-node observation',async t=>{
 const w=world(t),{operation,verification}=await w.verify();
 assert.equal(verification.outcome,'verified');assert.equal(operation.status,'settled_verified');
 assert.equal(verification.txStatus,'confirmed');assert.equal(verification.slotConsumed,true);
 assert.match(verification.observer,/single-node consistent view; not a validator-quorum proof/);
 assert.ok(w.state().coordinate.verifiedAt);assert.equal(w.state().consumed,1);
});

for(const [name,options,outcome,status] of [
 ['failed execution',{body:{status:'failed'}},'execution_failed','payment_uncertain'],
 ['pending body',{body:{status:'pending'}},'awaiting_inclusion','broadcast_reported'],
 ['body without a status',{body:{status:undefined}},'transaction_unconfirmed','broadcast_reported'],
 ['unknown body status',{body:{status:'unknown'}},'transaction_unconfirmed','broadcast_reported'],
 ['body for another hash',{body:{hash:'2'.repeat(64)}},'transaction_unconfirmed','broadcast_reported'],
 ['body in another block',{body:{blockNumber:11}},'invalid_observation','broadcast_reported'],
 ['failed source readback',{observation:{...INCLUDED,sourceDisposition:'failed'}},'transaction_unconfirmed','broadcast_reported'],
]) {
 test(`executed-only: ${name} settles nothing (${outcome})`,async t=>{
  const w=world(t,options),{verification}=await w.verify();
  assert.equal(verification.outcome,outcome);
  assertUnsettled(w,status);
  assert.equal(w.state().coordinate.observation.slotConsumed,false);
  if(outcome==='execution_failed'){
   assert.equal(verification.txStatus,'failed');assert.equal(verification.rejectedReason,'canonical transaction execution failed');
   // A repeated check reads the same hash again and still settles nothing.
   assert.equal((await w.verify()).verification.outcome,'execution_failed');
   assertUnsettled(w,status);
  }
 });
}

for(const [status,outcome] of [['pending','awaiting_inclusion'],['not-found','awaiting_inclusion'],['unavailable','chain_unavailable']]) {
 test(`executed-only: observation ${status} reads no body and settles nothing`,async t=>{
  const w=world(t,{observation:{status}}),{verification}=await w.verify();
  assert.equal(verification.outcome,outcome);
  assert.deepEqual(w.reads,['observe']);
  assertUnsettled(w,'broadcast_reported');
 });
}
