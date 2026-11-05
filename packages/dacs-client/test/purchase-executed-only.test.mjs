// D16 launch review: buyer verification settles only an executed transfer.
// An included observation is not enough: the fresh canonical body must be
// confirmed, carry the requested hash and observed block, and agree with any
// source readback. Anything else settles nothing, records no consumed nonce
// and keeps the same hash for readback. The source SQLite store is passed as
// the D11 PurchaseStore parameter, as in purchase-integrity.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase, transaction, isUniqueViolation } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { nodeProjectedNonce } from '../src/dacs/chain.mjs';
const store={transaction,isUniqueViolation},purposes={APPROVE_PURCHASE:'approve-purchase'};
const CHAIN='f'.repeat(64), WALLET='0x'+'a'.repeat(64), PAYEE='0x'+'7'.repeat(64), HASH='1'.repeat(64), AMOUNT='2500000000';
const INCLUDED={status:'included',payer:WALLET,payee:PAYEE,amountOs:AMOUNT,blockNumber:10};
const NATIVE_TERMS={protocol:{profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',nativePayment:'native-dem-once-after-public-agreement-and-fixture-commitment',sellerAgreementProjection:'public-signed-create'}};
function world(t,{observation=INCLUDED,body={},native=false,classifier,settlementError}={}) {
 const dir=mkdtempSync(join(tmpdir(),'executed-only-')),db=openDatabase(join(dir,'state.sqlite'));
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const ops=createOperationStore({db,handoffSecret:'TEST-'.repeat(8)}),coordinates=createCoordinateStore({db}),reads=[];
 db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer','TEST','TEST-buyer',new Date().toISOString());
 const chain={network:'testnet',pinnedIdentity:CHAIN,rpcOrigin:'https://rpc.invalid',evidenceMode:'TEST-stub',networkIdentity:async()=>({identity:CHAIN,mode:'public-chain-read'}),
  async observeTransfer(hash){reads.push('observe');return {...observation,txHash:hash};},
  async getTransaction(hash){reads.push('body');return {hash,status:'confirmed',blockNumber:10,content:{from:WALLET,nonce:7},...body};}};
 const terms={buyer:{wallet:WALLET},seller:{payee:PAYEE,claim:'TEST-seller'},price:{amountOs:AMOUNT,amount:'2.5'},listing:{listingId:'TEST-listing',version:1,contentHash:CHAIN},network:'testnet',rail:'demos-native:DEM',domain:{network:'testnet',rail:'demos-native:DEM',mode:'public-chain-read',chainIdentity:CHAIN},...(native?NATIVE_TERMS:{})};
 const op=ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:'TEST-once',request:{},status:'broadcast_reported',terms,termsHash:CHAIN,expiresAt:new Date(Date.now()+3600000).toISOString()}).operation;
 coordinates.save({operationId:op.id,kind:'native-dem-transfer',network:'testnet',from:WALLET,nonceFence:6,expectedNonce:7,target:PAYEE,amountOs:AMOUNT,payload:{content:{nonce:7}}});
 assert.equal(coordinates.reportHash(op.id,HASH),true);
 const protocol=native?{nativePaymentSuperseded:async()=>true,nativeIntentsSupersededBy:async()=>[]}:undefined;
 if (settlementError) {
  const transition = ops.transition;
  ops.transition = (...args) => { if (args[2] === 'settled_verified') throw settlementError; return transition(...args); };
 }
 const purchases=createPurchaseService({db,ops,coordinates,config:{},chain,protocol,store:classifier ? {...store,isUniqueViolation:classifier} : store,purposes});
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

// The canonical body as the real node serves it. Field for field as node2
// answered getTxByHash for native send cbabec31... (block 563635, read
// 2026-10-19), with TEST addresses and this purchase's price: nonce and
// timestamp are decimal text, amount and fees are OS numbers, the send's
// amount argument is OS text and every GCR edit carries the hash.
const node2Body=hash=>({content:{type:'native',from:WALLET,to:PAYEE,from_ed25519_address:WALLET,amount:Number(AMOUNT),nonce:'7',timestamp:'1792395912567',
  transaction_fee:{network_fee:1000000000,rpc_fee:1000000000,additional_fee:0,rpc_address:null},
  data:['native',{nativeOperation:'send',args:[PAYEE,AMOUNT]}],
  gcr_edits:[{type:'balance',operation:'remove',isRollback:false,account:WALLET,txhash:hash,amount:AMOUNT},
   {type:'balance',operation:'add',isRollback:false,account:PAYEE,txhash:hash,amount:AMOUNT},
   {type:'balance',account:WALLET,operation:'remove',amount:'1000000000',txhash:hash,isRollback:false},
   {type:'nonce',operation:'add',account:WALLET,amount:1,txhash:hash,isRollback:false}]},
 signature:{type:'ed25519',data:'0x'+'0'.repeat(128)},ed25519_signature:null,hash,status:'confirmed',blockNumber:10,attrs:{reference_block:9}});

for(const native of [false,true]) {
 test(`node2-shaped body: a decimal-text nonce settles the ${native?'native':'default'} purchase once`,async t=>{
  const w=world(t,{native,body:node2Body(HASH)}),{operation,verification}=await w.verify();
  assert.equal(verification.outcome,'verified');assert.equal(operation.status,'settled_verified');
  assert.equal(w.state().coordinate.observation.txNonce,7);assert.equal(w.state().consumed,1);
  // A repeated check returns the same settlement and records nothing more.
  const again=await w.verify();
  assert.equal(again.verification.outcome,'verified');assert.equal(again.operation.status,'settled_verified');
  assert.equal(w.state().consumed,1);
 });
}

for(const [name,nonce] of [['missing',undefined],['null',null],['leading zero','07'],['whitespace',' 7'],['sign','+7'],['fraction','7.0'],
 ['exponent','7e0'],['hex','0x7'],['empty',''],['unsafe text','9007199254740993'],['negative',-7],['fractional number',7.5],['object',{value:7}]]) {
 test(`node2-shaped body: unreadable nonce (${name}) keeps the hash and status`,async t=>{
  const w=world(t,{body:{content:{...node2Body(HASH).content,nonce}}}),{verification}=await w.verify();
  assert.equal(verification.outcome,'transaction_unconfirmed');assert.equal(verification.txNonce,null);
  assert.equal(verification.rejectedReason,'canonical transaction nonce is missing or unreadable');
  assertUnsettled(w,'broadcast_reported');
 });
}

for(const [name,payer] of [['missing',{from:undefined,from_ed25519_address:undefined}],['malformed ed25519 payer',{from_ed25519_address:'TEST-not-an-address'}],['non-string payer',{from_ed25519_address:7}]]) {
 test(`node2-shaped body: unreadable payer (${name}) keeps the hash and status`,async t=>{
  const w=world(t,{body:{content:{...node2Body(HASH).content,...payer}}}),{verification}=await w.verify();
  assert.equal(verification.outcome,'transaction_unconfirmed');
  assert.equal(verification.rejectedReason,'canonical transaction payer is missing or unreadable');
  assertUnsettled(w,'broadcast_reported');
 });
}

for(const [name,content,reason] of [['another nonce',{nonce:'8'},'transaction nonce is not the pre-saved expected nonce'],
 ['another payer',{from_ed25519_address:'0x'+'b'.repeat(64)},'payer is not the approved buyer wallet']]) {
 test(`node2-shaped body: a readable ${name} still rejects the pointer`,async t=>{
  const w=world(t,{body:{content:{...node2Body(HASH).content,...content}}}),{operation,verification}=await w.verify();
  assert.equal(verification.outcome,'pointer_rejected');assert.deepEqual(verification.mismatches,[reason]);
  assert.equal(operation.status,'payment_uncertain');assert.equal(w.state().coordinate.reportedTxHash,null);
  assert.equal(w.state().consumed,0);
 });
}

test('nodeProjectedNonce reads a safe integer or its canonical decimal text, and nothing else',()=>{
 for(const [input,want] of [[0,0],['0',0],[7,7],['7',7],['198',198],['9007199254740991',9007199254740991],[9007199254740991,9007199254740991]])
  assert.equal(nodeProjectedNonce(input),want,JSON.stringify(input));
 for(const input of [undefined,null,'','07',' 7','7 ','+7','-7','7.0','7e0','0x7','9007199254740992','9007199254740993',-1,-0,-0.5,7.5,9007199254740992,Number.NaN,true,{},[7]])
  assert.equal(nodeProjectedNonce(input),null,String(input));
});

for (const value of [false, true, 'promise', 'throw', null, 1]) {
 test(`settlement classifier preserves exact synchronous boolean semantics: ${value}`, async t => {
  const cause = new Error('TEST-storage-failure'), classifierCause = new Error('TEST-classifier-failure');
  const classifier = () => { if (value === 'throw') throw classifierCause; return value === 'promise' ? Promise.resolve(false) : value; };
  const w = world(t, { classifier, settlementError: cause });
  await assert.rejects(w.verify(), error => value === false ? error === cause
   : value === true ? error.code === 'hash_conflict'
   : value === 'throw' ? error === classifierCause : error.code === (value === 'promise' ? 'purchase_store_async_classifier_result' : 'purchase_store_invalid_classifier_result'));
  assertUnsettled(w, 'broadcast_reported');
 });
}
