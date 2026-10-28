// An explicit TEST finality oracle, separate from the inclusion-only SR-2
// adapter. record() scripts a finalized observation of an exact CREATE. Its
// signed receipt never changes the loopback adapter's evidence or labels.
import {canonicalize,contentHash,isAnchorReceipt} from '@kynesyslabs/dacs';
import {verifyDemosSignature,addressForClaim} from '../../src/dacs/demos-claims.mjs';
const same=(a,b)=>canonicalize(a)===canonicalize(b);
export function finalizedCommitmentReader(reader,signer){
 const observations=new Map();
 const proof=receipt=>{const {evidence,...material}=receipt;return 'TEST-finalized-commitment:'+canonicalize(material);};
 const matches=(row,artifact,projection)=>row&&same(row.artifact,artifact)&&same(row.signedProjection,projection);
 return{
  record({logicalAddress,artifact,signedProjection,blockRef}){
   const material={receiptVersion:'1',substrate:'TEST-finality-oracle',finalityProfile:'TEST-scripted-finalized',logicalAddress,nativeAddress:signedProjection.content.to,
    contentHash:contentHash(artifact),writer:signer.claim,transactionRef:{kind:'demos',value:signedProjection.hash},state:'finalized',observationDisposition:'established',observedAt:blockRef.timestamp,blockRef};
   const receipt={...material,evidence:{kind:'TEST-finality-signature',value:signer.sign(Buffer.from(proof(material))).toString('base64url')}};
   observations.set(logicalAddress,structuredClone({artifact,signedProjection,receipt}));
  },
  async read(logicalAddress,options){
   const included=await reader.read(logicalAddress,options);if(included.status!=='present')return included;
   const row=observations.get(logicalAddress);
   if(!matches(row,included.artifact,options.signedProjection))return{status:'indeterminate',reason:'TEST no exact finalized observation'};
   return{...included,receipt:structuredClone(row.receipt)};
  },
  async verifyReceipt({receipt,artifact,signedProjection,logicalAddress,...options}){
   const row=observations.get(logicalAddress);
   if(!matches(row,artifact,signedProjection)||!isAnchorReceipt(receipt)||!same(receipt,row.receipt)||!verifyDemosSignature({address:addressForClaim(signer.claim),message:proof(receipt),signature:receipt.evidence.value}))return 'invalid';
   const included=await reader.read(logicalAddress,{...options,expectedArtifactKind:'FinalityCommitmentRecord',signedProjection});
   return included.status==='present'&&same(included.artifact,artifact)?reader.verifyReceipt({...options,artifact,signedProjection,logicalAddress,artifactKind:'FinalityCommitmentRecord',receipt:included.receipt}):'indeterminate';
  }
 };
}
