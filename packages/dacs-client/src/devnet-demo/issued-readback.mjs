import { observePayDemTransferCore } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../dacs/demos-sr2-adapter.mjs';

// Inspect only original signed CREATEs already retained by this source.
// Adapter reads authenticate the projection, transaction and inclusion block.
// No binding/readback lane is used: those lanes persist their observations.
export async function readIssuedArtifacts({sourceCapability,writer,jobId,unknownOnly=false}) {
  const address=`0x${writer.slice('did:demos:agent:'.length)}`;
  const rows=(await sourceCapability.journal.entries()).map(([,value])=>value).filter(value=>
    value?.signedTransaction?.content?.from===address && value.signedTransaction.content.type==='storageProgram'
    && value.signedTransaction.content.data?.[1]?.data?.jobId===jobId && (!unknownOnly || value.stage!=='observed'));
  const projections=new Map(rows.map(value=>[value.hash,value.signedTransaction]));
  if(!projections.size)return null;
  const reader=createDemosSr2Adapter({rpcUrl:sourceCapability.pins.endpoint,sourceCapability,journal:createInMemoryDemosSr2Journal()});
  const records=[];
  for(const [hash,projection] of projections){
    const metadata=projection.content.data[1].metadata;
    try{
      const record=await reader.read(metadata.logicalAddress,{expectedWriter:writer,expectedArtifactKind:metadata.artifactKind,signedProjection:projection});
      records.push({hash,status:record.status,record});
    }catch(error){records.push({hash,status:'indeterminate',reason:String(error.message).slice(0,240)});}
  }
  return {status:'readback-only',noResend:true,records};
}

export async function readIssuedWallet({sourceCapability,address,hash,nativeOnly=false}) {
  const rows=(await sourceCapability.journal.entries()).map(([,value])=>value).filter(value=>value?.hash===hash&&value.signedTransaction?.content?.from===address);
  if(!rows.length)return null;
  const projection=rows[0].signedTransaction;
  if(projection.content.type==='storageProgram'){
    if(nativeOnly)return null;
    return readIssuedArtifacts({sourceCapability,writer:`did:demos:agent:${address.slice(2)}`,jobId:projection.content.data[1].data.jobId,unknownOnly:true});
  }
  // A read-only observation is reported separately from the retained unknown
  // outcome. It grants no lane release, payment, resend or state transition.
  return {status:'readback-only',noResend:true,hash,observation:await observeTransferReadOnly({sourceCapability,hash})};
}

// The SDK observation over the source's fenced read RPC only. Unlike the
// source chainReader, it never runs the persisting binding readback of a
// retained native intent, whoever's transfer the hash names.
export async function observeTransferReadOnly({sourceCapability,hash}) {
  const node=async(message,data)=>{
    const answer=await sourceCapability.readRpc('/',{method:'nodeCall',params:[{message,data}]});
    if(answer?.result!==200)throw new Error('issued payment observation is unavailable');
    return answer.response;
  };
  return observePayDemTransferCore(hash,{
    getTransactionStatus:(value)=>node('getTransactionStatus',{hash:value}),
    getTxByHash:(value)=>node('getTxByHash',{hash:value}),
    getBlockByNumber:(blockNumber)=>node('getBlockByNumber',{blockNumber})});
}
