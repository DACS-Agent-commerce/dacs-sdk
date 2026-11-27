// The client's read-only qualification source, built over the seller doctor's node owner once TP-1 is bound: a registered
// declaration of the binding's own publications and an observer over the same owner. Nothing here opens a wallet, key,
// journal or lock, the purchase hold stays on, and the node is a scripted TP-1 node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile, canonicalNodeEndpoint } from '@kynesyslabs/dacs/wire';
import { createNodeTransportOwner, createQualificationObserverSource, tp1AuthorityLabel } from '@kynesyslabs/dacs-client/node-wallet';
import { purchaseActionsAdmitted } from '../../dacs-client/src/public-admission.mjs';
import { isDevnetDemoTransport, isQualificationObserverSource } from '../src/dacs/devnet-source.mjs';
import { createConnectionAuthorityReader, SELLER_TRANSPORT_AUTHORITY } from '../src/devnet-demo/connection-authority.mjs';
import { openDoctorNode } from '../src/devnet-demo/doctor-node.mjs';
import { jsonResponse, scriptedNode } from './helpers/kit-wallet-session.mjs';

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const HTTPS_ROOT = 'https://rpc.example.invalid/', HTTP_ROOT = 'http://rpc.example.invalid/';
const SELLER_CLAIM = `did:demos:agent:${'1'.repeat(64)}`;
const T0 = 1793102400000;
const REPLY_BYTE_LIMIT = 4 * 1024 * 1024;
const READ_DEADLINE_MS = 10_000;
const NETWORK_INFO = Object.freeze({ nodeVersion: { name: 'TEST-node', version: '0.0.0-test', commit: 'c'.repeat(40), dirty: false } });
const nodeAnswer = (response, result = 200) => jsonResponse(JSON.stringify({ result, response, require_reply: false, extra: null }));
const refusalOf = (promise) => promise.then(() => assert.fail('expected a refusal'), (error) => error);
const causesOf = (error) => { const chain = []; for (let link = error; link instanceof Error; link = link.cause) chain.push(link); return chain; };

// A doctor owner over a scripted node, bound to the approved TP-1 record; `node.networkInfo()` answers getNetworkInfo.
async function boundDoctor(t, { rpcUrl = HTTPS_ROOT } = {}) {
  const node = scriptedNode();
  node.networkInfo = () => nodeAnswer(NETWORK_INFO);
  node.intercept = ({ call }) => (call.message === 'getNetworkInfo' ? node.networkInfo() : undefined);
  const doctor = openDoctorNode({ rpcUrl, sellerClaim: SELLER_CLAIM, fetchImpl: node.fetch });
  t.after(() => doctor.close());
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: doctor.owner.currentLocal(), readAuthority: doctor.readAuthority });
  return { node, doctor, binding };
}

async function boundSource(t) {
  const world = await boundDoctor(t);
  const made = await createQualificationObserverSource({ owner: world.doctor.owner, binding: world.binding, clock: { now: () => T0 } });
  return { ...world, made };
}

test('a bound doctor owner yields a registered read-only source declaring the binding\'s TP-1 label for each publication, and an observer over the same owner, while the purchase hold is on', async (t) => {
  const { node, doctor, binding, made } = await boundSource(t);
  assert.equal(purchaseActionsAdmitted(), false, 'the purchase hold is on');
  assert.deepEqual(Object.keys(made).sort(), ['currentLocal', 'observer', 'source']);
  assert.ok(Object.isFrozen(made) && Object.isFrozen(made.source) && Object.isFrozen(made.observer));
  assert.equal(made.currentLocal, doctor.owner.currentLocal);
  const authority = tp1AuthorityLabel(binding);
  assert.deepEqual(made.source, { settlementPublication: { authority }, deliveryPublication: { authority }, demoArtifactPublication: { authority } });
  for (const publication of Object.values(made.source)) assert.ok(Object.isFrozen(publication));
  assert.deepEqual(Object.keys(made.observer).sort(), ['observe', 'provenance', 'readNodeInfo']);
  assert.equal(isQualificationObserverSource(made.source, { binding, currentLocal: made.currentLocal, observer: made.observer }), true);
  assert.equal(isDevnetDemoTransport(made.source), false, 'the source is not a transport any write adapter accepts');

  const observed = await made.observer.observe();
  assert.deepEqual({ chainIdentity: observed.chainIdentity, connectionId: observed.local.connectionId }, { chainIdentity: CHAIN, connectionId: doctor.owner.currentLocal().connectionId });
  assert.equal(made.observer.provenance(), observed.provenance);
  assert.deepEqual(await made.observer.readNodeInfo('getNetworkInfo'), NETWORK_INFO);
  assert.equal(purchaseActionsAdmitted(), false, 'the purchase hold is still on');
  assert.deepEqual([...new Set(node.calls)].sort(), ['getBlockByNumber', 'getNetworkInfo'], 'only node reads were sent');
});

test('the qualification source check accepts only the registered source with the binding, currentLocal and observer it was made with', async (t) => {
  const first = await boundSource(t), second = await boundSource(t);
  const own = { binding: first.binding, currentLocal: first.made.currentLocal, observer: first.made.observer };
  assert.equal(isQualificationObserverSource(first.made.source, own), true);
  for (const [name, expected] of Object.entries({
    'another binding': { ...own, binding: second.binding },
    'a copied binding': { ...own, binding: { ...first.binding } },
    'another owner\'s currentLocal': { ...own, currentLocal: second.made.currentLocal },
    'another source\'s observer': { ...own, observer: second.made.observer },
    'the doctor\'s own observer': { ...own, observer: first.doctor.observer },
    'no members': {},
  })) assert.equal(isQualificationObserverSource(first.made.source, expected), false, name);
  const label = first.made.source.settlementPublication.authority;
  for (const [name, forged] of Object.entries({
    'a spread copy': { ...first.made.source },
    'a structured clone': structuredClone(first.made.source),
    'the label string': label,
    'another source': second.made.source,
    'null': null,
  })) assert.equal(isQualificationObserverSource(forged, own), false, name);
});

test('constructing a qualification source refuses a binding of another connection, a missing or copied binding, an owner the client did not make and a closed owner', async (t) => {
  const first = await boundDoctor(t), second = await boundDoctor(t);
  const codeOf = async (options) => (await refusalOf(createQualificationObserverSource(options))).code;
  assert.equal(await codeOf({ owner: first.doctor.owner, binding: second.binding }), 'tp1_local_binding_changed');
  assert.equal(await codeOf({ owner: first.doctor.owner }), 'tp1_binding_required');
  assert.equal(await codeOf({ owner: first.doctor.owner, binding: { ...first.binding } }), 'tp1_binding_required');
  assert.equal(await codeOf({ owner: { ...first.doctor.owner }, binding: first.binding }), 'transport_mismatch');
  assert.equal(await codeOf({ binding: first.binding }), 'transport_mismatch');
  first.doctor.close();
  assert.equal(await codeOf({ owner: first.doctor.owner, binding: first.binding }), 'transport_closed');
});

test('a node that stops answering while the binding is checked refuses the construction tp1_authority_timeout with the timer as cause', async (t) => {
  const { node, doctor, binding } = await boundDoctor(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  node.intercept = () => new Promise(() => {});
  const outcome = refusalOf(createQualificationObserverSource({ owner: doctor.owner, binding }));
  await new Promise(setImmediate);
  t.mock.timers.tick(READ_DEADLINE_MS);
  const error = await outcome;
  assert.equal(error.code, 'tp1_authority_timeout');
  assert.equal(error.cause?.kind, 'timeout');
});

test('a canonical HTTP node root makes a qualification source only with the approved testnet chain identity; without it the client owner refuses transport_mismatch', async (t) => {
  assert.equal(canonicalNodeEndpoint(HTTP_ROOT, { chainIdentity: CHAIN }), HTTP_ROOT);
  const node = scriptedNode();
  const owner = createNodeTransportOwner({ endpoint: HTTP_ROOT, transportAuthority: SELLER_TRANSPORT_AUTHORITY, fetchImpl: node.fetch, chainIdentity: CHAIN });
  t.after(() => owner.close());
  const { connectionAuthority } = createConnectionAuthorityReader({ owner, claim: () => SELLER_CLAIM });
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(), readAuthority: connectionAuthority });
  assert.equal(binding.local.endpoint, HTTP_ROOT);
  const made = await createQualificationObserverSource({ owner, binding });
  assert.equal(isQualificationObserverSource(made.source, { binding, currentLocal: made.currentLocal, observer: made.observer }), true);
  assert.equal((await made.observer.observe()).local.endpoint, HTTP_ROOT);

  const calls = node.calls.length;
  for (const chainIdentity of [undefined, 'd'.repeat(64)]) {
    assert.equal(canonicalNodeEndpoint(HTTP_ROOT, { chainIdentity }), null);
    assert.throws(() => createNodeTransportOwner({ endpoint: HTTP_ROOT, transportAuthority: SELLER_TRANSPORT_AUTHORITY, fetchImpl: node.fetch, chainIdentity }),
      { name: 'OperationError', code: 'transport_mismatch' }, String(chainIdentity));
  }
  assert.equal(node.calls.length, calls, 'nothing reached the node');
});

test('after the owner closes, every read through the source refuses with transport_closed as the error or its cause, without reaching the node', async (t) => {
  const { node, doctor, made } = await boundSource(t);
  doctor.close();
  const calls = node.calls.length;
  for (const [name, read] of Object.entries({
    observe: () => made.observer.observe(),
    readNodeInfo: () => made.observer.readNodeInfo('getNetworkInfo'),
    provenance: async () => made.observer.provenance(),
    currentLocal: async () => made.currentLocal(),
  })) {
    const error = await refusalOf(read());
    assert.ok(causesOf(error).some((link) => link.code === 'transport_closed'), `${name}: ${String(error)}`);
  }
  assert.equal(node.calls.length, calls);
});

test('a node reply over 4 MiB is refused before decoding with the byte-limit error as cause', async (t) => {
  const { node, made } = await boundSource(t);
  node.networkInfo = () => nodeAnswer('x'.repeat(REPLY_BYTE_LIMIT));
  const error = await refusalOf(made.observer.readNodeInfo('getNetworkInfo'));
  assert.ok(causesOf(error).some((link) => link.code === 'response_byte_limit'), String(error));
});

test('a stalled node read through the source\'s observer refuses tp1_authority_timeout with the timer as cause', async (t) => {
  const { node, made } = await boundSource(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  node.networkInfo = () => new Promise(() => {});
  const outcome = refusalOf(made.observer.readNodeInfo('getNetworkInfo'));
  await new Promise(setImmediate);
  t.mock.timers.tick(READ_DEADLINE_MS);
  const error = await outcome;
  assert.equal(error.code, 'tp1_authority_timeout');
  assert.equal(error.cause?.kind, 'timeout');
});

test('an unavailable node is refused upstream_unavailable, a failed fetch keeps its own error, and any message but the two node-info reads is refused readonly_only', async (t) => {
  const { node, made } = await boundSource(t);
  node.networkInfo = () => nodeAnswer('TEST-unavailable', 503);
  assert.equal((await refusalOf(made.observer.readNodeInfo('getNetworkInfo'))).code, 'upstream_unavailable');
  const failure = new Error('TEST-node-unreachable');
  node.networkInfo = () => { throw failure; };
  assert.ok(causesOf(await refusalOf(made.observer.readNodeInfo('getNetworkInfo'))).includes(failure));
  const calls = node.calls.length;
  for (const message of ['getAddressNonce', 'execute', 'getBlockByNumber']) {
    assert.equal((await refusalOf(made.observer.readNodeInfo(message))).code, 'readonly_only', message);
  }
  assert.equal(node.calls.length, calls, 'a refused message reached no node');
});

test('binding, making the source and reading through it run with file writes denied and send only node reads', () => {
  // File reads and worker threads (the suite's module loader hook runs in one) stay allowed; every file write is denied.
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  const probe = `import { writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
    import { createQualificationObserverSource } from '@kynesyslabs/dacs-client/node-wallet';
    import { openDoctorNode } from './src/devnet-demo/doctor-node.mjs';
    const sent = [];
    const answer = (response) => new Response(JSON.stringify({ result: 200, response, require_reply: false, extra: null }), { headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body), call = body.params[0];
      sent.push(body.method + ':' + (call.message ?? call.extra));
      if (call.message === 'getNetworkInfo') return answer(${JSON.stringify(NETWORK_INFO)});
      const chain = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
      return answer(call.data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: chain, content: {} }
        : { number: call.data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64), content: { previousHash: chain } });
    };
    const doctor = openDoctorNode({ rpcUrl: ${JSON.stringify(HTTPS_ROOT)}, sellerClaim: ${JSON.stringify(SELLER_CLAIM)}, fetchImpl });
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: doctor.owner.currentLocal(), readAuthority: doctor.readAuthority });
    const made = await createQualificationObserverSource({ owner: doctor.owner, binding, clock: { now: () => ${T0} } });
    await made.observer.observe();
    await made.observer.readNodeInfo('getNetworkInfo');
    doctor.close();
    let writeDenied = false;
    try { writeFileSync(join(tmpdir(), 'qualification-observer-probe'), 'x'); } catch (error) { writeDenied = error.code === 'ERR_ACCESS_DENIED'; }
    console.log(JSON.stringify({ sent: [...new Set(sent)].sort(), writeDenied }));`;
  const child = spawnSync(process.execPath, [permission, '--allow-fs-read=*', '--allow-worker', '--input-type=module', '-e', probe], { encoding: 'utf8', cwd: fileURLToPath(new URL('../', import.meta.url)) });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), { sent: ['nodeCall:getBlockByNumber', 'nodeCall:getNetworkInfo'], writeDenied: true });
});
