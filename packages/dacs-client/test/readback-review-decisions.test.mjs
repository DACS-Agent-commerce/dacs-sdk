// Isolate the retained readers and coordinator from transport and handshake.
// Fakes provide data at those boundaries; all decisions and durable writes are real.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, contentHash, demosSignedTransactionProofHash, finalityCommitmentAddress, fixedPriceAgreementLogicalAddress, logicalToStorageProgramName, paymentEvidenceAddress, sha256Hex } from '@kynesyslabs/dacs';
import { openDatabase, transaction, isUniqueViolation } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
const store={transaction,isUniqueViolation},buyerAccess={assertWallet(){}};
const state=globalThis[Symbol.for('d15.review.readers')]={};
// Loader modules run in a separate thread; returned fakes execute in this test's realm.
register(new URL('./helpers/readback-review-loader.mjs', import.meta.url), import.meta.url);
const { DemosSr2Error, demosSr2Contradiction }=await import('../src/dacs/demos-sr2-adapter.mjs?actual');
const { createBuyerChainReadback }=await import('../src/dacs/buyer-chain-readback.mjs');
const { createSellerSr2AgreementAnchor }=await import('../src/dacs/seller-sr2-agreement-consumer.mjs');
const { nativeAgreementPaymentConfig, NATIVE_AGREEMENT_PAYMENT }=await import('../src/dacs/native-agreement-payment-consumer.mjs');
const { createNativePaymentEvidenceConsumer, nativeEvidenceReadOutcome, NATIVE_PAYMENT_EVIDENCE }=await import('../src/dacs/native-payment-evidence-consumer.mjs');
const { createNativeDemDeliveryCapability }=await import('../src/dacs/native-dem-delivery-consumer.mjs');
const { readDemDeliveryReady }=await import('../src/dacs/dem-delivery-consumer.mjs');
const { createDevnetSettlementTransport, DEVNET_SETTLEMENT_POLICY }=await import('../src/wallet/devnet-native-transport.mjs');
const { createDevnetNativeCommitmentCapability, DEVNET_NATIVE_COMMITMENT_MARKER }=await import('../src/devnet-demo/commitment-consumer.mjs');
const { createProtocolPurchases, protocolStageHelp }=await import('../src/dacs/protocol-purchases.mjs');
const CHAIN='f'.repeat(64),BUYER='0x'+'e'.repeat(64),SELLER='did:demos:agent:'+'a'.repeat(64),JOB='01HZY3K8V9Q2W4E6R7T8Y9X0AB';
const journal={get:async()=>null,put:async()=>{throw Error('not used');},entries:async()=>[],withWalletLock:(_k,work)=>work()};
const sourceCapability=createDevnetSettlementTransport({settlementPublication:{policy:DEVNET_SETTLEMENT_POLICY,artifactKind:'SettlementEvidence',phase:'pay-dem',railId:'demos-native:DEM',phaseIndex:2,authority:'TEST-review'},expected:{network:'testnet',chainIdentity:CHAIN,pinVersion:'TEST-1',endpoint:'https://rpc.invalid/',transportAuthority:'TEST-owner'},transportOwner:{getContext(){throw Error('offline');},acquireConnectionFence(){throw Error('offline');}},journal});
const authority='TEST-RUN-review0000';
const commitment=createDevnetNativeCommitmentCapability({authority,anchor:{authority,readRetained(){throw Error('not used');},verifyReceipt(){throw Error('not used');}}});
const listing={listingId:'TEST',listingVersion:1,seller:{identity:{presentedBy:SELLER}},offering:{title:'TEST'}};
const pin={listingId:'TEST',version:1,contentHash:contentHash(listing)};
const agreement={jobId:JOB,parties:[{role:'buyer',primaryClaim:'did:demos:agent:'+'e'.repeat(64)},{role:'seller',primaryClaim:SELLER}],listingRef:pin,
  terms:{price:{amount:'2.5',currency:'DEM'},deadline:Date.now()+3600000,payoutBindings:[{payeeAddress:SELLER,phaseIndex:2,railId:'demos-native:DEM'}]}};
const agreementHash=contentHash(agreement),logicalAddress=fixedPriceAgreementLogicalAddress(JOB);
const approvedContent={from:BUYER,to:'stor-test',data:['storageProgram',{metadata:{logicalAddress,artifactKind:'Agreement'}}]};
const txHash=sha256Hex(JSON.stringify(approvedContent));
const approvedProjection={hash:txHash,content:approvedContent,signature:{type:'ed25519',data:'00'}};
const proof={proofVersion:'1',chainIdentity:CHAIN,writer:BUYER,operation:'create',signedTransactionHash:demosSignedTransactionProofHash(approvedProjection),finalityProofHash:CHAIN,nativeRead:{programName:logicalToStorageProgramName(logicalAddress),valueHash:CHAIN,observedAt:1}};
const receipt={receiptVersion:'1',substrate:'demos',finalityProfile:'demos-bft-confirmed-native-read',logicalAddress,contentHash:agreementHash,nativeAddress:'stor-test',transactionRef:{kind:'demos-storage-program',value:txHash},writer:'did:demos:agent:'+'e'.repeat(64),nonce:'1',state:'finalized',observationDisposition:'established',observedAt:1,blockRef:{id:CHAIN,height:'1',timestamp:1},evidence:{kind:'demos-bft-write-proof-v1',value:Buffer.from(canonicalize(proof)).toString('base64url')}};
journal.entries=async()=>[['sr2/adapter/TEST',{stage:'verified',authorizationProfile:'embedded-storage-anchor-create',logicalAddress,writer:receipt.writer,transactionHash:txHash,hash:agreementHash,authorizedTransaction:approvedProjection}]];
const walletConfig={sourceCapability,rpcUrl:sourceCapability.pins.endpoint,journal,bridgeFor:()=>({})};
const anchorRequest={logicalAddress,writer:'did:demos:agent:'+'e'.repeat(64),agreementHash,receipt};
const errors=[['adapter invalid',()=>new DemosSr2Error('invalid','unverified node bytes')],['foreign invalid',()=>Object.assign(Error('unverified node bytes'),{code:'invalid'})],['permanent',()=>Object.assign(Error('unverified node bytes'),{code:'conflict'})],['unavailable',()=>Error('unavailable')],['marked contradiction',()=>demosSr2Contradiction('authenticated different record')]];
const marked=label=>label==='marked contradiction';
for(const [label,error] of errors)for(const method of ['readAgreement','recheckAgreement'])test(`${method}: ${label}`,async()=>{
 const reader=createSellerSr2AgreementAnchor({reader:{read:async()=>{throw error();},recheck:async()=>{throw error();},verifyReceipt:async()=> 'valid'}});
 const result=await reader[method](anchorRequest);
 assert.equal(result.disposition,marked(label)?'rejected':'indeterminate');
 assert.equal(result.authenticated===true,marked(label));
});
for(const cache of [false,true])for(const [label,error] of errors)test(`payment gate carries ${label} classification, cache ${cache}`,async()=>{
 state.adapter={read:async()=>{throw error();},recheck:async()=>{throw error();},verifyReceipt:async()=> 'valid'};
 const payment=nativeAgreementPaymentConfig(sourceCapability,{walletConfig,sellerSr2Commitment:commitment,coordinates:{},now:Date.now,...(cache?{readbackCache:{read:async(_key,_read,check)=>check({native:{receipt}})}}:{})});
 const op={id:'TEST-gate',terms:{buyer:{wallet:BUYER},protocol:{}},state:{protocol:{agreement:{artifact:agreement,hash:agreementHash,ref:{anchor:{locator:logicalAddress}},anchorReceipt:receipt}}}};
 await assert.rejects(payment.verifyAgreement(op),error=>{
   assert.equal(error.readbackDisposition,marked(label)?'rejected':'indeterminate');
   assert.equal(error.readbackAuthenticated===true,marked(label));return true;
 });
});
for(const [label,error] of errors)test(`payment evidence: ${label}`,async()=>{
 state.adapter={read:async()=>{throw error();},verifyReceipt:async()=> 'valid'};
 const evidence=createNativePaymentEvidenceConsumer({rpcUrl:sourceCapability.pins.endpoint,sourceCapability});
 const result=await evidence.readEvidence({agreement,writer:SELLER,txHash,blockNumber:10,committedAt:1,signedProjection:{hash:txHash}});
 assert.equal(result.disposition,marked(label)?'rejected':'indeterminate');
 assert.equal(result.authenticated===true,marked(label));
});
for(const status of ['invalid','rejected','unknown'])test(`unmarked ${status} evidence result is indeterminate`,()=>{
 assert.equal(nativeEvidenceReadOutcome({status}).disposition,'indeterminate');
});
const nativeDelivery=createNativeDemDeliveryCapability({authority:'TEST-review',submit(){},reconcile(){},read(){},verifyReceipt(){}});
const report={reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:JOB,agreementHash,listing:pin,title:'TEST',settlementId:'TEST-settlement',producer:SELLER,content:{mediaType:'text/plain; charset=utf-8',text:'TEST'}};
const deliverableReceipt={receiptVersion:'1',substrate:'TEST',finalityProfile:'TEST',logicalAddress:'dacs4:deliverable:'+JOB,nativeAddress:'stor-test',contentHash:contentHash(report),writer:SELLER,nonce:1,state:'included',observationDisposition:'included',transactionRef:{value:txHash},blockRef:{timestamp:10}};
const delivery={status:'delivered',logicalAddress:'dacs4:deliverable:'+JOB,contentHash:contentHash(report),evidenceHash:'d'.repeat(64),fulfilmentId:'TEST',anchorReceipt:deliverableReceipt};
for(const [label,error] of errors)test(`delivery evidence: ${label}`,async()=>{
 const result=await readDemDeliveryReady({nativeDemDelivery:nativeDelivery,agreement,listing,seller:SELLER,answer:{settlementId:'TEST-settlement',delivery},chainReadback:{readDeliverable:async()=>({status:'present',artifact:report,receipt:deliverableReceipt}),readDeliveryEvidence:async()=>{throw error();}}});
 assert.equal(result.disposition,'present');
 assert.equal(result.delivery.evidenceHold.status,marked(label)?'rejected':'pending');
 assert.equal(result.evidenceAuthenticated===true,marked(label));
});
function coordinator(t, { status='settled_verified', stage='delivered', retainedDelivery=status==='settled_verified', protocolPatch={} }={}) {
 const dir=mkdtempSync(join(tmpdir(),'d15-decisions-')),db=openDatabase(join(dir,'state.sqlite'));
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const ops=createOperationStore({db,handoffSecret:'TEST-only-d15-review-secret-000000000'});
 db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer','TEST','TEST-buyer',new Date().toISOString());
 const terms={buyer:{wallet:BUYER},seller:{payee:SELLER,claim:SELLER},price:{amountOs:'2500000000'},listing:pin,network:'testnet',rail:'demos-native:DEM',domain:{mode:'public-chain-read',chainIdentity:CHAIN},protocol:{transportBinding:sourceCapability.transportBinding,jobId:JOB,profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',sellerAgent:'https://seller.invalid',sellerCommitment:DEVNET_NATIVE_COMMITMENT_MARKER,sellerAgreementProjection:'public-signed-create',nativePayment:NATIVE_AGREEMENT_PAYMENT,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE}};
 const protocol={stage,signatures:{agreement:'TEST-signature'},planned:{plan:{agreementHash},anchorAddress:logicalAddress},listing,agreement:{artifact:agreement,hash:agreementHash,ref:{anchor:{locator:logicalAddress}},anchorReceipt:receipt,signedProjection:{hash:txHash}},
   ...(retainedDelivery?{delivery:{...delivery,report},nativeEvidence:{status:'verified'},paymentEvidence:{ref:{contentHash:'d'.repeat(64)}}}:{}),...protocolPatch};
 const op=ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:'TEST',request:{},status,terms,termsHash:CHAIN,state:{protocol},expiresAt:new Date(Date.now()+3600000).toISOString()}).operation;
 const nativeEvidence=createNativePaymentEvidenceConsumer({rpcUrl:sourceCapability.pins.endpoint,sourceCapability});
 const service=createProtocolPurchases({db,ops,coordinates:{unresolvedForSender:()=>[]},dacsProtocol:{walletAgreement:walletConfig,nativeSellerCommitment:commitment,nativeAgreementPayment:sourceCapability,nativePaymentEvidence:nativeEvidence,sellerEndpoint:()=> 'https://seller.invalid'},store,buyerAccess});
 return {op,ops,service};
}
test('host chain-readback bookkeeping keeps its source and records a repeated hold once', t => {
 const {op,ops,service}=coordinator(t);
 const held=service.holdChainReadback(op,'TEST-host-retired-key');
 assert.equal(held.state.protocol.chainReadbackHeld.source,'host-supplied');
 assert.equal(held.state.protocol.chainReadbackHeld.reason,'TEST-host-retired-key');
 assert.equal(service.holdChainReadback(op,'TEST-repeat').state.protocol.chainReadbackHeld.reason,'TEST-host-retired-key');
 const events=ops.history(op.id).filter(event=>event.type==='protocol_chain_readback_held');
 assert.equal(events.length,1);
 assert.equal(events[0].data.source,'host-supplied');
 assert.equal(held.status,'settled_verified');
});
for(const [label,error] of errors)test(`delivered purchase recheck: ${label}`,async t=>{
 state.adapter={read:async()=>{throw error();},verifyReceipt:async()=> 'valid'};
 state.seller={origin:'https://seller.invalid'};
 const {op,ops,service}=coordinator(t);
 const coords={verifiedAt:'TEST',reportedTxHash:txHash,observation:{observation:{blockNumber:10}}};
 const result=await service.recheck(op,coords),stored=ops.get(op.accountId,op.id);
 assert.equal(result.status,'settled_verified');
 if(marked(label)){assert.equal(stored.state.protocol.delivery,null);assert.equal(stored.state.protocol.stage,'payment-evidenced');}
 else {assert.deepEqual(stored.state.protocol.delivery,op.state.protocol.delivery);assert.deepEqual(stored.state.protocol.paymentEvidence,op.state.protocol.paymentEvidence);assert.equal(stored.state.protocol.stage,'delivered');}
});
test('malformed seller CREATE pointer cannot terminate the purchase',async t=>{
 let reads=0;state.adapter={read:async()=>{reads++;throw Error('must not read');},verifyReceipt:async()=> 'valid'};
 const address=finalityCommitmentAddress(JOB);
 state.seller={origin:'https://seller.invalid',commit:async()=>({publicSignedCreates:{[address]:{hash:'b'.repeat(64),content:{from:BUYER,data:['storageProgram',{metadata:{logicalAddress:address,artifactKind:'FinalityCommitmentRecord'}}]},signature:{type:'ed25519',data:'00'}}}})};
 state.anchored={disposition:'anchored',result:{agreement,agreementHash,agreementRef:{anchor:{locator:logicalAddress}},anchorReceipt:receipt}};
 const {op,ops,service}=coordinator(t,{status:'agreement_pending',stage:'agreement-anchored'});
 const result=await service.submitAgreement(op);
 assert.equal(reads,0);
 assert.equal(result.status,'agreement_pending');
 assert.equal(ops.get(op.accountId,op.id).status,'agreement_pending');
 assert.equal(result.state.protocol.stage,'agreement-anchored');
 const attempt=ops.history(op.id).findLast(e=>e.type==='protocol_commitment');
 assert.equal(attempt.data.outcome,'indeterminate');
 assert.match(attempt.data.sellerAnswerDiagnostic,/Listing seller/,JSON.stringify(attempt));
});

for(const [label,verifyReceipt] of [['unmarked error',async()=>{throw new DemosSr2Error('invalid','unverified proof');}],['unknown verdict',async()=> 'unknown'],['marked contradiction',async()=>{throw demosSr2Contradiction('different authenticated proof');}]])test(`buyer receipt verification: ${label}`,async()=>{
 const address='dacs4:evidence:'+JOB,artifact={TEST:'evidence'};
 const signedProjection={hash:txHash,content:{from:'0x'+'a'.repeat(64),to:'stor-test',data:['storageProgram',{metadata:{logicalAddress:address,artifactKind:'SettlementEvidence'}}]},signature:{type:'ed25519',data:'00'}};
 const reader={read:async()=>({status:'present',artifact,artifactKind:'SettlementEvidence',receipt:{writer:SELLER,logicalAddress:address,contentHash:contentHash(artifact),transactionRef:{value:txHash},nativeAddress:'stor-test'}}),verifyReceipt};
 const chain=createBuyerChainReadback({sourceCapability,reader});
 const result=await chain.readDeliveryEvidence({agreement,listing,seller:SELLER,signedProjection});
 assert.equal(result.status,marked(label)?'rejected':'indeterminate');assert.equal(result.authenticated===true,marked(label));
});

// Fresh transfer responses have one-node authority only. Signature verification
// is faked at the SDK boundary here; receipt, tuple and coordinator decisions run.
const transferTime=Date.now(), evidenceAddress=paymentEvidenceAddress(JOB,'demos-native:DEM',2);
const paymentArtifact={jobId:JOB,phase:'pay-dem',outcome:'success',paymentTxRefs:[{kind:'demos',txHash,blockNumber:10}],paymentAmount:{amount:'2.5',currency:'DEM'},settlementFinality:{model:'bft-final',finalityObservedAt:transferTime},observedAt:transferTime,signature:{signer:SELLER}};
const paymentProjection={hash:'c'.repeat(64),content:{from:'0x'+'a'.repeat(64),to:'stor-evidence',data:['storageProgram',{metadata:{logicalAddress:evidenceAddress,artifactKind:'SettlementEvidence'}}]},signature:{type:'ed25519',data:'00'}};
const transfer=()=>({status:'included',txHash,blockNumber:10,payer:'e'.repeat(64),payee:'a'.repeat(64),amountOs:'2500000000',includedAt:transferTime});
function paymentReader(artifact=paymentArtifact){
 state.adapter={read:async address=>address===logicalAddress?{status:'present',artifact:agreement,artifactKind:'Agreement',receipt}:{status:'present',artifact,artifactKind:'SettlementEvidence',receipt:{logicalAddress:evidenceAddress,writer:SELLER,contentHash:contentHash(artifact),nativeAddress:'stor-evidence',transactionRef:{value:'c'.repeat(64)}}},recheck:async()=>({status:'present'}),verifyReceipt:async()=> 'valid'};
 return createNativePaymentEvidenceConsumer({rpcUrl:sourceCapability.pins.endpoint,sourceCapability});
}
const paymentRequest=()=>({agreement,writer:SELLER,txHash,blockNumber:10,committedAt:transferTime-1000,signedProjection:paymentProjection});
const freshChanges=[['time',{includedAt:transferTime+1000}],['transaction',{txHash:'b'.repeat(64)}],['block',{blockNumber:11}],['payer',{payer:'a'.repeat(64)}],['payee',{payee:'e'.repeat(64)}],['amount',{amountOs:'1'}]];
for(const [label,change] of freshChanges){
 test(`fresh transfer ${label} mismatch is indeterminate`,async()=>{
  state.observeTransfer=async()=>({...transfer(),...change});
  const result=await paymentReader().readEvidence(paymentRequest());
  assert.equal(result.disposition,'indeterminate');assert.notEqual(result.authenticated,true);
 });
 for(const holding of [false,true])test(`fresh transfer ${label} mismatch: ${holding?'preserve delivery':'first read stays held'}`,async t=>{
  state.observeTransfer=async()=>({...transfer(),...change});paymentReader();
  state.seller={origin:'https://seller.invalid',submitPayment:async()=>({status:'accepted',delivery:{status:holding?'delivered':'pending'},signedProjection:paymentProjection})};
  const {op,ops,service}=coordinator(t,{retainedDelivery:holding,stage:holding?'delivered':'awaiting-claim',protocolPatch:{commitment:{committedAt:transferTime-1000},chainReadback:{[evidenceAddress]:paymentProjection}}});
  await service.recheck(op,{verifiedAt:'TEST',reportedTxHash:txHash,observation:{observation:transfer()}});
  const stored=ops.get(op.accountId,op.id);
  assert.equal(stored.status,'settled_verified');
  if(holding){assert.equal(stored.state.protocol.stage,'delivered');assert.deepEqual(stored.state.protocol.delivery,op.state.protocol.delivery);assert.deepEqual(stored.state.protocol.paymentEvidence,op.state.protocol.paymentEvidence);}
  else {assert.equal(stored.state.protocol.stage,'native-payment-evidence-held');assert.equal(stored.state.protocol.delivery,null);assert.equal(stored.state.protocol.nativeEvidence.nativeReadback,'indeterminate');}
 });
}
test('matching fresh transfer remains present',async()=>{
 state.observeTransfer=async()=>transfer();
 const result=await paymentReader().readEvidence(paymentRequest());
 assert.equal(result.disposition,'present');
});
test('authenticated payment evidence contradiction still rejects',async()=>{
 state.observeTransfer=async()=>transfer();
 const artifact={...paymentArtifact,paymentTxRefs:[{kind:'demos',txHash:'b'.repeat(64),blockNumber:10}]};
 const result=await paymentReader(artifact).readEvidence(paymentRequest());
 assert.equal(result.disposition,'rejected');assert.equal(result.authenticated,true);
});

test('present native payment evidence records the source outcome',async t=>{
 state.observeTransfer=async()=>transfer();paymentReader();
 state.seller={origin:'https://seller.invalid',submitPayment:async()=>({status:'accepted',delivery:{status:'pending'},signedProjection:paymentProjection})};
 const {op,ops,service}=coordinator(t,{retainedDelivery:false,stage:'awaiting-claim',protocolPatch:{commitment:{committedAt:transferTime-1000},chainReadback:{[evidenceAddress]:paymentProjection}}});
 await service.recheck(op,{verifiedAt:'TEST',reportedTxHash:txHash,observation:{observation:transfer()}});
 assert.equal(ops.get(op.accountId,op.id).state.protocol.stage,'payment-evidenced');
 assert.equal(ops.history(op.id).at(-1).data.outcome,'verified-source-native-read');
});
