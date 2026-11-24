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

const blockNumber=value=>Number.isSafeInteger(value) && value>=0;

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
  // Node e6af8f40 admits the write to its own mempool and names the hash it took.
  const mempoolAccepted=response===null && rpcEnvelope(answer,200,extra=>
    exactFields(extra,['confirmationBlock','lastBlockNumber','published','hash','disposition'])
    && extra.disposition==='mempool' && typeof hash==='string' && extra.hash===hash
    && blockNumber(extra.confirmationBlock) && blockNumber(extra.lastBlockNumber) && typeof extra.published==='boolean');
  // Node e6af8f40 refuses on a node that is not a staked validator before its
  // mempool and publication: nothing was submitted, and this node takes no writes.
  if(rpcEnvelope(answer,400,extra=>exactFields(extra,['error']) && extra.error==='NOT_A_VALIDATOR')
    && exactFields(response,['message']) && typeof response.message==='string') return 'refused-not-validator';
  return response?.success!==false
    && !Object.hasOwn(response ?? {},'error') && (hashBound || relayAccepted || mempoolAccepted) ? 'accepted' : 'unknown';
}

// `referenceBlock` is the reference block R of the write's kept confirmation. The
// node executes such a write only in block R+1 or R+2 (later it can only record
// it as failed), so node e6af8f40's not-found answer proves absence only once it
// has searched through R+2. Node 61b8e75's not-found answer names no block. A
// failed lookup never proves absence.
export function storageWriteAbsent(status, transaction, referenceBlock) {
  const notFound=(rpcEnvelope(transaction,400,null) && transaction.response==='error')
    || (transaction?.response===null && rpcEnvelope(transaction,404,extra=>
      exactFields(extra,['reason','checkedThroughBlock']) && extra.reason==='not_found'
      && blockNumber(extra.checkedThroughBlock) && blockNumber(referenceBlock)
      && referenceBlock<=Number.MAX_SAFE_INTEGER-2 && extra.checkedThroughBlock>=referenceBlock+2));
  return rpcEnvelope(status,200,'') && status.response?.state==='unknown'
    && Object.keys(status.response).length===1 && notFound;
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
