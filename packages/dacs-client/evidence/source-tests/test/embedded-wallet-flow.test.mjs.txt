// Embedded wallet FLOW acceptance (Node): built-in fixed-price payment and
// GitHub/Twitter identity add/remove. Clauses and tiers:
// docs/EMBEDDED-WALLET-FLOW-COVERAGE.md.
//
//  - F1-F3 are fixture/SDK controls (tier W+S). They prove the loopback chain,
//    real SDK signing and server readback. They do NOT prove the embedded wallet.
//  - P0 checks the default-off profile. P1-P6 and I1-I3 drive
//    createSdkWalletSession through the server's same-origin wallet relay
//    with the plain-object simulated-loopback transport, per core's
//    PRELIMINARY public contract (evidence/CORE-INTERFACE-PRELIMINARY.md).
//    On the frozen baseline the session refuses every write, so these FAIL
//    until the core implementation is integrated. That is the expected
//    baseline result, not a harness defect.
// All traffic is loopback (a guard refuses any other host before DNS). Keys
// are fresh and RAM-only. SIMULATED evidence only: not live testnet, not a
// security review.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, seedSellerListing, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import {
  CORE_INTERFACE, PROFILE, installLoopbackOnlyGuard, loadInstalledSdk, createSdkWallet, startSdkChainFixture, startGithubApiFixture,
  fetchProfile, transportFromProfile, linkWalletViaPortal, portalPost, portalFindHash,
} from './helpers/embedded-wallet-flow-fixtures.mjs';

const externalAttempts = installLoopbackOnlyGuard();
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(`${reason?.name ?? 'Error'}: ${reason?.message ?? String(reason)}`));

// A missing SDK install fails every test that needs it (never a silent skip).
const sdkResult = await loadInstalledSdk().then((sdk) => ({ sdk }), (error) => ({ error }));
const need = () => {
  if (sdkResult.error) throw sdkResult.error;
  return sdkResult.sdk;
};

// start_wallet_link needs dacs.purchases.write (or agents.write) besides the identity grant.
const WRITE = 'dacs.account.read dacs.purchases.write dacs.identities.write';
const key = (label) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const strip = (h) => String(h ?? '').toLowerCase().replace(/^0x/, '');
const { codes } = CORE_INTERFACE;

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function chainAndHarness(env = {}) {
  const chain = await startSdkChainFixture();
  const h = await startHarness({ chain, env });
  cleanups.push(() => h.close());
  return { chain, h };
}

// Embedded-session topology per the core contract: session -> same-origin
// relay (/portal/api/wallet-rpc, real plugin server) -> loopback fixture
// chain; GitHub lookups -> relay github-user -> loopback GitHub API fixture.
async function relayHarness() {
  const github = await startGithubApiFixture();
  cleanups.push(() => github.close());
  const { chain, h } = await chainAndHarness(CORE_INTERFACE.enableEnv({ githubApiOrigin: github.origin }));
  const profile = await fetchProfile(h);
  assert.equal(profile.writes, PROFILE, 'precondition: the simulated loopback profile is enabled');
  assert.equal(profile.evidenceMode, 'simulated-fixture');
  return { chain, h, github, profile, transport: transportFromProfile(h, profile) };
}

function recordingApprove(decide = () => true) {
  const requests = [];
  const approve = async (request) => {
    requests.push(JSON.stringify(request));
    return decide(request);
  };
  return { approve, requests };
}

function flowSession(sdk, extra = {}) {
  return createSdkWalletSession({ DemosCtor: sdk.Demos, IdentitiesCtor: sdk.Identities, validateMnemonic: sdk.validateMnemonic, ...extra });
}

// A transfer payload exactly as the server builds it (from, to, amount, nonce).
function payloadFor(chain, from, to, amountOs = '1000000000') {
  return buildNativeTransferPayload({ from, to, amountOs, nonce: chain.nonceOf(from) + 1, timestamp: Date.now(), encoding: 'os-string' });
}

function identityPortal(h, start) {
  const url = new URL(start.portalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  return { id, call: (step, body = {}) => portalPost(h, `/portal/api/identity/${id}/${step}`, { token, ...body }) };
}

// ---------------------------------------------------------------- controls

test('F1 [W+S control] real SDK pay -> confirm -> broadcast over loopback: fixture verifies hash and signature, one broadcast, post-fork wire', async () => {
  const sdk = need();
  const chain = await startSdkChainFixture();
  try {
    const payer = await createSdkWallet(sdk, { rpcUrl: chain.url });
    const payee = await createSdkWallet(sdk);
    const signed = await payer.demos.pay(payee.address, 2_500_000_000n, { nonce: 1 });
    assert.equal(signed.content.type, 'native');
    assert.equal(strip(signed.content.from), strip(payer.address));
    assert.equal(signed.content.to, payee.address);
    assert.equal(signed.content.amount, '2500000000', 'post-fork OS decimal string');
    assert.deepEqual(signed.content.data, ['native', { nativeOperation: 'send', args: [payee.address, '2500000000'] }]);
    assert.equal(signed.content.nonce, 1);

    // Witness: the fixture's independent check is not vacuous. A post-signing
    // amount change must be refused at confirm.
    const tampered = structuredClone(signed);
    tampered.content.amount = '1';
    await assert.rejects(payer.demos.confirm(tampered), /not valid/);
    assert.equal(chain.record.rejections.at(-1), 'hash is not sha256 of the serialized content');

    const validity = await payer.demos.confirm(signed);
    assert.equal(validity.response.data.valid, true);
    const res = await payer.demos.broadcast(validity);
    assert.equal(res.result, 200);
    assert.deepEqual(chain.record.broadcastAttempts, [signed.hash], 'exactly one broadcast');
    assert.equal(chain.nonceOf(payer.address), 1);
    assert.deepEqual(externalAttempts, []);
  } finally {
    await chain.close();
  }
});

test('F2 [W+S control] server readback: SDK wallet linked and approving via the portal; SDK signs the exact server payload; settled_verified receipt survives restart', async () => {
  const sdk = need();
  const { chain, h } = await chainAndHarness();
  const seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'flow-f2', price: '2.5' });
  const buyer = await linkedUser(h);
  const wallet = await createSdkWallet(sdk, { rpcUrl: chain.url });
  await linkWalletViaPortal(h, (await tool(h, buyer, 'start_wallet_link')).linkUrl, wallet);

  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: 'flow-f2', version: 1, seller: seller.claim, idempotencyKey: key('f2'), walletAddress: wallet.address });
  assert.equal(prepared.status, 'awaiting_approval');
  const id = prepared.operationId;
  const token = tokenFrom(prepared.approvalUrl);
  const challenge = await portalPost(h, `/portal/api/purchase/${id}/challenge`, { token, address: wallet.address });
  assert.equal(challenge.httpStatus, 200);
  const approved = await portalPost(h, `/portal/api/purchase/${id}/approve`, { token, challengeId: challenge.challengeId, signature: await wallet.signHex(challenge.message) });
  assert.equal(approved.status, 'payment_handoff');
  const { content } = approved.payload;
  assert.equal(content.amount, '2500000000');

  const signed = await wallet.demos.pay(content.to, BigInt(content.amount), { nonce: content.nonce });
  await wallet.demos.broadcast(await wallet.demos.confirm(signed));
  const reported = await portalPost(h, `/portal/api/purchase/${id}/report`, { token, txHash: signed.hash });
  assert.equal(reported.status, 'settled_verified');
  assert.equal(reported.verification.outcome, 'verified');
  const receipt = reported.evidence.receipt;
  assert.equal(receipt.txHash, signed.hash);
  assert.equal(receipt.amountOs, '2500000000');
  assert.equal(receipt.chainMode, 'simulated-fixture');
  assert.equal(reported.evidence.simulated, true);
  assert.deepEqual(chain.record.applied.map((a) => [a.from, a.to, a.amount, a.nonce]), [[wallet.address, content.to, '2500000000', content.nonce]]);

  await h.restart();
  const status = await tool(h, buyer, 'get_purchase_status', { operationId: id });
  assert.equal(status.status, 'settled_verified', 'the receipt is persisted');
  assertNoSecrets([...h.logs, reported], [wallet.secretProbe()], 'server logs and portal response');
  assert.deepEqual(externalAttempts, []);
});

test('F3 [W+S control] identity: SDK Identities add then remove GitHub over loopback; the server observes the exact wallet and handle with no external call', async () => {
  const sdk = need();
  const { chain, h } = await chainAndHarness({ DACS_IDENTITY_WRITES: 'simulated-fixture-only' });
  const user = await linkedUser(h, WRITE);
  const wallet = await createSdkWallet(sdk, { rpcUrl: chain.url });
  await linkWalletViaPortal(h, (await tool(h, user, 'start_wallet_link')).linkUrl, wallet);
  const ids = new sdk.Identities();
  const proofUrl = 'https://gist.github.com/flow-octo/0123456789abcdef';

  const add = identityPortal(h, await tool(h, user, 'start_identity_action', { idempotencyKey: key('f3a'), action: 'add', kind: 'github', walletAddress: wallet.address }));
  assert.equal((await add.call('view')).status, 'awaiting_wallet');
  assert.equal((await add.call('connected', { address: wallet.address })).status, 'awaiting_public_proof');
  assert.equal((await add.call('proof', { proofUrl })).status, 'review');
  const asked = await add.call('request');
  assert.deepEqual(asked.walletRequest, { method: 'addGithubIdentity', params: [proofUrl] });
  // The same payload SDK addGithubIdentity builds, minus its api.github.com
  // lookup: userId is a SIMULATED value.
  const v1 = await ids.inferWeb2Identity(wallet.demos, { context: 'github', proof: proofUrl, username: 'flow-octo', userId: 'simulated-1' }, { nonce: chain.nonceOf(wallet.address) + 1 });
  await wallet.demos.broadcast(v1);
  assert.equal((await add.call('report', { outcome: { success: true } })).status, 'association_observed');

  const rm = identityPortal(h, await tool(h, user, 'start_identity_action', { idempotencyKey: key('f3r'), action: 'remove', kind: 'github', username: 'flow-octo', walletAddress: wallet.address }));
  await rm.call('view');
  assert.equal((await rm.call('connected', { address: wallet.address })).status, 'review');
  const askedRm = await rm.call('request');
  assert.deepEqual(askedRm.walletRequest, { method: 'removeWeb2Identity', params: [{ context: 'github', username: 'flow-octo' }] });
  await wallet.demos.broadcast(await ids.removeWeb2Identity(wallet.demos, askedRm.walletRequest.params[0], { nonce: chain.nonceOf(wallet.address) + 1 }));
  assert.equal((await rm.call('report', { outcome: { success: true } })).status, 'removal_observed');
  assert.deepEqual(chain.record.applied.map((a) => a.type), ['identity', 'identity']);
  assert.deepEqual(externalAttempts, []);
});

test('F4 [witness for P6] the SDK default broadcast path resends after a lost 503 answer: the P6 no-resend assertion catches that implementation', async () => {
  const sdk = need();
  const chain = await startSdkChainFixture();
  try {
    const payer = await createSdkWallet(sdk, { rpcUrl: chain.url });
    const signed = await payer.demos.pay(createEphemeralWallet().address, 1_000_000_000n, { nonce: 1 });
    const validity = await payer.demos.confirm(signed);
    chain.faults.broadcastMode = 'apply-then-503';
    await payer.demos.broadcast(validity);
    assert.equal(chain.record.applied.length, 1);
    assert.ok(chain.record.broadcastAttempts.length > 1, 'SDK _doPost retried the broadcast (a wrong implementation for P6)');
  } finally {
    await chain.close();
  }
});

// ------------------------------------------------- embedded wallet: payment

test('P1 [S] embedded sendTransaction: exact terms approved, one broadcast of the SDK-signed server payload, findHash-compatible result, settled_verified receipt', async () => {
  const sdk = need();
  const { chain, h, profile, transport } = await relayHarness();
  const seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'flow-p1', price: '3' });
  const buyer = await linkedUser(h);
  const rec = recordingApprove();
  const session = flowSession(sdk, { approve: rec.approve, transactionTransport: transport });
  const { address, network, evidenceMode } = await session.create();
  assert.deepEqual([network, evidenceMode], [profile.network, 'simulated-fixture'], 'public account reflects the simulated transport');
  const signHex = async (message) => (await session.request({ method: 'sign', params: [message] })).data.signature;
  await linkWalletViaPortal(h, (await tool(h, buyer, 'start_wallet_link')).linkUrl, { address, signHex });

  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: 'flow-p1', version: 1, seller: seller.claim, idempotencyKey: key('p1'), walletAddress: address });
  const id = prepared.operationId;
  const token = tokenFrom(prepared.approvalUrl);
  const challenge = await portalPost(h, `/portal/api/purchase/${id}/challenge`, { token, address });
  const approved = await portalPost(h, `/portal/api/purchase/${id}/approve`, { token, challengeId: challenge.challengeId, signature: await signHex(challenge.message) });
  assert.equal(approved.status, 'payment_handoff');
  const { content } = approved.payload;

  // Same request shape as public/portal/portal.js walletSend.
  const res = await session.request({ method: 'sendTransaction', params: [approved.payload] });
  assert.equal(res.success, true, `sendTransaction must succeed once core is integrated (baseline: ${res.error?.code}: ${res.error?.message})`);
  const shown = rec.requests.find((r) => r.includes('sendTransaction'));
  assert.ok(shown, 'a sendTransaction approval was requested');
  for (const term of [content.to, content.amount, String(content.nonce), address]) assert.ok(shown.includes(term), `approval shows the exact term ${term}`);
  assert.equal(chain.record.confirms.length, 1);
  assert.equal(chain.record.broadcastAttempts.length, 1, 'exactly one broadcast');
  const [applied] = chain.record.applied;
  assert.deepEqual([applied.from, applied.to, applied.amount, applied.nonce], [address, content.to, content.amount, content.nonce], 'signed content equals the approved terms');
  assert.equal(strip(portalFindHash(res)), applied.hash, 'portal findHash reads the broadcast hash');

  const reported = await portalPost(h, `/portal/api/purchase/${id}/report`, { token, txHash: portalFindHash(res) });
  assert.equal(reported.status, 'settled_verified');
  assert.equal(reported.evidence.receipt.txHash, applied.hash);
  assert.equal(reported.evidence.receipt.chainMode, 'simulated-fixture');
  assertNoSecrets([res, ...rec.requests, ...h.logs], [session.exportMnemonicForUser()], 'provider responses, approvals and server logs');
});

// transport: true -> through the real relay (relayHarness); false -> no
// transport and no plugin server at all (P4 observes zero chain traffic).
async function sessionWithPayload({ approveDecide, transport = true } = {}) {
  const sdk = need();
  let relay = null;
  let chain;
  if (transport) {
    relay = await relayHarness();
    chain = relay.chain;
  } else {
    chain = await startSdkChainFixture();
    cleanups.push(() => chain.close());
  }
  let session;
  const rec = recordingApprove((r) => approveDecide?.(r, session) ?? true);
  session = flowSession(sdk, { approve: rec.approve, ...(relay ? { transactionTransport: relay.transport } : {}) });
  const { address } = await session.create();
  const payee = createEphemeralWallet().address;
  return { chain, session, rec, address, relay, payload: payloadFor(chain, address, payee) };
}

test('P0 default off: without the flag the profile is off and the wallet relay does not answer', async () => {
  const { h } = await chainAndHarness();
  const profile = await fetchProfile(h);
  assert.equal(profile.httpStatus, 200);
  assert.equal(profile.writes, 'off');
  assert.equal((await fetch(`${h.origin}${CORE_INTERFACE.routes.rpc}`)).status, 404);
});

test('P2 embedded sendTransaction cancel: user_rejected after the approval prompt; nothing confirmed or broadcast', async () => {
  const { chain, session, rec, payload } = await sessionWithPayload({ approveDecide: (r) => !JSON.stringify(r).includes('sendTransaction') });
  const res = await session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(res.success, false);
  assert.equal(res.error?.code, codes.rejected);
  assert.ok(rec.requests.some((r) => r.includes('sendTransaction')), 'the person was actually asked');
  assert.deepEqual([chain.record.confirms, chain.record.broadcastAttempts], [[], []]);
});

test('P3 embedded sendTransaction lock during approval: locked; nothing confirmed or broadcast', async () => {
  const { chain, session, rec, payload } = await sessionWithPayload({ approveDecide: (_r, s) => { s.lock(); return true; } });
  const res = await session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(res.error?.code, codes.locked);
  assert.ok(rec.requests.some((r) => r.includes('sendTransaction')), 'the lock happened while the approval was pending');
  assert.deepEqual([chain.record.confirms, chain.record.broadcastAttempts], [[], []]);
});

test('P4 embedded sendTransaction without a configured transport: not_configured, no prompt, no network', async () => {
  const { chain, session, rec, payload } = await sessionWithPayload({ transport: false });
  const res = await session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(res.success, false);
  assert.equal(res.error?.code, codes.notConfigured);
  assert.deepEqual(rec.requests, []);
  assert.deepEqual(chain.record.rpc, []);
});

test('P5 embedded sendTransaction definite failure (confirm says invalid): a definite failure, not outcome_unknown; nothing broadcast', async () => {
  const { chain, session, payload } = await sessionWithPayload();
  chain.faults.broadcastMode = 'reject-confirm';
  const res = await session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(chain.record.confirms.length, 1, 'precondition: the signed transaction reached confirm');
  assert.equal(res.success, false);
  assert.notEqual(res.error?.code, codes.unknown);
  assert.equal(res.error?.code, codes.confirmRejected);
  assert.deepEqual(chain.record.broadcastAttempts, []);
});

test('P6 embedded sendTransaction outcome unknown (applied, answer lost): outcome_unknown and no automatic second broadcast', async () => {
  const { chain, session, payload } = await sessionWithPayload();
  chain.faults.broadcastMode = 'apply-then-503';
  const res = await session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(chain.record.applied.length, 1, 'precondition: the broadcast was applied by the fixture');
  assert.equal(res.success, false);
  assert.equal(res.error?.code, codes.unknown);
  assert.equal(strip(res.data?.hash), chain.record.applied[0].hash, 'the unknown outcome carries the hash for later verify_deal');
  // The fixture answers 503 after applying; the SDK's _doPost would retry a
  // 503 after 250 ms with backoff (F4). The contract's relay must not let it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(chain.record.broadcastAttempts.length, 1, 'no automatic resend after an unknown outcome');
});

// ------------------------------------------------ embedded wallet: identity

test('I1 [S] embedded addGithubIdentity and addTwitterIdentity with the server params: exact action approved, one identity write each, association applied, no external host', async () => {
  const { chain, session, rec, address, relay } = await sessionWithPayload();
  const gh = 'https://gist.github.com/flow-gh/0123abcd';
  const resGh = await session.request({ method: 'addGithubIdentity', params: [gh] });
  assert.equal(resGh.success, true, `addGithubIdentity must succeed once core is integrated (baseline: ${resGh.error?.code})`);
  assert.ok(rec.requests.some((r) => r.includes('addGithubIdentity') && r.includes(gh) && r.includes(address) && r.includes('flow-gh')), 'approval shows the method, proof URL, resolved handle and wallet');
  assert.deepEqual(chain.web2Handles(address, 'github'), ['flow-gh']);
  assert.deepEqual(relay.transport.lookups, ['flow-gh'], 'GitHub user resolved once through the transport');
  assert.deepEqual(relay.github.requests, ['GET /\x75sers/flow-gh'], 'and answered by the loopback GitHub API fixture');

  const tw = 'https://x.com/flow_tw/status/1234567890';
  const resTw = await session.request({ method: 'addTwitterIdentity', params: [tw] });
  assert.equal(resTw.success, true);
  assert.ok(rec.requests.some((r) => r.includes('addTwitterIdentity') && r.includes(tw)));
  assert.deepEqual(chain.web2Handles(address, 'twitter'), ['flow_tw']);
  assert.equal(chain.record.applied.length, 2, 'one identity write per approved action');
  assert.deepEqual(externalAttempts, [], 'no GitHub or X API was contacted');
});

test('I2 [S] embedded removeWeb2Identity with the server params: exact context and handle approved, association removed', async () => {
  const { chain, session, rec, address } = await sessionWithPayload();
  chain.seedWeb2Identity(address, 'github', { username: 'flow-rm', userId: 'simulated-2', proof: 'https://gist.github.com/flow-rm/1' });
  const res = await session.request({ method: 'removeWeb2Identity', params: [{ context: 'github', username: 'flow-rm' }] });
  assert.equal(res.success, true, `removeWeb2Identity must succeed once core is integrated (baseline: ${res.error?.code})`);
  assert.ok(rec.requests.some((r) => r.includes('removeWeb2Identity') && r.includes('flow-rm') && r.includes('github')));
  assert.deepEqual(chain.web2Handles(address, 'github'), []);
  assert.equal(chain.record.applied.length, 1);
});

test('I3 embedded identity cancel: user_rejected after the prompt; nothing written', async () => {
  const { chain, session, rec } = await sessionWithPayload({ approveDecide: (r) => !JSON.stringify(r).includes('addGithubIdentity') });
  const res = await session.request({ method: 'addGithubIdentity', params: ['https://gist.github.com/flow-no/1'] });
  assert.equal(res.error?.code, codes.rejected);
  assert.ok(rec.requests.some((r) => r.includes('addGithubIdentity')), 'the person was actually asked');
  assert.deepEqual([chain.record.confirms, chain.record.applied], [[], []]);
});

test('no external connection and no unhandled rejection in this file', () => {
  assert.deepEqual(externalAttempts, []);
  assert.deepEqual(unhandled, []);
});
