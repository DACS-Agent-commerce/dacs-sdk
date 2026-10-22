// the source change harness: node answers that parse but do not authenticate, at the buyer's
// commitment readback (both reads: the anchor's first read and the SDK's
// receipt re-read) and at the Agreement receipt check. A purchase ends at
// agreement_rejected only on an authenticated contradiction; these answers
// must leave it agreement_pending, completed by a clean readback.
import assert from 'node:assert/strict';
import { contentHash, FINALITY_COMMITMENT_SEPARATOR, finalityCommitmentAddress, signedBytes } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionApp } from './devnet-live-composition-app.mjs';
import { createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './flows.mjs';
import { post } from './public-sr2-projection-flow.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';
import { createSellerTransportClientAuth } from '../../src/dacs/seller-transport-auth.mjs';
import { createDevnetNativeCommitmentCapability } from '../../src/devnet-demo/commitment-consumer.mjs';
import { IMMUTABLE_READBACK_TTL_MS } from '../../src/util/immutable-readbacks.mjs';

export const JUNK_KINDS = ['block-not-found', 'block-pending', 'tx-without-content', 'tx-corrupt-signature', 'native-metadata'];
export const createsOf = (h, artifactKind) => h.transport.chain.wire.record.accepted.filter((tx) => tx.content.data[1].metadata.artifactKind === artifactKind);

// Every proof-cache lookup lapses while `cold` is set, as for a readback more
// than one TTL after the last verified read: both reads reach the node.
const realNow = Date.now;
let cold = false;
Date.now = function now() {
  const at = realNow.call(Date);
  if (!cold) return at;
  return /\bget \(file:[^)]*immutable-readbacks\.mjs:/.test(new Error().stack ?? '') ? at + IMMUTABLE_READBACK_TTL_MS : at;
};
export const setCold = (value) => { cold = value; };

// Answers the Nth node read of the `artifactKind` CREATE's transaction, block
// or native program (by `kind`) with junk that parses but does not authenticate.
export function junkFaults(kind, artifactKind = 'FinalityCommitmentRecord') {
  let h = null, armed = false, n = 0, failAt = 0;
  const upstream = async (body, url) => (await (await fetch(`${h.transport.chain.url}${url}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());
  const f = {
    setKind(value) { kind = value; },
    bind(harness) { h = harness; },
    arm(at) { armed = true; n = 0; failAt = at; },
    disarm() { armed = false; },
    seen: () => n,
    hook: async (body, url) => {
      const call = body?.params?.[0];
      if (!armed || !h) return undefined;
      const [target] = createsOf(h, artifactKind);
      if (!target) return undefined;
      const match = kind.startsWith('block-') ? call?.message === 'getBlockByNumber' && Number(call.data?.blockNumber) === h.transport.chain.inclusion.numberFor(target.hash)
        : kind.startsWith('tx-') ? call?.message === 'getTxByHash' && call.data?.hash === target.hash
          : url === `/storage-program/${target.content.to}`;
      if (!match || (n += 1) !== failAt) return undefined;
      if (kind === 'block-not-found') return { result: 200, response: null, require_reply: false, extra: null };
      if (kind === 'native-metadata') { const real = await upstream(undefined, url); return { ...real, metadata: { ...real.metadata, artifactKind: 'Listing' } }; }
      const real = await upstream(body, '/');
      if (kind === 'block-pending') return { ...real, response: { ...real.response, status: 'pending' } };
      if (kind === 'tx-without-content') { const { content, ...rest } = real.response; return { ...real, response: rest }; }
      if (kind === 'tx-corrupt-signature') { const data = real.response.signature.data; return { ...real, response: { ...real.response, signature: { ...real.response.signature, data: `${data.slice(0, -2)}${data.endsWith('00') ? '11' : '00'}` } } }; }
      throw new Error(`unknown junk kind ${kind}`);
    },
  };
  return f;
}

export async function start(t, f, commitOnSignature) {
  const h = await startDevnetLiveCompositionApp({ commitOnSignature, rpcOverride: f.hook });
  f.bind(h);
  t.after(async () => { await h.sellerTiming.waitForIdle({ timeoutMs: 60000 }).catch(() => {}); await h.close(); });
  globalThis.location = new URL(h.origin); globalThis.window ??= globalThis; globalThis.document ??= { baseURI: `${h.origin}/portal/assets/embedded-wallet/`, currentScript: null };
  return h;
}

// Prepares, plans and signs one native Agreement (as the the source change commitment test
// does); approve() runs the wallet CREATE and the buyer's first readback.
export async function sign(t, h) {
  let client;
  const buyerActor = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin)) }); t.after(() => buyerActor.close());
  const wallet = buyerActor.walletFactory({ anchorJournal: { get: (key) => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) } });
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const signMessage = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  h.authenticationRegistry.set(h.sellerActor.signer.claim, createSellerTransportClientAuth({ buyerSigner: { claim: buyerActor.signer.claim, sign: (bytes) => buyerActor.signer.signBytes(bytes) }, seller: h.sellerActor.signer.claim, resolveJob: (jobId) => h.jobContexts.get(jobId) }));
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: h.composition.listing.listingId, version: 1, seller: h.sellerActor.signer.claim, idempotencyKey: `node-junk-${Date.now()}-${Math.random()}`, protocol: 'dacs-sr2-wallet-agreement' });
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

// The composition's own anchor with the retained read or the SDK's receipt
// re-read replaceable, built the way composition.mjs builds the capability.
export function capabilityOver(h, { verifyReceipt, readRetained } = {}) {
  const real = h.composition.anchor;
  const anchor = {
    authority: real.authority,
    readRetained: async (input) => { const read = await real.readRetained(input); return readRetained ? readRetained(read) : read; },
    verifyReceipt: async (input) => (verifyReceipt ? verifyReceipt(input, real) : real.verifyReceipt(input)),
  };
  return createDevnetNativeCommitmentCapability({ authority: h.composition.authority, anchor });
}

// One purchase: junk at the Nth matching read over approve plus one
// verify_deal, all with a cold proof cache. Neither call may fail: the junk
// is recorded as an attempt, never thrown (final review, finding 1). Returns
// what the purchase recorded.
export async function junkPurchase(t, { kind, commitOnSignature, at, artifactKind = 'FinalityCommitmentRecord' }) {
  const f = junkFaults(kind, artifactKind), h = await start(t, f, commitOnSignature), a = await sign(t, h);
  f.arm(at); setCold(true);
  let approved, answer;
  try {
    approved = (await a.approve()).state;
    await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
    answer = await a.verify();
    await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  } finally { f.disarm(); setCold(false); }
  const verified = answer.status;
  assert.equal(typeof verified, 'string', `${kind} #${at}: verify_deal failed: ${JSON.stringify(answer).slice(0, 240)}`);
  const op = a.operation(), attempts = op.state.protocol.attempts;
  const steps = attempts.filter((x) => ['agreement', 'commitment', 'commit-request'].includes(x.step)).map((x) => `${x.step}/${x.outcome}${x.outcome === 'verified' || x.outcome === 'anchored' ? '' : ` (${String(x.reason ?? '').slice(0, 80)})`}`);
  return { h, a, seen: f.seen(), op, attempts, line: `${kind} #${at} of ${f.seen()}: approve ${approved}, verify ${verified}, now ${op.status}; ${steps.join(' | ') || '-'}` };
}

// After the junk: never rejected, and readback alone completes the purchase
// with exactly one commitment CREATE.
export async function assertPendingThenCompletes(r, lines) {
  assert.notEqual(r.op.status, 'agreement_rejected', lines.join('\n'));
  assert.ok(!r.attempts.some((x) => x.outcome === 'rejected'), `${r.line}\n${JSON.stringify(r.attempts.filter((x) => x.outcome === 'rejected'))}`);
  let status = r.op.status;
  for (let i = 0; i < 4 && status !== 'awaiting_approval'; i++) { status = (await r.a.verify()).status; await r.h.sellerTiming.waitForIdle({ timeoutMs: 60000 }); }
  const done = r.a.operation();
  assert.equal(done.status, 'awaiting_approval', `${r.line}\n${JSON.stringify(done.state.protocol.attempts.slice(-4))}`);
  assert.equal(done.state.protocol.attempts.filter((x) => x.step === 'commitment').at(-1).outcome, 'verified');
  assert.equal(createsOf(r.h, 'FinalityCommitmentRecord').length, 1, 'the seller wrote exactly one commitment');
}

// A commitment the seller really signed, at the job's canonical address, that
// binds other session content (CA-3/CA-7; by default another Agreement): an
// authenticated contradiction. (The seller's packaged wallet refuses to anchor
// a commitment whose own signature does not verify, so this is the
// contradiction a seller can actually publish.) The test publishes it through
// the seller's own anchor before the seller commits.
export const anotherAgreement = (unsigned, agreement) => ({ ...unsigned, agreementHash: contentHash({ ...agreement, jobId: `${agreement.jobId}-other` }) });
export function contradictingCommitmentPublisher(h, mutate = anotherAgreement) {
  return async (agreement) => {
    const seller = agreement.parties.find((p) => p.role === 'seller').primaryClaim, buyer = agreement.parties.find((p) => p.role === 'buyer').primaryClaim;
    assert.equal(seller, h.sellerActor.signer.claim);
    const unsigned = mutate({ finalityCommitmentVersion: '1', jobId: agreement.jobId, agreementHash: contentHash(agreement), listingRef: { ...agreement.listingRef },
      parties: [buyer, seller], pattern: 'fixed-price', createdAt: Date.now() }, agreement);
    const value = Buffer.from(h.sellerActor.signer.signBytes(signedBytes(FINALITY_COMMITMENT_SEPARATOR, contentHash(unsigned)))).toString('base64url');
    const record = { ...unsigned, signature: { algorithm: 'ed25519', signer: seller, value } };
    const out = await h.composition.anchor.publish({ logicalAddress: finalityCommitmentAddress(agreement.jobId), artifact: record, artifactKind: 'FinalityCommitmentRecord' });
    assert.equal(out.status, 'present', JSON.stringify(out));
  };
}
