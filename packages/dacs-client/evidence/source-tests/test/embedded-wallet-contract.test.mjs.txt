// Positive contract tests for the EXPERIMENTAL, default-off embedded wallet
// SDK seam (packet INTERFACE-CONTRACT "SDK seam"). Evidence: sdk-real (the
// shared sdk-provider.mjs driven by the Demos runtime from demos-runtime.mjs)
// plus the real server verifier (src/wallet). Approvals are a labelled
// source-aware adapter. Not a security review, not source-blind validation,
// not live/installed-wallet proof. Keys are fresh, synthetic and RAM-only.
//
// On an isolated checkout without the new modules every feature check is
// reported as TODO "BLOCKED: ..." (never pass/skip); set
// DACS_EMBEDDED_WALLET_REQUIRE=1 in the combined run to make absence fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SDK_MODULES, modulePresence, blockedUnless, importEmbeddedModule, extractSignature, assertNoSecrets,
  createLoginChallengeIssuer, createRecordingApprove, ADDRESS_RE, PUBLIC_KEY_RE, PUBLIC_ACCOUNT_KEYS,
} from './helpers/embedded-wallet-fixtures.mjs';

const presence = modulePresence(SDK_MODULES);
const gate = blockedUnless(presence);

// demos-runtime.mjs is a browser bundle: plain Node import fails with
// "window is not defined" (node-seal's web build locates itself via the
// document at import). As in test/embedded-wallet-sdk.test.mjs, provide only
// window/document.baseURI/location so the real bundle runs in Node. This is
// Node SDK evidence, NOT browser proof; the browser tests carry that. If the
// import still fails, the Node SDK proof is BLOCKED (reported, not hidden).
async function loadSeam(t) {
  if (!presence.present) throw new Error(`BLOCKED: combined candidate absent (missing ${presence.missing.join(', ')})`);
  const sdk = await importEmbeddedModule('sdk-provider.mjs');
  globalThis.window ??= globalThis;
  globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
  globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
  let runtime;
  try {
    runtime = await importEmbeddedModule('demos-runtime.mjs');
  } catch (error) {
    throw new Error(`BLOCKED: demos-runtime.mjs is not loadable in Node even with minimal browser globals (${error?.message ?? error}); browser test carries the SDK-real proof`);
  }
  t.diagnostic('evidence: Node + minimal browser-global fixture (not browser proof)');
  if (runtime.version) t.diagnostic(`demos-runtime version: ${runtime.version}`);
  return { sdk, runtime };
}

// validateMnemonic is the SDK's own check exported by demos-runtime.mjs; the
// seam refuses importMnemonic without it.
function newSession({ sdk, runtime }, extra = {}) {
  return sdk.createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, ...extra });
}

function assertPublicAccount(account) {
  assert.deepEqual(Object.keys(account).sort(), PUBLIC_ACCOUNT_KEYS, 'create/import return only public account fields');
  assert.match(account.address, ADDRESS_RE);
  assert.match(account.publicKey, PUBLIC_KEY_RE);
  assert.equal(account.address, `0x${account.publicKey}`, 'Demos address is the raw Ed25519 public key');
  assert.equal(account.network, 'unconfigured');
  assert.equal(account.evidenceMode, 'local-key-only');
}

test('contract surface: sdk-provider and demos-runtime exports [sdk-real]', gate, async (t) => {
  const { sdk, runtime } = await loadSeam(t);
  assert.equal(typeof sdk.createSdkWalletSession, 'function');
  assert.equal(typeof runtime.Demos, 'function', 'demos-runtime exports the upstream Demos class');
  assert.equal(typeof runtime.validateMnemonic, 'function', 'demos-runtime exports the SDK recovery-phrase check');
  t.diagnostic(`Identities exported: ${typeof runtime.Identities === 'function'}`);
  const session = newSession({ sdk, runtime });
  for (const name of ['create', 'importMnemonic', 'getPublicAccount', 'exportMnemonicForUser', 'request', 'lock', 'isLocked']) {
    assert.equal(typeof session[name], 'function', `session.${name}`);
  }
  assert.equal(session.isLocked(), true, 'a fresh session holds no wallet authority');
});

test('create and import of the exported mnemonic yield the same public account [sdk-real]', gate, async (t) => {
  const seam = await loadSeam(t);
  const first = newSession(seam);
  const created = await first.create();
  assertPublicAccount(created);
  assert.deepEqual(first.getPublicAccount(), created);
  assert.equal(first.isLocked(), false);
  const mnemonic = first.exportMnemonicForUser();
  assert.equal(typeof mnemonic, 'string');
  assert.equal(mnemonic.trim().split(/\s+/).length, 24, 'default strength 256 gives a 24-word phrase');

  const second = newSession(seam);
  const imported = await second.importMnemonic(mnemonic);
  assertPublicAccount(imported);
  assert.deepEqual(imported, created, 'import reproduces the created account exactly');

  const other = await newSession(seam).create();
  assert.notEqual(other.address, created.address, 'each create uses fresh key material');
  const short = newSession(seam);
  assertPublicAccount(await short.create({ strength: 128 }));
  assert.equal(short.exportMnemonicForUser().trim().split(/\s+/).length, 12, 'strength 128 gives a 12-word phrase');

  assertNoSecrets([created, imported, first.getPublicAccount(), second.getPublicAccount()], [mnemonic], 'public account objects');
  for (const s of [first, second, short]) s.lock();
});

test('connect returns only the public address; approved sign over the exact wallet-login challenge is accepted by the server verifier [sdk-real + real verifier]', gate, async (t) => {
  const seam = await loadSeam(t);
  const approval = createRecordingApprove(() => true);
  const session = newSession(seam, { approve: approval.approve });
  const account = await session.create();
  const mnemonic = session.exportMnemonicForUser();

  const connected = await session.request({ method: 'connect' });
  assert.equal(connected.success, true);
  const connectedAddress = typeof connected.data === 'string' ? connected.data : connected.data?.address;
  assert.equal(connectedAddress, account.address);
  if (typeof connected.data === 'object') assert.deepEqual(Object.keys(connected.data), ['address'], 'connect data is only the public address');

  const issuer = createLoginChallengeIssuer();
  try {
    const challenge = issuer.issue(account.address);
    const signed = await session.request({ method: 'sign', params: [challenge.message] });
    assert.equal(signed.success, true, `sign failed: ${signed.error?.message ?? ''}`);
    const signature = extractSignature(signed);
    assert.equal(typeof signature, 'string');
    assert.equal(issuer.verifyOnly({ address: account.address, message: challenge.message, signature }), true, 'raw-message Ed25519 signature verifies');
    const consumed = issuer.verifyAndConsume(challenge.challengeId, signature);
    assert.equal(consumed.address, account.address, 'the challenge service accepts and consumes the signature');
    assert.equal(approval.requests.length, 1, 'exactly one approval for one signature');
    const nonceLine = challenge.message.split('\n').find((line) => line.startsWith('nonce: '));
    assert.ok(approval.requests[0].includes(nonceLine) && approval.requests[0].includes('purpose: account-login'), 'the approval request carries the exact message');
    assertNoSecrets([connected, signed, ...approval.requests], [mnemonic], 'provider responses and approval requests');
  } finally {
    issuer.close();
    session.lock();
  }
});

test('signing needs an explicit approval callback that says yes [sdk-real + source-aware approval adapter]', gate, async (t) => {
  const seam = await loadSeam(t);
  const message = 'embedded wallet approval check';
  const unapproved = newSession(seam);
  await unapproved.create();
  const noApprove = await unapproved.request({ method: 'sign', params: [message] });
  assert.equal(noApprove.success, false, 'no approve callback: no signature');
  assert.equal(extractSignature(noApprove) ?? null, null);

  const declined = createRecordingApprove(() => false);
  const session = newSession(seam, { approve: declined.approve });
  await session.create();
  const res = await session.request({ method: 'sign', params: [message] });
  assert.equal(res.success, false, 'declined approval: no signature');
  assert.equal(declined.requests.length, 1);
  unapproved.lock();
  session.lock();
});

test('lock discards live wallet authority [sdk-real]', gate, async (t) => {
  const seam = await loadSeam(t);
  const approval = createRecordingApprove(() => true);
  const session = newSession(seam, { approve: approval.approve });
  await session.create();
  const mnemonic = session.exportMnemonicForUser();
  session.lock();
  assert.equal(session.isLocked(), true);
  const res = await session.request({ method: 'sign', params: ['after lock'] });
  assert.equal(res.success, false, 'a locked session cannot sign');
  assert.equal(approval.requests.length, 0, 'no approval is asked for while locked');
  let exported;
  try {
    exported = session.exportMnemonicForUser();
  } catch {
    exported = null;
  }
  assert.notEqual(exported, mnemonic, 'the backup phrase is gone after lock');
});

test('transactions and identity writes are unavailable by default (no transport injected) [sdk-real]', gate, async (t) => {
  const seam = await loadSeam(t);
  const approval = createRecordingApprove(() => true);
  const session = newSession(seam, { approve: approval.approve });
  await session.create();
  const mnemonic = session.exportMnemonicForUser();
  const calls = [
    ['sendTransaction', [{ simulated: 'not-a-real-transaction' }]],
    ['addGithubIdentity', ['https://gist.github.com/fixture-user/0000']],
    ['addTwitterIdentity', ['https://x.com/fixture_user/status/1']],
    ['removeWeb2Identity', [{ context: 'github', username: 'fixture-user' }]],
  ];
  for (const [method, params] of calls) {
    const res = await session.request({ method, params });
    assert.equal(res.success, false, `${method} is default-off`);
    assert.ok(res.error, `${method} reports an explicit unsupported/not-configured error`);
    assertNoSecrets([res], [mnemonic], `${method} response`);
  }
  session.lock();
});

// SDK 4.0.16's public connect(rpcUrl) seam now uses the configured same-origin
// loopback relay. Replace the obsolete unsupported-seam TODO with actual
// bundled-SDK lifecycle evidence. This remains simulated, not live proof.
test('loopback transactionTransport lifecycle: real bundled SDK sends once, then lock removes authority [loopback-simulated]', gate, async (t) => {
  const seam = await loadSeam(t);
  const { startHarness } = await import('./helpers/harness.mjs');
  const { createEphemeralWallet } = await import('./fixtures/wallet.mjs');
  const { buildNativeTransferPayload } = await import('../src/dacs/wallet-transactions.mjs');
  const { startSdkChainFixture, fetchProfile, transportFromProfile } = await import('./helpers/embedded-wallet-flow-fixtures.mjs');
  const chain = await startSdkChainFixture();
  let h;
  let session;
  try {
    h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
    const profile = await fetchProfile(h);
    assert.equal(profile.writes, 'simulated-loopback');
    const approval = createRecordingApprove(() => true);
    session = newSession(seam, { approve: approval.approve, transactionTransport: transportFromProfile(h, profile) });
    const account = await session.create();
    const payload = buildNativeTransferPayload({ from: account.address, to: createEphemeralWallet().address, amountOs: '1000000000', nonce: 1, timestamp: Date.now(), encoding: 'os-string' });
    const res = await session.request({ method: 'sendTransaction', params: [payload] });
    assert.equal(res.success, true);
    assert.equal(approval.requests.length, 1);
    assert.deepEqual(chain.record.broadcastAttempts, [res.data.hash]);
    assert.equal(chain.nonceOf(account.address), 1);
    session.lock();
    const locked = await session.request({ method: 'sendTransaction', params: [payload] });
    assert.equal(locked.success, false);
    assert.equal(locked.error.code, 'locked');
    assert.deepEqual(chain.record.broadcastAttempts, [res.data.hash], 'lock must not allow another send');
  } finally {
    session?.lock();
    if (h) await h.close();
    else await chain.close();
  }
});
