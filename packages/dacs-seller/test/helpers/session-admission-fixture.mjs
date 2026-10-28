// A seller-owned session admission for tests: its revocation readers give one
// fresh catalog surface that lists the Listing as active (the agent decides
// with core checkListingRevocation; `readRevocationWith` scripts other
// readings and `markers` holds anchored RevocationMarkers by locator), and it
// admits both parties under the package's exact profile (the presentation
// challenge is generated and retained by the agent before the buyer signs),
// and keeps the counterparty-verified CompositeVerificationRecords its Vet
// references name (DACS-2 §7.7.2: the buyer's record signed by the seller, the
// seller's by the buyer). Each record hashes the exact BundleRequirement it
// evaluated (`requirement`, DACS-2 §7.7.1) and has no results, so it passes
// only a requirement with no required claim.
// Each record also has the SR-2 receipt the operator's reader holds for it
// (DACS-2 VPC-3), finalized by default; `receipt` in the record options is
// null (the reader has none) or the members that replace the default's.
// `overrides` replaces parts of an admitted answer to build refusal vectors.
import * as core from '@kynesyslabs/dacs';
import { SELLER_PROFILE } from '../../src/dacs/session-admission.mjs';

export function createSessionAdmissionFixture({ seller, buyer, now = () => Date.now() }) {
  const records = new Map(), receipts = new Map(), calls = [];
  let made = 0;
  // The reference names the party's verifier (by default its counterparty) at
  // the job's canonical address; the options build records that do not back it.
  // A record's hash leaves out its signature, so each record gets its own
  // generatedAt: one never replaces another here.
  const vetRecord = async (jobId, party, bundle, { requirement, decision = 'pass', verifier = party === seller.claim ? buyer : seller, signer = verifier, recordJobId = jobId,
    bundleHash = core.identityBundleHash(bundle), requirementHash = core.sha256Hex(core.canonicalize(requirement)), receipt = {} } = {}) => {
    const unsigned = { recordVersion: '1', jobId: recordJobId, evaluatedParty: party, bundleHash, requirementHash,
      freshness: [], supplementary: [], dealSpecific: [], overallDecision: decision, generatedAt: now() - made++ };
    const record = await core.signComponentArtifact(unsigned, core.ARTIFACT_SEPARATORS.CompositeVerificationRecord, { algorithm: 'ed25519', signer: signer.claim, sign: signer.sign });
    const ref = { anchor: { kind: 'storage-program', locator: core.compositeVerificationAddress(jobId, party) }, contentHash: core.contentHash(record), signer: verifier.claim };
    records.set(ref.contentHash, record);
    if (receipt !== null) {
      receipts.set(ref.contentHash, { receiptVersion: '1', substrate: 'demos', finalityProfile: 'TEST-fixture', logicalAddress: ref.anchor.locator, nativeAddress: `TEST-native-${ref.contentHash.slice(0, 16)}`,
        contentHash: ref.contentHash, transactionRef: { kind: 'demos', value: core.sha256Hex(`TEST vet tx ${ref.contentHash}`) }, writer: verifier.claim, state: 'finalized', observationDisposition: 'established',
        observedAt: now(), blockRef: { id: 'TEST-block', height: '1', timestamp: now() }, evidence: { kind: 'TEST', value: 'fixture' }, ...receipt });
    }
    return ref;
  };
  const admitted = (query) => ({ disposition: 'admitted', jobId: query.jobId, buyer: query.buyer, buyerBundleHash: query.buyerBundleHash, listingPin: query.listingPin,
    participants: [{ role: 'buyer', claim: query.buyer, ...structuredClone(SELLER_PROFILE) }, { role: 'seller', claim: query.seller, ...structuredClone(SELLER_PROFILE) }] });
  const activeSurfaces = () => [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: now() }];
  const markers = new Map();
  let overrides = null, surfaces = null, verifyOverride = null;
  return {
    calls,
    vetRecord,
    // The answer for the next admissions: (admitted, query) => answer, or null.
    answerWith: (fn) => { overrides = fn; },
    // The revocation surfaces for the next readings: (active, query) => surfaces (or a throw), or null.
    readRevocationWith: (fn) => { surfaces = fn; },
    // The verdict for the next receipt verifications: ({ ref, record, receipt }) => 'valid' | 'invalid' | 'indeterminate' (or a throw), or null.
    verifyReceiptWith: (fn) => { verifyOverride = fn; },
    markers,
    sessionAdmission: {
      readRevocationSurfaces: async (query) => { calls.push(['readRevocationSurfaces', query.jobId]); return surfaces ? surfaces(activeSurfaces(), query) : activeSurfaces(); },
      readRevocationMarker: async (anchor) => { calls.push(['readRevocationMarker', anchor.locator]); return markers.has(anchor.locator) ? structuredClone(markers.get(anchor.locator)) : null; },
      admit: async (query) => { calls.push(['admit', query.jobId]); const answer = admitted(query); return overrides ? overrides(answer, query) : answer; },
      resolveVetRecord: async ({ ref }) => { calls.push(['resolveVetRecord', ref.contentHash]); if (!records.has(ref.contentHash)) throw new Error('no Vet record at this reference'); return structuredClone(records.get(ref.contentHash)); },
      // The authentic receipt of a record is the one the fixture's chain holds for it.
      verifyVetAnchorReceipt: async ({ ref, record, receipt }) => { calls.push(['verifyVetAnchorReceipt', ref.contentHash]); if (verifyOverride) return verifyOverride({ ref, record, receipt }); return receipts.has(ref.contentHash) && core.canonicalize(receipts.get(ref.contentHash)) === core.canonicalize(receipt) && core.contentHash(record) === ref.contentHash ? 'valid' : 'invalid'; },
      readVetAnchorReceipt: async ({ ref }) => { calls.push(['readVetAnchorReceipt', ref.contentHash]); if (!receipts.has(ref.contentHash)) throw new Error('no SR-2 receipt at this reference'); return structuredClone(receipts.get(ref.contentHash)); },
    },
  };
}
