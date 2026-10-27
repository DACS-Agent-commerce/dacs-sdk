import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createSellerAgentClient, SellerUnavailableError } from '../src/dacs/seller-http.mjs';
import { SELLER_DELEGATION_SAFETY_MARGIN_MS } from '../src/dacs/protocol-purchases.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { readdirSync } from 'node:fs';
import { sha256Hex } from '@kynesyslabs/dacs';

const CASES=[{lostResponse:false},{lostResponse:true},{lostResponse:true,expireBeforeRecovery:true}];
for(const {lostResponse,expireBeforeRecovery=false} of CASES)test(`app session delegation: a second generated wallet buys through the portal${lostResponse?' and recovers a lost seller response without resend':''}${expireBeforeRecovery?' after the delegation expired':''}`,{timeout:600000},async t=>{
  const testBuyer=createEphemeralWallet(),w=await sourceDemoFlow(t,{delegated:true});
  assert.notEqual(w.buyerActor.signer.claim,testBuyer.claim);
  assert.equal(w.op().terms.protocol.sellerTransport.delegation,'seller-session-delegation/v1');
  const identity=await w.api('agreement/identity',{address:w.address});
  assert.equal(identity.httpStatus,200,JSON.stringify(identity));
  assert.equal(identity.signRequest.delegation.payload.buyer,w.buyerActor.signer.claim);
  assert.equal(identity.signRequest.delegation.payload.jobId,w.op().terms.protocol.jobId);
  const rejected=await w.api('agreement/plan',{signature:w.buyerActor.signer.signBytes(Buffer.from(identity.signRequest.message)).toString('hex')});
  assert.equal(rejected.httpStatus,409);assert.equal(rejected.error,'bad_signature');
  assert.equal(w.seller.anchorWrites.length,0,'missing delegation refuses before seller Vet writes');
  assert.equal((await w.agreement()).status,'awaiting_approval');
  const delegation=w.op().state.protocol.sessionDelegation;
  assert.notEqual(delegation.payload.sessionPublicKey,w.buyerActor.signer.claim.slice('did:demos:agent:'.length));
  assert.ok(delegation.payload.expiresAt<=w.op().state.protocol.agreement.artifact.terms.deadline);
  await new Promise(resolve=>setTimeout(resolve,1050));
  const {handoff}=await w.approve(),sent=await w.send(handoff.payload);assert.equal(sent.success,true);
  if(lostResponse)w.seller.dropNextPaymentResponse();
  const reported=await w.api('report',{txHash:sent.data.hash});assert.equal(reported.status,'settled_verified');
  const writes=w.seller.anchorWrites.length,creates=w.h.chain.wire.record.broadcastAttempts.length;
  if(lostResponse)assert.equal(reported.evidence.protocol.stage,'payment-observed');
  else assert.equal(reported.evidence.protocol.stage,'delivery-ready');
  // Move the delegation clock (app sessions, client auth and seller auth) past expiry.
  if(expireBeforeRecovery)w.advanceDelegationClock(delegation.payload.expiresAt-Date.now()+5000);
  await w.h.restart();await w.seller.restart();w.restartSessions();
  const verified=await w.verify();assert.equal(verified.protocol.stage,'delivery-ready',JSON.stringify(verified));
  if(expireBeforeRecovery){
    // The journaled payment was read back; a new seller effect is refused before invocation.
    const authentication=w.sellerTransport.authenticationFor(w.op()),peer=createSellerAgentClient({url:w.seller.origin,authentication});
    await assert.rejects(peer.bundleRequest(delegation.payload.jobId),SellerUnavailableError);
    const body={jobId:delegation.payload.jobId},text=JSON.stringify(body),signed=await authentication.request('/dacs/v1/bundles/request',body,text);
    const response=await fetch(`${w.seller.origin}/dacs/v1/bundles/request`,{method:'POST',headers:{'content-type':'application/json','x-dacs-seller-peer':signed.header},body:text});
    const answer=await response.text();assert.equal(response.status,408);assert.equal(JSON.parse(answer).error,'peer_delegation_expired');
    authentication.verifyResponse(signed.payload,{header:response.headers.get('x-dacs-seller-peer'),status:response.status,text:answer});
  }
  assert.equal(modelReport(verified.protocol.delivery.report).jobId,delegation.payload.jobId);
  assert.equal(w.seller.anchorWrites.length,writes);assert.equal(w.h.chain.wire.record.broadcastAttempts.length,creates);
  assert.equal(w.h.chain.record.broadcasts.length,1,'the buyer transfer is sent exactly once');
  assert.equal(creates,3,'one Agreement, payment evidence and Deliverable native CREATE each');
});

// Session key deletion: once the purchase is delivery-ready and the grace
// window passed (also across a restart), the sweep deletes the private key.
// Later rechecks re-read the delivery (readback only) and send nothing to the
// seller; seller-session-final-readback.test.mjs covers failed reads.
test('session key deletion: a delivery-ready purchase loses its session key after the grace window, and later rechecks re-read its delivery without seller requests',{timeout:600000},async t=>{
  const w=await sourceDemoFlow(t,{delegated:true});
  assert.equal((await w.agreement()).status,'awaiting_approval');
  await new Promise(resolve=>setTimeout(resolve,1050));
  const {handoff}=await w.approve(),sent=await w.send(handoff.payload);assert.equal(sent.success,true);
  const reported=await w.api('report',{txHash:sent.data.hash});assert.equal(reported.evidence.protocol.stage,'delivery-ready');
  const finalAt=w.op().state.protocol.sellerSessionFinalAt,requestsBefore=w.seller.requests.length;
  assert.ok(Number.isSafeInteger(finalAt));
  for(let n=0;n<8;n++){
    w.advanceDelegationClock(10*60000);
    assert.equal((await w.verify()).protocol.stage,'delivery-ready');
  }
  assert.equal(w.seller.requests.length,requestsBefore,'final polling never acquires seller authentication');
  assert.equal(w.op().state.protocol.sellerSessionFinalAt,finalAt,'final polling does not restart the retirement clock');
  w.advanceDelegationClock(-80*60000);
  const keyName=`${sha256Hex(w.id)}.json`,retiredName=`${sha256Hex(w.id)}.retired.json`;
  let swept=w.sweepSessions();
  assert.deepEqual(swept.deleted,[]);assert.match(swept.kept[0].reason,/delivery-ready; inside the grace window/);
  await w.h.restart();await w.seller.restart();w.restartSessions();
  swept=w.sweepSessions();assert.deepEqual(swept.deleted,[],'a restart inside the grace window keeps the key');
  assert.deepEqual(readdirSync(w.sessionDirectory),[keyName]);
  const requests=w.seller.requests.length,writes=w.seller.anchorWrites.length,creates=w.h.chain.wire.record.broadcastAttempts.length;
  w.advanceDelegationClock(SELLER_SESSION_KEY_GRACE_MS+1000);
  swept=w.sweepSessions();
  assert.deepEqual(swept.deleted.map(item=>[item.operationId,item.sessionPublicKey]),[[w.id,w.op().state.protocol.sessionDelegation.payload.sessionPublicKey]]);
  assert.deepEqual(readdirSync(w.sessionDirectory),[retiredName],'only the key-free retired marker remains');
  for(const restart of [false,true]){
    if(restart){await w.h.restart();w.restartSessions();}
    const verified=await w.verify();
    assert.equal(verified.protocol.stage,'delivery-ready',JSON.stringify(verified));
    assert.equal(modelReport(verified.protocol.delivery.report).jobId,w.op().terms.protocol.jobId);
  }
  // Recorded state never stands in for a read (these states are injected; the
  // sweep never deletes a key while evidence is pending). A recorded delivered
  // is final and is re-read: without a delivery evidence reader in this
  // fixture the fresh read shows delivery-ready. A recorded pending evidence
  // hold is not final; with the key deleted it is re-read from the retained
  // seller answer. With no retained pointer at all, the hold is recorded.
  const ops=()=>w.h.app.services.ops,base=w.op().state.protocol;
  ops().transition(w.id,'settled_verified','settled_verified',{state:{protocol:{...base,stage:'delivered'}},event:'TEST_injected_delivered'});
  const delivered=await w.verify();
  assert.equal(delivered.protocol.stage,'delivery-ready',JSON.stringify(delivered));
  assert.equal(modelReport(delivered.protocol.delivery.report).jobId,w.op().terms.protocol.jobId);
  const evidenceHold={status:'pending',logicalAddress:`dacs4:evidence:${w.op().terms.protocol.jobId}`,reason:'TEST delivery evidence has not read back'};
  ops().transition(w.id,'settled_verified','settled_verified',{state:{protocol:{...base,stage:'delivery-ready',delivery:{...base.delivery,evidenceHold}}},event:'TEST_injected_evidence_pending'});
  const pending=await w.verify();
  assert.equal(pending.protocol.stage,'delivery-ready',JSON.stringify(pending));
  assert.equal(pending.protocol.delivery.evidenceHold,undefined,'the fresh read decides, not the recorded hold');
  const {sellerAnswer,...unpointed}=base;assert.ok(sellerAnswer);
  ops().transition(w.id,'settled_verified','settled_verified',{state:{protocol:{...unpointed,stage:'payment-evidenced',delivery:null}},event:'TEST_injected_no_pointer'});
  const held=await w.verify();
  assert.notEqual(held.protocol.stage,'delivery-ready',JSON.stringify(held));
  assert.match(JSON.stringify(w.op().state.protocol),/seller session key for this purchase was deleted/);
  assert.deepEqual(readdirSync(w.sessionDirectory),[retiredName],'no replacement key');
  assert.equal(w.seller.requests.length,requests,'no seller request without the key');
  assert.equal(w.seller.anchorWrites.length,writes);assert.equal(w.h.chain.wire.record.broadcastAttempts.length,creates);
  assert.equal(w.h.chain.record.broadcasts.length,1,'the buyer transfer is sent exactly once');
});

// Safety margin: a step that would need a NEW seller write starts only while
// the delegation has SELLER_DELEGATION_SAFETY_MARGIN_MS left. The delegation
// clock is moved back so the delegation is created that close to expiry
// against the app's real clock.
const sign=async(w,message)=>{const r=await w.wallet.request({method:'sign',params:[message]});assert.equal(r.success,true);return r.data.signature;};
async function delegatedNear(t,headroomMs){
  const w=await sourceDemoFlow(t,{delegated:true}),lifetime=w.op().state.protocol.listing.terms.deadlineSecAfterCommit*1000;
  w.advanceDelegationClock(headroomMs-lifetime);
  const identity=await w.api('agreement/identity',{address:w.address});assert.equal(identity.httpStatus,200,JSON.stringify(identity));
  const expiresAt=identity.signRequest.delegation.payload.expiresAt;assert.ok(Math.abs(expiresAt-Date.now()-headroomMs)<5000);
  return{w,identity,expiresAt};
}
const waitUntil=(time)=>new Promise(resolve=>setTimeout(resolve,Math.max(0,time-Date.now())));

test('safety margin: a delegation with less than the margin left plans nothing and makes no seller write',{timeout:600000},async t=>{
  const {w,identity}=await delegatedNear(t,SELLER_DELEGATION_SAFETY_MARGIN_MS-60000);
  const planned=await w.api('agreement/plan',{signature:await sign(w,identity.signRequest.message),delegationSignature:await sign(w,identity.signRequest.delegation.message)});
  assert.equal(planned.httpStatus,409,JSON.stringify(planned));assert.equal(planned.error,'seller_delegation_expiring');
  assert.match(planned.message,/nothing was signed or sent/);
  assert.equal(w.op().status,'agreement_pending');assert.equal(w.op().state.protocol.planned,undefined);
  assert.equal(w.seller.anchorWrites.length,0,'no seller Vet write');assert.deepEqual(w.seller.requests,[]);
});

test('safety margin: the first Agreement signature is refused once the margin is reached; no seller proposal or Agreement CREATE',{timeout:600000},async t=>{
  const {w,identity,expiresAt}=await delegatedNear(t,SELLER_DELEGATION_SAFETY_MARGIN_MS+15000);
  const planned=await w.api('agreement/plan',{signature:await sign(w,identity.signRequest.message),delegationSignature:await sign(w,identity.signRequest.delegation.message)});
  assert.equal(planned.httpStatus,200,JSON.stringify(planned));
  const vetWrites=w.seller.anchorWrites.length,creates=w.h.chain.wire.record.broadcastAttempts.length;
  await waitUntil(expiresAt-SELLER_DELEGATION_SAFETY_MARGIN_MS+250);
  const signed=await w.api('agreement/sign',{agreementSignature:await sign(w,planned.signRequest.agreementMessage)});
  assert.equal(signed.httpStatus,409,JSON.stringify(signed));assert.equal(signed.error,'seller_delegation_expiring');
  assert.equal(w.op().state.protocol.signatures,undefined);assert.equal(w.op().state.protocol.stage,'agreement-signing');
  assert.equal(w.seller.requests.filter(path=>path!=='/dacs/v1/agreements/state').length,0,'no seller proposal or commit');
  assert.equal(w.seller.anchorWrites.length,vetWrites);assert.equal(w.h.chain.wire.record.broadcastAttempts.length,creates);
});

test('safety margin: payment approval and handoff are refused once the margin is reached; nothing is sent',{timeout:600000},async t=>{
  const {w,expiresAt}=await delegatedNear(t,SELLER_DELEGATION_SAFETY_MARGIN_MS+45000);
  assert.equal((await w.agreement()).status,'awaiting_approval');
  assert.ok(Date.now()<expiresAt-SELLER_DELEGATION_SAFETY_MARGIN_MS,'the Agreement finished inside the test window');
  const seller=w.seller.requests.length,creates=w.h.chain.wire.record.broadcastAttempts.length;
  await waitUntil(expiresAt-SELLER_DELEGATION_SAFETY_MARGIN_MS+250);
  const challenge=await w.api('challenge',{address:w.address});
  assert.equal(challenge.httpStatus,409,JSON.stringify(challenge));assert.equal(challenge.error,'seller_delegation_expiring');
  assert.equal(w.op().status,'awaiting_approval');
  assert.equal(w.h.chain.record.broadcasts.length,0,'no buyer transfer');assert.equal(w.h.chain.wire.record.broadcastAttempts.length,creates);
  assert.equal(w.seller.requests.length,seller,'no seller request');
});
