import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { canonicalize, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';

const operationQueues=new Map(),signingContext=new AsyncLocalStorage();
const clone=(value)=>JSON.parse(canonicalize(value));
const same=(a,b)=>canonicalize(a)===canonicalize(b);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function requireJobId(jobId) {
  if (!isCanonicalJobId(jobId)) fail('job_invalid','jobId must be a canonical uppercase ULID');
}
const PARTY_VET_STATE='dacs-devnet-demo-party-vet-state/v2';
const freshOps=()=>({buyer:{checkpoints:{},steps:{},signing:{}},seller:{checkpoints:{},steps:{},signing:{}}});
// The demo requirement is empty, so a party Vet has no attempts and signs only
// its composite record, in this SDK step.
const SIGNING_STEP='composite';
// A job with anchor intents but no party Vet state: its Vets were started by
// an earlier server version (or its state was deleted after its purchase
// ended). It is refused for good, before anything is read back, signed or sent.
export const LEGACY_PARTY_VET_STATE='legacy_party_vet_state_missing';
// This context profile supports an explicitly empty buyer requirement on
// sellers. It is independent of the Listing's requirements on buyers.
export const SELLER_REQUIREMENT=Object.freeze({requirementVersion:'1',required:Object.freeze([]),preferredPresentation:'any'});

// A job's Vet state, one row in the seller's party Vet store (its own file,
// next to the artifact journal that holds the anchor's CREATE intents): the
// binding, written before any Vet signature; whether a write was ever
// started; both Vets' SDK operation checkpoints and the write-ahead record of
// each signature; the context the seller's Agreement step reads; or a
// quarantine marker. Every change is one atomic read, compare and write that
// bumps the row's revision, the discipline of the protocol revision CAS (#26):
// a writer whose binding no longer holds writes nothing.
function partyVetState(store,writer) {
  const keyFor=(jobId)=>{requireJobId(jobId);return `party-vet/${sha256Hex(canonicalize([writer,jobId]))}`;};
  const mine=(row,jobId)=>{
    if(row.version!==PARTY_VET_STATE||row.writer!==writer||row.jobId!==jobId)fail('indeterminate','the retained party Vet state is not this job\'s');
    return row;
  };
  const read=async(jobId)=>{const row=await store.read(keyFor(jobId));return row?clone(mine(row,jobId)):null;};
  // change is synchronous: undefined keeps the row, null deletes it.
  const update=async(jobId,change)=>{
    const row=await store.update(keyFor(jobId),(stored,rows)=>{
      const current=stored?mine(stored,jobId):null,next=change(current&&clone(current),rows);
      return next===undefined||next===null?next:{...next,version:PARTY_VET_STATE,writer,jobId,revision:(current?.revision ?? 0)+1};
    });
    return row&&clone(row);
  };
  const jobs=async()=>(await store.entries()).map(([,row])=>row).filter((row)=>row?.version===PARTY_VET_STATE&&row.writer===writer&&typeof row.jobId==='string').map((row)=>row.jobId);
  const serializeStep=(jobId,role,key,work)=>{
    requireJobId(jobId);
    const storeKey=store.storeId??store,lane=canonicalize([writer,jobId,role,key]);
    const queues=operationQueues.get(storeKey)??new Map();operationQueues.set(storeKey,queues);
    const result=(queues.get(lane)??Promise.resolve()).then(work),tail=result.catch(()=>{});
    queues.set(lane,tail);
    void tail.then(()=>{if(queues.get(lane)===tail)queues.delete(lane);if(!queues.size&&operationQueues.get(storeKey)===queues)operationQueues.delete(storeKey);});
    return result;
  };
  return{read,update,jobs,serializeStep};
}

// Reserve before execution. Completed results/failures replay; an interrupted
// pending step holds for authoritative reconciliation and never executes again.
// Signing context belongs to this async invocation, including concurrent keys.
function durableOperationStore(state,job,role,{now,clock}) {
  const own=(current)=>{if(!current?.binding||!same(current.binding,job.binding))fail('binding-changed','the job\'s party Vet binding changed; nothing was written');return current.ops[role];};
  Object.defineProperty(clock,'step',{configurable:true,get:()=>{const scope=signingContext.getStore();return scope?.clock===clock?scope.view:null;}});
  const terminalFailure=error=>({name:String(error?.name??'Error'),message:String(error?.message??error),...(typeof error?.code==='string'?{code:error.code}:{}),...(typeof error?.category==='string'?{category:error.category}:{})});
  const replayFailure=error=>Object.assign(new Error(error.message,{cause:clone(error)}),error);
  const run=(input,authorized=false)=>{
    const {operationKey,operationHash,inputHash,step,execute,authorize}=input;
    const key=canonicalize({operationKey,step}),owner=randomUUID();
    const identity={operationHash,inputHash};
    const kept=old=>{
      if(old.operationHash!==operationHash||old.inputHash!==inputHash)fail('conflict','party Vet effect key conflict');
      if(old.state==='failed')throw replayFailure(old.error);
      if(old.state==='complete'||(old.state===undefined&&Object.hasOwn(old,'value')))return clone(old.value);
      fail('indeterminate','the retained party Vet step has an unknown outcome; authoritative reconciliation is required');
    };
    const done=value=>authorized?{status:'complete',value}:value;
    return state.serializeStep(job.jobId,role,key,()=>signingContext.run(null,async()=>{
      let replay=false,value;
      await state.update(job.jobId,current=>{
        const ops=own(current),old=ops.steps[key];
        if(old){value=kept(old);replay=true;return undefined;}
        if(step===SIGNING_STEP&&ops.signing[key])fail('indeterminate','a legacy written-ahead signing step requires authoritative reconciliation');
        ops.steps[key]={...identity,state:'pending',owner};return current;
      });
      if(replay)return done(value);
      const fenced=ops=>{const pending=ops.steps[key];if(pending?.state!=='pending'||pending.owner!==owner)fail('binding-changed','the party Vet operation reservation changed');};
      const clear=()=>state.update(job.jobId,current=>{const ops=own(current);fenced(ops);delete ops.steps[key];if(ops.signing[key]?.reservation===owner)delete ops.signing[key];return current;});
      if(authorized){
        let verdict;
        try{verdict=await authorize();}catch(error){try{await clear();}catch(cause){throw new AggregateError([error,cause],'party Vet authorization cleanup failed',{cause});}throw error;}
        if(verdict?.status!=='authorized'){await clear();return{status:'authorization-rejected',reason:['fenced','expired','indeterminate'].includes(verdict?.reason)?verdict.reason:'indeterminate'};}
      }
      let view=null;
      try{if(step===SIGNING_STEP){
        const at=now();if(!Number.isSafeInteger(at)||at<0)fail('indeterminate','party Vet signing time is unavailable');
        await state.update(job.jobId,current=>{
          const ops=own(current);fenced(ops);
          if(ops.signing[key])fail('conflict','party Vet signing identity already exists');
          ops.signing[key]={...identity,generatedAt:at,reservation:owner};return current;
        });
        view=Object.freeze({key,generatedAt:at});
      }else await state.update(job.jobId,current=>{fenced(own(current));});}catch(error){try{await clear();}catch(cause){throw Object.assign(new AggregateError([error,cause],'party Vet preparation cleanup failed',{cause}),{code:'indeterminate'});}throw error;}
      const scope=Object.freeze({state,jobId:job.jobId,role,key,owner,clock,view});
      const finish=outcome=>state.update(job.jobId,current=>{const ops=own(current);fenced(ops);ops.steps[key]={...identity,...outcome};return current;});
      try{value=clone(await signingContext.run(scope,execute));}
      catch(error){
        const failure=terminalFailure(error);
        try{await finish({state:'failed',error:failure});}
        catch(cause){throw Object.assign(new AggregateError([error,cause],'party Vet failure could not be durably retained',{cause}),{code:'indeterminate'});}
        throw replayFailure(failure);
      }
      await finish({state:'complete',value});return done(clone(value));
    }));
  };
  const signingScope=()=>{
    const scope=signingContext.getStore();
    if(scope?.state!==state||scope.jobId!==job.jobId||scope.role!==role||!scope.view)fail('write-ahead-missing','a party Vet signature outside its active written-ahead step');
    return scope;
  };
  const signingFence=(ops,scope)=>{if(ops.steps[scope.key]?.state!=='pending'||ops.steps[scope.key]?.owner!==scope.owner)fail('binding-changed','the party Vet signing reservation changed');};
  // Stores the exact bytes the step asks to sign, before the signer; answers
  // the signature already stored for them, if any.
  const writeAhead=async(bytes)=>{
    const scope=signingScope(),step=scope.view,hex=Buffer.from(bytes).toString('hex');
    let entry;
    await state.update(job.jobId,(current)=>{
      const ops=own(current);signingFence(ops,scope);entry=ops.signing[step.key];
      if(entry?.generatedAt!==step.generatedAt)fail('binding-changed','the written-ahead party Vet record changed; nothing was signed');
      if(entry.signedBytes!==undefined){if(entry.signedBytes!==hex)fail('conflict','the record to sign differs from its written-ahead bytes; nothing was signed');return undefined;}
      entry.signedBytes=hex;
      return current;
    });
    return entry.signature ?? null;
  };
  const recordSignature=async(bytes,signature)=>{
    const scope=signingScope(),step=scope.view,hex=Buffer.from(bytes).toString('hex');
    await state.update(job.jobId,(current)=>{
      const ops=own(current);signingFence(ops,scope);const entry=ops.signing[step.key];
      if(entry?.generatedAt!==step?.generatedAt||entry.signedBytes!==hex)fail('binding-changed','the written-ahead party Vet record changed; the signature was not kept');
      if(entry.signature!==undefined){if(entry.signature!==signature)fail('conflict','the signer gave another signature for the same written-ahead bytes');return undefined;}
      entry.signature=signature;
      return current;
    });
  };
  return{writeAhead,recordSignature,operationStore:{
    load:async(key)=>{const value=own(await state.read(job.jobId)).checkpoints[key];return value===undefined?null:clone(value);},
    compareAndSet:async({operationKey,expected,next})=>{
      let changed=false;
      await state.update(job.jobId,(current)=>{
        const checkpoints=own(current).checkpoints;
        if(!same(checkpoints[operationKey] ?? null,expected))return undefined;
        checkpoints[operationKey]=clone(next);changed=true;
        return current;
      });
      return changed;
    },
    runOnce:run,
    runOnceAuthorized:input=>run(input,true),
  }};
}
