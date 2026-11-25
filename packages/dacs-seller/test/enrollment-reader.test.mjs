// The verified enrollment reader over the client's node transport owner. A scripted node answers the identity and block
// reads; an in-process stub signs each enrollment answer for the live request with the test-only key, never with the
// verifier. Every refusal starts from that working read and changes one condition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { openVerifiedEnrollmentReader as fromMainEntry } from '@kynesyslabs/dacs-seller';
import { createSellerAuthorityReader } from '../src/dacs/authority-reader.mjs';
import { openVerifiedEnrollmentReader } from '../src/devnet-demo/seller-enrollment-reader.mjs';
import { OperationError } from '../src/operations.mjs';
import { BAD_KEYS } from './helpers/ed25519-edge-cases.mjs';
import { enrollmentScenario, entryFor, signResponse, successEnvelope, testOnlyNodeKey, trustedNodeFor, unsignedResponse } from './helpers/enrollment-signing.mjs';
import { NODE_ENDPOINT, jsonResponse, scriptedNode } from './helpers/kit-wallet-session.mjs';

const MESSAGE = 'getParticipantEnrollmentProof';
const DEADLINE_MS = 10_000;
const MIB = 1024 * 1024;
const HEIGHT = 120345;
// The scripted node answers every block above zero with this hash.
const CHAIN_BLOCK_HASH = 'b'.repeat(64);
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const scenario = enrollmentScenario();
const SELLER = scenario.request.sellerClaim, BUYER = scenario.request.participantClaim, PIN = scenario.request.listingPin;
const OTHER_KEY = testOnlyNodeKey('another node key');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** The node's signed envelope for the live request `data`; `change(unsigned)` edits the response before it is signed. */
function signedAnswer(data, { entries, key = testOnlyNodeKey(), blockHash = CHAIN_BLOCK_HASH, change } = {}) {
  const { version: _version, ...request } = data;
  const unsigned = unsignedResponse({ request, observedBlock: { height: HEIGHT, blockHash } }, entries ?? [entryFor(request.participantClaim)]);
  change?.(unsigned);
  return successEnvelope(signResponse(unsigned, key));
}

/**
 * A node that answers the enrollment method by calling `node.reply(data, init)` (a signed current entry by default) and
 * the identity and block reads as the scripted node does. `node.block(height)` may answer a block read instead. It lists
 * each enrollment request in `requests` and every fetched URL in `urls`.
 */
function enrollmentNode() {
  const node = scriptedNode();
  Object.assign(node, { requests: [], urls: [], reply: (data) => jsonResponse(JSON.stringify(signedAnswer(data))), block: null });
  node.intercept = async ({ init, call }) => {
    if (call.message === MESSAGE) {
      node.requests.push({ body: JSON.parse(init.body), init });
      return node.reply(call.data, init);
    }
    if (call.message === 'getBlockByNumber' && call.data.blockNumber === HEIGHT && node.block) return node.block(HEIGHT);
    return undefined;
  };
  const fetchImpl = (url, init) => { node.urls.push(String(url)); return node.fetch(url, init); };
  return { node, fetchImpl };
}

function world(t, changes = {}) {
  const { node, fetchImpl } = enrollmentNode();
  const options = { endpoint: NODE_ENDPOINT, transportAuthority: 'TEST-enrollment', fetchImpl, claim: SELLER, listingPin: PIN,
    trustedNode: trustedNodeFor(testOnlyNodeKey()), ...changes };
  const open = (more = {}) => {
    const reader = openVerifiedEnrollmentReader({ ...options, ...more });
    t.after(() => reader.close());
    return reader;
  };
  return { node, options, open };
}

const enrollmentReads = (node) => node.calls.filter((message) => message === MESSAGE).length;

async function assertRefused(promise, code, label, check = () => {}) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OperationError, `${label}: ${error}`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    check(error);
    return true;
  }, label);
}

const blockAnswer = (hash) => jsonResponse(JSON.stringify({ result: 200, response: { number: HEIGHT, status: 'confirmed', hash, content: { previousHash: TP1_APPROVED_IDENTITY_RECORD.chainIdentity } }, require_reply: false, extra: null }));

test('a stalled enrollment read times out inside one aggregate deadline and a late reply cannot authorize', async (t) => {
  await t.test('the enrollment reply stalls', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { node, open } = world(t), reader = open(), entered = deferred(), late = deferred();
    node.reply = (data) => { entered.resolve(); return late.promise.then(() => jsonResponse(JSON.stringify(signedAnswer(data)))); };
    const pending = reader.entriesFor(BUYER);
    await entered.promise;
    t.mock.timers.tick(DEADLINE_MS);
    await assertRefused(pending, 'enrollment_timeout', 'stalled reply', (error) => assert.ok(error.cause !== undefined));
    const callsAtTimeout = node.calls.length;
    late.resolve();
    await flush();
    assert.equal(node.calls.length, callsAtTimeout, 'the late signed reply starts no block read');
  });
  await t.test('time spent on the enrollment reply counts against the selected-block read', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { node, open } = world(t), reader = open(), entered = deferred(), release = deferred(), blockEntered = deferred();
    node.reply = (data) => { entered.resolve(); return release.promise.then(() => jsonResponse(JSON.stringify(signedAnswer(data)))); };
    node.block = () => { blockEntered.resolve(); return new Promise(() => {}); };
    const pending = reader.entriesFor(BUYER);
    await entered.promise;
    t.mock.timers.tick(DEADLINE_MS - 4000);
    release.resolve();
    await blockEntered.promise;
    t.mock.timers.tick(3999);
    let settled = false;
    pending.catch(() => { settled = true; });
    await flush();
    assert.equal(settled, false, 'the call is still inside its deadline');
    t.mock.timers.tick(1);
    await assertRefused(pending, 'enrollment_timeout', 'the aggregate deadline ends the block read');
  });
});

test('byte entry depth and nested-member limits refuse at their boundaries', async (t) => {
  // A signed answer whose text is padded with leading spaces to exactly `bytes` bytes.
  const padded = (data, bytes) => { const text = JSON.stringify(signedAnswer(data)); return ' '.repeat(bytes - Buffer.byteLength(text)) + text; };
  const nested = (depth) => { let value = 0; for (let level = 0; level < depth; level++) value = [value]; return value; };
  const withExtra = (extra) => (data) => jsonResponse(JSON.stringify({ ...signedAnswer(data), extra }));
  const entries = (count) => Array.from({ length: count }, (_, index) => entryFor(BUYER, `registry row ${index}`));
  const cases = [
    ['a reply of exactly 1 MiB', (data) => jsonResponse(padded(data, MIB)), null],
    ['a reply one byte over 1 MiB', (data) => jsonResponse(padded(data, MIB + 1)), 'enrollment_too_large'],
    ['16 signed entries', (data) => jsonResponse(JSON.stringify(signedAnswer(data, { entries: entries(16) }))), null],
    ['17 signed entries', (data) => jsonResponse(JSON.stringify(signedAnswer(data, { entries: entries(17) }))), 'enrollment_too_large'],
    // The envelope is one level, so `extra` nested 31 deep makes 32.
    ['nesting 32 deep', withExtra(nested(31)), null],
    ['nesting 33 deep', withExtra(nested(32)), 'enrollment_too_large'],
    ['a list of 1024 members', withExtra(Array.from({ length: 1024 }, () => 0)), null],
    ['a list of 1025 members', withExtra(Array.from({ length: 1025 }, () => 0)), 'enrollment_too_large'],
    ['an object of 1025 members', withExtra(Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`m${index}`, 0]))), 'enrollment_too_large'],
  ];
  for (const [label, reply, code] of cases) {
    const { node, open } = world(t), reader = open();
    node.reply = reply;
    if (code === null) assert.ok((await reader.entriesFor(BUYER)).length > 0, label);
    else await assertRefused(reader.entriesFor(BUYER), code, label);
  }
});

test('changed post-read identity block hash or close aborting active and queued reads refuses', async (t) => {
  await t.test('the chain identity changes after the enrollment read', async (t) => {
    const { node, open } = world(t), reader = open(), base = node.fetch;
    let changed = false;
    node.reply = (data) => { changed = true; return jsonResponse(JSON.stringify(signedAnswer(data))); };
    node.fetch = async (url, init) => {
      const call = JSON.parse(init.body).params[0];
      if (changed && call.message === 'getBlockByNumber' && call.data.blockNumber < 2) {
        return jsonResponse(JSON.stringify({ result: 200, response: { number: call.data.blockNumber, status: 'confirmed', hash: sha256Hex('another chain'), content: { previousHash: sha256Hex('another chain') } }, require_reply: false, extra: null }));
      }
      return base(url, init);
    };
    await assertRefused(reader.entriesFor(BUYER), 'enrollment_connection_changed', 'post-read identity');
  });
  await t.test('the signed block hash differs from the selected block', async (t) => {
    const { node, open } = world(t), reader = open();
    node.reply = (data) => jsonResponse(JSON.stringify(signedAnswer(data, { blockHash: 'c'.repeat(64) })));
    await assertRefused(reader.entriesFor(BUYER), 'enrollment_unverified', 'block hash');
  });
  await t.test('close aborts the active and the queued read and a late reply admits nothing', async (t) => {
    const { node, open } = world(t), reader = open(), entered = deferred(), late = deferred();
    node.reply = (data) => { entered.resolve(); return late.promise.then(() => jsonResponse(JSON.stringify(signedAnswer(data)))); };
    const active = reader.entriesFor(BUYER), queued = reader.entriesFor(BUYER);
    await entered.promise;
    reader.close();
    await assertRefused(active, 'enrollment_connection_changed', 'active read');
    await assertRefused(queued, 'enrollment_connection_changed', 'queued read');
    late.resolve();
    await flush();
    assert.equal(enrollmentReads(node), 1, 'the queued read never reached the node');
    await assertRefused(reader.entriesFor(BUYER), 'enrollment_connection_changed', 'a read after close');
  });
});

test('two uncached reads send the exact nodeCall body with distinct fresh 64-hex nonces through one origin-bound owner', async (t) => {
  const { node, open } = world(t), reader = open();
  const first = await reader.entriesFor(BUYER, { sessionId: 'TEST-session' });
  const second = await reader.entriesFor(BUYER);
  assert.deepEqual([first, second], [[entryFor(BUYER)], [entryFor(BUYER)]]);
  assert.equal(node.requests.length, 2, 'each call reads the node again');
  const nonces = node.requests.map(({ body, init }) => {
    const { nonce } = body.params[0].data;
    assert.deepEqual(body, { method: 'nodeCall', params: [{ message: MESSAGE, data: { version: 1, sellerClaim: SELLER, participantClaim: BUYER, listingPin: PIN, nonce } }] });
    assert.match(nonce, /^[0-9a-f]{64}$/);
    assert.deepEqual([init.method, init.cache, init.credentials, init.redirect], ['POST', 'no-store', 'omit', 'error']);
    return nonce;
  });
  assert.notEqual(nonces[0], nonces[1]);
  assert.ok(node.urls.length > 2 && node.urls.every((url) => url === NODE_ENDPOINT), 'every read goes to the one endpoint');
  assert.ok(!JSON.stringify(node.requests).includes('TEST-session'), 'the session id is never sent');
});

test('missing malformed extra-key small-order wrong-identity and wrong-signer trust pins refuse and the actual signer pin accepts', async (t) => {
  const { node, options, open } = world(t);
  const { trustedNode } = options;
  const badPins = {
    missing: [undefined, 'enrollment_invalid'],
    malformed: [{ ...trustedNode, publicKey: trustedNode.publicKey.slice(1) }, 'enrollment_invalid'],
    'extra key': [{ ...trustedNode, keyVersion: 1 }, 'enrollment_invalid'],
    'small order': [{ ...trustedNode, publicKey: Buffer.from(BAD_KEYS['small-order y = 1'], 'hex').toString('base64url') }, 'enrollment_invalid'],
    'wrong identity': [{ ...trustedNode, chainIdentity: sha256Hex('another chain') }, 'enrollment_unverified'],
  };
  for (const [label, [pin, code]] of Object.entries(badPins)) {
    assert.throws(() => open({ trustedNode: pin }), (error) => error instanceof OperationError && error.code === code, label);
  }
  assert.equal(node.urls.length, 0, 'a refused pin reaches no node');
  await assertRefused(open({ trustedNode: trustedNodeFor(OTHER_KEY) }).entriesFor(BUYER), 'enrollment_unverified', 'wrong signer');
  assert.deepEqual(await open().entriesFor(BUYER), [entryFor(BUYER)]);
});

test('the staged seller reader selects only one current unrevoked entry from a verified source', async (t) => {
  const JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0A';
  const local = Object.freeze({ endpoint: NODE_ENDPOINT, transportAuthority: 'TEST-enrollment', connectionId: 'TEST-connection' });
  const revoked = entryFor(BUYER, 'registry row 41 revoked at block 120310');
  revoked.revoked = true;
  const sets = {
    'one current entry': [[entryFor(BUYER)], true],
    'a signed complete empty set': [[], false],
    'one revoked entry': [[revoked], false],
    'a revoked entry and a later current entry': [[revoked, entryFor(BUYER, 'registry row 52 at block 120320')], false],
  };
  for (const [label, [entries, admitted]] of Object.entries(sets)) {
    const { node, open } = world(t), source = open();
    node.reply = (data) => jsonResponse(JSON.stringify(signedAnswer(data, { entries })));
    assert.deepEqual(await source.entriesFor(BUYER), entries, `${label}: the source returns every signed entry`);
    const readAuthority = createSellerAuthorityReader({ connectionAuthority: async () => ({ local, chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-provenance' }),
      identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: SELLER, listingPin: PIN, bootstrap: { current: (jobId) => (jobId === JOB ? { seller: SELLER, buyer: BUYER, listingPin: PIN } : null) },
      retainedJob: () => null, participantImplementations: source });
    const decision = await readAuthority({ local, sessionId: JOB, participants: [SELLER, BUYER] });
    assert.equal(decision.participants.length, admitted ? 2 : 0, label);
    if (admitted) assert.deepEqual(decision.participants[1], { claim: BUYER, profile: entryFor(BUYER).profile, modules: entryFor(BUYER).modules });
  }
  const { node, open } = world(t), source = open();
  node.reply = () => jsonResponse(JSON.stringify({ result: 200, response: 'TEST unsigned', require_reply: false, extra: '' }));
  const readAuthority = createSellerAuthorityReader({ connectionAuthority: async () => ({ local, chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-provenance' }),
    identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: SELLER, listingPin: PIN, bootstrap: { current: () => ({ seller: SELLER, buyer: BUYER, listingPin: PIN }) },
    retainedJob: () => null, participantImplementations: source });
  await assertRefused(readAuthority({ local, sessionId: JOB, participants: [SELLER, BUYER] }), 'enrollment_invalid', 'an unsigned answer rejects the authority read instead of reading as empty');
});

test('each Base failure and stage maps to its enrollment refusal with cause retained', async (t) => {
  const timeoutError = () => new DOMException('TEST the request timed out', 'TimeoutError');
  const refusedError = () => new Error('TEST the connection was refused');
  // `stage` says which read fails: the first observation, the enrollment RPC, the selected-block read or the second observation.
  const failAt = (node, stage, failure) => {
    const base = node.fetch;
    let enrolled = false;
    node.fetch = async (url, init) => {
      const call = JSON.parse(init.body).params[0];
      const isBlock = call.message === 'getBlockByNumber' && call.data.blockNumber === HEIGHT;
      if (call.message === MESSAGE) enrolled = true;
      const hit = { observe: !enrolled && call.message === 'getBlockByNumber', rpc: call.message === MESSAGE, block: isBlock, after: enrolled && !isBlock && call.message === 'getBlockByNumber' }[stage];
      if (hit) return failure(call, init);
      return base(url, init);
    };
  };
  const rows = [
    // The observer reports a failed identity read as its own unavailable error, with the bounded fetch's timeout as cause.
    ['first observation timeout', 'observe', () => { throw timeoutError(); }, 'enrollment_timeout', (cause) => assert.equal(cause.cause.kind, 'timeout')],
    ['first observation identity mismatch', 'observe', (call) => jsonResponse(JSON.stringify({ result: 200, response: { number: call.data.blockNumber, status: 'confirmed', hash: sha256Hex('another chain'), content: { previousHash: sha256Hex('another chain') } }, require_reply: false, extra: null })),
      'enrollment_connection_changed', (cause) => assert.ok(cause)],
    ['first observation refused', 'observe', () => { throw refusedError(); }, 'enrollment_unavailable', (cause) => assert.ok(cause)],
    ['enrollment timeout', 'rpc', () => { throw timeoutError(); }, 'enrollment_timeout', (cause) => assert.equal(cause.kind, 'timeout')],
    ['enrollment reply not JSON', 'rpc', () => new Response('TEST', { headers: { 'content-type': 'text/plain' } }), 'enrollment_invalid', (cause) => assert.equal(cause.kind, 'invalid')],
    ['enrollment redirect', 'rpc', () => new Response(null, { status: 302, headers: { location: NODE_ENDPOINT } }), 'enrollment_invalid', (cause) => assert.equal(cause.kind, 'invalid')],
    ['enrollment HTTP 404', 'rpc', () => new Response('{}', { status: 404 }), 'enrollment_unavailable', (cause) => assert.equal(cause.kind, 'not-found')],
    ['enrollment HTTP 500', 'rpc', () => new Response('{}', { status: 500 }), 'enrollment_unavailable', (cause) => assert.equal(cause.kind, 'unavailable')],
    ['enrollment refused', 'rpc', () => { throw refusedError(); }, 'enrollment_unavailable', (cause) => assert.equal(cause.kind, 'unavailable')],
    ['enrollment method absent', 'rpc', () => jsonResponse(JSON.stringify({ result: 400, response: 'TEST unknown message', require_reply: false, extra: '' })), 'enrollment_unavailable', () => {}],
    ['enrollment answer has an extra envelope member', 'rpc', (call) => jsonResponse(JSON.stringify({ ...signedAnswer(call.data), more: 1 })), 'enrollment_invalid', () => {}],
    ['enrollment answer signed by another key', 'rpc', (call) => jsonResponse(JSON.stringify(signedAnswer(call.data, { key: OTHER_KEY }))), 'enrollment_unverified', () => {}],
    ['enrollment entry with an extra member', 'rpc', (call) => jsonResponse(JSON.stringify(signedAnswer(call.data, { entries: [{ ...entryFor(BUYER), extra: 1 }] }))), 'enrollment_invalid', () => {}],
    ['selected block timeout', 'block', () => { throw timeoutError(); }, 'enrollment_timeout', (cause) => assert.equal(cause.code, 'tp1_authority_timeout')],
    ['selected block refused', 'block', () => { throw refusedError(); }, 'enrollment_unavailable', (cause) => assert.ok(cause)],
    ['selected block not found', 'block', () => jsonResponse(JSON.stringify({ result: 404, response: 'TEST no block', require_reply: false, extra: null })), 'enrollment_unavailable', () => {}],
    ['second observation timeout', 'after', () => { throw timeoutError(); }, 'enrollment_timeout', (cause) => assert.equal(cause.cause.kind, 'timeout')],
    ['second observation refused', 'after', () => { throw refusedError(); }, 'enrollment_unavailable', (cause) => assert.ok(cause)],
  ];
  for (const [label, stage, failure, code, checkCause] of rows) {
    const { node, open } = world(t), reader = open();
    failAt(node, stage, failure);
    await assertRefused(reader.entriesFor(BUYER), code, label, (error) => { assert.notEqual(error.cause, undefined, `${label}: cause kept`); checkCause(error.cause); });
  }
  const { node, open } = world(t), reader = open();
  for (const claim of [undefined, '', 7]) await assertRefused(reader.entriesFor(claim), 'enrollment_invalid', `participant claim ${String(claim)}`);
  assert.equal(enrollmentReads(node), 0, 'an invalid participant claim sends no nodeCall');
  // A selected-block read that the reader's own close ends is a connection change, not an unavailable read.
  const closing = world(t), closingReader = closing.open(), blockEntered = deferred();
  closing.node.block = () => { blockEntered.resolve(); return new Promise(() => {}); };
  const pending = closingReader.entriesFor(BUYER);
  await blockEntered.promise;
  closingReader.close();
  await assertRefused(pending, 'enrollment_connection_changed', 'close during the selected-block read', (error) => assert.ok(error.cause));
});

test('literal duplicate-key JSON is refused by the bounded bridge before decoded proof verification', async (t) => {
  const { node, open } = world(t), reader = open();
  node.reply = (data) => {
    const text = JSON.stringify(signedAnswer(data));
    return jsonResponse(`{"result":200,${text.slice(1)}`);
  };
  await assertRefused(reader.entriesFor(BUYER), 'enrollment_invalid', 'duplicate member', (error) => {
    assert.equal(error.cause.kind, 'invalid');
    assert.equal(typeof error.cause.code, 'string');
  });
  assert.equal(node.calls.at(-1), MESSAGE, 'no selected-block read follows the refused reply');
});

test('a queued read times out on its own deadline while the first read stays active', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { node, open } = world(t), reader = open(), entered = deferred();
  // Only the first enrollment reply stalls; a read that got its turn after the first ended would be answered at once.
  let stalled = false;
  node.reply = (data) => {
    if (stalled) return jsonResponse(JSON.stringify(signedAnswer(data)));
    stalled = true;
    entered.resolve();
    return new Promise(() => {});
  };
  const first = reader.entriesFor(BUYER);
  await entered.promise;
  const queued = reader.entriesFor(BUYER);
  const settled = [];
  first.catch(() => settled.push('first'));
  queued.catch(() => settled.push('queued'));
  t.mock.timers.tick(DEADLINE_MS - 1);
  await flush();
  assert.deepEqual(settled, [], 'both reads are inside their deadline');
  t.mock.timers.tick(1);
  await assertRefused(queued, 'enrollment_timeout', 'queued read');
  await assertRefused(first, 'enrollment_timeout', 'first read');
  assert.equal(enrollmentReads(node), 1, 'the queued read timed out waiting and never reached the node');
});

test('a replayed old nonce refuses against the live request, and a valid signature whose signed height now selects a block with a different hash refuses `enrollment_unverified`', async (t) => {
  await t.test('an answer kept from an earlier call', async (t) => {
    const { node, open } = world(t), reader = open();
    let kept = null;
    node.reply = (data) => { kept ??= signedAnswer(data); return jsonResponse(JSON.stringify(kept)); };
    assert.deepEqual(await reader.entriesFor(BUYER), [entryFor(BUYER)]);
    await assertRefused(reader.entriesFor(BUYER), 'enrollment_unverified', 'replayed nonce');
  });
  await t.test('the signed height now selects another block', async (t) => {
    const { node, open } = world(t), reader = open();
    assert.deepEqual(await reader.entriesFor(BUYER), [entryFor(BUYER)]);
    node.block = () => blockAnswer('c'.repeat(64));
    await assertRefused(reader.entriesFor(BUYER), 'enrollment_unverified', 'changed block hash');
  });
});

test("the main-entry reader requires the caller's own trust pin and a missing or mismatched pin admits nothing", async (t) => {
  assert.equal(fromMainEntry, openVerifiedEnrollmentReader);
  const { node, options } = world(t);
  const { trustedNode: _pin, ...withoutPin } = options;
  const refusals = [[withoutPin, 'enrollment_invalid'], [{ ...options, trustedNode: { ...options.trustedNode, publicKey: 'TEST' } }, 'enrollment_invalid'],
    [{ ...options, trustedNode: { ...options.trustedNode, chainIdentity: sha256Hex('another chain') } }, 'enrollment_unverified']];
  for (const [given, code] of refusals) assert.throws(() => fromMainEntry(given), (error) => error instanceof OperationError && error.code === code, code);
  assert.equal(node.urls.length, 0, 'no nodeCall before a pin is accepted');
  const reader = fromMainEntry({ ...options, trustedNode: trustedNodeFor(OTHER_KEY) });
  t.after(() => reader.close());
  for (let call = 0; call < 2; call++) await assertRefused(reader.entriesFor(BUYER), 'enrollment_unverified', `read ${call} under another signer's pin`);
  assert.ok(node.urls.every((url) => url === NODE_ENDPOINT), 'no request goes to another node');
});

test('a caller abort during an active enrollment read rejects at once and a late signed reply admits nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { node, open } = world(t), reader = open(), entered = deferred(), late = deferred();
  node.reply = (data) => { entered.resolve(); return late.promise.then(() => jsonResponse(JSON.stringify(signedAnswer(data)))); };
  const caller = new AbortController(), reason = new Error('TEST the buyer left');
  const pending = reader.entriesFor(BUYER, { sessionId: 'TEST-session', signal: caller.signal });
  await entered.promise;
  caller.abort(reason);
  // No timer is advanced: the rejection comes from the abort, not from the deadline.
  await assertRefused(pending, 'enrollment_unavailable', 'caller abort', (error) => assert.equal(error.cause, reason));
  const callsAtAbort = node.calls.length;
  late.resolve();
  await flush();
  assert.equal(node.calls.length, callsAtAbort, 'the late signed reply starts no further read');
  node.reply = (data) => jsonResponse(JSON.stringify(signedAnswer(data)));
  assert.deepEqual(await reader.entriesFor(BUYER), [entryFor(BUYER)], 'the next call reads again');
});
