// The native commitment reader (readDevnetNativeCommitment) authenticates the
// retained commitment and its receipt, then the SDK's commitFixedPriceAgreement
// re-reads the receipt proof (verifyAnchorReceipt). When that re-read is not
// established (a node 503, or a connection fence refused at the shutdown grace,
// which the adapter maps to indeterminate) the SDK throws a SubstrateError. That
// is no contradiction: the reader answers indeterminate and the purchase stays
// agreement_pending until a clean readback. Only an authenticated contradiction
// is rejected: an invalid signature (the SDK's CounterpartyError), or a receipt
// proof the plugin's own anchor answered invalid (the source change; see
// commitment-node-junk-reader.test.mjs for node answers that do not authenticate).
// Review finding: PR the source change an earlier review, code P2-1 / a review first P2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetLiveCompositionApp } from './helpers/devnet-live-composition-app.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { post } from './helpers/public-sr2-projection-flow.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { createSellerTransportClientAuth } from '../src/dacs/seller-transport-auth.mjs';
import { createDevnetNativeCommitmentCapability, readDevnetNativeCommitment } from '../src/devnet-demo/commitment-consumer.mjs';
import { IMMUTABLE_READBACK_TTL_MS } from '../src/util/immutable-readbacks.mjs';
import { opsHealth } from '../src/ops/health.mjs';

const commitmentTxs = (h) => h.transport.chain.wire.record.accepted.filter((tx) => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord');

// Within a purchase the reader's retained read and the SDK's receipt re-read
// share the anchor's short-lived proof cache, so the re-read reaches the node
// only when that entry lapses in between (IMMUTABLE_READBACK_TTL_MS). While
// `lapse` is set, the cache lookup in the anchor's verifyReceipt sees the clock
// one TTL later, as it would at that boundary; nothing else sees a changed clock.
const realNow = Date.now;
let lapse = false;
Date.now = function now() {
  const at = realNow.call(Date);
  if (!lapse) return at;
  const stack = new Error().stack ?? '';
  return /immutable-readbacks\.mjs:/.test(stack) && /verifyReceipt \(file:[^)]*\/devnet-demo\/artifact-anchor\.mjs:/.test(stack) ? at + IMMUTABLE_READBACK_TTL_MS : at;
};

// Answers 503 to the Nth getTxByHash for the commitment CREATE, counted from arm().
function faults() {
  let h = null, armed = false, n = 0, failAt = 0;
  return {
    bind(harness) { h = harness; },
    arm(at) { armed = true; n = 0; failAt = at; },
    disarm() { armed = false; },
    seen: () => n,
    hook: (body) => {
      if (!armed || !h) return undefined;
      const call = body?.params?.[0], [commitment] = commitmentTxs(h);
      if (call?.message !== 'getTxByHash' || !commitment || call.data?.hash !== commitment.hash) return undefined;
      n += 1;
      return n === failAt ? { result: 503, response: null, require_reply: false, extra: null } : undefined;
    },
  };
}

async function start(t, f, commitOnSignature) {
  const h = await startDevnetLiveCompositionApp({ commitOnSignature, rpcOverride: f.hook });
  f.bind(h);
  t.after(async () => { await h.sellerTiming.waitForIdle({ timeoutMs: 60000 }).catch(() => {}); await h.close(); });
  globalThis.location = new URL(h.origin); globalThis.window ??= globalThis; globalThis.document ??= { baseURI: `${h.origin}/portal/assets/embedded-wallet/`, currentScript: null };
  return h;
}

// Prepares, plans and signs one native Agreement; approve() runs the wallet
// CREATE and with it the buyer's first commitment readback.
async function sign(t, h) {
  let client;
  const buyerActor = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin)) }); t.after(() => buyerActor.close());
  const wallet = buyerActor.walletFactory({ anchorJournal: { get: (key) => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) } });
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const signMessage = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  h.authenticationRegistry.set(h.sellerActor.signer.claim, createSellerTransportClientAuth({ buyerSigner: { claim: buyerActor.signer.claim, sign: (bytes) => buyerActor.signer.signBytes(bytes) }, seller: h.sellerActor.signer.claim, resolveJob: (jobId) => h.jobContexts.get(jobId) }));
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: h.composition.listing.listingId, version: 1, seller: h.sellerActor.signer.claim, idempotencyKey: `proof-indeterminate-${Date.now()}-${Math.random()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl), api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const answer = await post(`${h.origin}${path}`, body, h.origin); if (answer.httpStatus !== 200) throw Object.assign(new Error(answer.message), { code: answer.error }); return answer; } });
  const account = h.app.services.accounts.walletOwner(address), operation = () => h.app.services.ops.get(account, id);
  const identity = await api('agreement/identity', { address }), planned = await api('agreement/plan', { signature: await signMessage(identity.signRequest.message) });
  assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  h.jobContexts.set(operation().terms.protocol.jobId, { listingPin: planned.signRequest.summary.listing, agreementHash: planned.signRequest.agreementHash });
  await client.authenticate({ address, sign: signMessage });
  const signed = await api('agreement/sign', { agreementSignature: await signMessage(planned.signRequest.agreementMessage) });
  assert.equal(signed.httpStatus, 200, JSON.stringify(signed));
  return { operation, approve: () => client.approveOne(wallet), verify: () => tool(h, buyer, 'verify_deal', { operationId: id }) };
}

// The composition's own anchor, with the SDK's receipt re-read and the retained
// read replaceable. The capability is built the way composition.mjs builds it.
function capabilityOver(h, { verifyReceipt, readRetained } = {}) {
  const real = h.composition.anchor, calls = { verifyReceipt: 0, readRetained: [] };
  const anchor = {
    authority: real.authority,
    readRetained: async (input) => { const read = await real.readRetained(input); calls.readRetained.push(read.status); return readRetained ? readRetained(read) : read; },
    verifyReceipt: async (input) => { calls.verifyReceipt += 1; return verifyReceipt ? verifyReceipt(input, real) : real.verifyReceipt(input); },
  };
  return { capability: createDevnetNativeCommitmentCapability({ authority: h.composition.authority, anchor }), calls };
}

for (const commitOnSignature of [false, true]) {
  const mode = `DACS_COMMIT_ON_SIGNATURE=${commitOnSignature ? 'on' : 'off'}`;

  test(`${mode}: an unestablished receipt re-read leaves the commitment indeterminate; an authenticated contradiction is still rejected`, { timeout: 600000 }, async (t) => {
    const f = faults(), h = await start(t, f, commitOnSignature), a = await sign(t, h);
    assert.equal((await a.approve()).state, 'completed');
    await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
    assert.equal((await a.verify()).status, 'awaiting_approval');
    const p = a.operation().state.protocol, scope = { agreement: p.agreement.artifact, listing: p.listing, fresh: true };
    const read = (capability) => readDevnetNativeCommitment(capability, scope);

    const control = capabilityOver(h);
    const verified = await read(control.capability);
    assert.equal(verified.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.contentHash, p.commitment.contentHash);
    assert.deepEqual(control.calls, { verifyReceipt: 1, readRetained: ['present'] });

    // The commitment and its receipt authenticate on the retained read; only the
    // SDK's own receipt re-read is not established.
    const cases = {
      'returns indeterminate': () => 'indeterminate',
      'returns error': () => 'error',
      'throws a transport error': () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1 (connection fence refused)'), { code: 'ECONNREFUSED' }); },
      'answers after a node 503': async (input, real) => { f.arm(1); try { return await real.verifyReceipt(input); } finally { f.disarm(); } },
    };
    for (const [label, verifyReceipt] of Object.entries(cases)) {
      const { capability, calls } = capabilityOver(h, { verifyReceipt });
      const result = await read(capability);
      assert.equal(result.status, 'indeterminate', `receipt re-read ${label}: ${JSON.stringify(result)}`);
      assert.match(result.reason, /commitment receipt proof/, label);
      assert.deepEqual(calls, { verifyReceipt: 1, readRetained: ['present'] }, label);
    }

    // Authenticated contradictions stay rejected: the anchor answers the receipt
    // proof invalid (it does only for a seller-signed contradiction), or the
    // commitment's signature does not verify (the SDK's CounterpartyError).
    const invalidProof = capabilityOver(h, { verifyReceipt: () => 'invalid' });
    const invalid = await read(invalidProof.capability);
    assert.equal(invalid.status, 'rejected', JSON.stringify(invalid));
    assert.match(invalid.reason, /commitment receipt proof is invalid/);
    const forged = capabilityOver(h, { readRetained: (r) => {
      const artifact = structuredClone(r.artifact), value = artifact.signature.value;
      artifact.signature.value = `${value.slice(0, 10)}${value[10] === 'a' ? 'b' : 'a'}${value.slice(11)}`;
      return { ...r, artifact };
    } });
    const contradicted = await read(forged.capability);
    assert.equal(contradicted.status, 'rejected', JSON.stringify(contradicted));
    assert.match(contradicted.reason, /signature is not verified \(invalid\)/);

    // A node 503 at each commitment read of a fresh readback, on the composed
    // capability: never a rejection. A failure before the reader's own catch
    // (the retained read) still throws as before.
    f.arm(0); assert.equal((await read(h.composition.nativeSellerCommitment)).status, 'verified'); const total = f.seen(); f.disarm();
    assert.ok(total >= 2, `the readback reads the commitment transaction (${total})`);
    const results = [];
    for (let at = 1; at <= total; at++) {
      f.arm(at);
      let r; try { r = await read(h.composition.nativeSellerCommitment); } catch (error) { r = { status: `threw ${error?.code ?? error?.name}`, reason: error?.message }; }
      f.disarm();
      results.push(`#${at}/${total}: ${r.status} (${String(r.reason ?? '').slice(0, 90)})`);
    }
    assert.ok(results.every((line) => !/: rejected /.test(line)), results.join('\n'));
    assert.match(results.at(-1), /: indeterminate \(commitment receipt proof is not established/, results.join('\n'));
    assert.equal((await read(h.composition.nativeSellerCommitment)).status, 'verified');
  });

  test(`${mode}: a node 503 at any commitment read of the buyer's readback, with the proof cache lapsing, never ends the purchase; a clean read completes it`, { timeout: 900000 }, async (t) => {
    t.after(() => { lapse = false; });
    const outcomes = [];
    let hitReader = false;
    for (let at = 1; at <= 24; at++) {
      const f = faults(), h = await start(t, f, commitOnSignature), a = await sign(t, h);
      // Faulted: the wallet CREATE with the buyer's first commitment readback
      // (continueSellerSr2Commitment), then one verify_deal.
      f.arm(at); lapse = true;
      let approved; try { approved = (await a.approve()).state; } catch (error) { approved = `threw ${error?.code ?? error?.message}`; }
      await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
      const answer = await a.verify(), faulted = answer.status ?? `error ${answer.error ?? answer.code ?? JSON.stringify(answer).slice(0, 80)}`;
      await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
      f.disarm(); lapse = false;
      const seen = f.seen(), op = a.operation(), attempts = op.state.protocol.attempts;
      const commitmentOutcomes = attempts.filter((x) => x.step === 'commitment').map((x) => x.outcome);
      if (commitmentOutcomes.includes('indeterminate')) {
        hitReader = true;
        // Ops health classifies the recorded attempt (an unknown pair fails closed).
        const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
        assert.ok(report.purchases.some((row) => row.purchaseId === op.id), JSON.stringify(report.purchases.map((row) => row.purchaseId)));
      }
      outcomes.push(`fail #${at} of ${seen}: approve ${approved}, verify ${faulted}, now ${op.status}; commitment ${commitmentOutcomes.join(',') || '-'}`);
      assert.notEqual(op.status, 'agreement_rejected', outcomes.join('\n'));
      assert.ok(!attempts.some((x) => x.outcome === 'rejected'), `${outcomes.at(-1)}\n${JSON.stringify(attempts.filter((x) => x.outcome === 'rejected'))}`);
      // Clean: readback only completes it.
      let status = op.status;
      for (let i = 0; i < 3 && status !== 'awaiting_approval'; i++) { status = (await a.verify()).status; await h.sellerTiming.waitForIdle({ timeoutMs: 60000 }); }
      const done = a.operation();
      assert.equal(done.status, 'awaiting_approval', `${outcomes.at(-1)}\n${JSON.stringify(done.state.protocol.attempts.slice(-4))}`);
      assert.equal(done.state.protocol.attempts.filter((x) => x.step === 'commitment').at(-1).outcome, 'verified');
      assert.match(done.state.protocol.commitment?.contentHash ?? '', /^[0-9a-f]{64}$/);
      assert.equal(commitmentTxs(h).length, 1, 'the seller wrote exactly one commitment');
      if (seen < at) break;
    }
    t.diagnostic(`scan:\n${outcomes.join('\n')}`);
    assert.ok(hitReader, `some position reached the reader's receipt re-read:\n${outcomes.join('\n')}`);
  });
}
