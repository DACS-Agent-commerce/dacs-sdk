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
  const contexts=new Map(),invocations=[],vets=new Map(),running=new Set(),drops=new Set();
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
  const counterpartyReady = () => counterparty && typeof counterparty.issueChallenge === 'function' && typeof counterparty.evaluate === 'function';
  const strictRecord = (record, {jobId,bundle,requirement,authority}) => verifyCompositeVerificationRecord(record,
    {jobId,evaluatedParty:bundle.presentedBy,bundleHash:identityBundleHash(bundle),requirement,verifier:authority,freshness:[],dealSpecific:[]},
    {nowMs:now,resolve:async()=>null,resolveRecipe:async()=>null,isRecipeSignerAuthorized:()=>false,isVerifyResultSignerAuthorized:()=>false,
      resolvePublicKey:signature=>signature.signer===authority?authority:null,verify:verifier.verify,verifyAuthorityAttestation:()=> 'unresolved'});
  const validReceipt = async (read,logicalAddress,artifact,authority) => read?.status==='present'
    && ['accepted','included','finalized'].includes(read.receipt?.state)
    && await anchor.verifyReceipt({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord',receipt:read.receipt,verifier:authority})==='valid';
  async function sellerSession(job) {
    let kept=(await state.read(job.jobId))?.presentation;
    if(!kept){
      if(!counterpartyReady()) fail('counterparty_vet_required','a buyer verifier and its challenge ledger are required');
      const buyer=job.binding.buyerIdentityBundle.presentedBy;
      const challenge=await counterparty.issueChallenge({jobId:job.jobId,buyer,seller:wallet.claim});
      if(challenge?.issuer!==buyer || challenge?.jobId!==job.jobId || challenge?.seller!==wallet.claim
        || !/^[a-f0-9]{64}$/.test(challenge?.sessionNonce??'') || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt<=now()) fail('seller_challenge_invalid','buyer challenge is not bound to this session');
      const {presentation:_publicationProof,...identity}=listing.seller.identity;
      const value={challenge:clone(challenge),bundle:{...identity,presentedAt:now(),sessionNonce:challenge.sessionNonce}};
      kept=(await state.update(job.jobId,(current,rows)=>{
        // Claim the nonce in the job row, under the store transaction. It is
        // retained across restarts and released with the ended purchase.
        if(rows().some(([,row])=>row.jobId!==job.jobId && row.writer===wallet.claim
          && row.presentation?.challenge?.issuer===buyer
          && row.presentation.challenge.sessionNonce===challenge.sessionNonce))
          fail('seller_challenge_reused','buyer challenge was already presented for another job');
        if(!current?.binding || !same(current.binding,job.binding)) fail('binding-changed','seller presentation binding changed');
        if(current.presentation)return undefined;
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
  async function contextAuthentic(input) {
    for(const [role,authority,requirement] of [['buyer',wallet.claim,listing.buyerRequirement],['seller',input.buyer.identityBundle.presentedBy,SELLER_REQUIREMENT]]){
      const bundle=input[role].identityBundle,ref=input[role].vetRecordRef;
      const logicalAddress=compositeVerificationAddress(input.jobId,bundle.presentedBy);
      const read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord',fresh:true});
      if(read.status!=='present' || ref.signer!==authority || contentHash(read.artifact)!==ref.contentHash
        || !await validReceipt(read,logicalAddress,read.artifact,authority))return false;
      if((await strictRecord(read.artifact,{jobId:input.jobId,bundle,requirement,authority})).status!=='valid')return false;
    }
    return true;
  }
  async function produceSeller(job) {
    const identityBundle=await sellerSession(job),authority=job.binding.buyerIdentityBundle.presentedBy;
    const logicalAddress=compositeVerificationAddress(job.jobId,wallet.claim);
    let record=(await state.read(job.jobId))?.counterpartyRecord;
    if(!record){
      guard(job,'counterparty Vet');
      record=await counterparty.evaluate({jobId:job.jobId,buyer:authority,seller:wallet.claim,identityBundle:clone(identityBundle),requirement:clone(SELLER_REQUIREMENT)});
      const strict=await strictRecord(record,{jobId:job.jobId,bundle:identityBundle,requirement:SELLER_REQUIREMENT,authority});
      if(record?.signature?.signer!==authority || strict.status!=='valid') fail('seller_vet_invalid',`buyer-issued seller Vet failed strict verification: ${strict.status}:${strict.code}`);
      await state.update(job.jobId,current=>{
        if(!current?.binding || !same(current.binding,job.binding)) fail('binding-changed','counterparty Vet binding changed');
        if(current.counterpartyRecord){if(!same(current.counterpartyRecord,record))fail('conflict','counterparty returned another Vet record');return undefined;}
        return {...current,counterpartyRecord:clone(record)};
      });
    }
    const strict=await strictRecord(record,{jobId:job.jobId,bundle:identityBundle,requirement:SELLER_REQUIREMENT,authority});
    if(record?.signature?.signer!==authority || strict.status!=='valid')fail('seller_vet_invalid','retained seller Vet is not authenticated by the buyer');
    if(record.overallDecision!=='pass')return {refused:nonPass(record)};
    let read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord'});
    if(read.status!=='present'){
      guard(job,'counterparty anchor');await markWrite(job);
      read=await anchor.publish({logicalAddress,artifact:record,artifactKind:'CompositeVerificationRecord',verifier:authority,authorize:()=>job.open()});
    }
    if(contentHash(read.artifact??{})!==contentHash(record) || !await validReceipt(read,logicalAddress,record,authority))fail('seller_vet_receipt_invalid','seller Vet has no verified accepted anchor receipt');
    const recordRef={anchor:{kind:'storage-program',locator:logicalAddress},contentHash:contentHash(record),signer:authority};
    invocations.push({evaluatedParty:wallet.claim,recordRef:clone(recordRef),receipt:clone(read.receipt),record:clone(record),strictStatus:strict.status});
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
    const durable=durableOperationStore(state,job,role,{now,clock});
    const sign=async(bytes)=>{
      let stored;
      try{guard(job,'signature');await markWrite(job);stored=await durable.writeAhead(bytes);guard(job,'signature');}
      catch(error){writerFailed(error);throw error;}
      // The purchase was read again just above, with no await before the
      // signer: one cancelled while the mark or the bytes were stored signs
      // nothing. A retained signature is replayed; otherwise the deterministic,
      // side-effect-free signer may be called again on these immutable bytes.
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
            out=await anchor.publish({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord',authorize:()=>job.open()});
          }else{
            // Readback only: a read never creates an intent.
            out=await anchor.read({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord'});
            if(out.status==='absent')fail('not-pending','the purchase is no longer pending; no new Vet write was started');
          }
        }catch(error){writerFailed(error);throw error;}
        if(out.status!=='present'){writerFailed(null,out);throw new Error(out.reason ?? 'Vet publication held');}
        return{ref:{anchor:{kind:'storage-program',locator:out.receipt.nativeAddress},contentHash:contentHash(artifact),signer:wallet.claim},receipt:out.receipt};
      },
      verifyFinalizedAnchor:async({logicalAddress,artifact,receipt})=>(await anchor.verifyReceipt({logicalAddress,artifact,artifactKind:'CompositeVerificationRecord',receipt}))==='valid',
      readAnchoredJson:async(ref)=>{const out=await anchor.readRetained({logicalAddress:address,artifactKind:'CompositeVerificationRecord'});return out.status==='present'&&out.receipt.nativeAddress===ref.anchor.locator&&contentHash(out.artifact)===ref.contentHash?out.artifact:null;},
      resolveFinalizedArtifact:async({logicalAddress,contentHash:hash})=>{const out=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord'});if(out.status!=='present'||contentHash(out.artifact)!==hash)return null;writerCause=null;return{ref:{anchor:{kind:'storage-program',locator:out.receipt.nativeAddress},contentHash:hash,signer:wallet.claim},receipt:out.receipt};},
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
    invocations.push({evaluatedParty:identityBundle.presentedBy,recordRef:clone(recordRef),nativeRecordRef:clone(made.recordRef),receipt:clone(read.receipt),record:clone(made.record),strictStatus:strict.status});
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
  // anchored record. If the signature checkpoint is missing, it may call the
  // deterministic, side-effect-free signer again on the immutable bytes; it
  // never produces a second record or a second CREATE for the party. A run that
  // fails before any write drops its binding, so a fresh attempt can bind.
  // The run answers {job,buyerVet,sellerVet}, or {refused:'conflict'|'legacy'}.
  function jobVet(scope,buyerIdentityBundle,open) {
    const {generatedAt:_generatedAt,...terms}=scope,binding={scope:terms,buyerIdentityBundle,sellerRequirement:SELLER_REQUIREMENT};
    let job=vets.get(scope.jobId);
    if(job&&!same(job.binding,binding))return Promise.resolve({refused:'conflict'});
    if(!job){job={jobId:scope.jobId,binding:clone(binding),buyerVet:null,running:null,finished:false,writeStarted:false,evicted:false,open};vets.set(scope.jobId,job);}
    if(!job.running){
      job.open=open;
      const addresses=[compositeVerificationAddress(scope.jobId,buyerIdentityBundle.presentedBy),compositeVerificationAddress(scope.jobId,listing.seller.identity.presentedBy)];
      const run=(async()=>{
        const bound=await bind(job,addresses);
        if(bound!=='bound')return{refused:bound};
        try{
          const session=createInMemoryFencedSessionStore();await session.create({jobId:scope.jobId,phase:'settle-pending',now:now()});const leased=await session.acquireLease({jobId:scope.jobId,owner:'devnet-demo-party-vet',ttlMs:300000,now:now()});if(!leased.ok)throw new Error(`party Vet lease failed: ${leased.reason}`);
          await sellerSession(job);
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
  // The seller's Agreement step reads the context of the request whose plan
  // was saved, after a restart too: each context is kept in the job's row
  // (the derive input without its generatedAt, the Vet requirements and the
  // request times) before it is answered.
  async function retain(job,input,vetRequirements) {
    const {generatedAt,...base}=input;
    await state.update(job.jobId,(current)=>{
      if(!current?.binding||!same(current.binding,job.binding))fail('binding-changed','the job\'s party Vet binding changed; no context was kept');
      const kept=current.seller;
      if(kept&&(!same(kept.input,base)||!same(kept.vetRequirements,vetRequirements)))fail('conflict','the job\'s retained Agreement context differs');
      if(kept?.generatedAts.includes(generatedAt))return undefined;
      current.seller={input:clone(base),vetRequirements:clone(vetRequirements),generatedAts:[...(kept?.generatedAts ?? []),generatedAt].slice(-CONTEXT_TIMES)};
      return current;
    });
  }
  // writable: the caller's purchase check, run again right before each Vet
  // signature and each anchor intent; synchronous, true or the reason no new
  // write may start.
  async function resolveBuyer({scope,buyerIdentityBundle},{writable=()=>true}={}) {
    requireJobId(scope?.jobId);
    assertAccess(buyerIdentityBundle.presentedBy);
    if(!counterpartyReady())return {disposition:'rejected',code:'counterparty_vet_required',reason:'a buyer verifier and its challenge ledger are required'};
    // Upgrade cleanup: earlier versions retained a second fence row after the
    // job itself was deleted. Such ended jobs no longer own a challenge.
    for(const [key,row] of await store.entries())if(key.startsWith('seller-challenge/') && !(await state.read(row.jobId)))
      await store.update(key,current=>current?.jobId===row.jobId?null:undefined);
    const produced=await jobVet(scope,buyerIdentityBundle,writable);
    if(produced.refused?.code==='party_vet_non_pass')return produced.refused;
    if(produced.refused==='legacy')return{disposition:'rejected',reason:LEGACY_REASON,code:LEGACY_PARTY_VET_STATE};
    if(produced.refused)return{disposition:'rejected',reason:'demo Agreement context scope conflict'};
    const {job,buyerVet,sellerVet}=produced;
    const input={jobId:scope.jobId,verifiedListing:{disposition:'verified',listing,pin:listingPin(listing)},buyer:{identityBundle:buyerIdentityBundle,vetRecordRef:buyerVet.recordRef},seller:{identityBundle:sellerVet.identityBundle,vetRecordRef:sellerVet.recordRef},selectedRail:{...DEM_RAIL},payoutBindings:[{railId:DEM_RAIL.railId,phaseIndex:protocolSupport(listing).phases.payment,payeeAddress:scope.payee}],generatedAt:scope.generatedAt};
    const vetRequirements=[buyerVet,sellerVet].map((vet,index)=>({vetRecordRef:clone(vet.recordRef),evaluatedParty:vet.record.evaluatedParty,requirement:clone(index===0?listing.buyerRequirement:SELLER_REQUIREMENT),verifier:index===0?wallet.claim:buyerIdentityBundle.presentedBy,freshness:[],dealSpecific:[]}));
    if(!await contextAuthentic(input))fail('party_vet_unavailable','party Vet receipts no longer authenticate');
    await retain(job,clone(input),vetRequirements);
    // One context per exact scope: a later plan request carries a new
    // generatedAt and reuses the job's Vet refs.
    contexts.set(canonicalize(scope),{scope:clone(scope),input:clone(input),vetRequirements});return{disposition:'present',value:{scope:clone(scope),input:clone(input)}};
  }
  // The seller context route's reconciliation of an uncertain step (a crash
  // or lost answer after the Vet writes): read only. Both canonical Vet records
  // are read back from the seller's retained CREATEs (#19 readRetained) and
  // verified strictly; with either absent or invalid the step stays uncertain.
  // Nothing is written and no Vet is produced again; neither is the job's party
  // Vet row. The recovered context is kept in this process under its exact
  // scope, unless the job already has a context with another scope.
  async function recoverBuyer({scope,buyerIdentityBundle}) {
    requireJobId(scope?.jobId);
    assertAccess(buyerIdentityBundle.presentedBy);
    const retained=await state.read(scope.jobId);
    const sellerIdentity=retained?.presentation?.bundle;
    const {generatedAt:_time,...terms}=scope;
    if(!sellerIdentity?.presentation || !same(retained.binding?.scope,terms) || !same(retained.binding?.buyerIdentityBundle,buyerIdentityBundle))return null;
    const records=[];
    for(const bundle of [buyerIdentityBundle,sellerIdentity]){
      const logicalAddress=compositeVerificationAddress(scope.jobId,bundle.presentedBy),read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord',fresh:true});
      if(read.status!=='present')return null;
      const authority=bundle.presentedBy===wallet.claim?buyerIdentityBundle.presentedBy:wallet.claim;
      const strict=await strictRecord(read.artifact,{jobId:scope.jobId,bundle,requirement:bundle.presentedBy===wallet.claim?SELLER_REQUIREMENT:listing.buyerRequirement,authority});
      if(strict.status!=='valid'||read.artifact.signature?.signer!==authority||!await validReceipt(read,logicalAddress,read.artifact,authority))return null;
      if(read.artifact.overallDecision!=='pass')return nonPass(read.artifact);
      records.push({recordRef:{anchor:{kind:'storage-program',locator:logicalAddress},contentHash:contentHash(read.artifact),signer:authority},record:read.artifact,identityBundle:bundle});
    }
    const [buyerVet,sellerVet]=records;
    const input={jobId:scope.jobId,verifiedListing:{disposition:'verified',listing,pin:listingPin(listing)},buyer:{identityBundle:buyerIdentityBundle,vetRecordRef:buyerVet.recordRef},seller:{identityBundle:sellerVet.identityBundle,vetRecordRef:sellerVet.recordRef},selectedRail:{...DEM_RAIL},payoutBindings:[{railId:DEM_RAIL.railId,phaseIndex:protocolSupport(listing).phases.payment,payeeAddress:scope.payee}],generatedAt:scope.generatedAt};
    const vetRequirements=records.map((vet,index)=>({vetRecordRef:clone(vet.recordRef),evaluatedParty:vet.record.evaluatedParty,requirement:clone(index===0?listing.buyerRequirement:SELLER_REQUIREMENT),verifier:index===0?wallet.claim:buyerIdentityBundle.presentedBy,freshness:[],dealSpecific:[]}));
    if([...contexts.values()].some((entry)=>entry.input.jobId===scope.jobId&&!same(entry.scope,scope)))return null;
    const key=canonicalize(scope);
    if(!contexts.has(key))contexts.set(key,{scope:clone(scope),input:clone(input),vetRequirements});
    return{disposition:'present',value:{scope:clone(scope),input:clone(input)}};
  }
  // After a seller restart the context of a completed route step is recovered
  // for the proposal, read only: only when the durable records name this
  // buyer, Listing, bundle and generatedAt, and only from both Vet records read
  // back and verified strictly (recoverBuyer). Nothing is written or produced.
  // The seller context route's resume of an uncertain step a shutdown cut
  // (seller context route): read only. It answers {writes}, the number
  // of the job's two Vet CREATEs still to make, only when each is read back
  // present, has no intent at all (none was ever asked), or is a 'closing'
  // intent the anchor proves was never signed (a shutdown ended its approval,
  // artifact-anchor.mjs closingAbsence), and at least one is that proven
  // absence. Anything else (an intent whose outcome is unknown) answers null
  // and the step stays uncertain. Running the step again then makes no second
  // CREATE: a present record is read back and a cut one is asked again, as
  // in-process.
  async function resumableBuyer({scope,buyerIdentityBundle}) {
    requireJobId(scope?.jobId);
    assertAccess(buyerIdentityBundle.presentedBy);
    let writes=0,cut=false;
    for(const bundle of [buyerIdentityBundle,listing.seller.identity]){
      const logicalAddress=compositeVerificationAddress(scope.jobId,bundle.presentedBy);
      if(!(await anchor.hasIntent(logicalAddress))){writes+=1;continue;}
      const read=await anchor.readRetained({logicalAddress,artifactKind:'CompositeVerificationRecord'});
      if(isProvenUnsignedAbsence(read)){writes+=1;cut=true;continue;}
      if(read.status!=='present')return null;
    }
    return cut?{writes}:null;
  }
  async function recoverSeller({jobId,pin,buyerIdentityBundle,generatedAt}) {
    requireJobId(jobId);
    if(!retainedScope)return null;
    try{
      const scope=await retainedScope({jobId,buyer:buyerIdentityBundle.presentedBy});
      if(!scope||!same(scope.listingPin,pin)||scope.generatedAt!==generatedAt||scope.buyerBundleHash!==identityBundleHash(buyerIdentityBundle))return null;
      return (await recoverBuyer({scope,buyerIdentityBundle}))?.disposition==='present'?contexts.get(canonicalize(scope))??null:null;
    }catch{return null;}
  }
  // The seller is answered only from a context that matches its request
  // exactly: this process's, or the one kept in the job's row, or
  // (seller context route only) a completed route step's (recoverSeller).
  async function resolveSeller({jobId,listingPin:pin,buyerIdentityBundle,generatedAt}) {
    requireJobId(jobId);
    assertAccess(buyerIdentityBundle.presentedBy);
    const matches=(input)=>same(input.verifiedListing.pin,pin)&&same(input.buyer.identityBundle,buyerIdentityBundle)&&input.generatedAt===generatedAt;
    const answer=(found)=>({disposition:'present',value:{input:clone(found.input),vetRequirements:clone(found.vetRequirements)}});
    const forJob=[...contexts.values()].filter((entry)=>entry.input.jobId===jobId),found=forJob.find((entry)=>matches(entry.input));
    if(found)return await contextAuthentic(found.input)?answer(found):{disposition:'indeterminate',reason:'party Vet receipts no longer authenticate'};
    const kept=(await state.read(jobId))?.seller ?? null;
    const durable=kept?.generatedAts.includes(generatedAt)?{input:{...kept.input,generatedAt},vetRequirements:kept.vetRequirements}:null;
    if(durable&&matches(durable.input)){
      const recovered=await recoverBuyer({scope:{...((await state.read(jobId)).binding.scope),generatedAt},buyerIdentityBundle});
      return recovered?.disposition==='present'?answer(durable):{disposition:'indeterminate',reason:'party Vet receipts no longer authenticate'};
    }
    const recovered=retainedScope?await recoverSeller({jobId,pin,buyerIdentityBundle,generatedAt}):null;
    if(recovered&&matches(recovered.input))return answer(recovered);
    if(!forJob.length&&!kept)return{disposition:'indeterminate',reason:'buyer context is not retained'};
    return{disposition:'rejected',reason:'seller context differs from buyer context'};
  }
  const logged=(what,jobId)=>(error)=>log(`party-vet-store: job ${jobId} ${what} failed: ${oneLine(`${error?.code ?? 'error'}: ${error?.message ?? error}`)}\n`);
  // Deletes an ended job's row once no run of it is left in this process (a
  // run can still wait in a seller approval and write). Its anchor intents
  // stay in the artifact journal, so the job would be quarantined as legacy
  // were it ever asked for again. That is right: an ended purchase is
  // refused before the provider is reached.
  async function drop(jobId) {
    requireJobId(jobId);
    drops.add(jobId);
    if(running.has(jobId))return false;
    await state.update(jobId,()=>null);
    for(const [key,row] of await store.entries())if(key.startsWith('seller-challenge/') && row.jobId===jobId)
      await store.update(key,current=>current?.jobId===jobId?null:undefined);
    drops.delete(jobId);
    return true;
  }
  // Once a job's plan is saved (generatedAt names its request), only that
  // request's context stays, in memory and in the job's row. Once its
  // purchase ended (no generatedAt), its in-memory entries go and its row is
  // deleted.
  function release({jobId,generatedAt=null}) {
    requireJobId(jobId);
    const job=vets.get(jobId);
    if(job){job.evicted=true;if(!job.running||job.finished)forget(job);}
    for(const [key,entry] of contexts)if(entry.input.jobId===jobId&&entry.input.generatedAt!==generatedAt)contexts.delete(key);
    if(generatedAt===null){drop(jobId).catch(logged('deletion',jobId));return;}
    state.update(jobId,(current)=>current?.seller?.generatedAts.includes(generatedAt)&&current.seller.generatedAts.length>1?{...current,seller:{...current.seller,generatedAts:[generatedAt]}}:undefined).catch(logged('context pruning',jobId));
  }
  // Deletes the rows of jobs whose purchase ended (ended(jobId) answers true)
  // without a status change this process saw: lazy expiry, or an end before
  // a restart. A job still running here is kept until its run settles.
  async function sweep(ended) {
    let deleted=0;
    for(const jobId of await state.jobs()){
      requireJobId(jobId);
      if(running.has(jobId)||ended(jobId)!==true)continue;
      if(await drop(jobId))deleted+=1;
    }
    return{deleted,usage:store.usage?.() ?? null};
  }
  return{resolveBuyer,recoverBuyer,resumableBuyer,resolveSeller,release,sweep,usage:()=>store.usage?.() ?? null,
    // The seller context route admits a request with this same guard before any write.
    assertBuyerAccess:assertAccess,contexts,invocations};
}
