// Overnight ORDINARY functional acceptance of core's publication stages,
// handoff-scoped re-check route and embedded-wallet profiles, through the
// public portal HTTP API and config loader. SIMULATED fixtures only;
// source-aware; NOT a security review, NOT live, NOT v0.1 acceptance.
//
// Expected values come from core's published interface (publication stage
// mapping table, profile endpoint shapes, held-profile config rules) and
// docs/OVERNIGHT-CORE.md, not from core's tests. The seller "wallet" is the
// SIMULATED test key of the source harness. The held-profile checks are
// config/endpoint level only: the https RPC host is a reserved .invalid name
// and no tool that would read it is called.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, portal, tokenFrom } from './helpers/flows.mjs';
import { summaryFor } from './fixtures/listings.mjs';
import { loadConfig } from '../src/config.mjs';
import { agentInput, unique } from './helpers/overnight-acceptance-flows.mjs';

const harnesses = [];
async function harness(env) {
  const h = await startHarness({ env });
  harnesses.push(h);
  return h;
}
after(async () => {
  for (const h of harnesses) await h.close();
});

const post = async (h, path, body = {}) => {
  const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { http: res.status, json };
};
const STAGE_IDS = ['identity_signature', 'listing_signature', 'storage_write', 'chain_readback', 'directory_submission', 'directory_visibility'];
const stagesOf = (view) => Object.fromEntries((view.stages ?? []).map((s) => [s.id, s.state]));

test('OA-C1 profiles: default is exactly {writes:"off"}; simulated reports capabilities; held is accepted only as documented and exposes no relay', async () => {
  const plain = await harness({});
  assert.deepEqual((await post(plain, '/portal/api/embedded-wallet/profile')).json, { writes: 'off' });

  const sim = await harness({ DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_IDENTITY_WRITES: 'simulated-fixture-only' });
  const p = (await post(sim, '/portal/api/embedded-wallet/profile')).json;
  assert.equal(p.writes, 'simulated-loopback');
  assert.deepEqual(p.capabilities, { payment: true, identity: true, publication: true });
  const simNoId = await harness({ DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' });
  assert.equal((await post(simNoId, '/portal/api/embedded-wallet/profile')).json.capabilities.identity, false, 'identity capability follows DACS_IDENTITY_WRITES');

  // Config acceptance/refusal (no server, no network).
  const base = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:1', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_DATA_DIR: '/nonexistent-not-opened', DACS_EMBEDDED_WALLET_WRITES: 'testnet-held' };
  const held = { ...base, DACS_CHAIN_RPC_URL: 'https://node.invalid', DACS_CHAIN_NETWORK: 'demos-testnet' };
  const cfg = loadConfig(held);
  assert.equal(cfg.embeddedWallet.writes, 'off', 'held keeps the write profile off');
  assert.deepEqual({ ...cfg.embeddedWalletTestnet }, { profile: 'held', executable: false, network: 'demos-testnet', rpcOrigin: 'https://node.invalid' });
  assert.deepEqual({ ...loadConfig({ ...base, DACS_EMBEDDED_WALLET_WRITES: 'off' }).embeddedWalletTestnet }, { profile: 'off' }, 'default is off');
  const refusals = [
    ['http RPC', { ...held, DACS_CHAIN_RPC_URL: 'http://node.invalid' }, /https, non-loopback DACS_CHAIN_RPC_URL|must use https/],
    ['loopback RPC', { ...held, DACS_CHAIN_RPC_URL: 'https://127.0.0.1:9' }, /non-loopback/],
    ['no RPC', { ...held, DACS_CHAIN_RPC_URL: '' }, /DACS_CHAIN_RPC_URL/],
    ['no network label', { ...held, DACS_CHAIN_NETWORK: '' }, /explicit DACS_CHAIN_NETWORK/],
    ['bad network label', { ...held, DACS_CHAIN_NETWORK: 'Demos Testnet!' }, /DACS_CHAIN_NETWORK/],
    ['fixture GitHub origin', { ...held, DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: 'http://127.0.0.1:9' }, /only to the simulated-loopback profile/],
    ['unknown value', { ...held, DACS_EMBEDDED_WALLET_WRITES: 'testnet' }, /must be off, simulated-loopback or testnet-held/],
  ];
  for (const [label, env, message] of refusals) assert.throws(() => loadConfig(env), message, label);

  // Held app: endpoint shape and no relay. Nothing reads the .invalid RPC.
  const h = await harness({ DACS_EMBEDDED_WALLET_WRITES: 'testnet-held', DACS_CHAIN_RPC_URL: 'https://node.invalid', DACS_CHAIN_NETWORK: 'demos-testnet' });
  const hp = (await post(h, '/portal/api/embedded-wallet/profile')).json;
  assert.equal(hp.writes, 'off');
  assert.equal(hp.rpcUrl, undefined, 'no relay URL is offered');
  assert.equal(hp.testnet.profile, 'held');
  assert.equal(hp.testnet.executable, false);
  assert.equal(hp.testnet.network, 'demos-testnet');
  assert.equal(typeof hp.testnet.reason, 'string');
  assert.equal(hp.testnet.gates.length, 4);
  const relay = await post(h, '/portal/api/wallet-rpc', { method: 'execute', params: [{ extra: 'confirmTx', data: {} }] });
  assert.equal(relay.http, 404, 'the wallet relay is not mounted in the held profile');
});

// Predicts the hash the harness fixture chain assigns on broadcast (its
// documented test-only wallet behaviour: content + from_ed25519_address).
function predictedHash(payload) {
  const content = structuredClone(payload.content);
  content.from_ed25519_address = String(content.from).toLowerCase();
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

test('OA-C2 stages follow the interface table: reported is never verified; /verify advances only on matching evidence; directory visibility only once a separate search finds the listing', async () => {
  const h = await harness({});
  const seller = await linkedUser(h);
  const title = `Overnight core stages ${unique('t')}`;
  const input = agentInput({ title, priceDem: '3.5' });
  const reg = await tool(h, seller, 'register_agent', input);
  const token = tokenFrom(reg.portalUrl);
  const base = `/portal/api/publish/${reg.operationId}`;
  const view = async () => portal(h, `${base}/view`, { token });

  let v = await view();
  assert.deepEqual(STAGE_IDS, v.stages.map((s) => s.id), 'all six stages, in order');
  assert.deepEqual(stagesOf(v), { identity_signature: 'action_required', listing_signature: 'pending', storage_write: 'pending', chain_readback: 'pending', directory_submission: 'pending', directory_visibility: 'pending' });
  const identity = await portal(h, `${base}/identity`, { token, address: seller.wallet.address, signature: seller.wallet.signHex(v.signRequest.message) });
  assert.deepEqual(stagesOf(await view()), { identity_signature: 'verified', listing_signature: 'action_required', storage_write: 'pending', chain_readback: 'pending', directory_submission: 'pending', directory_visibility: 'pending' });
  const listed = await portal(h, `${base}/listing`, { token, signature: seller.wallet.signHex(identity.signRequest.message) });
  assert.equal(listed.status, 'publication_handoff');
  assert.equal(stagesOf(await view()).storage_write, 'action_required');

  // A wallet rejection: not completed, and the same payload is offered again.
  await portal(h, `${base}/report`, { token, walletError: 'User rejected the request' });
  v = await view();
  assert.equal(v.status, 'publication_handoff');
  assert.equal(stagesOf(v).storage_write, 'action_required');
  const again = await portal(h, `${base}/handoff`, { token });
  assert.deepEqual(again.payload, listed.payload, 'the same nonce-fenced payload is re-offered');

  // Ordinary inclusion lag: the wallet reports its hash before the chain has it.
  const hash = predictedHash(listed.payload);
  const reported = await portal(h, `${base}/report`, { token, txHash: hash });
  v = await view();
  assert.notEqual(v.status, 'chain_verified', `reported status ${reported.status}`);
  const lag = stagesOf(v);
  assert.equal(lag.storage_write, 'reported', 'a wallet-reported write is "reported"');
  assert.notEqual(lag.chain_readback, 'verified', 'reported is never verified');
  const noEvidence = await portal(h, `${base}/verify`, { token });
  assert.notEqual(noEvidence.status, 'chain_verified', '/verify does not advance without chain evidence');
  assert.notEqual(stagesOf(await view()).chain_readback, 'verified');

  // The write lands; now /verify advances.
  assert.equal(h.chain.walletBroadcast(listed.payload), hash, 'precondition: predicted hash');
  const landed = await portal(h, `${base}/verify`, { token });
  assert.equal(landed.status, 'chain_verified');
  assert.deepEqual(stagesOf(await view()), { identity_signature: 'verified', listing_signature: 'verified', storage_write: 'verified', chain_readback: 'verified', directory_submission: 'action_required', directory_visibility: 'pending' });

  // Registration is "reported"; visibility waits for the directory to serve it.
  const req = await portal(h, `${base}/registration`, { token });
  const reg2 = await portal(h, `${base}/register`, { token, signedAt: req.signedAt, signature: seller.wallet.signHex(req.message) });
  assert.equal(reg2.status, 'directory_submitted');
  assert.deepEqual([stagesOf(await view()).directory_submission, stagesOf(await view()).directory_visibility], ['reported', 'waiting']);
  const consumerSearch = async () => (await tool(h, null, 'search_agents', { query: title })).results.filter((r) => r.listingId === input.listingId).length;
  assert.equal(await consumerSearch(), 0, 'precondition: a separate consumer does not find it yet');
  assert.notEqual((await portal(h, `${base}/verify`, { token })).status, 'directory_visible', '/verify does not advance while the directory does not serve it');

  // The directory serves an older/different version first: still no advance.
  const op = listed.payload.content.data[1];
  const stale = structuredClone(op.data);
  stale.offering.title = `${title} (older)`;
  h.directory.add(summaryFor(stale, op.storageAddress), stale);
  assert.notEqual((await portal(h, `${base}/verify`, { token })).status, 'directory_visible', 'a different listing at the same coordinates is not matching evidence');
  assert.notEqual(stagesOf(await view()).directory_visibility, 'verified');

  // The directory serves the exact listing: a separate search finds it, and /verify advances.
  h.directory.add(summaryFor(op.data, op.storageAddress), op.data);
  assert.equal(await consumerSearch(), 1, 'a separate consumer finds it');
  const visible = await portal(h, `${base}/verify`, { token });
  assert.equal(visible.status, 'directory_visible');
  // Terminal state stays truthful on a later reload of the view.
  v = await view();
  assert.equal(v.status, 'directory_visible');
  assert.ok(Object.values(stagesOf(v)).every((s) => s === 'verified'));
  const handoffAfter = await portal(h, `${base}/handoff`, { token });
  assert.ok(!handoffAfter.payload, 'no write is offered after completion');
});

test('OA-C3 a cancelled publication stays cancelled with no later stage verified, also on reload; nothing is written', async () => {
  const h = await harness({});
  const seller = await linkedUser(h);
  const reg = await tool(h, seller, 'register_agent', agentInput({ title: `Overnight cancel ${unique('c')}` }));
  const token = tokenFrom(reg.portalUrl);
  const base = `/portal/api/publish/${reg.operationId}`;
  const v0 = await portal(h, `${base}/view`, { token });
  const identity = await portal(h, `${base}/identity`, { token, address: seller.wallet.address, signature: seller.wallet.signHex(v0.signRequest.message) });
  const listed = await portal(h, `${base}/listing`, { token, signature: seller.wallet.signHex(identity.signRequest.message) });
  const storageCount = h.chain.storage.size;
  const c = await tool(h, seller, 'cancel_wallet_handoff', { operationId: reg.operationId });
  assert.equal(c.status, 'cancelled');
  for (let i = 0; i < 2; i += 1) {
    const v = await portal(h, `${base}/view`, { token });
    assert.equal(v.status, 'cancelled');
    const s = stagesOf(v);
    assert.equal(s.storage_write, 'cancelled');
    assert.ok(['chain_readback', 'directory_submission', 'directory_visibility'].every((k) => s[k] === 'pending'));
  }
  const handoff = await portal(h, `${base}/handoff`, { token });
  assert.ok(!handoff.payload, 'a cancelled publication offers no write');
  assert.equal(h.chain.storage.size, storageCount, 'nothing was written');
  assert.ok(listed.payload, 'precondition: a payload had been prepared');
});
