// Offline tester launcher (bin/dacs-chatgpt-offline-test.mjs): programmatic
// start/stop, the public fixture surfaces, fixture write acceptance with
// normal ed25519 verification and independent readback, and the CLI process
// lifecycle. Everything is SIMULATED and loopback-only. The test-owned buyer
// key below is a throwaway key made in this file; the operator holds none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startOfflineTester, parseArgs, publicSummary, NOTICE } from '../bin/dacs-chatgpt-offline-test.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { loadConfig } from '../src/config.mjs';

const BIN = fileURLToPath(new URL('../bin/dacs-chatgpt-offline-test.mjs', import.meta.url));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  return { address: `0x${hex}`, signUtf8: (text) => `0x${sign(null, Buffer.from(text, 'utf8'), privateKey).toString('hex')}` };
}

// SDK 4.0.16 transaction shape: hash = sha256(JSON content), ed25519 over the UTF-8 hash.
function signedTx(key, content) {
  const full = { from: key.address, timestamp: Date.now(), gcr_edits: [], ...content };
  const hash = sha256(JSON.stringify(full));
  return { content: full, hash, signature: { type: 'ed25519', data: key.signUtf8(hash) } };
}

const rpc = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
const execute = (url, data, extra) => rpc(url, { method: 'execute', params: [{ type: 'execute', message: '', sender: null, receiver: null, timestamp: null, data, extra }] });
const nodeCall = (url, message, data) => rpc(url, { method: 'nodeCall', params: [{ message, data }] });

async function refused(origin) {
  try {
    await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch (error) {
    return /ECONNREFUSED/.test(String(error?.cause?.code ?? error?.cause?.message ?? error?.message));
  }
}

let h;
before(async () => {
  h = await startOfflineTester({ logLevel: 'silent' });
});
after(async () => {
  await h?.stop();
});

test('start: loopback-only public origins, simulated notice and the core profile flags', async () => {
  for (const origin of [h.origin, h.fixtures.chain, h.fixtures.directory, h.fixtures.proofs]) {
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  }
  assert.match(NOTICE, /not Demos testnet/);
  assert.match(NOTICE, /not settlement/);
  assert.deepEqual(h.coreProfile, { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: h.fixtures.proofs });
  assert.equal(existsSync(h.stateDir), true);
  const summary = JSON.stringify(publicSummary(h));
  assert.doesNotMatch(summary, /cookie|secret|privateKey|mnemonic/i, 'only public values are summarized');

  const health = await (await fetch(`${h.origin}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.dependencies.chain.configured, true);
  assert.equal(health.dependencies.chain.rpcOrigin, h.fixtures.chain);
  assert.equal(health.dependencies.chain.network, 'offline-fixture');
  assert.equal(health.dependencies.directory.origin, h.fixtures.directory);
});

test('the fixture listing is discoverable and verified through the normal MCP tools (simulated)', async () => {
  const client = new Client({ name: 'offline-tester-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  try {
    const search = await client.callTool({ name: 'search_agents', arguments: { query: 'offline fixture' } });
    assert.equal(search.isError, undefined, JSON.stringify(search.content));
    assert.equal(search.structuredContent.evidenceMode, 'simulated-fixture');
    assert.equal(search.structuredContent.results.length, 1);
    const got = await client.callTool({ name: 'get_listing', arguments: { listingId: h.listing.listingId, version: 1, seller: h.listing.seller } });
    assert.equal(got.isError, undefined, JSON.stringify(got.content));
    const v = got.structuredContent;
    assert.equal(v.transactable, true, JSON.stringify(v.checks));
    assert.equal(v.disposition, 'verified');
    assert.equal(v.price.amount, '1.5');
    assert.equal(v.price.amountOs, '1500000000');
    assert.equal(v.evidence.chainMode, 'simulated-fixture');
  } finally {
    await client.close();
  }
});

test('prepare_purchase still requires the normal OAuth account (no fixture skip)', async () => {
  const client = new Client({ name: 'offline-tester-anon', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  try {
    const result = await client.callTool({ name: 'prepare_purchase', arguments: { listingId: h.listing.listingId, version: 1, seller: h.listing.seller, idempotencyKey: 'offline-tester-anon-1' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /auth|link|sign in|account/i);
  } finally {
    await client.close();
  }
});

test('fixture chain: confirm + broadcast of an ed25519-signed native send, then independent readback', async () => {
  const buyer = throwawayKey();
  const seller = h.listing.sellerAddress;
  const amount = '1500000000';
  const tx = signedTx(buyer, { type: 'native', to: seller, amount, nonce: 1, data: ['native', { nativeOperation: 'send', args: [seller, amount] }] });

  const info = await nodeCall(h.fixtures.chain, 'getNetworkInfo', {});
  assert.equal(info.body.response.forks.osDenomination.activated, true);
  assert.equal(info.headers.get('x-dacs-simulation'), 'fixture');

  const confirmed = await execute(h.fixtures.chain, tx, 'confirmTx');
  assert.equal(confirmed.body.response.data.valid, true, confirmed.body.response.data.message);
  const broadcast = await execute(h.fixtures.chain, confirmed.body, 'broadcastTx');
  assert.equal(broadcast.body.result, 200, JSON.stringify(broadcast.body));
  assert.equal(broadcast.body.response.hash, tx.hash);

  // Readback through the plugin's own chain reader and the bundled pay-DEM observer.
  const reader = createDemosChainReader({ rpcUrl: h.fixtures.chain, network: 'offline-fixture' });
  assert.equal(await reader.getAddressNonce(buyer.address), 1);
  const observed = await reader.observeTransfer(tx.hash);
  assert.equal(observed.status, 'included', JSON.stringify(observed));
  // The observer reports native addresses as bare lowercase hex.
  assert.equal(observed.payer, buyer.address.slice(2));
  assert.equal(observed.payee, seller.slice(2));
  assert.equal(observed.amountOs, amount);
  assert.equal(reader.evidenceMode, 'simulated-fixture');

  // Replaying the same transaction is a nonce rejection, not a second record.
  const replay = await execute(h.fixtures.chain, confirmed.body, 'broadcastTx');
  assert.equal(replay.body.result, 400);
  assert.match(replay.body.response.message, /nonce 1 rejected; expected 2/);
});

test('fixture chain rejects wrong signer, altered content and a forged validity flag', async () => {
  const buyer = throwawayKey();
  const other = throwawayKey();
  const to = h.listing.sellerAddress;
  const base = { type: 'native', to, amount: '1', nonce: 1, data: ['native', { nativeOperation: 'send', args: [to, '1'] }] };

  const good = signedTx(buyer, base);
  const wrongSigner = { ...good, signature: { type: 'ed25519', data: other.signUtf8(good.hash) } };
  const r1 = await execute(h.fixtures.chain, wrongSigner, 'confirmTx');
  assert.equal(r1.body.response.data.valid, false);
  assert.match(r1.body.response.data.message, /signature does not verify/);

  const altered = { ...good, content: { ...good.content, amount: '2' } };
  const r2 = await execute(h.fixtures.chain, altered, 'confirmTx');
  assert.equal(r2.body.response.data.valid, false);
  assert.match(r2.body.response.data.message, /hash does not match content/);

  const forged = { result: 200, response: { data: { valid: true, transaction: wrongSigner } } };
  const r3 = await execute(h.fixtures.chain, forged, 'broadcastTx');
  assert.equal(r3.body.result, 400);
  assert.match(r3.body.response.message, /signature does not verify/);

  // The valid control still confirms (the negatives did not start from an error baseline).
  const r4 = await execute(h.fixtures.chain, good, 'confirmTx');
  assert.equal(r4.body.response.data.valid, true);
  const nonce = await nodeCall(h.fixtures.chain, 'getAddressNonce', { address: buyer.address });
  assert.equal(nonce.body.response, 0, 'nothing was recorded for rejected attempts');
});

test('public proof fixture: GitHub-shaped user API, publication and web2 identity add/remove readback', async () => {
  const wallet = throwawayKey();
  const user = await (await fetch(`${h.fixtures.proofs}/\x75sers/fixture-tester`)).json();
  assert.equal(user.login, 'fixture-tester');
  assert.equal(Number.isSafeInteger(user.id), true);
  assert.equal(user.simulated, true);

  const proof = `demos:dw2p:ed25519:${wallet.signUtf8('dw2p')}`;
  const published = await rpc(`${h.fixtures.proofs}/api/proofs`, { kind: 'github', username: 'fixture-tester', proof });
  assert.equal(published.status, 200);
  assert.match(published.body.proofUrl, /^https:\/\/gist\.github\.com\/fixture-tester\/[0-9a-f]{20}$/);

  const add = signedTx(wallet, { type: 'identity', to: wallet.address, amount: 0, nonce: 1, data: ['identity', { context: 'web2', method: 'web2_identity_assign', payload: { context: 'github', username: 'fixture-tester', userId: String(user.id), proof: published.body.proofUrl } }] });
  const c1 = await execute(h.fixtures.chain, add, 'confirmTx');
  assert.equal(c1.body.response.data.valid, true, c1.body.response.data.message);
  assert.equal((await execute(h.fixtures.chain, c1.body, 'broadcastTx')).body.result, 200);

  const reader = createDemosChainReader({ rpcUrl: h.fixtures.chain, network: 'offline-fixture' });
  const ids = await reader.getIdentities(wallet.address);
  assert.deepEqual(ids.response.web2.github.map((e) => e.username), ['fixture-tester']);

  const remove = signedTx(wallet, { type: 'identity', to: wallet.address, amount: 0, nonce: 2, data: ['identity', { context: 'web2', method: 'web2_identity_remove', payload: { context: 'github', username: 'fixture-tester' } }] });
  const c2 = await execute(h.fixtures.chain, remove, 'confirmTx');
  assert.equal(c2.body.response.data.valid, true, c2.body.response.data.message);
  assert.equal((await execute(h.fixtures.chain, c2.body, 'broadcastTx')).body.result, 200);
  assert.deepEqual((await reader.getIdentities(wallet.address)).response.web2.github, []);

  // A proof made by a different key, or an unpublished URL, is not accepted.
  const stranger = throwawayKey();
  const theirs = await rpc(`${h.fixtures.proofs}/api/proofs`, { kind: 'github', username: 'someone-else', proof: `demos:dw2p:ed25519:${stranger.signUtf8('dw2p')}` });
  const bad = signedTx(wallet, { type: 'identity', to: wallet.address, amount: 0, nonce: 3, data: ['identity', { context: 'web2', method: 'web2_identity_assign', payload: { context: 'github', username: 'someone-else', proof: theirs.body.proofUrl } }] });
  const c3 = await execute(h.fixtures.chain, bad, 'confirmTx');
  assert.equal(c3.body.response.data.valid, false);
  assert.match(c3.body.response.data.message, /proof signature does not verify/);
  const unpublished = signedTx(wallet, { type: 'identity', to: wallet.address, amount: 0, nonce: 3, data: ['identity', { context: 'web2', method: 'web2_identity_assign', payload: { context: 'github', username: 'fixture-tester', proof: 'https://gist.github.com/fixture-tester/0000' } }] });
  assert.match((await execute(h.fixtures.chain, unpublished, 'confirmTx')).body.response.data.message, /not published/);
});

test('proof publisher page is a plain, script-free form with a restrictive CSP', async () => {
  const res = await fetch(`${h.fixtures.proofs}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /SIMULATED/);
  assert.match(html, /Not GitHub, not X, not Demos testnet/);
  assert.doesNotMatch(html, /<script/i);
});

test('fixture request bodies are bounded', async () => {
  const big = 'x'.repeat(300 * 1024);
  const res = await fetch(h.fixtures.chain, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
  assert.equal(res.status, 413);
  await res.arrayBuffer();
});

test('core profile: the launched app enables simulated-loopback embedded-wallet writes with the proof fixture as GitHub API', async () => {
  // Core's simulated-loopback profile (CORE-INTERFACE.md §1/§2). This fails,
  // rather than skipping, if the app does not support the profile.
  const config = loadConfig({ DACS_PUBLIC_ORIGIN: h.origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32), DACS_DATA_DIR: h.stateDir, DACS_CHAIN_RPC_URL: h.fixtures.chain, ...h.coreProfile });
  assert.deepEqual({ ...config.embeddedWallet }, { writes: 'simulated-loopback', githubApiOrigin: h.fixtures.proofs });
  const profile = await (await fetch(`${h.origin}/portal/api/embedded-wallet/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(profile.writes, 'simulated-loopback');
  assert.equal(profile.rpcUrl, `${h.origin}/portal/api/wallet-rpc`);
  assert.equal(profile.githubLookup, true);
  // The relay reaches the fixture chain (simulation header observed) and the
  // GitHub lookup reaches the proof fixture, both through the app.
  const relayed = await rpc(`${h.origin}/portal/api/wallet-rpc`, { method: 'nodeCall', params: [{ message: 'getNetworkParameters', data: {} }] });
  assert.equal(relayed.status, 200);
  assert.deepEqual([relayed.body.result, relayed.body.response.networkFee, relayed.body.response.rpcFee], [200, 0, 0]);
  const user = await rpc(`${h.origin}/portal/api/wallet-rpc/github-user`, { username: 'offline-tester' });
  assert.equal(user.status, 200);
  assert.equal(user.body.login, 'offline-tester');
  assert.equal(Number.isSafeInteger(user.body.id), true);
});

test('fixture wire matches the SDK 4.0.16 envelope (getTweet, confirm fields, broadcast txHash)', async () => {
  const wallet = throwawayKey();
  const proof = `demos:dw2p:ed25519:${wallet.signUtf8('dw2p')}`;
  const { body } = await rpc(`${h.fixtures.proofs}/api/proofs`, { kind: 'twitter', username: 'fixture_tester', proof });
  const tweet = await nodeCall(h.fixtures.chain, 'getTweet', { tweetUrl: body.proofUrl });
  assert.deepEqual([tweet.body.result, tweet.body.require_reply, tweet.body.extra], [200, false, null]);
  assert.equal(tweet.body.response.success, true);
  assert.equal(tweet.body.response.tweet.username, 'fixture_tester');
  assert.equal(typeof tweet.body.response.tweet.userId, 'string');
  const tx = signedTx(wallet, { type: 'native', to: h.listing.sellerAddress, amount: '1', nonce: 1, data: ['native', { nativeOperation: 'send', args: [h.listing.sellerAddress, '1'] }] });
  const confirmed = await execute(h.fixtures.chain, tx, 'confirmTx');
  for (const key of ['valid', 'reference_block', 'message', 'gas_operation', 'transaction']) assert.ok(Object.hasOwn(confirmed.body.response.data, key), key);
  assert.ok(Object.hasOwn(confirmed.body.response, 'rpc_public_key'));
  const broadcast = await execute(h.fixtures.chain, confirmed.body, 'broadcastTx');
  assert.equal(broadcast.body.response.txHash, tx.hash);
});

test('argument parsing: defaults, loopback redirect origin and refusals', async () => {
  assert.deepEqual(parseArgs([]).redirectOrigins, ['http://localhost:6274']);
  assert.equal(parseArgs(['--port', '0', '--keep-state']).keepState, true);
  assert.throws(() => parseArgs(['--port', '70000']), /--port/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
  await assert.rejects(startOfflineTester({ redirectOrigins: ['https://chatgpt.com'] }), /loopback/);
});

test('stop closes every owned listener and removes fresh state; stop is idempotent', async () => {
  const own = await startOfflineTester({ logLevel: 'silent' });
  const origins = [own.origin, own.fixtures.chain, own.fixtures.directory, own.fixtures.proofs];
  assert.equal((await fetch(`${own.origin}/health`)).status, 200);
  await Promise.all([own.stop(), own.stop()]);
  assert.equal(own.stopped, true);
  for (const origin of origins) assert.equal(await refused(origin), true, `${origin} still accepts connections`);
  assert.equal(existsSync(own.stateDir), false);
});

test('CLI: --json prints only public start info and SIGTERM stops cleanly', async () => {
  const child = spawn(process.execPath, [BIN, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '' } });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 20_000;
    while (!out.includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const summary = JSON.parse(out.split('\n')[0]);
    assert.equal(summary.status, 'running');
    assert.match(summary.notice, /SIMULATED/);
    assert.match(summary.mcp, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(summary.state.kept, false);
    assert.doesNotMatch(out + err, /cookie|secret|private|mnemonic/i);
    assert.equal((await fetch(summary.health)).status, 200);
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 0, err);
    assert.match(err, /SIGTERM received/);
    for (const origin of [summary.plugin, summary.fixtures.chain, summary.fixtures.directory, summary.fixtures.proofs]) {
      assert.equal(await refused(origin), true, `${origin} still accepts connections`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

test('CLI: --help exits 0 and an unknown option exits 2', async () => {
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => resolve({ code, out }));
  });
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /not Demos testnet/);
  const bad = await run(['--nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown option --nope/);
});
