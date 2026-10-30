import * as core from '@kynesyslabs/dacs';
import { seller, NOW } from './protocol-fixture.mjs';

// Authenticate a real signed registry and pin it under an in-memory lease.
export async function sessionRegistrySnapshot(jobId, tag = 'default') {
  const recipe = await core.signComponentArtifact({ recipeVersion: 1, scheme: 'domain',
    defaultMethod: { kind: 'consensus-backed-proxy', endpoint: { method: 'GET', urlTemplate: 'https://authority.example/{identifier}' } },
    defaultMaxAgeSec: 3600, parserRules: { format: 'json', successJsonPath: '$.active' }, retryClass: 'permanent', availability: 'live',
    governance: { proposedBy: seller.claim, acceptedAt: NOW - 1000, anchoring: 'single-signer' },
  }, 'dacs-recipe:v1:', { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  const recipeRef = { anchor: { kind: 'storage-program', locator: `TEST-recipe:${tag}` }, contentHash: core.contentHash(recipe) };
  const index = { registryId: core.RECIPE_REGISTRY_INDEX_ADDRESS, entries: [recipeRef] };
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
    readAnchoredJson: async ref => structuredClone(ref.anchor.locator === indexRef.anchor.locator ? index : recipe),
    stewardWriter: seller.claim, stewardSigner: seller.claim,
    stewardPublicKey: Uint8Array.from(core.rawPublicKey(core.publicKeyFromSeed(new Uint8Array(32).fill(17)))),
    verify: (bytes, signature, key) => core.ed25519Verify(bytes, signature, core.publicKeyFromRaw(key)),
  };
  const store = core.createInMemoryFencedSessionStore();
  await store.create({ jobId, now: 0 });
  const lease = await store.acquireLease({ jobId, owner: 'TEST-registry-fixture', ttlMs: 10_000, now: 0 });
  if (!lease.ok) throw new Error(`TEST registry lease failed: ${lease.reason}`);
  return core.pinSessionRecipeRegistrySnapshot({ store, jobId, sessionStartHash: core.sha256Hex(`TEST-session:${jobId}`), provider, leaseToken: lease.lease, now: 1 });
}
