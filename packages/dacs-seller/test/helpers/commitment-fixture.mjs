import * as core from '@kynesyslabs/dacs';
import {join}from'node:path';
import {mkdtemp,rm}from'node:fs/promises';
import {tmpdir}from'node:os';
import {proposalAdmissionFixture}from'./proposal-admission-fixture.mjs';
import {seller,buyer,NOW,fixtureRecord}from'./protocol-fixture.mjs';
import {localAnchor,fixtureTxRef,signAnchorWrite,verifyFixtureReceipt,fixtureRef}from'./local-anchor-fixture.mjs';
import {createNativeDemDeliveryCapability}from'../../src/dacs/native-dem-delivery-consumer.mjs';
import {createNativePaymentEvidenceConsumer}from'../../src/dacs/native-payment-evidence-consumer.mjs';
import {createPaymentEvidenceWalletJournal}from'../../src/dacs/payment-evidence-wallet-journal.mjs';
import {contributionVerifier}from'../../src/dacs/purchase-protocol.mjs';
import {createOperatorBuyerAccess}from'../../src/devnet-demo/buyer-access.mjs';
export async function commitmentFixture(t,{early=false,publisher=null}={}){
 const f=await proposalAdmissionFixture(t,{assembled:true}),local=localAnchor({now:()=>NOW}),controls={agreement:null,read:null},unreachable=()=>{throw new Error('TEST no payment operation');};
 const walletDir=await mkdtemp(join(tmpdir(),'TEST-commitment-wallet-'));
 const journal=createPaymentEvidenceWalletJournal({path:join(walletDir,'journal.sqlite'),signCreate:unreachable,broadcast:unreachable,readAccountNonce:unreachable,readTransactionState:unreachable});t.after(async()=>{journal.close();await rm(walletDir,{recursive:true,force:true});});
 const native={writer:seller.claim,source:'TEST-native',readRetained:async({logicalAddress})=>{const row=await local.read(logicalAddress);return row.status==='present'?{...row,receipt:{...row.receipt,nonce:'1'},txRef:fixtureTxRef(row.receipt)}:row;},publish:async({logicalAddress,artifact})=>{if(!local.rows.has(logicalAddress))await local.write({logicalAddress,artifact,writer:seller.claim,writerSignature:signAnchorWrite(seller.signBytes,logicalAddress,core.contentHash(artifact))});return native.readRetained({logicalAddress});},verifyReceipt:async({receipt,logicalAddress,artifact})=>verifyFixtureReceipt({receipt,logicalAddress,hash:core.contentHash(artifact),expectedWriter:seller.claim})};
 f.config.nativeArtifactAnchor=publisher??native;f.config.nativePaymentEvidence=createNativePaymentEvidenceConsumer({rpcUrl:'http://127.0.0.1:1',anchorEvidence:journal.anchorEvidence,fetchImpl:unreachable});f.config.reconcilePaymentEvidence=journal.reconcilePaymentEvidence;
 f.config.nativeDemDelivery=createNativeDemDeliveryCapability({authority:'TEST-admission',submit:unreachable,reconcile:unreachable,read:unreachable,verifyReceipt:unreachable});f.config.commitOnSignature=early;f.config.buyerAccess=createOperatorBuyerAccess({openBuyerAccess:true,buyerForJob:jobId=>f.contexts.has(jobId)?buyer.address:null});
 f.config.agreementAnchor={source:'TEST-native-agreement',readAgreement:async query=>{if(controls.read)return controls.read(query);const row=controls.agreement;if(!row)return{disposition:'absent'};return{disposition:'present',artifact:structuredClone(row.artifact),ref:fixtureRef(query.logicalAddress,core.contentHash(row.artifact)),native:{source:'TEST-native-agreement',evidenceMode:'TEST-writer-proof',nativeAddress:row.receipt.nativeAddress,txRef:fixtureTxRef(row.receipt)}};}};
 const prepare=async()=>{const agent=await f.open(),request=await f.proposal(agent),response=await agent.receiveProposal(request);if(response.disposition!=='complete')throw new Error('TEST proposal failed: '+JSON.stringify(response));const agreement=await core.finalizeFixedPriceAgreementContributions(request.proposal.plan,[request.proposal.buyerContribution,response.contribution],contributionVerifier);controls.agreement=fixtureRecord(core.fixedPriceAgreementLogicalAddress(agreement.jobId),agreement,buyer);return{agent,request,agreement};};
 return{...f,local,native,controls,prepare};
}
