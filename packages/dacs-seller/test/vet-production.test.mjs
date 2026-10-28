import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { JOB, NOW, buyer, seller } from './helpers/protocol-fixture.mjs';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';

test('staged Vet factory refuses before any signer, anchor or row operation',()=>{
 let effects=0;const effect=()=>{effects++;throw new Error('TEST effect');};
 assert.throws(()=>createDevnetDemoAgreementContextProvider({anchor:{hasIntent:effect,publish:effect},wallet:{signBytes:effect},store:{read:effect,update:effect,entries:effect}}),/Vet context is not assembled/);assert.equal(effects,0);
});
// SN-2 bounds an issued challenge only by a floor: at least 32 lowercase-hex
// characters and no upper bound. Odd lengths are conforming too.
for(const length of [32,33,64,255,256,300])test(`real staged bilateral engine accepts a ${length}-hex verifier nonce`,async()=>{
 const f=productionFixture();f.controls.nonce='a'.repeat(length);const result=await f.run();assert.equal(result.buyerVet.record.overallDecision,'pass');assert.equal(result.sellerVet.record.signature.signer,f.seen[0].buyer);assert.equal(f.local.writes.length,2);assert.equal(f.seen.length,1);f.base.close();
});
for(const length of [31])test(`nonce length ${length} refuses before signing`,async()=>{
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
test('a challenge that expires during the durable write is never signed',async()=>{
 const f=productionFixture();let at=NOW;
 f.config.now=()=>at;
 const issue=f.counterparty.issueChallenge;
 f.counterparty.issueChallenge=async request=>({...await issue(request),expiresAt:at+1});
 const update=f.store.update;
 f.config.store={...f.store,update:async(key,change)=>update(key,(old,rows)=>{
  const next=change(old,rows);
  // markWrite is the durable update that starts this purchase's first write.
  if(next?.writeStarted&&!old?.writeStarted)at+=2;
  return next;
 })};
 await assert.rejects(f.run(),e=>e.code==='seller_challenge_expired');
 assert.equal(f.controls.signs,0);
 const result=await f.run();assert.equal(result.sellerVet.record.overallDecision,'pass');
 assert.equal(f.local.writes.length,2);assert.equal(f.controls.signs,2);
 f.base.close();
});
test('a counterparty raw reply from another JavaScript realm is admitted',async()=>{
 const f=productionFixture(),issue=f.counterparty.issueChallenge;
 const ForeignUint8Array=vm.runInNewContext('Uint8Array');
 f.counterparty.issueChallenge=async args=>ForeignUint8Array.from(Buffer.from(JSON.stringify(await issue(args))));
 const result=await f.run();assert.equal(result.sellerVet.record.overallDecision,'pass');assert.equal(f.seen.length,1);
 f.base.close();
});
test('an oversized raw counterparty reply is refused before signatures',async()=>{
 const f=productionFixture(),issue=f.counterparty.issueChallenge;
 f.counterparty.issueChallenge=async args=>Buffer.from(JSON.stringify({...await issue(args),extra:'x'.repeat(65537)}));
 await assert.rejects(f.run(),e=>e.code==='counterparty_vet_unavailable'&&e.cause instanceof Error);assert.equal(f.controls.signs,0);f.base.close();
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
test('a purchase already closed starts no seller challenge',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 const issue=f.counterparty.issueChallenge;let issued=0;
 f.counterparty.issueChallenge=async request=>{issued++;return issue(request);};
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>false),e=>e.code==='not-pending');
 assert.equal(issued,0);assert.equal(f.controls.signs,0);assert.equal(f.local.writes.length,0);
 f.base.close();
});
test('a purchase closed while the challenge is issued retains no presentation',async()=>{
 const f=productionFixture(),input=f.input();
 // Observe every row write that would retain a presentation for this job.
 const update=f.store.update;let retained=false;
 f.config.store={...f.store,update:async(key,change)=>update(key,(old,rows)=>{const next=change(old,rows);if(next?.presentation)retained=true;return next;})};
 const issue=f.counterparty.issueChallenge;let closed=false;
 // The verifier issues its one-use challenge, and the purchase closes before
 // the seller can retain it.
 f.counterparty.issueChallenge=async request=>{const challenge=await issue(request);closed=true;return challenge;};
 const p=await f.provider();
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>closed?'closed':true),e=>e.code==='not-pending');
 assert.equal(retained,false);assert.equal(f.controls.signs,0);assert.equal(f.local.writes.length,0);
 assert.equal(await p.state.read(input.scope.jobId),null);
 f.base.close();
});
test('a purchase closed during the ledger read starts no evaluation',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 let closed=false,evaluations=0;
 const read=f.counterparty.readRecord;
 f.counterparty.readRecord=async request=>{const out=await read(request);closed=true;return out;};
 const evaluate=f.counterparty.evaluate;
 f.counterparty.evaluate=async request=>{evaluations++;return evaluate(request);};
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>closed?'closed':true),e=>e.code==='not-pending');
 assert.equal(evaluations,0);assert.equal(f.seen.length,0);f.base.close();
});
test('a record evaluated under a rotated presentation is not pinned to the new one',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 // Sign the presentation, then lose the ledger read, so the job is left with a
 // signed presentation and no retained counterparty record.
 const read=f.counterparty.readRecord;let unavailable=true;
 f.counterparty.readRecord=async request=>{if(unavailable){unavailable=false;throw new Error('TEST ledger unavailable');}return read(request);};
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='counterparty_vet_unavailable');
 const evaluate=f.counterparty.evaluate;
 f.counterparty.evaluate=async request=>{
  const record=await evaluate(request);
  // Another provider rotates the expired challenge while this record is in flight.
  await p.state.update(input.scope.jobId,current=>({...current,presentation:{challenge:{...current.presentation.challenge,sessionNonce:'b'.repeat(32)},bundle:{...current.presentation.bundle,sessionNonce:'b'.repeat(32)}}}));
  return record;
 };
 const row=await p.state.read(input.scope.jobId);
 await assert.rejects(p.produceSeller({jobId:row.jobId,binding:row.binding,open:()=>true,writeStarted:true}),e=>e.code==='binding-changed');
 assert.equal((await p.state.read(input.scope.jobId)).counterpartyRecord,undefined);
 f.base.close();
});
test('a finished job repeats without the buyer ledger after the challenge expires',async()=>{
 const f=productionFixture();let at=NOW;f.config.now=()=>at;
 const p=await f.provider(),input=f.input();
 assert.equal((await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true)).sellerVet.record.overallDecision,'pass');
 // The job's row already retains the buyer-issued record and the anchor holds
 // the receipt; an expired challenge must not make the repeat depend on the
 // buyer's ledger being reachable.
 at=NOW+60001;
 f.counterparty.readRecord=async()=>{throw new Error('TEST ledger offline');};
 f.counterparty.issueChallenge=async()=>{throw new Error('TEST ledger offline');};
 const repeat=await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 assert.equal(repeat.sellerVet.record.overallDecision,'pass');assert.equal(f.seen.length,1);
 f.base.close();
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
test('a resumed unsigned presentation without a buyer verifier makes no signature or write',async()=>{
 const f=productionFixture(),sign=f.config.wallet.signBytes;let interrupt=true;
 f.config.wallet.signBytes=bytes=>{if(interrupt){interrupt=false;throw new Error('TEST interrupted signer');}return sign(bytes);};
 await assert.rejects(f.run(),/TEST interrupted signer/);
 // The interrupted attempt kept an unsigned presentation (and its binding)
 // before the signer. A resume must not sign it, or anchor the buyer CVR,
 // before it discovers that the buyer verifier is missing.
 f.config.counterparty=null;
 await assert.rejects(f.run(),e=>e.code==='counterparty_vet_required'&&e.cause===undefined);
 assert.equal(f.controls.signs,0);assert.equal(f.local.writes.length,0);
 f.base.close();
});
test('a finished job replays its retained seller Vet without a buyer verifier',async()=>{
 // A retained buyer-issued record proves what happened: a repeat does not need
 // the buyer's ledger, so an absent capability must not block it.
 const f=productionFixture(),p=await f.provider(),input=f.input();
 await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 const signs=f.controls.signs;
 f.config.counterparty=null;
 const repeat=await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 assert.equal(repeat.sellerVet.record.overallDecision,'pass');
 assert.equal(f.controls.signs,signs);
 f.base.close();
});
test('context authentication refuses an incomplete context instead of throwing',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 const result=await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 const context=()=>({jobId:JOB,buyer:{identityBundle:structuredClone(input.buyerIdentityBundle),vetRecordRef:structuredClone(result.buyerVet.recordRef)},
  seller:{identityBundle:structuredClone(result.sellerVet.identityBundle),vetRecordRef:structuredClone(result.sellerVet.recordRef)}});
 assert.equal(await p.contextAuthentic({}),false);
 assert.equal(await p.contextAuthentic(null),false);
 for(const [label,mutate] of [
  ['no seller',ctx=>{delete ctx.seller;}],
  ['null buyer',ctx=>{ctx.buyer=null;}],
  ['no buyer bundle',ctx=>{delete ctx.buyer.identityBundle;}],
  ['no seller bundle',ctx=>{delete ctx.seller.identityBundle;}],
 ]){
  const altered=context();mutate(altered);
  assert.equal(await p.contextAuthentic(altered),false,label);
 }
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
