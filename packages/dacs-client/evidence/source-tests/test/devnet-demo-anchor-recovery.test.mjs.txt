import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, finalityCommitmentAddress, generateCanonicalJobId, signComponentArtifact, FINALITY_COMMITMENT_SEPARATOR } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

// Live Node2 includes a CREATE a block after accepting it. While the publisher
// still holds the artifact key and its wallet waits for that inclusion, the app
// may independently read the same commitment. That read must report the CREATE
// as still being issued, never throw on the publisher's lock or write over it.
test('a concurrent retained read during the publisher inclusion wait is indeterminate, then present after; one CREATE',{timeout:120000},async t=>{
  const harness=await startDevnetLiveCompositionTransport({pendingStatusPolls:4,transportOptions:{inclusionPollMs:150}});t.after(()=>harness.close());
  globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${harness.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const directory=mkdtempSync(join(tmpdir(),'demo-anchor-race-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const journal=openDurableWalletJournal({path:join(directory,'seller-artifacts.sqlite'),mode:'create'});t.after(()=>journal.close());
  const approvals=[],transport=createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin));
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${harness.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:transport,approve:async(request)=>{approvals.push(structuredClone(request));return true;}});t.after(()=>seller.close());
  const anchor=createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})});
  const jobId=generateCanonicalJobId(),logicalAddress=finalityCommitmentAddress(jobId),buyer=`did:demos:agent:${'52'.repeat(32)}`;
  const commitment=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'race-report',version:1,contentHash:'c'.repeat(64)},parties:[buyer,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},
    FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)});
  const publishing=anchor.publish({logicalAddress,artifact:commitment,artifactKind:'FinalityCommitmentRecord'});
  const issued=async()=>(await harness.capability.journal.entries()).some(([,value])=>value?.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===logicalAddress);
  for(let i=0;i<400&&!(await issued());i++)await new Promise((resolve)=>setTimeout(resolve,10));
  assert.equal(await issued(),true,'the CREATE reached the transport journal while the publisher still waits');
  const during=await anchor.readRetained({logicalAddress,artifactKind:'FinalityCommitmentRecord'});
  assert.equal(during.status,'indeterminate',JSON.stringify(during));assert.match(during.reason,/still being issued/);assert.equal(during.noResend,true);
  const published=await publishing;assert.equal(published.status,'present',JSON.stringify(published));
  const after=await anchor.readRetained({logicalAddress,artifactKind:'FinalityCommitmentRecord'});assert.equal(after.status,'present');assert.equal(contentHash(after.artifact),contentHash(commitment));
  assert.equal(harness.chain.wire.record.accepted.length,1);assert.equal(approvals.length,1);
});

// A crash after the packaged wallet broadcast, before it recorded the answer,
// leaves its own nonce lane at broadcast-started. The next seller CREATE must
// release it only from a fresh authenticated readback of that exact original
// CREATE; a lane whose signed bytes differ stays fenced and nothing is resent.
test('an interrupted wallet anchor lane is released only by authenticated readback of its exact CREATE; tampered lanes stay fenced',{timeout:120000},async t=>{
  const harness=await startDevnetLiveCompositionTransport();t.after(()=>harness.close());
  globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${harness.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const directory=mkdtempSync(join(tmpdir(),'demo-anchor-lane-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const journal=openDurableWalletJournal({path:join(directory,'seller-artifacts.sqlite'),mode:'create'});t.after(()=>journal.close());
  const approvals=[],transport=createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin));
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${harness.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:transport,approve:async(request)=>{approvals.push(structuredClone(request));return true;}});t.after(()=>seller.close());
  const anchor=createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})});
  const commit=async()=>{const jobId=generateCanonicalJobId();const artifact=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'lane-report',version:1,contentHash:'c'.repeat(64)},parties:[`did:demos:agent:${'52'.repeat(32)}`,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},
    FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)});return anchor.publish({logicalAddress:finalityCommitmentAddress(jobId),artifact,artifactKind:'FinalityCommitmentRecord'});};
  const lane=async()=>{const rows=(await journal.entries()).filter(([key])=>key.startsWith('demo/wallet/'));assert.equal(rows.length,1);return rows[0];};
  assert.equal((await commit()).status,'present');
  const [key,first]=await lane();assert.equal(first.stage,'broadcast-accepted');
  await journal.put(key,{...first,stage:'broadcast-started'});
  const second=await commit();assert.equal(second.status,'present',JSON.stringify(second));
  assert.equal(harness.chain.wire.record.accepted.length,2,'the interrupted CREATE is never resent');assert.equal(approvals.length,2);
  const [,released]=await lane();assert.equal(released.stage,'broadcast-accepted');assert.notEqual(released.hash,first.hash);
  const tampered=structuredClone(released);tampered.stage='broadcast-started';tampered.signedTransaction.content.timestamp+=1;
  await journal.put(key,tampered);
  await assert.rejects(commit(),/differs from its original public projection/);
  assert.equal(harness.chain.wire.record.accepted.length,2);assert.equal(approvals.length,2);assert.equal((await lane())[1].stage,'broadcast-started');
});
