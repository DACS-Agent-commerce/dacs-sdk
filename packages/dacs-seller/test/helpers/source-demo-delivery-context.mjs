// TEST-only application producer for the exact DACS-2 provenance consumed by
// the SDK V2 seller fulfilment path.  Both party records are produced by
// partyVetCore under one current fenced seller/orchestrator lease, anchored to
// the owned loopback SR-2 fixture, and independently closure-verified before
// they are admitted to Agreement derivation.
import {
  canonicalize,
  compositeVerificationAddress,
  contentHash,
  createInMemoryFencedSessionStore,
  identityBundleHash,
  partyVetCore,
  verifyCompositeVerificationRecord,
} from '@kynesyslabs/dacs';
import { fixtureRef, signAnchorWrite, verifyFixtureRecord, verifyFixtureReceipt } from '../../src/dacs/fixture-anchors.mjs';
import { DEM_RAIL, verifyComponent } from '../../src/dacs/listing.mjs';
import { listingPin, protocolSupport } from '../../src/dacs/purchase-protocol.mjs';

const same = (a, b) => canonicalize(a) === canonicalize(b);
const clone = (value) => JSON.parse(canonicalize(value));

function operationStore() {
  const checkpoints = new Map(), steps = new Map();
  const run = async (input) => {
    const key = canonicalize({ operationKey: input.operationKey, step: input.step });
    const existing = steps.get(key);
    if (existing) {
      if (existing.operationHash !== input.operationHash || existing.inputHash !== input.inputHash) throw new Error('party Vet effect key conflict');
      if (existing.error) throw existing.error;
      return clone(existing.value);
    }
    try {
      const value = await input.execute();
      steps.set(key, { operationHash: input.operationHash, inputHash: input.inputHash, value: clone(value) });
      return clone(value);
    } catch (error) {
      steps.set(key, { operationHash: input.operationHash, inputHash: input.inputHash, error });
      throw error;
    }
  };
  return {
    load: async (key) => checkpoints.has(key) ? clone(checkpoints.get(key)) : null,
    compareAndSet: async ({ operationKey, expected, next }) => {
      const current = checkpoints.has(operationKey) ? checkpoints.get(operationKey) : null;
      if (!same(current, expected)) return false;
      checkpoints.set(operationKey, clone(next));
      return true;
    },
    runOnce: run,
    runOnceAuthorized: async (input) => {
      const authorization = await input.authorize();
      if (authorization.status !== 'authorized') return { status: 'authorization-rejected', reason: authorization.reason };
      return { status: 'complete', value: await run(input) };
    },
  };
}

export function createSourceDemoDeliveryContextProvider({ anchors, wallet, now = () => Date.now() }) {
  const contexts = new Map(), invocations = [], nativeLocators = new Map();
  const componentVerifier = {
    isSignerAuthorized: (_artifact, signature) => signature.signer === wallet.claim,
    resolvePublicKey: (signature) => signature.signer === wallet.claim ? signature.signer : null,
    verify: ({ signedBytes, signature }) => verifyComponent({ signedBytes, signature }),
  };

  async function produceParty({ jobId, identityBundle, requirement, store, lease }) {
    const produced = await partyVetCore({
      jobId,
      evaluatedParty: identityBundle.presentedBy,
      identityBundle,
      requirement,
      attempts: [],
    }, {
      proxyFetch: async () => { throw new Error('empty TEST requirement cannot invoke a proxy'); },
      nowMs: now,
      componentSigner: { algorithm: 'ed25519', signer: wallet.claim, sign: (bytes) => wallet.signBytes(bytes) },
      anchorFinalizedArtifact: async ({ logicalAddress, artifact }) => {
        const receipt = await anchors.write({ logicalAddress, artifact, writer: wallet.claim,
          writerSignature: signAnchorWrite((bytes) => wallet.signBytes(bytes), logicalAddress, contentHash(artifact)) });
        nativeLocators.set(receipt.nativeAddress, logicalAddress);
        // partyVetCore authenticates the binding-native locator.  The
        // application later exposes the independently readable canonical
        // logical-address ref required by the fixed-price fulfilment profile.
        return { ref: { anchor: { kind: 'storage-program', locator: receipt.nativeAddress }, contentHash: contentHash(artifact), signer: wallet.claim }, receipt };
      },
      verifyFinalizedAnchor: ({ logicalAddress, artifact, receipt }) =>
        verifyFixtureReceipt({ receipt, logicalAddress, hash: contentHash(artifact), expectedWriter: wallet.claim }) === 'valid',
      readAnchoredJson: async (ref) => {
        const read = await anchors.read(nativeLocators.get(ref.anchor.locator) ?? ref.anchor.locator);
        return read.status === 'present' && contentHash(read.artifact) === ref.contentHash ? read.artifact : null;
      },
      resolveFinalizedArtifact: async ({ logicalAddress, contentHash: hash }) => {
        const read = await anchors.read(logicalAddress);
        if (read.status !== 'present' || contentHash(read.artifact) !== hash ||
            verifyFixtureRecord(read, { logicalAddress, expectedWriter: wallet.claim }) !== 'valid') return null;
        return { ref: { anchor: { kind: 'storage-program', locator: read.receipt.nativeAddress }, contentHash: hash, signer: wallet.claim }, receipt: read.receipt };
      },
      operationStore: operationStore(),
      verifyIdentityPresentation: ({ bundle, signedBytes }) => {
        const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
        return Boolean(proof && verifyComponent({ signedBytes, signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
      },
      componentVerifier,
      sessionEffectAuthority: { store, leaseToken: { owner: lease.owner, generation: lease.generation } },
    });
    const strict = await verifyCompositeVerificationRecord(produced.record, {
      jobId,
      evaluatedParty: identityBundle.presentedBy,
      bundleHash: identityBundleHash(identityBundle),
      requirement,
      verifier: wallet.claim,
      freshness: [],
      dealSpecific: [],
    }, {
      nowMs: now,
      resolve: async (ref) => {
        const read = await anchors.read(ref.anchor.locator);
        return read.status === 'present' && contentHash(read.artifact) === ref.contentHash
          ? { encoding: 'canonical-json', value: read.artifact } : null;
      },
      resolveRecipe: async () => null,
      isRecipeSignerAuthorized: () => false,
      isVerifyResultSignerAuthorized: () => false,
      resolvePublicKey: componentVerifier.resolvePublicKey,
      verify: componentVerifier.verify,
      verifyAuthorityAttestation: () => 'unresolved',
    });
    if (strict.status !== 'valid') throw new Error(`TEST party Vet closure failed: ${strict.status}:${strict.code}`);
    const expectedAddress = compositeVerificationAddress(jobId, identityBundle.presentedBy);
    const readback = await anchors.read(expectedAddress);
    if (verifyFixtureRecord(readback, { logicalAddress: expectedAddress, expectedWriter: wallet.claim }) !== 'valid' ||
        contentHash(readback.artifact) !== contentHash(produced.record)) throw new Error('TEST party Vet logical readback failed');
    const recordRef = { ...fixtureRef(expectedAddress, contentHash(produced.record)), signer: wallet.claim };
    invocations.push({ evaluatedParty: identityBundle.presentedBy, recordRef: clone(recordRef), nativeRecordRef: clone(produced.recordRef), record: clone(produced.record), strictStatus: strict.status });
    return { ...produced, recordRef };
  }

  async function resolveBuyer({ scope, buyerIdentityBundle }) {
    const existing = contexts.get(scope.jobId);
    if (existing) return same(existing.scope, scope) ? { disposition: 'present', value: { scope: clone(scope), input: clone(existing.input) } }
      : { disposition: 'rejected', reason: 'TEST DEM delivery context scope conflict' };
    // The resolver receives a scope, not Listing bytes.  Seller/listing bytes
    // are supplied by installListing before buyer planning.
    const configured = [...contexts.values()].find((entry) => entry.pending === true && entry.seller === scope.seller);
    if (!configured) return { disposition: 'indeterminate', reason: 'TEST DEM seller context is not installed' };
    const { listing } = configured;
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: scope.jobId, phase: 'settle-pending', now: now() });
    const leased = await store.acquireLease({ jobId: scope.jobId, owner: 'source-demo-party-vet', ttlMs: 300_000, now: now() });
    if (!leased.ok) throw new Error(`TEST party Vet lease failed: ${leased.reason}`);
    const buyerVet = await produceParty({ jobId: scope.jobId, identityBundle: buyerIdentityBundle, requirement: listing.buyerRequirement, store, lease: leased.lease });
    const sellerVet = await produceParty({ jobId: scope.jobId, identityBundle: listing.seller.identity, requirement: listing.buyerRequirement, store, lease: leased.lease });
    const input = {
      jobId: scope.jobId,
      verifiedListing: { disposition: 'verified', listing, pin: listingPin(listing) },
      buyer: { identityBundle: buyerIdentityBundle, vetRecordRef: buyerVet.recordRef },
      seller: { identityBundle: listing.seller.identity, vetRecordRef: sellerVet.recordRef },
      selectedRail: { ...DEM_RAIL },
      payoutBindings: [{ railId: DEM_RAIL.railId, phaseIndex: protocolSupport(listing).phases.payment, payeeAddress: scope.payee }],
      generatedAt: scope.generatedAt,
    };
    const vetRequirements = [buyerVet, sellerVet].map((vet) => ({
      vetRecordRef: clone(vet.recordRef),
      evaluatedParty: vet.record.evaluatedParty,
      requirement: clone(listing.buyerRequirement),
      verifier: wallet.claim,
      freshness: [],
      dealSpecific: [],
    }));
    contexts.delete(configured.key);
    contexts.set(scope.jobId, { scope: clone(scope), input: clone(input), vetRequirements: clone(vetRequirements), seller: wallet.claim, listing: clone(listing) });
    return { disposition: 'present', value: { scope: clone(scope), input: clone(input) } };
  }

  return {
    installListing(listing) {
      const key = `pending:${listing.seller.identity.presentedBy}`;
      contexts.set(key, { key, pending: true, seller: listing.seller.identity.presentedBy, listing: clone(listing) });
    },
    resolveBuyer,
    resolveSeller: async ({ jobId, listingPin: requestedPin, buyerIdentityBundle, generatedAt }) => {
      const found = contexts.get(jobId);
      if (!found || found.pending) return { disposition: 'indeterminate', reason: 'TEST DEM buyer context is not retained' };
      if (!same(found.input.verifiedListing.pin, requestedPin) || !same(found.input.buyer.identityBundle, buyerIdentityBundle) || found.input.generatedAt !== generatedAt) {
        return { disposition: 'rejected', reason: 'TEST DEM seller context differs from buyer context' };
      }
      return { disposition: 'present', value: { input: clone(found.input), vetRequirements: clone(found.vetRequirements) } };
    },
    contexts,
    invocations,
  };
}
