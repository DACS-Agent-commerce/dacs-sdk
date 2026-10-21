// Item 5 (read seams only): how the admitted Node2 capability reaches the
// operator's existing read consumers. Executed here: the seller SR-2 Agreement
// observer composition (operator.mjs:164) and the pinned chain reader identity
// read. NOT executed: payment, Agreement/SettlementEvidence/Deliverable CREATE,
// wallet bridge writes, seller process/TLS or any signature. Offline .invalid
// stubs only; the SR-2 journal refuses writes as in the operator composition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { createSellerSr2AgreementAnchor } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
import { createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { CHAIN, ENDPOINT, NOW, WRITER, admittedTransport, blockZeroAdmission, envelopeAdmission, envelopeChain, layoutAdmission, layoutChain, zeroBlock } from './helpers/review-node2-current-coverage-fixture.mjs';

const LOGICAL='dacs4:agreement:review-node2-cov-job';
const SEARCH={searchStoragePrograms:{result:200,response:[]}};
const runtime=(t,admission,answers)=>{const run=admittedTransport(admission,answers);t.after(()=>run.capability.close());return run;};
const others=(run)=>run.stub.messages().filter((m)=>m!=='getBlockByNumber');
// Exactly operator.mjs:164: read-only journal, reader over the source capability.
const sellerObserver=(capability)=>createSellerSr2AgreementAnchor({reader:createDemosSr2Adapter({rpcUrl:ENDPOINT,sourceCapability:capability,
  journal:{...createInMemoryDemosSr2Journal(),put:async()=>{throw new Error('seller Agreement observer is read-only');}},now:()=>NOW})});

test('control: block-zero (v1) admission lets the seller SR-2 Agreement observer reach the name index (absent)',async t=>{
  const run=runtime(t,await blockZeroAdmission(),{0:zeroBlock(),...SEARCH});
  const answer=await sellerObserver(run.capability).readAgreement({logicalAddress:LOGICAL,writer:WRITER});
  assert.equal(answer.disposition,'absent');
  assert.deepEqual(run.stub.messages(),['getBlockByNumber','getBlockByNumber','searchStoragePrograms']);
  assert.deepEqual(run.stub.heights(),[0,0]);assert.deepEqual(run.journal.puts,[]);
});

for(const [name,admission,chain,heights] of [['layout',layoutAdmission,layoutChain,[0,1,2,0,1,2]],['four-field envelope',envelopeAdmission,envelopeChain,[0,1,0,1]]])
  test(`repaired consumer (${name} admission): the SR-2 Agreement observer consumes a fresh reviewed binding then reaches the name index`,async t=>{
    const run=runtime(t,await admission(),{...chain(),...SEARCH});
    const answer=await sellerObserver(run.capability).readAgreement({logicalAddress:LOGICAL,writer:WRITER});
    assert.equal(answer.disposition,'absent');
    assert.deepEqual(run.stub.heights(),heights);assert.deepEqual(others(run),['searchStoragePrograms']);assert.deepEqual(run.journal.puts,[]);
  });

test('contrast: the pinned chain reader identity read follows the SDK block-one convention under the layout admission',async t=>{
  const run=runtime(t,await layoutAdmission(),layoutChain());
  assert.deepEqual(await run.capability.chainReader().networkIdentity(),{mode:'public-chain-read',identity:CHAIN});
  assert.deepEqual(run.stub.heights(),[0,1,2,0,0,1,2,1]);assert.deepEqual(run.journal.puts,[]);
});

test('construction only: the native payment evidence consumer accepts the admitted capability and composes the same SR-2 adapter without any read',async t=>{
  const run=runtime(t,await layoutAdmission(),layoutChain());
  const consumer=createNativePaymentEvidenceConsumer({rpcUrl:ENDPOINT,sourceCapability:run.capability});
  assert.equal(typeof consumer.readEvidence,'function');assert.equal(typeof consumer.observeDemosTransfer,'function');
  assert.deepEqual(run.stub.calls,[]);assert.deepEqual(run.journal.puts,[]);
});
