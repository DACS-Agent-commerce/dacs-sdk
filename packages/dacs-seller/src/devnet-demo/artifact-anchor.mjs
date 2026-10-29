import {assertQualifiedDeployment} from './deployment-qualification.mjs';
import { verifyComponent } from '../dacs/listing.mjs';
import { isDevnetPurchasedReport } from './deliverable.mjs';
import { boundedResolutionValue, resolveWithDeadline } from '../util/bounded-resolution.mjs';
import { createImmutableReadbacks } from '../util/immutable-readbacks.mjs';
// Application-owned native publication for the real demo composition. Every
// CREATE is produced by the packaged seller wallet and then accepted only
// after an independent source read, original signed projection, and SDK
// portable receipt verification. A retained intent never reissues a wallet
// request, except one that provably signed nothing (a shutdown ended its
// approval: stage 'closing'; the wallet answered without signing: 'unsigned';
// the process died while the wallet was asked: 'intent'), and only while no
// signed CREATE for its address is retained by the source or the seller's
// wallet; an accepted, absent operator CREATE may resend its original bytes.
import { isNativeDeliveryEvidence } from '../dacs/delivery-evidence.mjs';
import { provenUnsignedAbsence } from '../dacs/native-dem-delivery-consumer.mjs';
import { rpcEnvelope, storageWriteAccountNonce, storageWriteRpcSigner } from './storage-write-recovery.mjs';
import { operatorBuyerAccessConfig } from './buyer-access.mjs';
import { OPERATOR_CLOSING } from './operator-approval.mjs';
import {
  ARTIFACT_SEPARATORS, FINALITY_COMMITMENT_SEPARATOR, signedBytes, canonicalize, sameCanonicalClaimIdentity,
  contentHash,
  isCompositeVerificationRecord,
  isFinalityCommitmentRecord,
  isListing,
  isCanonicalJobId,
  logicalToStorageProgramName,
  sha256Hex,
} from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, demosSr2TxRef } from '../dacs/demos-sr2-adapter.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress, MAX_STORAGE_ARTIFACT_BYTES } from '../dacs/wallet-transactions.mjs';
import { addressForClaim, verifyDemosSignature } from '../dacs/demos-claims.mjs';
import {
  DEVNET_AGREEMENT_PROFILE,
  DEVNET_DEMO_ARTIFACT_KIND,
  DEVNET_DEMO_ARTIFACT_POLICY,
  DEVNET_DEMO_ARTIFACT_TYPES,
  isDevnetDemoTransport,
} from '../dacs/devnet-source.mjs';

const clone=(v)=>JSON.parse(canonicalize(v));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const exactHash=(v)=>sha256Hex(canonicalize(v));
// A retained intent names one publication target. A retry that provably signed
// nothing may re-stamp the artifact's provisional time, but the address, kind,
// writer, verifier and delivery binding stay immutable.
const publicationScope=(input)=>canonicalize({logicalAddress:input?.logicalAddress??null,artifactKind:input?.artifactKind??null,writer:input?.writer??null,verifier:input?.verifier??null,deliveryBinding:input?.deliveryBinding??null});
// The durable wallet outcome is independent of readback stage. Older readers
// could promote a rejected row to 'issued' while keeping this error marker.
const broadcastRejected=(row)=>row?.error==='broadcast_rejected';
const HASH=/^[0-9a-f]{64}$/;
// A retained intent that provably signed nothing (see signedNothing) reads as
// a proven absence, so callers publish it again, which asks the wallet again;
// a 'closing' row with a signed CREATE reads as plain absence.
const NO_INTENT_ABSENT='no seller-owned demo CREATE intent';
const UNSIGNED_ABSENT='the wallet never signed this CREATE (no signed transaction is retained for it); publishing it asks again';
const CLOSING_ABSENT='a shutdown ended this CREATE\'s approval before anything was signed; publishing it asks again';
// The nonce reply has a byte cap before decoding in the source, and a
// deadline and strict decoded JSON budgets enforced at this boundary.
const NONCE_READ_LIMITS=Object.freeze({maxBytes:4096,timeoutMs:10_000});
// A signed CREATE carries one artifact of at most MAX_STORAGE_ARTIFACT_BYTES
// plus its fixed CREATE fields and bindings; a caller's projection larger than
// this is refused before it is hashed.
const SIGNED_CREATE_MAX_BYTES=4*MAX_STORAGE_ARTIFACT_BYTES;
const SIGNED_PROJECTION_MAX_BYTES=SIGNED_CREATE_MAX_BYTES+1024; // Authentication envelope above the signed-content budget.

// The caller authenticates expectedSigner: the Vet verifier or commitment
// orchestrator, which may differ from the native storage owner.
function artifactValid(kind,value,writer,expectedSigner=writer) {
  if(kind!=='Listing' && !isCanonicalJobId(value?.jobId)) return false;
  const signed=(separator,signer)=>sameCanonicalClaimIdentity(value?.signature?.signer,signer)
    && verifyComponent({signedBytes:signedBytes(separator,contentHash(value)),signature:value.signature});
  if(kind==='Listing') return isListing(value) && sameCanonicalClaimIdentity(value.seller?.identity?.presentedBy,writer) && signed(ARTIFACT_SEPARATORS.Listing,writer);
  if(kind==='CompositeVerificationRecord') return isCompositeVerificationRecord(value)
    && (sameCanonicalClaimIdentity(value.evaluatedParty,writer) ? !sameCanonicalClaimIdentity(expectedSigner,writer) : sameCanonicalClaimIdentity(expectedSigner,writer))
    && signed(ARTIFACT_SEPARATORS.CompositeVerificationRecord,expectedSigner);
  if(kind==='FinalityCommitmentRecord') return isFinalityCommitmentRecord(value) && signed(FINALITY_COMMITMENT_SEPARATOR,expectedSigner);
  if(kind==='SettlementEvidence')return isNativeDeliveryEvidence(value,writer,`dacs4:evidence:${value.jobId}`);
  return kind==='Deliverable' && isDevnetPurchasedReport(value,{producer:writer});
}
// One successfully read snapshot supplies unsignedness, projection identity and
// nonce reservations. Index historical evidence once, never inside a row loop.
function publicationSnapshot(sourceRows,walletRows) {
  const addresses=new Set(), projections=new Map(), addressHashes=new Map();
  const lane=tx=>JSON.stringify([tx?.content?.from,tx?.content?.nonce,tx?.content?.data?.[1]?.metadata?.logicalAddress]);
  const rejected=new Set(walletRows.filter(([,row])=>broadcastRejected(row)).map(([,row])=>lane(row.transaction)));
  for(const [key,row] of [...sourceRows,...walletRows.filter(([key])=>key.startsWith('demo/wallet/'))]) {
    const tx=row?.signedTransaction, address=tx?.content?.data?.[1]?.metadata?.logicalAddress;
    if(address) addresses.add(address);
    if(address && typeof row.hash==='string') {
      if(!addressHashes.has(address)) addressHashes.set(address,new Set());
      addressHashes.get(address).add(row.hash);
    }
  }
  for(const [,row] of [...sourceRows,...walletRows]) {
    if(!row?.signedTransaction || typeof row.hash!=='string') continue;
    const prior=projections.get(row.hash), text=JSON.stringify(row.signedTransaction);
    projections.set(row.hash,prior===undefined?text:prior===text?prior:null);
  }
  const classify=(address,row,{reaskDenied=false}={})=>{
    if(broadcastRejected(row)) return 'rejected';
    if(row?.error==='user_rejected'&&!reaskDenied) return 'denied';
    const unsigned=row && !Object.hasOwn(row,'hash') && !Object.hasOwn(row,'signedTransaction')
      && row.transaction?.content?.data?.[1]?.metadata?.logicalAddress===address
      && (['intent','unsigned'].includes(row.stage) || row.stage==='closing'&&row.error===OPERATOR_CLOSING || reaskDenied&&row.stage==='denied');
    return !addresses.has(address)&&(!row||unsigned)?'unsigned':'signed';
  };
  const live=rows=>rows.filter(([,row])=>{
    const address=row?.transaction?.content?.data?.[1]?.metadata?.logicalAddress;
    return row?.signedTransaction || row?.hash || classify(address,row)!=='unsigned' && row?.error!=='user_rejected' && !['closing','unsigned','rejected'].includes(row?.stage);
  });
  return {classify,live,addresses,addressHashes,sourceRows,walletRows,rejected:row=>row.included!==true&&row.stage!=='observed'&&row.stage!=='verified'&&rejected.has(lane(row.signedTransaction ?? row.transaction)),projection:hash=>{const text=projections.get(hash);return text?JSON.parse(text):null;}};
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

export function createDevnetDemoArtifactAnchor(options) {
  if(!isDevnetDemoTransport(options.sourceCapability)) throw new TypeError('the explicit devnet demo source capability is required');
  return assembleArtifactAnchor(options);
}
function assembleArtifactAnchor({sourceCapability,journal,walletFactory,network,signer,buyerAccess=null,now=()=>Date.now()},ports={}) {
  // Only the seller's own Listing has no purchase. Every other write, new or
  // retained, belongs to a job whose current buyer must be admitted first.
  const access=operatorBuyerAccessConfig(buyerAccess);
  const authorizeJob=(artifactKind,jobId)=>{
    if(artifactKind==='Listing') return;
    if(!isCanonicalJobId(jobId)) fail('invalid','jobId must be a canonical uppercase ULID');
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
  const reader=ports.reader ?? createDemosSr2Adapter({rpcUrl:sourceCapability.pins.endpoint,journal:createInMemoryDemosSr2Journal(),sourceCapability,now});
  const owner=wallet.getPublicAccount()?.address;
  const claim=owner ? `did:demos:agent:${owner.slice(2)}` : null;
  const signRpc=Object.hasOwn(ports,'signRpc')?ports.signRpc:storageWriteRpcSigner(signer,claim);
  if(!owner || wallet.getWriteProfile()?.demoArtifactPublication?.policy!==DEVNET_DEMO_ARTIFACT_POLICY) throw new TypeError('the packaged seller wallet does not carry the demo artifact publication policy');
  const keyFor=(logicalAddress)=>{
    const jobPrefix=/^(?:dacs2:composite:|dacs3:commit:|dacs4:deliverable:|dacs4:evidence:)/.exec(logicalAddress);
    if(jobPrefix && !isCanonicalJobId(logicalAddress.slice(jobPrefix[0].length).split(':')[0])) fail('invalid','job address must contain a canonical uppercase ULID');
    return `demo/artifact/${exactHash([network,sourceCapability.pins.chainIdentity,claim,logicalAddress])}`;
  };

  const snapshot=async()=>publicationSnapshot(await sourceCapability.journal.entries(),await journal.entries());
  const signedNothing=async(address,row)=>(await snapshot()).classify(address,row)==='unsigned';

  async function accountNonce() {
    try {
      const response=boundedResolutionValue(await resolveWithDeadline(limits=>sourceCapability.readRpc('/',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:owner}}]},limits),NONCE_READ_LIMITS),
        {...NONCE_READ_LIMITS,maxValues:64,maxDepth:8,maxListEntries:16});
      const current=storageWriteAccountNonce(response?.response);
      if(!rpcEnvelope(response,200,null) || current===null) fail('indeterminate','seller nonce is unavailable');
      return current;
    } catch(cause) {
      throw Object.assign(new Error(`seller nonce read failed or exceeded its deadline: ${cause.message}`,{cause}),{code:'indeterminate'});
    }
  }
  async function liveSourceRows() {
    const sourceRows=await sourceCapability.journal.entries();
    const state=publicationSnapshot(sourceRows,await journal.entries());
    return state.live(sourceRows).filter(([,row])=>!state.rejected(row));
  }

  async function observeSource(hash,projection,writeProof,{resend=true}={}) {
    let observed=await sourceCapability.binding({phase:'readback',address:owner,hash,...(writeProof?{writeProof}:{})});
    if(resend && observed.disposition==='pending' && signRpc && projection?.content?.type==='storageProgram') {
      const recoveryKey=`demo/recovery/${hash}`;
      await journal.withWalletLock(recoveryKey,async()=>{
        const prior=await journal.get(recoveryKey),projectionHash=exactHash(projection);
        if(prior){
          if(prior.projectionHash!==projectionHash)fail('invalid','retained recovery projection differs');
          return; // An interrupted or uncertain resend never authorizes another.
        }
        await assertQualifiedDeployment(sourceCapability);
        await journal.put(recoveryKey,{stage:'intent',projectionHash});
        await sourceCapability.recoverStorageWrite({signedTransaction:projection,signRpc});
        await journal.put(recoveryKey,{stage:'issued',projectionHash});
      });
      observed=await sourceCapability.binding({phase:'readback',address:owner,hash});
    }
    return observed;
  }

  async function reconcilePriorSourceLane() {
    const pending=(await liveSourceRows()).map(([,value])=>value).filter((value)=>value?.signedTransaction?.content?.from===owner&&value.stage!=='observed');
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

  // Keep the original projection before releasing the wallet's single lane.
  // A refused broadcast with definitive absence frees only that lane; unknown
  // outcomes retain it, and authenticated late inclusion still completes.
  async function reconcilePriorWalletLane() {
    const state=await snapshot();
    for(const [key,value] of state.walletRows.filter(([key,value])=>key.startsWith('demo/wallet/')&&value?.stage==='broadcast-started'&&value?.signedTransaction?.content?.from===owner)){
      const projection=state.projection(value.hash),address=projection?.content?.data?.[1]?.metadata?.logicalAddress;
      if(!projection||!projectionAuthentic(projection,{transactionRef:{value:value.hash}})||canonicalize(projection)!==canonicalize(value.signedTransaction)) fail('indeterminate','the retained seller wallet CREATE differs from its original public projection');
      const artifactKey=keyFor(address);
      await journal.withWalletLock(artifactKey,async()=>{
        const retained=await journal.get(artifactKey);
        if(!retained||canonicalize(retained.transaction.content.data)!==canonicalize(projection.content.data)) fail('indeterminate','the retained wallet CREATE has no matching artifact intent');
        await journal.put(artifactKey,{...retained,hash:value.hash,signedTransaction:projection});
      });
      const observed=await observeSource(value.hash,projection,undefined,{resend:!state.rejected(value)});
      if(observed.disposition!=='included'&&!(state.rejected(value)&&observed.disposition==='absent')) fail('indeterminate',`the retained seller wallet CREATE requires readback (${observed.disposition})`);
      await journal.withWalletLock(key,async()=>{
        const current=await journal.get(key);
        if(current?.stage==='broadcast-started'&&current.hash===value.hash&&canonicalize(current.signedTransaction)===canonicalize(value.signedTransaction)) await journal.put(key,{...current,stage:'broadcast-accepted',included:observed.disposition==='included'});
      });
    }
  }

  async function publicProjection(hash) {
    return (await snapshot()).projection(hash);
  }
  async function observe(input,retained,writeProof,{fresh=false}={}) {
    if(retained.error==='user_rejected') return {status:'rejected',reason:'user_rejected: the operator refused this CREATE',noResend:true};
    let hash=retained.hash;
    if(!hash) {
      const hashes=(await snapshot()).addressHashes.get(input.logicalAddress);
      if(hashes?.size!==1) return {status:'indeterminate',reason:'the original demo CREATE hash is not uniquely retained',noResend:true};
      hash=[...hashes][0];
      // Every caller holds the artifact lock from intent lookup through save,
      // so an observation cannot overwrite a newer wallet outcome.
      await journal.put(keyFor(input.logicalAddress),{...retained,stage:'issued',hash});
    }
    const projection=await publicProjection(hash);
    if(!projection) return {status:broadcastRejected(retained)?'rejected':'indeterminate',reason:broadcastRejected(retained)?'broadcast_rejected: no original signed CREATE retained':'the original public signed CREATE projection is unavailable',noResend:true};
    if(!retained.signedTransaction) {retained={...retained,hash,signedTransaction:projection};await journal.put(keyFor(input.logicalAddress),retained);}
    const cacheable=cachedKinds.has(input.artifactKind),cacheKey=cacheScope(input,projection,retained.receipt ?? null);
    const cached=cacheable&&!fresh?immutable.get(cacheKey):null;
    if(cached){await sourceCapability.observeBinding();return cached;}
    const included=await observeSource(hash,projection,writeProof,{resend:!broadcastRejected(retained)});
    if(broadcastRejected(retained)&&included.disposition==='absent') return {status:'rejected',reason:'broadcast_rejected: the original demo CREATE is absent',noResend:true};
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
    await journal.put(keyFor(input.logicalAddress),complete);
    const result={status:'present',artifact:clone(record.artifact),receipt:clone(record.receipt),signedProjection:projection,demosEvidence:clone(record.demosEvidence),
      ref:{anchor:{kind:'storage-program',locator:input.logicalAddress},contentHash:input.receiptContentHash,signer:claim},txRef:demosSr2TxRef(record.receipt),noResend:true};
    if(cachedKinds.has(input.artifactKind))immutable.put(cacheScope(input,projection,record.receipt),result);
    return result;
  }
  // authorize (optional): the caller's own check, called under this address's
  // lock and awaited immediately before storing the intent. Anything but true refuses:
  // no intent is stored and nothing is sent. Without it, publish is unchanged.
  // reaskDenied (optional, a Listing only): a retained intent the packaged
  // wallet refused at its approval (denied: user_rejected, before it signed
  // anything) is replaced under this lock by a fresh intent and asked again.
  // Every other retained intent is only read back, as without it, apart from
  // a 'closing' one (a shutdown ended its approval), which is always asked again.
  async function publish({logicalAddress,artifact,artifactKind,writer=claim,verifier=writer,deliveryBinding,authorize,reaskDenied=false}) {
    if(authorize!==undefined&&typeof authorize!=='function') fail('invalid','publish authorization must be a function');
    if(writer!==claim || !kinds.has(artifactKind) || !artifactValid(artifactKind,artifact,writer,verifier)) fail('invalid','demo artifact kind, producer, or signed shape differs');
    if(artifactKind==='SettlementEvidence'&&logicalAddress!==`dacs4:evidence:${artifact.jobId}`)fail('invalid','delivery evidence address differs from its job');
    const value=clone(artifact), jobId=value.jobId ?? `listing:${value.listingId}`, receiptContentHash=contentHash(value);
    if((artifactKind==='Deliverable')!==Boolean(deliveryBinding) || (deliveryBinding && !deliveryBindingValid(deliveryBinding,value,logicalAddress,receiptContentHash))) fail('invalid','demo Deliverable is not bound to the exact Agreement, Listing, fulfilment, amount and payload');
    const input={logicalAddress,artifact:value,artifactKind,writer,receiptContentHash,...(verifier!==writer?{verifier}:{}),...(deliveryBinding?{deliveryBinding:clone(deliveryBinding)}:{})};
    // The source owns the atomic wallet lane used by ALL its CREATE writers,
    // including writers using other journals. An artifact-local lock cannot
    // establish that guarantee. Unintegrated hosts may still read retained data.
    if(typeof sourceCapability.withWalletNonceLock!=='function') fail('nonce_lane_unavailable','the source must provide a shared atomic wallet nonce lane');
    return sourceCapability.withWalletNonceLock({owner,network,chainIdentity:sourceCapability.pins.chainIdentity},()=>journal.withWalletLock(`demo/nonce/${exactHash([network,sourceCapability.pins.chainIdentity,owner])}`,()=>journal.withWalletLock(keyFor(logicalAddress),async()=>{
      const retained=await journal.get(keyFor(logicalAddress));
      if(retained) {
        authorizeRetained(retained);
        // Nothing was signed (a shutdown ended its approval, the wallet answered
        // without signing, or the process died while it was asked, with no
        // signed CREATE retained for the address): ask again below, from a
        // fresh nonce, as for a new intent. Only the operator's refusal of a
        // Listing is also asked again, when the caller says so, on the same
        // proof: its row is unsigned and neither journal retains a signed CREATE.
        const deniedListing=reaskDenied===true&&artifactKind==='Listing'&&retained.stage==='denied'&&retained.error==='user_rejected';
        const unsigned=(await snapshot()).classify(logicalAddress,retained,{reaskDenied:deniedListing})==='unsigned';
        if(retained.inputHash!==exactHash(input)) {
          // A retry after a proven unsigned attempt is a new publication, so its
          // artifact may carry a new provisional time; nothing was signed and no
          // immutable intent exists. Any other change stays a conflict.
          if(!unsigned||publicationScope(retained.input)!==publicationScope(input)) fail('conflict','immutable demo artifact intent differs');
        } else if(!unsigned) return observe(input,retained);
      }
      if(!retained&&(await snapshot()).addresses.has(logicalAddress)) return {status:'indeterminate',reason:'signed CREATE retained without an intent',noResend:true};
      authorizeJob(artifactKind,jobId);
      await assertQualifiedDeployment(sourceCapability);
      // Another application seam (for example native SettlementEvidence)
      // may have used this same seller/source nonce lane immediately before
      // delivery. Authenticate and release that exact retained transaction;
      // only retained accepted storage bytes can qualify for recovery.
      await reconcilePriorSourceLane();
      await reconcilePriorWalletLane();
      const current=await accountNonce();
      // Retained signed or reserved bytes fence this nonce even after inclusion.
      // Wait for the RPC to catch up instead of preparing a duplicate CREATE.
      const prior=await snapshot();
      const retainedNonces=prior.live([...prior.sourceRows,...prior.walletRows]).filter(([,row])=>!prior.rejected(row)).flatMap(([,row])=>[row?.transaction,row?.signedTransaction])
        .filter(tx=>tx?.content?.from===owner).map(tx=>tx.content.nonce);
      if(retainedNonces.some(n=>!Number.isSafeInteger(n)||n<0)) fail('indeterminate','retained seller nonce is invalid');
      if(current===Number.MAX_SAFE_INTEGER||retainedNonces.some(n=>n>current)) fail('indeterminate','seller nonce RPC has not caught up with retained CREATEs');
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
      // Admit the same content and complete Ed25519 envelope that readback accepts.
      const candidateProjection={...transaction,hash:'0'.repeat(64),signature:{type:'ed25519',data:'0x'+'0'.repeat(128)}};
      if(projectionContentText(transaction.content)===null || !projectionWithinBudget(candidateProjection)) fail('invalid','demo CREATE exceeds signed projection limits');
      const intent={stage:'intent',inputHash:exactHash(input),input:clone(input),transaction:clone(transaction)};
      if(authorize){
        const allowed=await authorize();
        if(allowed!==true) fail('not-authorized',`the caller withdrew this write (${typeof allowed==='string'?allowed.slice(0,160):'no answer'}); no intent was stored and nothing was sent`);
      }
      await journal.put(keyFor(logicalAddress),intent);
      // Recheck after durable intent publication too: an older host writer
      // bypassing the shared-lane contract must not race a known reservation.
      const sourceRows=await liveSourceRows();
      if(sourceRows.some(([,row])=>row?.signedTransaction?.content?.from===owner && row.signedTransaction.content.nonce>=nonce)){
        await journal.put(keyFor(logicalAddress),{...intent,stage:'unsigned',error:'nonce-lane-changed'});
        fail('indeterminate','source wallet nonce lane changed during CREATE reservation');
      }
      const answer=await wallet.request({method:'sendTransaction',params:[{kind:DEVNET_DEMO_ARTIFACT_KIND,profile:DEVNET_AGREEMENT_PROFILE,network,owner:writer,artifactKind,jobId,
        logicalAddress,contentHash:receiptContentHash,envelopeHash:exactHash(value),transaction}]});
      if(answer?.error?.code===OPERATOR_CLOSING) {
        // Not a decision: the custody reports it only when the approval was
        // cut before signing. The intent stays askable (never denied).
        await journal.put(keyFor(logicalAddress),{...intent,stage:'closing',error:OPERATOR_CLOSING});
        return {status:'indeterminate',reason:`${OPERATOR_CLOSING}: ${answer.error.message ?? 'the operator is closing'}`.slice(0,240),noResend:true};
      }
      if(!answer?.success) {
        // The packaged wallet journals signed bytes before submission. Only a
        // completed failure with no signed transaction in either durable journal
        // proves an unsigned attempt. Ambiguous signed outcomes keep the floor.
        const state=await snapshot();
        const signed=state.live([...state.sourceRows,...state.walletRows]).some(([,row])=>!state.rejected(row) && row?.signedTransaction?.content?.from===owner && row.signedTransaction.content.nonce===nonce);
        const code=answer?.error?.code;
        const stage=code==='user_rejected'?'denied':code==='broadcast_rejected'?'rejected':answer?.success===false&&!signed?'unsigned':'issued';
        await journal.put(keyFor(logicalAddress),{...intent,stage,error:code ?? 'wallet-response-missing'});
        return {status:answer?.error?.code==='user_rejected'?'rejected':'indeterminate',reason:`${answer?.error?.code ?? 'wallet-response-missing'}: ${answer?.error?.message ?? 'wallet response missing'}`.slice(0,240),noResend:true};
      }
      const hash=answer?.data?.hash;
      const projection=(await snapshot()).projection(hash);
      if(!HASH.test(hash ?? '') || !projection || !projectionAuthentic(projection,{transactionRef:{value:hash}}) || projection.content.from!==owner || canonicalize(projection.content.data?.[1]?.data)!==canonicalize(value)) {
        await journal.put(keyFor(logicalAddress),{...intent,stage:'issued',error:'wallet-answer-unbound'});
        return {status:'indeterminate',reason:'wallet answer has no matching retained signed CREATE',noResend:true};
      }
      const issued={...intent,stage:'issued',hash};
      await journal.put(keyFor(logicalAddress),issued);
      return observe(input,issued,answer.data.writeProof);
    })));
  }
  async function read({logicalAddress,artifact,artifactKind,writer=claim,verifier=writer,deliveryBinding,fresh=false}) {
    if(writer!==claim || !artifactValid(artifactKind,artifact,writer,verifier)) return {status:'rejected',reason:'demo read scope differs'};
    authorizeJob(artifactKind,artifact?.jobId);
    return journal.withWalletLock(keyFor(logicalAddress),async()=>{
      const retained=await journal.get(keyFor(logicalAddress));
      if(!retained) return noIntentAbsence(logicalAddress);
      const input={logicalAddress,artifact:clone(artifact),artifactKind,writer,receiptContentHash:contentHash(artifact),...(verifier!==writer?{verifier}:{}),...(deliveryBinding?{deliveryBinding:clone(deliveryBinding)}:{})};
      if(retained.inputHash!==exactHash(input)) return {status:'rejected',reason:'retained demo CREATE scope differs'};
      authorizeRetained(retained);
      if(await signedNothing(logicalAddress,retained)) return provenUnsignedAbsence(retained.stage==='closing'?CLOSING_ABSENT:UNSIGNED_ABSENT);
      if(retained.stage==='closing') return {status:'absent',reason:CLOSING_ABSENT};
      return observe(input,retained,undefined,{fresh});
    });
  }
  // publish stores its intent before it asks the wallet to sign anything, and
  // this read holds the address's lock, so an address with no intent row (and
  // no signed CREATE retained anywhere for it) was never asked of the wallet:
  // the proven absence a held native Deliverable needs to be asked again.
  async function noIntentAbsence(logicalAddress) {
    return (await snapshot()).addresses.has(logicalAddress) ? {status:'absent',reason:NO_INTENT_ABSENT} : provenUnsignedAbsence(NO_INTENT_ABSENT);
  }
  // Passive: whether this seller's journal retains a CREATE intent for the
  // address. No readback, resend or write, and nothing is authorized by it.
  async function hasIntent(logicalAddress) {
    return Boolean(await journal.get(keyFor(logicalAddress)));
  }
  async function readRetained({logicalAddress,artifactKind,writer=claim,fresh=false,proofOfNoIntent=false}) {
    if(writer!==claim || !kinds.has(artifactKind) || typeof proofOfNoIntent!=='boolean') return {status:'rejected',reason:'demo retained read scope differs'};
    authorizeJob(artifactKind,logicalAddress.split(':')[2]);
    return journal.withWalletLock(keyFor(logicalAddress),async()=>{
      const retained=await journal.get(keyFor(logicalAddress));
      if(!retained) return proofOfNoIntent?noIntentAbsence(logicalAddress):{status:'absent',reason:'no seller-owned demo CREATE intent'};
      if(retained.input?.artifactKind!==artifactKind || retained.input?.writer!==writer || retained.input?.logicalAddress!==logicalAddress) return {status:'rejected',reason:'retained demo CREATE scope differs'};
      authorizeRetained(retained);
      // As read: only an exact 'closing' row reads as the proven absence (the
      // context route resumes a step a shutdown cut only from that proof).
      if(await signedNothing(logicalAddress,retained)) return provenUnsignedAbsence(retained.stage==='closing'?CLOSING_ABSENT:UNSIGNED_ABSENT);
      if(retained.stage==='closing') return {status:'absent',reason:CLOSING_ABSENT};
      return observe(clone(retained.input),retained,undefined,{fresh});
    });
  }
  // The original public signed CREATE of one of this seller's own verified
  // writes, offered to a buyer only as bytes it authenticates on chain itself.
  // Local lookup only: no read, wallet request or journal write. Like every
  // other retained read, the buyer-access check comes first; a refusal offers nothing.
  async function retainedSignedCreate({logicalAddress,artifactKind}) {
    if(!kinds.has(artifactKind)) return null;
    keyFor(logicalAddress);
    try { authorizeJob(artifactKind,logicalAddress.split(':')[2]); } catch { return null; }
    const retained=await journal.get(keyFor(logicalAddress));
    if(retained?.stage!=='verified' || retained.input?.artifactKind!==artifactKind || retained.input?.writer!==claim || retained.input?.logicalAddress!==logicalAddress
      || !HASH.test(retained.hash ?? '') || retained.signedProjection?.hash!==retained.hash || typeof retained.signedProjection.content!=='object' || sha256Hex(JSON.stringify(retained.signedProjection.content))!==retained.hash) return null;
    try { authorizeRetained(retained); } catch { return null; }
    return structuredClone(retained.signedProjection);
  }
  // A projection is caller data until it authenticates locally: its content is
  // JSON within one signed CREATE's size, its hash is the hash of that content,
  // the seller signed that hash, and the receipt names that transaction. Only
  // then may its job and kind choose the access check.
  const projectionContentText=(content)=>{
    if(content===null || typeof content!=='object') return null;
    try { return JSON.stringify(boundedResolutionValue(content,{maxBytes:SIGNED_CREATE_MAX_BYTES,maxValues:8192,maxDepth:32,maxListEntries:4096})); } catch { return null; }
  };
  const projectionWithinBudget=projection=>{
    try { boundedResolutionValue(projection,{maxBytes:SIGNED_PROJECTION_MAX_BYTES,maxValues:8192,maxDepth:34,maxListEntries:4096});return true; } catch { return false; }
  };
  const projectionAuthentic=(projection,receipt)=>{
    if(!projectionWithinBudget(projection)) return false;
    const text=HASH.test(projection?.hash ?? '') ? projectionContentText(projection.content) : null;
    return text!==null && sha256Hex(text)===projection.hash
      && projection.signature?.type==='ed25519' && verifyDemosSignature({address:owner,message:projection.hash,signature:projection.signature.data})
      && receipt.transactionRef.value===projection.hash;
  };
  async function verifyReceipt({logicalAddress,artifact,artifactKind,receipt,writer=claim,verifier=writer,signedProjection,deliveryBinding,fresh=false}) {
    // The request itself is checked first, with no read: this anchor's writer,
    // an artifact of a kind it publishes in that writer's signed shape, and a
    // receipt naming a transaction hash.
    if(writer!==claim || !kinds.has(artifactKind) || !artifactValid(artifactKind,artifact,claim,verifier) || !HASH.test(receipt?.transactionRef?.value ?? '')) return 'invalid';
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
    const input={logicalAddress,artifact:clone(artifact),artifactKind,writer,receiptContentHash:contentHash(artifact),...(verifier!==writer?{verifier}:{}),...(deliveryBinding?{deliveryBinding:clone(deliveryBinding)}:{})};
    const cacheable=cachedKinds.has(artifactKind),cacheKey=cacheScope(input,projection,receipt);
    if(cacheable&&!fresh&&immutable.get(cacheKey)){await sourceCapability.observeBinding();return 'valid';}
    const verdict=await reader.verifyReceipt({receipt,logicalAddress,artifact,expectedWriter:writer,artifactKind,...(deliveryBinding?{deliveryBinding}:{}),receiptContentHash:contentHash(artifact),signedProjection:projection});
    if(cacheable&&verdict==='invalid') immutable.delete(cacheKey);
    return verdict;
  }
  return Object.freeze({source:'dacs-devnet-demo-native-artifacts/v1',authority:sourceCapability.demoArtifactPublication.authority,writer:claim,publish,read,readRetained,retainedSignedCreate,hasIntent,verifyReceipt});
}
