import * as core from '@kynesyslabs/dacs';
import { seller as fixtureSeller, buyer as fixtureBuyer } from './protocol-fixture.mjs';
import { privateModule } from './private-module.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { DEVNET_DEMO_ARTIFACT_POLICY } from '../../src/dacs/devnet-source.mjs';
const {assembleArtifactAnchor}=await privateModule(new URL('../../src/devnet-demo/artifact-anchor.mjs',import.meta.url),['assembleArtifactAnchor']);
export function memoryJournal(){const rows=new Map(),tails=new Map();return {rows,get:async key=>structuredClone(rows.get(key)??null),put:async(key,value)=>rows.set(key,structuredClone(value)),entries:async()=>[...rows].map(([k,v])=>[k,structuredClone(v)]),withWalletLock:async(key,work)=>{const previous=tails.get(key)??Promise.resolve();let release;const gate=new Promise(r=>release=r);tails.set(key,gate);await previous;try{return await work();}finally{release();if(tails.get(key)===gate)tails.delete(key);}}};}
export async function anchorFixture({writer,signRpc=null,artifactKinds=['FinalityCommitmentRecord','CompositeVerificationRecord']}={}){
 writer??={claim:fixtureSeller.claim,sign:fixtureSeller.signBytes};
 const owner='0x'+writer.claim.slice(16),seller=writer.claim,journal=memoryJournal(),sourceJournal=memoryJournal(),captured=[];
 const controls={nonce:0,request:null,reader:{read:async()=>({status:'absent'}),verifyReceipt:async()=>'indeterminate'}};
 const source={pins:{network:'local-only',chainIdentity:'local-only',endpoint:'https://unused.invalid',deployment:{commit:'61b8e75aa8db5e408c49e1c3a89db4d673f45578',dirty:false,artifactSha256:'b'.repeat(64),qualifiedOperations:['fee','nonce','broadcast','confirmation']}},verifyDeployment:async()=>true,demoArtifactPublication:{authority:'local',artifactKinds},transportBinding:{},journal:sourceJournal,withWalletNonceLock:({owner,network,chainIdentity},work)=>sourceJournal.withWalletLock(`nonce/${network}/${chainIdentity}/${owner}`,work),readRpc:async()=>({result:200,response:controls.nonce,require_reply:false,extra:null})};
 const buyerAccess=createOperatorBuyerAccess({openBuyerAccess:false,custodyBuyer:fixtureBuyer.claim,buyerForJob:()=>controls.accessClosed?null:fixtureBuyer.address});
 const open=()=>assembleArtifactAnchor({sourceCapability:source,journal,buyerAccess,walletFactory:()=>({getPublicAccount:()=>({address:owner}),getWriteProfile:()=>({demoArtifactPublication:{policy:DEVNET_DEMO_ARTIFACT_POLICY}}),request:async request=>{captured.push(structuredClone(request.params[0]));if(controls.request)return controls.request(request.params[0]);return {success:false,error:{code:'capture-without-signing'}};}}),network:'local-only',signer:writer,now:()=>1800000000000},{reader:controls.reader,signRpc});
 const artifact=jobId=>core.signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'TEST-publication',version:1,contentHash:'b'.repeat(64)},parties:[fixtureBuyer.claim,seller],pattern:'fixed-price',createdAt:1800000000000},core.FINALITY_COMMITMENT_SEPARATOR,{signer:seller,algorithm:'ed25519',sign:writer.sign});
 const publish=async(anchor,jobId)=>anchor.publish({logicalAddress:core.finalityCommitmentAddress(jobId),artifact:await artifact(jobId),artifactKind:'FinalityCommitmentRecord'});
 return {owner,seller,journal,sourceJournal,captured,controls,source,open,publish,artifact};
}

// Use the installed SDK's execution edits rather than signing the request unchanged.
export async function signSdkCreate(transaction,{postFork=false}={}){
 const {createRequire}=await import('node:module'),{dirname,join}=await import('node:path'),{pathToFileURL}=await import('node:url');
 const {GCRGeneration}=await import(pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('@kynesyslabs/demosdk')),'websdk/GCRGeneration.js')).href);
 const signed=structuredClone(transaction);signed.hash='';signed.content.gcr_edits=await GCRGeneration.generate(signed);
 signed.content.transaction_fee={network_fee:1,rpc_fee:0,additional_fee:0,rpc_address:null};
 if(postFork){signed.content.amount='0';for(const field of ['network_fee','rpc_fee','additional_fee'])signed.content.transaction_fee[field]=String(BigInt(signed.content.transaction_fee[field])*1000000000n);for(const edit of signed.content.gcr_edits)if(edit.type==='balance')edit.amount=String(BigInt(edit.amount)*1000000000n);}
 signed.hash=core.sha256Hex(JSON.stringify(signed.content));signed.signature={type:'ed25519',data:'0x'+fixtureSeller.signBytes(Buffer.from(signed.hash)).toString('hex')};return signed;
}
