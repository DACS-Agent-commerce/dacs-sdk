import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_SEPARATORS, FINALITY_COMMITMENT_SEPARATOR, signComponentArtifact, contentHash } from '@kynesyslabs/dacs';
import { assertQualifiedDeployment, QUALIFIED_NODE_COMMITS } from '../src/devnet-demo/deployment-qualification.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { classifyStorageWriteSubmission, storageWriteAbsent, storageWriteAccountNonce, storageWriteConfirmationMatches, storageWriteIdentityMatches, storageWriteRpcSigner } from '../src/devnet-demo/storage-write-recovery.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { seller, buyer, JOB, NOW } from './helpers/protocol-fixture.mjs';
const pin = { dirty: false, commit: QUALIFIED_NODE_COMMITS[0], artifactSha256: 'a'.repeat(64), qualifiedOperations: ['fee','nonce','broadcast','confirmation'] };
const rpc = (result, response, extra = null) => ({ result, response, extra, require_reply: false });

test('qualified deployment requires exact operation list, artifact and verifier', async () => {
  await assertQualifiedDeployment({ pins: { deployment: pin }, verifyDeployment: async value => { assert.deepEqual(value, pin); return true; } });
  for (const qualifiedOperations of ['not-fee not-nonce not-broadcast not-confirmation', {}, ['fee','nonce','broadcast'], null]) await assert.rejects(assertQualifiedDeployment({ pins: { deployment: { ...pin, qualifiedOperations } }, verifyDeployment: async () => true }), e => e.code === 'deployment_unqualified');
  for (const change of [{ dirty: true }, { artifactSha256: 'bad' }, { commit: 'b'.repeat(40) }]) await assert.rejects(assertQualifiedDeployment({ pins: { deployment: { ...pin, ...change } }, verifyDeployment: async () => true }), e => e.code === 'deployment_unqualified');
  await assert.rejects(assertQualifiedDeployment({ pins: { deployment: pin }, verifyDeployment: async () => false }));
});
test('factory refuses an unconstructed capability before injected effects', () => {
  let calls=0; const effect=()=>{calls++;throw new Error('TEST effect');};
  const input={sourceCapability:{readRpc:effect,journal:{entries:effect}},journal:{get:effect,put:effect,entries:effect,withWalletLock:effect},walletFactory:effect};
  assert.throws(()=>createDevnetDemoArtifactAnchor(input),/explicit devnet demo source capability/);assert.equal(calls,0);
});
test('Listing publication validates real signature bytes and exact expected signer', async () => {
  const { artifactValid } = await privateModule(new URL('../src/devnet-demo/artifact-anchor.mjs', import.meta.url), ['artifactValid']);
  const listing = fixtureListing(seller, { now: NOW }); assert.equal(artifactValid('Listing', listing, seller.claim), true);
  const bad = structuredClone(listing); bad.signature.value = Buffer.alloc(64).toString('base64url'); assert.equal(artifactValid('Listing', bad, seller.claim), false);
  const changed = structuredClone(listing); changed.offering.title = 'TEST changed'; assert.equal(artifactValid('Listing', changed, seller.claim), false);
});
test('commitment signer is the authenticated orchestrator independent of storage writer', async () => {
  const { artifactValid } = await privateModule(new URL('../src/devnet-demo/artifact-anchor.mjs', import.meta.url), ['artifactValid']);
  const listing = fixtureListing(seller, { now: NOW });
  const unsigned = { finalityCommitmentVersion: '1', jobId: JOB, agreementHash: 'a'.repeat(64), listingRef: { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) }, parties: [buyer.claim, seller.claim], pattern: 'fixed-price', createdAt: NOW };
  const record = await signComponentArtifact(unsigned, FINALITY_COMMITMENT_SEPARATOR, { signer: buyer.claim, algorithm: 'ed25519', sign: buyer.signBytes });
  assert.equal(artifactValid('FinalityCommitmentRecord', record, seller.claim, buyer.claim), true);
  assert.equal(artifactValid('FinalityCommitmentRecord', record, seller.claim, seller.claim), false);
  const bad = structuredClone(record); bad.signature.value = Buffer.alloc(64).toString('base64url'); assert.equal(artifactValid('FinalityCommitmentRecord', bad, seller.claim, buyer.claim), false);
});
test('unsigned recovery checks exact scope and both retained signed journals', async () => {
  const { publicationSnapshot } = await privateModule(new URL('../src/devnet-demo/artifact-anchor.mjs', import.meta.url), ['publicationSnapshot']);
  const unsignedIntent=(address,row,source,wallet)=>publicationSnapshot(source,wallet).classify(address,row)==='unsigned';
  const address = `dacs4:deliverable:${JOB}`, transaction = { content: { from: seller.address, data: ['storageProgram', { metadata: { logicalAddress: address } }] } };
  const row = { stage: 'intent', transaction };
  assert.equal(unsignedIntent(address, row, [], []), true);
  assert.equal(unsignedIntent(address, { ...row, stage: 'closing', error: 'operator_closing' }, [], []), true);
  for (const change of [{ hash: undefined }, { signedTransaction: undefined }, { stage: 'closing' }, { stage: 'observed' }]) assert.equal(unsignedIntent(address, { ...row, ...change }, [], []), false);
  const signed = ['TEST', { signedTransaction: transaction }];
  assert.equal(unsignedIntent(address, row, [signed], []), false);
  assert.equal(unsignedIntent(address, row, [], [['demo/wallet/TEST', signed[1]]]), false);
  assert.equal(unsignedIntent(address + 'x', row, [], []), false);
});
test('storage submission requires exact hash or positively accepted validator relay', () => {
  const hash = 'a'.repeat(64); assert.equal(classifyStorageWriteSubmission(rpc(200,{ hash }),hash),'accepted');
  assert.equal(classifyStorageWriteSubmission(rpc(200,{ message: 'Transaction relayed to validators' },{ confirmationBlock: 1 }),hash),'accepted');
  for (const value of [rpc(200,null),rpc(200,{ hash, success: false }),rpc(200,{ hash:'b'.repeat(64) }),rpc(200,{ hash, error:'TEST' }),rpc(200,{ message:'Transaction relayed to validators' },{ confirmationBlock:-1 })]) assert.equal(classifyStorageWriteSubmission(value,hash),'unknown');
});
test('storage absence, nonce and confirmation projections fail closed', async () => {
  assert.equal(storageWriteAbsent(rpc(200,{ state:'unknown' },''),rpc(400,'error')),true); assert.equal(storageWriteAbsent(rpc(404,null),rpc(404,null)),false);
  assert.equal(storageWriteAccountNonce('0'),0); for (const value of ['00',-1,{},1.5,Number.MAX_SAFE_INTEGER+1]) assert.equal(storageWriteAccountNonce(value),null);
  const transaction = { content:{ TEST:'transaction' } }, value = { data:{ valid:true,reference_block:0,message:'TEST',gas_operation:null,transaction },signature:{ type:'ed25519',data:`0x${'a'.repeat(128)}` },rpc_public_key:{ type:'ed25519',data:`0x${'a'.repeat(64)}` } };
  assert.equal(storageWriteConfirmationMatches(value),true); assert.equal(storageWriteConfirmationMatches({ ...value, extra:true }),false);
  assert.equal(storageWriteIdentityMatches({ number:0,status:'confirmed',hash:'a'.repeat(64) }),true); assert.equal(storageWriteIdentityMatches({ number:0 }),false);
  assert.equal(storageWriteRpcSigner({ claim: buyer.claim, sign: buyer.signBytes },seller.claim),null);
  assert.equal(typeof await storageWriteRpcSigner({ claim:seller.claim,sign:seller.signBytes },seller.claim)('TEST exact RPC bytes'),'string');
});
test('artifact validation shares the bounded purchased-report predicate', async () => {
  const { artifactValid } = await privateModule(new URL('../src/devnet-demo/artifact-anchor.mjs', import.meta.url), ['artifactValid']);
  const report = { reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:JOB,agreementHash:'a'.repeat(64),listing:{listingId:'TEST',version:1,contentHash:'b'.repeat(64)},title:'TEST',settlementId:'TEST',producer:seller.claim,content:{mediaType:'text/plain; charset=utf-8',text:'TEST'} };
  assert.equal(artifactValid('Deliverable',report,seller.claim),true);
  for(const text of ['TEST\u0000','😀'.repeat(4097)]) assert.equal(artifactValid('Deliverable',{...report,content:{...report.content,text}},seller.claim),false);
});
test('Vet artifact signature verifies against the expected counterparty', async () => {
  const { artifactValid } = await privateModule(new URL('../src/devnet-demo/artifact-anchor.mjs', import.meta.url), ['artifactValid']);
  const unsigned = { recordVersion:'1',jobId:JOB,evaluatedParty:buyer.claim,bundleHash:'a'.repeat(64),requirementHash:'b'.repeat(64),freshness:[],supplementary:[],dealSpecific:[],overallDecision:'pass',generatedAt:NOW };
  const record = await signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.CompositeVerificationRecord, {signer:seller.claim,algorithm:'ed25519',sign:seller.signBytes});
  assert.equal(artifactValid('CompositeVerificationRecord',record,seller.claim,seller.claim),true);
  assert.equal(artifactValid('CompositeVerificationRecord',record,seller.claim,buyer.claim),false);
  record.signature.value=Buffer.alloc(64).toString('base64url');assert.equal(artifactValid('CompositeVerificationRecord',record,seller.claim,seller.claim),false);
});
