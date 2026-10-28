import test from 'node:test';
import assert from 'node:assert/strict';
import {commitmentFixture} from './helpers/commitment-fixture.mjs';
import {JOB,buyer} from './helpers/protocol-fixture.mjs';
import {NATIVE_PAYMENT_EVIDENCE} from '../src/dacs/native-payment-evidence-consumer.mjs';
test('native commitment and claim refuse before publication while native payment is staged',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();await assert.rejects(agent.commit({jobId:JOB}),{code:'settlement_profile_unavailable'});await assert.rejects(agent.submitPayment({jobId:JOB,txHash:'a'.repeat(64),payerPayingKey:buyer.claim,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE}),{code:'settlement_profile_unavailable'});assert.equal(f.local.writes.length,0);
});
