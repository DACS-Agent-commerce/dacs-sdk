// A seller-owned session admission for tests: it reads the Listing as active
// and admits both parties under the package's exact profile (the presentation
// challenge is the agent's own ledger: `issue` hands the agent the nonce a
// bundle carries, as the operator's issuer would before the presentation),
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
    listingStatus: { status: 'active', observedAt: now() },
    participants: [{ role: 'buyer', claim: query.buyer, ...structuredClone(SELLER_PROFILE) }, { role: 'seller', claim: query.seller, ...structuredClone(SELLER_PROFILE) }] });
  let overrides = null;
  // CORE SN-1/SN-3: the seller issues the bundle's challenge for its job before
  // the buyer presents it (`target` is the agent or the host). Issuing it again
  // to the same seller state (after a restart) keeps the first issue.
  const issue = (target, jobId, bundle) => {
    try { return target.issueSessionChallenge({ jobId, buyer: bundle.presentedBy, sessionNonce: bundle.sessionNonce }); }
    catch (error) { if (error.code !== 'challenge_taken') throw error; return null; }
  };
  return {
    calls,
    vetRecord,
    issue,
    // The answer for the next admissions: (admitted, query) => answer, or null.
    answerWith: (fn) => { overrides = fn; },
    sessionAdmission: {
      admit: async (query) => { calls.push(['admit', query.jobId]); const answer = admitted(query); return overrides ? overrides(answer, query) : answer; },
      resolveVetRecord: async ({ ref }) => { calls.push(['resolveVetRecord', ref.contentHash]); if (!records.has(ref.contentHash)) throw new Error('no Vet record at this reference'); return structuredClone(records.get(ref.contentHash)); },
    },
  };
}
