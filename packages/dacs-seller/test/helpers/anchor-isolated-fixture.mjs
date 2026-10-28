import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as core from '@kynesyslabs/dacs';
import {assertQualifiedDeployment} from '../../src/devnet-demo/deployment-qualification.mjs';
// The real marker, so a composed capability's reader is recognised by the agent's own check
// (a test that stubs the module, as d5-isolated-dependencies does, has none and reads the field).
const {provenUnsignedAbsence=(reason)=>({status:'absent',reason})}=await import('../../src/dacs/native-dem-delivery-consumer.mjs');
export function memoryJournal(){const rows=new Map(),tails=new Map();return {rows,get:async key=>structuredClone(rows.get(key)??null),put:async(key,value)=>rows.set(key,structuredClone(value)),entries:async()=>[...rows].map(([k,v])=>[k,structuredClone(v)]),withWalletLock:async(key,work)=>{const previous=tails.get(key)??Promise.resolve();let release;const gate=new Promise(r=>release=r);tails.set(key,gate);await previous;try{return await work();}finally{release();if(tails.get(key)===gate)tails.delete(key);}}};}
export async function anchorFixture({writer,signRpc=null,artifactKinds=['FinalityCommitmentRecord','CompositeVerificationRecord']}={}){
 const owner=writer?'0x'+writer.claim.slice(16):'0x'+'2'.repeat(64),seller=writer?.claim??'did:demos:agent:'+'2'.repeat(64),journal=memoryJournal(),sourceJournal=memoryJournal(),captured=[];
 const controls={nonce:0,request:null,reader:{read:async()=>({status:'absent'}),verifyReceipt:async()=>'indeterminate'}};
 const source={pins:{network:'local-only',chainIdentity:'local-only',endpoint:'https://unused.invalid',deployment:{commit:'61b8e75aa8db5e408c49e1c3a89db4d673f45578',dirty:false,artifactSha256:'b'.repeat(64),qualifiedOperations:['fee','nonce','broadcast','confirmation']}},verifyDeployment:async()=>true,demoArtifactPublication:{authority:'local',artifactKinds},transportBinding:{},journal:sourceJournal,withWalletNonceLock:({owner,network,chainIdentity},work)=>sourceJournal.withWalletLock(`nonce/${network}/${chainIdentity}/${owner}`,work),readRpc:async()=>({result:200,response:controls.nonce})};
 const noop=()=>{};
 const modules={
  'node:crypto':await import('node:crypto'),
  './deployment-qualification.mjs':{assertQualifiedDeployment},
  '../util/immutable-readbacks.mjs':{createImmutableReadbacks:()=>({get:()=>null,put:noop,delete:noop})},
  '../dacs/delivery-evidence.mjs':{isNativeDeliveryEvidence:()=>false},
  '../dacs/native-dem-delivery-consumer.mjs':{provenUnsignedAbsence:reason=>Object.assign(provenUnsignedAbsence(reason),{provenUnsigned:true})},
  './storage-write-recovery.mjs':{storageWriteRpcSigner:()=>signRpc},
  './buyer-access.mjs':{operatorBuyerAccessConfig:()=>({assertSellerJob:noop})},
  './operator-approval.mjs':{OPERATOR_CLOSING:'operator_closing'},
  '@kynesyslabs/dacs':{...core,isFinalityCommitmentRecord:()=>true},
  '../dacs/demos-sr2-adapter.mjs':{createDemosSr2Adapter:()=>controls.reader,createInMemoryDemosSr2Journal:()=>({}),demosSr2TxRef:noop},
  '../dacs/wallet-transactions.mjs':{deriveStorageAddress:()=> 'stor-local',buildStorageProgramCreatePayload:input=>({content:{type:'storageProgram',from:owner,nonce:input.nonce,data:['storageProgram',{data:input.signedListing,metadata:{logicalAddress:input.logicalAddress}}]}})},
  '../dacs/demos-claims.mjs':{addressForClaim:()=>owner,verifyDemosSignature:()=>false},
  '../dacs/devnet-source.mjs':{DEVNET_AGREEMENT_PROFILE:'local',DEVNET_DEMO_ARTIFACT_KIND:'local',DEVNET_DEMO_ARTIFACT_POLICY:'local',DEVNET_DEMO_ARTIFACT_TYPES:[],isDevnetDemoTransport:()=>true}
 };
 const module=new vm.SourceTextModule(readFileSync(new URL('../../src/devnet-demo/artifact-anchor.mjs',import.meta.url),'utf8'));
 await module.link(async spec=>{const values=modules[spec];if(!values)throw new Error('missing isolated import '+spec);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);});});await module.evaluate();
 const open=()=>module.namespace.createDevnetDemoArtifactAnchor({sourceCapability:source,journal,walletFactory:()=>({getPublicAccount:()=>({address:owner}),getWriteProfile:()=>({demoArtifactPublication:{policy:'local'}}),request:async request=>{captured.push(structuredClone(request.params[0]));if(controls.request)return controls.request(request.params[0]);return {success:false,error:{code:'capture-without-signing'}};}}),network:'local-only',signer:writer,now:()=>1800000000000});
 const publish=(anchor,jobId)=>anchor.publish({logicalAddress:core.finalityCommitmentAddress(jobId),artifact:{jobId,signature:{signer:seller}},artifactKind:'FinalityCommitmentRecord'});
 return {owner,seller,journal,sourceJournal,captured,controls,source,open,publish};
}
