// Offline destination regressions added during the D15 decision review.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase, transaction, isUniqueViolation } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
const store = { transaction, isUniqueViolation }, purposes = { APPROVE_PURCHASE: 'approve-purchase' };
const CHAIN='f'.repeat(64), WALLET='0x'+'a'.repeat(64), PAYEE='0x'+'7'.repeat(64), A='1'.repeat(64), B='2'.repeat(64), AMOUNT='2500000000';
function world(t, { observe, native = false, resolve = async () => true, failMarker = false } = {}) {
  const dir=mkdtempSync(join(tmpdir(),'d15-review-')),file=join(dir,'state.sqlite'),connections=[];
  t.after(()=>{for(const db of connections)db.close();rmSync(dir,{recursive:true,force:true});});
  let active;
  const calls=[];
  const chain={network:'testnet',pinnedIdentity:CHAIN,rpcOrigin:'https://rpc.invalid',evidenceMode:'TEST-stub',
    networkIdentity:async()=>({identity:CHAIN,mode:'public-chain-read'}),
    observeTransfer:hash=>observe ? observe(hash) : included(hash),
    getTransaction:async hash=>({hash,status:'confirmed',blockNumber:10,content:{from:WALLET,nonce:7}})};
  const protocol={nativePaymentSuperseded:async(op,coords)=>{calls.push(op.id);return resolve(op,coords,active);},nativeIntentsSupersededBy:async()=>[]};
  const open=()=>{
    const db=openDatabase(file);connections.push(db);
    const ops=createOperationStore({db,handoffSecret:'TEST-only-d15-review-secret-000000000'}),real=createCoordinateStore({db});
    const coordinates=failMarker?{...real,recordObservation:(id,obs,...args)=>obs.nativeLaneResolved ? false : real.recordObservation(id,obs,...args)}:real;
    const purchases=createPurchaseService({db,ops,coordinates,config:{},chain,protocol,store,purposes});
    active={db,ops,coordinates,purchases};
  };
  open();
  active.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer','TEST','TEST-buyer',new Date().toISOString());
  const terms={buyer:{wallet:WALLET},seller:{payee:PAYEE,claim:'TEST-seller'},price:{amountOs:AMOUNT,amount:'2.5'},listing:{listingId:'TEST-listing',version:1,contentHash:CHAIN},network:'testnet',rail:'demos-native:DEM',domain:{network:'testnet',rail:'demos-native:DEM',mode:'public-chain-read',chainIdentity:CHAIN},
    ...(native?{protocol:{profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',nativePayment:'native-dem-once-after-public-agreement-and-fixture-commitment',sellerAgreementProjection:'public-signed-create'}}:{})};
  const make=(key,hash=null)=>{
    const op=active.ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:key,request:{key},status:hash?'broadcast_reported':'payment_handoff',terms,termsHash:CHAIN,expiresAt:new Date(Date.now()+3600000).toISOString()}).operation;
    active.coordinates.save({operationId:op.id,kind:'native-dem-transfer',network:'testnet',from:WALLET,nonceFence:6,expectedNonce:7,target:PAYEE,amountOs:AMOUNT,payload:{content:{nonce:7}}});
    if(hash)assert.equal(active.coordinates.reportHash(op.id,hash),true);
    return op;
  };
  return { make, restart:open, current:()=>active, calls, verify:op=>active.purchases.verifyDeal({accountId:'TEST-buyer',operationId:op.id}),
    snapshot:op=>({operation:active.ops.get('TEST-buyer',op.id),coordinate:active.coordinates.get(op.id),events:active.ops.history(op.id)}) };
}
const included=hash=>({status:'included',txHash:hash,payer:WALLET,payee:PAYEE,amountOs:AMOUNT,blockNumber:10});
for(const terminal of ['settled_verified','payment_mismatch','superseded'])for(const late of ['failed','unknown']) {
  test(`late same-hash ${late} cannot overwrite ${terminal}`,async t=>{
    let enter,release,calls=0;
    const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    const w=world(t,{observe:async hash=>{if(++calls===1){enter();await gate;return {status:late,txHash:hash};}return {...included(hash),...(terminal==='payment_mismatch'?{payee:'0x'+'8'.repeat(64)}:{})};}});
    const op=w.make('delayed',A),pending=w.verify(op);await entered;
    try {
      const winner=terminal==='superseded'?w.make('settler',B):op;
      await w.verify(winner);
      const before=w.snapshot(op);assert.equal(before.operation.status,terminal);
      release();await pending;
      assert.deepEqual(w.snapshot(op),before,'late unverified data writes neither state, observation nor events');
    } finally {release();}
  });
}
test('native competing-lane marker persists through retry and restart',async t=>{
  const w=world(t,{native:true}),settler=w.make('settler',A),other=w.make('other');
  assert.equal((await w.verify(settler)).verification.outcome,'verified');
  const saved=w.snapshot(other);
  assert.equal(saved.operation.status,'superseded');
  assert.equal(saved.coordinate.reportedTxHash,null);
  assert.equal(saved.coordinate.observation.txHash,A);
  assert.equal(saved.coordinate.observation.nativeLaneResolved,true);
  const count=w.calls.length;
  w.restart();await w.verify(settler);await w.verify(other);
  assert.equal(w.calls.length,count,'resolved source lane is not resolved again after restart');
  assert.deepEqual(w.snapshot(other),saved,'retry appends no duplicate resolution event');
});
for(const changed of ['pointer','owner','write-refused'])test(`native supersession remains unresolved after ${changed}`,async t=>{
  let w;
  w=world(t,{native:true,failMarker:changed==='write-refused',resolve:async(op,coords,active)=>{
    if(changed==='pointer') active.coordinates.reportHash(op.id,B);
    if(changed==='owner') {
      const owner=active.ops.get('TEST-buyer',coords.observation.supersededBy);
      active.ops.transition(owner.id,owner.status,'payment_uncertain');
    }
    return true;
  }});
  const settler=w.make('settler',A),other=w.make('other');
  await w.verify(settler);
  const saved=w.snapshot(other);
  assert.notEqual(saved.coordinate.observation.nativeLaneResolved,true);
  assert.equal(saved.events.filter(e=>e.type==='native_supersession_resolved').length,0);
  assert.equal(saved.events.filter(e=>e.type==='native_supersession_pending').length,1);
  assert.equal((await w.verify(other)).verification.nativeLaneResolved,changed==='pointer', 'a retry can resolve once its retained pointer stays stable');
});
