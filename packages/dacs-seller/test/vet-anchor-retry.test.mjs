import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { JOB, buyer } from './helpers/protocol-fixture.mjs';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';

const address=compositeVerificationAddress(JOB,buyer.claim);
// A wallet that retains its signer outcomes. Asked about a reservation another provider is still
// signing under, it answers once that signer call has finished, never before and never "unsigned".
function retainPresentationOutcomes(wallet){
 const sign=wallet.signBytes,slots=new Map();
 const slot=reservation=>{if(!slots.has(reservation)){const entry={};entry.outcome=new Promise((resolve,reject)=>{entry.resolve=resolve;entry.reject=reject;});entry.outcome.catch(()=>{});slots.set(reservation,entry);}return slots.get(reservation);};
 wallet.signBytes=(bytes,request)=>{
  if(!request?.reservation)return sign(bytes,request);
  const entry=slot(request.reservation);
  try{const signature=Buffer.from(sign(bytes,request)).toString('base64url');entry.resolve(Buffer.from(JSON.stringify({...request,status:'signed',signature})));return signature;}
  catch(error){entry.reject(error);throw error;}
 };
 wallet.reconcilePresentationSignature=async request=>slot(request.reservation).outcome;
}
const cases=[['publish','result'],['readRetained','result'],['verifyReceipt','verdict'],['readRetained','bytes']];
for(const [boundary,mode] of cases)for(const failure of mode==='verdict'?['indeterminate']:['indeterminate','journal-busy','journal-capacity'])for(const fresh of [false,true])test(`${boundary} ${mode} ${failure} retries exact buyer record (${fresh?'restart':'same provider'})`,async()=>{
 const f=productionFixture(),original=f.anchor[boundary],read=f.anchor.readRetained,verify=f.anchor.verifyReceipt;let held=true,bytes=false;
 if(mode==='bytes')f.anchor.verifyReceipt=async input=>{const out=await verify(input);bytes=true;return out;};
 if(boundary==='publish')f.anchor.readRetained=async input=>held&&f.local.rows.has(address)?{status:'indeterminate'}:read(input);
 f.anchor[boundary]=async input=>{
  if(boundary==='publish'&&held&&failure!=='indeterminate')throw Object.assign(new Error('TEST journal unavailable'),{code:failure});
  const out=await original(input);
  if(input.logicalAddress!==address||!held)return out;
  if(mode==='bytes'){if(!bytes)return out;bytes=false;}
  if(mode==='verdict')return 'indeterminate';
  if(failure==='indeterminate')return{status:'indeterminate',reason:'TEST pending',noResend:true};
  throw Object.assign(new Error('TEST journal unavailable'),{code:failure});
 };
 if(fresh)retainPresentationOutcomes(f.config.wallet);
 const p=await f.provider(),input=f.input(),run=async()=>{const use=fresh?await f.provider():p;return use.jobVet(input.scope,input.buyerIdentityBundle,()=>true);};
 await assert.rejects(run());await assert.rejects(run());const signatures=f.controls.signs-f.controls.presentationSigns;
 held=false;const results=await Promise.all([run(),run()]);
 for(const result of results)assert.equal(result.buyerVet.record.overallDecision,'pass');
 assert.equal(f.controls.signs-f.controls.presentationSigns,signatures,'the retained buyer record signature is reused');
 assert.equal(f.local.writes.filter(row=>row===address).length,1);f.base.close();
});
// The two restarted providers of the variants above race for the presentation reservation. Here the
// first is held inside the signer until the second has asked the wallet for the first one's outcome.
for(const reconciles of [true,false])test(`a restarted provider ${reconciles?'takes over':'refuses'} the presentation signature a held provider is still signing`,async()=>{
 const f=productionFixture(),wallet=f.config.wallet;let signing,release,asked;
 const signingStarted=new Promise(resolve=>{signing=resolve;}),gate=new Promise(resolve=>{release=resolve;}),secondAsked=new Promise(resolve=>{asked=resolve;});
 if(reconciles){
  retainPresentationOutcomes(wallet);const reconcile=wallet.reconcilePresentationSignature;
  wallet.reconcilePresentationSignature=request=>{asked();return reconcile(request);};
 }
 const sign=wallet.signBytes;
 wallet.signBytes=async(bytes,request)=>{if(request?.reservation){signing();await gate;}return sign(bytes,request);};
 const input=f.input(),run=async()=>(await f.provider()).jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 const first=run();await signingStarted;const second=run().then(result=>({result}),error=>({error}));
 if(reconciles){
  assert.equal(await Promise.race([secondAsked.then(()=>'asked'),second.then(()=>'settled')]),'asked');release();
  const [held,restarted]=await Promise.all([first,second]);
  assert.equal(held.buyerVet.record.overallDecision,'pass');assert.equal(restarted.result.buyerVet.record.overallDecision,'pass');
 }else{
  const refused=await second;assert.equal(refused.error?.code,'seller_presentation_indeterminate');release();await first;
 }
 assert.equal(f.controls.presentationSigns,1,'only one provider signs the presentation');f.base.close();
});
for(const definitive of ['rejected','invalid','wrong-hash'])test(`a definitive ${definitive} fallback overrides earlier uncertainty`,async()=>{
 const f=productionFixture(),publish=f.anchor.publish,read=f.anchor.readRetained;let reads=0;
 f.anchor.publish=async input=>{await publish(input);return{status:'indeterminate'};};
 f.anchor.readRetained=async input=>{const out=await read(input);if(++reads===1)return out;
  if(definitive==='rejected')return{status:'rejected',reason:'TEST refused'};
  if(definitive==='invalid')return out.status==='present'?{...out,receipt:{...out.receipt,state:'dropped'}}:out;
  return out.status==='present'?{...out,artifact:{...out.artifact,jobId:'TEST changed'}}:out;
 };
 await assert.rejects(f.run());const row=(await f.base.entries())[0][1];
 assert.equal(Object.values(row.ops.buyer.steps).some(step=>step.state==='failed'),true);f.base.close();
});
