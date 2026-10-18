// Identity add/remove OFFLINE CANDIDATE. The wallet is SIMULATED: a test
// "wallet" applies the requested identity change to the fixture chain, the
// way the reviewed wallet source broadcasts after its own confirmation. The
// server under test never signs or broadcasts; completion comes only from
// readback of the exact wallet, kind and handle.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool } from './helpers/flows.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { createAccountService } from '../src/accounts.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createIdentityActions, claimedHandle, REQUIRED_LIVE_CHECKS } from '../src/identities.mjs';

const WRITE = 'dacs.account.read dacs.identities.write';
let h;
before(async () => {
  h = await startHarness({ env: { DACS_IDENTITY_WRITES: 'simulated-fixture-only' } });
});
after(async () => h.close());

const key = (label) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const portal = (h0, start) => {
  const url = new URL(start.portalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  const call = async (step, body = {}) => {
    const res = await fetch(`${h0.origin}/portal/api/identity/${id}/${step}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
    return { status: res.status, body: await res.json() };
  };
  return { id, token, call };
};

test('held by default: no identity writes, with the required live checks listed', async () => {
  const plain = await startHarness();
  try {
    const user = await linkedUser(plain, WRITE);
    const out = await tool(plain, user, 'start_identity_action', { idempotencyKey: key('held'), action: 'add', kind: 'github' });
    assert.equal(out.error, 'identity_writes_held');
    assert.deepEqual(out.details.requiredLiveChecks, [...REQUIRED_LIVE_CHECKS]);
    const ids = await tool(plain, user, 'get_identities');
    assert.equal(ids.identityActions.capability, 'held');
    assert.ok(ids.identityActions.requiredLiveChecks.some((c) => /sign\(\) with an installed wallet/.test(c) && /unconfirmed with a real wallet/.test(c)));
  } finally {
    await plain.close();
  }
});

test('start_identity_action needs the distinct dacs.identities.write grant', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'identity-meta', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  const { tools } = await client.listTools();
  await client.close();
  const t = tools.find((x) => x.name === 'start_identity_action');
  assert.deepEqual(t._meta.securitySchemes, [{ type: 'oauth2', scopes: ['dacs.identities.write'] }]);
  assert.equal(t.annotations.readOnlyHint, false);
  assert.deepEqual(t.inputSchema.properties.kind.enum, ['github', 'twitter']);
  assert.ok(!tools.some((x) => /create_account|merge|delete_account/.test(x.name)), 'no account creation, merge or deletion tool');

  const buyerOnly = await linkedUser(h); // default grant: account read + agents + purchases
  const denied = await tool(h, buyerOnly, 'start_identity_action', { idempotencyKey: key('scope'), action: 'add', kind: 'github' });
  assert.match(denied.raw.content[0].text, /dacs\.identities\.write/);
  const granted = await linkedUser(h, WRITE);
  const out = await tool(h, granted, 'start_identity_action', { idempotencyKey: key('scope'), action: 'add', kind: 'github' });
  assert.equal(out.status, 'prepared');
});

test('add GitHub: one wallet request, then readback of the exact wallet and handle', async () => {
  const user = await linkedUser(h, WRITE);
  const other = await linkedUser(h, WRITE);
  const start = await tool(h, user, 'start_identity_action', { idempotencyKey: key('gh'), action: 'add', kind: 'github' });
  assert.equal(start.status, 'prepared');
  assert.match(start.note, /Nothing has been sent/);
  const p = portal(h, start);

  assert.equal((await p.call('view')).body.status, 'awaiting_wallet');
  const wrong = await p.call('connected', { address: other.wallet.address });
  assert.equal(wrong.body.error, 'wallet_mismatch');
  assert.equal((await p.call('connected', { address: user.wallet.address })).body.status, 'awaiting_public_proof');

  assert.equal((await p.call('proof', { proofUrl: 'https://example.com/octo/abc' })).body.error, 'invalid_proof_url');
  const proofUrl = 'https://gist.github.com/octo-cat/0123456789abcdef';
  const review = await p.call('proof', { proofUrl });
  assert.equal(review.body.status, 'review');
  assert.equal(review.body.username, 'octo-cat');

  const asked = await p.call('request');
  assert.equal(asked.body.status, 'wallet_requested');
  assert.deepEqual(asked.body.walletRequest, { method: 'addGithubIdentity', params: [proofUrl] });
  assert.equal((await p.call('request')).body.error, 'invalid_state', 'the wallet can be asked only once');

  // SIMULATED wallet: confirms, broadcasts, and the fixture chain records the association.
  h.chain.seedWeb2Identity(user.wallet.address, 'github', { username: 'octo-cat', userId: '99', proof: proofUrl });
  const reported = await p.call('report', { outcome: { success: true, dataSha256: 'a'.repeat(64) } });
  assert.equal(reported.body.status, 'association_observed');
  assert.equal(reported.body.walletOutcome.classification, 'wallet_reported_success');
  assert.ok(reported.body.history.some((e) => e.type === 'association_observed' && /not proof of which transaction/.test(e.data.note)));

  const ids = await tool(h, user, 'get_identities');
  const op = ids.operations.find((o) => o.operationId === p.id);
  assert.equal(op.status, 'association_observed');
  assert.ok(ids.wallets[0].claims.some((c) => c.kind === 'web2' && c.platform === 'github' && c.handle === 'octo-cat'));
});

test('remove Twitter: on-chain unlink observed; wallet, sign-in and history stay', async () => {
  const user = await linkedUser(h, WRITE);
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'bird_one', userId: '5', proof: 'https://x.com/bird_one/status/1' });
  assert.equal((await tool(h, user, 'start_identity_action', { idempotencyKey: key('rm'), action: 'remove', kind: 'twitter', username: 'nobody' })).error, 'identity_not_associated');
  // A differently-cased handle resolves to the exact on-chain handle for the wallet request.
  const start = await tool(h, user, 'start_identity_action', { idempotencyKey: key('rm'), action: 'remove', kind: 'twitter', username: 'Bird_One' });
  assert.equal(start.username, 'bird_one');
  const p = portal(h, start);
  await p.call('view');
  assert.equal((await p.call('connected', { address: user.wallet.address })).body.status, 'review');
  const asked = await p.call('request');
  assert.deepEqual(asked.body.walletRequest, { method: 'removeWeb2Identity', params: [{ context: 'twitter', username: 'bird_one' }] });
  h.chain.removeWeb2Identity(user.wallet.address, 'twitter', 'bird_one');
  const reported = await p.call('report', { outcome: { success: true } });
  assert.equal(reported.body.status, 'removal_observed');
  assert.match(reported.body.statusHelp, /not deleted/);
  const status = await tool(h, user, 'get_account_status');
  assert.deepEqual(status.wallets.map((w) => w.address), [user.wallet.address], 'the wallet stays linked');
});

test('USER_REJECTED before send is distinct; TIMEOUT and ambiguous errors keep the outcome unknown', async () => {
  const user = await linkedUser(h, WRITE);
  const rejectStart = await tool(h, user, 'start_identity_action', { idempotencyKey: key('rej'), action: 'add', kind: 'twitter' });
  const r = portal(h, rejectStart);
  await r.call('view');
  await r.call('connected', { address: user.wallet.address });
  await r.call('proof', { proofUrl: 'https://x.com/rej_user/status/12345' });
  await r.call('request');
  const rejected = await r.call('report', { outcome: { success: false, code: 'USER_REJECTED', message: 'User rejected' } });
  assert.equal(rejected.body.status, 'rejected_before_send');

  const timeoutStart = await tool(h, user, 'start_identity_action', { idempotencyKey: key('to'), action: 'add', kind: 'twitter' });
  const t = portal(h, timeoutStart);
  await t.call('view');
  await t.call('connected', { address: user.wallet.address });
  await t.call('proof', { proofUrl: 'https://x.com/slow_user/status/777' });
  await t.call('request');
  const timedOut = await t.call('report', { outcome: { success: false, code: 'TIMEOUT', message: 'Operation timed out waiting for user response' } });
  assert.equal(timedOut.body.status, 'readback_pending', 'a timeout is not "not broadcast"');
  assert.equal(timedOut.body.walletOutcome.classification, 'unknown');
  assert.equal((await t.call('request')).body.error, 'invalid_state', 'no automatic or manual re-request');
  // The wallet had in fact broadcast: a later readback observes it.
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'slow_user', proof: 'https://x.com/slow_user/status/777' });
  assert.equal((await t.call('view')).body.status, 'association_observed');
});

test('idempotency, one in-flight action per wallet, and restart durability', async () => {
  const user = await linkedUser(h, WRITE);
  const k = key('idem');
  const a = await tool(h, user, 'start_identity_action', { idempotencyKey: k, action: 'add', kind: 'github' });
  const again = await tool(h, user, 'start_identity_action', { idempotencyKey: k, action: 'add', kind: 'github' });
  assert.equal(again.operationId, a.operationId);
  assert.equal((await tool(h, user, 'start_identity_action', { idempotencyKey: k, action: 'add', kind: 'twitter' })).error, 'idempotency_conflict');
  assert.equal((await tool(h, user, 'start_identity_action', { idempotencyKey: key('second'), action: 'add', kind: 'twitter' })).error, 'identity_operation_in_progress');

  const p = portal(h, a);
  await p.call('view');
  await p.call('connected', { address: user.wallet.address });
  await h.restart();
  assert.equal((await p.call('view')).body.status, 'awaiting_public_proof', 'state survives a restart');
  assert.equal((await p.call('proof', { proofUrl: 'https://gist.github.com/after-restart/abc' })).body.status, 'review');
});

test('with no chain configured, identity actions are not_configured', async () => {
  const bare = await startHarness({ env: { DACS_IDENTITY_WRITES: 'simulated-fixture-only', DACS_CHAIN_RPC_URL: '' } });
  try {
    const user = await linkedUser(bare, WRITE);
    assert.equal((await tool(bare, user, 'start_identity_action', { idempotencyKey: key('nc'), action: 'add', kind: 'github' })).error, 'not_configured');
  } finally {
    await bare.close();
  }
});

test('proof URLs: handle comes from the first path segment on the SDK hosts only', () => {
  assert.equal(claimedHandle('github', 'https://gist.github.com/fixture-owner/abc'), 'fixture-owner');
  assert.equal(claimedHandle('github', 'https://raw.githubusercontent.com/fixture-owner/repo/main/proof.txt'), 'fixture-owner');
  assert.equal(claimedHandle('twitter', 'https://x.com/bob_b/status/1234'), 'bob_b');
  for (const bad of [['github', 'http://gist.github.com/fixture-owner/abc'], ['github', 'https://github.com/fixture-owner'], ['twitter', 'https://x.com/fixture-reader'], ['twitter', 'https://x.com.evil.example/fixture-reader/status/1'], ['github', 'https://gist.github.com:8443/fixture-owner/abc']]) {
    assert.throws(() => claimedHandle(...bad), /invalid|must|valid/, bad.join(' '));
  }
});

// Deterministic clock: expiry before the wallet is asked, and an unobserved
// result becoming outcome_unknown, then observed later without any retry.
test('expiry and the readback window, with a controllable clock and a fixture chain object', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-identity-clock-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  try {
    let t = Date.parse('2026-10-02T00:00:00Z');
    const now = () => t;
    const accounts = createAccountService({ db, builtinIssuer: 'https://issuer.invalid/oauth', now });
    const ops = createOperationStore({ db, handoffSecret: 'x'.repeat(40), now });
    const coordinates = createCoordinateStore({ db, now });
    const state = { github: [] };
    const chain = { network: 'demos-testnet', evidenceMode: 'simulated-fixture', getIdentities: async () => ({ result: 200, response: { xm: {}, web2: structuredClone(state), ud: [], pqc: {} } }) };
    const actions = createIdentityActions({ config: { identityWrites: 'simulated-fixture-only' }, ops, accounts, coordinates, chain, now });
    const wallet = `0x${'1'.repeat(64)}`;
    const account = accounts.loginWithWallet({ address: wallet, challengeId: 'chl_test' });

    const stale = await actions.start({ accountId: account.id, idempotencyKey: 'stale-0001', action: 'add', kind: 'github' });
    t += 31 * 60 * 1000;
    assert.equal((await actions.opened(stale.operation.id, stale.handoffToken)).status, 'expired');

    const live = await actions.start({ accountId: account.id, idempotencyKey: 'live-00001', action: 'add', kind: 'github' });
    await actions.opened(live.operation.id, live.handoffToken);
    actions.connected({ id: live.operation.id, token: live.handoffToken, address: wallet });
    await actions.submitProof({ id: live.operation.id, token: live.handoffToken, proofUrl: 'https://gist.github.com/clock/abc' });
    actions.request({ id: live.operation.id, token: live.handoffToken });
    const closed = await actions.report({ id: live.operation.id, token: live.handoffToken, outcome: { success: false, code: 'addGithubIdentityCancelled', message: 'User closed popup' } });
    assert.equal(closed.operation.status, 'readback_pending');
    t += 11 * 60 * 1000;
    assert.equal((await actions.opened(live.operation.id, live.handoffToken)).status, 'outcome_unknown');
    state.github.push({ username: 'clock', proof: 'https://gist.github.com/clock/abc' });
    assert.equal((await actions.opened(live.operation.id, live.handoffToken)).status, 'association_observed');
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
