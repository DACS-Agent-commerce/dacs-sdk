import {
  ARTIFACT_SEPARATORS, DACS_STANDARD_PIN, bundleAddress, canonicalize, compositeVerificationAddress,
  contentHash, finalityCommitmentAddress, fixedPriceAgreementLogicalAddress, isAnchorReceipt,
  isAttestationRef, isCanonicalJobId, isPayeeBoundAgreementDocument, paymentEvidenceAddress, sha256Hex,
} from '@kynesyslabs/dacs';
import { addressForClaim, claimForAddress, verifyDemosSignature } from '../signatures.mjs';

export const COMPLETION_READINESS_STANDARD_PIN = 'd45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20';
const PROFILES = new Set(['dacs-chatgpt-plugin/fixed-price-pay-dem/v1', 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', 'dacs-chatgpt-plugin/devnet-pay-dem-purchase/v1']);
const CURRENT_DELIVERY = new Set(['delivery-ready', 'delivered', 'awaiting-countersignature', 'completed', 'bundle-rejected']);
const HEX64 = /^[0-9a-f]{64}$/;
const stringMatches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const isHex64 = (value) => stringMatches(HEX64, value);
const isDemosClaim = (value) => stringMatches(/^did:demos:agent:[0-9a-f]{64}$/, value);
const SPEC = Object.freeze({
  implementation: ['CORE §11.1.2(2)'],
  admission: ['CORE §11.1.2(3)', 'PROFILE: Unreleased corrective candidate'],
  scope: ['CORE §B.1', 'DACS-5 §10.3.1 ST-11'],
  vet: ['DACS-2 §7.7–7.8', 'DACS-5 §10.3.1 ST-11(1–2)', 'DACS-5 §10.4.3'],
  agreement: ['DACS-3 §8.5–8.6', 'DACS-4 §9.9', 'DACS-5 §10.3.1 ST-11(3)'],
  commitment: ['DACS-3 §8.6', 'DACS-5 §10.3.1 ST-11(1–3)'],
  payment: ['DACS-4 §9.5.8–9.5.9', 'DACS-4 §9.7', 'DACS-5 §10.3.1 ST-11(1–2)'],
  delivery: ['DACS-4 §9.6.1', 'DACS-4 §9.7', 'DACS-5 §10.3.1 ST-11(1–2)'],
  bundle: ['DACS-5 §10.4.1–10.4.3', 'DACS-5 §10.3.1 ST-11(4–5)', 'DEMOS-MAPPING §A.2'],
  finality: ['CORE §5.1', 'DACS-4 §9.5.9', 'DACS-5 §10.3.1 ST-11', 'DEMOS-MAPPING §A.2'],
});
const same = (a, b) => { if (a === undefined && b === undefined) return true; try { return canonicalize(a) === canonicalize(b); } catch { return false; } };
const hash = (value) => { try { return contentHash(value); } catch { return null; } };
const payloadHash = (value) => { try { return sha256Hex(canonicalize(value)); } catch { return null; } };
// y-coordinates of the eight small-order Ed25519 points (orders 1, 2, 4, 8). The
// sign bit is ignored and non-canonical y >= p is reduced, so every encoding of
// those points is refused: they verify constant forgeries without a private key.
const P25519 = 2n ** 255n - 19n, Y8 = 2707385501144840649318225287225658788936804267575313519463743609750303402022n;
const SMALL_ORDER_Y = new Set([0n, 1n, P25519 - 1n, Y8, P25519 - Y8]);
const smallOrderKey = (claim) => {
  const hex = isDemosClaim(claim) ? claim.slice('did:demos:agent:'.length) : null;
  return hex == null || SMALL_ORDER_Y.has((BigInt(`0x${hex.match(/../g).reverse().join('')}`) & ((1n << 255n) - 1n)) % P25519);
};
// CORE §B.7 SIG-6: exact unpadded Base64URL of 64 bytes, round-trip exact (no hex,
// prefix, padding, whitespace or residual bits) before cryptographic verification.
const canonicalSignature = (value) => stringMatches(/^[A-Za-z0-9_-]{86}$/, value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const signatureValid = (signer, message, value, algorithm = 'ed25519') => {
  try { return algorithm === 'ed25519' && canonicalSignature(value) && !smallOrderKey(signer) && verifyDemosSignature({ address: addressForClaim(signer), message, signature: value }); } catch { return false; }
};
// Reference signer expectation when no authenticated authority is retained.
const AUTHORITY_UNAVAILABLE = Symbol('authority unavailable');
const fixtureReceipt = (r) => [r.substrate, r.finalityProfile, r.evidence?.kind, r.transactionRef?.kind]
  .some((value) => stringMatches(/fixture|simulat/i, value));

// Recorded-state inspection only. No resolver or finality authority exists in
// this slice; matching pointers and valid detached signatures cannot close ST-11.
export function evaluateCompletionReadiness(operation, protocolView) {
  const requirements = [];
  const add = (id, status, code, reason, spec) => requirements.push({ id, status, code, reason, specSections: [...SPEC[spec]] });
  const t = operation?.terms ?? {}, p = operation?.state?.protocol ?? {};
  const jobId = t.protocol?.jobId;
  const profile = t.protocol?.profile;
  let buyer = null;
  try { buyer = claimForAddress(t.buyer?.wallet); } catch {}
  const seller = t.seller?.claim;
  const a = p.agreement, artifact = a?.artifact, agreementHash = hash(artifact);
  const native = t.protocol?.transportBinding?.source === 'devnet-agreement-transport/v1';
  const view = protocolView;
  const scopeValid = PROFILES.has(profile) && DACS_STANDARD_PIN === COMPLETION_READINESS_STANDARD_PIN;
  add('profile.implementation', scopeValid ? 'present' : 'mismatch', scopeValid ? 'profile.implementation-recognized' : 'profile.unsupported', scopeValid
    ? 'Recognized application profile at the installed SDK Standard pin; this identifies the implementation only and admits no completion profile.'
    : 'Application profile or installed SDK Standard revision is unsupported.', 'implementation');
  add('profile.completion', 'unavailable', 'profile.not-admitted', 'No released completion profile tuple is selected and authenticated for this session; the unreleased corrective candidate is not admitted.', 'admission');
  const jobValid = isCanonicalJobId(jobId) && buyer !== null && isDemosClaim(seller);
  add('purchase.scope', jobValid ? 'present' : 'mismatch', jobValid ? 'scope.recorded' : 'scope.invalid', jobValid
    ? 'Canonical job and purchase-bound buyer and seller identities are recorded.' : 'Canonical job or purchase-bound buyer/seller identity is missing or malformed.', 'scope');
  const viewMatches = view != null && !view.notSaved && Number.isSafeInteger(p.revision ?? 0) && view.revision === (p.revision ?? 0) && view.profile === profile && view.jobId === jobId && view.stage === p.stage
    && same(view.agreement?.hash, a?.hash) && same(view.commitment, p.commitment ?? null)
    && same(view.paymentEvidence, p.paymentEvidence ?? null)
    && same(view.delivery?.deliverableRef, CURRENT_DELIVERY.has(p.stage) ? p.delivery?.deliverableRef : undefined)
    && same(view.delivery?.evidenceRef, CURRENT_DELIVERY.has(p.stage) ? p.delivery?.evidenceRef : undefined)
    && same(view.delivery?.report, CURRENT_DELIVERY.has(p.stage) ? p.delivery?.report : undefined)
    && same(view.bundle?.bundleHash, p.bundle?.bundleHash);
  add('protocol.view', view == null ? 'unavailable' : viewMatches ? 'present' : 'mismatch', view == null ? 'view.unavailable' : viewMatches ? 'view.matches' : 'view.mismatch', view == null
    ? 'Protocol view is unavailable; current delivery cannot be established.' : viewMatches
      ? 'Protocol view agrees with the recorded job, profile, stage and evidence pointers.' : 'Protocol view differs from the recorded job, profile, stage or evidence pointers.', 'scope');

  function reference(id, ref, logical, expectedHash, writer, receipt, spec) {
    if (ref == null) return add(id, 'missing', 'reference.missing', `No recorded reference for ${logical}.`, spec);
    if (!isAttestationRef(ref) || ref.anchor.kind !== 'storage-program') return add(id, 'mismatch', 'reference.shape', 'Reference is not an exact storage-program AttestationRef.', spec);
    if (!jobValid || ref.anchor.locator !== logical && !(receipt?.logicalAddress === logical && ref.anchor.locator === receipt.nativeAddress)) return add(id, 'mismatch', 'reference.address', `Reference does not bind the expected job/address ${logical}.`, spec);
    if (expectedHash != null && ref.contentHash !== expectedHash) return add(id, 'mismatch', 'reference.hash', 'Reference hash differs from the recorded artifact or bound hash.', spec);
    if (writer !== AUTHORITY_UNAVAILABLE && ref.signer !== undefined && ref.signer !== writer) return add(id, 'mismatch', 'reference.signer', 'Reference signer differs from the purchase-bound authority.', spec);
    add(id, 'present', 'reference.matches', `Recorded pointer matches ${logical}; pointer matching does not resolve or authenticate its artifact.`, spec);
  }
  function receipt(id, r, logical, expectedHash, writer, ref, spec) {
    if (r == null) return add(id, 'missing', 'receipt.missing', `No recorded AnchorReceipt for ${logical}.`, spec);
    if (!isAnchorReceipt(r)) return add(id, 'mismatch', 'receipt.shape', 'Receipt is not an exact CORE AnchorReceipt; a bare finalized label is insufficient.', spec);
    if (!jobValid || r.logicalAddress !== logical) return add(id, 'mismatch', 'receipt.job', `Receipt does not bind the expected job/address ${logical}.`, spec);
    if (!isHex64(expectedHash) || r.contentHash !== expectedHash) return add(id, 'mismatch', 'receipt.hash', 'Receipt hash differs from the bound artifact hash, or that hash is unavailable.', spec);
    if (r.writer !== writer) return add(id, 'mismatch', 'receipt.writer', 'Receipt writer differs from the purchase-bound authority.', spec);
    if (ref && ref.anchor?.locator !== logical && ref.anchor?.locator !== r.nativeAddress) return add(id, 'mismatch', 'receipt.native', 'Receipt native address differs from the recorded reference.', spec);
    if (fixtureReceipt(r)) return add(id, native ? 'mismatch' : 'unavailable', native ? 'receipt.fixture-as-native' : 'receipt.fixture', 'Fixture receipt cannot establish native inclusion or DACS-5 finality.', spec);
    if (r.substrate !== 'demos' || r.finalityProfile !== 'demos-bft-confirmed-native-read') return add(id, 'mismatch', 'receipt.profile', 'Receipt substrate/finality profile is not the pinned SDK Demos binding.', spec);
    if (r.state !== 'finalized' || r.observationDisposition !== 'established') return add(id, 'unavailable', 'receipt.nonfinal', 'Recorded receipt is non-final or its observation is indeterminate; completion stays held.', spec);
    add(id, 'unavailable', 'receipt.unauthenticated', 'Matching finalized-shaped receipt is recorded; native resolution, transaction/nonce and consensus proof are not authenticated by this evaluator.', spec);
  }
  function unresolved(id, ref, spec) {
    add(id, ref == null ? 'missing' : 'unavailable', ref == null ? 'artifact.missing' : 'artifact.unresolved', ref == null
      ? 'No artifact reference is recorded.' : 'Only a recorded reference/summary is available; signed artifact bytes and their dependencies are unresolved.', spec);
  }
  // Malformed entries are left to the Agreement shape check instead of dereferenced.
  // A dense copy turns holes into undefined, which every() would otherwise skip.
  const partyEntries = Array.isArray(artifact?.parties) ? Array.from(artifact.parties) : [];
  const parties = partyEntries.every((entry) => entry !== null && typeof entry === 'object') ? partyEntries : [];
  for (const role of ['buyer', 'seller']) {
    const party = parties.find((entry) => entry.role === role);
    const claim = role === 'buyer' ? buyer : seller;
    const ref = party?.vetRecordRef ?? p.agreementContext?.input?.[role]?.vetRecordRef;
    const logical = jobValid ? compositeVerificationAddress(jobId, claim) : 'unavailable Vet address';
    reference(`vet.${role}.reference`, ref, logical, null, AUTHORITY_UNAVAILABLE, null, 'vet');
    add(`vet.${role}.signer`, 'unavailable', 'vet.signer-unavailable', `The ${role} composite must be signed by the verifier that ran Vet on it; without authenticated per-role Vet provenance, signer authority is not inferred from either role or a recorded signer label.`, 'vet');
    unresolved(`vet.${role}.record`, ref, 'vet');
    add(`vet.${role}.receipt`, 'missing', 'receipt.missing', 'Vet AnchorReceipt is not retained in the purchase state; a reference is insufficient.', 'vet');
    add(`vet.${role}.provenance`, 'unavailable', 'vet.provenance', 'Counterparty requirement origin, verifier authority, signatures, method/source/freshness and composite closure are not available for independent replay; operator-produced refs do not prove mutual Vet (T2).', 'vet');
  }

  const agreementAddress = jobValid ? fixedPriceAgreementLogicalAddress(jobId) : 'unavailable Agreement address';
  reference('agreement.reference', a?.ref, agreementAddress, agreementHash, buyer, a?.anchorReceipt, 'agreement');
  let agreementProblem = null;
  if (artifact == null) agreementProblem = ['missing', 'agreement.missing', 'Signed Agreement bytes are not recorded.'];
  else if (!isPayeeBoundAgreementDocument(artifact)) agreementProblem = ['mismatch', 'agreement.shape', 'Agreement is not the supported exact payee-bound Agreement type/signature set.'];
  else if (artifact.jobId !== jobId) agreementProblem = ['mismatch', 'agreement.job', 'Agreement names another job.'];
  else if (parties.find((x) => x.role === 'buyer')?.primaryClaim !== buyer || parties.find((x) => x.role === 'seller')?.primaryClaim !== seller) agreementProblem = ['mismatch', 'agreement.parties', 'Agreement parties differ from the purchase-bound buyer/seller.'];
  else if (agreementHash !== a.hash) agreementProblem = ['mismatch', 'agreement.hash', 'Recomputed Agreement hash differs from the recorded Agreement hash.'];
  else if (!same(artifact.listingRef, { listingId: t.listing?.listingId, version: t.listing?.version, contentHash: t.listing?.contentHash })) agreementProblem = ['mismatch', 'agreement.listing', 'Agreement Listing pin differs from the purchase.'];
  else if (!same(artifact.terms.price, { amount: t.price?.amount, currency: t.price?.currency }) || !same(artifact.terms.payoutBindings, [{ railId: 'demos-native:DEM', phaseIndex: 2, payeeAddress: t.seller?.payee }]) || !same(artifact.terms.rail, { railId: 'demos-native:DEM', railVersion: 1 })) agreementProblem = ['mismatch', 'agreement.terms', 'Agreement price, payee, phase or rail differs from the fixed-price DEM purchase.'];
  else if (!artifact.signatures.every((s) => signatureValid(s.party, `${ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument}${agreementHash}`, s.value, s.algorithm))) agreementProblem = ['mismatch', 'agreement.signature', 'A required Agreement signature does not verify over the exact domain-separated Agreement hash.'];
  add('agreement.signed', ...(agreementProblem ?? ['present', 'agreement.signatures-verified', 'Recorded Agreement job, parties, Listing pin, price/payee/rail, hash and both Ed25519 signatures match; its native resolution and dependency closure remain separate.']), 'agreement');
  receipt('agreement.receipt', a?.anchorReceipt, agreementAddress, agreementHash, buyer, a?.ref, 'agreement');
  add('agreement.authority', 'unavailable', 'agreement.authority', 'Exact signed Listing, identity linkage, deadline/Deliverable derivation and commitment phase dispatch require independent audit replay.', 'agreement');

  const c = p.commitment, commitmentAddress = jobValid ? finalityCommitmentAddress(jobId) : 'unavailable commitment address';
  reference('commitment.reference', c?.ref, commitmentAddress, c?.contentHash, seller, c?.anchorReceipt, 'commitment');
  if (c?.signer !== undefined && c.signer !== seller) add('commitment.signer', 'mismatch', 'commitment.signer', 'Recorded commitment signer differs from the seller/phase orchestrator.', 'commitment');
  else add('commitment.signer', 'unavailable', 'commitment.signature-unresolved', 'Commitment signature and Agreement/Listing binding cannot be replayed from the recorded signer label.', 'commitment');
  unresolved('commitment.record', c?.ref, 'commitment');
  receipt('commitment.receipt', c?.anchorReceipt, commitmentAddress, c?.ref?.contentHash, seller, c?.ref, 'commitment');

  const transfer = p.transfer;
  const observed = transfer != null && isHex64(transfer.txHash) && Number.isSafeInteger(transfer.blockNumber) && transfer.blockNumber >= 0;
  add('payment.observation', transfer == null ? 'missing' : observed ? 'present' : 'mismatch', transfer == null ? 'payment.missing' : observed ? 'payment.recorded' : 'payment.shape', transfer == null
    ? 'No transfer observation is recorded.' : observed ? 'Transaction hash and block are recorded; this does not authenticate the payment tuple or finality.' : 'Recorded transfer lacks an exact transaction hash and block number.', 'payment');
  const e = p.paymentEvidence, paymentAddress = jobValid ? paymentEvidenceAddress(jobId, 'demos-native:DEM', 2) : 'unavailable payment evidence address';
  reference('payment.reference', e?.ref, paymentAddress, e?.evidenceHash, seller, e?.anchorReceipt, 'payment');
  if (e?.txHash !== undefined && (e.txHash !== transfer?.txHash || e.blockNumber !== transfer?.blockNumber)) add('payment.binding', 'mismatch', 'payment.binding', 'Payment evidence summary differs from the recorded transaction or block.', 'payment');
  else add('payment.binding', 'unavailable', 'payment.tuple-unresolved', 'Payer, payee, nonce, exact DEM/OS amount and job/phase binding require signed settlement evidence and authenticated transaction bytes.', 'payment');
  unresolved('payment.evidence', e?.ref, 'payment');
  receipt('payment.receipt', e?.anchorReceipt, paymentAddress, e?.ref?.contentHash, seller, e?.ref, 'payment');

  const d = p.delivery, deliveryAddress = jobValid ? `dacs4:deliverable:${jobId}` : 'unavailable Deliverable address';
  const evidenceAddress = jobValid ? `dacs4:evidence:${jobId}` : 'unavailable delivery evidence address';
  const current = viewMatches && CURRENT_DELIVERY.has(p.stage) && view?.delivery != null;
  add('deliverable.current', current ? 'present' : 'unavailable', current ? 'delivery.current' : 'delivery.not-current', current
    ? 'Current protocol view exposes delivery; bytes, receipt and evidence are checked separately.' : 'Current protocol view does not expose delivery; retained historical report bytes cannot satisfy current readiness.', 'delivery');
  reference('deliverable.reference', d?.deliverableRef, deliveryAddress, payloadHash(d?.report), seller, d?.anchorReceipt, 'delivery');
  const reportHash = payloadHash(d?.report);
  let reportProblem = null;
  if (d?.report == null) reportProblem = ['missing', 'deliverable.missing', 'Deliverable bytes are not recorded.'];
  else if (!isCanonicalJobId(jobId) || d.report.jobId !== jobId) reportProblem = ['mismatch', 'deliverable.job', 'Deliverable job is missing, malformed or differs from the canonical purchase job.'];
  else if (!isHex64(agreementHash) || a?.hash !== agreementHash || d.report.agreementHash !== agreementHash) reportProblem = ['mismatch', 'deliverable.agreement', 'Deliverable or recorded Agreement hash is missing, malformed or differs from the recomputed Agreement hash.'];
  else if (d.report.producer !== undefined && d.report.producer !== seller) reportProblem = ['mismatch', 'deliverable.producer', 'Deliverable producer differs from the purchase-bound seller.'];
  else if (reportHash === null || reportHash !== d.deliverableRef?.contentHash || reportHash !== d.payloadHash) reportProblem = ['mismatch', 'deliverable.hash', 'Deliverable bytes differ from the recorded reference or payload hash.'];
  add('deliverable.bytes', ...(reportProblem ?? [current ? 'present' : 'unavailable', current ? 'deliverable.matches' : 'delivery.not-current', current ? 'Recorded Deliverable job, Agreement and canonical payload hash match; schema/access-mode and native authenticity require independent audit replay.' : 'Matching retained bytes are historical; current delivery is unavailable.']), 'delivery');
  receipt('deliverable.receipt', d?.anchorReceipt, deliveryAddress, reportHash, seller, d?.deliverableRef, 'delivery');
  add('deliverable.authority', 'unavailable', 'deliverable.authority', 'Schema, access-mode fidelity and native seller-write authenticity require independent audit replay; matching payload bytes do not establish those checks.', 'delivery');
  reference('delivery.reference', d?.evidenceRef, evidenceAddress, d?.evidenceHash, seller, d?.evidenceReceipt, 'delivery');
  unresolved('delivery.evidence', d?.evidenceRef, 'delivery');
  receipt('delivery.receipt', d?.evidenceReceipt, evidenceAddress, d?.evidenceRef?.contentHash, seller, d?.evidenceRef, 'delivery');
  add('delivery.binding', d?.evidenceHold?.status === 'rejected' ? 'mismatch' : 'unavailable', d?.evidenceHold?.status === 'rejected' ? 'delivery.rejected' : 'delivery.binding-unresolved', d?.evidenceHold?.status === 'rejected'
    ? 'Recorded delivery evidence was rejected; the recorded rejection text is untrusted and is not reproduced or evaluated.'
    : 'Signed delivery SettlementEvidence must resolve at dacs4:evidence:<job> and bind this Deliverable hash; a planned evidence hash is insufficient.', 'delivery');

  const b = p.bundle;
  add('bundle.scope', b == null ? 'missing' : 'unavailable', b == null ? 'bundle.missing' : 'bundle.unresolved', b == null
    ? 'No completed DACS-5 bundle is recorded.' : 'Only bundle proposal/hash/copy pointers are retained; complete signed bundle dependencies and consistency are unresolved.', 'bundle');
  for (const role of ['buyer', 'seller']) {
    const value = b?.[`${role}Signature`], signer = role === 'buyer' ? buyer : seller;
    const message = typeof b?.bundleHash === 'string' ? `${ARTIFACT_SEPARATORS.FaultAttestationBundle}${b.bundleHash}` : null;
    const valid = isHex64(b?.bundleHash) && b?.message === message && signatureValid(signer, message, value);
    const spelling = valid || canonicalSignature(value) ? 'invalid' : 'noncanonical';
    add(`bundle.${role}.signature`, value == null ? 'missing' : valid ? 'present' : 'mismatch', value == null ? 'bundle.signature-missing' : valid ? 'bundle.signature-verified' : `bundle.signature-${spelling}`, value == null
      ? `No ${role} bundle counter-signature is recorded.` : valid ? `The ${role} Ed25519 signature verifies over the recorded FaultAttestationBundle domain/hash; bundle scope is unresolved.` : spelling === 'noncanonical'
        ? `${role} bundle signature is not exact canonical unpadded Base64URL (CORE §B.7 SIG-6); alternate spellings are rejected before verification.` : `${role} bundle signature, signer, domain or hash does not match the recorded bundle proposal.`, 'bundle');
    reference(`bundle.${role}.reference`, b?.[`${role}CopyRef`], jobValid ? bundleAddress(jobId, role) : 'unavailable bundle address', role === 'buyer' ? b?.buyerCopyHash : null, signer, null, 'bundle');
    unresolved(`bundle.${role}.copy`, b?.[`${role}CopyRef`], 'bundle');
    add(`bundle.${role}.binding`, 'unavailable', 'bundle.binding-unresolved', 'Role-owned copy receipt and signed logical-to-native BundleBinding are not retained/resolved; a copy pointer or completed label cannot establish anchoring.', 'bundle');
  }
  add('finality', 'unavailable', 'finality.no-authenticated-source', 'No authenticated finality source is implemented here. finalized, included, bft-final, settled_verified, delivery-ready and completed labels never prove consensus finality or ST-11 completion.', 'finality');
  return { status: 'held', scope: 'recorded-state-only', standardRevision: COMPLETION_READINESS_STANDARD_PIN, requirements };
}
