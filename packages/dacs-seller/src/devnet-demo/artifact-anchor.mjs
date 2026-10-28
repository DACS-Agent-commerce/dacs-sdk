import {assertQualifiedDeployment} from './deployment-qualification.mjs';
import { verifyComponent } from '../dacs/listing.mjs';
import { isDevnetPurchasedReport } from './deliverable.mjs';
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
// Every node read made while the shared wallet nonce lane is held has a reply
// byte cap the source applies before decoding, and a deadline enforced here.
const NONCE_READ_LIMITS=Object.freeze({maxBytes:4096,timeoutMs:10_000});
// A signed CREATE carries one artifact of at most MAX_STORAGE_ARTIFACT_BYTES
// plus its fixed CREATE fields and bindings; a caller's projection larger than
// this is refused before it is hashed.
const SIGNED_CREATE_MAX_BYTES=4*MAX_STORAGE_ARTIFACT_BYTES;

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
// Journal snapshots are local authority only. Missing/uncertain observations
// never manufacture absence; callers await both journals before this decision.
function unsignedIntent(logicalAddress,retained,sourceRows,walletRows) {
  if(!retained || Object.hasOwn(retained,'hash') || Object.hasOwn(retained,'signedTransaction')) return false;
  if(retained.transaction?.content?.data?.[1]?.metadata?.logicalAddress!==logicalAddress) return false;
  if(retained.stage==='closing'){if(retained.error!==OPERATOR_CLOSING)return false;}
  else if(retained.stage!=='unsigned'&&retained.stage!=='intent')return false;
  const names=value=>value?.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===logicalAddress;
  return Array.isArray(sourceRows)&&Array.isArray(walletRows)&&!sourceRows.some(([,value])=>names(value))
    && !walletRows.some(([key,value])=>key.startsWith('demo/wallet/')&&names(value));
}
async function unsignedJournalIntent(logicalAddress,retained,sourceJournal,walletJournal) {
  return unsignedIntent(logicalAddress,retained,await sourceJournal.entries(),await walletJournal.entries());
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
  const reader=createDemosSr2Adapter({rpcUrl:sourceCapability.pins.endpoint,journal:createInMemoryDemosSr2Journal(),sourceCapability,now});
  const owner=wallet.getPublicAccount()?.address;
  const claim=owner ? `did:demos:agent:${owner.slice(2)}` : null;
  const signRpc=storageWriteRpcSigner(signer,claim);
  if(!owner || wallet.getWriteProfile()?.demoArtifactPublication?.policy!==DEVNET_DEMO_ARTIFACT_POLICY) throw new TypeError('the packaged seller wallet does not carry the demo artifact publication policy');
  const keyFor=(logicalAddress)=>{
    const jobPrefix=/^(?:dacs2:composite:|dacs3:commit:|dacs4:deliverable:|dacs4:evidence:)/.exec(logicalAddress);
    if(jobPrefix && !isCanonicalJobId(logicalAddress.slice(jobPrefix[0].length).split(':')[0])) fail('invalid','job address must contain a canonical uppercase ULID');
    return `demo/artifact/${exactHash([network,sourceCapability.pins.chainIdentity,claim,logicalAddress])}`;
  };

  const signedNothing=(address,retained)=>unsignedJournalIntent(address,retained,sourceCapability.journal,journal);

  async function liveNonceRows(rows,outcomes=rows) {
    const rejected=outcomes.map(([,row])=>row).filter(row=>broadcastRejected(row)&&row.transaction?.content?.from===owner);
    // An abandoned unsigned intent reserves no nonce. Use the same proof as
    // read/publish, including both signed journals, for this and other jobs.
    const unsigned=new Set();
    for(const [,row] of rows) {
      const address=row?.transaction?.content?.data?.[1]?.metadata?.logicalAddress;
      if(address && await signedNothing(address,row)) unsigned.add(row);
    }
    return rows.filter(([,row])=>!unsigned.has(row)).filter(([,row])=>!rejected.some(done=>canonicalize(done.transaction.content)===canonicalize((row?.signedTransaction??row?.transaction)?.content??null)))
      .filter(([,row])=>!(!row?.hash&&!row?.signedTransaction&&(['closing','unsigned','rejected'].includes(row?.stage)||(row?.stage==='denied'&&row.error==='user_rejected'))));
  }

  // The seller account nonce, read under the shared nonce lane: the source caps
  // the reply at NONCE_READ_LIMITS.maxBytes before decoding and honors signal;
  // a reply that misses the deadline, decodes larger or is malformed releases
  // the lane as indeterminate, and nothing is signed.
  async function accountNonce() {
    const controller=new AbortController(),timedOut=Symbol('timed out');let timer;
    const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(timedOut);},NONCE_READ_LIMITS.timeoutMs);});
    try{
      const response=await Promise.race([sourceCapability.readRpc('/',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:owner}}]},{...NONCE_READ_LIMITS,signal:controller.signal}),deadline]);
      if(response===timedOut) fail('indeterminate',`seller nonce read exceeded its ${NONCE_READ_LIMITS.timeoutMs} ms deadline`);
      if(Buffer.byteLength(JSON.stringify(response)??'')>NONCE_READ_LIMITS.maxBytes) fail('indeterminate','seller nonce reply exceeds its byte limit');
      const current=storageWriteAccountNonce(response?.response);
      if(!rpcEnvelope(response,200,null) || current===null) fail('indeterminate','seller nonce is unavailable');
      return current;
    }finally{clearTimeout(timer);controller.abort();}
  }

  async function liveSourceRows() {
    const sourceRows=await sourceCapability.journal.entries();
    return liveNonceRows(sourceRows,[...sourceRows,...await journal.entries()]);
  }

  async function observeSource(hash,projection,writeProof) {
    let observed=await sourceCapability.binding({phase:'readback',address:owner,hash,...(writeProof?{writeProof}:{})});
    if(observed.disposition==='pending' && signRpc && projection?.content?.type==='storageProgram') {
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

  // A crash after the packaged wallet broadcast but before it recorded the
  // answer leaves its own nonce lane at broadcast-started, fencing every later
  // seller CREATE. Release it only after a fresh authenticated readback shows
  // that exact original signed CREATE included; no new transaction is signed.
  async function reconcilePriorWalletLane() {
    const rows=(await liveNonceRows(await journal.entries())).filter(([key,value])=>key.startsWith('demo/wallet/')&&value?.stage==='broadcast-started'&&value?.signedTransaction?.content?.from===owner);
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
    if(broadcastRejected(retained)) return {status:'rejected',reason:'broadcast_rejected: the original demo CREATE was definitively rejected',noResend:true};
    let hash=retained.hash;
    if(!hash) {
      const candidates=(await sourceCapability.journal.entries()).map(([,value])=>value).filter((value)=>value?.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===input.logicalAddress
        && value.signedTransaction.content.from===owner);
      const hashes=new Set(candidates.map((candidate)=>candidate.hash).filter((candidate)=>typeof candidate==='string'&&candidate.length>0));
      if(hashes.size!==1) return {status:'indeterminate',reason:'the original demo CREATE hash is not uniquely retained',noResend:true};
      hash=[...hashes][0];
      // Every caller holds the artifact lock from intent lookup through save,
      // so an observation cannot overwrite a newer wallet outcome.
      await journal.put(keyFor(input.logicalAddress),{...retained,stage:'issued',hash});
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
        if(retained.inputHash!==exactHash(input)) fail('conflict','immutable demo artifact intent differs');
        authorizeRetained(retained);
        // Nothing was signed (a shutdown ended its approval, the wallet answered
        // without signing, or the process died while it was asked, with no
        // signed CREATE retained for the address): ask again below, from a
        // fresh nonce, as for a new intent. Only the operator's refusal of a
        // Listing is also asked again, when the caller says so, on the same
        // proof: its row is unsigned and neither journal retains a signed CREATE.
        const deniedListing=reaskDenied===true&&artifactKind==='Listing'&&retained.stage==='denied'&&retained.error==='user_rejected';
        if(!(await signedNothing(logicalAddress,deniedListing?{...retained,stage:'unsigned'}:retained))) return observe(input,retained);
      }
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
      const priorRows=[...(await journal.entries()),...(await sourceCapability.journal.entries())];
      const retainedNonces=(await liveNonceRows(priorRows)).flatMap(([,row])=>[row?.transaction,row?.signedTransaction])
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
        const rows=[...(await journal.entries()),...(await sourceCapability.journal.entries())];
        const signed=(await liveNonceRows(rows)).some(([,row])=>row?.signedTransaction?.content?.from===owner && row.signedTransaction.content.nonce===nonce);
        const code=answer?.error?.code;
        const stage=code==='user_rejected'?'denied':code==='broadcast_rejected'?'rejected':answer?.success===false&&!signed?'unsigned':'issued';
        await journal.put(keyFor(logicalAddress),{...intent,stage,error:code ?? 'wallet-response-missing'});
        return {status:answer?.error?.code==='user_rejected'?'rejected':'indeterminate',reason:`${answer?.error?.code ?? 'wallet-response-missing'}: ${answer?.error?.message ?? 'wallet response missing'}`.slice(0,240),noResend:true};
      }
      const issued={...intent,stage:'issued',hash:answer.data.hash};
      await journal.put(keyFor(logicalAddress),issued);
      return observe(input,issued,answer.data.writeProof);
    })));
  }
  async function read({logicalAddress,artifact,artifactKind,writer=claim,verifier=writer,deliveryBinding,fresh=false}) {
    if(writer!==claim || !artifactValid(artifactKind,artifact,writer,verifier)) return {status:'rejected',reason:'demo read scope differs'};
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
  // Whether a retained row proves the wallet never signed this CREATE. The
  // packaged wallet journals the signed bytes (its own journal, and the
  // source's before it broadcasts) before anything leaves the process, and
  // publish holds this address's lock from the intent through the wallet's
  // answer, so a row this read finds is never mid-request. The row must be one
  // publish writes before or without a signature, carry no hash, and have no
  // signed CREATE for its address retained by the source or this seller's
  // wallet, checked again on every read: a 'closing' row exactly as publish
  // writes it (a shutdown ended the approval), an 'unsigned' one (the wallet
  // answered without signing), or an 'intent' one (the process died while the
  // wallet was asked: a signature it made but did not journal was never sent).
  // Any other row reads as before (plain absence for 'closing', else a readback).
  // Whether the source or this seller's wallet retains a signed CREATE for the
  // address.
  async function signedCreateRetained(logicalAddress) {
    const names=(value)=>value?.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===logicalAddress;
    return (await sourceCapability.journal.entries()).some(([,value])=>names(value))
      || (await journal.entries()).some(([key,value])=>key.startsWith('demo/wallet/')&&names(value));
  }
  // publish stores its intent before it asks the wallet to sign anything, and
  // this read holds the address's lock, so an address with no intent row (and
  // no signed CREATE retained anywhere for it) was never asked of the wallet:
  // the proven absence a held native Deliverable needs to be asked again.
  async function noIntentAbsence(logicalAddress) {
    return (await signedCreateRetained(logicalAddress)) ? {status:'absent',reason:NO_INTENT_ABSENT} : provenUnsignedAbsence(NO_INTENT_ABSENT);
  }
  // Passive: whether this seller's journal retains a CREATE intent for the
  // address. No readback, resend or write, and nothing is authorized by it.
  async function hasIntent(logicalAddress) {
    return Boolean(await journal.get(keyFor(logicalAddress)));
  }
  async function readRetained({logicalAddress,artifactKind,writer=claim,fresh=false,proofOfNoIntent=false}) {
    if(writer!==claim || !kinds.has(artifactKind) || typeof proofOfNoIntent!=='boolean') return {status:'rejected',reason:'demo retained read scope differs'};
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
    try { const text=JSON.stringify(content); return Buffer.byteLength(text,'utf8')<=SIGNED_CREATE_MAX_BYTES ? text : null; } catch { return null; }
  };
  const projectionAuthentic=(projection,receipt)=>{
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
