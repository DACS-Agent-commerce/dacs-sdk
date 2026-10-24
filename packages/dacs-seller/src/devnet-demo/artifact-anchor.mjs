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
import { storageWriteRpcSigner } from './storage-write-recovery.mjs';
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
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../dacs/wallet-transactions.mjs';
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
  throw new Error("artifact publication is not assembled");
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
  // lock with no await before the intent is stored. Anything but true refuses:
  // no intent is stored and nothing is sent. Without it, publish is unchanged.
  // reaskDenied (optional, a Listing only): a retained intent the packaged
  // wallet refused at its approval (denied: user_rejected, before it signed
  // anything) is replaced under this lock by a fresh intent and asked again.
  // Every other retained intent is only read back, as without it, apart from
  // a 'closing' one (a shutdown ended its approval), which is always asked again.
}
