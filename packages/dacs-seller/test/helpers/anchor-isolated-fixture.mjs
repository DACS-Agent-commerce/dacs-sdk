import * as core from '@kynesyslabs/dacs';
import { seller as fixtureSeller, buyer as fixtureBuyer } from './protocol-fixture.mjs';
import { privateModule } from './private-module.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { DEVNET_DEMO_ARTIFACT_POLICY } from '../../src/dacs/devnet-source.mjs';
const {assembleArtifactAnchor}=await privateModule(new URL('../../src/devnet-demo/artifact-anchor.mjs',import.meta.url),['assembleArtifactAnchor']);
// The isolated anchor has no wallet session: its runCreate calls the work at once, with RPC-authentication signers unchanged.
export const passThroughRunCreate=async(op,work)=>work({guardedSigner:sign=>sign});
// The anchor with publish's pass class and check filled in when a test gives none (the isolated wallet never asks the check).
export const withPassDefaults=anchor=>Object.freeze({...anchor,publish:input=>anchor.publish({operationClass:'job-create',currentAuthorization:()=>true,...input})});
export function memoryJournal(){const rows=new Map(),tails=new Map();return {rows,get:async key=>structuredClone(rows.get(key)??null),put:async(key,value)=>rows.set(key,structuredClone(value)),entries:async()=>[...rows].map(([k,v])=>[k,structuredClone(v)]),withWalletLock:async(key,work)=>{const previous=tails.get(key)??Promise.resolve();let release;const gate=new Promise(r=>release=r);tails.set(key,gate);await previous;try{return await work();}finally{release();if(tails.get(key)===gate)tails.delete(key);}}};}
// sleep (optional): replaces the anchor's wait between readbacks of a pending CREATE.
export async function anchorFixture({writer,signRpc=null,artifactKinds=['FinalityCommitmentRecord','CompositeVerificationRecord'],now=()=>1800000000000,vetMode,sleep}={}){
 writer??={claim:fixtureSeller.claim,sign:fixtureSeller.signBytes};
 const owner='0x'+writer.claim.slice(16),seller=writer.claim,journal=memoryJournal(),sourceJournal=memoryJournal(),captured=[];
 // controls.qualify: the composition's qualification step the anchor preflights; by default it answers one fixed generation.
 // This local-only source has no TP-1 binding, so node qualification itself is tested in node-qualification.test.mjs.
 const controls={nonce:0,request:null,qualify:async()=>'TEST-connection-generation',reader:{read:async()=>({status:'absent'}),verifyReceipt:async()=>'indeterminate'}};
 const source={pins:{network:'local-only',chainIdentity:'local-only',endpoint:'https://unused.invalid'},demoArtifactPublication:{authority:'local',artifactKinds},transportBinding:{},journal:sourceJournal,withWalletNonceLock:({owner,network,chainIdentity},work)=>sourceJournal.withWalletLock(`nonce/${network}/${chainIdentity}/${owner}`,work),readRpc:async()=>({result:200,response:controls.nonce,require_reply:false,extra:null})};
 const buyerAccess=createOperatorBuyerAccess({openBuyerAccess:false,custodyBuyer:fixtureBuyer.claim,buyerForJob:()=>controls.accessClosed?null:fixtureBuyer.address});
 // controls.runCreate and controls.stopped (optional): the runCreate and the host stop check of anchors opened after they are set.
 const open=()=>withPassDefaults(assembleArtifactAnchor({runCreate:controls.runCreate??passThroughRunCreate,stopped:controls.stopped??(()=>false),qualify:input=>controls.qualify(input),sourceCapability:source,journal,buyerAccess,walletFactory:()=>({getPublicAccount:()=>({address:owner}),getWriteProfile:()=>({demoArtifactPublication:{policy:DEVNET_DEMO_ARTIFACT_POLICY}}),guardsSigning:controls.guardsSigning!==false,
  // As the operator custody wallet: the operator's approval (controls.approval) is awaited, then the write's own check runs before anything is signed.
  request:async(request,{authorize}={})=>{captured.push(structuredClone(request.params[0]));await controls.approval?.(request.params[0]);
   if(authorize){let allowed;try{allowed=authorize();}catch(error){allowed=error;}if(allowed!==true)return {success:false,error:{code:'internal_error',message:'TEST withdrawn after approval'}};}
   if(controls.request)return controls.request(request.params[0]);return {success:false,error:{code:'capture-without-signing'}};}}),network:'local-only',signer:writer,now,vetMode},{reader:controls.reader,signRpc,...(sleep?{sleep}:{})}));
 const artifact=jobId=>core.signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'TEST-publication',version:1,contentHash:'b'.repeat(64)},parties:[fixtureBuyer.claim,seller],pattern:'fixed-price',createdAt:now()},core.FINALITY_COMMITMENT_SEPARATOR,{signer:seller,algorithm:'ed25519',sign:writer.sign});
 const publish=async(anchor,jobId)=>anchor.publish({logicalAddress:core.finalityCommitmentAddress(jobId),artifact:await artifact(jobId),artifactKind:'FinalityCommitmentRecord'});
 return {owner,seller,journal,sourceJournal,captured,controls,source,open,publish,artifact};
}

// Use the installed SDK's execution edits rather than signing the request unchanged.
export async function signSdkCreate(transaction,{postFork=false,writer=fixtureSeller}={}){
 const {createRequire}=await import('node:module'),{dirname,join}=await import('node:path'),{pathToFileURL}=await import('node:url');
 const {GCRGeneration}=await import(pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('@kynesyslabs/demosdk')),'websdk/GCRGeneration.js')).href);
 const signed=structuredClone(transaction);signed.hash='';signed.content.gcr_edits=await GCRGeneration.generate(signed);
 signed.content.transaction_fee={network_fee:1,rpc_fee:0,additional_fee:0,rpc_address:null};
 if(postFork){signed.content.amount='0';for(const field of ['network_fee','rpc_fee','additional_fee'])signed.content.transaction_fee[field]=String(BigInt(signed.content.transaction_fee[field])*1000000000n);for(const edit of signed.content.gcr_edits)if(edit.type==='balance')edit.amount=String(BigInt(edit.amount)*1000000000n);}
 signed.hash=core.sha256Hex(JSON.stringify(signed.content));signed.signature={type:'ed25519',data:'0x'+writer.signBytes(Buffer.from(signed.hash)).toString('hex')};return signed;
}
