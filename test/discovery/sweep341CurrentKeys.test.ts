import { describe, expect, it, vi } from 'vitest';
import { isCanonicalJobId, finalityCommitmentAddress } from '@kynesyslabs/dacs/negotiate';
import { isCurrentJobId, admitArtifactJson, contentHash } from '@kynesyslabs/dacs/canonical';
import { createBoundArtifactRepository, createInMemoryBindingStore } from '../../src/discovery/index.js';
const JOB = '01J8ME0SXKQ4T9V2RC5HJ6WX7D';
describe('exact current job admission', () => {
  it('uses the same exact grammar in both exported predicates and commitment builder', () => {
    expect(isCurrentJobId(JOB + '\n')).toBe(false);
    expect(isCanonicalJobId(JOB + '\n')).toBe(false);
    expect(() => finalityCommitmentAddress(JOB + '\n')).toThrow();
  });
  it.each([
    'dacs4:payment:job-abc:rail:0',
    'dacs2:registry:scheme:identifier:v1',
    'dacs2:composite:job-abc:did',
    'dacs3:commit:job-abc',
    'dacs4:deliverable:job-abc',
    'dacs4:entitlement:job-abc:0',
    'dacs4:payment-disposition:job-abc:0:' + 'a'.repeat(64),
    'dacs4:payload-attestation:job-abc:' + 'a'.repeat(64) + ':0',
    'dacs5:rating:job-abc:did',
    `dacs4:payment:${JOB.toLowerCase()}:rail:0`,
  ])('does not publish or resolve malformed current job address %s', async (address) => {
    const artifact = { public: 'no keys or network in this fixture' };
    const store = createInMemoryBindingStore();
    const anchorWriteOnce = vi.fn(async () => ({ address: 'native-public-fixture' }));
    const resolve = vi.fn(store.resolve);
    const publish = vi.fn(store.publish);
    const readAnchor = vi.fn(async () => admitArtifactJson(Buffer.from(JSON.stringify(artifact))));
    const repo = createBoundArtifactRepository({
      adapter: { getAddress: () => 'public-owner', anchorWriteOnce,
        readAnchor },
      index: { resolve }, publisher: { publish },
    });
    const attempted = repo.write(address, artifact);
    await expect(attempted).rejects.toThrow();
    expect(anchorWriteOnce).not.toHaveBeenCalled();
    await repo.read(address, 'public-owner', () => true);
    expect(resolve).not.toHaveBeenCalled();
    expect(readAnchor).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

import { verifySettlementEvidence } from '@kynesyslabs/dacs';
it('requires authenticated absolute HTLC expiry instants before an authenticated payment pass', async () => {
  const signer = 'did:demos:orchestrator';
  const record = admitArtifactJson(Buffer.from(JSON.stringify({
    evidenceVersion: '1', jobId: JOB, phase: 'pay-cross-chain-htlc', outcome: 'success', observedAt: 1,
    paymentAmount: { amount: '5', currency: 'USDC' },
    paymentTxRefs: [{ kind: 'htlc-claim', chainId: 80002,
      contractAddress: '0x0000000000000000000000000000000000000001', claimTxHash: '0xclaim' }],
    settlementFinality: { model: 'htlc-reveal', finalityObservedAt: 1 },
    signature: { algorithm: 'ed25519', signer, value: Buffer.alloc(64).toString('base64url') },
  })));
  const result = await verifySettlementEvidence(record, {
    orchestrator: signer,
    agreement: { amount: '5', currency: 'USDC' },
    rail: { railId: 'rail', railType: 'cross-chain-htlc', handler: 'pay-cross-chain-htlc',
      asset: 'USDC', sourceFinalitySec: 120, safetyWindowSec: 600 },
    attestationRef: { anchor: { kind: 'storage-program', locator: `dacs4:payment:${JOB}:rail:0` },
      contentHash: contentHash(record) },
    paymentAddress: { railId: 'rail', phaseIndex: 0 },
    result: { ok: true, txRefs: record.paymentTxRefs as never },
  }, { resolvePublicKey: async () => new Uint8Array(32), verify: () => true });
  // Crypto is injected to isolate context validation; this fixture is not signed.
  expect(result.decision).not.toBe('pass');
});


it("current authenticated payment requires the pinned AssetSpec and NetworkSpec before crypto", async () => {
  const signer = 'did:demos:orchestrator';
  const record = admitArtifactJson(Buffer.from(JSON.stringify({ jobId: JOB, phase: 'pay-x402' })));
  for (const rail of [{}, { assetSpec: { kind: 'erc20' } }, { networkSpec: { kind: 'x402-resource' } }]) {
    const deps = { resolvePublicKey: vi.fn(), verify: vi.fn() };
    const result = await verifySettlementEvidence(record, { rail, orchestrator: signer } as never, deps);
    expect(result).toEqual({ decision: 'error', reasons: ['current payment verification requires authenticated pinned assetSpec and networkSpec'] });
    expect(deps.resolvePublicKey).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  }
});
