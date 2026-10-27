// The source uses bounded JSON RPC replies, not SDK/Axios transport wrappers.
// A success code alone cannot authorize recovery of an ambiguous submission.
export const STORAGE_WRITE_SUBMISSION_PROFILE = 'hash-or-validator-relay/v3';

export function rpcEnvelope(answer, result, extra) {
  return answer!==null && typeof answer==='object' && !Array.isArray(answer)
    && Object.keys(answer).length===4
    && ['result','response','require_reply','extra'].every(key=>Object.hasOwn(answer,key))
    && answer.result===result && answer.require_reply===false
    && (typeof extra==='function'?extra(answer.extra):answer.extra===extra);
}

function exactFields(value, keys) {
  return value!==null && typeof value==='object' && !Array.isArray(value)
    && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
}

export function storageWriteConfirmationMatches(response) {
  const signedField=(value,length)=>exactFields(value,['type','data']) && value.type==='ed25519'
    && typeof value.data==='string' && value.data.length===length && /^0x[0-9a-f]+$/.test(value.data);
  const data=response?.data;
  return exactFields(response,['data','signature','rpc_public_key'])
    && exactFields(data,['valid','reference_block','message','gas_operation','transaction'])
    && data.valid===true && Number.isSafeInteger(data.reference_block) && data.reference_block>=0
    && typeof data.message==='string' && data.gas_operation===null
    && data.transaction!==null && typeof data.transaction==='object' && !Array.isArray(data.transaction)
    && signedField(response.signature,130) && signedField(response.rpc_public_key,66);
}

export function storageWriteIdentityMatches(block) {
  // Retain the block-zero projection alongside the node's Blocks columns.
  return exactFields(block,['number','status','hash'])
    || exactFields(block,['id','number','hash','content','status','proposer','next_proposer','validation_data','attrs']);
}

export function classifyStorageWriteSubmission(answer, hash) {
  const response=answer?.response;
  const hashes=['hash','txHash'].filter(key=>Object.hasOwn(response ?? {},key));
  const hashBound=rpcEnvelope(answer,200,null) && response!==null && typeof response==='object' && !Array.isArray(response)
    && hashes.length>0 && Object.keys(response).length===hashes.length && hashes.every(key=>response[key]===hash);
  // Node 61b8e75 echoes no storage hash. Only its positively accepted relay
  // reply qualifies without one; direct null replies and parked relays do not.
  const relayAccepted=response?.message==='Transaction relayed to validators'
    && Object.keys(response).length===1 && rpcEnvelope(answer,200,extra=>
      extra!==null && typeof extra==='object' && !Array.isArray(extra)
      && Object.keys(extra).length===1 && Object.hasOwn(extra,'confirmationBlock')
      && Number.isSafeInteger(extra.confirmationBlock) && extra.confirmationBlock>=0);
  return response?.success!==false
    && !Object.hasOwn(response ?? {},'error') && (hashBound || relayAccepted) ? 'accepted' : 'unknown';
}

export function storageWriteAbsent(status, transaction) {
  return rpcEnvelope(status,200,'') && status.response?.state==='unknown'
    && Object.keys(status.response).length===1
    && rpcEnvelope(transaction,400,null) && transaction.response==='error';
}

export function storageWriteAccountNonce(value) {
  return Number.isSafeInteger(value) && value>=0 ? value
    : typeof value==='string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

// RPC authentication signs only the timestamp-bound header message. It never
// asks the operator wallet to sign or prepare another transaction.
export function storageWriteRpcSigner(signer, writer) {
  return signer?.claim===writer && typeof signer.sign==='function'
    ? async message=>`0x${Buffer.from(await signer.sign(Buffer.from(message))).toString('hex')}` : null;
}
