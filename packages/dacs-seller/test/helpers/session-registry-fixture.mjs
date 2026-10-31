import * as core from '@kynesyslabs/dacs';
import { seller, NOW } from './protocol-fixture.mjs';

// Authenticate a real signed registry and pin it under an in-memory lease.
export async function sessionRegistrySnapshot(jobId, tag = 'default', entries) {
  return (await sessionRegistryFixture(jobId, tag, entries)).sessionSnapshot;
}

export async function sessionRegistryFixture(jobId, tag = 'default', entries) {
  const recipes = entries ?? [await core.signComponentArtifact({ recipeVersion: 1, scheme: 'domain',
    defaultMethod: { kind: 'consensus-backed-proxy', endpoint: { method: 'GET', urlTemplate: 'https://authority.example/{identifier}' } },
    defaultMaxAgeSec: 3600, parserRules: { format: 'json', successJsonPath: '$.active' }, retryClass: 'permanent', availability: 'live',
    governance: { proposedBy: seller.claim, acceptedAt: NOW - 1000, anchoring: 'single-signer' },
  }, 'dacs-recipe:v1:', { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes })];
  const recipeRefs = recipes.map((recipe, i) => ({ anchor: { kind: 'storage-program', locator: `TEST-recipe:${tag}:${i}` }, contentHash: core.contentHash(recipe) }));
  const documents = new Map(recipeRefs.map((ref, i) => [ref.anchor.locator, recipes[i]]));
  const index = { registryId: core.RECIPE_REGISTRY_INDEX_ADDRESS, entries: recipeRefs };
  const indexRef = { anchor: { kind: 'storage-program', locator: `TEST-registry:${tag}` }, contentHash: core.contentHash(index) };
  const receipt = {
    receiptVersion: '1', substrate: 'TEST', finalityProfile: 'instant-test-finality',
    logicalAddress: core.RECIPE_REGISTRY_INDEX_ADDRESS, nativeAddress: indexRef.anchor.locator,
    contentHash: indexRef.contentHash, transactionRef: { kind: 'memory-tx', value: `TEST-tx:${tag}` },
    writer: seller.claim, state: 'finalized', observationDisposition: 'established', observedAt: NOW,
    blockRef: { id: `TEST-block:${tag}`, height: '1', timestamp: NOW }, evidence: { kind: 'memory-proof', value: `TEST-proof:${tag}` },
  };
  const provider = {
    resolveCurrentIndex: async () => ({ registryVersion: 1, indexRef: structuredClone(indexRef), receipt: structuredClone(receipt) }),
    authenticateCurrentIndex: () => 'valid',
    readAnchoredJson: async ref => structuredClone(ref.anchor.locator === indexRef.anchor.locator ? index : documents.get(ref.anchor.locator)),
    stewardWriter: seller.claim, stewardSigner: seller.claim,
    stewardPublicKey: Uint8Array.from(core.rawPublicKey(core.publicKeyFromSeed(new Uint8Array(32).fill(17)))),
    verify: (bytes, signature, key) => core.ed25519Verify(bytes, signature, core.publicKeyFromRaw(key)),
  };
  const store = core.createInMemoryFencedSessionStore();
  await store.create({ jobId, now: 0 });
  const lease = await store.acquireLease({ jobId, owner: 'TEST-registry-fixture', ttlMs: 10_000, now: 0 });
  if (!lease.ok) throw new Error(`TEST registry lease failed: ${lease.reason}`);
  const scope = { store, jobId, sessionStartHash: core.sha256Hex(`TEST-session:${jobId}`), leaseToken: lease.lease, now: 1 };
  return { sessionSnapshot: await core.pinSessionRecipeRegistrySnapshot({ ...scope, provider }),
    recover: () => core.recoverSessionRecipeRegistrySnapshot(scope) };
}
