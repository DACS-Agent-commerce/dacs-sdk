// SDK #365 sweep: the shipped Deliverable capability composed with the artifact
// anchor. A wallet that refuses without signing, or a process that dies while
// the wallet is asked, must leave a paid order's Deliverable askable again
// (once), and a signed CREATE must never be asked again. The agent's own check
// is the one `isProvenUnsignedAbsence` the host uses (seller-agent.mjs,
// reconcileDeliverySubmission), applied here to the capability's real answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {fixtureListing} from './fixtures/listings.mjs';
import {seller} from './helpers/protocol-fixture.mjs';
import {anchorFixture} from './helpers/anchor-isolated-fixture.mjs';
import {privateModule} from './helpers/private-module.mjs';
import {createDevnetPurchasedReportProducer} from '../src/devnet-demo/deliverable.mjs';
import {createDevnetDemoDeliveryCapability} from '../src/devnet-demo/native-delivery.mjs';
import {isProvenUnsignedAbsence,readNativeDemDelivery,submitNativeDemDelivery} from '../src/dacs/native-dem-delivery-consumer.mjs';
// The custody module's wallet runtime imports are not part of this package; the approval attempt does not use them.
const {createOperatorApprovalAttempt}=await privateModule(new URL('../src/devnet-demo/operator-custody.mjs',import.meta.url),['createOperatorApprovalAttempt'],
 (source)=>source.replace(/^import .*(sdk-provider|demos-signature)\.mjs';$/gm,'').replace('export function createOperatorApprovalAttempt','function createOperatorApprovalAttempt'));

const JOB='01ARZ3NDEKTSV4RRFFQ69G5FAW';
async function composed(){
 const w=await anchorFixture({artifactKinds:['Deliverable']}),anchor=w.open();
 const listing=fixtureListing(seller),listingRef={listingId:listing.listingId,version:listing.listingVersion,contentHash:core.contentHash(listing)},agreement={jobId:JOB,listingRef};
 const report=createDevnetPurchasedReportProducer({producer:w.seller,produce:()=>'Bound purchased content'})({agreement,listing,settlementId:'settlement-1'});
 const logicalAddress=`dacs4:deliverable:${JOB}`,receiptContentHash=core.contentHash(report);
 const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:JOB,phase:'deliver-storage-program',phaseIndex:0,listing:listingRef,
  agreementHash:report.agreementHash,fulfilmentId:'fulfilment-1',purchaseAmount:{currency:'DEM',amount:'2.5'},payloadHash:receiptContentHash};
 const input={jobId:JOB,logicalAddress,report,receiptContentHash,deliveryBinding};
 const capability=(opened=anchor)=>createDevnetDemoDeliveryCapability({authority:'TEST-local',anchor:{...opened,authority:'TEST-local'}});
 return {w,anchor,input,capability,logicalAddress};
}
const refuse=(code)=>async()=>({success:false,error:{code}});

for(const code of ['internal_error','capture-without-signing'])test(`a wallet ${code} before anything is signed: the capability proves the absence, also after a restart, and the Deliverable is asked once more`,async()=>{
 for(const restart of [false,true]){
  const {w,anchor,input,capability}=await composed();
  w.controls.request=refuse(code);
  const first=await submitNativeDemDelivery(capability(),input);
  assert.equal(first.status,'indeterminate',`restart ${restart}`);assert.equal(w.captured.length,1);
  const opened=restart?w.open():anchor;
  assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(opened),input)),true,`restart ${restart}: nothing was signed, so the read proves it`);
  // The agent asks again on that proof: the wallet signs and the CREATE lands this time.
  w.controls.request=async request=>{
   await w.journal.put('demo/wallet/signed',{stage:'broadcast-accepted',hash:'a'.repeat(64),signedTransaction:{...request.transaction,hash:'a'.repeat(64)}});
   return {success:false,error:{code:'internal_error'}};
  };
  assert.equal((await submitNativeDemDelivery(capability(opened),input)).status,'indeterminate');
  assert.equal(w.captured.length,2,'asked once more');
  assert.deepEqual(w.captured.map(r=>r.transaction.content.nonce),[1,1]);
  // Now a signed CREATE is retained for the address: the proof is gone and it is never asked again.
  assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(w.open()),input).catch(()=>null)),false);
 }
});
test('a process killed while the wallet was asked: proven absence only while no signed CREATE is retained',async()=>{
 const {w,input,capability}=await composed();
 w.controls.request=async()=>{throw new Error('killed');};
 await assert.rejects(submitNativeDemDelivery(capability(),input),/killed/);
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(w.open()),input)),true);
 await w.journal.put('demo/wallet/signed',{stage:'broadcast-started',hash:'a'.repeat(64),signedTransaction:{...w.captured[0].transaction,hash:'a'.repeat(64)}});
 w.source.binding=async()=>({disposition:'pending'});
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(w.open()),input).catch(()=>null)),false);
});

for (const restart of [false, true]) for (const lostFence of [false, true]) test(`native delivery rechecks authorization after nonce RPC, restart=${restart}, lostFence=${lostFence}`, async () => {
 const {w,anchor,input,capability}=await composed();
 let prepared=false,checks=0;
 w.source.readRpc=async()=>{prepared=true;return {result:200,response:0,require_reply:false,extra:null};};
 const failure=new Error('TEST job fence lost during preparation');
 const authorize=()=>{checks++;assert.equal(prepared,true,'guard runs after asynchronous nonce preparation');if(lostFence)throw failure;return false;};
 await assert.rejects(submitNativeDemDelivery(capability(),input,authorize),lostFence?error=>error===failure:error=>error.code==='not-authorized');
 assert.equal(checks,1);
 assert.equal(w.captured.length,0,'no wallet signature requested');
 const opened=restart?w.open():anchor;
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(opened),input)),true);
 const retry=await submitNativeDemDelivery(capability(opened),input,()=>true);
 assert.equal(retry.status,'indeterminate');
 assert.equal(w.captured.length,1,'unsigned refusal remains askable after reopen');
});

// The wallet's approval can wait on the operator: the write's authority is
// checked again after that answer, right before anything is signed.
for (const restart of [false, true]) test(`a settlement contested while the wallet waits for approval signs nothing, and the proven absence keeps it askable (restart=${restart})`, async () => {
 const {w,anchor,input,capability}=await composed();
 let contested=false;const stages=[];
 w.controls.approval=async()=>{contested=true;};
 w.controls.request=async()=>{throw new Error('TEST signed after the contest');};
 const authorize=(stage)=>{stages.push(stage);return stage==='signing'&&contested?'TEST settlement contested':true;};
 const answer=await submitNativeDemDelivery(capability(),input,authorize);
 assert.equal(answer.status,'indeterminate');
 assert.deepEqual(stages,['intent','signing']);
 assert.equal(w.captured.length,1,'the wallet was asked once and signed nothing');
 const opened=restart?w.open():anchor;
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(opened),input)),true);
});

test('a guarded Deliverable is not published through a wallet that cannot check it right before signing', async () => {
 const {w,input,capability}=await composed();
 w.controls.guardsSigning=false;
 const opened=w.open();
 await assert.rejects(submitNativeDemDelivery(capability(opened),input,()=>true),error=>error.code==='not-authorized');
 assert.equal(w.captured.length,0);
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(opened),input)),true);
});

test('the operator custody wallet checks a guarded write after the operator approves it and before it signs', async () => {
 for (const contested of [false, true]) {
  const settled=[];let signed=false;
  const approve=Object.assign(async()=>true,{settle:async(_request,outcome)=>{settled.push(outcome);}});
  const attempt=createOperatorApprovalAttempt(approve);
  // As the packaged wallet: a thrown approval is answered internal_error, and nothing is signed.
  const result=await attempt.run(async()=>{
   try{await attempt.approve({method:'sendTransaction'});}catch{return {success:false,error:{code:'internal_error'}};}
   signed=true;return {success:true};
  },()=>contested?'TEST settlement contested':true);
  assert.equal(signed,!contested,`contested ${contested}`);
  assert.equal(result.success,!contested);
  assert.deepEqual(settled,['released'],'the operator approval is released: nothing was sent');
 }
});

test('the operator custody wallet checks a guarded write again right before it signs, after its later reads', async () => {
 for (const contested of [false, true]) {
  const settled=[];let signed=0,withdrawn=false;
  const approve=Object.assign(async()=>true,{settle:async(_request,outcome)=>{settled.push(outcome);}});
  const attempt=createOperatorApprovalAttempt(approve);
  const Demos=attempt.guardSigning(class{async sign(tx){signed++;return {...tx,signed:true};}});
  // As the packaged wallet: approval, then the network and nonce reads during which the write is withdrawn,
  // then the SDK signature; a thrown signature is answered sdk_error, and nothing is sent.
  const result=await attempt.run(async()=>{
   try{await attempt.approve({method:'sendTransaction'});}catch{return {success:false,error:{code:'internal_error'}};}
   await new Promise(resolve=>setImmediate(()=>{withdrawn=contested;resolve();}));
   try{await new Demos().sign({TEST:'create'});}catch(error){assert.equal(error.code,'not-authorized');return {success:false,error:{code:'sdk_error'}};}
   return {success:true};
  },()=>withdrawn?'TEST withdrawn during the wallet reads':true);
  assert.equal(signed,contested?0:1,`contested ${contested}`);
  assert.equal(result.success,!contested);
  assert.deepEqual(settled,['released'],'the operator approval is released: nothing was sent');
 }
});

test('the operator custody wallet keeps the error its authorize check threw as the cause of the refusal', async () => {
 const failure=new Error('TEST job fence lost');
 for (const throws of [true, false]) {
  const attempt=createOperatorApprovalAttempt(async()=>true);
  const refusal=await attempt.run(async()=>{
   try{await attempt.approve({method:'sendTransaction'});}catch(error){return error;}
   return null;
  },()=>{if(throws)throw failure;return 'TEST settlement contested';});
  assert.equal(refusal.code,'not-authorized',`throws ${throws}`);
  if(throws)assert.equal(refusal.cause,failure,'the refusal carries the thrown error');
  else assert.equal(Object.hasOwn(refusal,'cause'),false,'a refusal without a thrown error has no cause');
 }
});

// A wallet like the session's: whatever is assigned to `crypto` is wrapped, so the value read back is never the value assigned.
function walletWithWrappingCrypto(){
 const counts={keyLayers:0,keySignatures:0};
 const wrap=(inner)=>({sign:(...args)=>{counts.keyLayers++;return inner.sign(...args);}});
 const Demos=class{
  #crypto=null;
  constructor(){this.crypto={sign:async()=>{counts.keySignatures++;return 'signature';}};}
  get crypto(){return this.#crypto;}
  set crypto(inner){this.#crypto=inner&&wrap(inner);}
  async sign(){return this.crypto.sign('ed25519','message');}
 };
 // The wrapper layers a key signature passes through.
 const layersOnKeySignature=(demos)=>{counts.keyLayers=0;demos.crypto.sign('ed25519','message');return counts.keyLayers;};
 return {Demos,counts,layersOnKeySignature};
}

test('guarded signing adds no wrapper layer to the wallet\'s crypto however many signatures it makes', async () => {
 const {Demos,layersOnKeySignature}=walletWithWrappingCrypto();
 const attempt=createOperatorApprovalAttempt(async()=>true);
 let checks=0;
 const demos=new (attempt.guardSigning(Demos))();
 const perSignature=[],layers=[];
 for (let signature=0;signature<3;signature++) {
  checks=0;
  assert.equal(await attempt.run(()=>demos.sign(),()=>{checks++;return true;}),'signature');
  perSignature.push(checks);layers.push(layersOnKeySignature(demos));
 }
 assert.deepEqual(perSignature,[2,2,2],'each signature is checked at entry and once at the key');
 assert.equal(layers[2],layers[0],'the third signature left the key as many layers deep as the first');
});

test('guarded signing guards a key the wallet receives after a lock', async () => {
 const {Demos,counts}=walletWithWrappingCrypto();
 const attempt=createOperatorApprovalAttempt(async()=>true);
 const demos=new (attempt.guardSigning(Demos))();
 assert.equal(await attempt.run(()=>demos.sign(),()=>true),'signature');
 demos.crypto=null;
 demos.crypto={sign:async()=>{counts.keySignatures++;return 'second key';}};
 counts.keySignatures=0;
 let checks=0;
 await assert.rejects(attempt.run(()=>demos.sign(),()=>checks++===0?true:'TEST withdrawn at the key'),error=>error.code==='not-authorized');
 assert.equal(counts.keySignatures,0,'the second key signed nothing');
});

test('a key signature made outside a guarded sign() is not checked against the write', async () => {
 const {Demos}=walletWithWrappingCrypto();
 const attempt=createOperatorApprovalAttempt(async()=>true);
 const demos=new (attempt.guardSigning(Demos))();
 assert.equal(await attempt.run(()=>demos.sign(),()=>true),'signature');
 let checks=0;
 await attempt.run(async()=>{await demos.crypto.sign('ed25519','rpc authentication');},()=>{checks++;return 'TEST withdrawn';});
 assert.equal(checks,0,'only a signature inside sign() runs the write\'s check');
});

test('the guarded SDK class signs as before outside a guarded write', async () => {
 const attempt=createOperatorApprovalAttempt(async()=>true);
 const Demos=attempt.guardSigning(class{async sign(tx){return {...tx,signed:true};}});
 assert.deepEqual(await new Demos().sign({TEST:'plain'}),{TEST:'plain',signed:true});
});

test('locking the wallet while a guarded signature is pending leaves the wallet without its key', async () => {
 const attempt=createOperatorApprovalAttempt(async()=>true);
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const Demos=attempt.guardSigning(class{
  crypto={sign:async tx=>({...tx,signed:true})};
  lock(){this.crypto=null;}
  async sign(tx){await pending;return {...tx,signed:true};}
 });
 const demos=new Demos();
 const original=demos.crypto;
 const signing=attempt.run(async()=>demos.sign({TEST:'lock'}),()=>true);
 // The guarded signature has swapped in its wrapper and waits; the wallet is locked in that time.
 await new Promise(resolve=>setImmediate(resolve));
 assert.notEqual(demos.crypto,original,'the signature is pending behind the wrapper');
 demos.lock();
 release();
 await signing;
 assert.equal(demos.crypto,null,'the lock stays: the original key is not put back');
});

test('a guarded write withdrawn during the SDK signature\'s own network read is not signed by the real SDK', async () => {
 const {register}=await import('node:module');
 register(new URL('./helpers/demosdk-operations-resolve.mjs',import.meta.url));
 const {Demos}=await import('@kynesyslabs/demosdk/websdk');
 for (const contested of [false, true]) {
  const attempt=createOperatorApprovalAttempt(async()=>true);
  const demos=new (attempt.guardSigning(Demos))();
  await demos.connectWallet(demos.newMnemonic(128),{algorithm:'ed25519'});
  demos.rpc_url='http://TEST.invalid';
  let withdrawn=false;
  // Stand-ins for the node's answers to the reads the SDK makes inside sign(), after its entry; the write is
  // withdrawn while the fee read is pending.
  demos.nodeCall=async(message)=>{
   if(message==='getNetworkParameters'){await new Promise(resolve=>setImmediate(resolve));withdrawn=contested;return {networkFee:1,rpcFee:0};}
   return message==='getNetworkInfo'?{forks:{osDenomination:{activated:true}}}:null;
  };
  const to='0x'+'ab'.repeat(32);
  const tx={content:{type:'native',to,amount:'1',data:['native',{nativeOperationType:'send',args:[to,'1']}],nonce:1,timestamp:1,gcr_edits:[],transaction_fee:{}}};
  const result=await attempt.run(async()=>{
   try{const signed=await demos.sign(tx,{nonce:1});return {signed:Boolean(signed.signature?.data)};}catch(error){return {code:error.code};}
  },()=>withdrawn?'TEST withdrawn during the SDK read':true);
  assert.equal(withdrawn,contested,'the SDK made its fee read inside sign()');
  assert.deepEqual(result,contested?{code:'not-authorized'}:{signed:true},`contested ${contested}`);
  assert.ok(demos.crypto&&typeof demos.crypto.sign==='function','the wallet keeps its own key after a guarded signature');
 }
});
