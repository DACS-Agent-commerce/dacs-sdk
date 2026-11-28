// Bridge to the Node wallet session's explicit storage-anchor kind. The
// session owns approval, SDK signing, confirmation and dispatch, each through
// its effect boundary, and its native transport runs recovery through the same
// boundary. This module owns the retained logical plan and independent native/block
// readback. Only an injected operator signer permits identical recovery of a
// seller evidence CREATE; the user's wallet path remains readback-only.
import {
  ARTIFACT_SEPARATORS,
  canonicalize,
  contentHash,
  sha256Hex,
  isPayeeBoundAgreementDocument,
  isSettlementEvidence,
  createFixedPriceAgreementSigningPlan,
  fixedPriceAgreementSignedBytes,
  paymentEvidenceAddress,
  signedBytes,
} from '@kynesyslabs/dacs';
import { addressForClaim, verifyDemosSignature } from '../signatures.mjs';
import { storageWriteRpcSigner } from '../devnet-demo/storage-write-recovery.mjs';
import { OPERATOR_CLOSING } from '../devnet-demo/operator-approval.mjs';
import { createWalletLaneView, walletLane, walletLaneKey } from '../wallet/wallet-lane.mjs';
import { deepFreeze } from '../util/deep-freeze.mjs';
import { createDemosSr2Adapter, demosSr2Contradiction, isDemosSr2Contradiction } from './demos-sr2-adapter.mjs';
import { isDevnetAgreementTransport, isDevnetSettlementTransport, isDevnetDeliveryTransport, DEVNET_AGREEMENT_KIND, DEVNET_AGREEMENT_PROFILE, DEVNET_SETTLEMENT_KIND, DEVNET_DELIVERY_KIND, DEVNET_DELIVERY_POLICY } from '../wallet/devnet-native-transport.mjs';

export const SR2_WALLET_KIND = 'dacs-storage-anchor-create';
const clone = (v) => structuredClone(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const settlementRail = 'demos-native:DEM';
const settlementPhaseIndex = 2;
const exactKeys = (value, keys) => object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export class DemosSr2BridgeError extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; }
}
const fail = (code, message, options) => { throw new DemosSr2BridgeError(code, message, options); };

/**
 * The `anchor` and `resume` refusal codes that mean no wallet handoff was issued for the plan, so nothing was handed
 * to the wallet, signed or sent. A caller may drop a retained intent on one of them and anchor afresh later.
 */
export const PAID_WRITE_NOT_ISSUED_CODES = Object.freeze(['paid-write-callback-required', 'paid-write-permit-required', 'handoff-not-issued']);

// The seller-side SDK producer for this profile emits one exact pay-dem
// success variant. SettlementEvidence has no artifactType, so its kind is
// carried separately in CREATE metadata. Keep the accepted surface narrower
// than the SDK's forward-readable validator: this bridge binds the seller
// writer, phase, rail, phase index, job, address and original component
// signature, but never rewrites the signed artifact.
function settlementEvidenceMatches(input, value, hash) {
  if (input.artifactKind !== 'SettlementEvidence' || Object.hasOwn(value, 'artifactType') || !isSettlementEvidence(value)
    || !exactKeys(value, ['evidenceVersion', 'jobId', 'phase', 'outcome', 'paymentTxRefs', 'paymentAmount', 'settlementFinality', 'observedAt', 'signature'])
    || value.phase !== 'pay-dem' || value.outcome !== 'success'
    || input.logicalAddress !== paymentEvidenceAddress(value.jobId, settlementRail, settlementPhaseIndex)
    || !Array.isArray(value.paymentTxRefs) || value.paymentTxRefs.length !== 1
    || !exactKeys(value.paymentTxRefs[0], ['kind', 'txHash', 'blockNumber']) || value.paymentTxRefs[0].kind !== 'demos'
    || !/^[0-9a-f]{64}$/.test(value.paymentTxRefs[0].txHash) || !Number.isSafeInteger(value.paymentTxRefs[0].blockNumber) || value.paymentTxRefs[0].blockNumber < 0
    || !exactKeys(value.paymentAmount, ['amount', 'currency']) || value.paymentAmount.currency !== 'DEM'
    || !exactKeys(value.settlementFinality, ['model', 'finalityObservedAt']) || value.settlementFinality.model !== 'bft-final'
    || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || value.settlementFinality.finalityObservedAt !== value.observedAt
    || !exactKeys(value.signature, ['algorithm', 'signer', 'value']) || value.signature.algorithm !== 'ed25519' || value.signature.signer !== input.writer) return false;
  const message = Buffer.from(signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, hash)).toString('utf8');
  return verifyDemosSignature({ address: addressForClaim(input.writer), message, signature: value.signature.value });
}

function deliverableMatches(input, value, hash) {
  const binding=input.deliveryBinding;
  return input.artifactKind==='Deliverable' && !Object.hasOwn(value,'artifactType')
    && exactKeys(value,['reportVersion','kind','jobId','agreementHash','listing','title','settlementId','body'])
    && value.reportVersion==='1' && value.kind==='dacs-chatgpt-plugin/fixture-test-report' && value.jobId===input.jobId
    && /^[0-9a-f]{64}$/.test(value.agreementHash ?? '') && Array.isArray(value.body) && value.body.every((line)=>typeof line==='string')
    && exactKeys(binding,['version','profile','jobId','phase','phaseIndex','listing','agreementHash','fulfilmentId','purchaseAmount','payloadHash'])
    && binding.version==='1' && binding.profile===DEVNET_DELIVERY_POLICY && binding.jobId===value.jobId
    && binding.phase==='deliver-storage-program' && Number.isSafeInteger(binding.phaseIndex) && binding.phaseIndex>=0
    && canonicalize(binding.listing)===canonicalize(value.listing) && binding.agreementHash===value.agreementHash
    && typeof binding.fulfilmentId==='string' && binding.fulfilmentId.length>0 && binding.fulfilmentId.length<=128
    && exactKeys(binding.purchaseAmount,['amount','currency']) && binding.purchaseAmount.currency==='DEM' && typeof binding.purchaseAmount.amount==='string'
    && binding.payloadHash===hash && input.logicalAddress===`dacs4:deliverable:${value.jobId}`;
}

function snapshot(input) {
  const value = JSON.parse(canonicalize(input.artifact));
  const bytes = canonicalize(value);
  if (!object(value) || typeof value.jobId !== 'string' || !value.jobId || (input.jobId !== undefined && input.jobId !== value.jobId)) fail('invalid', 'artifact kind and matching job are required');
  if (Buffer.byteLength(bytes) > 24 * 1024) fail('artifact-bound', 'the unchanged wallet relay supports at most 24 KiB of anchor data');
  if (/[^\x00-\x7f]/.test(bytes)) fail('non-ascii-held', 'the pinned SDK non-ASCII signing-hash mismatch remains held');
  const hash = contentHash(value);
  if (input.receiptContentHash !== undefined && input.receiptContentHash !== hash) fail('hash-profile-held', 'this frozen wallet supports only SDK contentHash signed scope');
  if (Object.hasOwn(value, 'artifactType')) {
    if (input.artifactKind === 'SettlementEvidence') fail('invalid', 'SettlementEvidence kind is out-of-band and must not be injected into its signed artifact');
    if (typeof value.artifactType !== 'string' || !value.artifactType || (input.artifactKind !== undefined && input.artifactKind !== value.artifactType)) fail('invalid', 'artifact kind differs from its declared type');
  } else {
    // No inference/default: these normative documents have no artifactType.
    // The separate discriminator is bound in CREATE metadata, never injected.
    if (input.artifactKind === 'Agreement') {
      if (!isPayeeBoundAgreementDocument(value) || value.derivedFromPattern !== 'fixed-price'
        || input.logicalAddress !== `dacs3:agreement:${value.jobId}`) fail('invalid', 'explicit Agreement kind and exact normative job address are required');
      const buyer = value.parties.find((p) => p.role === 'buyer');
      const seller = value.parties.find((p) => p.role === 'seller');
      if (buyer.primaryClaim !== input.writer || canonicalize(value.terms.rail) !== canonicalize({ railId: settlementRail, railVersion: 1 })
        || value.terms.price.currency !== 'DEM' || canonicalize(value.terms.payoutBindings) !== canonicalize([{ railId: settlementRail, phaseIndex: settlementPhaseIndex, payeeAddress: addressForClaim(seller.primaryClaim) }])) fail('invalid', 'Agreement buyer, DEM rail or payee binding differs from the supported profile');
      const { signatures, ...draft } = value;
      const message = Buffer.from(fixedPriceAgreementSignedBytes(createFixedPriceAgreementSigningPlan(draft))).toString('utf8');
      if (signatures.some((s) => s.algorithm !== 'ed25519' || !verifyDemosSignature({ address: addressForClaim(s.party), message, signature: s.value }))) fail('invalid', 'Agreement signatures do not authorize these exact signed bytes');
    } else if (!settlementEvidenceMatches(input, value, hash) && !deliverableMatches(input,value,hash)) {
      fail('invalid', 'explicit SettlementEvidence/Deliverable kind or bound bytes differ');
    }
  }
  return { logicalAddress: input.logicalAddress, artifact: value, writer: input.writer, receiptContentHash: hash,
    ...(input.artifactKind !== undefined ? { artifactKind: input.artifactKind } : {}),
    ...(input.deliveryBinding !== undefined ? { deliveryBinding:clone(input.deliveryBinding) } : {}) };
}

// Inject an atomic journal with async-compatible get(key), put(key,value),
// entries() -> [key,value][], withWalletLock(key,work). No RAM or filesystem
// fallback is installed here. All entries contain only public transaction /
// approval / receipt material; the wallet keeps its secret locally.
//
// `obtainPaidWritePermit(request, { preparePaidWrite, authorizePaidWrite })` is the
// host's paid-write callback. Before the handoff is issued, `anchor` hands it the
// deeply frozen `{ method: 'sendTransaction', params: [createRequest] }` it will send
// and the two paid-write members of the wallet view; it sends that object once with
// `{ paidApproval: permit }`. A paid-approval view with no callback refuses
// `paid-write-callback-required`; a callback that throws or returns no object refuses
// `paid-write-permit-required` (its error is the cause). Both leave the plan prepared.
export function createDemosSr2WalletBridge({ rpcUrl, network, journal, walletFactory, obtainPaidWritePermit, sourceCapability = null, signer, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (!isDevnetAgreementTransport(sourceCapability)) fail('profile-held','an opaque source Agreement capability is required');
  const profile = DEVNET_AGREEMENT_PROFILE;
  const mode = 'explicit-pinned-transport-single-node';
  const kindFor = (input) => input.artifactKind === 'SettlementEvidence' ? DEVNET_SETTLEMENT_KIND : input.artifactKind === 'Deliverable' ? DEVNET_DELIVERY_KIND : DEVNET_AGREEMENT_KIND;
  const visible = 'native-read-visible';
  if (!journal || ['get', 'put', 'entries', 'withWalletLock'].some((k) => typeof journal[k] !== 'function')) fail('journal-required', 'an explicit shared atomic journal is required');
  if (typeof walletFactory !== 'function') fail('wallet-required', 'an explicit packaged-wallet factory is required');
  if (typeof network !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(network)) fail('invalid', 'an explicit fixture network label is required');
  if (obtainPaidWritePermit !== undefined && typeof obtainPaidWritePermit !== 'function') fail('invalid', 'obtainPaidWritePermit must be a function when it is given');
  const adapterPrefix = 'sr2/adapter/';
  const lane = (address) => walletLane({ network, chainIdentity: sourceCapability.pins.chainIdentity, address });
  const laneKey = (address) => walletLaneKey(lane(address));
  async function exactPut(key, record) {
    await journal.put(key, clone(record));
    const retained = await journal.get(key);
    if (!retained || canonicalize(retained) !== canonicalize(record)) fail('journal-error', 'the exact issued stage was not retained');
  }
  const walletJournal = createWalletLaneView({ journal });
  const adapterJournal = {
    get: async (id) => clone(await journal.get(adapterPrefix + id)),
    put: async (record) => exactPut(adapterPrefix + record.planId, record),
    records: async () => (await journal.entries()).filter(([key]) => key.startsWith(adapterPrefix)).map(([, value]) => clone(value)),
    withWalletLock: (key, work) => {
      const [, writer] = JSON.parse(key);
      return journal.withWalletLock(laneKey(addressForClaim(writer)), work);
    },
  };
  const adapter = createDemosSr2Adapter({ rpcUrl, journal: adapterJournal, sourceCapability, fetchImpl, now });
  const wallet = walletFactory({ anchorJournal: walletJournal });
  if (!wallet || ['request', 'getPublicAccount', 'getWriteProfile'].some((k) => typeof wallet[k] !== 'function')) fail('wallet-required', 'the packaged wallet contract is unavailable');
  const paidApprovalView = typeof wallet.preparePaidWrite === 'function' && typeof wallet.authorizePaidWrite === 'function';

  function owner(input) {
    const account = wallet.getPublicAccount();
    if (!account?.address) fail('wallet-locked', 'the embedded wallet is locked');
    if (addressForClaim(input.writer) !== account.address) fail('wrong-writer', 'this anchor belongs to another wallet');
    const capability = wallet.getWriteProfile();
    const kind=kindFor(input);
    if (sourceCapability && input.artifactKind === 'SettlementEvidence' && !isDevnetSettlementTransport(sourceCapability)) fail('profile-held','the separate source SettlementEvidence publication policy is absent');
    if (sourceCapability && input.artifactKind === 'Deliverable' && !isDevnetDeliveryTransport(sourceCapability)) fail('profile-held','the separate source Deliverable publication policy is absent');
    if (capability?.profile !== profile || capability.network !== network || !capability.transactionKinds?.includes(kind)) fail('profile-held', 'the explicit wallet anchor kind is unavailable or held');
    return account.address;
  }
  function result(status, extra = {}) { return { ...extra, status, evidenceMode: mode, finality: 'not-established' }; }

  async function finish(input, plan, address) {
    const key = laneKey(address);
    const record = await journal.get(key);
    // A verified older anchor may be read while a newer lane is occupied, but
    // it must never overwrite or release that newer lane's authority.
    if (plan.stage === 'verified' && record?.hash !== plan.transactionHash) {
      const readback = await adapter.read(input.logicalAddress, { expectedWriter: input.writer, expectedArtifactKind: input.artifactKind, expectedDeliveryBinding:input.deliveryBinding });
      // An authenticated readback that holds other content, or a receipt the
      // adapter finds contradicted, is a contradiction; anything else not
      // reauthenticated is refused unmarked (the source change).
      if (readback.status === 'present' && (readback.receipt.contentHash !== input.receiptContentHash || sha256Hex(canonicalize(readback.artifact)) !== sha256Hex(canonicalize(input.artifact)))) throw demosSr2Contradiction('verified anchor content changed');
      const verdict = readback.status === 'present' ? await adapter.verifyReceipt({ receipt: readback.receipt, logicalAddress: input.logicalAddress, artifact: input.artifact, expectedWriter: input.writer, artifactKind: input.artifactKind, deliveryBinding:input.deliveryBinding }) : null;
      if (verdict === 'invalid') throw demosSr2Contradiction('verified anchor receipt is contradicted');
      if (verdict !== 'valid') fail('invalid', 'verified anchor content changed or is not reauthenticated');
      return result(visible, { plan, ...readback });
    }
    await adapter.adoptWalletAuthorization({ planId: plan.planId, walletRecord: record });
    const signRpc=storageWriteRpcSigner(signer,input.writer);
    if(sourceCapability && signRpc && input.artifactKind==='SettlementEvidence') {
      await sourceCapability.recoverStorageWrite({signedTransaction:record.signedTransaction,signRpc});
    }
    const receipt = await adapter.write({ ...input, transactionHash: record.hash });
    const readback = await adapter.read(input.logicalAddress, { expectedWriter: input.writer, expectedArtifactKind: input.artifactKind, expectedDeliveryBinding:input.deliveryBinding });
    // Independent observations can have different observedAt values. Verify
    // each portable receipt against current inclusion/native facts instead of
    // treating equal wall-clock observations as a finality condition.
    if (readback.status !== 'present'
      || await adapter.verifyReceipt({ receipt, logicalAddress: input.logicalAddress, artifact: input.artifact, expectedWriter: input.writer, artifactKind: input.artifactKind, deliveryBinding:input.deliveryBinding }) !== 'valid'
      || await adapter.verifyReceipt({ receipt: readback.receipt, logicalAddress: input.logicalAddress, artifact: input.artifact, expectedWriter: input.writer, artifactKind: input.artifactKind, deliveryBinding:input.deliveryBinding }) !== 'valid') fail('indeterminate', 'independent native receipt readback is not established');
    await journal.withWalletLock(key, async () => {
      const current = await journal.get(key);
      if (current?.hash !== record.hash || canonicalize(current.signedTransaction) !== canonicalize(record.signedTransaction)) fail('journal-error', 'the wallet lane changed during receipt readback');
      await exactPut(key, { ...current, stage: 'broadcast-accepted', anchorReceipt: receipt, observation: visible });
    });
    {
      const observed = await sourceCapability.binding({phase:'readback',address,hash:record.hash});
      if (observed.disposition !== 'included') fail('indeterminate','the retained source CREATE must independently read back before releasing its nonce lane');
    }
    return result(visible, { plan: { ...plan, stage: 'verified', transactionHash: record.hash }, ...readback });
  }

  // the source change: a readback refusal is rejected only for the adapter's authenticated
  // contradiction or the wallet lane's own refusals. A node answer that does
  // not authenticate (unmarked invalid), another chain identity or any other
  // fault is indeterminate and stays readback-only.
  function observationError(error, plan) {
    return result(isDemosSr2Contradiction(error) || ['wrong-writer', 'conflict', 'authorization-required'].includes(error?.code) ? 'rejected' : 'indeterminate',
      { code: error?.code ?? 'observation-error', ...(plan ? { plan } : {}) });
  }

  // the source change: with no plan retained (the first anchor, or recovery after the
  // adapter's plan is lost), planWrite reads the logical address. Its `invalid`
  // follows the readback rule above: rejected only for a marked contradiction,
  // otherwise indeterminate. Its other refusals still throw to the caller.
  async function planned(input) {
    try { return { plan: await adapter.planWrite(input) }; }
    catch (error) { if (error?.code === 'invalid') return { refused: observationError(error) }; throw error; }
  }

  const sendRequest = (input, kind, handoff) => ({ method: 'sendTransaction', params: [{ kind, profile, network, owner: input.writer,
    artifactKind: input.artifactKind ?? input.artifact.artifactType, jobId: input.artifact.jobId, logicalAddress: input.logicalAddress,
    contentHash: handoff.contentHash, envelopeHash: handoff.envelopeHash, transaction: handoff.unsignedTransaction }] });

  async function permitFor(request) {
    let permit;
    const members = Object.freeze({ preparePaidWrite: wallet.preparePaidWrite, authorizePaidWrite: wallet.authorizePaidWrite });
    try { permit = await obtainPaidWritePermit(request, members); } catch (cause) { fail('paid-write-permit-required', 'the host paid-write callback gave no permit', { cause }); }
    if (permit === null || typeof permit !== 'object') fail('paid-write-permit-required', 'the host paid-write callback gave no permit');
    return permit;
  }

  // The host approves a read-only preview while the plan is still prepared, so a refusal burns nothing. The handoff is
  // issued only after that, and the previewed object is sent only when the issued handoff yields the same request.
  async function sendWithPermit(input, kind, target) {
    const request = deepFreeze(sendRequest(input, kind, await adapter.previewStorageAnchorHandoff(target)));
    const permit = await permitFor(request);
    const handoff = await adapter.takeStorageAnchorHandoff(target);
    if (canonicalize(sendRequest(input, kind, handoff)) !== canonicalize(request)) fail('paid-write-request-changed', 'the issued handoff differs from the request the host approved');
    return { handoff, answer: await wallet.request(request, { paidApproval: permit }) };
  }

  async function anchor(raw) {
    const input = snapshot(raw);
    const kind=kindFor(input);
    const address = owner(input);
    const { plan, refused } = await planned(input);
    if (refused) return refused;
    if (plan.stage !== 'prepared') {
      // A retry only reconciles the retained record. It does not call request.
      try { return await finish(input, plan, address); } catch (error) { return observationError(error, plan); }
    }
    const target = { planId: plan.planId, walletAddress: address, network };
    if (!obtainPaidWritePermit && paidApprovalView) fail('paid-write-callback-required', 'this wallet sends a paid write only with the host paid-write callback');
    let handoff, answer;
    if (obtainPaidWritePermit) ({ handoff, answer } = await sendWithPermit(input, kind, target));
    else {
      handoff = await adapter.takeStorageAnchorHandoff(target);
      answer = await wallet.request(sendRequest(input, kind, handoff));
    }
    if (!answer?.success) {
      // An unknown outcome remains unknown even when a fixture may have
      // applied it. An explicit later anchor/resume performs readback only.
      // A shutdown cut (OPERATOR_CLOSING) is no decision: nothing was signed,
      // and the issued handoff stays read-back-only exactly as after a crash.
      const undecided = ['outcome_unknown', OPERATOR_CLOSING].includes(answer?.error?.code);
      return result(undecided ? 'indeterminate' : 'rejected', { plan: handoff, code: answer?.error?.code ?? 'wallet-response-missing' });
    }
    try { return await finish(input, handoff, address); } catch (error) { return observationError(error, handoff); }
  }

  async function resume(raw) {
    const input = snapshot(raw);
    const address = owner(input);
    const { plan, refused } = await planned(input);
    if (refused) return refused;
    if (plan.stage === 'prepared') fail('handoff-not-issued', 'no wallet handoff was issued for this plan, and resume cannot issue one');
    try { return await finish(input, plan, address); } catch (error) { return observationError(error, plan); }
  }

  // Only for an explicit wallet denial already recorded by the caller. The
  // adapter holds this wallet's lane lock (the same key the wallet journal
  // uses), so the lane is read here without re-entering it: any signed record
  // naming this plan's address or nonce keeps the handoff fenced.
  async function retireDenied(raw) {
    const input = snapshot(raw);
    const address = owner(input);
    return adapter.retireDeniedHandoff({ logicalAddress: input.logicalAddress, writer: input.writer, walletAddress: address,
      provesUnsigned: async (plan) => {
        const record = await journal.get(laneKey(address));
        return !record || (record.approved?.logicalAddress !== plan.logicalAddress && record.nonce !== plan.nonce
          && record.signedTransaction?.content?.nonce !== plan.nonce);
      } });
  }

  return { wallet, evidenceMode: mode, anchor, resume, retireDenied,
    read: (logicalAddress, options) => adapter.read(logicalAddress, options),
    verifyReceipt: (input) => adapter.verifyReceipt(input) };
}
