import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { JOB, buyer, seller } from './helpers/protocol-fixture.mjs';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';

test('Vet factory validates ownership before any signer, anchor or row operation',()=>{
 let effects=0;const effect=()=>{effects++;throw new Error('TEST effect');};
 assert.throws(()=>createDevnetDemoAgreementContextProvider({anchor:{hasIntent:effect,publish:effect},wallet:{claim:seller.claim,signBytes:effect},store:{read:effect,update:effect,entries:effect}}),/Vet context is not assembled|Vet producer and native anchor/);assert.equal(effects,0);
});
for(const length of [32,64])test(`real staged bilateral engine accepts a ${length}-hex verifier nonce`,async()=>{
 const f=productionFixture();f.controls.nonce='a'.repeat(length);const result=await f.run();assert.equal(result.buyerVet.record.overallDecision,'pass');assert.equal(result.sellerVet.record.signature.signer,f.seen[0].buyer);assert.equal(f.local.writes.length,2);assert.equal(f.seen.length,1);f.base.close();
});
for(const length of [31,258])test(`nonce length ${length} refuses before signing`,async()=>{
 const f=productionFixture();f.controls.nonce='a'.repeat(length);await assert.rejects(f.run(),e=>e.code==='seller_challenge_invalid');assert.equal(f.controls.signs,0);assert.equal(f.local.writes.length,0);f.base.close();
});
test('buyer result is recovered after a lost seller checkpoint without consuming its challenge again',async()=>{
 const f=productionFixture();f.controls.failCounterpartySave=true;await assert.rejects(f.run(),/counterparty checkpoint lost/);assert.equal(f.seen.length,1);
 const result=await f.run();assert.equal(result.sellerVet.record.overallDecision,'pass');assert.equal(f.seen.length,1);assert.equal(f.local.writes.length,2);f.base.close();
});
test('unknown buyer nonce ledger never authorizes evaluation',async()=>{
 const f=productionFixture();f.counterparty.readRecord=async()=>({status:'absent'});await assert.rejects(f.run(),e=>e.code==='seller_vet_reconciliation_required');assert.equal(f.seen.length,0);f.base.close();
});
test('inherited core verifier refusal of qualified CVR signer stays closed',async()=>{
 const f=productionFixture();f.controls.qualifiedSigner=true;await assert.rejects(f.run(),e=>e.code==='seller_vet_invalid');f.base.close();
});
for(const state of ['accepted','included'])test(`merely ${state} receipts never close staged Vet`,async()=>{
 const f=productionFixture();f.controls.receiptState=state;f.controls.receiptVerdict='valid';await assert.rejects(f.run());f.base.close();
});
test('counterparty raw-byte and decoded budgets refuse oversized replies before signatures',async()=>{
 const f=productionFixture(),issue=f.counterparty.issueChallenge;f.counterparty.issueChallenge=async args=>({...await issue(args),extra:'x'.repeat(65537)});
 await assert.rejects(f.run(),e=>e.code==='counterparty_vet_unavailable'&&e.cause instanceof Error);assert.equal(f.controls.signs,0);f.base.close();
});
test('counterparty connection failures keep the actual cause',async()=>{
 const f=productionFixture(),cause=Object.assign(new Error('TEST refused'),{code:'ECONNREFUSED'});f.counterparty.issueChallenge=async()=>{throw cause;};
 await assert.rejects(f.run(),e=>e.code==='counterparty_vet_unavailable'&&e.cause===cause);f.base.close();
});
test('counterparty deadline aborts a never-settling reader',async t=>{
 const f=productionFixture(),p=await f.provider();let entered,options;const started=new Promise(resolve=>{entered=resolve;});
 f.counterparty.issueChallenge=(input,limits)=>{options=limits;entered();return new Promise(()=>{});};t.mock.timers.enable({apis:['setTimeout']});const input=f.input();
 const result=assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='counterparty_vet_unavailable'&&e.cause?.name==='TimeoutError');await started;t.mock.timers.tick(10001);await result;assert.equal(options.signal.aborted,true);assert.equal(options.maxBytes,65536);assert.equal(f.controls.signs,0);f.base.close();
});

for(const state of ['accepted','included'])test(`seller-only ${state} receipt cannot close a staged Vet`,async()=>{
 const f=productionFixture();f.controls.receiptStateFor=address=>address===compositeVerificationAddress(JOB,seller.claim)?state:'finalized';f.controls.receiptVerdict='valid';await assert.rejects(f.run(),e=>e.code==='seller_vet_receipt_invalid');f.base.close();
});
test('a buyer Vet kept for a retry is not reused once its receipt no longer qualifies',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();f.controls.failCounterpartySave=true;
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),/counterparty checkpoint lost/);
 f.controls.receiptStateFor=address=>address===compositeVerificationAddress(JOB,buyer.claim)?'accepted':'finalized';
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='party_vet_unavailable');assert.equal(f.local.writes.length,1);f.base.close();
});
for(const [party,address,code] of [['buyer',()=>compositeVerificationAddress(JOB,buyer.claim),'party_vet_unavailable'],['seller',()=>compositeVerificationAddress(JOB,seller.claim),'seller_vet_receipt_invalid']])test(`a finished job is read back again: a ${party} receipt that no longer qualifies refuses the repeat`,async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 assert.equal((await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true)).sellerVet.record.overallDecision,'pass');
 f.controls.receiptStateFor=asked=>asked===address()?'accepted':'finalized';
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code===code);assert.equal(f.local.writes.length,2);f.base.close();
});
// A receipt that is not final yet is a wait: the step is retried, never kept as a terminal failure.
for(const state of ['accepted','included'])for(const provider of ['same','fresh'])test(`a ${state} receipt for the written Vet finalizes on a retry with a ${provider} provider`,async()=>{
 const clean=productionFixture();await clean.run();const signs=clean.controls.signs;clean.base.close();
 const f=productionFixture(),p=await f.provider(),input=f.input(),run=()=>(provider==='same'?Promise.resolve(p):f.provider()).then(use=>use.jobVet(input.scope,input.buyerIdentityBundle,()=>true));
 f.controls.receiptState=state;f.controls.receiptVerdict='valid';
 await assert.rejects(run());await assert.rejects(run(),/./,'still not final: still a wait');
 f.controls.receiptState='finalized';
 const result=await run();assert.equal(result.sellerVet.record.overallDecision,'pass');
 assert.equal(f.local.writes.length,2,'the retry rereads the same intent');assert.equal(f.controls.signs,signs,'nothing is signed twice');f.base.close();
});
test('two provider instances that both see an unattempted nonce converge on the buyer\'s retained record',async()=>{
 const f=productionFixture(),first=await f.provider(),second=await f.provider(),input=f.input(),read=f.counterparty.readRecord;
 let arrived=0,release;const both=new Promise(resolve=>{release=resolve;});
 f.counterparty.readRecord=async request=>{const answer=await read(request);if(++arrived<=2){if(arrived===2)release();await both;}return answer;};
 const runs=await Promise.all([first,second].map(provider=>provider.jobVet(input.scope,input.buyerIdentityBundle,()=>true)));
 for(const run of runs)assert.equal(run.sellerVet.record.overallDecision,'pass');
 assert.equal(runs[0].sellerVet.recordRef.contentHash,runs[1].sellerVet.recordRef.contentHash);assert.equal(f.seen.length,1,'the one-use challenge was consumed once');assert.equal(f.local.writes.length,2);f.base.close();
});
test('a failed evaluate with no retained record stays a failure that keeps its cause',async()=>{
 const f=productionFixture(),cause=new Error('TEST evaluate failed');f.counterparty.evaluate=async()=>{throw cause;};
 await assert.rejects(f.run(),e=>e.code==='counterparty_vet_unavailable'&&e.cause===cause);assert.equal(f.local.writes.length,1);f.base.close();
});
test('a retained record read after a failed evaluate is still verified against the buyer',async()=>{
 const f=productionFixture(),evaluate=f.counterparty.evaluate;f.controls.wrongSigner=true;
 f.counterparty.evaluate=async input=>{await evaluate(input);throw new Error('TEST reply lost');};
 await assert.rejects(f.run(),e=>e.code==='seller_vet_invalid');assert.equal(f.local.writes.length,1);f.base.close();
});
test('a losing evaluate race waits for the winner to retain its record',async()=>{
 const f=productionFixture(),first=await f.provider(),second=await f.provider(),input=f.input(),read=f.counterparty.readRecord,buyerSign=buyer.signBytes;
 let arrived=0,releaseReads;const both=new Promise(resolve=>{releaseReads=resolve;});
 let held=false,releaseSign;const holdSign=new Promise(resolve=>{releaseSign=resolve;});
 f.counterparty.readRecord=async request=>{
  const answer=await read(request);
  if(answer.status==='unattempted'&&++arrived<=2){if(arrived===2)releaseReads();await both;}
  else if(answer.status==='indeterminate'&&held)setTimeout(releaseSign,0);
  return answer;
 };
 // The first evaluation consumes the one-use nonce and then stalls in signing,
 // so the second provider observes an in-progress ledger before a result exists.
 buyer.signBytes=bytes=>{if(!held){held=true;return holdSign.then(()=>buyerSign(bytes));}return buyerSign(bytes);};
 try{
  const runs=await Promise.all([first,second].map(provider=>provider.jobVet(input.scope,input.buyerIdentityBundle,()=>true)));
  for(const run of runs)assert.equal(run.sellerVet.record.overallDecision,'pass');
  assert.equal(f.seen.length,1,'the one-use challenge was consumed once');assert.equal(f.local.writes.length,2);
 }finally{buyer.signBytes=buyerSign;f.base.close();}
});
test('a finished job fresh-reads and fresh-verifies the seller receipt',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input(),read=f.anchor.readRetained,verify=f.anchor.verifyReceipt;
 const sellerAddress=compositeVerificationAddress(JOB,seller.claim),cached=new Map();let staleRead=false,staleVerify=false;
 f.anchor.readRetained=async options=>{
  const result=await read(options);
  if(options.logicalAddress!==sellerAddress)return result;
  // Emulate the native anchor's short immutable cache: an ordinary read may
  // answer the retained finalized evidence; only `fresh` sees current state.
  if(result.status==='present'&&!options.fresh)cached.set(sellerAddress,result);
  if(options.fresh)return staleRead&&result.status==='present'?{...result,receipt:{...result.receipt,state:'accepted'}}:result;
  return cached.get(sellerAddress)??result;
 };
 f.anchor.verifyReceipt=async options=>{
  if(options.logicalAddress===sellerAddress&&staleVerify&&options.fresh)return 'invalid';
  return verify(options);
 };
 const first=await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);assert.equal(first.sellerVet.record.overallDecision,'pass');
 staleRead=true;
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='seller_vet_receipt_invalid');
 staleRead=false;staleVerify=true;
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='seller_vet_receipt_invalid');
 f.base.close();
});
for(const [status,code] of [['rejected','seller_vet_receipt_invalid'],['indeterminate','indeterminate']])test(`a ${status} seller publication reply keeps its reason and class`,async()=>{
 const f=productionFixture(),publish=f.anchor.publish,sellerAddress=compositeVerificationAddress(JOB,seller.claim);
 f.anchor.publish=async options=>options.logicalAddress===sellerAddress?{status,reason:`TEST ${status}`}:publish(options);
 await assert.rejects(f.run(),e=>e.code===code&&e.cause?.status===status&&String(e.message).includes(`TEST ${status}`));f.base.close();
});
test('a resumed signed presentation without a buyer verifier is refused before any callback',async()=>{
 const f=productionFixture(),read=f.counterparty.readRecord;let fail=true;
 f.counterparty.readRecord=async request=>{if(fail){fail=false;throw Object.assign(new Error('TEST ledger unavailable'),{code:'ECONNREFUSED'});}return read(request);};
 await assert.rejects(f.run(),e=>e.code==='counterparty_vet_unavailable');
 f.config.counterparty=null;
 const provider=await f.provider(),input=f.input();
 await assert.rejects(provider.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='counterparty_vet_required'&&e.cause===undefined);
 f.base.close();
});
test('context authentication binds the supplied references to the canonical anchor',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 const result=await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 const context=()=>({jobId:JOB,buyer:{identityBundle:structuredClone(input.buyerIdentityBundle),vetRecordRef:structuredClone(result.buyerVet.recordRef)},
  seller:{identityBundle:structuredClone(result.sellerVet.identityBundle),vetRecordRef:structuredClone(result.sellerVet.recordRef)}});
 assert.equal(await p.contextAuthentic(context()),true);
 for(const [role,field,value] of [['buyer','kind','https'],['buyer','locator','https://absent.invalid/wrong'],['seller','kind','https'],['seller','locator','https://absent.invalid/wrong']]){
  const altered=context();altered[role].vetRecordRef.anchor[field]=value;
  assert.equal(await p.contextAuthentic(altered),false,`${role} ${field}`);
 }
 f.base.close();
});
test('context authentication binds the exact identity bundles including presentations',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 const result=await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 const context=()=>({jobId:JOB,buyer:{identityBundle:structuredClone(input.buyerIdentityBundle),vetRecordRef:structuredClone(result.buyerVet.recordRef)},
  seller:{identityBundle:structuredClone(result.sellerVet.identityBundle),vetRecordRef:structuredClone(result.sellerVet.recordRef)}});
 const unsigned=context();delete unsigned.seller.identityBundle.presentation;
 assert.equal(await p.contextAuthentic(unsigned),false);
 const changed=context();changed.buyer.identityBundle.presentedAt-=1;
 assert.equal(await p.contextAuthentic(changed),false);
 f.base.close();
});
