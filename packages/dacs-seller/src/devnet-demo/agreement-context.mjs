import { isProvenUnsignedAbsence } from '../dacs/native-dem-delivery-consumer.mjs';
import { listingPin, protocolSupport } from '../dacs/purchase-protocol.mjs';
import { DEM_RAIL, verifyComponent } from '../dacs/listing.mjs';
import { compositeVerificationAddress, contentHash, createInMemoryFencedSessionStore, identityBundleHash, partyVetCore, verifyCompositeVerificationRecord, vetPhaseFailureClass } from '@kynesyslabs/dacs';
import { addressForClaim } from '../dacs/demos-claims.mjs';
import { operatorBuyerAccessConfig } from './buyer-access.mjs';
import { OperationError } from '../operations.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { admitRawJson, canonicalize, isCanonicalJobId, sameCanonicalClaimIdentity, sha256Hex } from '@kynesyslabs/dacs';

const operationQueues=new Map(),signingContext=new AsyncLocalStorage();
const clone=(value)=>JSON.parse(canonicalize(value));
const same=(a,b)=>canonicalize(a)===canonicalize(b);
const fail=(code,message,cause)=>{throw Object.assign(new Error(message,{cause}),{code});};
// Pending receipts and native uncertainty keep anchor work retryable; signed bytes stay retained.
const PENDING_RECEIPT_STATES=new Set(['accepted','included']);
const RETRYABLE_ANCHOR_CODES=new Set(['indeterminate','journal-busy','journal-capacity']);
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
function durableOperationStore(state,job,role,{now,clock,wait={pending:false}}) {
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
      wait.pending=false;wait.terminal=false;
      try{value=clone(await signingContext.run(scope,execute));}
      catch(error){
        if(step==='composite-anchor'&&wait.pending&&!wait.terminal){
          try{await clear();}catch(cause){throw Object.assign(new AggregateError([error,cause],'party Vet pending cleanup failed',{cause}),{code:'indeterminate'});}
          throw error;
        }
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

// Produces both genuine partyVetCore composites and the exact derive input
// consumed by buyer and seller. Native receipts are verified again before the
// canonical logical refs enter the Agreement. store: the seller's party Vet
// store (party-vet-store.mjs), one per seller, shared by every route that
// writes this seller's Vets.
// retainedScope({jobId,buyer}) (seller context route, seller-context-route.mjs
// createSellerContextRecords): the scope of that buyer's completed route step
// from the seller's durable records, or null.
export function createDevnetDemoAgreementContextProvider({anchor,wallet,listing,store,buyerAccess=null,retainedScope=null,counterparty=null,now=()=>Date.now(),log=(line)=>process.stderr.write(line)}) {
  if(anchor?.writer!==wallet?.claim || typeof wallet?.signBytes!=='function') throw new TypeError('Vet producer and native anchor must belong to the seller');
  if(typeof anchor.hasIntent!=='function') throw new TypeError('the native anchor must answer whether a CREATE intent is retained');
  if(!store || !['read','update','entries'].every((key)=>typeof store[key]==='function')) throw new TypeError('party Vet state requires the seller\'s party Vet store');
  const access=operatorBuyerAccessConfig(buyerAccess);
  const assertAccess=(buyer)=>{
    if(!access&&anchor.source==='dacs-devnet-demo-native-artifacts/v1')throw new OperationError('buyer_access_closed','operator buyerAccess capability is missing');
    access?.assertWallet(addressForClaim(buyer));
  };
  const state=partyVetState(store,wallet.claim);
  const contexts=new Map(),invocations=[],vets=new Map(),running=new Set(),drops=new Set(),releasing=new Map();
  const rememberInvocation=value=>{invocations.push(value);if(invocations.length>INVOCATION_DIAGNOSTIC_LIMIT)invocations.shift();};
  const verifier={isSignerAuthorized:(_artifact,signature)=>signature.signer===wallet.claim,resolvePublicKey:(signature)=>signature.signer===wallet.claim?signature.signer:null,verify:({signedBytes,signature})=>verifyComponent({signedBytes,signature})};
  // This profile admits a parsed single-claim bundle before Vet and invokes no
  // credential parser. No valid CVR here can have the solely counterparty-
  // malformed-presentation cause; never infer that exception from seller text.
  const nonPass = record => ({ disposition:'rejected', code:'party_vet_non_pass',
    errorClass:vetPhaseFailureClass(record.overallDecision),
    reason:`${record.evaluatedParty === listing.seller.identity.presentedBy ? 'seller' : 'buyer'} Vet decision: ${record.overallDecision}` });
  // counterparty is a buyer-owned capability, not a seller signing adapter.
  // Its issuer must retain and consume its challenge before evaluating this
  // exact presentation. The seller independently authenticates the returned CVR.
  const counterpartyReady = () => counterparty && ['issueChallenge','readRecord','evaluate'].every(key=>typeof counterparty[key]==='function');
  // Capabilities must bound wire bytes before decoding. Independently bound
  // their returned representation and deadline, including a stalled callback.
  const callCounterparty = async(method,input)=>{
    const controller=new AbortController(),maxBytes=65536,timeoutMs=10000;
    let timer;
    try{
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DOMException('counterparty deadline expired','TimeoutError'));},timeoutMs);});
      const value=await Promise.race([Promise.resolve().then(()=>counterparty[method](clone(input),{signal:controller.signal,maxBytes,timeoutMs})),timeout]);
      if(value instanceof Uint8Array)return admitRawJson(value,{maxBytes});
      let budget=maxBytes;
      const text=JSON.stringify(value,(key,member)=>{
        budget-=Buffer.byteLength(key)+(typeof member==='string'?Buffer.byteLength(member):8);
        if(budget<0)throw new RangeError('counterparty reply exceeds byte budget');
        return member;
      });
      return admitRawJson(Buffer.from(text),{maxBytes});
    }catch(cause){fail('counterparty_vet_unavailable',`counterparty ${method} failed`,cause);}
    finally{clearTimeout(timer);controller.abort();}
  };
  const strictRecord = (record, {jobId,bundle,requirement,authority}) => verifyCompositeVerificationRecord(record,
    {jobId,evaluatedParty:bundle.presentedBy,bundleHash:identityBundleHash(bundle),requirement,verifier:authority,freshness:[],dealSpecific:[]},
    {nowMs:now,resolve:async()=>null,resolveRecipe:async()=>null,isRecipeSignerAuthorized:()=>false,isVerifyResultSignerAuthorized:()=>false,
      resolvePublicKey:signature=>sameCanonicalClaimIdentity(signature.signer,authority)?authority:null,verify:verifier.verify,verifyAuthorityAttestation:()=> 'unresolved'});
  const validReceipt = async (read,logicalAddress,artifact,authority) => read?.status==='present'
    && read.receipt?.state==='finalized' && read.receipt?.observationDisposition==='established'
    && await anchor.verifyReceipt({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord',receipt:read.receipt,verifier:authority})==='valid';
  const unattempted=(read,request)=>read?.status==='unattempted'
    && sameCanonicalClaimIdentity(read.issuer,request.buyer) && read.jobId===request.jobId
    && read.bundleHash===identityBundleHash(request.identityBundle)
    && read.requirementHash===sha256Hex(canonicalize(request.requirement));
  async function sellerSession(job) {
    let kept=(await state.read(job.jobId))?.presentation;
    let expired=null;
    if(kept&&!kept.bundle.presentation&&kept.challenge.expiresAt<=now()){
      const request={jobId:job.jobId,buyer:job.binding.buyerIdentityBundle.presentedBy,seller:wallet.claim,identityBundle:kept.bundle,requirement:SELLER_REQUIREMENT};
      if(!unattempted(await callCounterparty('readRecord',request),request))fail('seller_vet_reconciliation_required','the expired seller challenge has no authoritative unused outcome');
      expired=kept;kept=null;
    }
    if(!kept){
      if(!counterpartyReady()) fail('counterparty_vet_required','a buyer verifier and its challenge ledger are required');
      const buyer=job.binding.buyerIdentityBundle.presentedBy;
      const challenge=await callCounterparty('issueChallenge',{jobId:job.jobId,buyer,seller:wallet.claim});
      if(!sameCanonicalClaimIdentity(challenge?.issuer,buyer) || challenge?.jobId!==job.jobId || !sameCanonicalClaimIdentity(challenge?.seller,wallet.claim)
        || typeof challenge.sessionNonce!=='string' || !/^(?:[a-f0-9]{2}){16,128}$/.test(challenge.sessionNonce) || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt<=now()) fail('seller_challenge_invalid','buyer challenge is not bound to this session');
      if(expired&&challenge.sessionNonce===expired.challenge.sessionNonce)fail('seller_challenge_reused','the expired seller challenge cannot be issued again');
      const {presentation:_publicationProof,...identity}=listing.seller.identity;
      const value={challenge:clone(challenge),bundle:{...identity,presentedAt:now(),sessionNonce:challenge.sessionNonce}};
      kept=(await state.update(job.jobId,(current,rows)=>{
        // Claim the nonce in the job row, under the store transaction. It is
        // retained across restarts and released with the ended purchase.
        if(rows().some(([,row])=>row.jobId!==job.jobId && row.writer===wallet.claim
          && sameCanonicalClaimIdentity(row.presentation?.challenge?.issuer,buyer)
          && row.presentation.challenge.sessionNonce===challenge.sessionNonce))
          fail('seller_challenge_reused','buyer challenge was already presented for another job');
        if(!current?.binding || !same(current.binding,job.binding)) fail('binding-changed','seller presentation binding changed');
        if(current.presentation&&(!expired||!same(current.presentation,expired)))return undefined;
        if(current.counterpartyRecord)fail('seller_vet_reconciliation_required','the seller challenge already has a retained record');
        return {...current,presentation:value};
      })).presentation;
    }
    if(!kept.bundle.presentation){
      if(kept.challenge.expiresAt<=now()) fail('seller_challenge_expired','seller challenge expired before presentation');
      guard(job,'seller presentation');await markWrite(job);guard(job,'seller presentation');
      const raw=await wallet.signBytes(Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(kept.bundle)}`));
      const signature=typeof raw==='string'?raw:Buffer.from(raw).toString('base64url');
      const bundle={...kept.bundle,presentation:{kind:'per-claim',signatures:[{ref:wallet.claim,signature}]}};
      kept=(await state.update(job.jobId,current=>{
        if(!current?.binding || !same(current.binding,job.binding) || !same(current.presentation.challenge,kept.challenge)) fail('binding-changed','seller presentation binding changed');
        if(current.presentation.bundle.presentation)return undefined;
        return {...current,presentation:{...current.presentation,bundle}};
      })).presentation;
    }
    return clone(kept.bundle);
  }
  // A buyer Vet kept in memory for a retry is read back from the anchor again before it is reused.
  async function buyerVetAnchored({recordRef}) {
    const logicalAddress=recordRef.anchor.locator,read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord',fresh:true});
    return read.status==='present'&&contentHash(read.artifact)===recordRef.contentHash&&await validReceipt(read,logicalAddress,read.artifact,wallet.claim);
  }
  // Another provider instance may consume the one-use challenge first. After a
  // failed evaluate the buyer is asked again; only a retained record is taken,
  // and it is verified like any other. Otherwise the evaluate failure stands.
  async function evaluateOrReadRetained(request) {
    try{return await callCounterparty('evaluate',request);}
    catch(error){
      const retained=await callCounterparty('readRecord',request).catch(()=>null);
      if(retained?.status==='present')return retained.record;
      throw error;
    }
  }
  async function produceSeller(job) {
    const identityBundle=await sellerSession(job),authority=job.binding.buyerIdentityBundle.presentedBy;
    const logicalAddress=compositeVerificationAddress(job.jobId,wallet.claim);
    let record=(await state.read(job.jobId))?.counterpartyRecord;
    if(!record){
      guard(job,'counterparty Vet');
      const request={jobId:job.jobId,buyer:authority,seller:wallet.claim,identityBundle,requirement:SELLER_REQUIREMENT};
      // Buyer retains its result before answering evaluate. A lost seller save
      // reads that result; only an exact, authoritative unattempted nonce may
      // start evaluation. Absence/unknown never authorizes another consumption.
      const retained=await callCounterparty('readRecord',request);
      if(retained?.status==='present')record=retained.record;
      else if(unattempted(retained,request))record=await evaluateOrReadRetained(request);
      else fail('seller_vet_reconciliation_required','the buyer nonce ledger has no authoritative outcome');
      const strict=await strictRecord(record,{jobId:job.jobId,bundle:identityBundle,requirement:SELLER_REQUIREMENT,authority});
      if(!sameCanonicalClaimIdentity(record?.signature?.signer,authority) || strict.status!=='valid') fail('seller_vet_invalid',`buyer-issued seller Vet failed strict verification: ${strict.status}:${strict.code}`);
      await state.update(job.jobId,current=>{
        if(!current?.binding || !same(current.binding,job.binding)) fail('binding-changed','counterparty Vet binding changed');
        if(current.counterpartyRecord){if(!same(current.counterpartyRecord,record))fail('conflict','counterparty returned another Vet record');return undefined;}
        return {...current,counterpartyRecord:clone(record)};
      });
    }
    const strict=await strictRecord(record,{jobId:job.jobId,bundle:identityBundle,requirement:SELLER_REQUIREMENT,authority});
    if(!sameCanonicalClaimIdentity(record?.signature?.signer,authority) || strict.status!=='valid')fail('seller_vet_invalid','retained seller Vet is not authenticated by the buyer');
    if(record.overallDecision!=='pass')return {refused:nonPass(record)};
    let read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord'});
    if(read.status!=='present'){
      guard(job,'counterparty anchor');await markWrite(job);
      read=await anchor.publish({logicalAddress,artifact:record,artifactKind:'CompositeVerificationRecord',verifier:authority,authorize:()=>job.open()});
    }
    if(contentHash(read.artifact??{})!==contentHash(record) || !await validReceipt(read,logicalAddress,record,authority))fail('seller_vet_receipt_invalid','seller Vet has no verified finalized anchor receipt');
    const recordRef={anchor:{kind:'storage-program',locator:logicalAddress},contentHash:contentHash(record),signer:authority};
    rememberInvocation({evaluatedParty:wallet.claim,recordRef:clone(recordRef),receipt:clone(read.receipt),record:clone(record),strictStatus:strict.status});
    return {record,recordRef,identityBundle};
  }
  // Marks the job durably before its first signature or anchor intent; from
  // then on its binding is kept, because a write may exist.
  async function markWrite(job) {
    if(job.writeStarted)return;
    await state.update(job.jobId,(current)=>{
      if(!current?.binding||!same(current.binding,job.binding))fail('binding-changed','the job\'s party Vet binding changed; nothing was signed or written');
      if(current.writeStarted)return undefined;
      current.writeStarted=true;
      return current;
    });
    job.writeStarted=true;
  }
  // The caller's purchase check, synchronous: a purchase no longer pending
  // starts no new write. A check that does not answer true at once refuses.
  function guard(job,what) {
    const open=job.open();
    if(open!==true)fail('not-pending',`the purchase is no longer pending (${typeof open==='string'?open:'its check gave no answer'}); no ${what} was made`);
  }
  // The SDK reports a writer failure only as "submission outcome is
  // indeterminate". The writer's cause is kept here as an allowlisted code
  // (its raw text goes to the server log), and the failure starts with it. A
  // cause the SDK then recovered from by readback is cleared.
  async function produce({job,identityBundle,session,lease,role}) {
    const jobId=job.jobId,requirement=role==='buyer'?listing.buyerRequirement:SELLER_REQUIREMENT,address=compositeVerificationAddress(jobId,identityBundle.presentedBy);
    let writerCause=null;
    const writerFailed=(error,out)=>{
      writerCause=writerCode(error,out);
      log(`party-vet-writer: job ${jobId} ${role} CVR ${writerCause}: ${oneLine(out?`${out.status}: ${out.reason ?? 'no reason'}`:`${error?.code ?? 'error'}: ${error?.message ?? error}`)}\n`);
    };
    // The record time of the step being written ahead, while it runs.
    const clock={step:null};
    // Set by a callback that finds the written record's receipt not final yet.
    const wait={pending:false,terminal:false};
    // Preserve native uncertainty before SDK normalization. Definitive evidence
    // from any later fallback wins over an earlier unresolved observation.
    const anchorCall=async(work)=>{
      try{
        const out=await work();
        if(out==='indeterminate'||out?.status==='indeterminate'){
          wait.pending=true;throw Object.assign(new Error('Vet anchor evidence is not known yet'),{code:'indeterminate'});
        }
        if(out==='invalid'||out?.status==='rejected')wait.terminal=true;
        return out;
      }catch(error){
        if(RETRYABLE_ANCHOR_CODES.has(error?.code))wait.pending=true;else wait.terminal=true;
        throw error;
      }
    };
    const durable=durableOperationStore(state,job,role,{now,clock,wait});
    const sign=async(bytes)=>{
      let stored;
      try{guard(job,'signature');await markWrite(job);stored=await durable.writeAhead(bytes);guard(job,'signature');}
      catch(error){writerFailed(error);throw error;}
      // The purchase was read again just above, with no await before the
      // signer: one cancelled while the mark or the bytes were stored signs
      // nothing. A retained signature is replayed; an interrupted reservation
      // holds instead of calling the signer again.
      if(stored)return stored;
      const raw=await wallet.signBytes(bytes),signature=typeof raw==='string'?raw:Buffer.from(raw).toString('base64url');
      try{await durable.recordSignature(bytes,signature);}catch(error){writerFailed(error);throw error;}
      return signature;
    };
    const made=await partyVetCore({jobId,evaluatedParty:identityBundle.presentedBy,identityBundle,requirement,attempts:[]},{
      proxyFetch:async()=>{throw new Error('empty demo requirement cannot invoke a proxy');},nowMs:()=>clock.step?.generatedAt ?? now(),
      componentSigner:{algorithm:'ed25519',signer:wallet.claim,sign},
      anchorFinalizedArtifact:async({logicalAddress,artifact})=>{
        writerCause=null;
        let out;
        try{
          if(job.open()===true){
            await markWrite(job);
            // The anchor asks again under its key lock, right before it
            // stores the intent: a purchase cancelled meanwhile stores none
            // and sends nothing.
            out=await anchorCall(()=>anchor.publish({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord',authorize:()=>job.open()}));
          }else{
            // Readback only: a read never creates an intent.
            out=await anchorCall(()=>anchor.read({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord'}));
            if(out.status==='absent')fail('not-pending','the purchase is no longer pending; no new Vet write was started');
          }
        }catch(error){writerFailed(error);throw error;}
        if(out.status!=='present'){wait.terminal=true;writerFailed(null,out);throw new Error(out.reason ?? 'Vet publication held');}
        return{ref:{anchor:{kind:'storage-program',locator:out.receipt.nativeAddress},contentHash:contentHash(artifact),signer:wallet.claim},receipt:out.receipt};
      },
      verifyFinalizedAnchor:async({logicalAddress,artifact,receipt})=>(await anchorCall(()=>anchor.verifyReceipt({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord',receipt})))==='valid',
      readAnchoredJson:async(ref)=>{
        const out=await anchorCall(()=>anchor.readRetained({logicalAddress:address,artifactKind:'CompositeVerificationRecord'}));
        if(out.status!=='present')return null;
        if(out.receipt.nativeAddress!==ref.anchor.locator||contentHash(out.artifact)!==ref.contentHash){wait.terminal=true;return null;}
        return out.artifact;
      },
      resolveFinalizedArtifact:async({logicalAddress,contentHash:hash})=>{
        const out=await anchorCall(()=>anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord'}));
        if(out.status!=='present')return null;
        if(contentHash(out.artifact)!==hash){wait.terminal=true;return null;}
        if(PENDING_RECEIPT_STATES.has(out.receipt?.state)){wait.pending=true;throw new Error(`the ${role} Vet receipt is not final yet`);}
        if(out.receipt?.state!=='finalized'||out.receipt?.observationDisposition!=='established')wait.terminal=true;
        writerCause=null;return{ref:{anchor:{kind:'storage-program',locator:out.receipt.nativeAddress},contentHash:hash,signer:wallet.claim},receipt:out.receipt};
      },
      operationStore:durable.operationStore,
      verifyIdentityPresentation:({bundle,signedBytes})=>{const proof=bundle.presentation?.kind==='per-claim'&&bundle.presentation.signatures.find((entry)=>entry.ref===bundle.presentedBy);return Boolean(proof&&verifyComponent({signedBytes,signature:{algorithm:'ed25519',signer:bundle.presentedBy,value:proof.signature}}));},
      componentVerifier:verifier,sessionEffectAuthority:{store:session,leaseToken:{owner:lease.owner,generation:lease.generation}},
    }).catch((error)=>{
      if(writerCause===null)throw error;
      throw new Error(`${role} Vet record write failed (${writerCause}: ${WRITER_CAUSES[writerCause]}); ${String(error?.message ?? error).replaceAll(address,`${role} CVR`)}`,{cause:error});
    });
    const strict=await verifyCompositeVerificationRecord(made.record,{jobId,evaluatedParty:identityBundle.presentedBy,bundleHash:identityBundleHash(identityBundle),requirement,verifier:wallet.claim,freshness:[],dealSpecific:[]},{nowMs:now,resolve:async()=>null,resolveRecipe:async()=>null,isRecipeSignerAuthorized:()=>false,isVerifyResultSignerAuthorized:()=>false,resolvePublicKey:verifier.resolvePublicKey,verify:verifier.verify,verifyAuthorityAttestation:()=> 'unresolved'});
    if(strict.status!=='valid')throw new Error(`party Vet closure failed: ${strict.status}:${strict.code}`);
    const logicalAddress=address,read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord'});
    if(read.status!=='present'||contentHash(read.artifact)!==contentHash(made.record)||!await validReceipt(read,logicalAddress,made.record,wallet.claim))throw new Error('party Vet native readback failed');
    const recordRef={anchor:{kind:'storage-program',locator:logicalAddress},contentHash:contentHash(made.record),signer:wallet.claim};
    if(made.record.overallDecision!=='pass')return{refused:nonPass(made.record)};
    rememberInvocation({evaluatedParty:identityBundle.presentedBy,recordRef:clone(recordRef),nativeRecordRef:clone(made.recordRef),receipt:clone(read.receipt),record:clone(made.record),strictStatus:strict.status});
    return{...made,recordRef};
  }
  // Binds the job durably before any Vet signature. The same binding resumes
  // its operation checkpoints; another binding replaces it only when no write
  // was ever started under it. Before a job's first binding, the anchor's
  // journal keys for its two CVRs are checked passively: an intent there with
  // no binding was written by an earlier server version, and the job is
  // quarantined for good (nothing is read back, signed or sent for it).
  // Answers 'bound', 'conflict' (bound to another binding) or 'legacy'.
  async function bind(job,addresses) {
    for(let tries=0;tries<3;tries+=1){
      const before=await state.read(job.jobId);
      const legacy=before?.binding||before?.quarantine?null:(await Promise.all(addresses.map((logicalAddress)=>anchor.hasIntent(logicalAddress)))).some(Boolean);
      let outcome='retry';
      await state.update(job.jobId,(current)=>{
        if(current?.quarantine){outcome='legacy';return undefined;}
        if(current?.binding&&same(current.binding,job.binding)){outcome='bound';job.writeStarted||=current.writeStarted===true;return undefined;}
        if(current?.binding){
          if(current.writeStarted){outcome='conflict';return undefined;}
          outcome='bound';
          return{binding:clone(job.binding),writeStarted:false,ops:freshOps(),seller:null};
        }
        // No binding now: bind only on a passive check made for this state.
        if(legacy===null)return undefined;
        outcome=legacy?'legacy':'bound';
        return legacy?{quarantine:LEGACY_PARTY_VET_STATE}:{binding:clone(job.binding),writeStarted:false,ops:freshOps(),seller:null};
      });
      if(outcome!=='retry')return outcome;
    }
    fail('indeterminate','the job\'s party Vet state kept changing; nothing was signed or sent');
  }
  // A failed run with no write deletes its row: nothing was signed or written.
  const unbind=(job)=>state.update(job.jobId,(current)=>current?.binding&&same(current.binding,job.binding)&&!current.writeStarted?null:undefined);
  const forget=(job)=>{if(vets.get(job.jobId)===job)vets.delete(job.jobId);};
  // One Vet run per job in this provider, bound to everything that makes it valid for a
  // request: the scope except generatedAt, and the exact buyer identity bundle
  // with its presentation (the scope's bundle hash leaves the presentation
  // out). Another buyer, bundle, Listing pin or term for the job is refused
  // and never joins. A concurrent or repeated request joins the running Vet.
  // A retry uses the job's durable checkpoints and reads back an already
  // anchored record. Unknown signature outcomes require reconciliation; it
  // never repeats a signer or creates another record for the party. A run that
  // fails before any write drops its binding, so a fresh attempt can bind.
  // A request for a finished job reads both records back again before it is
  // answered (recheckFinished), so a receipt that stopped qualifying is refused.
  // The run answers {job,buyerVet,sellerVet}, or {refused:'conflict'|'legacy'}.
  async function recheckFinished(job) {
    if(!await buyerVetAnchored(job.buyerVet))fail('party_vet_unavailable','the buyer Vet no longer has a verified finalized anchor receipt');
    const sellerVet=await produceSeller(job);
    return sellerVet.refused?sellerVet:{job,buyerVet:job.buyerVet,sellerVet};
  }
  function jobVet(scope,buyerIdentityBundle,open) {
    const {generatedAt:_generatedAt,...terms}=scope,binding={scope:terms,buyerIdentityBundle,sellerRequirement:SELLER_REQUIREMENT};
    let job=vets.get(scope.jobId);
    if(job&&!same(job.binding,binding))return Promise.resolve({refused:'conflict'});
    if(!job){job={jobId:scope.jobId,binding:clone(binding),buyerVet:null,running:null,finished:false,writeStarted:false,evicted:false,open};vets.set(scope.jobId,job);}
    if(job.finished&&job.running)return job.running.then(()=>recheckFinished(job));
    if(!job.running){
      job.open=open;
      const addresses=[compositeVerificationAddress(scope.jobId,buyerIdentityBundle.presentedBy),compositeVerificationAddress(scope.jobId,listing.seller.identity.presentedBy)];
      const run=(async()=>{
        const bound=await bind(job,addresses);
        if(bound!=='bound')return{refused:bound};
        try{
          const session=createInMemoryFencedSessionStore();await session.create({jobId:scope.jobId,phase:'settle-pending',now:now()});const leased=await session.acquireLease({jobId:scope.jobId,owner:'devnet-demo-party-vet',ttlMs:300000,now:now()});if(!leased.ok)throw new Error(`party Vet lease failed: ${leased.reason}`);
          await sellerSession(job);
          if(job.buyerVet&&!await buyerVetAnchored(job.buyerVet))fail('party_vet_unavailable','the buyer Vet kept from an earlier attempt no longer has a verified finalized anchor receipt');
          job.buyerVet??=await produce({job,identityBundle:buyerIdentityBundle,session,lease:leased.lease,role:'buyer'});
          if(job.buyerVet.refused)return job.buyerVet;
          const sellerVet=await produceSeller(job);
          if(sellerVet.refused)return sellerVet;
          return{job,buyerVet:job.buyerVet,sellerVet};
        }catch(error){
          // Nothing was signed or written under this binding: drop it before
          // any waiter sees the failure.
          if(!job.writeStarted)await unbind(job).catch(()=>{});
          throw error;
        }
      })();
      job.running=run;running.add(scope.jobId);
      // Registered before any waiter, so a waiter that retries finds this
      // run settled and its entry already updated. A finished run is kept
      // for later requests of the job. An ended job's row waits for its run.
      const settled=()=>{running.delete(scope.jobId);if(drops.has(scope.jobId))drop(scope.jobId).catch(logged('deletion',scope.jobId));};
      run.then((out)=>{job.finished=Boolean(out.buyerVet);if(!job.finished){job.running=null;forget(job);}else if(job.evicted)forget(job);settled();},()=>{
        job.running=null;
        if(!job.writeStarted||job.evicted)forget(job);
        settled();
      });
    }
    return job.running;
  }
  // Request membership is independent of proof production and descriptor pinning.
  const bindingFor=(scope,buyerIdentityBundle)=>{const {generatedAt,...terms}=scope;return{scope:terms,buyerIdentityBundle,sellerRequirement:SELLER_REQUIREMENT};};
  const validate=(scope)=>{requireJobId(scope?.jobId);if(!Number.isSafeInteger(scope.generatedAt)||scope.generatedAt<0)fail('context_time_invalid','context time must be a nonnegative safe integer');};
  const eligible=(row,ticket)=>Boolean(row?.binding&&same(row.binding,ticket.binding)
    &&row.lifecycle?.incarnation===ticket.incarnation&&row.lifecycle.epoch===ticket.epoch
    &&row.lifecycle.state!=='ended'&&row.lifecycle.times.includes(ticket.time)
    &&(row.lifecycle.state==='open'||row.lifecycle.selected===ticket.time));
  const ticketFor=(row,time)=>({binding:clone(row.binding),incarnation:row.lifecycle.incarnation,epoch:row.lifecycle.epoch,time});
  const authorized=(row,ticket)=>{if(!eligible(row,ticket))fail('context_released','the context request is no longer authorized');};
  async function admit(scope,buyerIdentityBundle){
    validate(scope);assertAccess(buyerIdentityBundle.presentedBy);
    const job={jobId:scope.jobId,binding:bindingFor(scope,buyerIdentityBundle),writeStarted:false};
    const addresses=[buyerIdentityBundle.presentedBy,wallet.claim].map(party=>compositeVerificationAddress(job.jobId,party));
    const bound=await bind(job,addresses);if(bound!=='bound')return{refused:bound};
    const row=await state.update(job.jobId,current=>{
      if(!current?.binding||!same(current.binding,job.binding))fail('binding-changed','context binding changed before admission');
      if(!current.lifecycle&&current.seller)fail('context_lifecycle_uncertain','the retained context has no provable lifecycle membership');
      current.lifecycle??={incarnation:randomUUID(),epoch:0,state:'open',times:[]};
      const life=current.lifecycle;
      if(life.state==='ended'||(life.state==='selected'&&life.selected!==scope.generatedAt))fail('context_released','the context request was released');
      if(life.times.includes(scope.generatedAt))return undefined;
      if(life.state!=='open'||life.times.length>=CONTEXT_TIMES)fail('context_capacity','no further context request times can be admitted');
      life.times.push(scope.generatedAt);return current;
    });
    return{ticket:ticketFor(row,scope.generatedAt)};
  }
  const descriptor=(input,vetRequirements)=>{const {generatedAt,...base}=input;return{input:base,vetRequirements};};
  const proofIdentity=(row)=>{
    const checkpoints=Object.values(row.ops?.buyer?.checkpoints??{}).filter(value=>['composite-submitting','complete'].includes(value.stage)&&value.record);
    if(checkpoints.length!==1||!row.counterpartyRecord||!row.presentation?.bundle?.presentation)return null;
    return{buyer:checkpoints[0].record,seller:row.counterpartyRecord,sellerBundle:row.presentation.bundle};
  };
  // All adapters authenticate these exact checkpoint identities at canonical addresses.
  async function project(row,time){
    const expected=proofIdentity(row);if(!expected)return null;
    const buyerIdentityBundle=row.binding.buyerIdentityBundle,scope={...row.binding.scope,generatedAt:time};
    const records=[],requirements=[];
    for(const [role,bundle,authority,requirement] of [['buyer',buyerIdentityBundle,wallet.claim,listing.buyerRequirement],['seller',expected.sellerBundle,buyerIdentityBundle.presentedBy,SELLER_REQUIREMENT]]){
      const logicalAddress=compositeVerificationAddress(row.jobId,bundle.presentedBy);
      const read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord',fresh:true});
      if(read?.status!=='present'||!same(read.artifact,expected[role]))return null;
      const strict=await strictRecord(read.artifact,{jobId:row.jobId,bundle,requirement,authority});
      if(strict.status!=='valid'||!sameCanonicalClaimIdentity(read.artifact.signature?.signer,authority)
        ||!await validReceipt(read,logicalAddress,read.artifact,authority))return null;
      if(read.artifact.overallDecision!=='pass')return{refused:nonPass(read.artifact)};
      const recordRef={anchor:{kind:'storage-program',locator:logicalAddress},contentHash:contentHash(read.artifact),signer:authority};
      records.push({identityBundle:clone(bundle),vetRecordRef:recordRef});
      requirements.push({vetRecordRef:clone(recordRef),evaluatedParty:bundle.presentedBy,requirement:clone(requirement),verifier:authority,freshness:[],dealSpecific:[]});
    }
    const input={jobId:row.jobId,verifiedListing:{disposition:'verified',listing,pin:listingPin(listing)},buyer:records[0],seller:records[1],selectedRail:{...DEM_RAIL},payoutBindings:[{railId:DEM_RAIL.railId,phaseIndex:protocolSupport(listing).phases.payment,payeeAddress:scope.payee}],generatedAt:time};
    const value=descriptor(input,requirements);
    if(row.seller&&(!same(row.seller.input,value.input)||!same(row.seller.vetRequirements,value.vetRequirements)))return null;
    return{scope,input,vetRequirements:requirements,proofs:expected};
  }
  function checkCandidate(row,ticket,candidate){
    authorized(row,ticket);
    if(!same(proofIdentity(row),candidate.proofs))fail('binding-changed','the exact context proofs changed');
    if(row.seller&&(!same(row.seller.input,descriptor(candidate.input,candidate.vetRequirements).input)||!same(row.seller.vetRequirements,candidate.vetRequirements)))fail('conflict','the pinned context changed');
  }
  // The final store operation is the acceptance point; no external awaits follow.
  async function finish(jobId,ticket,candidate,write=false){
    if(releasing.has(jobId))fail('context_released','the context is being released');
    if(write)await state.update(jobId,row=>{checkCandidate(row,ticket,candidate);if(row.seller)return undefined;row.seller=clone(descriptor(candidate.input,candidate.vetRequirements));return row;});
    else checkCandidate(await state.read(jobId),ticket,candidate);
    if(releasing.has(jobId))fail('context_released','the context is being released');
    const key=canonicalize(candidate.scope);contexts.set(key,clone({scope:candidate.scope,input:candidate.input,vetRequirements:candidate.vetRequirements}));
    while(contexts.size>CONTEXT_TIMES)contexts.delete(contexts.keys().next().value);
    return candidate;
  }
  const buyerAnswer=value=>({disposition:'present',value:{scope:clone(value.scope),input:clone(value.input)}});
  async function resolveBuyer({scope,buyerIdentityBundle},{writable=()=>true}={}){
    validate(scope);assertAccess(buyerIdentityBundle.presentedBy);
    if(!counterpartyReady())return{disposition:'rejected',code:'counterparty_vet_required',reason:'a buyer verifier and its challenge ledger are required'};
    for(const [key,row] of await store.entries())if(key.startsWith('seller-challenge/')&&!(await state.read(row.jobId)))await store.update(key,current=>current?.jobId===row.jobId?null:undefined);
    const admitted=await admit(scope,buyerIdentityBundle);
    if(admitted.refused)return{disposition:'rejected',code:admitted.refused==='legacy'?LEGACY_PARTY_VET_STATE:'context_conflict',reason:admitted.refused==='legacy'?LEGACY_REASON:'context binding conflict'};
    const produced=await jobVet(scope,buyerIdentityBundle,writable);
    if(produced.refused)return typeof produced.refused==='object'?produced.refused:{disposition:'rejected',reason:'context binding conflict'};
    const row=await state.read(scope.jobId);authorized(row,admitted.ticket);
    const candidate=await project(row,scope.generatedAt);if(candidate?.refused)return candidate.refused;if(!candidate)fail('party_vet_unavailable','the exact context proofs do not authenticate');
    return buyerAnswer(await finish(scope.jobId,admitted.ticket,candidate,true));
  }
  async function readCandidate(scope,buyerIdentityBundle){
    validate(scope);assertAccess(buyerIdentityBundle.presentedBy);
    const row=await state.read(scope.jobId);
    if(!row?.lifecycle||!same(row.binding,bindingFor(scope,buyerIdentityBundle)))return null;
    const ticket=ticketFor(row,scope.generatedAt);if(!eligible(row,ticket))return null;
    const candidate=await project(row,scope.generatedAt);if(!candidate||candidate.refused)return candidate;
    try{return await finish(scope.jobId,ticket,candidate);}catch{return null;}
  }
  async function recoverBuyer({scope,buyerIdentityBundle}){
    const candidate=await readCandidate(scope,buyerIdentityBundle);return candidate?.refused??(candidate?buyerAnswer(candidate):null);
  }
  async function resolveSeller({jobId,listingPin:pin,buyerIdentityBundle,generatedAt}){
    validate({jobId,generatedAt});assertAccess(buyerIdentityBundle.presentedBy);
    const row=await state.read(jobId);
    if(!row?.lifecycle)return{disposition:'indeterminate',reason:'buyer context is not retained'};
    const ticket=ticketFor(row,generatedAt);
    if(!eligible(row,ticket))return{disposition:'rejected',reason:'the context request was released'};
    if(!same(row.binding.buyerIdentityBundle,buyerIdentityBundle)||!same(row.binding.scope.listingPin,pin))return{disposition:'rejected',reason:'seller context differs from buyer context'};
    // A completed route can only identify an already admitted candidate.
    if(!row.seller&&retainedScope){
      const scope=await retainedScope({jobId,buyer:buyerIdentityBundle.presentedBy});
      if(!scope||!same(bindingFor(scope,buyerIdentityBundle),row.binding)||scope.generatedAt!==generatedAt)return{disposition:'indeterminate',reason:'completed route differs'};
    }
    const candidate=await project(row,generatedAt);
    if(!candidate||candidate.refused)return{disposition:'indeterminate',reason:'party Vet receipts no longer authenticate'};
    try{await finish(jobId,ticket,candidate);}catch{return{disposition:'indeterminate',reason:'the context lifecycle changed'};}
    return{disposition:'present',value:{input:clone(candidate.input),vetRequirements:clone(candidate.vetRequirements)}};
  }
  async function resumableBuyer({scope,buyerIdentityBundle}){
    validate(scope);assertAccess(buyerIdentityBundle.presentedBy);
    const row=await state.read(scope.jobId);if(!row?.lifecycle||!same(row.binding,bindingFor(scope,buyerIdentityBundle)))return null;
    const ticket=ticketFor(row,scope.generatedAt);if(!eligible(row,ticket))return null;
    let writes=0,cut=false;
    for(const party of [buyerIdentityBundle.presentedBy,wallet.claim]){
      const logicalAddress=compositeVerificationAddress(scope.jobId,party);
      if(!(await anchor.hasIntent(logicalAddress))){writes++;continue;}
      const read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord',fresh:true});
      if(isProvenUnsignedAbsence(read)){writes++;cut=true;continue;}
      if(read?.status!=='present')return null;
      const seller=party===wallet.claim,bundle=seller?row.presentation?.bundle:buyerIdentityBundle;
      const expected=seller?row.counterpartyRecord:Object.values(row.ops?.buyer?.checkpoints??{}).find(value=>value.record)?.record;
      const authority=seller?buyerIdentityBundle.presentedBy:wallet.claim,requirement=seller?SELLER_REQUIREMENT:listing.buyerRequirement;
      if(!bundle||!expected||!same(read.artifact,expected)||read.artifact.overallDecision!=='pass'
        ||(await strictRecord(read.artifact,{jobId:scope.jobId,bundle,requirement,authority})).status!=='valid'
        ||!await validReceipt(read,logicalAddress,read.artifact,authority))return null;
    }
    const current=await state.read(scope.jobId);
    return cut&&eligible(current,ticket)&&same([current.presentation??null,current.counterpartyRecord??null,current.ops?.buyer?.checkpoints??{}],[row.presentation??null,row.counterpartyRecord??null,row.ops?.buyer?.checkpoints??{}])?{writes}:null;
  }
  const logged=(what,jobId)=>(error)=>log(`party-vet-store: job ${jobId} ${what} failed: ${oneLine(error?.code??'error')}\n`);
  function evict(jobId,generatedAt){
    const job=vets.get(jobId);if(job){if(generatedAt===null)job.open=()=>false;job.evicted=true;if(!job.running||job.finished)forget(job);}
    for(const [key,entry] of contexts)if(entry.input.jobId===jobId&&entry.input.generatedAt!==generatedAt)contexts.delete(key);
  }
  async function drop(jobId){
    requireJobId(jobId);evict(jobId,null);drops.add(jobId);
    let removed=false;
    const ended=await state.update(jobId,row=>{
      if(!row)return undefined;
      if(row.lifecycle?.state!=='ended'){row.lifecycle={...(row.lifecycle??{incarnation:randomUUID(),epoch:0,times:[]}),epoch:(row.lifecycle?.epoch??0)+1,state:'ended',times:[]};return row;}
      return undefined;
    });
    await state.update(jobId,row=>{
      if(!row){removed=true;return undefined;}
      if(row.lifecycle?.state!=='ended'||row.lifecycle.incarnation!==ended?.lifecycle?.incarnation||row.lifecycle.epoch!==ended?.lifecycle?.epoch)return undefined;
      if(running.has(jobId)||Object.values(row.ops??{}).some(ops=>Object.values(ops.steps??{}).some(step=>step.state==='pending')))return undefined;
      removed=true;return null;
    });
    if(removed){for(const [key,row] of await store.entries())if(key.startsWith('seller-challenge/')&&row.jobId===jobId)await store.update(key,current=>current?.jobId===jobId?null:undefined);drops.delete(jobId);}
    return removed;
  }
  function release({jobId,generatedAt=null}){
    requireJobId(jobId);if(generatedAt!==null)validate({jobId,generatedAt});
    evict(jobId,generatedAt);releasing.set(jobId,(releasing.get(jobId)??0)+1);
    const completion=generatedAt===null?drop(jobId).then(deleted=>({invalidated:true,deleted})):state.update(jobId,row=>{
      if(!row?.lifecycle||!row.lifecycle.times.includes(generatedAt)||row.lifecycle.state==='ended')fail('context_released','selection requires an admitted open request');
      const life=row.lifecycle;
      if(life.state==='selected'){if(life.selected!==generatedAt)fail('context_released','the job already selected another request');return undefined;}
      row.lifecycle={...life,epoch:life.epoch+1,state:'selected',selected:generatedAt,times:[generatedAt]};return row;
    }).then(row=>({selected:generatedAt,epoch:row.lifecycle.epoch}));
    // Optional callback callers may ignore completion; awaiting callers see failures.
    const settled=()=>{const count=releasing.get(jobId);if(count===1)releasing.delete(jobId);else releasing.set(jobId,count-1);};
    void completion.then(settled,error=>{settled();logged('release',jobId)(error);});return completion;
  }
  async function sweep(ended){let deleted=0;for(const jobId of await state.jobs())if(ended(jobId)===true&&await drop(jobId))deleted++;return{deleted,usage:store.usage?.()??null};}
  return{resolveBuyer,recoverBuyer,resumableBuyer,resolveSeller,release,sweep,usage:()=>store.usage?.()??null,assertBuyerAccess:assertAccess,contexts,invocations};

}

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


const LEGACY_REASON=`${LEGACY_PARTY_VET_STATE}: this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase`;

const CONTEXT_TIMES=16;
const INVOCATION_DIAGNOSTIC_LIMIT=CONTEXT_TIMES*2;
