// Test-owned SR-2 authority. Receipts and writer authorizations use independent
// ephemeral Ed25519 keys; altered addresses, bytes or receipts fail verification.
import {generateKeyPairSync,sign,verify,createPublicKey,randomBytes} from 'node:crypto';
import {canonicalize,contentHash,sha256Hex} from '@kynesyslabs/dacs';
const authorities=new Map();
const publicKey=claim=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(claim.slice(16),'hex')]),format:'der',type:'spki'});
export const fixtureRef=(locator,hash)=>({anchor:{kind:'storage-program',locator},contentHash:hash});
const writeBytes=(address,hash)=>Buffer.from(`test-anchor-write:${address}:${hash}`);
export const signAnchorWrite=(signer,address,hash)=>Buffer.from(signer(writeBytes(address,hash))).toString('base64url');
export const canonicalSignature=value=>Buffer.from(value,'base64url').toString('base64url');
export const fixtureTxRef=receipt=>({kind:'demos',txHash:receipt.transactionRef.value,blockNumber:Number(receipt.blockRef.height)});
export function verifyFixtureReceipt({receipt,logicalAddress,hash,expectedWriter}){
 try{
  const {value,...evidence}=receipt.evidence,scope={...receipt,evidence};
  return receipt.logicalAddress===logicalAddress&&receipt.contentHash===hash&&receipt.writer===expectedWriter
   && verify(null,Buffer.from(canonicalize(scope)),authorities.get(receipt.substrate),Buffer.from(value,'base64url'))?'valid':'invalid';
 }catch{return 'invalid';}
}
export const verifyFixtureRecord=(record,{logicalAddress,expectedWriter})=>record?.status==='present'?verifyFixtureReceipt({receipt:record.receipt,logicalAddress,hash:contentHash(record.artifact),expectedWriter}):'invalid';
export function localAnchor({now}){
 const authority=generateKeyPairSync('ed25519'),id='TEST-local-'+randomBytes(8).toString('hex'),rows=new Map(),writes=[];
 authorities.set(id,authority.publicKey);
 const controls={state:'finalized',timestamp:null,read:row=>row,failAfterWrite:null};
 const write=async({logicalAddress,artifact,writer,writerSignature})=>{
  if(!verify(null,writeBytes(logicalAddress,contentHash(artifact)),publicKey(writer),Buffer.from(writerSignature,'base64url')))throw new Error('invalid test writer authorization');
  if(rows.has(logicalAddress))throw new Error('immutable test address already written');
  const hash=sha256Hex(canonicalize([logicalAddress,artifact])),timestamp=controls.timestamp??now();
  const receipt={receiptVersion:'1',substrate:id,finalityProfile:'TEST-local-finality',logicalAddress,nativeAddress:logicalAddress,
   contentHash:contentHash(artifact),writer,transactionRef:{kind:'test-tx',value:hash},state:controls.state,observationDisposition:'established',observedAt:now(),
   blockRef:{id:hash,height:String(rows.size+1),timestamp},evidence:{kind:'test-signed-receipt'}};
  receipt.evidence.value=sign(null,Buffer.from(canonicalize(receipt)),authority.privateKey).toString('base64url');
  rows.set(logicalAddress,{status:'present',artifact:structuredClone(artifact),receipt});writes.push(logicalAddress);
  if(controls.failAfterWrite===logicalAddress){controls.failAfterWrite=null;throw new Error('lost anchor answer');}
  return structuredClone(receipt);
 };
 return {rows,writes,controls,write,read:async address=>controls.read(structuredClone(rows.get(address)??{status:'absent'}),address)};
}
