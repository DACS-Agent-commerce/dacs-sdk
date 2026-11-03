// Closure (identity recovery): a wallet whose identity request stopped BEFORE
// anything was broadcast, or whose user gave input the wallet can never use,
// must not be stranded; a fresh corrected action succeeds without a restart.
// Ambiguous or post-send answers keep the existing rule: unknown, in flight,
// never re-requested and never called rejected. See docs/IDENTITY-RECOVERY.md.
//
// SIMULATED: the harness fixture chain plays the node, and the test plays the
// wallet's reported envelope exactly as public/portal/portal.js sends it. The
// real pinned embedded wallet producing these codes is covered by
// closure-identity-sdk.test.mjs. Functional offline tests; not a security
// review, not live.
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
import { createIdentityActions } from '../src/identities.mjs';

const WRITE = 'dacs.account.read dacs.identities.write';
// Codes the pinned embedded wallet raises for identity methods before its one
// broadcast (public/portal/embedded-wallet/sdk-provider.mjs, ui.mjs).
const PRE_SEND = ['locked', 'busy', 'invalid_params', 'invalid_request', 'not_configured', 'unsupported', 'held_for_review', 'upstream_unavailable', 'identity_mismatch', 'confirm_rejected', 'payload_mismatch'];

let h;
before(async () => {
  // Many fresh linked accounts (each OAuth link is dozens of requests): the
  // documented per-minute limit is raised for this harness only; rate
  // limiting itself is not under test here.
  h = await startHarness({ env: { DACS_IDENTITY_WRITES: 'simulated-fixture-only', DACS_RATE_LIMIT_PER_MINUTE: '100000' } });
});
after(async () => h.close());

const key = (label) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const portal = (start) => {
  const url = new URL(start.portalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  const call = async (step, body = {}, { withToken = token } = {}) => {
    const res = await fetch(`${h.origin}/portal/api/identity/${id}/${step}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: withToken, ...body }) });
    return { status: res.status, body: await res.json() };
  };
  return { id, token, call };
};

// The idempotency key each started operation used, for replay checks.
const usedKeys = new Map();
async function start(user, args) {
  const idempotencyKey = key('cl');
  const out = await tool(h, user, 'start_identity_action', { idempotencyKey, walletAddress: user.wallet.address, ...args });
  assert.equal(out.status, 'prepared', JSON.stringify(out));
  usedKeys.set(out.operationId, idempotencyKey);
  return out;
}

// prepared -> review, exactly the portal's steps.
async function toReview(user, { action = 'add', kind = 'twitter', proofUrl, username } = {}) {
  const s = await start(user, { action, kind, ...(username ? { username } : {}) });
  const p = portal(s);
  assert.equal((await p.call('view')).body.status, 'awaiting_wallet');
  const connected = await p.call('connected', { address: user.wallet.address });
  if (action === 'add') {
    assert.equal(connected.body.status, 'awaiting_public_proof');
    const proof = await p.call('proof', { proofUrl });
    assert.equal(proof.body.status, 'review', JSON.stringify(proof.body));
  } else {
    assert.equal(connected.body.status, 'review');
  }
  return { s, p };
}

async function asked(p) {
  const r = await p.call('request');
  assert.equal(r.body.status, 'wallet_requested', JSON.stringify(r.body));
  return r.body.walletRequest;
}

const events = (body) => body.history.map((e) => e.type);

// ---------------------------------------------------------------- accepting controls first

test('accepting control: GitHub add and Twitter add/remove reported by the embedded wallet still complete from readback', async () => {
  const user = await linkedUser(h, WRITE);
  const gist = 'https://gist.github.com/closure-gh/0123456789abcdef';
  const gh = await toReview(user, { kind: 'github', proofUrl: gist });
  assert.deepEqual(await asked(gh.p), { method: 'addGithubIdentity', params: [gist] });
  h.chain.seedWeb2Identity(user.wallet.address, 'github', { username: 'closure-gh', userId: '7', proof: gist });
  const ghDone = await gh.p.call('report', { outcome: { success: true, dataSha256: 'b'.repeat(64), wallet: 'embedded' } });
  assert.equal(ghDone.body.status, 'association_observed');
  assert.equal(ghDone.body.walletOutcome.classification, 'wallet_reported_success');
  assert.equal(ghDone.body.walletOutcome.wallet, 'embedded');

  const post = 'https://x.com/closure_tw/status/4242';
  const tw = await toReview(user, { kind: 'twitter', proofUrl: post });
  await asked(tw.p);
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'closure_tw', userId: '8', proof: post });
  assert.equal((await tw.p.call('report', { outcome: { success: true, wallet: 'embedded' } })).body.status, 'association_observed');

  const rm = await toReview(user, { action: 'remove', kind: 'twitter', username: 'closure_tw' });
  assert.deepEqual(await asked(rm.p), { method: 'removeWeb2Identity', params: [{ context: 'twitter', username: 'closure_tw' }] });
  h.chain.removeWeb2Identity(user.wallet.address, 'twitter', 'closure_tw');
  assert.equal((await rm.p.call('report', { outcome: { success: true, wallet: 'embedded' } })).body.status, 'removal_observed');

  // A reload of a finished page reads the same terminal state.
  assert.equal((await rm.p.call('view')).body.status, 'removal_observed');
  const ids = await tool(h, user, 'get_identities', { walletAddress: user.wallet.address });
  assert.deepEqual(ids.operations.filter((o) => [gh.s, tw.s, rm.s].some((s) => s.operationId === o.operationId)).map((o) => o.status).sort(),
    ['association_observed', 'association_observed', 'removal_observed']);
});

test('accepting control: an extension USER_REJECTED is still rejected_before_send and frees the wallet', async () => {
  const user = await linkedUser(h, WRITE);
  const { p } = await toReview(user, { proofUrl: 'https://x.com/ext_reject/status/1' });
  await asked(p);
  const rejected = await p.call('report', { outcome: { success: false, code: 'USER_REJECTED', message: 'User rejected', wallet: 'extension' } });
  assert.equal(rejected.body.status, 'rejected_before_send');
  assert.equal(rejected.body.walletOutcome.classification, 'rejected_before_send');
  assert.equal(rejected.body.walletOutcome.wallet, 'extension');
  await start(user, { action: 'add', kind: 'twitter' });
});

// ---------------------------------------------------------------- invalid user input before the wallet is asked

test('a GitHub handle GitHub can never have is refused at the proof step; the same action takes the corrected URL and completes', async () => {
  const user = await linkedUser(h, WRITE);
  const s = await start(user, { action: 'add', kind: 'github' });
  const p = portal(s);
  await p.call('view');
  await p.call('connected', { address: user.wallet.address });
  const bad = await p.call('proof', { proofUrl: 'https://gist.github.com/not_github/0123456789abcdef' });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, 'invalid_proof_url');
  assert.match(bad.body.message, /“not_github” cannot be a GitHub username/);
  assert.match(bad.body.message, /Nothing was sent to your wallet/);
  const still = await p.call('view');
  assert.equal(still.body.status, 'awaiting_public_proof', 'the user can paste a corrected URL in the same action');
  assert.ok(!events(still.body).includes('wallet_requested'), 'the wallet was never asked');
  assert.equal((await p.call('request')).body.error, 'invalid_state', 'no wallet request before a valid proof');

  const good = 'https://gist.github.com/real-github/0123456789abcdef';
  const review = await p.call('proof', { proofUrl: good });
  assert.equal(review.body.status, 'review');
  assert.equal(review.body.username, 'real-github');
  assert.deepEqual(await asked(p), { method: 'addGithubIdentity', params: [good] });
  h.chain.seedWeb2Identity(user.wallet.address, 'github', { username: 'real-github', proof: good });
  assert.equal((await p.call('report', { outcome: { success: true, wallet: 'embedded' } })).body.status, 'association_observed');

  // Control: underscores remain valid for Twitter handles.
  const tw = await toReview(user, { kind: 'twitter', proofUrl: 'https://x.com/under_score/status/5' });
  assert.equal((await tw.p.call('view')).body.username, 'under_score');
});

// ---------------------------------------------------------------- wallet stopped before broadcasting

test('an embedded-wallet failure before broadcast closes the action as failed_before_send; a corrected fresh action for the same wallet succeeds without a restart', async () => {
  const user = await linkedUser(h, WRITE);
  const missing = 'https://x.com/closure_fail/status/9';
  const first = await toReview(user, { proofUrl: missing });
  await asked(first.p);
  const failed = await first.p.call('report', { outcome: { success: false, code: 'upstream_unavailable', message: 'the configured Demos node did not answer getTweet; nothing was signed', wallet: 'embedded' } });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, 'failed_before_send');
  assert.equal(failed.body.walletOutcome.classification, 'failed_before_send');
  assert.equal(failed.body.walletOutcome.wallet, 'embedded');
  assert.equal(failed.body.walletOutcome.code, 'upstream_unavailable');
  assert.match(failed.body.statusHelp, /stopped before broadcasting anything/);
  assert.doesNotMatch(failed.body.statusHelp, /rejected/i, 'not called a rejection');
  assert.deepEqual(events(failed.body).slice(-2), ['wallet_requested', 'failed_before_send']);

  assert.equal((await first.p.call('request')).body.error, 'invalid_state', 'never re-requested');
  assert.equal((await first.p.call('cancel')).body.error, 'invalid_state', 'a closed action is not cancellable');
  assert.equal((await first.p.call('view')).body.status, 'failed_before_send', 'reload shows the same closed state');
  const listed = (await tool(h, user, 'get_identities')).operations.find((o) => o.operationId === first.s.operationId);
  assert.equal(listed.status, 'failed_before_send');
  assert.equal(listed.walletOutcome, 'failed_before_send');

  // The same idempotency key still replays the same closed action.
  const replay = await tool(h, user, 'start_identity_action', { idempotencyKey: usedKeys.get(first.s.operationId), action: 'add', kind: 'twitter', walletAddress: user.wallet.address });
  assert.equal(replay.operationId, first.s.operationId);
  assert.equal(replay.status, 'failed_before_send');

  // Corrected: the post now exists. A fresh action for the SAME wallet is allowed.
  const fixed = 'https://x.com/closure_fail/status/10';
  const second = await toReview(user, { proofUrl: fixed });
  await asked(second.p);
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'closure_fail', proof: fixed });
  assert.equal((await second.p.call('report', { outcome: { success: true, wallet: 'embedded' } })).body.status, 'association_observed');
});

test('every documented embedded stopped-before-broadcast code closes the action and frees the wallet', async () => {
  const user = await linkedUser(h, WRITE);
  for (const code of PRE_SEND) {
    const { p } = await toReview(user, { proofUrl: `https://x.com/code_${code.replace(/_/g, '')}/status/1` });
    await asked(p);
    const r = await p.call('report', { outcome: { success: false, code, message: `simulated ${code}`, wallet: 'embedded' } });
    assert.equal(r.body.status, 'failed_before_send', code);
    // The next iteration's start for the same wallet proves it is free.
  }
  await start(user, { action: 'add', kind: 'github' });
});

// ---------------------------------------------------------------- ambiguous / post-send: unchanged rule

const AMBIGUOUS = [
  ['embedded outcome_unknown (broadcast may have reached the node)', { success: false, code: 'outcome_unknown', message: 'the broadcast may or may not have reached the node', wallet: 'embedded' }],
  ['embedded broadcast_rejected (sent; node refused)', { success: false, code: 'broadcast_rejected', message: 'the node answered the broadcast with a refusal', wallet: 'embedded' }],
  ['embedded internal_error (catch-all)', { success: false, code: 'internal_error', message: 'the embedded wallet could not complete the request', wallet: 'embedded' }],
  ['embedded wallet_error (UI wrapper catch-all)', { success: false, code: 'wallet_error', message: 'The embedded wallet could not complete this request.', wallet: 'embedded' }],
  ['embedded sdk_error (not an identity-path code)', { success: false, code: 'sdk_error', message: 'x', wallet: 'embedded' }],
  ['embedded thrown provider error (no code)', { success: false, code: null, message: 'socket hang up', wallet: 'embedded' }],
  ['embedded TIMEOUT', { success: false, code: 'TIMEOUT', message: 'Operation timed out', wallet: 'embedded' }],
  ['extension upstream_unavailable (meaning not established)', { success: false, code: 'upstream_unavailable', message: 'x', wallet: 'extension' }],
  ['no wallet marker, pre-send code', { success: false, code: 'identity_mismatch', message: 'x' }],
  ['unrecognized wallet marker', { success: false, code: 'locked', message: 'x', wallet: 'Embedded' }],
];

test('ambiguous or post-send answers stay unknown: the wallet stays blocked (not cancellable), nothing is re-requested and nothing is called rejected', async () => {
  for (const [label, outcome] of AMBIGUOUS) {
    const user = await linkedUser(h, WRITE);
    const { p } = await toReview(user, { proofUrl: 'https://x.com/ambiguous_case/status/3' });
    await asked(p);
    const r = await p.call('report', { outcome });
    assert.equal(r.body.status, 'readback_pending', label);
    assert.equal(r.body.walletOutcome.classification, 'unknown', label);
    assert.equal(r.body.walletOutcome.wallet, outcome.wallet === 'embedded' || outcome.wallet === 'extension' ? outcome.wallet : null, label);
    const blocked = await tool(h, user, 'start_identity_action', { idempotencyKey: key('blk'), action: 'add', kind: 'github', walletAddress: user.wallet.address });
    assert.equal(blocked.error, 'identity_operation_in_progress', label);
    assert.equal(blocked.details.status, 'readback_pending', label);
    assert.equal(blocked.details.cancellable, false, label);
    assert.match(blocked.message, /settled only by chain readback/, label);
    const cancel = await p.call('cancel');
    assert.equal(cancel.status, 409, label);
    assert.equal(cancel.body.error, 'invalid_state', label);
    assert.match(cancel.body.message, /only before the wallet is asked/, label);
    assert.equal((await p.call('request')).body.error, 'invalid_state', `${label}: never re-requested`);
    assert.equal((await p.call('view')).body.status, 'readback_pending', label);
  }
  // A lost answer whose write did land is settled by readback, not by a retry.
  const user = await linkedUser(h, WRITE);
  const post = 'https://x.com/landed_late/status/77';
  const { p } = await toReview(user, { proofUrl: post });
  await asked(p);
  assert.equal((await p.call('report', { outcome: AMBIGUOUS[0][1] })).body.status, 'readback_pending');
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'landed_late', proof: post });
  assert.equal((await p.call('view')).body.status, 'association_observed');
  await start(user, { action: 'add', kind: 'github' });
});

// ---------------------------------------------------------------- cancel before the wallet is asked

test('cancel before the wallet is asked, from every pre-wallet step; repeating it is harmless and the wallet is free afterwards', async () => {
  const user = await linkedUser(h, WRITE);
  const steps = [
    ['prepared', async () => {}],
    ['awaiting_wallet', async (p) => p.call('view')],
    ['awaiting_public_proof', async (p) => { await p.call('view'); await p.call('connected', { address: user.wallet.address }); }],
    ['review', async (p) => { await p.call('view'); await p.call('connected', { address: user.wallet.address }); await p.call('proof', { proofUrl: 'https://x.com/cancel_me/status/2' }); }],
  ];
  for (const [from, drive] of steps) {
    const s = await start(user, { action: 'add', kind: 'twitter' });
    const p = portal(s);
    await drive(p);
    const blocked = await tool(h, user, 'start_identity_action', { idempotencyKey: key('blk'), action: 'add', kind: 'github', walletAddress: user.wallet.address });
    assert.equal(blocked.error, 'identity_operation_in_progress', from);
    assert.equal(blocked.details.cancellable, true, from);
    assert.equal(blocked.details.operationId, s.operationId, from);
    assert.equal(blocked.details.expiresAt, s.expiresAt, from);
    assert.match(blocked.message, /cancel it on its portal page, or it expires at/, from);
    const wrongToken = await p.call('cancel', {}, { withToken: 'x'.repeat(43) });
    assert.equal(wrongToken.status, 404, from);
    const cancelled = await p.call('cancel');
    assert.equal(cancelled.status, 200, from);
    assert.equal(cancelled.body.status, 'cancelled', from);
    assert.match(cancelled.body.statusHelp, /before your wallet was asked/, from);
    assert.ok(!events(cancelled.body).includes('wallet_requested'), from);
    assert.equal(cancelled.body.history.at(-1).data.reason, 'cancelled by the user before the wallet was asked', from);
    const again = await p.call('cancel');
    assert.equal(again.status, 200, `${from}: repeat`);
    assert.equal(again.body.status, 'cancelled');
    assert.equal(again.body.history.length, cancelled.body.history.length, 'a repeat records nothing new');
    assert.equal((await p.call('request')).body.error, 'invalid_state', `${from}: no wallet request after cancel`);
    assert.equal((await p.call('view')).body.status, 'cancelled');
    // The next iteration's start proves the wallet is free.
  }
  // Remove cancelled at review: the association stays.
  h.chain.seedWeb2Identity(user.wallet.address, 'github', { username: 'keep-me', proof: 'https://gist.github.com/keep-me/1' });
  const rm = await toReview(user, { action: 'remove', kind: 'github', username: 'keep-me' });
  assert.equal((await rm.p.call('cancel')).body.status, 'cancelled');
  const ids = await tool(h, user, 'get_identities', { walletAddress: user.wallet.address });
  assert.ok(ids.wallets[0].claims.some((c) => c.kind === 'web2' && c.platform === 'github' && c.handle === 'keep-me'));
});

test('cancel is refused once the wallet was asked and after any outcome', async () => {
  const user = await linkedUser(h, WRITE);
  const post = 'https://x.com/asked_once/status/11';
  const { p } = await toReview(user, { proofUrl: post });
  await asked(p);
  const during = await p.call('cancel');
  assert.equal(during.status, 409);
  assert.deepEqual([during.body.error, during.body.details.status], ['invalid_state', 'wallet_requested']);
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'asked_once', proof: post });
  assert.equal((await p.call('report', { outcome: { success: true, wallet: 'embedded' } })).body.status, 'association_observed');
  assert.deepEqual((await p.call('cancel')).body.details, { status: 'association_observed' });

  const rej = await toReview(user, { proofUrl: 'https://x.com/asked_twice/status/12' });
  await asked(rej.p);
  await rej.p.call('report', { outcome: { success: false, code: 'user_rejected', message: 'not approved', wallet: 'embedded' } });
  assert.deepEqual((await rej.p.call('cancel')).body.details, { status: 'rejected_before_send' });
});

test('closed actions (failed_before_send, cancelled) survive a restart and do not block the wallet', async () => {
  const user = await linkedUser(h, WRITE);
  const f = await toReview(user, { proofUrl: 'https://x.com/restart_case/status/1' });
  await asked(f.p);
  await f.p.call('report', { outcome: { success: false, code: 'identity_mismatch', message: 'the proof belongs to someone_else', wallet: 'embedded' } });
  const c = portal(await start(user, { action: 'add', kind: 'github' }));
  await c.call('cancel');
  await h.restart();
  assert.equal((await f.p.call('view')).body.status, 'failed_before_send');
  assert.equal((await c.call('view')).body.status, 'cancelled');
  await start(user, { action: 'add', kind: 'twitter' });
});

// ---------------------------------------------------------------- deterministic clock

test('with a controllable clock: expiry still closes untouched actions, cancel of an expired action is harmless, and outcome_unknown after the window still blocks until readback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-closure-identity-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  try {
    let t = Date.parse('2026-10-04T00:00:00Z');
    const now = () => t;
    const accounts = createAccountService({ db, builtinIssuer: 'https://issuer.invalid/oauth', now });
    const ops = createOperationStore({ db, handoffSecret: 'x'.repeat(40), now });
    const coordinates = createCoordinateStore({ db, now });
    const state = { twitter: [] };
    const chain = { network: 'demos-testnet', evidenceMode: 'simulated-fixture', getIdentities: async () => ({ result: 200, response: { xm: {}, web2: structuredClone(state), ud: [], pqc: {} } }) };
    const actions = createIdentityActions({ config: { identityWrites: 'simulated-fixture-only' }, ops, accounts, coordinates, chain, now });
    const wallet = `0x${'2'.repeat(64)}`;
    const account = accounts.loginWithWallet({ address: wallet, challengeId: 'chl_test' });
    const to = (id, token) => ({ id, token });

    const stale = await actions.start({ accountId: account.id, idempotencyKey: 'stale-0001', action: 'add', kind: 'twitter' });
    t += 31 * 60 * 1000;
    const expired = actions.cancel(to(stale.operation.id, stale.handoffToken));
    assert.equal(expired.status, 'expired', 'cancel after expiry reports the expiry, unchanged');

    const live = await actions.start({ accountId: account.id, idempotencyKey: 'live-00001', action: 'add', kind: 'twitter' });
    await actions.opened(live.operation.id, live.handoffToken);
    actions.connected({ ...to(live.operation.id, live.handoffToken), address: wallet });
    await actions.submitProof({ ...to(live.operation.id, live.handoffToken), proofUrl: 'https://x.com/slow_clock/status/1' });
    actions.request(to(live.operation.id, live.handoffToken));
    const pending = await actions.report({ ...to(live.operation.id, live.handoffToken), outcome: { success: false, code: 'outcome_unknown', message: 'lost answer', wallet: 'embedded' } });
    assert.equal(pending.operation.status, 'readback_pending');
    t += 11 * 60 * 1000;
    assert.equal((await actions.opened(live.operation.id, live.handoffToken)).status, 'outcome_unknown');
    await assert.rejects(actions.start({ accountId: account.id, idempotencyKey: 'next-00001', action: 'add', kind: 'github' }),
      (e) => e.code === 'identity_operation_in_progress' && e.details.status === 'outcome_unknown' && e.details.cancellable === false);
    assert.throws(() => actions.cancel(to(live.operation.id, live.handoffToken)), (e) => e.code === 'invalid_state' && e.details.status === 'outcome_unknown');
    state.twitter.push({ username: 'slow_clock', proof: 'https://x.com/slow_clock/status/1' });
    assert.equal((await actions.opened(live.operation.id, live.handoffToken)).status, 'association_observed');
    const next = await actions.start({ accountId: account.id, idempotencyKey: 'next-00002', action: 'add', kind: 'github' });
    assert.equal(next.operation.status, 'prepared');
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
