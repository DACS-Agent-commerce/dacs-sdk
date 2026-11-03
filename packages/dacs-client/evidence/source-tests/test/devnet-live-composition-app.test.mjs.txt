import { formatTimeline, purchaseTimeline } from '../scripts/purchase-timeline.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { startDevnetLiveCompositionApp } from './helpers/devnet-live-composition-app.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { post } from './helpers/public-sr2-projection-flow.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { createSellerTransportClientAuth } from '../src/dacs/seller-transport-auth.mjs';

test('actual app/MCP returns the independently read genuine purchased report from seller SDK delivery-ready',{timeout:150000},async t=>{
  const h=await startDevnetLiveCompositionApp();t.after(async()=>{await h.sellerTiming.waitForIdle({timeoutMs:60000}).catch(()=>{});await h.close();});globalThis.location=new URL(h.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${h.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  let client;
  const buyerActor=await createEphemeralPackagedSeller({network:'demos-devnet',transactionTransport:createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin))});t.after(()=>buyerActor.close());
  const wallet=buyerActor.walletFactory({anchorJournal:{get:(key)=>client.anchorJournal.get(key),put:(key,value)=>client.anchorJournal.put(key,value),withWalletLock:(key,work)=>client.anchorJournal.withWalletLock(key,work)}});
  const buyer=await linkPackagedWallet(h,wallet),address=wallet.getPublicAccount().address;
  const sign=async(message)=>{const answer=await wallet.request({method:'sign',params:[message]});assert.equal(answer.success,true);return answer.data.signature;};
  h.authenticationRegistry.set(h.sellerActor.signer.claim,createSellerTransportClientAuth({buyerSigner:{claim:buyerActor.signer.claim,sign:(bytes)=>buyerActor.signer.signBytes(bytes)},seller:h.sellerActor.signer.claim,resolveJob:(jobId)=>h.jobContexts.get(jobId)}));
  const prepared=await tool(h,buyer,'prepare_purchase',{listingId:h.composition.listing.listingId,version:1,seller:h.sellerActor.signer.claim,idempotencyKey:`devnet-live-${Date.now()}`,protocol:'dacs-sr2-wallet-agreement'});
  assert.equal(prepared.status,'agreement_pending',JSON.stringify(prepared));
  const id=prepared.operationId,token=tokenFrom(prepared.approvalUrl),api=(part,body={})=>post(`${h.origin}/portal/api/purchase/${id}/${part}`,{token,...body},h.origin);
  client=createOfflineAgreementBrokerClient({id,token,api:async(path,body)=>{const answer=await post(`${h.origin}${path}`,body,h.origin);if(answer.httpStatus!==200)throw Object.assign(new Error(answer.message),{code:answer.error});return answer;}});
  const account=h.app.services.accounts.walletOwner(address),operation=()=>h.app.services.ops.get(account,id);
  const identity=await api('agreement/identity',{address}),planned=await api('agreement/plan',{signature:await sign(identity.signRequest.message)});assert.equal(planned.httpStatus,200,JSON.stringify(planned));
  h.jobContexts.set(operation().terms.protocol.jobId,{listingPin:planned.signRequest.summary.listing,agreementHash:planned.signRequest.agreementHash});
  await client.authenticate({address,sign});
  const signed=await api('agreement/sign',{agreementSignature:await sign(planned.signRequest.agreementMessage)});assert.equal(signed.httpStatus,200,JSON.stringify(signed));
  assert.equal(signed.evidence?.protocol?.stage,'agreement-signing',JSON.stringify(signed));
  assert.ok(await h.transport.capability.journal.get(`devnet-browser-agreement/create/${id}`),JSON.stringify(signed.evidence?.protocol?.lastAttempt));
  const agreementApproval=await client.approveOne(wallet);assert.equal(agreementApproval.state,'completed',JSON.stringify(agreementApproval));
  const committed=await tool(h,buyer,'verify_deal',{operationId:id});assert.equal(committed.protocol?.stage,'seller-committed',JSON.stringify(committed));
  assert.equal(operation().terms.protocol.substrate,'source-pinned-native-fixed-price-demo; finality-held');
  // Record which storage programs the app's chain reader reads, to see where the Listing comes from.
  const chainReader=h.app.services.chain,readProgram=chainReader.readStorageProgram,programReads=[];
  chainReader.readStorageProgram=(locator,...rest)=>{programReads.push(locator);return readProgram.call(chainReader,locator,...rest);};
  const listingLocator=operation().terms.listing.anchor.locator,listingReads=()=>programReads.filter(locator=>locator===listingLocator).length;
  const challenge=await api('challenge',{address});assert.equal(listingReads(),1,'the approval check reads the Listing once and may keep it for this purchase');
  const handoff=await api('approve',{challengeId:challenge.challengeId,signature:await sign(challenge.message)});assert.equal(handoff.status,'payment_handoff',JSON.stringify(handoff));
  assert.equal(listingReads(),2,'the handoff re-verification reads the Listing fresh from the chain, not the approval check\'s readback');
  chainReader.readStorageProgram=readProgram;
  // Native transaction reads at the owned source endpoint (every Agreement and commitment readback makes them).
  const txReads=()=>h.transport.requests.filter(request=>request==='getTxByHash').length,immutableReads=txReads();assert.ok(immutableReads>0);
  // The pre-approval gate may reuse this purchase's verified proofs within their short TTL.
  for(let i=0;i<2;i++)await h.app.services.protocol.recheckCommitment(operation(),{reuseVerified:true});
  assert.equal(txReads(),immutableReads,'pre-approval reuse of the verified Agreement and commitment proofs avoids repeated native reads, while gates still run');
  // The payment-path gate (the default, used at handoff) re-reads the chain every time.
  await h.app.services.protocol.recheckCommitment(operation());assert.ok(txReads()>immutableReads,'the handoff gate reads the Agreement and commitment fresh');
  // A changed Agreement readback is seen, not served from cache; the failed fresh read also evicts the reusable proof.
  h.transport.chain.faults.native=(object)=>({...object,data:{...object.data,changedAfterVerification:true}});
  await assert.rejects(h.app.services.protocol.recheckCommitment(operation()),{code:'agreement_unverified'});
  await assert.rejects(h.app.services.protocol.recheckCommitment(operation(),{reuseVerified:true}),{code:'agreement_unverified'});
  h.transport.chain.faults.native=null;
  await h.app.services.protocol.recheckCommitment(operation());
  client.useNativePaymentLane();const sent=await wallet.request({method:'sendTransaction',params:[handoff.payload]});assert.equal(sent.success,true,JSON.stringify(sent));
  const initial=await api('report',{txHash:sent.data.hash});let completed=initial.evidence;const recoveryStages=[];
  // A timed-out authenticated seller request remains an unknown in-flight
  // operation. Await only this TEST-owned job's natural release before using
  // the existing exact read-only retries; never race the live durable fence.
  await h.sellerTiming.waitForIdle({timeoutMs:60000});
  for(let attempt=0;attempt<4&&completed?.protocol?.stage!=='delivery-ready';attempt++){completed=await tool(h,buyer,'verify_deal',{operationId:id});recoveryStages.push(completed.protocol?.stage);}
  assert.equal(completed.protocol?.stage,'delivery-ready',JSON.stringify({recoveryStages,completed,sellerDeliveryState:h.composition.sellerAgent.deliveryStateOf(operation().terms.protocol.jobId)}));
  assert.equal(completed.protocol.nativeEvidence?.delivery,'delivery-ready');
  assert.equal(completed.protocol.nativeEvidence?.deliveryReadback?.disposition,'present');
  const sellerReady=h.composition.sellerAgent.deliveryStateOf(operation().terms.protocol.jobId);assert.equal(sellerReady.substrate,'source-native-one-node-delivery',JSON.stringify(sellerReady));
  const retained=await h.composition.anchor.readRetained({logicalAddress:sellerReady.logicalAddress,artifactKind:'Deliverable'});assert.equal(retained.status,'present',JSON.stringify(retained));
  const report=completed===initial.evidence?completed.protocol.delivery.report:modelReport(completed.protocol.delivery.report);assert.deepEqual(report,retained.artifact);assert.equal(report.kind,'dacs-chatgpt-plugin/devnet-purchased-report');assert.match(report.content.text,/Fresh purchased Node2 report/);assert.doesNotMatch(report.content.text,/fixture/i);
  assert.equal(h.transport.chain.record.accepted.length,1);assert.equal(h.transport.chain.wire.record.accepted.length,7);
  assert.deepEqual(h.composition.contextProvider.invocations.map(v=>v.evaluatedParty).sort(),[buyerActor.signer.claim,h.sellerActor.signer.claim].sort());
  const repeated=await tool(h,buyer,'verify_deal',{operationId:id});assert.equal(repeated.protocol?.stage,'delivery-ready');assert.deepEqual(modelReport(repeated.protocol.delivery.report),report);
  assert.equal(h.transport.chain.record.accepted.length,1);assert.equal(h.transport.chain.wire.record.accepted.length,7);
  const fixtureLog=h.logs.join('\n'),events=purchaseTimeline(fixtureLog).get(id);
  for(const step of ['page-action-received','sign','validate','broadcast','inclusion','readback-verified','stage-change'])assert.ok(events.some(event=>event.step===step),step);
  assert.ok(events.every(event=>Number.isSafeInteger(event.timestampMs)&&event.gapMs>=0));
  assert.ok(events.some(event=>event.step==='inclusion'&&Number.isSafeInteger(event.durationMs)));
  // The live server logs at info: no per-step lines there, yet the timeline script still shows every step kind.
  const infoLines=h.logs.filter(line=>JSON.parse(line).level!=='debug'),infoLog=infoLines.join('\n'),infoEvents=purchaseTimeline(infoLog).get(id);
  assert.equal(infoLines.filter(line=>JSON.parse(line).event==='purchase_step').length,0,'per-step lines are debug only');
  assert.ok(infoLines.filter(line=>JSON.parse(line).event==='purchase_timeline').length<=events.filter(event=>event.step==='stage-change').length+1,'about one info line per stage');
  for(const step of ['page-action-received','sign','validate','broadcast','inclusion','readback-verified','stage-change'])assert.ok(infoEvents.some(event=>event.step===step),`info ${step}`);
  assert.equal(events.length,h.logs.filter(line=>{const entry=JSON.parse(line);return entry.event==='purchase_step'&&entry.purchaseId===id;}).length,'each step counted once at debug');
  const timelineDirectory=mkdtempSync(join(tmpdir(),'purchase-timeline-'));t.after(()=>rmSync(timelineDirectory,{recursive:true,force:true}));
  const fixtureLogPath=join(timelineDirectory,'server.log');writeFileSync(fixtureLogPath,fixtureLog);
  const output=execFileSync(process.execPath,['scripts/purchase-timeline.mjs',fixtureLogPath],{encoding:'utf8'});
  assert.equal(output,`${formatTimeline(fixtureLog)}\n`);assert.match(output,/duration ms \| gap ms/);assert.ok(output.includes(id));
  t.diagnostic(JSON.stringify({steps:events.length,infoTimelineLines:infoLines.filter(line=>JSON.parse(line).event==='purchase_timeline').length,stage:completed.protocol.stage,initialStage:initial.evidence.protocol.stage,recoveryStages,creates:7,payments:1,repeatCreates:0,partyVet:2,reportKind:report.kind,fixtureFallback:false,markerRequired:false,finality:'not-established'}));
});
