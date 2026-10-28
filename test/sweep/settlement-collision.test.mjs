// Run with Node 22: node --loader ./test/sweep/source-loader.mjs --test test/sweep/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = pathToFileURL(resolve(process.env.DACS_SWEEP_REPO ?? '.') + '/');
const api = await import(new URL('src/agent/settlementIdentity.ts', root));
const { signArtifact } = await import(new URL('src/crypto/signing.ts', root));
const { ed25519Verify, publicKeyFromRaw, publicKeyFromSeed, rawPublicKey } = await import(new URL('src/crypto/ed25519.ts', root));
const seed = new Uint8Array(32).fill(42);
const key = rawPublicKey(publicKeyFromSeed(seed));
const deps = { resolvePublicKey: () => key, verify: (m,s,k) => ed25519Verify(m,s,publicKeyFromRaw(k)) };
const jobA = '01JZ0000000000000000000360';
const jobB = '01JZ0000000000000000000361';
const tx = 'ab'.repeat(32);
const settlementId = `evm:8453:${tx}:0`;
function record(jobId = jobA, phaseIndex = 0, logIndex = 0) {
  const evidence = {
    evidenceVersion: '1', jobId, phase: 'pay-evm-erc20', outcome: 'success',
    paymentTxRefs: [{ kind: 'evm-event', chainId: 8453, txHash: tx, logIndex }],
    paymentAmount: { amount: '5', currency: 'USDC' },
    settlementFinality: { model: 'block-depth', finalityBlocks: 12, finalityObservedAt: 1785866400000 },
    observedAt: 1785866400000,
  };
  evidence.signature = { algorithm: 'ed25519', signer: 'did:demos:orchestrator', value: Buffer.from(signArtifact('dacs-evidence:v1:', evidence, seed)).toString('base64url') };
  return { evidence, context: {
    anchorAddress: `dacs4:payment:${jobId}:base-usdc:${phaseIndex}`, phaseIndex, railId: 'base-usdc',
    asset: 'USDC', payer: 'buyer', payee: 'seller', amount: { amount: '5', currency: 'USDC' },
    ledgerEvents: [{ ledger: 'evm', chainId: 8453, txHash: tx, logIndex, standard: 'erc20-transfer', asset: 'USDC', payer: 'buyer', payee: 'seller', amount: '5' }],
  }, railProfile: { definitionHash: 'cd'.repeat(32), bindingProfile: 'eip3009-sb3-v1' } };
}
const batch = (...args) => api.resolveSettlementEventIdentities(...args);
const decisions = result => result.records.map(r => r.decision);
const binding = (r, changes = {}) => ({ settlementId, jobId: r.evidence.jobId, phaseIndex: r.context.phaseIndex, railId: r.context.railId, ...r.railProfile, ...changes });

test('point resolution cannot authorize a first arrival via priorClaims', async () => {
  const r = record();
  const result = await api.resolveSettlementEventIdentity(r.evidence, { ...r.context, priorClaims: {} }, deps);
  assert.equal(result.decision, 'indeterminate');
});
test('complete singleton and duplicate presentations count once; distinct batched events count separately', async () => {
  const r = record();
  const single = await batch([r], deps);
  assert.deepEqual(decisions(single), ['pass']);
  assert.deepEqual(single.countable, [{ settlementId, jobId: jobA, phaseIndex: 0 }]);
  assert.equal((await batch([r, structuredClone(r)], deps)).countable.length, 1);
  assert.equal((await batch([r, record(jobB, 1, 1)], deps)).countable.length, 2);
});
test('late collision revokes the earlier provisional count in either arrival order', async () => {
  for (const records of [[record(), record(jobB)], [record(jobB), record()]]) {
    assert.equal((await batch([records[0]], deps)).countable.length, 1);
    const result = await batch(records, deps);
    assert.deepEqual(decisions(result), ['indeterminate', 'indeterminate']);
    assert.deepEqual(result.countable, []);
  }
});
test('exact independently authenticated settlement-side authority can select either tuple', async () => {
  const a = record(), b = record(jobB);
  for (const selected of [a, b]) {
    const result = await batch([a, b], deps, input => {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.claims[0].railProfile), true);
      return [binding(selected)];
    });
    assert.deepEqual(decisions(result), selected === a ? ['pass', 'fail'] : ['fail', 'pass']);
    assert.equal(result.countable[0].jobId, selected.evidence.jobId);
  }
});
test('missing, wrong-group, wrong-rail, wrong-profile, incomplete, or conflicting authority selects nobody', async () => {
  const a = record(), b = record(jobB);
  for (const authority of [null, [], [{ ...binding(a), phaseIndex: undefined }], [binding(a, { settlementId: `evm:8453:${'ff'.repeat(32)}:0` })], [binding(a, { railId: 'other' })], [binding(a, { definitionHash: 'ef'.repeat(32) })], [binding(a, { bindingProfile: 'permit2-job-only' })], [binding(a), binding(b)]]) {
    const result = await batch([a,b], deps, () => authority);
    assert.deepEqual(decisions(result), ['indeterminate', 'indeterminate']);
    assert.equal(result.countable.length, 0);
  }
});
test('job-only authority cannot select between phases of the same job', async () => {
  const a = record(), b = record(jobA, 1);
  const authority = binding(a); delete authority.phaseIndex;
  assert.deepEqual(decisions(await batch([a,b], deps, () => [authority])), ['indeterminate', 'indeterminate']);
});
test('the complete evidence set is captured before signature callbacks can mutate it', async () => {
  const records = [record(), record(jobB)];
  let calls = 0;
  const result = await batch(records, { ...deps, resolvePublicKey: () => { calls++; records.pop(); return key; } });
  assert.equal(calls, 2);
  assert.deepEqual(decisions(result), ['indeterminate', 'indeterminate']);
});
test('unauthenticated or malformed claims are excluded without hiding valid claims', async () => {
  const bad = record(jobB); bad.evidence.signature.value = 'A'.repeat(86);
  const result = await batch([record(), bad], deps);
  assert.deepEqual(decisions(result), ['pass', 'fail']);
  assert.equal(result.countable.length, 1);
  const malformed = record(); malformed.evidence.jobId = 'job-legacy';
  let calls = 0;
  const rejected = await batch([malformed], { ...deps, resolvePublicKey: () => { calls++; return key; } });
  assert.equal(calls, 0);
  assert.deepEqual(decisions(rejected), ['error']);
});
test('a prior index can reveal omitted competing evidence but cannot select a winner', async () => {
  const r = record(); r.context.priorClaims = { [settlementId]: { jobId: jobB, phaseIndex: 0 } };
  assert.deepEqual(decisions(await batch([r], deps)), ['indeterminate']);
});
test('JID-1 rejects trailing line terminators and alternate spellings in both shared validators', async () => {
  const { isCanonicalJobId: producer } = await import(new URL('src/negotiate/jobId.ts', root));
  const { isCanonicalJobId: consumer } = await import(new URL('src/artifacts/validators.ts', root));
  for (const check of [producer, consumer]) {
    for (const good of [jobA, '00000000000000000000000000', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ']) assert.equal(check(good), true);
    for (const bad of [jobA+'\n', jobA+'\r', jobA+'\r\n', jobA.toLowerCase(), '8'+jobA.slice(1), ' '+jobA, jobA.slice(0,-1)+'K']) assert.equal(check(bad), false, JSON.stringify(bad));
  }
});
test('authority for a selected tuple does not authorize a copy with a different pinned rail/profile', async () => {
  const a = record(), alternate = record(), b = record(jobB);
  alternate.railProfile.definitionHash = 'ef'.repeat(32);
  const result = await batch([a,alternate,b], deps, () => [binding(a)]);
  assert.deepEqual(decisions(result), ['pass','indeterminate','fail']);
  assert.equal(result.countable.length, 1);
});
