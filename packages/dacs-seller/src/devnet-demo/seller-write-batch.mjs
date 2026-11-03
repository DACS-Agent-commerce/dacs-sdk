import { createHash } from 'node:crypto';
import { isCanonicalJobId, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { createWalletWriteBatch } from '../wallet/write-batch.mjs';

const FORMAT='dacs-seller-prepared-batch/v1';
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,noResend:true});};
const label=(value)=>typeof value==='string'&&value.length>0&&value.length<=128&&!value.includes('\0');

// Only accepts complete, unsigned plans. Native SDK preparation and the
// chain-bound callbacks are separate capabilities, never model proof flags.
export function createSellerWriteBatch({enabled=false,singlePublisher,journal,network,chainIdentity,wallet,approve,verifyPrepared,verifyReceipt,...transport}={}) {
  if(typeof enabled!=='boolean')throw new TypeError('seller batching requires an explicit boolean switch');
  if(!enabled)return singlePublisher;
  if(![approve,verifyPrepared,verifyReceipt].every(fn=>typeof fn==='function'))throw new TypeError('exact seller approval, prepared scope and receipt verifiers are required');
  createWalletWriteBatch({journal,network,chainIdentity,wallet,...transport});
  const lane=JSON.stringify([network,chainIdentity,wallet]);
  const keyFor=(batchId)=>`seller-batch-plan/${sha(JSON.stringify([lane,batchId]))}`;
  const proofKey=(batchId,hash)=>`${keyFor(batchId)}/receipt/${hash}`;
  const step=(jobId)=>`after-payment:${jobId}`;

  function checked(input) {
    if(!exact(input,['batchId','jobId','railId','paymentPhaseIndex','writes'])||!label(input.batchId)||!isCanonicalJobId(input.jobId)
      ||!label(input.railId)||!Number.isSafeInteger(input.paymentPhaseIndex)||input.paymentPhaseIndex<0
      ||!Array.isArray(input.writes)||![2,3].includes(input.writes.length))fail('seller-batch-invalid','one fully prepared after-payment purchase step is required');
    const addresses=[`dacs4:deliverable:${input.jobId}`,paymentEvidenceAddress(input.jobId,input.railId,input.paymentPhaseIndex),`dacs4:evidence:${input.jobId}`];
    for(const [index,plan] of input.writes.entries()){
      const c=plan?.transaction?.content,m=c?.data?.[1]?.metadata;
      if(!exact(plan,['artifactKind','logicalAddress','transaction','approval'])||plan.artifactKind!==(index===0?'Deliverable':'SettlementEvidence')
        ||plan.transaction?.signature!==null||plan.transaction?.hash!==''||c?.type!=='storageProgram'||c?.data?.[0]!=='storageProgram'
        ||c.data?.[1]?.operation!=='CREATE_STORAGE_PROGRAM'||plan.logicalAddress!==addresses[index]||c?.from!==wallet||c.network!==network||c.chainIdentity!==chainIdentity
        ||!Number.isSafeInteger(c.nonce)||c.nonce<1||m?.logicalAddress!==plan.logicalAddress||m.artifactKind!==plan.artifactKind
        ||m.artifactBinding?.jobId!==input.jobId||m.artifactBinding?.writer!==`did:demos:agent:${wallet.slice(2)}`
        ||(index>0&&c.nonce!==input.writes[0].transaction.content.nonce+index))fail('seller-batch-invalid','seller plans differ from the exact ordered purchase, writer, chain or nonces');
    }
    return input;
  }
  async function prepared(input) {
    checked(input);
    for(const plan of input.writes)if(await verifyPrepared(structuredClone(plan),{jobId:input.jobId,network,chainIdentity,wallet})!==true)
      fail('seller-batch-invalid','a seller plan is not fully built or differs from its exact approval bytes');
    return input;
  }
  async function retained(batchId) {
    const record=await journal.get(keyFor(batchId));
    if(!exact(record,['format','input'])||record.format!==FORMAT||record.input?.batchId!==batchId)fail('seller-batch-invalid','the retained seller batch scope is unavailable or malformed');
    // Readback-only recovery: verifyPrepared's authorization and fees may have
    // gone stale since signing; view() binds this plan to the signed bytes.
    return checked(structuredClone(record.input));
  }
  async function putExact(key,value) {
    await journal.put(key,value);
    if(JSON.stringify(await journal.get(key))!==JSON.stringify(value))fail('seller-batch-journal-error','the exact seller batch record was not retained');
  }
  function engine(input) {
    const planFor=(request)=>input.writes.find(plan=>plan.transaction.content.nonce===request.nonce);
    let journalFault=null;
    const batch=createWalletWriteBatch({journal,network,chainIdentity,wallet,...transport,
      verifyIncluded:async(request)=>{
        const observation=structuredClone(request.observation),plan=planFor(request);
        if(!plan||await transport.verifySigned({...request,transaction:structuredClone(plan.transaction)})!==true
          ||await transport.verifyIncluded({...request,observation:structuredClone(observation)})!==true
          ||await verifyReceipt({plan:structuredClone(plan),...request,observation:structuredClone(observation)})!==true)return false;
        // WS9 treats a throw here as an unverifiable readback; the write stays
        // fenced and the journal fault is rethrown once its reconcile returns.
        try { await putExact(proofKey(input.batchId,request.hash),observation); } catch(error) { journalFault??=error; throw error; }
        return true;
      },
    });
    return {submit:batch.submit,reconcile:async(request)=>{
      const result=await batch.reconcile(request);
      if(journalFault)throw journalFault;
      return result;
    }};
  }
  async function view(input,batch) {
    if(batch.batchId!==input.batchId||batch.step!==step(input.jobId)||batch.writes.length!==input.writes.length)fail('seller-batch-invalid','the wallet batch differs from its retained purchase step');
    const writes=[];
    for(const [index,write] of batch.writes.entries()){
      if(write.nonce!==input.writes[index].transaction.content.nonce||await transport.verifySigned({network,chainIdentity,wallet,hash:write.hash,nonce:write.nonce,signedBytes:write.signedBytes,transaction:structuredClone(input.writes[index].transaction)})!==true)fail('seller-batch-invalid','the original signed write differs from its retained approval');
      let observation=null;
      if(write.disposition==='included'){
        observation=await journal.get(proofKey(input.batchId,write.hash));
        const request={network,chainIdentity,wallet,hash:write.hash,nonce:write.nonce,signedBytes:write.signedBytes,observation:structuredClone(observation)};
        if(observation?.hash!==write.hash||observation?.wallet!==wallet||observation?.nonce!==write.nonce||observation?.disposition!=='included'
          ||await transport.verifyIncluded(structuredClone(request))!==true
          ||await verifyReceipt({plan:structuredClone(input.writes[index]),...structuredClone(request)})!==true)fail('seller-batch-receipt-invalid','a retained seller receipt no longer authenticates the original write');
      }
      writes.push({logicalAddress:input.writes[index].logicalAddress,disposition:write.disposition,observation});
    }
    return {batch,writes,deliverable:writes[0].disposition==='included'?writes[0]:null,noResend:true};
  }
  async function submitPrepared(input) {
    const plans=await prepared(structuredClone(input));
    return journal.withWalletLock(keyFor(plans.batchId),async()=>{
      if(await journal.get(keyFor(plans.batchId)))fail('seller-batch-replay','retained seller work is readback-only');
      await putExact(keyFor(plans.batchId),{format:FORMAT,input:plans});
      const decisions=[];
      for(const plan of plans.writes){
        const requestBytes=JSON.stringify(plan.approval),accepted=await approve(structuredClone(plan.approval));
        decisions.push({requestBytes,approvalHash:sha(requestBytes),decision:accepted===true?'approved':'rejected'});
        await putExact(`${keyFor(plans.batchId)}/approvals`,decisions);
        if(accepted!==true)fail('seller-batch-declined','a seller write was refused; no batch write was signed or sent');
      }
      const batch=await engine(plans).submit({batchId:plans.batchId,step:step(plans.jobId),writes:plans.writes.map(plan=>plan.transaction)});
      try { return await view(plans,batch); } catch(error) {
        throw Object.assign(new Error('the seller batch was signed, journaled and possibly sent, but its result could not be verified; use reconcile with this batchId, never resubmit',{cause:error}),
          {code:'seller-batch-submitted-unverified',batchId:plans.batchId,noResend:true});
      }
    });
  }
  async function reconcile({batchId}={}) {
    if(!label(batchId))fail('seller-batch-invalid','an exact seller batch id is required');
    const input=await retained(batchId);
    return view(input,await engine(input).reconcile({batchId}));
  }
  return Object.freeze({submitPrepared,reconcile});
}
