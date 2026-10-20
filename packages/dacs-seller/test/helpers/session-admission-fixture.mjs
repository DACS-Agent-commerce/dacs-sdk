// A seller-owned session admission for tests: it answers that the bundle's
// sessionNonce is the challenge it issued and consumed for the job (it keeps
// no ledger; the host itself refuses a nonce another session took), reads the
// Listing as active, admits both parties under the package's exact profile,
// and keeps the counterparty-verified CompositeVerificationRecords its Vet
// references name (DACS-2 §7.7.2: the buyer's record signed by the seller, the
// seller's by the buyer). Each record hashes the exact BundleRequirement it
// evaluated (`requirement`, DACS-2 §7.7.1) and has no results, so it passes
// only a requirement with no required claim.
// `overrides` replaces parts of an admitted answer to build refusal vectors.
import * as core from '@kynesyslabs/dacs';
import { SELLER_PROFILE } from '../../src/dacs/session-admission.mjs';

export function createSessionAdmissionFixture({ seller, buyer, now = () => Date.now() }) {
  const records = new Map(), calls = [];
  let made = 0;
  // The reference names the party's verifier (by default its counterparty) at
  // the job's canonical address; the options build records that do not back it.
  // A record's hash leaves out its signature, so each record gets its own
  // generatedAt: one never replaces another here.
  const vetRecord = async (jobId, party, bundle, { requirement, decision = 'pass', verifier = party === seller.claim ? buyer : seller, signer = verifier, recordJobId = jobId,
    bundleHash = core.identityBundleHash(bundle), requirementHash = core.sha256Hex(core.canonicalize(requirement)) } = {}) => {
    const unsigned = { recordVersion: '1', jobId: recordJobId, evaluatedParty: party, bundleHash, requirementHash,
      freshness: [], supplementary: [], dealSpecific: [], overallDecision: decision, generatedAt: now() - made++ };
    const record = await core.signComponentArtifact(unsigned, core.ARTIFACT_SEPARATORS.CompositeVerificationRecord, { algorithm: 'ed25519', signer: signer.claim, sign: signer.sign });
    const ref = { anchor: { kind: 'storage-program', locator: core.compositeVerificationAddress(jobId, party) }, contentHash: core.contentHash(record), signer: verifier.claim };
    records.set(ref.contentHash, record);
    return ref;
  };
  const admitted = (query) => ({ disposition: 'admitted', jobId: query.jobId, buyer: query.buyer, buyerBundleHash: query.buyerBundleHash, listingPin: query.listingPin,
    challenge: { nonce: query.sessionNonce, consumedAt: now() }, listingStatus: { status: 'active', observedAt: now() },
    participants: [{ role: 'buyer', claim: query.buyer, ...structuredClone(SELLER_PROFILE) }, { role: 'seller', claim: query.seller, ...structuredClone(SELLER_PROFILE) }] });
  let overrides = null;
  return {
    calls,
    vetRecord,
    // The answer for the next admissions: (admitted, query) => answer, or null.
    answerWith: (fn) => { overrides = fn; },
    sessionAdmission: {
      admit: async (query) => { calls.push(['admit', query.jobId]); const answer = admitted(query); return overrides ? overrides(answer, query) : answer; },
      resolveVetRecord: async ({ ref }) => { calls.push(['resolveVetRecord', ref.contentHash]); if (!records.has(ref.contentHash)) throw new Error('no Vet record at this reference'); return structuredClone(records.get(ref.contentHash)); },
    },
  };
}
