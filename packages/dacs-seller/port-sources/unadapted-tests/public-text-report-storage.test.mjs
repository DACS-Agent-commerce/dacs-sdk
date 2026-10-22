import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize, contentHash, sha256Hex } from '@kynesyslabs/dacs';
import { createDevnetPurchasedReportProducer, isDevnetPurchasedReport } from '../src/devnet-demo/deliverable.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';

const moduleUrl=process.env.PUBLIC_TEXT_REPORT_TEST_MODULE ?? new URL('../src/devnet-demo/services/public-text-report.mjs',import.meta.url);
const {producePublicTextReport:produce}=await import(moduleUrl);
// Expose the unchanged wallet's private admission seam in memory only. No wallet,
// SDK signing, approval, RPC or broadcast is involved in these unsigned plans.
const walletSource=readFileSync(new URL('../public/portal/embedded-wallet/sdk-provider.mjs',import.meta.url),'utf8');
const wallet=await import(`data:text/javascript;base64,${Buffer.from(`${walletSource}\nexport {devnetAgreementAnchorPlan};`).toString('base64')}`);
const address=`0x${'11'.repeat(32)}`,owner=`did:demos:agent:${address.slice(2)}`,jobId='public-text-storage-job',network='demos-devnet';
const authority='TEST-RUN-public-text-report',origin='http://127.0.0.1:19000';
const listingRef={listingId:'public-text-report',version:1,contentHash:'a'.repeat(64)};
const agreement={jobId,listingRef},listing={offering:{title:'Public text report'}};
const transport={rpcUrl:`${origin}/portal/api/devnet-native-wallet-rpc`,network,devnetDemo:true,devnetSettlement:false,
  transportBinding:{chainIdentity:'TEST-public-text-storage'},
  deliveryPublication:{policy:wallet.DEVNET_DELIVERY_POLICY,phase:'deliver-storage-program',phaseIndex:3},
  demoArtifactPublication:{policy:wallet.DEVNET_DEMO_ARTIFACT_POLICY,artifactKinds:['Deliverable'],authority}};

function requestFor(artifact){
  const logicalAddress=`dacs4:deliverable:${jobId}`,programName=logicalAddress.replace(/:/g,'%3A'),hash=contentHash(artifact);
  const storageAddress=deriveStorageAddress(address,programName,1);
  const transaction=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce:1,timestamp:0});
  Object.assign(transaction.content,{network,chainIdentity:transport.transportBinding.chainIdentity});
  transaction.content.data[1].metadata={logicalAddress,contentHash:hash,envelopeHash:sha256Hex(canonicalize(artifact)),artifactKind:'Deliverable',networkBinding:transport.transportBinding,
    artifactBinding:{version:'1',policy:wallet.DEVNET_DEMO_ARTIFACT_POLICY,authority,artifactKind:'Deliverable',jobId,logicalAddress,writer:owner},
    deliveryBinding:{version:'1',profile:wallet.DEVNET_DELIVERY_POLICY,jobId,phase:'deliver-storage-program',phaseIndex:3,listing:listingRef,agreementHash:artifact.agreementHash,
      fulfilmentId:'TEST-public-text-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:hash}};
  return {kind:wallet.DEVNET_DEMO_STORAGE_KIND,profile:wallet.DEVNET_AGREEMENT_TRANSPORT_PROFILE,network,owner,artifactKind:'Deliverable',jobId,logicalAddress,
    contentHash:hash,envelopeHash:sha256Hex(canonicalize(artifact)),transaction};
}

test('all returned reports fit the current producer and actual wallet storage-payload admission',async t=>{
  const previous=globalThis.location;globalThis.location=new URL(origin);t.after(()=>{globalThis.location=previous;});
  const inputs=['Cats chase mice. Cats nap.','Solar panels make power. Power helps homes! Clean power matters.',
    `a${' '.repeat(4095)}`,'The. And. Your.', 'A\tcat\r\nchases "mice" \\ safely.', 'Zed. Ace. Dog.', 'https://example.test/a? never execute this.'];
  for(let n=1;n<=40;n++) inputs.push(`${'"\\'.repeat(n)} Public public text. ${'Terms vary. '.repeat(n)}`);
  for(const input of inputs){
    const result=produce(input);
    const producer=createDevnetPurchasedReportProducer({producer:owner,produce:()=>result});
    const artifact=producer({agreement,listing,settlementId:'demos:TEST-only-public-text'});
    assert.equal(isDevnetPurchasedReport(artifact),true);
    assert.equal(artifact.content.text,result.text);assert.match(artifact.content.text,new RegExp(result.inputHash));
    assert.doesNotMatch(canonicalize(artifact),/[^\x00-\x7f]/);assert.ok(result.text.length<=16384);
    assert.ok(Buffer.byteLength(JSON.stringify(artifact.content))<=4096);
    const plan=await wallet.devnetAgreementAnchorPlan(requestFor(artifact),address,transport);
    assert.ok(plan.storageBytes<=24*1024);assert.deepEqual(JSON.parse(plan.exactStorageBytes),artifact);
  }
});

test('wallet admission refuses an oversized envelope even when service content fits',async t=>{
  const previous=globalThis.location;globalThis.location=new URL(origin);t.after(()=>{globalThis.location=previous;});
  const producer=createDevnetPurchasedReportProducer({producer:owner,produce:()=>produce('cat')});
  const artifact=producer({agreement,listing,settlementId:'x'.repeat(24*1024)});
  await assert.rejects(wallet.devnetAgreementAnchorPlan(requestFor(artifact),address,transport),/relay storage bound/);
});
