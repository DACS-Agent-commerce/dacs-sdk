// Independent offline control: a fixed-price 2.5 DEM job, four executed
// phases, two current-shape Vets, and one payment/delivery evidence each.
// No SDK finalizer is mocked. Fixture authorization proves fixture identity
// and immutability only; it does not claim chain finality or #331 resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_SEPARATORS, attestationBundleHash, bundleAddress, canonicalize,
  canonicalSellerSettlementId, contentHash, finalityCommitmentAddress,
  fixedPriceAgreementLogicalAddress, identityBundleHash, listingAddress,
  paymentEvidenceAddress, publicKeyFromRaw, ed25519Verify, sellerFulfilmentId,
  sha256Hex, signedBytes, storAddress, verifySettlementEvidence,
} from '@kynesyslabs/dacs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { buildListingDraft, buildUnsignedIdentityBundle, attachIdentityPresentation, verifyComponent, DEM_RAIL } from '../src/dacs/listing.mjs';
import { FIXTURE_FINALITY, FIXTURE_SUBSTRATE, anchorWriteMessage, fixtureWriteHash } from '../src/dacs/fixture-anchors.mjs';
import {
  ST11_PROFILE, createSt11FixtureFinalizationProvider,
  prepareStrictCompletedBundleRequest, createStrictCompletedBuyerCounterSignature,
  finalizeStrictCompletedSellerBundle, finalizeStrictCompletedBuyerBundle,
} from '../src/dacs/st11-finalizers.mjs';

const NOW = 1_790_000_000_000;
const JOB = '01J8ME0SXKQ4T9V2RC5HJ6WX7D';
const RECIPE_PIN = 4;
const RAIL_PIN = 1; // authenticated fixture operational pin, not a live registry
const VET_PROVENANCE_DOMAIN = 'dacs-chatgpt-plugin/fixture-vet-invocation/v1:';
const AUTHORITY_DOMAIN = 'dacs-chatgpt-plugin/fixture-did-authority/v1:';
const DELIVERY_DOMAIN = 'dacs-chatgpt-plugin/fixture-delivery-binding/v1:';
const exact = (a, b) => canonicalize(a) === canonicalize(b);

function signArtifact(unsigned, separator, wallet) {
  return { ...structuredClone(unsigned), signature: {
    algorithm: 'ed25519', signer: wallet.claim,
    value: wallet.signBytes(signedBytes(separator, contentHash(unsigned))).toString('base64url'),
  } };
}

function signatureValid(artifact, separator) {
  return verifyComponent({ signedBytes: signedBytes(separator, contentHash(artifact)), signature: artifact.signature });
}

function corruptReceiptProof(receipt) {
  receipt.evidence.value = Buffer.alloc(64).toString('base64url');
  receipt.transactionRef.value = fixtureWriteHash({ logicalAddress: receipt.logicalAddress,
    contentHash: receipt.contentHash, writer: receipt.writer, writerSignature: receipt.evidence.value });
}

function fixture() {
  const buyerWallet = createEphemeralWallet();
  const sellerWallet = createEphemeralWallet();
  const wallets = new Map([[buyerWallet.claim, buyerWallet], [sellerWallet.claim, sellerWallet]]);
  const identity = (wallet, label) => {
    const draft = buildUnsignedIdentityBundle({ address: wallet.address, presentedAt: NOW - 30_000, sessionSeed: `st11-${label}` });
    return attachIdentityPresentation(draft, wallet.signHex(draft.message));
  };
  const buyerIdentity = identity(buyerWallet, 'buyer');
  const sellerPublished = identity(sellerWallet, 'published');
  const sellerIdentity = identity(sellerWallet, 'post-vet');
  const identities = new Map([buyerIdentity, sellerPublished, sellerIdentity].map((entry) => [identityBundleHash(entry), entry]));
  const buyer = { primaryClaim: buyerWallet.claim, bundleHash: identityBundleHash(buyerIdentity), signer: buyerWallet.signBytes };
  const seller = { primaryClaim: sellerWallet.claim, bundleHash: identityBundleHash(sellerIdentity), signer: sellerWallet.signBytes };
  const buyerRequirement = { requirementVersion: '1', required: [{ scheme: 'did', verificationRequired: true }] };
  const sellerRequirement = { requirementVersion: '1', required: [{ scheme: 'did', verificationRequired: true, parameters: { fixturePolicy: 'seller' } }] };
  const draft = buildListingDraft({
    identityBundle: sellerPublished, displayName: 'Offline seller', publicEndpoint: 'https://fixture.invalid/dacs',
    listingId: 'st11-fixed-dem-fixture', listingVersion: 1, title: 'ST-11 report', description: 'Offline report',
    category: 'software', tags: ['fixture'], priceDem: '2.5', notBefore: NOW - 60_000, notAfter: NOW + 60_000,
  });
  draft.buyerRequirement = buyerRequirement;
  const listing = signArtifact(draft, ARTIFACT_SEPARATORS.Listing, sellerWallet);
  const listingPin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) };
  const records = new Map();
  const faults = { native: new Map(), bundle: new Map(), omitProvenance: false, provenance: 'valid', identity: 'valid', invalidBundleProof: false };
  const receipt = (logicalAddress, hash, wallet, timestamp) => {
    const proof = wallet.signBytes(Buffer.from(anchorWriteMessage(logicalAddress, hash))).toString('base64url');
    return {
      receiptVersion: '1', substrate: FIXTURE_SUBSTRATE, finalityProfile: FIXTURE_FINALITY,
      logicalAddress, nativeAddress: storAddress(logicalAddress), contentHash: hash,
      writer: wallet.claim,
      transactionRef: { kind: 'fixture-sr2-write', value: fixtureWriteHash({ logicalAddress, contentHash: hash, writer: wallet.claim, writerSignature: proof }) },
      state: 'finalized', observationDisposition: 'established', observedAt: NOW,
      blockRef: { id: `fixture-block-${hash.slice(0, 16)}`, timestamp },
      evidence: { kind: 'fixture-writer-signature', value: proof },
    };
  };
  const add = (logical, artifact, { wallet = sellerWallet, separator, encoding = 'artifact', timestamp = NOW - 1_000, refFields = {}, sourceKind = 'attestation-ref' } = {}) => {
    const hash = encoding === 'jcs' ? sha256Hex(canonicalize(artifact)) : contentHash(artifact);
    const ref = { anchor: { kind: 'storage-program', locator: logical }, contentHash: hash, ...refFields };
    records.set(storAddress(logical), { artifact: structuredClone(artifact), ref, receipt: receipt(logical, hash, wallet, timestamp), separator, encoding, sourceKind, writer: wallet.claim });
    return ref;
  };
  add(listingAddress(sellerWallet.claim, listingPin.listingId, listingPin.version), listing, { separator: ARTIFACT_SEPARATORS.Listing });
  const recipe = signArtifact({
    recipeVersion: 1, scheme: 'did', defaultMethod: { kind: 'self-signed' }, defaultMaxAgeSec: 3600,
    parserRules: { format: 'raw', matcher: 'identity' }, retryClass: 'permanent', availability: 'live',
    governance: { proposedBy: sellerWallet.claim, acceptedAt: NOW - 40_000, anchoring: 'single-signer' },
  }, 'dacs-recipe:v1:', sellerWallet);
  const vetFacts = [[buyer, buyerWallet, buyerRequirement], [seller, sellerWallet, sellerRequirement]].map(([party, wallet, requirement], index) => {
    const authority = signArtifact({ authorityEvidenceVersion: '1', claim: wallet.claim, jobId: JOB, decision: 'pass' }, AUTHORITY_DOMAIN, wallet);
    const authorityRef = add(`fixture:authority:${JOB}:${index}`, authority, { wallet, separator: AUTHORITY_DOMAIN, encoding: 'jcs', refFields: { signer: wallet.claim } });
    const result = signArtifact({
      resultVersion: '1', scheme: 'did', identifier: wallet.claim.slice(4), recipeVersion: 1, method: 'self-signed',
      decision: 'pass', reason: 'independent fixture identity proof', attestation: authorityRef,
      fetchedAt: NOW - 19_000, verifiedAt: NOW - 18_000, validUntil: NOW + 60_000,
    }, 'dacs-verifyresult:v1:', sellerWallet);
    const resultRef = { ...add(`fixture:verify:${JOB}:${index}`, result, { separator: 'dacs-verifyresult:v1:' }), recipeVersion: 1 };
    const record = signArtifact({
      recordVersion: '1', jobId: JOB, evaluatedParty: party.primaryClaim, bundleHash: party.bundleHash,
      requirementHash: sha256Hex(canonicalize(requirement)), freshness: [], supplementary: [], dealSpecific: [resultRef],
      overallDecision: 'pass', generatedAt: NOW - 16_000,
    }, ARTIFACT_SEPARATORS.CompositeVerificationRecord, sellerWallet);
    const vetRecordRef = add(`fixture:vet:${JOB}:${index}`, record, { separator: ARTIFACT_SEPARATORS.CompositeVerificationRecord });
    const invocation = {
      vetRecordRef, evaluatedParty: party.primaryClaim, requirement, verifier: sellerWallet.claim, freshness: [],
      dealSpecific: [{ ref: resultRef, scheme: 'did', identifier: wallet.claim.slice(4), method: 'self-signed', requirement: requirement.required[0] }],
    };
    // Exact authenticated operational transcript. This does not assert a
    // normative complementary requirement origin while Standard #331 is open.
    const witness = signArtifact({ jobId: JOB, listingRef: listingPin, invocation }, VET_PROVENANCE_DOMAIN, sellerWallet);
    return { vetRecordRef, invocation, witness };
  });
  const [buyerVet, sellerVet] = vetFacts;
  const deliverableSpec = listing.offering.deliverable;
  const deliverableRef = { deliverableType: deliverableSpec.kind, hash: sha256Hex(canonicalize(deliverableSpec)) };
  const unsignedAgreement = {
    payeeBoundAgreementVersion: '1', jobId: JOB, listingRef: listingPin,
    parties: [
      { role: 'buyer', primaryClaim: buyer.primaryClaim, bundleHash: buyer.bundleHash, vetRecordRef: buyerVet.vetRecordRef },
      { role: 'seller', primaryClaim: seller.primaryClaim, bundleHash: seller.bundleHash, vetRecordRef: sellerVet.vetRecordRef },
    ],
    terms: { deliverable: deliverableRef, price: { amount: '2.5', currency: 'DEM' }, rail: DEM_RAIL, deadline: NOW + 60_000,
      payoutBindings: [{ railId: DEM_RAIL.railId, phaseIndex: 2, payeeAddress: sellerWallet.address }] },
    derivedFromPattern: 'fixed-price', generatedAt: NOW - 15_000,
  };
  const agreementArtifact = { ...unsignedAgreement, signatures: [buyerWallet, sellerWallet].map((wallet) => ({
    party: wallet.claim, algorithm: 'ed25519',
    value: wallet.signBytes(signedBytes(ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument, contentHash(unsignedAgreement))).toString('base64url'),
  })) };
  const agreementRef = add(fixedPriceAgreementLogicalAddress(JOB), agreementArtifact, { wallet: buyerWallet, separator: ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument });
  const commitment = signArtifact({
    finalityCommitmentVersion: '1', jobId: JOB, agreementHash: agreementRef.contentHash, listingRef: listingPin,
    parties: [buyer.primaryClaim, seller.primaryClaim], pattern: 'fixed-price', createdAt: NOW - 12_000,
  }, 'dacs-finality-commitment:v1:', sellerWallet);
  const commitmentRef = add(finalityCommitmentAddress(JOB), commitment, { separator: 'dacs-finality-commitment:v1:', timestamp: NOW - 11_000 });
  const txHash = 'a'.repeat(64);
  const settlementId = canonicalSellerSettlementId({ kind: 'demos', txHash });
  const paymentInput = {
    evidenceVersion: '1', jobId: JOB, phase: 'pay-dem', outcome: 'success',
    paymentTxRefs: [{ kind: 'demos', txHash, blockNumber: 120 }], paymentAmount: { amount: '2.5', currency: 'DEM' },
    settlementFinality: { model: 'bft-final', finalityObservedAt: NOW - 4_000 }, observedAt: NOW - 4_000,
  };
  const payment = signArtifact(paymentInput, ARTIFACT_SEPARATORS.SettlementEvidence, sellerWallet);
  const paymentRef = add(paymentEvidenceAddress(JOB, DEM_RAIL.railId, 2), payment, { separator: ARTIFACT_SEPARATORS.SettlementEvidence });
  const payload = { reportVersion: '1', jobId: JOB, agreementHash: agreementRef.contentHash, text: 'Offline ST-11 result' };
  const payloadRef = add(`dacs4:deliverable:${JOB}`, payload, { encoding: 'jcs', sourceKind: 'deliverable' });
  const delivery = signArtifact({
    evidenceVersion: '1', jobId: JOB, phase: 'deliver-storage-program', outcome: 'success', observedAt: NOW - 2_000,
    deliverableContentHash: payloadRef.contentHash, deliverableAnchor: payloadRef.anchor,
  }, ARTIFACT_SEPARATORS.SettlementEvidence, sellerWallet);
  const deliveryRef = add(`dacs4:delivery:${JOB}:3`, delivery, { separator: ARTIFACT_SEPARATORS.SettlementEvidence });
  const deliveredWitness = signArtifact({ jobId: JOB, agreementHash: agreementRef.contentHash, payloadRef, deliveryRef }, DELIVERY_DOMAIN, sellerWallet);
  const agreement = {
    artifactKind: 'payee-bound', ref: agreementRef.anchor.locator, contentHash: agreementRef.contentHash, jobId: JOB, listingPin,
    buyer: { primaryClaim: buyer.primaryClaim, bundleHash: buyer.bundleHash, vetRecordRef: buyerVet.vetRecordRef },
    seller: { primaryClaim: seller.primaryClaim, bundleHash: seller.bundleHash, vetRecordRef: sellerVet.vetRecordRef },
    deliverableRef, commitment: { status: 'finalized', ref: commitmentRef.anchor.locator, agreementHash: agreementRef.contentHash,
      recordContentHash: commitmentRef.contentHash, finalizedAt: NOW - 11_000, signer: seller.primaryClaim },
  };
  const authorization = {
    jobId: JOB, phaseIndex: 2, agreementHash: agreementRef.contentHash, listingRef: listingPin, railId: DEM_RAIL.railId,
    railRegistryVersion: RAIL_PIN, commitment: { ref: commitmentRef.anchor.locator, contentHash: commitmentRef.contentHash, finalizedAt: NOW - 11_000, signer: seller.primaryClaim },
    settlementIdentity: { kind: 'demos', txHash, blockNumber: 120, includedAt: NOW - 4_000 }, settlementId,
    evidenceHash: contentHash(paymentInput), evidenceInput: paymentInput, payoutBindingTier: 1, sessionBinding: 'established',
  };
  const fulfilment = {
    decision: 'completed', fulfilmentId: sellerFulfilmentId({ jobId: JOB, paymentPhaseIndex: 2, deliveryPhaseIndex: 3,
      settlementId, agreementHash: agreementRef.contentHash, paymentEvidenceHash: contentHash(paymentInput) }),
    evidence: delivery, evidenceHash: deliveryRef.contentHash, evidenceRef: deliveryRef,
    evidenceAnchorReceipt: structuredClone(records.get(storAddress(deliveryRef.anchor.locator)).receipt), consumedPaymentAuthorization: authorization,
    bundleContribution: { phaseSummary: { index: 3, kind: 'deliver-storage-program', outcome: 'ok', attestationRef: deliveryRef }, settlementEvidence: deliveryRef },
  };
  const negotiateDelta = { 'negotiate-fixed-price': { agreementHash: agreementRef.contentHash, agreementRef } };
  const phaseResults = [
    { index: 0, step: listing.pipeline[0], invokedAt: NOW - 14_000, result: { ok: true, contextDelta: negotiateDelta }, contextDelta: negotiateDelta },
    { index: 1, step: listing.pipeline[1], invokedAt: NOW - 12_000, result: { ok: true, attestationRef: commitmentRef, contextDelta: {} }, contextDelta: {} },
    { index: 2, step: listing.pipeline[2], invokedAt: NOW - 5_000, result: { ok: true, attestationRef: paymentRef, txRefs: paymentInput.paymentTxRefs, contextDelta: {} }, contextDelta: {} },
    { index: 3, step: listing.pipeline[3], invokedAt: NOW - 3_000, result: { ok: true, attestationRef: deliveryRef, contextDelta: {} }, contextDelta: {} },
  ];
  const dependencies = [...records.values()].map((record) => ({
    source: record.artifact === listing || record.receipt.contentHash === listingPin.contentHash
      ? { kind: 'listing', listingRef: listingPin }
      : record.sourceKind === 'deliverable'
        ? { kind: 'deliverable', anchor: payloadRef.anchor, contentHash: payloadRef.contentHash, encoding: 'jcs' }
        : { kind: 'attestation-ref', ref: structuredClone(record.ref), ...(record.encoding === 'jcs' ? { encoding: 'jcs' } : {}) },
    anchorReceipt: structuredClone(record.receipt),
  }));
  const input = {
    agreement, agreementRef, fulfilment,
    session: { recordVersion: '1', jobId: JOB, state: 'audit-pending', listingRef: listingPin, parties: agreementArtifact.parties,
      pipeline: listing.pipeline, phaseResults, startedAt: NOW - 20_000, lastUpdatedAt: NOW - 2_000, recipeRegistryVersion: RECIPE_PIN, railRegistryVersion: RAIL_PIN },
    sessionArtifacts: { agreementCommitment: commitmentRef, vetRecords: vetFacts.map((entry) => entry.vetRecordRef),
      vetRequirements: vetFacts.map((entry) => entry.invocation), settlementEvidence: [paymentRef, deliveryRef] },
    finalisedAt: NOW, seller, dependencies,
  };
  const writes = { buyer: 0, seller: 0 };
  const bundles = new Map();
  const nativeReads = [];
  const substrate = {
    readNative: (native) => {
      nativeReads.push(native);
      if (faults.native.has(native)) return structuredClone(faults.native.get(native));
      const record = records.get(native);
      return record ? { disposition: 'present', artifact: structuredClone(record.artifact) } : { disposition: 'absent' };
    },
    lookupBundle: (logical, role) => {
      if (faults.bundle.has(role)) return structuredClone(faults.bundle.get(role));
      const anchored = bundles.get(logical);
      return anchored ? { disposition: 'present', anchored: structuredClone(anchored) } : { disposition: 'absent' };
    },
    writeBundle: (logical, bundle, role) => {
      assert.equal(logical, bundleAddress(JOB, role));
      assert.equal(bundle.anchoredByRole, role);
      const hash = attestationBundleHash(bundle);
      const existing = bundles.get(logical);
      if (existing) { assert.equal(attestationBundleHash(existing.bundle), hash); return; }
      const proof = receipt(logical, hash, wallets.get(bundle.parties.find((entry) => entry.role === role).primaryClaim), NOW);
      if (faults.invalidBundleProof) proof.evidence.value = Buffer.alloc(64).toString('base64url');
      writes[role]++;
      bundles.set(logical, { bundle: structuredClone(bundle), nativeAddress: storAddress(logical), anchorReceipt: proof });
    },
  };
  const authority = {
    bundleCopyVerifier: {
      resolvePublicKey: (claim) => wallets.get(claim)?.publicKeyRaw ?? null,
      verify: (message, signature, key) => ed25519Verify(message, signature, publicKeyFromRaw(key)),
    },
    compositeVerificationDeps: {
      resolveRecipe: (selector, registry) => registry === RECIPE_PIN && selector.scheme === 'did' && selector.recipeVersion === 1 && selector.method === 'self-signed' ? structuredClone(recipe) : null,
      isRecipeSignerAuthorized: (_recipe, signature) => signature.signer === seller.primaryClaim,
      isVerifyResultSignerAuthorized: (_result, signature) => signature.signer === seller.primaryClaim,
      resolvePublicKey: (signature) => signature.algorithm === 'ed25519' ? wallets.get(signature.signer)?.publicKeyRaw ?? null : null,
      verify: ({ signedBytes: bytes, signature, publicKey }) => ed25519Verify(bytes, Buffer.from(signature.value, 'base64url'), publicKeyFromRaw(publicKey)),
      verifyAuthorityAttestation: ({ expected, content }) => content.encoding === 'canonical-json' && content.value.jobId === JOB &&
        content.value.claim === `did:${expected.identifier}` && content.value.signature?.signer === content.value.claim &&
        content.value.decision === 'pass' && signatureValid(content.value, AUTHORITY_DOMAIN) ? 'valid' : 'invalid',
      verifyRequirementParameters: ({ expected }) => exact(expected.requirement, sellerRequirement.required[0]) || exact(expected.requirement, buyerRequirement.required[0]),
    },
    verifyDependency: async ({ dependency, artifact }) => {
      const record = records.get(dependency.anchorReceipt.nativeAddress);
      if (!record || !exact(record.artifact, artifact) || dependency.anchorReceipt.writer !== record.writer ||
          dependency.anchorReceipt.logicalAddress !== record.receipt.logicalAddress) return 'invalid';
      if (record.sourceKind === 'deliverable') {
        return artifact.jobId === JOB && artifact.agreementHash === agreementRef.contentHash && signatureValid(deliveredWitness, DELIVERY_DOMAIN) &&
          deliveredWitness.payloadRef.contentHash === sha256Hex(canonicalize(artifact)) ? 'valid' : 'invalid';
      }
      if (artifact.payeeBoundAgreementVersion) {
        return artifact.jobId === JOB && artifact.signatures.length === 2 && artifact.signatures.every((entry) => verifyComponent({
          signedBytes: signedBytes(record.separator, contentHash(artifact)), signature: { algorithm: entry.algorithm, signer: entry.party, value: entry.value },
        })) ? 'valid' : 'invalid';
      }
      if (artifact.evidenceVersion) {
        const paymentContext = artifact.phase === 'pay-dem' ? {
          rail: { railId: DEM_RAIL.railId, railType: 'demos-native', asset: 'DEM', assetSpec: { kind: 'native-dem' },
            network: 'demos', networkSpec: { kind: 'demos' }, handler: 'pay-dem' },
          result: { ok: true, txRefs: [{ kind: 'demos', txHash, blockNumber: 120 }] },
          paymentAddress: { railId: DEM_RAIL.railId, phaseIndex: 2 },
        } : { result: { ok: true }, expectedAnchorLocator: payloadRef.anchor.locator };
        const verified = await verifySettlementEvidence(artifact, {
          orchestrator: seller.primaryClaim, agreement: { amount: '2.5', currency: 'DEM' },
          attestationRef: structuredClone(record.ref), ...paymentContext,
        }, authority.bundleCopyVerifier);
        if (verified.decision !== 'pass') return 'invalid';
      }
      return signatureValid(artifact, record.separator) && artifact.signature.signer === record.writer && (!artifact.jobId || artifact.jobId === JOB) ? 'valid' : 'invalid';
    },
    verifyIdentityLinkage: ({ listingIdentity, listingBundleHash, sessionBundleHash, primaryClaim }) => {
      if (faults.identity !== 'valid') return faults.identity;
      const sessionIdentity = identities.get(sessionBundleHash);
      const validPresentation = (bundle) => bundle && bundle.presentedBy === primaryClaim && verifyComponent({
        signedBytes: signedBytes('dacs-bundle-presentation:v1:', identityBundleHash(bundle)),
        signature: { algorithm: 'ed25519', signer: primaryClaim, value: bundle.presentation.signatures.find((entry) => entry.ref === primaryClaim)?.signature },
      });
      return identityBundleHash(listingIdentity) === listingBundleHash && validPresentation(listingIdentity) && validPresentation(sessionIdentity) ? 'valid' : 'invalid';
    },
    verifyVetProvenance: ({ invocation, compositeRecord, listingOwned }) => {
      if (faults.omitProvenance || faults.provenance !== 'valid') return faults.omitProvenance ? 'indeterminate' : faults.provenance;
      const row = vetFacts.find((entry) => exact(entry.invocation, invocation));
      return row && signatureValid(row.witness, VET_PROVENANCE_DOMAIN) && exact(row.witness.invocation, invocation) &&
        row.witness.jobId === compositeRecord.jobId && invocation.evaluatedParty === compositeRecord.evaluatedParty &&
        (!listingOwned || exact(invocation.requirement, listing.buyerRequirement)) ? 'valid' : 'invalid';
    },
    resolvePaymentPhaseIndex: ({ dependency, evidence }) => {
      const logical = paymentEvidenceAddress(JOB, DEM_RAIL.railId, 2);
      return evidence.jobId === JOB && dependency.anchorReceipt.logicalAddress === logical &&
        dependency.anchorReceipt.nativeAddress === storAddress(logical)
        ? { disposition: 'valid', jobId: JOB, railId: DEM_RAIL.railId, phaseIndex: 2, resolved: false }
        : { disposition: 'invalid', reason: 'PC-2 tuple is not the retained executed pay-dem invocation' };
    },
  };
  const provider = createSt11FixtureFinalizationProvider({ substrate, authority });
  const verificationInput = () => ({ ...input, seller: { primaryClaim: seller.primaryClaim, bundleHash: seller.bundleHash } });
  return { input, provider, substrate, authority, buyer, faults, records, writes, bundles, nativeReads, verificationInput,
    paymentRef, deliveryRef, vetFacts, sellerPublished, sellerIdentity };
}

async function signAndFinalize(w) {
  const request = prepareStrictCompletedBundleRequest(w.input);
  const requestInput = w.verificationInput();
  delete requestInput.counterSignatures;
  const signature = await createStrictCompletedBuyerCounterSignature({ sellerVerificationInput: requestInput, buyer: w.buyer }, request, w.provider);
  w.input.counterSignatures = [signature];
  const seller = await finalizeStrictCompletedSellerBundle(w.input, w.provider);
  const buyer = await finalizeStrictCompletedBuyerBundle({ sellerVerificationInput: w.verificationInput(), sellerFinalization: seller, counterSignature: signature, buyer: w.buyer }, w.provider);
  return { request, signature, seller, buyer };
}

test('strict SDK accepting control: native dependency reads, both role-owned finalized copies, and exact detached signature', async () => {
  const w = fixture();
  const result = await signAndFinalize(w);
  assert.equal(result.seller.state, 'finalised');
  assert.equal(result.buyer.state, 'finalised');
  assert.equal(result.seller.sellerBundle.faultBundleVersion, '1');
  assert.equal(result.seller.sellerBundle.faultedParty, 'none');
  assert.equal(result.seller.sellerBundle.outcome, 'completed');
  assert.deepEqual(result.seller.sellerBundle.phaseSummary.map(({ index, kind, outcome }) => ({ index, kind, outcome })), [
    { index: 0, kind: 'negotiate-fixed-price', outcome: 'ok' },
    { index: 1, kind: 'commit-payee-bound-agreement', outcome: 'ok' },
    { index: 2, kind: 'pay-dem', outcome: 'ok' },
    { index: 3, kind: 'deliver-storage-program', outcome: 'ok' },
  ]);
  assert.equal(result.seller.bundleContentHash, result.buyer.bundleContentHash);
  assert.deepEqual(result.seller.sellerBundle.settlementEvidence, [w.paymentRef, w.deliveryRef]);
  assert.deepEqual(w.writes, { buyer: 1, seller: 1 });
  assert.ok(w.input.dependencies.every((entry) => w.nativeReads.includes(entry.anchorReceipt.nativeAddress)));
  assert.notEqual(identityBundleHash(w.sellerPublished), identityBundleHash(w.sellerIdentity));
  assert.equal(ST11_PROFILE.evidenceMode, 'offline-fixture');
  assert.equal(result.buyer.binding, undefined, 'pure mapping does not invent a BundleBinding');
  const replay = await signAndFinalize(w);
  assert.equal(replay.seller.resumedBundle, true);
  assert.deepEqual(w.writes, { buyer: 1, seller: 1 }, 'exact finalized readback never writes twice');
});

test('missing mandatory authority seams fail before any finalizer runs', () => {
  const w = fixture();
  for (const key of ['verifyDependency', 'verifyIdentityLinkage', 'verifyVetProvenance', 'resolvePaymentPhaseIndex']) {
    assert.throws(() => createSt11FixtureFinalizationProvider({ substrate: w.substrate, authority: { ...w.authority, [key]: undefined } }), /st11_missing_/);
  }
});

test('incomplete or already-terminal canonical session facts cannot become a completed proposal', async (t) => {
  for (const variant of ['phase-gap', 'already-finalised', 'endedAt', 'missing-registry']) await t.test(variant, () => {
    const w = fixture();
    if (variant === 'phase-gap') w.input.session.phaseResults.pop();
    if (variant === 'already-finalised') w.input.session.state = 'finalised';
    if (variant === 'endedAt') w.input.session.endedAt = NOW;
    if (variant === 'missing-registry') delete w.input.session.recipeRegistryVersion;
    assert.throws(() => prepareStrictCompletedBundleRequest(w.input), variant === 'phase-gap'
      ? /one PhaseEntry per executed pipeline phase/ : /one exact audit-pending DACS-5 SessionRecord/);
    assert.deepEqual(w.writes, { buyer: 0, seller: 0 });
  });
});

test('missing, extra, and duplicate closure nodes fail closed before a role write', async (t) => {
  for (const variant of ['missing', 'extra', 'duplicate']) await t.test(variant, async () => {
    const w = fixture();
    if (variant === 'missing') w.input.dependencies.splice(w.input.dependencies.findIndex((entry) => entry.anchorReceipt.contentHash === w.paymentRef.contentHash), 1);
    else if (variant === 'duplicate') w.input.dependencies.push(structuredClone(w.input.dependencies[0]));
    else {
      const extra = structuredClone(w.input.dependencies[1]);
      extra.source.ref.anchor.locator += ':unreferenced';
      extra.anchorReceipt.logicalAddress += ':unreferenced';
      extra.anchorReceipt.nativeAddress = storAddress(extra.anchorReceipt.logicalAddress);
      w.input.dependencies.push(extra);
    }
    const expected = { missing: /missing from the recursive ST-11 closure/, extra: /exactly cover the recursive ST-11 closure/, duplicate: /duplicate source/ };
    await assert.rejects(signAndFinalize(w), expected[variant]);
    assert.deepEqual(w.writes, { buyer: 0, seller: 0 });
  });
});

test('receipt lifecycle, proof, and native resolution boundaries stay audit-pending', async (t) => {
  for (const variant of ['included', 'indeterminate', 'proof', 'absent', 'read-indeterminate', 'hash']) await t.test(variant, async () => {
    const w = fixture();
    const dependency = w.input.dependencies.find((entry) => entry.anchorReceipt.contentHash === w.paymentRef.contentHash);
    if (variant === 'included') dependency.anchorReceipt.state = 'included';
    if (variant === 'indeterminate') { dependency.anchorReceipt.observationDisposition = 'indeterminate'; dependency.anchorReceipt.preservedReceiptHash = sha256Hex(canonicalize(dependency.anchorReceipt)); }
    if (variant === 'proof') corruptReceiptProof(dependency.anchorReceipt);
    if (variant === 'absent') w.faults.native.set(dependency.anchorReceipt.nativeAddress, { disposition: 'absent' });
    if (variant === 'read-indeterminate') w.faults.native.set(dependency.anchorReceipt.nativeAddress, { disposition: 'indeterminate', reason: 'fixture reader unavailable' });
    if (variant === 'hash') {
      const changed = structuredClone(w.records.get(dependency.anchorReceipt.nativeAddress).artifact);
      changed.paymentAmount.amount = '2.4';
      w.faults.native.set(dependency.anchorReceipt.nativeAddress, { disposition: 'present', artifact: changed });
    }
    const expected = { included: /lacks an established finalized AnchorReceipt/, indeterminate: /lacks an established finalized AnchorReceipt/,
      proof: /receipt proof is invalid/, absent: /authoritatively absent despite its finalized receipt/,
      'read-indeterminate': /resolution is indeterminate/, hash: /different canonical content hash/ };
    await assert.rejects(signAndFinalize(w), expected[variant]);
    assert.deepEqual(w.writes, { buyer: 0, seller: 0 });
    assert.equal(w.input.session.state, 'audit-pending');
  });
});

test('unknown provenance and lineage dispositions never authorize a buyer signature', async (t) => {
  for (const seam of ['provenance', 'identity']) for (const disposition of ['invalid', 'indeterminate', 'error', true, undefined]) await t.test(`${seam}:${String(disposition)}`, async () => {
    const w = fixture();
    w.faults[seam] = disposition;
    let signatures = 0;
    const signer = { ...w.buyer, signer: (...args) => { signatures++; return w.buyer.signer(...args); } };
    await assert.rejects(createStrictCompletedBuyerCounterSignature({ sellerVerificationInput: w.verificationInput(), buyer: signer }, prepareStrictCompletedBundleRequest(w.input), w.provider),
      seam === 'provenance' ? /Vet requirement invocation provenance/ : /Listing\/session IdentityBundle claim and key linkage/);
    assert.equal(signatures, 0);
    assert.deepEqual(w.writes, { buyer: 0, seller: 0 });
  });
});

test('seller-supplied detached scope and completed-copy substitutions are rejected', async () => {
  const w = fixture();
  const request = prepareStrictCompletedBundleRequest(w.input);
  await assert.rejects(createStrictCompletedBuyerCounterSignature({ sellerVerificationInput: w.verificationInput(), buyer: w.buyer }, { ...request, bundleContentHash: 'f'.repeat(64) }, w.provider));
  const { signature, seller } = await signAndFinalize(w);
  const altered = structuredClone(seller);
  altered.buyerBundle.anchoredByRole = 'seller';
  await assert.rejects(finalizeStrictCompletedBuyerBundle({ sellerVerificationInput: w.verificationInput(), sellerFinalization: altered, counterSignature: signature, buyer: w.buyer }, w.provider));
  assert.deepEqual(w.writes, { buyer: 1, seller: 1 });
});

test('PC-2 resolver must match the whole authenticated executed job, rail, phase and resolved tuple', async (t) => {
  const variants = { jobId: '01J8ME0SXKQ4T9V2RC5HJ6WX7E', railId: 'demos-native:OTHER', phaseIndex: 3, resolved: true };
  for (const [field, value] of Object.entries(variants)) await t.test(field, async () => {
    const w = fixture();
    w.provider = { ...w.provider, resolvePaymentPhaseIndex: () => ({ disposition: 'valid', jobId: JOB,
      railId: DEM_RAIL.railId, phaseIndex: 2, resolved: false, [field]: value }) };
    await assert.rejects(signAndFinalize(w), /payment evidence contradicts its authenticated job\/rail\/phase\/resolved binding/);
    assert.deepEqual(w.writes, { buyer: 0, seller: 0 });
  });
});

test('bundle publication is non-terminal when proof or readback is ambiguous; retry does not overwrite', async (t) => {
  for (const variant of ['receipt', 'lookup']) await t.test(variant, async () => {
    const w = fixture();
    if (variant === 'receipt') w.faults.invalidBundleProof = true;
    else w.faults.bundle.set('seller', { disposition: 'indeterminate', reason: 'fixture resolution conflict' });
    await assert.rejects(signAndFinalize(w));
    assert.equal(w.writes.buyer, 0);
    const before = w.writes.seller;
    await assert.rejects(signAndFinalize(w));
    assert.equal(w.writes.seller, before);
  });
});

test('guard witness: accepting control survives; disabling only receipt-proof verification accepts a forged fixture proof', async () => {
  const control = fixture();
  assert.equal((await signAndFinalize(control)).seller.state, 'finalised');
  const w = fixture();
  const dependency = w.input.dependencies.find((entry) => entry.anchorReceipt.contentHash === w.paymentRef.contentHash);
  // Same artifact, coordinates, writer, lifecycle and content hash. The
  // fixture transaction/proof hash remains internally consistent, leaving
  // the invalid writer signature as the only broken receipt proof rule.
  corruptReceiptProof(dependency.anchorReceipt);
  await assert.rejects(signAndFinalize(w), /receipt proof is invalid/);
  w.provider = { ...w.provider, verifyDependencyReceipt: () => 'valid' };
  assert.equal((await signAndFinalize(w)).seller.state, 'finalised', 'named proof gate is causally necessary');
});
