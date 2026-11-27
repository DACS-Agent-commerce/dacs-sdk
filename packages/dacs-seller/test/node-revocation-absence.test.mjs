// The optional storage-proof and finalized-head reads of the seller's revocation surface reader. With an operator's trusted finality,
// a marker the SR-2 adapter authenticated has its native address asked for a storage proof and the node for its finalized head,
// through the bound source; the replies are discarded, so no reply can turn a revoked or unavailable surface into an admission.
// The marker is served by the SR-2 readback fixture; the optional reads go to a scripted answer or through the real source
// transport to the client's scripted node.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jsonResponse, ok, replayNode } from './helpers/seller-node-wallet-world.mjs';

const { canonicalize, contentHash, encodeAddressSegment, logicalToStorageProgramName, sha256Hex, signComponentArtifact } = await import('@kynesyslabs/dacs');
const { markerWorld } = await import('./helpers/revocation-marker-world.mjs');
const { walletSessionWorld, LISTING_PIN } = await import('./helpers/seller-wallet-session-world.mjs');
const { enrollment } = await import('./helpers/kit-wallet-session.mjs');
const { NOW, JOB } = await import('./helpers/protocol-fixture.mjs');
const { readbackFixture } = await import('./helpers/sr2-readback-fixture.mjs');
const { addressForClaim } = await import('../src/dacs/demos-claims.mjs');
const { buildStorageProgramCreatePayload, deriveStorageAddress } = await import('../src/dacs/wallet-transactions.mjs');

const VECTORS = JSON.parse(readFileSync(new URL('./vectors/revocation-proof-node.json', import.meta.url), 'utf8')).vectors;
// The reviewed node's operator pin, as the readers receive it from the seller's configuration; they forward it and read none of it.
const TRUSTED_FINALITY = Object.freeze(structuredClone(VECTORS['head-matching'].pin));
const NON_MEMBERSHIP = VECTORS['nonmembership-other-leaf'].reply, MEMBERSHIP = VECTORS['membership-sibling'].reply;
const HEAD = VECTORS['head-matching'].head, NEWER_HEAD = VECTORS['head-stale'].head;
const PROOF_READ_MAX_BYTES = 64 * 1024;
const LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 64 * 1024 });
const PROOF_MESSAGES = Object.freeze(['getStorageProof', 'getFinalizedHead']);
const OTHER_ADDRESS = `stor-${'1'.repeat(40)}`;
const REVOKED = Object.freeze({ code: 'session_not_admitted', status: 409, message: 'the Listing is revoked (verified-revocation-marker)' });
const UNAVAILABLE = (readFailureReason) => [{ kind: 'catalog', status: 'active', readStatus: 'unavailable', readFailureReason }];

const messageOf = (body) => body?.params?.[0]?.message;
const optionalReads = (world) => world.rpc.filter(({ body }) => PROOF_MESSAGES.includes(messageOf(body)));
const markerReads = (world) => world.rpc.filter(({ body }) => messageOf(body) === 'searchStoragePrograms').length;
const proofRequest = (address) => ({ method: 'nodeCall', params: [{ message: 'getStorageProof', data: { storageAddresses: [address] } }] });
const HEAD_REQUEST = Object.freeze({ method: 'nodeCall', params: [{ message: 'getFinalizedHead' }] });
const flush = async () => { for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve)); };
const surfacesOf = (readers, world) => readers.sessionAdmission.readRevocationSurfaces({ jobId: JOB, listingPin: world.listingPin }, LIMITS);
// A promise's outcome as it lands: `done`, then `value` or `error`.
function watched(promise) {
  const state = { done: false };
  promise.then((value) => Object.assign(state, { done: true, value }), (error) => Object.assign(state, { done: true, error }));
  return state;
}
// Answers each optional read with `answers[message](options)` (a value, a promise or a throw); every other read goes on to the fixture.
const scripted = (world, answers) => { world.answer = (_path, body, options) => answers[messageOf(body)]?.(options); };
// Sends the optional reads through the world's real source transport, whose scripted node answers them with `answers[message](row)`.
// Returns each read's outcome in order: 'ok' or the transport's error.
function throughSourceTransport(world, answers) {
  const outcomes = [];
  world.node.reply = (row) => answers[messageOf(row.body)]?.(row);
  world.answer = async (path, body, options) => {
    if (!PROOF_MESSAGES.includes(messageOf(body))) return undefined;
    try { const reply = await world.wallet.sourceCapability.readRpc(path, body, options); outcomes.push('ok'); return reply; } catch (error) { outcomes.push(error); throw error; }
  };
  return outcomes;
}
// A JSON reply of exactly `bytes` bytes.
function sizedReply(bytes) {
  const empty = JSON.stringify(ok({ pad: '' }));
  return new Response(JSON.stringify(ok({ pad: 'x'.repeat(bytes - Buffer.byteLength(empty)) })), { headers: { 'content-type': 'application/json' } });
}
const answeredPair = { getStorageProof: () => jsonResponse(ok(NON_MEMBERSHIP)), getFinalizedHead: () => jsonResponse(ok(HEAD)) };
function assertExactPair(world, address) {
  const reads = optionalReads(world);
  assert.deepEqual(reads.map(({ path, body }) => [path, body]), [['/', proofRequest(address)], ['/', HEAD_REQUEST]]);
  for (const { options } of reads) {
    assert.deepEqual(Object.keys(options).sort(), ['maxBytes', 'signal']);
    assert.ok(options.maxBytes === PROOF_READ_MAX_BYTES && options.signal instanceof AbortSignal);
  }
}

test('an authenticated SR-2 native address triggers exact bounded proof and finalized-head reads; one-address non-membership refuses admission', async (t) => {
  const world = await markerWorld(t), address = world.fixture.native.storageAddress;
  const outcomes = throughSourceTransport(world, answeredPair);
  assert.deepEqual(await world.coreCheck(world.readers({ trustedFinality: TRUSTED_FINALITY })), REVOKED);
  assertExactPair(world, address);
  assert.deepEqual(outcomes, ['ok', 'ok']);
  assert.deepEqual(world.node.reads.filter((message) => PROOF_MESSAGES.includes(message)), PROOF_MESSAGES, 'both reads reached the node through the bound source');
  assert.equal(markerReads(world), 2, 'the 409 follows the marker re-read');

  for (const [bytes, admitted] of [[PROOF_READ_MAX_BYTES, true], [PROOF_READ_MAX_BYTES + 1, false]]) {
    world.rpc.length = 0; outcomes.length = 0;
    const sized = throughSourceTransport(world, { ...answeredPair, getStorageProof: () => sizedReply(bytes) });
    assert.deepEqual(await world.coreCheck(world.readers({ trustedFinality: TRUSTED_FINALITY })), REVOKED, `${bytes} bytes`);
    if (admitted) assert.deepEqual(sized, ['ok', 'ok'], 'a reply at the limit is read');
    else assert.ok(sized.length === 1 && /exceeds byte limit/.test(sized[0].message), 'a reply one byte over the limit is refused before decoding');
    assert.equal(markerReads(world), 2);
  }
});

test('a present marker still refuses through its signature check', async (t) => {
  // A native record marked deleted still holds the signed marker: deletion never lifts a revocation.
  for (const [proof, change] of [[MEMBERSHIP, () => {}], [NON_MEMBERSHIP, () => {}], [MEMBERSHIP, (f) => { f.native.isDeleted = true; }]]) {
    const world = await markerWorld(t, { change });
    scripted(world, { getStorageProof: () => ok(proof), getFinalizedHead: () => ok(HEAD) });
    const readers = world.readers({ trustedFinality: TRUSTED_FINALITY });
    const [surface] = await surfacesOf(readers, world);
    assert.equal(surface.binding.markerContentHash, contentHash(world.marker));
    assert.deepEqual(await world.coreCheck(readers), REVOKED);
    assert.equal(optionalReads(world).length, 4, 'each surface read asked for the proof and the head');
  }
});

test('an authenticated marker with invalid content or signature refuses as unavailable', async (t) => {
  const otherSignature = async (marker) => ({ ...marker, signature: (await signComponentArtifact({ TEST: 'another artifact' }, 'dacs-revocation:v1:',
    { algorithm: 'ed25519', signer: marker.signature.signer, sign: () => Buffer.alloc(64, 7) })).signature });
  const changes = { 'changed content': (marker) => ({ ...marker, revokedAt: marker.revokedAt - 1 }), 'another signature': otherSignature };
  for (const [name, alterMarker] of Object.entries(changes)) {
    const world = await markerWorld(t, { alterMarker });
    scripted(world, { getStorageProof: () => ok(MEMBERSHIP), getFinalizedHead: () => ok(HEAD) });
    const readers = world.readers({ trustedFinality: TRUSTED_FINALITY });
    assert.equal((await surfacesOf(readers, world))[0].status, 'revoked', `${name}: the SR-2 adapter authenticated the marker`);
    const problem = await world.coreCheck(readers);
    assert.deepEqual([problem.code, problem.status], ['session_admission_unavailable', 503], name);
    assert.equal(optionalReads(world).length, 4, name);
  }
});

test('missing malformed oversized timed-out ACL-hidden 403 and wrong-address proof replies cannot admit a Listing', async (t) => {
  const failing = (error) => () => { throw error; };
  const replies = {
    missing: { getStorageProof: failing(Object.assign(new Error('TEST unknown node method'), { code: 'readonly_only' })) },
    malformed: { getStorageProof: () => ({ result: 200, response: 'TEST not a proof' }), getFinalizedHead: () => '{' },
    oversized: { getStorageProof: failing(Object.assign(new Error('TEST reply exceeds byte limit'), { kind: 'invalid' })) },
    'ACL-hidden 403': { getStorageProof: () => ({ result: 403, response: 'TEST forbidden' }), getFinalizedHead: () => ok(HEAD) },
    'wrong address': { getStorageProof: () => ok({ ...NON_MEMBERSHIP, storageAddresses: [OTHER_ADDRESS] }), getFinalizedHead: () => ok(HEAD) },
    'flipped certificate': { getStorageProof: () => ok(MEMBERSHIP), getFinalizedHead: () => ok({ ...HEAD, signedMessage: `${HEAD.signedMessage}0` }) },
  };
  for (const [name, answers] of Object.entries(replies)) {
    const world = await markerWorld(t);
    scripted(world, answers);
    assert.deepEqual(await world.coreCheck(world.readers({ trustedFinality: TRUSTED_FINALITY })), REVOKED, name);
    assert.deepEqual(optionalReads(world)[0]?.body, proofRequest(world.fixture.native.storageAddress), `${name}: the proof was asked for`);
  }

  const never = () => new Promise(() => {});
  const heldPairs = [{ getStorageProof: never }, { getStorageProof: () => ok(NON_MEMBERSHIP), getFinalizedHead: never }];
  const [pairWorlds, slowWorlds, stalled] = [[], [], await markerWorld(t)];
  for (let built = 0; built < 2; built++) { pairWorlds.push(await markerWorld(t)); slowWorlds.push(await markerWorld(t)); }
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  // A held proof read and a held head read each end the pair at 1,500 ms, and the surface read answers revoked then.
  for (const [index, answers] of heldPairs.entries()) {
    const world = pairWorlds[index];
    scripted(world, answers);
    const surfaces = watched(surfacesOf(world.readers({ trustedFinality: TRUSTED_FINALITY }), world));
    await flush();
    mock.timers.tick(1_499); await flush();
    assert.equal(surfaces.done, false, 'the pair still has time before 1,500 ms');
    mock.timers.tick(1); await flush();
    assert.equal(surfaces.value[0].status, 'revoked');
    assert.equal(optionalReads(world).length, Object.keys(answers).length);
  }
  // An SR-2 read that takes 7,000 ms leaves the pair 500 ms; the surface read answers at 7,500 ms and the marker re-read gives 409
  // within the core's 10-second check, or 503 when the re-read fails.
  for (const [index, [rereadFails, expected]] of [[false, REVOKED], [true, 503]].entries()) {
    const world = slowWorlds[index];
    let release, searches = 0;
    const slowSearch = new Promise((resolve) => { release = resolve; });
    scripted(world, { getStorageProof: never, searchStoragePrograms: () => {
      searches += 1;
      if (searches === 1) return slowSearch;
      return rereadFails ? { result: 200, response: [] } : undefined;
    } });
    const check = watched(world.coreCheck(world.readers({ trustedFinality: TRUSTED_FINALITY })));
    await flush();
    mock.timers.tick(7_000); release(); await flush();
    assert.equal(optionalReads(world).length, 1, 'the proof was asked for after the slow SR-2 read');
    mock.timers.tick(499); await flush();
    assert.equal(check.done, false, 'the pair still has time before 7,500 ms');
    mock.timers.tick(1); await flush();
    assert.equal(check.done, true, 'the marker re-read ran inside the reserved time');
    if (rereadFails) assert.equal(check.value.status, expected);
    else assert.deepEqual(check.value, expected);
  }
  // The surface read itself ends at 7,500 ms even when the SR-2 read never answers.
  scripted(stalled, { searchStoragePrograms: never });
  const surfaces = watched(surfacesOf(stalled.readers({ trustedFinality: TRUSTED_FINALITY }), stalled));
  await flush();
  mock.timers.tick(7_499); await flush();
  assert.equal(surfaces.done, false);
  mock.timers.tick(1); await flush();
  assert.equal(surfaces.error?.name, 'TimeoutError');
  assert.equal(optionalReads(stalled).length, 0);
});

test('a connection change or wrong chain during the optional reads cannot admit a Listing', async (t) => {
  // The node behind the connection reads as another chain from the proof read on: once, or for every later read.
  for (const persistent of [false, true]) {
    const world = await markerWorld(t);
    let wrongChain = false;
    const outcomes = throughSourceTransport(world, answeredPair);
    const answerOptional = world.answer;
    world.answer = (path, body, options) => {
      if (messageOf(body) === 'getStorageProof') wrongChain = true;
      return answerOptional(path, body, options);
    };
    const proofAnswer = world.node.reply;
    world.node.reply = (row) => {
      if (!wrongChain || messageOf(row.body) !== 'getBlockByNumber' || row.body.params[0].data.blockNumber !== 0) return proofAnswer(row);
      wrongChain = persistent;
      return jsonResponse(ok({ number: 0, status: 'confirmed', hash: 'e'.repeat(64), content: {} }));
    };
    const problem = await world.coreCheck(world.readers({ trustedFinality: TRUSTED_FINALITY }));
    assert.equal(outcomes.length, 1, 'the source fence refused the proof read');
    assert.notEqual(outcomes[0], 'ok');
    assert.ok(!world.node.reads.includes('getStorageProof'), 'the refused proof read never reached the node');
    if (persistent) assert.deepEqual([problem.code, problem.status], ['session_admission_unavailable', 503]);
    else assert.deepEqual(problem, REVOKED, 'the restored source re-reads the marker');
  }
});

test('an indexed 404 or foreign candidate and a duplicate owner issue no proof request and stay unavailable', async (t) => {
  // A name index that lists one more program of the marker's name at OTHER_ADDRESS, read back with `owner` (the seller's own when null).
  const withCandidate = async (owner) => {
    const world = await markerWorld(t, { change: (f) => { f.state.rows = [...(owner === null ? f.state.rows : []), { programName: f.native.programName, storageAddress: OTHER_ADDRESS }]; } });
    world.answer = (path) => (path === `/storage-program/${OTHER_ADDRESS}` ? { ...structuredClone(world.fixture.native), storageAddress: OTHER_ADDRESS, ...(owner === null ? {} : { owner }) } : undefined);
    return world;
  };
  const cases = [['native-address-miss', () => markerWorld(t, { storageMiss: true })], ['name-index-miss', () => withCandidate(`0x${'2'.repeat(64)}`)],
    ['indeterminate', () => withCandidate(null)]];
  for (const [reason, build] of cases) {
    const world = await build(), readers = world.readers({ trustedFinality: TRUSTED_FINALITY });
    assert.deepEqual(await surfacesOf(readers, world), UNAVAILABLE(reason), reason);
    assert.deepEqual([(await world.coreCheck(readers)).status, optionalReads(world).length], [503, 0], reason);
  }
});

test('a newer finalized head cannot change the authenticated revoked surface', async (t) => {
  const world = await markerWorld(t), readers = world.readers({ trustedFinality: TRUSTED_FINALITY });
  let head = HEAD;
  scripted(world, { getStorageProof: () => ok(MEMBERSHIP), getFinalizedHead: () => ok(head) });
  const before = await surfacesOf(readers, world);
  head = NEWER_HEAD;
  assert.ok(NEWER_HEAD.number > HEAD.number);
  assert.deepEqual(await surfacesOf(readers, world), before);
  assert.deepEqual(await world.coreCheck(readers), REVOKED);
  assert.equal(optionalReads(world).filter(({ body }) => messageOf(body) === 'getFinalizedHead').length, 3, 'each surface read asked for the head again');
});

test('a pointerless miss issues no proof and two authenticated session attempts read fresh proofs after restart without stored success', async (t) => {
  const miss = await markerWorld(t, { change: (f) => { f.state.rows = []; } }), missReaders = miss.readers({ trustedFinality: TRUSTED_FINALITY });
  assert.deepEqual(await surfacesOf(missReaders, miss), UNAVAILABLE('name-index-miss'));
  assert.deepEqual([(await miss.coreCheck(missReaders)).status, optionalReads(miss).length], [503, 0]);

  const world = await markerWorld(t), address = world.fixture.native.storageAddress;
  const answers = [{ getStorageProof: () => ok(MEMBERSHIP), getFinalizedHead: () => ok(HEAD) }, { getStorageProof: () => { throw new Error('TEST proof read failed'); } }];
  for (const [attempt, attemptAnswers] of answers.entries()) {
    world.rpc.length = 0;
    scripted(world, attemptAnswers);
    // Each attempt builds the readers again, as a restarted port does.
    assert.deepEqual(await world.coreCheck(world.readers({ trustedFinality: TRUSTED_FINALITY })), REVOKED, `attempt ${attempt + 1}`);
    assert.deepEqual(optionalReads(world)[0].body, proofRequest(address), `attempt ${attempt + 1} asked for the proof again`);
  }
});

test('the proof path uses only source-bound read RPC and never signs sends or loads a key', async (t) => {
  const world = await markerPort(t, { trustedFinality: TRUSTED_FINALITY }), keyLoads = world.keyLoads, callsBefore = world.node.calls.length;
  const surfaces = await world.port.sessionAdmission.readRevocationSurfaces({ jobId: JOB, listingPin: LISTING_PIN }, LIMITS);
  assert.equal(surfaces[0].status, 'revoked');
  const requests = world.node.calls.slice(callsBefore).map((row) => [row.body?.method, messageOf(row.body)]);
  assert.ok(requests.length > 2 && requests.every(([method]) => method === 'nodeCall'), 'every request the node received is a read call');
  assert.deepEqual(requests.filter(([, message]) => PROOF_MESSAGES.includes(message)), [['nodeCall', 'getStorageProof'], ['nodeCall', 'getFinalizedHead']]);
  assert.deepEqual({ keyLoads: world.keyLoads, executeStages: world.executeStages(), confirmed: world.options.approve.confirmed.length },
    { keyLoads, executeStages: 0, confirmed: 0 }, 'no key load, signature, send or operator approval');
});

test('one-address non-membership after authenticated positive read never admits a Listing', async (t) => {
  const world = await markerWorld(t), readers = world.readers({ trustedFinality: TRUSTED_FINALITY });
  scripted(world, { getStorageProof: () => ok(NON_MEMBERSHIP), getFinalizedHead: () => ok(HEAD) });
  const [surface] = await surfacesOf(readers, world);
  assert.deepEqual([surface.status, surface.readStatus], ['revoked', 'ok']);
  world.rpc.length = 0;
  const problem = await world.coreCheck(readers);
  assert.notEqual(problem, null, 'no session is opened');
  assert.deepEqual(problem, REVOKED);
  assertExactPair(world, world.fixture.native.storageAddress);
});

// A finalized production port whose node serves the port seller's own revocation marker, written by the port's key in a CREATE
// the SR-2 adapter authenticates, and answers the optional reads; `options` are added to the port's options.
async function markerPort(t, options) {
  const node = replayNode(), relay = node.fetch;
  let fixture = null;
  node.fetch = (url, init) => (fixture && new URL(url).pathname.startsWith('/storage-program/') ? fixture.fetchImpl(url, init) : relay(url, init));
  const world = await walletSessionWorld(t, { node, options: { participantImplementations: enrollment(), sessionOf: () => null, ...options } });
  const { session } = await world.finalize(), source = session.transport, signer = world.signer, owner = addressForClaim(signer.claim);
  const logicalAddress = `dacs1-revoked:${encodeAddressSegment(signer.claim)}:${LISTING_PIN.listingId}:v${LISTING_PIN.version}`;
  const programName = logicalToStorageProgramName(logicalAddress), storageAddress = deriveStorageAddress(owner, programName, 1);
  const marker = await signComponentArtifact({ listingId: LISTING_PIN.listingId, listingVersion: LISTING_PIN.version, listingContentHash: LISTING_PIN.contentHash, revokedAt: NOW - 1,
    reason: 'TEST withdrawn' }, 'dacs-revocation:v1:', { algorithm: 'ed25519', signer: signer.claim, sign: signer.signBytes });
  const signed = buildStorageProgramCreatePayload({ from: owner, storageAddress, programName, logicalAddress, signedListing: marker, nonce: 1, timestamp: NOW });
  Object.assign(signed.content, { from_ed25519_address: owner, network: source.pins.network, chainIdentity: source.pins.chainIdentity });
  signed.content.data[1].metadata = { logicalAddress, artifactKind: 'RevocationMarker', contentHash: contentHash(marker), envelopeHash: sha256Hex(canonicalize(marker)),
    networkBinding: structuredClone(source.transportBinding) };
  signed.hash = sha256Hex(JSON.stringify(signed.content));
  signed.signature = { type: 'ed25519', data: `0x${signer.signBytes(Buffer.from(signed.hash)).toString('hex')}` };
  fixture = readbackFixture({ signedTransaction: signed, observedAt: NOW });
  fixture.native.owner = owner;
  fixture.block.validation_data = { simulated: true };
  node.reply = (row) => {
    const { message, data } = row.body.params[0];
    if (message === 'searchStoragePrograms') return jsonResponse(ok(fixture.state.rows));
    if (message === 'getTxByHash') return jsonResponse(ok(fixture.tx));
    if (message === 'getBlockByNumber' && data.blockNumber === 1) return jsonResponse(ok(fixture.block));
    return answeredPair[message]?.(row);
  };
  return Object.assign(world, { storageAddress });
}

test('missing production trust sends no proof or head RPC and keeps revoked 409 and ordinary miss 503', async (t) => {
  for (const [trustedFinality, pairs] of [[undefined, 0], [TRUSTED_FINALITY, 1]]) {
    for (const [name, options] of [['revoked', {}], ['ordinary miss', { change: (f) => { f.state.rows = []; } }]]) {
      const world = await markerWorld(t, options), readers = world.readers({ trustedFinality });
      scripted(world, { getStorageProof: () => ok(NON_MEMBERSHIP), getFinalizedHead: () => ok(HEAD) });
      const problem = await world.coreCheck(readers);
      if (name === 'revoked') assert.deepEqual(problem, REVOKED, `${name} with trust ${trustedFinality !== undefined}`);
      else assert.equal(problem.status, 503, name);
      assert.equal(optionalReads(world).length, name === 'revoked' ? 2 * pairs : 0, `${name} with trust ${trustedFinality !== undefined}`);
      if (name === 'revoked' && pairs) assertExactPair(world, world.fixture.native.storageAddress);
    }
  }
  // The production port forwards its trusted finality option to the reader; without it the port's reader sends neither read.
  for (const trustedFinality of [undefined, TRUSTED_FINALITY]) {
    const world = await markerPort(t, trustedFinality === undefined ? {} : { trustedFinality });
    const surfaces = await world.port.sessionAdmission.readRevocationSurfaces({ jobId: JOB, listingPin: LISTING_PIN }, LIMITS);
    assert.deepEqual([surfaces[0].status, surfaces[0].readStatus], ['revoked', 'ok']);
    const sent = world.node.calls.filter((row) => PROOF_MESSAGES.includes(messageOf(row.body))).map((row) => row.body);
    assert.deepEqual(sent, trustedFinality === undefined ? [] : [proofRequest(world.storageAddress), HEAD_REQUEST]);
  }
});
