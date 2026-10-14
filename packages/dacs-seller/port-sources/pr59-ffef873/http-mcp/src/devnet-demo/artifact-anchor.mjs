import { createImmutableReadbacks } from '../util/immutable-readbacks.mjs';
// Application-owned native publication for the real demo composition. Every
// CREATE is produced by the packaged seller wallet and then accepted only
// after an independent source read, original signed projection, and SDK
// portable receipt verification. A retained intent never reissues a wallet
// request, except one whose approval a shutdown ended before anything was
// signed (stage 'closing'); an accepted, absent operator CREATE may resend
// its original bytes.
import { isNativeDeliveryEvidence } from '../dacs/delivery-evidence.mjs';
import { provenUnsignedAbsence } from '../dacs/native-dem-delivery-consumer.mjs';
import { storageWriteRpcSigner } from './storage-write-recovery.mjs';
import { operatorBuyerAccessConfig } from './buyer-access.mjs';
import { OPERATOR_CLOSING } from './operator-approval.mjs';
import {
  canonicalize,
  contentHash,
  isCompositeVerificationRecord,
  isFinalityCommitmentRecord,
  isListing,
  logicalToStorageProgramName,
  sha256Hex,
} from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, demosSr2TxRef } from '../dacs/demos-sr2-adapter.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../dacs/wallet-transactions.mjs';
import { addressForClaim, verifyDemosSignature } from '../wallet/demos-signature.mjs';
import {
  DEVNET_AGREEMENT_PROFILE,
  DEVNET_DEMO_ARTIFACT_KIND,
  DEVNET_DEMO_ARTIFACT_POLICY,
  DEVNET_DEMO_ARTIFACT_TYPES,
  isDevnetDemoTransport,
} from '../wallet/devnet-native-transport.mjs';

const clone=(v)=>JSON.parse(canonicalize(v));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const exactHash=(v)=>sha256Hex(canonicalize(v));
const heldByAnotherPublisher=(error)=>error?.code==='journal-fenced' && /another holder owns this key/.test(error.message);
const HASH=/^[0-9a-f]{64}$/;
// A retained 'closing' intent was never signed (see publish): it reads as
// absent, so callers publish it again, which asks the operator again.
const CLOSING_ABSENT='a shutdown ended this CREATE\'s approval before anything was signed; publishing it asks again';

function artifactValid(kind,value,writer) {
  if(kind==='Listing') return isListing(value) && value.seller?.identity?.presentedBy===writer;
  if(kind==='CompositeVerificationRecord') return isCompositeVerificationRecord(value) && value.signature?.signer===writer;
  if(kind==='FinalityCommitmentRecord') return isFinalityCommitmentRecord(value) && value.signature?.signer===writer;
  if(kind==='SettlementEvidence')return isNativeDeliveryEvidence(value,writer,`dacs4:evidence:${value.jobId}`);
  return kind==='Deliverable' && value?.reportVersion==='1' && value.kind==='dacs-chatgpt-plugin/devnet-purchased-report'
    && value.producer===writer && value.content?.mediaType==='text/plain; charset=utf-8'
    && typeof value.content.text==='string' && value.content.text.length>0 && value.content.text.length<=16384;
}
function deliveryBindingValid(value,artifact,logicalAddress,hash) {
  return value?.version==='1' && value.profile==='dacs-native-delivery-publication/v1' && value.jobId===artifact.jobId
    && value.phase==='deliver-storage-program' && Number.isSafeInteger(value.phaseIndex) && value.phaseIndex>=0
    && value.listing?.listingId===artifact.listing?.listingId && value.listing?.version===artifact.listing?.version
    && value.listing?.contentHash===artifact.listing?.contentHash && value.agreementHash===artifact.agreementHash
    && typeof value.fulfilmentId==='string' && value.fulfilmentId.length>0 && value.fulfilmentId.length<=128
    && value.purchaseAmount?.currency==='DEM' && typeof value.purchaseAmount.amount==='string'
    && value.payloadHash===hash && logicalAddress===`dacs4:deliverable:${artifact.jobId}`;
}

export function createDevnetDemoArtifactAnchor({ sourceCapability, journal, walletFactory, network, signer, buyerAccess=null, now=()=>Date.now() }) {
  if(!isDevnetDemoTransport(sourceCapability)) throw new TypeError('the explicit devnet demo source capability is required');
  // Only the seller's own Listing has no purchase. Every other write, new or
  // retained, belongs to a job whose current buyer must be admitted first.
  const access=operatorBuyerAccessConfig(buyerAccess);
  const authorizeJob=(artifactKind,jobId)=>{
    if(artifactKind==='Listing') return;
    if(!access) fail('buyer_access_closed','non-Listing demo writes require the operator buyerAccess capability; nothing was read, signed or sent');
    access.assertSellerJob(jobId);
  };
  // A retained intent is authorized by its own signed binding, never the caller's.
  const createBinding=(transaction)=>{const data=transaction?.content?.data?.[1];return{artifactKind:data?.metadata?.artifactKind,jobId:data?.metadata?.artifactBinding?.jobId ?? data?.data?.jobId};};
  const authorizeRetained=(retained)=>{const binding=createBinding(retained?.transaction);authorizeJob(binding.artifactKind,binding.jobId);};
  if(!journal || !['get','put','entries','withWalletLock'].every((key)=>typeof journal[key]==='function')) throw new TypeError('a durable public demo journal is required');
  if(typeof walletFactory!=='function') throw new TypeError('the packaged seller wallet factory is required');
  if(network!==sourceCapability.pins.network) throw new TypeError('demo wallet network differs from the source pin');
  // Verified immutable readbacks are reused only briefly (the short TTL in
  // createImmutableReadbacks), keyed by locator, content hash and the whole
  // signed scope. Vet and commitment entries are also scoped to their job; a
  // Listing has no purchase, so its entry is keyed by locator and content hash
  // alone and lives only for the TTL, never for the whole process. `fresh`
  // reads skip reuse, and a fresh read that does not verify evicts the entry.
  const immutable=createImmutableReadbacks({now});
  const cachedKinds=new Set(['Listing','CompositeVerificationRecord','FinalityCommitmentRecord']);
  const cacheScope=(input,projection,receipt)=>({purchaseId:input.artifact.jobId ?? null,locator:input.logicalAddress,contentHash:input.receiptContentHash,scope:{input,projection,receipt,binding:sourceCapability.transportBinding}});
  const kinds=new Set(sourceCapability.demoArtifactPublication.artifactKinds);
  let delegate;
  const wallet=walletFactory({anchorJournal:{get:(key)=>delegate.get(key),put:(key,value)=>delegate.put(key,value),withWalletLock:(key,work)=>delegate.withWalletLock(key,work)}});
  // Preserve the packaged wallet's exact insertion-ordered public projection;
  // its own journal readback intentionally uses byte-for-byte JSON.stringify.
  delegate={get:(key)=>journal.get(`demo/wallet/${key}`),put:(key,value)=>journal.put(`demo/wallet/${key}`,structuredClone(value)),withWalletLock:(key,work)=>journal.withWalletLock(`demo/wallet/${key}`,work)};
  if(!wallet || typeof wallet.request!=='function' || typeof wallet.getPublicAccount!=='function' || typeof wallet.getWriteProfile!=='function') throw new TypeError('the packaged seller wallet contract is unavailable');
  const reader=createDemosSr2Adapter({rpcUrl:sourceCapability.pins.endpoint,journal:createInMemoryDemosSr2Journal(),sourceCapability,now});
  const owner=wallet.getPublicAccount()?.address;
  const claim=owner ? `did:demos:agent:${owner.slice(2)}` : null;
  const signRpc=storageWriteRpcSigner(signer,claim);
  if(!owner || wallet.getWriteProfile()?.demoArtifactPublication?.policy!==DEVNET_DEMO_ARTIFACT_POLICY) throw new TypeError('the packaged seller wallet does not carry the demo artifact publication policy');
  const keyFor=(logicalAddress)=>`demo/artifact/${exactHash([network,sourceCapability.pins.chainIdentity,claim,logicalAddress])}`;

  async function observeSource(hash,projection,writeProof) {
    let observed=await sourceCapability.binding({phase:'readback',address:owner,hash,...(writeProof?{writeProof}:{})});
    if(observed.disposition==='pending' && signRpc && projection?.content?.type==='storageProgram') {
      await sourceCapability.recoverStorageWrite({signedTransaction:projection,signRpc});
      observed=await sourceCapability.binding({phase:'readback',address:owner,hash});
    }
    return observed;
  }

  async function reconcilePriorSourceLane() {
    const pending=(await sourceCapability.journal.entries()).map(([,value])=>value).filter((value)=>value?.signedTransaction?.content?.from===owner&&value.stage!=='observed');
    const hashes=new Set(pending.map((value)=>value.hash).filter((value)=>typeof value==='string'&&value.length>0));
    if(hashes.size>1) fail('indeterminate','more than one retained seller source transaction requires readback');
    if(hashes.size===1){
      // Named exception (closed-access-19-resend): #19's one unchanged resend
      // may finish another job's accepted-but-missing write after access closed.
      // It adds no transaction signature, approval or nonce; refusing it would
      // fence this lane. The source reports it (operator.mjs logs it).
      const hash=[...hashes][0],observed=await observeSource(hash,await publicProjection(hash));
      if(observed.disposition!=='included') fail('indeterminate',`the retained seller source transaction requires readback (${observed.disposition})`);
    }
  }

  // A crash after the packaged wallet broadcast but before it recorded the
  // answer leaves its own nonce lane at broadcast-started, fencing every later
  // seller CREATE. Release it only after a fresh authenticated readback shows
  // that exact original signed CREATE included; no new transaction is signed.
  async function reconcilePriorWalletLane() {
    const rows=(await journal.entries()).filter(([key,value])=>key.startsWith('demo/wallet/')&&value?.stage==='broadcast-started'&&value?.signedTransaction?.content?.from===owner);
    for(const [key,value] of rows){
      const projection=typeof value.hash==='string'?await publicProjection(value.hash):null;
      if(!projection||value.signedTransaction?.hash!==value.hash||canonicalize(projection)!==canonicalize(value.signedTransaction)) fail('indeterminate','the retained seller wallet CREATE differs from its original public projection');
      const observed=await sourceCapability.binding({phase:'readback',address:owner,hash:value.hash});
      if(observed.disposition!=='included') fail('indeterminate',`the retained seller wallet CREATE requires readback (${observed.disposition})`);
      await journal.withWalletLock(key,async()=>{
        const current=await journal.get(key);
        if(current?.stage==='broadcast-started'&&current.hash===value.hash&&canonicalize(current.signedTransaction)===canonicalize(value.signedTransaction)) await journal.put(key,{...current,stage:'broadcast-accepted'});
      });
    }
  }

  async function publicProjection(hash) {
    const records=(await sourceCapability.journal.entries()).map(([,value])=>value).filter((value)=>value?.hash===hash && value?.signedTransaction);
    if(records.length<1) return null;
    const first=records[0].signedTransaction;
    // The transaction hash signs insertion-ordered JSON, so never rebuild the
    // public projection through canonical JSON even though equality is
    // compared canonically.
    return records.every((entry)=>canonicalize(entry.signedTransaction)===canonicalize(first)) ? structuredClone(first) : null;
  }
  async function observe(input,retained,writeProof,{fresh=false}={}) {
    let hash=retained.hash;
    if(!hash) {
      const candidates=(await sourceCapability.journal.entries()).map(([,value])=>value).filter((value)=>value?.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===input.logicalAddress
        && value.signedTransaction.content.from===owner);
      const hashes=new Set(candidates.map((candidate)=>candidate.hash).filter((candidate)=>typeof candidate==='string'&&candidate.length>0));
      if(hashes.size!==1) return {status:'indeterminate',reason:'the original demo CREATE hash is not uniquely retained',noResend:true};
      hash=[...hashes][0];
      // An unlocked read can race the publisher that still holds this key
      // while its wallet awaits inclusion; that publisher records the hash.
      try { await journal.put(keyFor(input.logicalAddress),{...retained,stage:'issued',hash}); }
      catch(error) { if(heldByAnotherPublisher(error)) return {status:'indeterminate',reason:'the original demo CREATE is still being issued by its publisher',noResend:true}; throw error; }
    }
    const projection=await publicProjection(hash);
    if(!projection) return {status:'indeterminate',reason:'the original public signed CREATE projection is unavailable',noResend:true};
    const cacheable=cachedKinds.has(input.artifactKind),cacheKey=cacheScope(input,projection,retained.receipt ?? null);
    const cached=cacheable&&!fresh?immutable.get(cacheKey):null;
    if(cached){await sourceCapability.observeBinding();return cached;}
    const included=await observeSource(hash,projection,writeProof);
    if(included.disposition!=='included') return {status:'indeterminate',reason:`the original demo CREATE has no authenticated inclusion readback (${included.disposition}: ${included.reason ?? included.error ?? 'no reason'})`,noResend:true};
    const record=await reader.read(input.logicalAddress,{expectedWriter:claim,expectedArtifactKind:input.artifactKind,...(input.deliveryBinding?{expectedDeliveryBinding:input.deliveryBinding}:{}),signedProjection:projection});
    if(record.status!=='present' || canonicalize(record.artifact)!==canonicalize(input.artifact) || record.receipt.contentHash!==input.receiptContentHash) {
      if(cacheable) immutable.delete(cacheKey);
      fail('invalid','native demo artifact readback differs from the retained intent');
    }
    const verdict=await reader.verifyReceipt({receipt:record.receipt,logicalAddress:input.logicalAddress,artifact:input.artifact,expectedWriter:claim,artifactKind:input.artifactKind,receiptContentHash:input.receiptContentHash,signedProjection:projection});
    if(verdict!=='valid') {
      if(cacheable&&verdict==='invalid') immutable.delete(cacheKey);
      return {status:verdict==='indeterminate'?'indeterminate':'rejected',reason:`native demo receipt is ${verdict}`,noResend:true};
    }
    const complete={...retained,stage:'verified',hash,receipt:clone(record.receipt),signedProjection:projection};
    // The readback above is authenticated; if a publisher still holds the key,
    // it persists its own verified record, so this read only skips the cache.
    try { await journal.put(keyFor(input.logicalAddress),complete); }
    catch(error) { if(!heldByAnotherPublisher(error)) throw error; }
    const result={status:'present',artifact:clone(record.artifact),receipt:clone(record.receipt),signedProjection:projection,demosEvidence:clone(record.demosEvidence),
      ref:{anchor:{kind:'storage-program',locator:input.logicalAddress},contentHash:input.receiptContentHash,signer:claim},txRef:demosSr2TxRef(record.receipt),noResend:true};
    if(cachedKinds.has(input.artifactKind))immutable.put(cacheScope(input,projection,record.receipt),result);
    return result;
  }
  // authorize (optional): the caller's own check, called under this address's
  // lock with no await before the intent is stored. Anything but true refuses:
  // no intent is stored and nothing is sent. Without it, publish is unchanged.
  // reaskDenied (optional, a Listing only): a retained intent the packaged
  // wallet refused at its approval (denied: user_rejected, before it signed
  // anything) is replaced under this lock by a fresh intent and asked again.
  // Every other retained intent is only read back, as without it, apart from
  // a 'closing' one (a shutdown ended its approval), which is always asked again.
  async function publish({logicalAddress,artifact,artifactKind,writer=claim,deliveryBinding,authorize,reaskDenied=false}) {
    if(authorize!==undefined&&typeof authorize!=='function') fail('invalid','publish authorization must be a function');
    if(writer!==claim || !kinds.has(artifactKind) || !artifactValid(artifactKind,artifact,writer)) fail('invalid','demo artifact kind, producer, or signed shape differs');
    if(artifactKind==='SettlementEvidence'&&logicalAddress!==`dacs4:evidence:${artifact.jobId}`)fail('invalid','delivery evidence address differs from its job');
    const value=clone(artifact), jobId=value.jobId ?? `listing:${value.listingId}`, receiptContentHash=contentHash(value);
    if((artifactKind==='Deliverable')!==Boolean(deliveryBinding) || (deliveryBinding && !deliveryBindingValid(deliveryBinding,value,logicalAddress,receiptContentHash))) fail('invalid','demo Deliverable is not bound to the exact Agreement, Listing, fulfilment, amount and payload');
    const input={logicalAddress,artifact:value,artifactKind,writer,receiptContentHash,...(deliveryBinding?{deliveryBinding:clone(deliveryBinding)}:{})};
    return journal.withWalletLock(keyFor(logicalAddress),async()=>{
      const retained=await journal.get(keyFor(logicalAddress));
      if(retained) {
        if(retained.inputHash!==exactHash(input)) fail('conflict','immutable demo artifact intent differs');
        authorizeRetained(retained);
        // A shutdown ended its approval before anything was signed: ask again
        // below, from a fresh nonce, as for a new intent.
        const neverSigned=retained.stage==='denied'&&retained.error==='user_rejected'&&retained.hash===undefined;
        if(retained.stage!=='closing'&&!(reaskDenied===true&&artifactKind==='Listing'&&neverSigned)) return observe(input,retained);
      }
      authorizeJob(artifactKind,jobId);
      // Another application seam (for example native SettlementEvidence)
      // may have used this same seller/source nonce lane immediately before
      // delivery. Authenticate and release that exact retained transaction;
      // only retained accepted storage bytes can qualify for recovery.
      await reconcilePriorSourceLane();
      await reconcilePriorWalletLane();
      const response=await sourceCapability.readRpc('/',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:owner}}]});
      const current=response?.response;
      if(response?.result!==200 || !Number.isSafeInteger(current) || current<0) fail('indeterminate','seller nonce is unavailable');
      const nonce=current+1, programName=logicalToStorageProgramName(logicalAddress), storageAddress=deriveStorageAddress(owner,programName,nonce,'');
      const transaction=buildStorageProgramCreatePayload({from:owner,storageAddress,programName,logicalAddress,signedListing:value,nonce,timestamp:now()});
      transaction.content.from_ed25519_address=owner;
      transaction.content.network=network;
      transaction.content.chainIdentity=sourceCapability.pins.chainIdentity;
      const metadata=transaction.content.data[1].metadata;
      metadata.contentHash=receiptContentHash;
      metadata.envelopeHash=exactHash(value);
      metadata.artifactKind=artifactKind;
      metadata.networkBinding=clone(sourceCapability.transportBinding);
      metadata.artifactBinding={version:'1',policy:DEVNET_DEMO_ARTIFACT_POLICY,authority:sourceCapability.demoArtifactPublication.authority,artifactKind,jobId,logicalAddress,writer};
      if(deliveryBinding) metadata.deliveryBinding=clone(deliveryBinding);
      const intent={stage:'intent',inputHash:exactHash(input),input:clone(input),transaction:clone(transaction)};
      if(authorize){
        const allowed=authorize();
        if(allowed!==true) fail('not-authorized',`the caller withdrew this write (${typeof allowed==='string'?allowed.slice(0,160):'no answer'}); no intent was stored and nothing was sent`);
      }
      await journal.put(keyFor(logicalAddress),intent);
      const answer=await wallet.request({method:'sendTransaction',params:[{kind:DEVNET_DEMO_ARTIFACT_KIND,profile:DEVNET_AGREEMENT_PROFILE,network,owner:writer,artifactKind,jobId,
        logicalAddress,contentHash:receiptContentHash,envelopeHash:exactHash(value),transaction}]});
      if(answer?.error?.code===OPERATOR_CLOSING) {
        // Not a decision: the custody reports it only when the approval was
        // cut before signing. The intent stays askable (never denied).
        await journal.put(keyFor(logicalAddress),{...intent,stage:'closing',error:OPERATOR_CLOSING});
        return {status:'indeterminate',reason:`${OPERATOR_CLOSING}: ${answer.error.message ?? 'the operator is closing'}`.slice(0,240),noResend:true};
      }
      if(!answer?.success) {
        await journal.put(keyFor(logicalAddress),{...intent,stage:answer?.error?.code==='user_rejected'?'denied':'issued',error:answer?.error?.code ?? 'wallet-response-missing'});
        return {status:answer?.error?.code==='user_rejected'?'rejected':'indeterminate',reason:`${answer?.error?.code ?? 'wallet-response-missing'}: ${answer?.error?.message ?? 'wallet response missing'}`.slice(0,240),noResend:true};
      }
      const issued={...intent,stage:'issued',hash:answer.data.hash};
      await journal.put(keyFor(logicalAddress),issued);
      return observe(input,issued,answer.data.writeProof);
    });
  }
  async function read({logicalAddress,artifact,artifactKind,writer=claim,deliveryBinding,fresh=false}) {
    if(writer!==claim || !artifactValid(artifactKind,artifact,writer)) return {status:'rejected',reason:'demo read scope differs'};
    const retained=await journal.get(keyFor(logicalAddress));
    if(!retained) return {status:'absent',reason:'no seller-owned demo CREATE intent'};
    const input={logicalAddress,artifact:clone(artifact),artifactKind,writer,receiptContentHash:contentHash(artifact),...(deliveryBinding?{deliveryBinding:clone(deliveryBinding)}:{})};
    if(retained.inputHash!==exactHash(input)) return {status:'rejected',reason:'retained demo CREATE scope differs'};
    authorizeRetained(retained);
    if(retained.stage==='closing') return closingAbsence(logicalAddress,retained);
    return observe(input,retained,undefined,{fresh});
  }
  // Only a 'closing' row exactly as publish writes it, with no signed
  // transaction for its address retained by the source or this seller's
  // wallet, proves nothing was signed (the marker a held native Deliverable
  // needs to be asked again). Any other 'closing' row reads as plain absence.
  async function closingAbsence(logicalAddress,retained) {
    const names=(value)=>value?.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===logicalAddress;
    const exact=retained.error===OPERATOR_CLOSING && !Object.hasOwn(retained,'hash')
      && !(await sourceCapability.journal.entries()).some(([,value])=>names(value))
      && !(await journal.entries()).some(([key,value])=>key.startsWith('demo/wallet/')&&names(value));
    return exact ? provenUnsignedAbsence(CLOSING_ABSENT) : {status:'absent',reason:CLOSING_ABSENT};
  }
  // Passive: whether this seller's journal retains a CREATE intent for the
  // address. No readback, resend or write, and nothing is authorized by it.
  async function hasIntent(logicalAddress) {
    return Boolean(await journal.get(keyFor(logicalAddress)));
  }
  async function readRetained({logicalAddress,artifactKind,writer=claim,fresh=false}) {
    if(writer!==claim || !kinds.has(artifactKind)) return {status:'rejected',reason:'demo retained read scope differs'};
    const retained=await journal.get(keyFor(logicalAddress));
    if(!retained) return {status:'absent',reason:'no seller-owned demo CREATE intent'};
    if(retained.input?.artifactKind!==artifactKind || retained.input?.writer!==writer || retained.input?.logicalAddress!==logicalAddress) return {status:'rejected',reason:'retained demo CREATE scope differs'};
    authorizeRetained(retained);
    // As read: only an exact 'closing' row reads as the proven absence (the
    // context route resumes a step a shutdown cut only from that proof).
    if(retained.stage==='closing') return closingAbsence(logicalAddress,retained);
    return observe(clone(retained.input),retained,undefined,{fresh});
  }
  // The original public signed CREATE of one of this seller's own verified
  // writes, offered to a buyer only as bytes it authenticates on chain itself.
  // Local lookup only: no read, wallet request or journal write. Like every
  // other retained read, the buyer-access check comes first; a refusal offers nothing.
  async function retainedSignedCreate({logicalAddress,artifactKind}) {
    if(!kinds.has(artifactKind)) return null;
    const retained=await journal.get(keyFor(logicalAddress));
    if(retained?.stage!=='verified' || retained.input?.artifactKind!==artifactKind || retained.input?.writer!==claim || retained.input?.logicalAddress!==logicalAddress
      || !HASH.test(retained.hash ?? '') || retained.signedProjection?.hash!==retained.hash || typeof retained.signedProjection.content!=='object' || sha256Hex(JSON.stringify(retained.signedProjection.content))!==retained.hash) return null;
    try { authorizeRetained(retained); } catch { return null; }
    return structuredClone(retained.signedProjection);
  }
  // A projection is caller data until it authenticates locally: its hash is
  // the hash of its own content, the seller signed that hash, and the receipt
  // names that transaction. Only then may its job and kind choose the access check.
  const projectionAuthentic=(projection,receipt)=>HASH.test(projection?.hash ?? '') && projection.content!==null && typeof projection.content==='object'
    && sha256Hex(JSON.stringify(projection.content))===projection.hash
    && projection.signature?.type==='ed25519' && verifyDemosSignature({address:owner,message:projection.hash,signature:projection.signature.data})
    && receipt.transactionRef.value===projection.hash;
  async function verifyReceipt({logicalAddress,artifact,artifactKind,receipt,writer=claim,signedProjection,deliveryBinding,fresh=false}) {
    // The request itself is checked first, with no read: this anchor's writer,
    // an artifact of a kind it publishes in that writer's signed shape, and a
    // receipt naming a transaction hash.
    if(writer!==claim || !kinds.has(artifactKind) || !artifactValid(artifactKind,artifact,claim) || !HASH.test(receipt?.transactionRef?.value ?? '')) return 'invalid';
    const projection=signedProjection ?? await publicProjection(receipt.transactionRef.value);
    const requestJob=artifact?.jobId ?? `listing:${artifact?.listingId}`;
    if(!projection) { authorizeJob(artifactKind,requestJob); return 'indeterminate'; }
    if(!projectionAuthentic(projection,receipt)) return 'invalid';
    // Authorize the signed transaction's own job before the cache, the binder
    // or the receipt reader; a request naming another job or kind than that
    // transaction is invalid without any read.
    const bound=createBinding(projection);
    authorizeJob(bound.artifactKind,bound.jobId);
    if(bound.artifactKind!==artifactKind || bound.jobId!==requestJob) return 'invalid';
    const input={logicalAddress,artifact:clone(artifact),artifactKind,writer,receiptContentHash:contentHash(artifact),...(deliveryBinding?{deliveryBinding:clone(deliveryBinding)}:{})};
    const cacheable=cachedKinds.has(artifactKind),cacheKey=cacheScope(input,projection,receipt);
    if(cacheable&&!fresh&&immutable.get(cacheKey)){await sourceCapability.observeBinding();return 'valid';}
    const verdict=await reader.verifyReceipt({receipt,logicalAddress,artifact,expectedWriter:writer,artifactKind,...(deliveryBinding?{deliveryBinding}:{}),receiptContentHash:contentHash(artifact),signedProjection:projection});
    if(cacheable&&verdict==='invalid') immutable.delete(cacheKey);
    return verdict;
  }
  return Object.freeze({source:'dacs-devnet-demo-native-artifacts/v1',authority:sourceCapability.demoArtifactPublication.authority,writer:claim,publish,read,readRetained,retainedSignedCreate,hasIntent,verifyReceipt});
}
