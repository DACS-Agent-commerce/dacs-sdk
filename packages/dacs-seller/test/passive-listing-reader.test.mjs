// The passive Listing reader over a scripted TP-1 node: one read-only connection whose observer checks the chain against the
// approved identity record, then the SR-2 adapter's passive mode reads and authenticates the published Listing CREATE. The
// node, the Listing and its CREATE are the test's; nothing here opens a wallet, key, journal or socket.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { spawnSync } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { listingAddress, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { createNodeTransportOwner } from '@kynesyslabs/dacs-client/node-wallet';
import { installNoNetworkTrap } from './helpers/no-network-trap.mjs';

const networkTrap = installNoNetworkTrap();
const lookups = [];
for (const resolver of [dns, dns.promises]) mock.method(resolver, 'lookup', (...args) => { lookups.push(args[0]); throw new Error('TEST no DNS lookup'); });

const { NOW, buyer, seller } = await import('./helpers/protocol-fixture.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');
const { readbackFixture } = await import('./helpers/sr2-readback-fixture.mjs');
const { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_REPLY_BYTES } = await import('../src/dacs/demos-sr2-adapter.mjs');
const { createPassiveListingReader } = await import('../src/devnet-demo/passive-listing-reader.mjs');

const RECORD = TP1_APPROVED_IDENTITY_RECORD, CHAIN = RECORD.chainIdentity;
const HTTPS_ROOT = 'https://rpc.example.invalid/', HTTP_ROOT = 'http://203.0.113.7:53550/';
const PASSIVE_MODE = 'passive-pinned-record-single-node';
const ADAPTER_DEADLINE_MS = 10_000;
// The seller's own connection as its CREATE records it; a reader compares only the network, chain identity and pin version.
const SELLER_BINDING = Object.freeze({ network: RECORD.network, chainIdentity: CHAIN, pinVersion: RECORD.pinVersion,
  endpoint: 'https://seller-node.example.invalid/', transportAuthority: 'dacs-seller-tp1-node' });
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
const reply = (response, headers) => json({ result: 200, response, require_reply: false, extra: null }, headers);
const causes = (error) => { const chain = []; for (let link = error; link; link = link.cause) chain.push(link); return chain; };
const omit = (...names) => (content) => { for (const name of names) delete content[name]; return content; };

// Signs `signed` again over its current content with the seller's key.
function signAgain(signed) {
  signed.hash = sha256Hex(JSON.stringify(signed.content));
  signed.signature.data = `0x${seller.signBytes(Buffer.from(signed.hash)).toString('hex')}`;
}

/**
 * The seller's Listing CREATE as a TP-1 node holds it once confirmed. The signed content carries `network` and `chainIdentity`
 * (`signedNetwork`, `signedChain`) and the metadata carries `networkBinding`; `executed(content)` gives the content the node
 * reports for the confirmed transaction (the signed content by default).
 */
function publishedListing({ signedNetwork = RECORD.network, signedChain = CHAIN, networkBinding = SELLER_BINDING, executed = (content) => content } = {}) {
  const listing = fixtureListing(seller, { now: NOW });
  const logicalAddress = listingAddress(seller.claim, listing.listingId, listing.listingVersion);
  const f = readbackFixture({ logicalAddress, artifact: listing, artifactKind: 'Listing' });
  Object.assign(f.signed.content, { network: signedNetwork, chainIdentity: signedChain });
  f.signed.content.data[1].metadata.networkBinding = { ...networkBinding };
  signAgain(f.signed);
  const tx = { ...structuredClone(f.signed), content: executed(structuredClone(f.signed.content)), status: 'confirmed', blockNumber: 1 };
  const native = { ...f.native, metadata: structuredClone(f.signed.content.data[1].metadata), createdByTx: f.signed.hash, interactionTxs: [f.signed.hash] };
  const block = { number: 1, status: 'confirmed', hash: sha256Hex('TEST passive block one'),
    content: { previousHash: CHAIN, timestamp: NOW / 1000, ordered_transactions: [f.signed.hash] }, validation_data: { signers: ['TEST-validator'] } };
  return { listing, logicalAddress, tx, native, block, rows: f.rows, networkInfo: f.networkInfo, projection: structuredClone(f.signed) };
}

/**
 * A scripted TP-1 node holding `published`. `calls` lists each read (`GET <path>` or the nodeCall message), `requests` each
 * request's origin and redirect mode. `respond({ message, call, init })` may answer instead; `headers` go on every answer.
 */
function scriptedNode(published) {
  const node = { calls: [], requests: [], respond: null, headers: {} };
  node.fetch = async (url, init) => {
    const { origin, pathname } = new URL(url);
    const call = init.body === undefined ? null : JSON.parse(init.body).params[0];
    const message = call?.message ?? `GET ${pathname}`;
    node.calls.push(message);
    node.requests.push({ origin, redirect: init.redirect });
    const answer = await node.respond?.({ message, call, init });
    if (answer !== undefined) return answer;
    if (call === null) {
      return pathname === `/storage-program/${published.native.storageAddress}` ? json(published.native, node.headers)
        : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (message === 'getBlockByNumber') return reply(call.data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: CHAIN, content: {} } : published.block, node.headers);
    const answers = { getTxByHash: published.tx, searchStoragePrograms: published.rows, getNetworkInfo: published.networkInfo };
    if (!Object.hasOwn(answers, message)) throw new Error(`TEST-unscripted-node-read:${message}`);
    return reply(answers[message], node.headers);
  };
  return node;
}

/** A passive reader over a scripted node that holds the seller's Listing; `read(options)` reads it as P32aa's readback does. */
function readerWorld(t, { endpoint = HTTPS_ROOT, ...listingOptions } = {}) {
  const published = publishedListing(listingOptions), node = scriptedNode(published);
  const reader = createPassiveListingReader({ endpoint, fetchImpl: node.fetch });
  t.after(() => reader.close());
  const read = (options = {}) => reader.readPublishedListing({ logicalAddress: published.logicalAddress, writer: seller.claim,
    signedProjection: published.projection, nativeAddress: published.native.storageAddress, ...options });
  return { published, node, reader, read };
}

/** A passive SR-2 adapter over `node` with `identityRecord`; the observation answers the approved chain unless `observeIdentity` replaces it. */
const passiveAdapter = (node, options = {}) => createDemosSr2Adapter({ rpcUrl: HTTPS_ROOT, journal: createInMemoryDemosSr2Journal(), fetchImpl: node.fetch,
  identityRecord: RECORD, observeIdentity: async () => CHAIN, ...options });

const refusal = (promise) => promise.then(() => assert.fail('expected a refusal'), (error) => error);

test('a Listing published on the bound chain reads back with its receipt, and the reader opens no journal, wallet or anchor', async (t) => {
  const { published, node, reader, read } = readerWorld(t);
  assert.ok(Object.isFrozen(reader));
  assert.deepEqual(Object.keys(reader).sort(), ['close', 'readPublishedListing']);
  const result = await read();
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result).sort(), ['demosEvidence', 'evidenceMode', 'finality', 'listing', 'receipt', 'status']);
  assert.deepEqual({ status: result.status, evidenceMode: result.evidenceMode, finality: result.finality }, { status: 'present', evidenceMode: PASSIVE_MODE, finality: 'not-established' });
  assert.deepEqual(result.listing, published.listing);
  const { receipt } = result;
  assert.deepEqual({ writer: receipt.writer, logicalAddress: receipt.logicalAddress, nativeAddress: receipt.nativeAddress, transactionRef: receipt.transactionRef.value },
    { writer: seller.claim, logicalAddress: published.logicalAddress, nativeAddress: published.native.storageAddress, transactionRef: published.projection.hash });
  assert.deepEqual({ substrate: receipt.substrate, finalityProfile: receipt.finalityProfile, kind: receipt.evidence.kind },
    { substrate: 'demos', finalityProfile: 'demos-bft-confirmed-native-read', kind: 'demos-bft-write-proof-v1' });
  assert.deepEqual({ chainIdentity: result.demosEvidence.chainIdentity, writer: result.demosEvidence.writer }, { chainIdentity: CHAIN, writer: seller.address });
  // The observer reads block zero first; every other request is one of the adapter's reads. Nothing confirms, broadcasts or executes.
  assert.equal(node.calls[0], 'getBlockByNumber');
  assert.deepEqual([...new Set(node.calls)].sort(), [`GET /storage-program/${published.native.storageAddress}`, 'getBlockByNumber', 'getNetworkInfo', 'getTxByHash', 'searchStoragePrograms'].sort());

  const hook = new URL('./helpers/import-closure-hook.mjs', import.meta.url).href, target = new URL('../src/devnet-demo/passive-listing-reader.mjs', import.meta.url).href;
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
  assert.ok(closure.some((url) => url.endsWith('/demos-sr2-adapter.mjs')), 'the hook saw the reader\'s own imports');
  assert.deepEqual(closure.filter((url) => /node:sqlite|better-sqlite3|durable-journal\.mjs|seller-node-wallet\.mjs|seller-wallet-session\.mjs|artifact-anchor\.mjs|seller-key\.mjs/.test(url)), []);
});

test('with the signed Listing CREATE projection retaining the approved `network` and `chainIdentity`, Node2\'s confirmed executed CREATE omitting both, and the native read and inclusion otherwise valid, the public passive reader authenticates the Listing and receipt; removing the passive comparison restoration makes this test fail `invalid`', async (t) => {
  const { published, read } = readerWorld(t, { executed: omit('network', 'chainIdentity') });
  const projection = structuredClone(published.projection);
  assert.ok(!Object.hasOwn(published.tx.content, 'network') && !Object.hasOwn(published.tx.content, 'chainIdentity'));
  const result = await read();
  assert.deepEqual(result.listing, published.listing);
  assert.equal(result.receipt.transactionRef.value, projection.hash);
  assert.equal(result.receipt.writer, seller.claim);
  // The comparison copy is the adapter's own: the caller's projection and the node's executed content are unchanged.
  assert.deepEqual(published.projection, projection);
  assert.ok(!Object.hasOwn(published.tx.content, 'network') && !Object.hasOwn(published.tx.content, 'chainIdentity'));
  // Without the signed projection nothing supplies the pair, and the executed content does not hash to the transaction.
  assert.equal((await refusal(read({ signedProjection: undefined }))).code, 'invalid');
});

test('a missing writer refuses writer-required before any read; a pending inclusion, a missing program, a malformed answer or a Listing of another writer each refuse with their own code', async (t) => {
  const missingWriter = readerWorld(t);
  assert.equal((await refusal(missingWriter.read({ writer: undefined }))).code, 'writer-required');
  assert.deepEqual(missingWriter.node.calls, []);

  const pending = readerWorld(t);
  pending.published.tx.status = 'pending';
  const notIncluded = await refusal(pending.read());
  assert.deepEqual({ code: notIncluded.code, message: notIncluded.message }, { code: 'indeterminate', message: 'transaction inclusion is not established' });

  const missingProgram = readerWorld(t);
  missingProgram.published.native.storageAddress = `stor-${'e'.repeat(40)}`;
  assert.deepEqual((({ code, observation }) => ({ code, observation }))(await refusal(missingProgram.read())), { code: 'indeterminate', observation: 'native-address-miss' });
  const unindexed = readerWorld(t);
  unindexed.published.rows.length = 0;
  assert.deepEqual((({ code, observation }) => ({ code, observation }))(await refusal(unindexed.read({ signedProjection: undefined, nativeAddress: undefined }))),
    { code: 'indeterminate', observation: 'name-index-miss' });

  const malformed = readerWorld(t);
  malformed.node.respond = ({ message }) => (message === 'getTxByHash' ? json({ result: 500, response: 'TEST-node-error' }) : undefined);
  const unreadable = await refusal(malformed.read());
  assert.deepEqual({ code: unreadable.code, message: unreadable.message }, { code: 'indeterminate', message: 'malformed nodeCall result' });

  // The program at the address belongs to the seller, so it never authenticates as the buyer's Listing.
  const otherWriter = readerWorld(t);
  const foreign = await refusal(otherWriter.read({ writer: buyer.claim }));
  assert.deepEqual({ code: foreign.code, observation: foreign.observation }, { code: 'indeterminate', observation: 'name-index-miss' });
  assert.ok(!otherWriter.node.calls.includes('getTxByHash'), 'no transaction of another writer is read as the Listing');
});

test('from the same authenticated signed Listing projection, an executed CREATE missing only `network` or only `chainIdentity`, or retaining a changed value for either, refuses `invalid`; a signed pair differing from the approved record also refuses `invalid`', async (t) => {
  const changed = (name, value) => (content) => ({ ...content, [name]: value });
  for (const executed of [omit('network'), omit('chainIdentity'), changed('network', 'TEST-other-network'), changed('chainIdentity', 'd'.repeat(64))]) {
    const { read } = readerWorld(t, { executed });
    assert.equal((await refusal(read())).code, 'invalid', executed.toString());
  }
  for (const signed of [{ signedNetwork: 'TEST-other-network' }, { signedChain: 'd'.repeat(64) }]) {
    const { read } = readerWorld(t, { ...signed, executed: omit('network', 'chainIdentity') });
    assert.equal((await refusal(read())).code, 'invalid', JSON.stringify(signed));
  }
});

test('a signed projection that differs from the included CREATE, or a signed network binding of another network, chain or pin version, refuses invalid', async (t) => {
  const differing = readerWorld(t);
  const projection = structuredClone(differing.published.projection);
  projection.content.timestamp += 1;
  signAgain(projection);
  assert.equal((await refusal(differing.read({ signedProjection: projection }))).code, 'invalid');
  for (const member of [{ network: 'TEST-other-network' }, { chainIdentity: 'd'.repeat(64) }, { pinVersion: 'TEST-other-pin' }]) {
    const { read } = readerWorld(t, { networkBinding: { ...SELLER_BINDING, ...member } });
    assert.equal((await refusal(read())).code, 'invalid', JSON.stringify(member));
  }
});

test('a node on another chain refuses before any storage read, with the observer\'s error kept', async (t) => {
  const { node, read } = readerWorld(t);
  node.respond = ({ message }) => (message === 'getBlockByNumber' ? reply({ number: 0, status: 'confirmed', hash: 'd'.repeat(64), content: {} }) : undefined);
  const error = await refusal(read());
  assert.equal(error.code, 'indeterminate');
  assert.ok(causes(error).slice(1).some((cause) => typeof cause.code === 'string' && cause.code !== 'indeterminate'), 'the observer\'s refusal is the cause');
  assert.deepEqual([...new Set(node.calls)], ['getBlockByNumber']);
});

test('an unapproved identity record digest refuses before any node read, and a passive result retains finality not-established', async (t) => {
  const published = publishedListing(), node = scriptedNode(published);
  for (const identityRecord of [{ ...RECORD, recordId: 'TEST-unapproved-record' }, null, 'TEST-record']) {
    assert.throws(() => passiveAdapter(node, { identityRecord }), { code: 'tp1_identity_unapproved' });
  }
  assert.throws(() => passiveAdapter(node, { identityRecord: { ...RECORD, chainIdentity: TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0] } }), { code: 'tp1_identity_fixture' });
  assert.throws(() => passiveAdapter(node, { observeIdentity: undefined }), TypeError);
  assert.deepEqual(node.calls, []);
  const result = await passiveAdapter(node).read(published.logicalAddress, { expectedWriter: seller.claim, expectedArtifactKind: 'Listing',
    signedProjection: published.projection, nativeAddress: published.native.storageAddress });
  assert.deepEqual({ finality: result.finality, evidenceMode: result.evidenceMode, networkBinding: result.networkBinding }, { finality: 'not-established', evidenceMode: PASSIVE_MODE, networkBinding: undefined });
  assert.equal((await readerWorld(t).read()).finality, 'not-established');
});

test('an answer over the reply byte bound, a name-index page over its list bound or a read past the aggregate deadline refuses before use', async (t) => {
  const oversized = readerWorld(t);
  oversized.published.tx = { ...oversized.published.tx, padding: 'x'.repeat(DEMOS_SR2_REPLY_BYTES) };
  const tooLarge = await refusal(oversized.read());
  assert.equal(tooLarge.code, 'indeterminate');
  assert.ok(causes(tooLarge).some((cause) => cause.message === 'response exceeds byte limit'));
  assert.ok(!oversized.node.calls.includes('getNetworkInfo'), 'the oversized transaction is not used');

  const longPage = readerWorld(t);
  longPage.published.rows.push(...Array.from({ length: 50 }, () => ({ ...longPage.published.rows[0] })));
  const listTooLong = await refusal(longPage.read());
  assert.deepEqual({ code: listTooLong.code, message: listTooLong.message }, { code: 'indeterminate', message: 'malformed name-index page' });
  assert.ok(!longPage.node.calls.some((call) => call.startsWith('GET ')), 'no candidate of the oversized page is read');

  const stalled = readerWorld(t);
  let arrived;
  const storageRead = new Promise((resolve) => { arrived = resolve; });
  stalled.node.respond = ({ message, init }) => {
    if (!message.startsWith('GET ')) return undefined;
    arrived();
    return new Promise((_, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason), { once: true }));
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = refusal(stalled.read());
  await storageRead;
  t.mock.timers.tick(ADAPTER_DEADLINE_MS);
  const late = await pending;
  assert.equal(late.code, 'indeterminate');
  assert.equal(late.cause?.name, 'TimeoutError');
  assert.ok(!stalled.node.calls.includes('getTxByHash'), 'nothing is read after the deadline');
});

test('an answer carrying the simulation marker is refused as live evidence', async (t) => {
  const { node, read } = readerWorld(t);
  node.headers = { 'x-dacs-simulation': 'fixture' };
  const error = await refusal(read());
  assert.equal(error.code, 'indeterminate');
  assert.ok(causes(error).some((cause) => /simulation marker/.test(cause.message)));
  assert.ok(!node.calls.includes('getTxByHash'), 'a marked answer is not used');
});

test('an aborted signal refuses before any read, and an abort during the read starts no further read', async (t) => {
  const before = readerWorld(t), stop = new AbortController(), reason = new Error('TEST caller stopped');
  stop.abort(reason);
  assert.equal(await refusal(before.read({ signal: stop.signal })), reason);
  assert.deepEqual(before.node.calls, []);

  const during = readerWorld(t), midway = new AbortController(), midwayReason = new Error('TEST caller stopped midway');
  during.node.respond = ({ message, init }) => {
    if (!message.startsWith('GET ')) return undefined;
    midway.abort(midwayReason);
    return new Promise((_, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason), { once: true }));
  };
  assert.equal(await refusal(during.read({ signal: midway.signal })), midwayReason);
  const sent = during.node.calls.length;
  await nextTurn();
  await nextTurn();
  assert.equal(during.node.calls.length, sent);
  assert.ok(during.node.calls.at(-1).startsWith('GET '), 'the storage read is the last one started');
});

test('an approved testnet HTTP root and a canonical HTTPS root each reach the observer and Listing readback; the public reader obtains the HTTP chain pin from the approved record', async (t) => {
  for (const endpoint of [HTTP_ROOT, HTTPS_ROOT]) {
    const { published, node, read } = readerWorld(t, { endpoint });
    assert.deepEqual((await read()).listing, published.listing, endpoint);
    assert.equal(node.calls[0], 'getBlockByNumber', endpoint);
    assert.ok(node.calls.includes(`GET /storage-program/${published.native.storageAddress}`), endpoint);
    assert.deepEqual([...new Set(node.requests.map(({ origin }) => `${origin}/`))], [endpoint]);
  }
});

test('an HTTP root with a missing or wrong pinned chain identity at the direct owner, a non-root path, credentials, query, fragment, noncanonical spelling, or a redirect refuses before any read; HTTP without the approved pin is never admitted', async (t) => {
  for (const chainIdentity of [undefined, 'd'.repeat(64)]) {
    assert.throws(() => createNodeTransportOwner({ endpoint: HTTP_ROOT, transportAuthority: 'TEST-direct-owner', fetchImpl: async () => assert.fail('no read'), chainIdentity }),
      { code: 'transport_mismatch' }, String(chainIdentity));
  }
  const node = scriptedNode(publishedListing());
  for (const endpoint of ['https://rpc.example.invalid/rpc', 'https://u:p@rpc.example.invalid/', 'https://rpc.example.invalid/?q=1', 'https://rpc.example.invalid/#f',
    'https://RPC.example.invalid/', 'https://rpc.example.invalid', 'http://203.0.113.7:53550/rpc']) {
    assert.throws(() => createPassiveListingReader({ endpoint, fetchImpl: node.fetch }), { code: 'transport_mismatch' }, endpoint);
    assert.throws(() => passiveAdapter(node, { rpcUrl: endpoint }), { code: 'offline-only', message: 'passive SR-2 requires a canonical approved endpoint' }, endpoint);
  }
  assert.throws(() => createPassiveListingReader({ endpoint: HTTPS_ROOT, fetchImpl: 'TEST-not-a-function' }), { code: 'transport_mismatch' });
  assert.deepEqual(node.calls, []);

  const redirected = readerWorld(t);
  redirected.node.respond = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.invalid/' } });
  await refusal(redirected.read());
  assert.deepEqual(redirected.node.calls, ['getBlockByNumber'], 'the redirected identity read is the only request');
  assert.deepEqual(redirected.node.requests.map(({ redirect }) => redirect), ['error']);
});

test('close ends the reader: a later read rejects transport_closed', async (t) => {
  const { node, reader, read } = readerWorld(t);
  await read();
  const sent = node.calls.length;
  reader.close();
  reader.close();
  assert.equal((await refusal(read())).code, 'transport_closed');
  assert.equal(node.calls.length, sent);
});

test('no socket or DNS lookup leaves the process in the passive reader suite', () => {
  assert.deepEqual({ network: networkTrap.calls, lookups }, { network: [], lookups: [] });
});
