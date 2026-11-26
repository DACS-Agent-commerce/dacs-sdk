// The seller doctor's read-only node connection and balance read: one transport owner over a canonical node root, with the
// fixed seller transport authority, the production connection reader and the client's observer, and an exact OS balance read
// over that owner. Nothing here opens a wallet, key, journal or lock, and the node is a scripted TP-1 node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile, canonicalNodeEndpoint } from '@kynesyslabs/dacs/wire';
import { createNodeTransportOwner } from '@kynesyslabs/dacs-client/node-wallet';
import { keyRecordBytes, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';

const { jsonResponse, scriptedNode } = await import('./helpers/kit-wallet-session.mjs');
const { createSellerWalletSession, portOptions } = await import('./helpers/seller-wallet-session-world.mjs');
const { openDoctorNode, readSellerBalance } = await import('../src/devnet-demo/doctor-node.mjs');
const { SELLER_TRANSPORT_AUTHORITY } = await import('../src/devnet-demo/connection-authority.mjs');
const { WalletFormatError } = await import('../../dacs-client/src/signatures.mjs');

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const HTTPS_ROOT = 'https://rpc.example.invalid/', HTTP_ROOT = 'http://rpc.example.invalid/';
const SELLER_CLAIM = `did:demos:agent:${'1'.repeat(64)}`;
const ADDRESS = `0x${'ab'.repeat(32)}`;
const BALANCE_CAP = 65_536;
const codesOf = (error) => { const codes = []; for (let link = error; link instanceof Error; link = link.cause) codes.push(link.code); return codes; };
const refusalOf = (promise) => promise.then(() => assert.fail('expected a refusal'), (error) => error);

// A doctor over a scripted node; `balance(call)` answers getAddressInfo (a Response, or a value sent as the node's response).
function doctorWorld(t, { rpcUrl = HTTPS_ROOT, balance = () => ({ balance: '2481500000000' }) } = {}) {
  const node = scriptedNode();
  node.urls = [];
  const fetch = node.fetch;
  node.fetch = (url, init) => { node.urls.push({ url: String(url), redirect: init?.redirect }); return fetch(url, init); };
  node.intercept = async ({ call }) => {
    if (call.message !== 'getAddressInfo') return undefined;
    const answer = await balance(call);
    return answer instanceof Response ? answer : jsonResponse(JSON.stringify({ result: 200, response: answer, require_reply: false, extra: null }));
  };
  const doctor = openDoctorNode({ rpcUrl, sellerClaim: SELLER_CLAIM, fetchImpl: node.fetch });
  t.after(() => doctor.close());
  return { node, doctor };
}

test('openDoctorNode makes one owner with the production reader, fixed transport authority and observer; bindTp1Profile admits the approved chain and close is idempotent. A module-resolve hook in the seller suite records the doctor import closure under its Node 22/24 runner and asserts it contains neither node:sqlite nor better-sqlite3 nor seller-node-wallet.mjs nor durable-journal.mjs', async (t) => {
  const { doctor } = doctorWorld(t);
  assert.deepEqual(Object.keys(doctor).sort(), ['close', 'observer', 'owner', 'readAuthority']);
  assert.ok(Object.isFrozen(doctor) && Object.isFrozen(doctor.observer));
  assert.equal(SELLER_TRANSPORT_AUTHORITY, 'dacs-seller-tp1-node');
  assert.deepEqual({ endpoint: doctor.owner.currentLocal().endpoint, transportAuthority: doctor.owner.currentLocal().transportAuthority },
    { endpoint: HTTPS_ROOT, transportAuthority: SELLER_TRANSPORT_AUTHORITY });
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: doctor.owner.currentLocal(), readAuthority: doctor.readAuthority });
  assert.equal(binding.profile.chainIdentity, CHAIN);
  const observed = await doctor.observer.observe();
  assert.deepEqual({ chainIdentity: observed.chainIdentity, connectionId: observed.local.connectionId }, { chainIdentity: CHAIN, connectionId: doctor.owner.currentLocal().connectionId });
  assert.equal(doctor.observer.provenance(), observed.provenance);
  doctor.close();
  doctor.close();
  assert.throws(() => doctor.owner.currentLocal(), { code: 'transport_closed' });

  const hook = new URL('./helpers/import-closure-hook.mjs', import.meta.url).href, target = new URL('../src/devnet-demo/doctor-node.mjs', import.meta.url).href;
  const probe = `import { register } from 'node:module'; import { MessageChannel } from 'node:worker_threads';
    const { port1, port2 } = new MessageChannel(), seen = [];
    port1.on('message', (url) => seen.push(url));
    register(${JSON.stringify(hook)}, { data: { port: port2 }, transferList: [port2] });
    await import(${JSON.stringify(target)});
    await new Promise((resolve) => setTimeout(resolve, 100));
    port1.close();
    console.log(JSON.stringify(seen));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', cwd: fileURLToPath(new URL('../', import.meta.url)) });
  assert.equal(child.status, 0, child.stderr);
  const closure = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.ok(closure.some((url) => url.endsWith('/connection-authority.mjs')), 'the hook saw the doctor\'s own imports');
  assert.deepEqual(closure.filter((url) => /node:sqlite|better-sqlite3|seller-node-wallet\.mjs|durable-journal\.mjs/.test(url)), []);
});

test('at the merged build base and through the installed `@kynesyslabs/dacs/wire` export, canonicalNodeEndpoint returns the unchanged canonical HTTP root with TP1_APPROVED_IDENTITY_RECORD.chainIdentity, returns null for HTTP with another or missing identity and for path-bearing or noncanonical roots, and retains canonical HTTPS behavior; openDoctorNode passes that identity to the updated client owner and admits that HTTP root, while direct createNodeTransportOwner with another or missing identity throws OperationError(\'transport_mismatch\'); the bound read checks the live node identity; a mutant that drops the identity condition fails; missing claim and invalid fetch refuse before network access', async (t) => {
  assert.equal(canonicalNodeEndpoint(HTTP_ROOT, { chainIdentity: CHAIN }), HTTP_ROOT);
  for (const chainIdentity of ['d'.repeat(64), undefined]) assert.equal(canonicalNodeEndpoint(HTTP_ROOT, { chainIdentity }), null, String(chainIdentity));
  for (const root of ['http://rpc.example.invalid/rpc', 'http://rpc.example.invalid', 'http://u:p@rpc.example.invalid/', 'http://RPC.example.invalid/']) {
    assert.equal(canonicalNodeEndpoint(root, { chainIdentity: CHAIN }), null, root);
  }
  for (const chainIdentity of [CHAIN, undefined]) assert.equal(canonicalNodeEndpoint(HTTPS_ROOT, { chainIdentity }), HTTPS_ROOT);

  const { node, doctor } = doctorWorld(t, { rpcUrl: HTTP_ROOT });
  assert.equal(doctor.owner.currentLocal().endpoint, HTTP_ROOT);
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: doctor.owner.currentLocal(), readAuthority: doctor.readAuthority });
  assert.equal(binding.local.endpoint, HTTP_ROOT);
  assert.ok(node.calls.includes('getBlockByNumber'), 'the bound read asked the live node for its chain');
  for (const chainIdentity of ['d'.repeat(64), undefined]) {
    assert.throws(() => createNodeTransportOwner({ endpoint: HTTP_ROOT, transportAuthority: SELLER_TRANSPORT_AUTHORITY, fetchImpl: node.fetch, chainIdentity }),
      { name: 'OperationError', code: 'transport_mismatch' }, String(chainIdentity));
  }
  const calls = node.calls.length;
  for (const options of [{ sellerClaim: '' }, { sellerClaim: undefined }, { fetchImpl: 'not-a-function' }, { rpcUrl: 'http://rpc.example.invalid/rpc' }, { rpcUrl: 'ftp://rpc.example.invalid/' }]) {
    assert.throws(() => openDoctorNode({ rpcUrl: HTTP_ROOT, sellerClaim: SELLER_CLAIM, fetchImpl: node.fetch, ...options }), TypeError, JSON.stringify(options));
  }
  assert.equal(node.calls.length, calls, 'nothing reached the node');
});

test('after close, every doctor reader and balance member refuses transport_closed; after failed construction, the opened owner closes and no member survives. Neither path reaches a wallet, key, journal or fixture transport', async (t) => {
  const { node, doctor } = doctorWorld(t);
  const local = doctor.owner.currentLocal();
  doctor.close();
  const calls = node.calls.length;
  for (const [name, read] of Object.entries({
    readAuthority: () => doctor.readAuthority({ local, sessionId: null, participants: [] }),
    observe: () => doctor.observer.observe(),
    readNodeInfo: () => doctor.observer.readNodeInfo('getNetworkInfo'),
    provenance: async () => doctor.observer.provenance(),
    readSellerBalance: () => readSellerBalance({ owner: doctor.owner, address: ADDRESS }),
  })) assert.equal((await refusalOf(read())).code, 'transport_closed', name);
  assert.equal(node.calls.length, calls, 'no read reached the node after close');

  // The observer's construction fails after the owner opened: the owner it opened is closed and nothing is returned.
  const freeze = Object.freeze, opened = [];
  let failed = false;
  t.mock.method(Object, 'freeze', (value) => {
    if (typeof value?.acquireConnectionFence === 'function' && typeof value.currentLocal === 'function') opened.push(value);
    if (!failed && typeof value?.readNodeInfo === 'function' && typeof value.observe === 'function') { failed = true; throw new Error('TEST-observer-construction-failed'); }
    return freeze(value);
  });
  assert.throws(() => openDoctorNode({ rpcUrl: HTTPS_ROOT, sellerClaim: SELLER_CLAIM, fetchImpl: node.fetch }), /TEST-observer-construction-failed/);
  t.mock.restoreAll();
  assert.equal(opened.length, 1, 'one owner was opened');
  assert.throws(() => opened[0].currentLocal(), { code: 'transport_closed' });
  assert.equal(node.calls.length, calls);
});

test('readSellerBalance returns the exact OS string at 65,536 bytes, fails at 65,537 before JSON decode, and refuses a malformed address as seller_balance_malformed with WalletFormatError cause; malformed, missing, negative and fractional balances, unavailable and timed-out reads use their named refusal codes', async (t) => {
  // A node reply of exactly `size` bytes whose balance is `balance`.
  const sized = (size, balance) => {
    const head = `{"result":200,"response":{"balance":"${balance}","pad":"`, tail = '"},"require_reply":false,"extra":null}';
    return new Response(head + 'x'.repeat(size - head.length - tail.length) + tail, { headers: { 'content-type': 'application/json' } });
  };
  let reply = () => sized(BALANCE_CAP, '2481500000000');
  const { doctor } = doctorWorld(t, { balance: () => reply() });
  const read = (address = ADDRESS.toUpperCase().replace('0X', '0x')) => readSellerBalance({ owner: doctor.owner, address });
  assert.deepEqual(await read(), { address: ADDRESS, balanceOs: '2481500000000' });
  reply = () => sized(BALANCE_CAP + 1, '2481500000000');
  assert.deepEqual(codesOf(await refusalOf(read())), ['seller_balance_malformed', 'response_byte_limit']);
  const notAnAddress = await refusalOf(read('0x1234'));
  assert.deepEqual({ code: notAnAddress.code, cause: notAnAddress.cause instanceof WalletFormatError }, { code: 'seller_balance_malformed', cause: true });

  const answers = { exactNumber: [{ balance: 42 }, '42'] };
  for (const [label, [response, balanceOs]] of Object.entries(answers)) { reply = () => response; assert.equal((await read()).balanceOs, balanceOs, label); }
  for (const response of [{ balance: 'abc' }, {}, { balance: '-1' }, { balance: -1 }, { balance: '1.5' }, { balance: 1.5 }, { balance: '01' }, null]) {
    reply = () => response;
    assert.equal((await refusalOf(read())).code, 'seller_balance_malformed', JSON.stringify(response));
  }
  const refusals = {
    seller_balance_unavailable: [() => new Response('busy', { status: 503 }), () => jsonResponse(JSON.stringify({ result: 500, response: 'TEST-node-error', require_reply: false, extra: null }))],
    seller_balance_malformed: [() => new Response('{"result":', { headers: { 'content-type': 'application/json' } }), () => new Response('<html>', { headers: { 'content-type': 'text/html' } })],
    seller_balance_timeout: [() => { throw new DOMException('TEST-deadline', 'TimeoutError'); }],
  };
  for (const [code, replies] of Object.entries(refusals)) for (const next of replies) {
    reply = next;
    const error = await refusalOf(read());
    assert.equal(error.code, code);
    assert.ok(error.cause instanceof Error || code !== 'seller_balance_timeout', 'the cause is kept');
  }
});

test('readSellerBalance uses the same owner as the pin; abort and close refuse. The client helper\'s one generation check refuses a changed `connectionId` in an injected fake owner; no signer, wallet, file, journal or fence is touched', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  let gate = null;
  const { node, doctor } = doctorWorld(t, { balance: async () => { await gate; return { balance: '7' }; } });
  await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: doctor.owner.currentLocal(), readAuthority: doctor.readAuthority });
  assert.equal((await readSellerBalance({ owner: doctor.owner, address: ADDRESS })).balanceOs, '7');
  assert.ok(node.urls.every(({ url, redirect }) => url === HTTPS_ROOT && redirect === 'error'), 'every read went through the owner to its own root');
  const stopped = new AbortController();
  stopped.abort(new Error('TEST-stopped'));
  await assert.rejects(readSellerBalance({ owner: doctor.owner, address: ADDRESS, signal: stopped.signal }), /TEST-stopped/);

  let open;
  gate = new Promise((resolve) => { open = resolve; });
  const reading = refusalOf(readSellerBalance({ owner: doctor.owner, address: ADDRESS }));
  await new Promise((resolve) => setImmediate(resolve));
  doctor.close();
  open();
  assert.equal((await reading).code, 'transport_closed', 'a close during the read refuses its answer');

  const ids = ['TEST-connection-1', 'TEST-connection-2'];
  const fakeOwner = { currentLocal: () => ({ endpoint: HTTPS_ROOT, transportAuthority: SELLER_TRANSPORT_AUTHORITY, connectionId: ids.shift() ?? 'TEST-connection-3' }),
    fetchImpl: async () => jsonResponse(JSON.stringify({ result: 200, response: { balance: '7' }, require_reply: false, extra: null })) };
  assert.equal((await refusalOf(readSellerBalance({ owner: fakeOwner, address: ADDRESS }))).code, 'seller_balance_connection_changed');
  assert.equal(signatures.length, 0);
});

test('the production seller port given a canonical plain-HTTP root, with the approved testnet identity present, refuses `transport_mismatch` from its three-argument `createNodeTransportOwner` call before binding, with no signature or publication; the doctor\'s HTTP acceptance is unchanged; passing `chainIdentity` at the port\'s owner call fails this test', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const node = scriptedNode();
  let keyLoads = 0;
  const options = await portOptions(node, async () => { keyLoads += 1; return keyRecordBytes(); }, { endpoint: HTTP_ROOT });
  assert.equal(canonicalNodeEndpoint(HTTP_ROOT, { chainIdentity: CHAIN }), HTTP_ROOT, 'the approved identity would admit this root');
  assert.throws(() => createSellerWalletSession(options), { name: 'OperationError', code: 'transport_mismatch' });
  assert.deepEqual({ calls: node.calls.length, keyLoads, signatures: signatures.length }, { calls: 0, keyLoads: 0, signatures: 0 });
  const doctor = openDoctorNode({ rpcUrl: HTTP_ROOT, sellerClaim: SELLER_CLAIM, fetchImpl: node.fetch });
  t.after(() => doctor.close());
  assert.equal(doctor.owner.currentLocal().endpoint, HTTP_ROOT, 'the doctor still admits the HTTP testnet root');
});
