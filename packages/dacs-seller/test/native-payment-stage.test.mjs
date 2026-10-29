import test from 'node:test';
import assert from 'node:assert/strict';
import {commitmentFixture} from './helpers/commitment-fixture.mjs';
import {JOB,buyer} from './helpers/protocol-fixture.mjs';
import {NATIVE_PAYMENT_EVIDENCE} from '../src/dacs/native-payment-evidence-consumer.mjs';
test('native commitment and replay remain available while native payment is staged',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();assert.equal((await agent.commit({jobId:JOB})).status,'committed');assert.equal(f.local.writes.length,1);await assert.rejects(agent.submitPayment({jobId:JOB,txHash:'a'.repeat(64),payerPayingKey:buyer.claim,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE}),{code:'settlement_profile_unavailable'});assert.equal((await agent.commit({jobId:JOB})).status,'committed');assert.equal(f.local.writes.length,1);
});

test('native commitment, replay and readback recovery need no native payment delivery capability',async t=>{
 const f=await commitmentFixture(t);
 f.config.nativeDemDelivery=null;
 const {agent}=await f.prepare();
 assert.equal((await agent.commit({jobId:JOB})).status,'committed');
 const writes=f.local.writes.length;
 assert.equal((await agent.commit({jobId:JOB})).status,'committed');
 assert.equal((await agent.readCommitment({jobId:JOB})).status,'committed');
 await assert.rejects(agent.submitPayment({jobId:JOB,txHash:'a'.repeat(64),payerPayingKey:buyer.claim,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE}),{code:'settlement_profile_unavailable'});
 assert.equal(f.local.writes.length,writes);
});
