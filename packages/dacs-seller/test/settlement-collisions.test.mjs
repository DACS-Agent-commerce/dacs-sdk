import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {key} from './helpers/d5-http-fixture.mjs';
const {createSellerDurableState}=await import('../src/dacs/seller-durable-state.mjs');
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
for(const jobs of [JOBS,[...JOBS].reverse()])test(`a settlement collision suspends both jobs in order ${jobs.join(',')}, including after a restart`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'seller-collision-')),signer=key(),listingPin={listingId:'collision',version:1,contentHash:'a'.repeat(64)};
 let store=await createSellerDurableState({dir,signer,listingPin});
 try{
  store.retainContext({admittedAt:1800000000000,validation:{disposition:'verified'}});
  assert.equal(await store.withJob(jobs[0],()=>store.bindSettlement('demos:one-tx',jobs[0],{phaseIndex:0,jobId:jobs[0],evidenceHash:'b'.repeat(64)})),true);
  assert.equal(store.settlementJob('demos:one-tx'),jobs[0]);
  assert.equal(await store.withJob(jobs[1],()=>store.bindSettlement('demos:one-tx',jobs[1],{phaseIndex:0,jobId:jobs[1],evidenceHash:'c'.repeat(64)})),false);
  for(const jobId of jobs)assert.equal(await store.withJob(jobId,()=>store.bindSettlement('demos:one-tx',jobId)),false);
  assert.equal(store.settlementJob('demos:one-tx'),null);store.close();store=null;store=await createSellerDurableState({dir,signer,listingPin});
  assert.equal(store.settlementJob('demos:one-tx'),null);
  for(const jobId of jobs)assert.equal(await store.withJob(jobId,()=>store.bindSettlement('demos:one-tx',jobId)),false);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});


test('transport admits a competing payment to authenticated intake instead of electing the first sender',async()=>{
 const {createSellerTransportStore}=await import('./helpers/bound-transport-store.mjs');
 const {withFixtureProfile}=await import('./helpers/wire-authority-fixture.mjs');
 const dir=mkdtempSync(join(tmpdir(),'transport-collision-')),store=withFixtureProfile(createSellerTransportStore({path:join(dir,'transport.sqlite'),now:()=>1800000000000}));
 const buyer=key().claim,seller=key().claim,listingPin={listingId:'collision',version:1,contentHash:'b'.repeat(64)};
 try{
  for(const [i,jobId] of JOBS.entries()){
   const request={jobId,buyer,seller,listingPin,agreementHash:'c'.repeat(64),nonce:String(i).repeat(32),expiresAt:1800000030000,method:'POST',path:'/dacs/v1/agreements/proposals',bodyHash:'d'.repeat(64)};
   const proposal=store.reserve(request,{});store.finish(proposal,200,'{}');
   const payment=store.reserve({...request,path:'/dacs/v1/payments',nonce:String(i+2).repeat(32)},{jobId,txHash:'e'.repeat(64),payerPayingKey:buyer});
   assert.equal(payment.disposition,'perform');store.finish(payment,200,'{}');
  }
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('cached delivered transport answer is revalidated before disclosure',async()=>{
 const {createSellerHttpHandler}=await import('../src/dacs/seller-http.mjs');const {exchange}=await import('./helpers/d5-http-fixture.mjs');
 const seller=key().claim,listingPin={listingId:'collision',version:1,contentHash:'b'.repeat(64)};
 const handler=createSellerHttpHandler({claim:seller,listingPin,assertSettlementCredit:()=>{throw new Error('credit suspended')}},{authentication:{seller,listingPin,readRequest:()=>({jobId:JOBS[0]}),validate:()=>{},responseHeader:()=> 'fixture',store:{reserve:()=>({disposition:'cached',status:200,text:'{"status":"delivered"}'})}}});
 const result=await exchange(handler,{url:'/dacs/v1/payments',text:'{}',header:'fixture'});assert.equal(result.status,503);assert.notEqual(JSON.parse(result.text).status,'delivered');
});

// ---- The same settlement submitted for two jobs through the wire host ----

// Which job claims first, and how the second job is refused. Either refusal leaves the second job with no effect and the first with no credit.
const FIXTURE_ORDERS = [[0, 1, ['indeterminate', 'settlement-collision']], [1, 0, ['rejected', 'settlement-identity-replay']]];
const NATIVE_ORDERS = [[0, 1, ['indeterminate', 'settlement-collision']], [1, 0, ['indeterminate', 'settlement-collision']]];
const nothingWritten = (counts) => assert.deepEqual(counts, { evidenceCreates: 0, deliverableWrites: 0, deliveryEvidenceWrites: 0 }, 'no evidence, Deliverable or delivery evidence is written');

// The first job's payment stops after its work is kept: its settlement is bound and nothing is signed or sent.
// A request signed for the second job whose body changed after signing is not an admissible claim.
async function collideFixtureJobs(t, [first, second, refusal]) {
  const { fixturePaymentWorld, EVIDENCE_SIGNATURE, PAYMENT_TX } = await import('./helpers/wire-payment-fixture.mjs');
  const { PATHS } = await import('./helpers/wire-routes-world.mjs');
  const w = await fixturePaymentWorld(t), jobs = [w.jobId, w.otherJobId], label = `first ${first}`;
  w.script.signFault = EVIDENCE_SIGNATURE;
  assert.equal((await w.pay({ id: jobs[first] })).body.error, 'operation_uncertain', label);
  const signed = await w.buyerWire.signRequest(PATHS.payments, w.bodyOf(jobs[second], PAYMENT_TX), { jobId: jobs[second], agreementHash: w.agreementHashes.get(jobs[second]) });
  const forged = await w.send(PATHS.payments, { ...signed, text: `${signed.text} ` });
  assert.ok(forged.status >= 400 && forged.body.status === undefined, `${label}: a claim whose signature does not cover its body is refused: ${forged.text}`);
  assert.doesNotThrow(() => w.agent.assertSettlementCredit(jobs[first]), `${label}: the refused claim did not suspend the first job`);
  const contested = await w.pay({ id: jobs[second] });
  assert.deepEqual([contested.status, contested.body.status, contested.body.reason], [200, ...refusal], label);
  const assertBothSuspended = async (when) => {
    assert.throws(() => w.agent.assertSettlementCredit(jobs[first]), { code: 'settlement_collision' }, `${label}, ${when}: the first job lost its credit`);
    w.lapse();
    const retried = await w.pay({ id: jobs[first] });
    assert.notEqual(retried.body.status, 'delivered', `${label}, ${when}: the first job is not delivered: ${retried.text}`);
    const again = await w.pay({ id: jobs[second] });
    assert.deepEqual([again.status, again.body.status, again.body.reason], [200, ...refusal], `${label}, ${when}: the second job stays refused`);
    for (const id of jobs) {
      nothingWritten({ evidenceCreates: w.evidenceCreates(id), deliverableWrites: w.deliverableWrites(id), deliveryEvidenceWrites: w.deliveryEvidenceWrites(id) });
      assert.equal(w.payment(id), undefined, `${label}, ${when}: no payment is cached as a success`);
    }
  };
  await assertBothSuspended('at once');
  await w.restart();
  await assertBothSuspended('after a restart');
}

async function collideNativeJobs(t, [first, second, refusal]) {
  const { nativePaymentWorld } = await import('./helpers/native-payment-wire-fixture.mjs');
  const w = await nativePaymentWorld(t), jobs = [await w.purchase(), await w.purchase()], txHash = jobs[0].pay(), label = `first ${first}`;
  w.faults.walletSignature = 1;
  assert.notEqual((await jobs[first].claim(txHash)).status, 'payment-evidenced', label);
  const signed = await jobs[second].sign(txHash);
  const forged = await jobs[second].post({ ...signed, text: `${signed.text} ` });
  assert.ok(forged.status >= 400 && forged.body.status === undefined, `${label}: a claim whose signature does not cover its body is refused: ${forged.text}`);
  const contested = await jobs[second].claim(txHash);
  assert.deepEqual([contested.status, contested.reason], refusal, label);
  const assertBothSuspended = async (when) => {
    const retried = await jobs[first].claim(txHash);
    assert.notEqual(retried.status, 'payment-evidenced', `${label}, ${when}: the first job is not delivered`);
    const again = await jobs[second].claim(txHash);
    assert.deepEqual([again.status, again.reason], refusal, `${label}, ${when}: the second job stays refused`);
    assert.deepEqual([w.counts.walletSignatures, w.counts.walletBroadcasts], [0, 0], `${label}, ${when}: the wallet signs and sends nothing`);
    for (const p of jobs) assert.deepEqual([w.evidenceCreates(p), w.deliverableWrites(p), w.deliveryEvidenceWrites(p)], [0, 0, 0], `${label}, ${when}: nothing is written`);
  };
  await assertBothSuspended('at once');
  await w.restart();
  await assertBothSuspended('after a restart');
}

test('the same settlement submitted for two admissible jobs, in both orders and after a restart, suspends credit for both; an inadmissible competing claim gains nothing and cannot suspend the other', async (t) => {
  for (const order of FIXTURE_ORDERS) await collideFixtureJobs(t, order);
  for (const order of NATIVE_ORDERS) await collideNativeJobs(t, order);
});

test('a claim whose signature does not cover its body leaves the first job able to deliver', async (t) => {
  const { fixturePaymentWorld, EVIDENCE_SIGNATURE, PAYMENT_TX } = await import('./helpers/wire-payment-fixture.mjs');
  const { PATHS } = await import('./helpers/wire-routes-world.mjs');
  const w = await fixturePaymentWorld(t);
  w.script.signFault = EVIDENCE_SIGNATURE;
  assert.equal((await w.pay()).body.error, 'operation_uncertain');
  const signed = await w.buyerWire.signRequest(PATHS.payments, w.bodyOf(w.otherJobId, PAYMENT_TX), { jobId: w.otherJobId, agreementHash: w.agreementHashes.get(w.otherJobId) });
  assert.ok((await w.send(PATHS.payments, { ...signed, text: `${signed.text} ` })).status >= 400);
  w.lapse();
  const final = await w.pay();
  assert.deepEqual([final.status, final.body.status], [200, 'delivered']);
  assert.deepEqual([w.evidenceCreates(), w.deliverableWrites(), w.deliveryEvidenceWrites()], [1, 1, 1]);
});
