import { OperationError } from '../operations.mjs';
import { operatorBuyerAccessConfig } from './buyer-access.mjs';
import { addressForClaim } from '../dacs/demos-claims.mjs';
import {
  canonicalize, compositeVerificationAddress, contentHash, createInMemoryFencedSessionStore,
  identityBundleHash, isCanonicalJobId, partyVetCore, sha256Hex, verifyCompositeVerificationRecord, vetPhaseFailureClass,
} from '@kynesyslabs/dacs';
import { DEM_RAIL, verifyComponent } from '../dacs/listing.mjs';
import { listingPin, protocolSupport } from '../dacs/purchase-protocol.mjs';
import { isProvenUnsignedAbsence } from '../dacs/native-dem-delivery-consumer.mjs';

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
const LEGACY_REASON=`${LEGACY_PARTY_VET_STATE}: this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase`;
// Request times kept per job for the seller's context, until its plan is saved.
const CONTEXT_TIMES=16;
// This context profile supports an explicitly empty buyer requirement on
// sellers. It is independent of the Listing's requirements on buyers.
export const SELLER_REQUIREMENT=Object.freeze({requirementVersion:'1',required:Object.freeze([]),preferredPresentation:'any'});

// The writer causes a purchase's attempt note may name: a fixed code and its
// public text. The raw cause (lower-layer text that can carry node, wallet or
// path detail) goes to the server log only.
const WRITER_CAUSES=Object.freeze({
  conflict:'another record is already retained for this address',
  'binding-changed':'the job\'s Vet binding changed under this run; nothing was written',
  denied:'the seller approval was refused',
  rejected:'the anchor rejected the write',
  indeterminate:'the write outcome is not known yet',
  invalid:'the record failed the anchor checks',
  closed:'buyer access is closed',
  'not-pending':'the purchase is no longer pending; no new write was started',
  capacity:'a seller journal is full; this write was not stored',
  busy:'a seller journal is busy or its lock is held; this write was not started',
  failed:'the write failed',
});
const THROWN_CAUSES=Object.freeze({conflict:'conflict','binding-changed':'binding-changed',indeterminate:'indeterminate',invalid:'invalid',buyer_access_closed:'closed','not-pending':'not-pending','not-authorized':'not-pending','journal-capacity':'capacity','journal-busy':'busy'});
const writerCode=(error,out)=>out
  ? out.status==='rejected'?(/^user_rejected:/.test(out.reason ?? '')?'denied':'rejected'):out.status==='indeterminate'?'indeterminate':'failed'
  : Object.hasOwn(THROWN_CAUSES,error?.code ?? '')?THROWN_CAUSES[error.code]:'failed';
// The raw cause on one log line: control characters and backslashes escaped.
const ESCAPES={'\n':'\\n','\r':'\\r','\t':'\\t','\\':'\\\\'};
const oneLine=(text)=>String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029\\]/g,(c)=>ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);

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
  return{read,update,jobs};
}

// The SDK operation store for one role's Vet, kept in the job's durable state
// and valid only under the binding it was made for. Its signing step is
// written ahead: the record time is chosen once and stored before the step
// runs, the exact bytes to sign are stored before the signer is asked, and
// the signature is stored against them. A rerun, after a crash or in another
// process, builds the same unsigned record. It replays a stored signature,
// but a crash before that checkpoint or concurrent providers can call the
// signer again. The signer must be deterministic and free of side effects:
// repeat calls give the same signature value for the one immutable byte
// string per party Vet. A differing concurrent signature fails closed at
// recordSignature; no second record or CREATE is published.
function durableOperationStore(state,job,role,{now,clock}) {
  const own=(current)=>{if(!current?.binding||!same(current.binding,job.binding))fail('binding-changed','the job\'s party Vet binding changed; nothing was written');return current.ops[role];};
  const run=async(input)=>{
    const key=canonicalize({operationKey:input.operationKey,step:input.step});
    const kept=(old)=>{if(old.operationHash!==input.operationHash||old.inputHash!==input.inputHash)throw new Error('party Vet effect key conflict');return clone(old.value);};
    const old=own(await state.read(job.jobId)).steps[key];
    if(old)return kept(old);
    let ahead=null;
    if(input.step===SIGNING_STEP){
      const at=now(),ops=own(await state.update(job.jobId,(current)=>{
        const mineOps=own(current);
        if(mineOps.steps[key]||mineOps.signing[key])return undefined;
        mineOps.signing[key]={operationHash:input.operationHash,inputHash:input.inputHash,generatedAt:at};
        return current;
      }));
      if(ops.steps[key])return kept(ops.steps[key]);
      ahead=ops.signing[key];
      if(ahead.operationHash!==input.operationHash||ahead.inputHash!==input.inputHash)throw new Error('party Vet effect key conflict');
    }
    let value;
    clock.step=ahead&&{key,generatedAt:ahead.generatedAt};
    try{value=clone(await input.execute());}finally{clock.step=null;}
    await state.update(job.jobId,(current)=>{
      const steps=own(current).steps;
      if(steps[key]){value=kept(steps[key]);return undefined;}
      steps[key]={operationHash:input.operationHash,inputHash:input.inputHash,value};
      return current;
    });
    return clone(value);
  };
  // Stores the exact bytes the step asks to sign, before the signer; answers
  // the signature already stored for them, if any.
  const writeAhead=async(bytes)=>{
    const step=clock.step,hex=Buffer.from(bytes).toString('hex');
    if(!step)fail('write-ahead-missing','a party Vet signature outside its written-ahead step; nothing was signed');
    let entry;
    await state.update(job.jobId,(current)=>{
      entry=own(current).signing[step.key];
      if(entry?.generatedAt!==step.generatedAt)fail('binding-changed','the written-ahead party Vet record changed; nothing was signed');
      if(entry.signedBytes!==undefined){if(entry.signedBytes!==hex)fail('conflict','the record to sign differs from its written-ahead bytes; nothing was signed');return undefined;}
      entry.signedBytes=hex;
      return current;
    });
    return entry.signature ?? null;
  };
  const recordSignature=async(bytes,signature)=>{
    const step=clock.step,hex=Buffer.from(bytes).toString('hex');
    await state.update(job.jobId,(current)=>{
      const entry=own(current).signing[step?.key];
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
    runOnceAuthorized:async(input)=>{const a=await input.authorize();return a.status==='authorized'?{status:'complete',value:await run(input)}:{status:'authorization-rejected',reason:a.reason};},
  }};
}

// Produces both genuine partyVetCore composites and the exact derive input
// consumed by buyer and seller. Native receipts are verified again before the
// canonical logical refs enter the Agreement. store: the seller's party Vet
// store (party-vet-store.mjs), one per seller, shared by every route that
// writes this seller's Vets.
// retainedScope({jobId,buyer}) (seller context route, seller-context-route.mjs
// createSellerContextRecords): the scope of that buyer's completed route step
// from the seller's durable records, or null.
