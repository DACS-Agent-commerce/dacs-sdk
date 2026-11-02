import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture } from './helpers/vet-production-fixture.mjs';

// The purchase check that runs right before the Vet component signer is the one inside authorizeEffect (its
// durable read is awaited first). Here the purchase closes in the next microtask, so only a check made after
// that await sees it.
const CHECKS_BEFORE_COMPONENT_SIGNER=3;
const NO_LONGER_PENDING=/no longer pending/;
// A withdrawn write may be reported by the fallback read as a purchase no longer pending; `seen.withdrawn` proves the hook ran.
const WRITE_REFUSED=/no longer pending|withdrawn after its approval/;
async function runWith(f,open){
 const {scope,buyerIdentityBundle}=f.input();
 return (await f.provider()).jobVet(scope,buyerIdentityBundle,open);
}
// A publisher that behaves like the packaged wallet: `authorize` before the intent, then an approval wait in which
// the purchase closes, then `authorizeSigning` (when given) right before the CREATE. The CREATE is requested only
// if the hook answers literally true; a throw or any other answer withdraws the write.
function closeDuringApproval(f,{matches,close}){
 const publish=f.anchor.publish,seen={asked:0,withdrawn:0};
 f.anchor.publish=async request=>{
  if(!matches(request))return publish(request);
  seen.asked++;
  if(await request.authorize?.()!==true)throw new Error('TEST the write was refused before the intent');
  close();
  let allowed=true;
  if(request.authorizeSigning){try{allowed=request.authorizeSigning();}catch(error){allowed=error;}}
  if(allowed!==true){seen.withdrawn++;throw Object.assign(new Error('the write was withdrawn after its approval; nothing was signed'),{code:'not-authorized'});}
  return publish(request);
 };
 return seen;
}

test('a purchase that closes after the last awaited check signs no Vet component',async t=>{
 const f=productionFixture();t.after(()=>f.base.close());
 let checks=0,closed=false;
 const open=()=>{const answer=!closed;if(++checks===CHECKS_BEFORE_COMPONENT_SIGNER)queueMicrotask(()=>{closed=true;});return answer;};
 await assert.rejects(runWith(f,open),NO_LONGER_PENDING);
 assert.equal(f.controls.signs,0,'the wallet signed after the purchase closed');
 assert.ok(checks>CHECKS_BEFORE_COMPONENT_SIGNER,'a check ran after the purchase closed');
});

test('a purchase that closes while the wallet waits for approval requests no composite Vet record CREATE',async t=>{
 const f=productionFixture();t.after(()=>f.base.close());
 let open=true;
 const seen=closeDuringApproval(f,{matches:request=>request.verifier===undefined,close:()=>{open=false;}});
 const outcome=await runWith(f,()=>open).catch(error=>error);
 assert.equal(f.local.writes.length,0,'the wallet was asked for a CREATE after the purchase closed');
 assert.match(String(outcome?.message),WRITE_REFUSED);assert.deepEqual(seen,{asked:1,withdrawn:1});
});

test('a purchase that closes while the wallet waits for approval requests no counterparty Vet record CREATE',async t=>{
 const f=productionFixture();t.after(()=>f.base.close());
 let open=true;
 const seen=closeDuringApproval(f,{matches:request=>request.verifier!==undefined,close:()=>{open=false;}});
 const outcome=await runWith(f,()=>open).catch(error=>error);
 assert.equal(f.local.writes.length,1,'only the buyer composite record was written, not the counterparty record');
 assert.match(String(outcome?.message),WRITE_REFUSED);assert.deepEqual(seen,{asked:1,withdrawn:1});
});
