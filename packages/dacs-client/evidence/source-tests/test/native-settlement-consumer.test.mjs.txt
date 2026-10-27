import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCanonicalJobId } from '@kynesyslabs/dacs';
import { nativeEvidenceReadOutcome,createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing,fixtureIdentityBundle } from './fixtures/listings.mjs';
import { startAgreementChain } from './helpers/offline-agreement-fixture.mjs';
import { nativeEvidenceFlow } from './helpers/native-payment-evidence-flow.mjs';
import { installLoopbackOnlyGuard,externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
installLoopbackOnlyGuard();

test('native evidence result trichotomy: only exact absence is absent; invalid/rejected and indeterminate preserve exact state/reason',()=>{
  for(const [status,disposition] of [['absent','absent'],['invalid','rejected'],['rejected','rejected'],['indeterminate','indeterminate'],['unknown','indeterminate']]){
    const reason=`retained-${status}`,actual=nativeEvidenceReadOutcome({status,reason,code:'functional-reader-state'});
    assert.deepEqual(actual,{disposition,nativeReadStatus:status,reason,code:'functional-reader-state'});
  }
  assert.equal(nativeEvidenceReadOutcome({status:'present'}),null,'present is only permission to continue authentication, not validity');
  assert.equal(nativeEvidenceReadOutcome(undefined).disposition,'indeterminate');
  assert.equal(nativeEvidenceReadOutcome({}).nativeReadStatus,'missing');
});

test('actual owned native reader returns true absence separately from unavailable read; unsigned lookup plan is not accepting evidence',async(t)=>{
  const chain=await startAgreementChain();t.after(()=>chain.close());
  const buyer=createEphemeralWallet(),seller=createEphemeralWallet(),now=Date.now();
  // Only a real SDK-derived lookup scope, not a signed/anchored Agreement or
  // payment accepting control. The empty node has no evidence to authenticate.
  const {draft}=planAgreement({jobId:generateCanonicalJobId({timestamp:now}),listing:fixtureListing(seller,{now}),buyerBundle:fixtureIdentityBundle(buyer,now),generatedAt:now});
  const consumer=createNativePaymentEvidenceConsumer({rpcUrl:chain.url});
  const input={agreement:draft,writer:seller.claim,txHash:'a'.repeat(64),blockNumber:2,committedAt:now};
  const absent=await consumer.readEvidence(input);
  assert.equal(absent.disposition,'absent');assert.equal(absent.nativeReadStatus,'absent');
  chain.faults.unavailable=true;
  const unavailable=await consumer.readEvidence(input);
  assert.equal(unavailable.disposition,'indeterminate');assert.notEqual(unavailable.nativeReadStatus,'absent');
  assert.ok(unavailable.reason);chain.faults.unavailable=false;
  assert.equal((await consumer.readEvidence(input)).disposition,'absent');
  assert.deepEqual(externalAttempts,[]);
});

test('actual native payment then unknown-after-apply seller SettlementEvidence CREATE recovers public journal and fresh readback without resend across durable restarts',async(t)=>{
  const w=await nativeEvidenceFlow(t);
  assert.equal((await w.agreement()).status,'awaiting_approval');
  await new Promise(resolve=>setTimeout(resolve,1050));
  const {handoff}=await w.approve();assert.equal(handoff.status,'payment_handoff');
  w.seller.faults.evidenceUnknownAfterApply=true;
  const sent=await w.send(handoff.payload),hash=w.h.chain.record.accepted[0]?.hash??sent.data?.hash;
  const report=await w.api('report',{txHash:hash});
  assert.equal(report.status,'settled_verified');assert.equal(report.evidence.protocol.stage,'payment-evidenced',JSON.stringify({nativeEvidence:report.evidence.protocol.nativeEvidence,anchorAnswers:w.seller.evidenceAnswers}));
  assert.equal(report.evidence.protocol.nativeEvidence.nativeReadback,'present');
  assert.equal(report.evidence.protocol.nativeEvidence.finality,'one-node-fixture-view-not-independent');
  const attempts=w.seller.evidenceAttempts.map(x=>JSON.stringify(x));
  assert.equal(attempts.length,1);assert.equal(w.h.chain.wire.record.accepted.length,2);
  const input=w.seller.evidenceAttempts[0],projection=await w.seller.publicProjection({logicalAddress:input.logicalAddress,writer:input.writer});
  assert.ok(projection);assert.equal(JSON.stringify(projection.content.data[1].data),JSON.stringify(input.artifact));
  assert.equal(projection.content.from,w.seller.wallet.address);assert.notEqual(projection.content.from,w.address);
  const unknownRows=(await w.seller.walletJournal.entries()).filter(([key,r])=>key.startsWith('sr2/wallet/')&&r.hash===projection.hash);
  assert.equal(unknownRows.length,1);assert.equal(unknownRows[0][1].stage,'broadcast-started','unknown wallet result is not rewritten as a forged success');
  w.h.chain.wire.faults.dropAfterApply=false;w.seller.faults.evidenceUnknownAfterApply=false;
  await w.seller.restart();await w.h.restart();
  for(let i=0;i<2;i++)assert.equal((await w.verify()).protocol.stage,'payment-evidenced');
  assert.deepEqual(w.seller.evidenceAttempts.map(x=>JSON.stringify(x)),attempts);
  assert.equal(w.seller.sellerApprovals.filter(x=>x.method==='sendTransaction').length,1);
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length,2);assert.equal(w.h.chain.record.broadcasts.length,1);
  assert.equal((await w.api('completion/request')).error,'native_completion_held');
  assert.deepEqual(externalAttempts,[]);
});
