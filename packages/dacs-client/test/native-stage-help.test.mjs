import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protocolStageHelp, protocolView, STAGE_HELP } from '../src/dacs/protocol-purchases.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
for (const sourceBound of [true,false]) for (const stage of ['agreement-signing','agreement-anchored','seller-committed','payment-observed','native-payment-evidence-held']) test(`native ${stage} help, source binding ${sourceBound}`,()=>{
  const op={terms:{protocol:{profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',nativePayment:NATIVE_AGREEMENT_PAYMENT,sellerAgreementProjection:'public-signed-create',nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE,...(sourceBound?{transportBinding:{source:'devnet-agreement-transport/v1'}}:{})}},state:{protocol:{stage,...(stage==='native-payment-evidence-held'?{nativeEvidence:{status:'held'}}:{})}}};
  const help=protocolStageHelp(op);
  assert.equal(typeof help,'string');assert.doesNotMatch(help,/simulat|fixture/i);
  assert.match(help,/source.pin|source-pinned/i);
});

test('completed stage help describes source observations',()=>{
 assert.doesNotMatch(STAGE_HELP.completed,/fixture|simulated/i);assert.match(STAGE_HELP.completed,/source-pinned/);
});
for(const sourceBound of [false,true])test(`native result limits describe source transport, binding ${sourceBound}`,()=>{
 const op={status:'settled_verified',terms:{protocol:{profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',nativePayment:NATIVE_AGREEMENT_PAYMENT,sellerAgreementProjection:'public-signed-create',nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE,...(sourceBound?{transportBinding:{source:'devnet-agreement-transport/v1'}}:{})}},state:{protocol:{stage:'payment-evidenced'}}};
 const view=protocolView(op);
 assert.doesNotMatch(view.limits.payment,/fixture|simulated/i);if(!sourceBound)assert.match(view.limits.payment,/source/);
 assert.doesNotMatch(view.limits.substrate,/fixture|simulated/i);
 assert.doesNotMatch(view.limits.wallet,/fixture|simulated/i);
});
