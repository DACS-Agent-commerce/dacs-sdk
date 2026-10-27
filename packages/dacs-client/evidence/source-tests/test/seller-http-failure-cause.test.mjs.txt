import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSellerAgentClient, SellerUnavailableError, SellerRefusedError } from '../src/dacs/seller-http.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, portal, tokenFrom } from './helpers/flows.mjs';
import { opsHealth, formatOpsHealth } from '../src/ops/health.mjs';

const MESSAGE='seller agent response is unavailable or unauthenticated; the operation outcome may be unknown';
const privateError=(code)=>Object.assign(new Error('PRIVATE peer/certificate detail'),{code});
const json=(status=200,text='{}')=>new Response(text,{status,headers:{'content-type':'application/json'}});
for(const causeCode of ['tls','network','response-auth','status-5xx','client-sign','timeout','other'])test(`HTTP failures expose only bounded ${causeCode} cause with unchanged message`,async()=>{
  const authentication={request:async()=>({header:'test',payload:{}}),verifyResponse:()=>{}};
  let fetchImpl=async()=>json();
  if(causeCode==='tls'||causeCode==='network')fetchImpl=async()=>{throw new TypeError('PRIVATE wrapper',{cause:privateError(causeCode==='tls'?'CERT_HAS_EXPIRED':'ECONNREFUSED')});};
  if(causeCode==='timeout')fetchImpl=async()=>{throw privateError('UND_ERR_CONNECT_TIMEOUT');};
  if(causeCode==='other')fetchImpl=async()=>{throw privateError('PRIVATE_UNBOUNDED_CODE');};
  if(causeCode==='status-5xx')fetchImpl=async()=>json(503);
  if(causeCode==='response-auth')authentication.verifyResponse=()=>{throw privateError('PRIVATE_AUTH_ERROR');};
  if(causeCode==='client-sign')authentication.request=async()=>{throw privateError('ECONNRESET');};
  const client=createSellerAgentClient({url:'https://127.0.0.1:41002',fetchImpl:(...args)=>fetchImpl(...args),authentication});
  await assert.rejects(client.commit('test'),error=>{
    assert.ok(error instanceof SellerUnavailableError);assert.equal(error.code,'seller_unavailable');assert.equal(error.message,MESSAGE);assert.equal(error.causeCode,causeCode);assert.equal(error.cause,undefined);assert.equal(JSON.stringify(error).includes('PRIVATE'),false);return true;
  });
  assert.equal(client.failureCause,causeCode);
  fetchImpl=async()=>json();authentication.request=async()=>({header:'test',payload:{}});authentication.verifyResponse=()=>{};
  assert.deepEqual(await client.commit('test'),{});assert.equal(client.failureCause,undefined,'success clears the previous cause');
  if(causeCode==='tls')for(const code of ['CERT_SIGNATURE_FAILURE','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']){
    fetchImpl=async()=>{throw new TypeError('PRIVATE wrapper',{cause:privateError(code)});};
    await assert.rejects(client.commit('test'),error=>error.causeCode==='tls'&&error.message===MESSAGE);
  }
  // Definite refusals
  // preserve their original class, text and status.
  const refused=createSellerAgentClient({url:'http://127.0.0.1:41002',fetchImpl:async()=>json(422,'{"error":"job_invalid","message":"refused"}')});
  await assert.rejects(refused.commit('test'),error=>error instanceof SellerRefusedError&&error.message==='refused'&&error.status===422);
});

for(const causeCode of ['tls','network'])test(`actual loopback ${causeCode} failure stays indeterminate in protocol status, note and ops health`,{timeout:120000},async t=>{
  const h=await startProtocolHarness();t.after(()=>h.close());
  const user=await linkedUser(h),seller=await addSeller(h,{listingId:`failure-cause-${causeCode}`});
  let endpoint;
  if(causeCode==='tls'){
    const root=await realpath(await mkdtemp(join(tmpdir(),'seller-cause-tls-')));t.after(()=>rm(root,{recursive:true,force:true}));
    const tls=createLoopbackTestTlsMaterial({temporaryRoot:root});
    let requests=0;
    const server=https.createServer(tls,(_req,res)=>{requests++;res.end('{}');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    endpoint=`https://127.0.0.1:${server.address().port}`;
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    t.after(()=>assert.equal(requests,0,'TLS rejects before a seller HTTP request'));
  }else{
    const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));endpoint=`http://127.0.0.1:${server.address().port}`;await new Promise(resolve=>server.close(resolve));
  }
  h.endpoints.set(seller.wallet.claim,endpoint);
  const p=await tool(h,user,'prepare_purchase',{listingId:seller.published.listingId,version:1,seller:seller.wallet.claim,idempotencyKey:`cause-${causeCode}`,protocol:'dacs-pay-dem'});
  assert.equal(p.status,'agreement_pending',JSON.stringify(p));
  const token=tokenFrom(p.approvalUrl),path=`/portal/api/purchase/${p.operationId}/agreement`;
  const identity=await portal(h,`${path}/identity`,{token,address:user.wallet.address});assert.equal(identity.error,undefined);
  const plan=await portal(h,`${path}/plan`,{token,signature:user.wallet.signHex(identity.signRequest.message)});assert.equal(plan.error,undefined);
  const signed=await portal(h,`${path}/sign`,{token,agreementSignature:user.wallet.signHex(plan.signRequest.agreementMessage),anchorSignature:user.wallet.signHex(plan.signRequest.anchorMessage)});
  assert.equal(signed.error,undefined,JSON.stringify(signed));
  const status=await tool(h,user,'get_purchase_status',{operationId:p.operationId});
  assert.equal(status.status,'agreement_pending');
  assert.equal(status.protocol.lastAttempt.outcome,'indeterminate');assert.equal(status.protocol.lastAttempt.causeCode,causeCode);
  // the source change's model projection keeps the plugin's cause raw in history too (an earlier review).
  assert.equal(status.history.findLast(e=>e.type==='protocol_agreement')?.data.causeCode,causeCode,JSON.stringify(status.history.at(-1)));
  const event=h.app.db.prepare("SELECT data FROM operation_events WHERE operation_id=? AND type='protocol_agreement' ORDER BY seq DESC LIMIT 1").get(p.operationId);
  const note=JSON.parse(event.data);assert.equal(note.outcome,'indeterminate');assert.equal(note.causeCode,causeCode);assert.ok(note.reason.endsWith(MESSAGE));assert.equal(JSON.stringify(note).includes('PRIVATE'),false);
  const health=opsHealth({databasePath:h.config.databasePath});assert.equal(health.purchases.find(row=>row.purchaseId===p.operationId).causeCode,causeCode);assert.ok(formatOpsHealth(health).includes(`cause=${causeCode}`));
  assert.equal(seller.state.requests.length,0);assert.equal(h.anchors.faults.writes.length,0,'failure never sends an Agreement CREATE');
});

// Exercise the native wallet Agreement path used by the operator, including
// the SDK coordinator which returns a disposition instead of throwing.
for(const kind of ['local-guard','earlier-unknown','post-fetch','guard-after-proposal'])test(`native wallet Agreement attempt: ${kind}`,{timeout:120000},async t=>{
  const { nativeEvidenceFlow } = await import('./helpers/native-payment-evidence-flow.mjs');
  const { createSourceDemoSellerTransport } = await import('../src/dacs/source-demo-seller-transport.mjs');
  const { SellerTlsUnusableError } = await import('../src/dacs/seller-http.mjs');
  let sends=0,proposalSent=false;
  const sellerTransport=createSourceDemoSellerTransport({authority:'TEST-tls-before-dispatch',authenticationFor:()=>({
    request:async(path)=>{if(kind==='guard-after-proposal'?proposalSent&&path==='/dacs/v1/agreements/state':kind!=='post-fetch')throw new SellerTlsUnusableError('seller TLS certificate expired (starts 2026-01-01T00:00:00.000Z; ends 2026-01-02T00:00:00.000Z)');return{header:'TEST',payload:{}};},verifyResponse:()=>{},
  })});
  const w=await nativeEvidenceFlow(t,{sellerTransport,fetchImpl:async(url,options)=>{
    if(new URL(url).pathname.startsWith('/dacs/v1/')){sends++;if(kind==='guard-after-proposal'){const response=await fetch(url,options);if(new URL(url).pathname==='/dacs/v1/agreements/proposals')proposalSent=true;return response;}throw Object.assign(new TypeError('PRIVATE network error',{cause:privateError('CERT_HAS_EXPIRED')}),{dispatched:false});}
    return fetch(url,options);
  }});
  assert.ok(w.op().terms.protocol.sellerTransport,'the authenticated transport is retained on native terms');
  if(kind==='earlier-unknown')w.h.app.services.ops.record(w.id,'protocol_agreement',{outcome:'indeterminate',causeCode:'network'});
  const identity=await w.api('agreement/identity',{address:w.address});
  const plan=await w.api('agreement/plan',{signature:await w.sign(identity.signRequest.message)});
  assert.equal(plan.httpStatus,200,JSON.stringify(plan));
  await w.authenticateAgreement();
  const signed=await w.api('agreement/sign',{agreementSignature:await w.sign(plan.signRequest.agreementMessage)});
  assert.equal(signed.httpStatus,200,JSON.stringify(signed));
  const attempt=w.op().state.protocol.attempts.at(-1);
  assert.equal(attempt.step,'agreement');assert.equal(attempt.outcome,'indeterminate');assert.equal(attempt.causeCode,'tls');
  if(kind==='guard-after-proposal')assert.ok(sends>0&&proposalSent,'the proposal was already dispatched within this coordination attempt');else assert.equal(sends,kind==='post-fetch'?1:0);
  const event=w.h.app.services.ops.history(w.id).filter(e=>e.type==='protocol_agreement').at(-1);
  for(const recorded of [attempt,event.data]){
    assert.equal(recorded.dispatched,['post-fetch','guard-after-proposal'].includes(kind)?undefined:false);
    assert.equal(Object.hasOwn(recorded,'written'),false,'attempt dispatch does not imply certainty for the step');
    assert.equal(JSON.stringify(recorded).includes('PRIVATE'),false);
  }
  const row=opsHealth({databasePath:w.h.config.databasePath}).purchases.find(row=>row.purchaseId===w.id);
  assert.equal(row.causeCode,'tls');
  assert.deepEqual(row.unresolvedWrites,kind==='local-guard'?[]:['agreement']);
  assert.equal(row.outcome==='unknown-readback-required',kind!=='local-guard');
  if(kind==='local-guard')assert.equal(row.outcome,'not-sent');
  assert.equal(row.lastAttemptDispatched,['post-fetch','guard-after-proposal'].includes(kind)?undefined:false);
});

test('later claim failure records a bounded cause and remains an unknown write after dispatch',{timeout:120000},async t=>{
  const { approvePurchase, reportPurchase } = await import('./helpers/flows.mjs');
  const h=await startProtocolHarness();t.after(()=>h.close());
  const buyer=await linkedUser(h),seller=await addSeller(h,{listingId:'later-claim-cause'});
  const p=await tool(h,buyer,'prepare_purchase',{listingId:seller.published.listingId,version:1,seller:seller.wallet.claim,idempotencyKey:'later-claim-cause',protocol:'dacs-pay-dem'});
  const token=tokenFrom(p.approvalUrl),path=`/portal/api/purchase/${p.operationId}/agreement/`;
  const identity=await portal(h,path+'identity',{token,address:buyer.wallet.address});
  const plan=await portal(h,path+'plan',{token,signature:buyer.wallet.signHex(identity.signRequest.message)});
  const signed=await portal(h,path+'sign',{token,agreementSignature:buyer.wallet.signHex(plan.signRequest.agreementMessage),anchorSignature:buyer.wallet.signHex(plan.signRequest.anchorMessage)});
  assert.equal(signed.error,undefined,JSON.stringify(signed));
  const {approved}=await approvePurchase(h,p.operationId,p.approvalUrl,buyer.wallet);
  assert.equal(approved.status,'payment_handoff');
  seller.state.failPaths.add('/dacs/v1/payments');
  const reported=await reportPurchase(h,p.operationId,token,{txHash:h.chain.walletBroadcast(approved.payload)});
  assert.equal(reported.status,'settled_verified');
  const attempt=reported.evidence.protocol.lastAttempt;
  assert.equal(attempt.step,'claim');assert.equal(attempt.causeCode,'status-5xx');assert.equal(attempt.dispatched,undefined);
  const event=JSON.parse(h.app.db.prepare("SELECT data FROM operation_events WHERE operation_id=? AND type='protocol_claim' ORDER BY seq DESC LIMIT 1").get(p.operationId).data);
  assert.equal(event.causeCode,'status-5xx');
  const row=opsHealth({databasePath:h.config.databasePath}).purchases.find(row=>row.purchaseId===p.operationId);
  assert.equal(row.causeCode,'status-5xx');assert.deepEqual(row.unresolvedWrites,['claim']);
  assert.equal(seller.state.requests.filter(path=>path==='/dacs/v1/payments').length,1);
});

test('trusted pre-dispatch marker is reset after success and is not accepted from an ordinary error',async()=>{
  const { SellerTlsUnusableError } = await import('../src/dacs/seller-http.mjs');
  let blocked=true;
  const client=createSellerAgentClient({url:'https://127.0.0.1:41002',authentication:{request:()=>{if(blocked)throw new SellerTlsUnusableError('seller TLS certificate expired (ends 2026-01-02T00:00:00.000Z)');return{header:'test',payload:{}};},verifyResponse:()=>{}},fetchImpl:async()=>json()});
  await assert.rejects(client.commit('test'),error=>error.name==='SellerUnavailableError'&&error.dispatched===false);
  assert.equal(client.failureDispatched,false);
  blocked=false;assert.deepEqual(await client.commit('test'),{});assert.equal(client.failureCause,undefined);assert.equal(client.failureDispatched,undefined);
});

test('real signed-peer verifier classifies unsigned 429/404/415/503 answers as response-auth',async()=>{
  const { createSellerTransportClientAuth } = await import('../src/dacs/seller-transport-auth.mjs');
  const { createEphemeralWallet } = await import('./fixtures/wallet.mjs');
  const { generateCanonicalJobId } = await import('@kynesyslabs/dacs');
  const buyer=createEphemeralWallet(),seller=createEphemeralWallet(),jobId=generateCanonicalJobId();
  const authentication=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:{listingId:'unsigned-error',version:1,contentHash:'a'.repeat(64)},agreementHash:'b'.repeat(64)})});
  for(const status of [429,404,415,503]){
    const client=createSellerAgentClient({url:'https://127.0.0.1:41002',authentication,fetchImpl:async()=>json(status,'{"error":"PRIVATE peer text"}')});
    await assert.rejects(client.commit(jobId),error=>error instanceof SellerUnavailableError&&error.causeCode==='response-auth'&&error.message===MESSAGE&&error.dispatched===undefined);
  }
});

// These errors enter the direct protocol catch sites before an HTTP client is
// constructed. Their public fields cannot authenticate the local guard marker.
for(const ErrorType of [SellerUnavailableError,SellerRefusedError])for(const phase of ['commit','claim'])test(`forged dispatch marker is not persisted: ${ErrorType.name} during ${phase}`,{timeout:120000},async t=>{
  const { nativeEvidenceFlow } = await import('./helpers/native-payment-evidence-flow.mjs');
  const { createSourceDemoSellerTransport } = await import('../src/dacs/source-demo-seller-transport.mjs');
  let blocked=false,hits=0;
  const forged=Object.assign(ErrorType===SellerUnavailableError?new SellerUnavailableError('ordinary error','tls'):new SellerRefusedError('ordinary_refusal','ordinary error',422),{dispatched:false,causeCode:'tls'});
  const sellerTransport=createSourceDemoSellerTransport({authority:'TEST-forged-dispatch-marker',authenticationFor:operation=>{
    if(blocked&&(phase==='claim'||operation.state.protocol.stage==='agreement-anchored')){hits++;throw forged;}
    return{request:async()=>({header:'TEST',payload:{}}),verifyResponse:()=>{}};
  }});
  const w=await nativeEvidenceFlow(t,{sellerTransport});
  if(phase==='commit'){
    blocked=true;await w.agreement();
  }else{
    assert.equal((await w.agreement()).status,'awaiting_approval');
    await new Promise(resolve=>setTimeout(resolve,1050));
    const {handoff}=await w.approve();assert.equal(handoff.status,'payment_handoff');
    const sent=await w.send(handoff.payload),hash=w.h.chain.record.accepted[0]?.hash??sent.data?.hash;
    blocked=true;assert.equal((await w.api('report',{txHash:hash})).status,'settled_verified');
  }
  assert.ok(hits>0,'the ordinary error reaches the direct catch');
  const step=phase==='commit'?'commit-request':'native-evidence';
  const attempt=w.op().state.protocol.attempts.filter(attempt=>attempt.step===step).at(-1);
  const event=w.h.app.services.ops.history(w.id).filter(event=>event.type===`protocol_${step}`).at(-1);
  for(const recorded of [attempt,event.data]){
    assert.equal(recorded.causeCode,'tls');assert.equal(Object.hasOwn(recorded,'dispatched'),false);
    assert.equal(Object.hasOwn(recorded,'written'),false);
  }
  const row=opsHealth({databasePath:w.h.config.databasePath}).purchases.find(row=>row.purchaseId===w.id);
  assert.equal(row.lastAttemptDispatched,undefined);
  if(ErrorType===SellerUnavailableError)assert.ok(row.unresolvedWrites.includes(step));
});
