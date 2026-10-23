import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorld,HASH,CHAIN,ACCOUNT} from './helpers/domain-store-crash-world.mjs';
import {createPurchaseService} from '../src/purchases.mjs';
import {createSqlitePurchaseStore} from '../src/seams/purchase-store-not-wired.mjs';

test('unavailable native supersession has no source call or pending event after repeat and reopen', async t => {
 const dir=mkdtempSync(join(tmpdir(),'dacs-supersession-unavailable-')),path=join(dir,'state.sqlite');
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let w=openWorld(path),calls=0;
 try {
  w.seed('native-supersession');
  const owner=w.operation('payment'),replacement=w.operation('replacement');
  w.db.prepare("UPDATE operations SET status='settled_verified' WHERE id=?").run(owner.id);
  w.coordinates.recordObservation(owner.id,{txHash:HASH,status:'included'},true);
  w.db.prepare("UPDATE operations SET status='superseded' WHERE id=?").run(replacement.id);
  w.coordinates.recordObservation(replacement.id,{txHash:HASH,supersededBy:owner.id},false,null);
  const before=w.snapshot('native-supersession');
  for(const reopen of [false,false,true]) {
   if(reopen){w.db.close();w=openWorld(path);}
   const purchases=createPurchaseService({...w,store:createSqlitePurchaseStore(),config:{},purposes:{APPROVE_PURCHASE:'TEST'},
    now:()=>1700000000000,chain:{networkIdentity:async()=>({identity:CHAIN,mode:'public-chain-read'})},
    protocol:{nativePaymentReadbackAvailable:false,nativePaymentSuperseded:async()=>{calls++;return true;}}});
   const result=await purchases.verifyDeal({accountId:ACCOUNT,operationId:replacement.id});
   assert.equal(result.verification.nativeReadback,'unavailable');
   assert.equal(result.verification.nativeLaneResolved,false);
   assert.doesNotMatch(result.verification.nextStep,/retry|verify_deal/i);
   assert.equal(calls,0);assert.deepEqual(w.snapshot('native-supersession'),before);
   assert.deepEqual(w.ops.history(replacement.id).filter(event=>event.type==='native_supersession_pending'),[]);
  }
 }finally{w.db.close();}
});
