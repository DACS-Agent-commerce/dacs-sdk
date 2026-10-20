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
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { readIssuedArtifacts } from '../src/devnet-demo/issued-readback.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';

test('foreign issued CREATE recovery preserves unknown journals and never resends',{timeout:540000},async t=>{
  const harness=await startDevnetLiveCompositionTransport({transportOptions:{timeoutMs:30000,leaseMs:60000}});t.after(()=>harness.close());
  globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${harness.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const directory=mkdtempSync(join(tmpdir(),'access-readback-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const journal=openDurableWalletJournal({path:join(directory,'artifacts.sqlite'),mode:'create'});t.after(()=>journal.close());
  let requests=0;
  const transport=createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin));
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${harness.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:transport,approve:async()=>{requests++;return true;}});t.after(()=>seller.close());
  const anchor=createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})});
  const jobId=generateCanonicalJobId(),logicalAddress=finalityCommitmentAddress(jobId);
  const artifact=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'readback-report',version:1,contentHash:'c'.repeat(64)},parties:[`did:demos:agent:${'52'.repeat(32)}`,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},
    FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:bytes=>seller.signer.signBytes(bytes)});
  const closedAccess=createOperatorBuyerAccess({custodyBuyer:`did:demos:agent:${'2'.repeat(64)}`,buyerForJob:()=>`0x${'52'.repeat(32)}`});
  const readsBeforeRefusal=harness.requests.length;
  const blocked=createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess:closedAccess});
  await assert.rejects(blocked.publish({logicalAddress,artifact,artifactKind:'FinalityCommitmentRecord'}),error=>error.code==='buyer_access_closed');
  // A missing capability refuses every non-Listing write; a caller-built one is refused at construction.
  const unguarded=createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet'});
  await assert.rejects(unguarded.publish({logicalAddress,artifact,artifactKind:'FinalityCommitmentRecord'}),error=>error.code==='buyer_access_closed');
  const duck=Object.freeze({allowsWallet:()=>true,assertWallet(){},assertRelayWallet(){},assertSellerJob(){},assertSellerWallet(){},sellerNotice:()=>null});
  assert.throws(()=>createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess:duck}),/constructed operator capability/);
  assert.equal(requests,0);assert.equal(harness.requests.length,readsBeforeRefusal);assert.equal(harness.chain.wire.record.broadcastAttempts.length,0);assert.deepEqual(await journal.entries(),[]);
  assert.equal((await anchor.publish({logicalAddress,artifact,artifactKind:'FinalityCommitmentRecord'})).status,'present');
  // A verified write's signed bytes (DACS_BUYER_CHAIN_READBACK pointers) pass the same access check as every retained read.
  assert.ok(await anchor.retainedSignedCreate({logicalAddress,artifactKind:'FinalityCommitmentRecord'}),'an admitted job gets its verified signed CREATE');
  assert.equal(await blocked.retainedSignedCreate({logicalAddress,artifactKind:'FinalityCommitmentRecord'}),null,'a job whose buyer is not admitted gets nothing');
  assert.equal(await unguarded.retainedSignedCreate({logicalAddress,artifactKind:'FinalityCommitmentRecord'}),null,'without the capability nothing is offered');
  for(const [key,value] of await harness.capability.journal.entries())if(value.signedTransaction?.content?.data?.[1]?.data?.jobId===jobId)await harness.capability.journal.put(key,{...value,stage:'broadcast-started'});
  const before=await harness.capability.journal.entries(),publicBefore=await journal.entries(),broadcasts=harness.chain.wire.record.broadcastAttempts.length,approvals=requests;
  const read=await readIssuedArtifacts({sourceCapability:harness.capability,writer:seller.signer.claim,jobId,unknownOnly:true});
  assert.equal(read.status,'readback-only');assert.ok(read.records.length);assert.ok(read.records.every(record=>record.status==='present'));
  assert.deepEqual(await harness.capability.journal.entries(),before);assert.deepEqual(await journal.entries(),publicBefore);
  assert.equal(harness.chain.wire.record.broadcastAttempts.length,broadcasts);assert.equal(requests,approvals);
  assert.equal(await readIssuedArtifacts({sourceCapability:harness.capability,writer:seller.signer.claim,jobId:generateCanonicalJobId()}),null);
  // Even a retained unknown CREATE cannot turn a missing operator capability
  // into readback authorization.
  const operation={id:'operator-retained',accountId:'owner',kind:'purchase',status:'settled_verified',terms:{buyer:{wallet:seller.signer.address},protocol:{jobId,sellerCommitment:'dacs-chatgpt-plugin/devnet-native-seller-commitment/v1'}}};
  const ops={get:()=>operation,getByHandoff:()=>operation},coordinates={get:()=>({reportedTxHash:read.records[0].hash})};
  const missing=createProtocolPurchases({ops,coordinates,dacsProtocol:{walletAgreement:{sourceCapability:harness.capability,bridgeFor:()=>{}},sellerEndpoint:()=>null}});
  const service=createPurchaseService({db:{prepare:()=>({})},config:{},ops,coordinates,protocol:missing,chain:{observeTransfer:()=>{throw new Error('unexpected read');}}});
  const readsBeforeMissing=harness.requests.length;
  const closed=error=>error.code==='buyer_access_closed';
  await assert.rejects(missing.recheck(operation),closed);
  await assert.rejects(service.protocolRecheck({operationId:operation.id,token:'retained'}),closed);
  await assert.rejects(service.verifyDeal({accountId:'owner',operationId:operation.id}),closed);
  assert.deepEqual(await harness.capability.journal.entries(),before);

  // A missing or indeterminate inclusion must also preserve the issued record.
  const tx=harness.chain.wire.record.accepted[0];tx.content.timestamp++;
  const unknown=await readIssuedArtifacts({sourceCapability:harness.capability,writer:seller.signer.claim,jobId,unknownOnly:true});
  assert.ok(unknown.records.every(record=>record.status==='indeterminate'));
  assert.deepEqual(await harness.capability.journal.entries(),before);assert.equal(harness.chain.wire.record.broadcastAttempts.length,broadcasts);
});
