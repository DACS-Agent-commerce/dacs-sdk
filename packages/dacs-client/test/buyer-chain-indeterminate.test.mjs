// the source change decision cases ported from buyer-chain-readback-unit with an injected
// read-only adapter. The real opaque source capability is never invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, DacsError } from '@kynesyslabs/dacs';
import { createBuyerChainReadback } from '../src/dacs/buyer-chain-readback.mjs';
import { DemosSr2Error } from '../src/dacs/demos-sr2-adapter.mjs';
import { createDevnetAgreementTransport } from '../src/wallet/devnet-native-transport.mjs';
const sourceCapability=createDevnetAgreementTransport({expected:{network:'testnet',chainIdentity:'f'.repeat(64),pinVersion:'TEST-1',endpoint:'https://rpc.invalid/',transportAuthority:'TEST-owner'},transportOwner:{getContext(){throw Error('unused');},acquireConnectionFence(){throw Error('unused');}},journal:{get:async()=>null,put:async()=>{throw Error('read only');},entries:async()=>[],withWalletLock:(_k,w)=>w()}});
const seller='did:demos:agent:'+'a'.repeat(64),jobId='01HZY3K8V9Q2W4E6R7T8Y9X0AB',address='dacs4:deliverable:'+jobId;
const signedProjection={hash:'b'.repeat(64),content:{from:'0x'+'a'.repeat(64),to:'stor-'+'c'.repeat(40),data:['storageProgram',{metadata:{logicalAddress:address,artifactKind:'Deliverable'}}]},signature:{type:'ed25519',data:'00'}};
const listing={listingId:'TEST',listingVersion:1,seller:{identity:{presentedBy:seller}}};
for(const [label,error] of [['unmarked adapter invalid',new DemosSr2Error('invalid','node bytes did not authenticate')],['foreign invalid',Object.assign(new Error('foreign'),{code:'invalid'})],['invalid lookalike',{code:'invalid',contradiction:true,message:'node flag'}]])test(`the source change ${label} stays indeterminate`,async()=>{
 const chain=createBuyerChainReadback({sourceCapability,reader:{read:async()=>{throw error;},verifyReceipt:async()=>{throw Error('must not verify a missing record');}}});
 const result=await chain.readDeliverable({jobId,agreementHash:'d'.repeat(64),listing,seller,signedProjection,receiptContentHash:'e'.repeat(64),deliveryBinding:{jobId,agreementHash:'d'.repeat(64),listing:{listingId:listing.listingId,version:listing.listingVersion,contentHash:contentHash(listing)},payloadHash:'e'.repeat(64)}});
 assert.equal(result.status,'indeterminate',JSON.stringify(result));assert.equal(result.code,'invalid');
});
test('the source change an SDK permanent error before commitment authentication stays indeterminate',async()=>{
 const agreement={jobId,parties:[{role:'buyer',primaryClaim:'did:demos:agent:'+'e'.repeat(64)},{role:'seller',primaryClaim:seller}],listingRef:{listingId:'TEST',version:1,contentHash:'f'.repeat(64)}};
 const logicalAddress='dacs3:commit:'+jobId,artifact={TEST:'unauthenticated shape'},projection=structuredClone(signedProjection);projection.content.data[1].metadata={logicalAddress,artifactKind:'FinalityCommitmentRecord'};
 const chain=createBuyerChainReadback({sourceCapability,reader:{read:async()=>({status:'present',artifact,artifactKind:'FinalityCommitmentRecord',receipt:{writer:seller,logicalAddress,contentHash:contentHash(artifact),transactionRef:{value:projection.hash},nativeAddress:projection.content.to}}),verifyReceipt:async()=> 'valid'}});
 const result=await chain.readCommitment({agreement,listing,seller,signedProjection:projection});
 assert.equal(result.status,'indeterminate',JSON.stringify(result));
});
