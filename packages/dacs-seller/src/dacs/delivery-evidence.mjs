// Run-time port of http-mcp/src/dacs/delivery-evidence.mjs at DACS-Agent-commerce/frontend
// 15fdf23: the whole file.
import { ARTIFACT_SEPARATORS, contentHash, isCanonicalJobId, isSettlementEvidence, signedBytes } from '@kynesyslabs/dacs';
import { addressForClaim, verifyDemosSignature } from './demos-claims.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

// True only for a signed native delivery SettlementEvidence whose exact bytes,
// job, writer, logical address and deliverable anchor are canonical. Never throws.
export function isNativeDeliveryEvidence(value,writer,logicalAddress){
  if(!exact(value,['evidenceVersion','jobId','phase','outcome','dacsSdkAuditSourceHash','deliverableContentHash','deliverableAnchor','observedAt','signature'])
    ||!isSettlementEvidence(value)||value.evidenceVersion!=='1'||!isCanonicalJobId(value.jobId)||value.phase!=='deliver-storage-program'||value.outcome!=='success'
    ||!/^[0-9a-f]{64}$/.test(value.dacsSdkAuditSourceHash??'')||logicalAddress!==`dacs4:evidence:${value.jobId}`||!/^[0-9a-f]{64}$/.test(value.deliverableContentHash??'')
    ||!exact(value.deliverableAnchor,['kind','locator'])||value.deliverableAnchor.kind!=='storage-program'||value.deliverableAnchor.locator!==`dacs4:deliverable:${value.jobId}`
    ||!Number.isSafeInteger(value.observedAt)||value.observedAt<0||!exact(value.signature,['algorithm','signer','value'])||value.signature.algorithm!=='ed25519'||value.signature.signer!==writer)return false;
  try{return verifyDemosSignature({address:addressForClaim(writer),message:Buffer.from(signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence,contentHash(value))).toString('utf8'),signature:value.signature.value});}catch{return false;}
}
