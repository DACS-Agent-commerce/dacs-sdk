// Entirely in-memory read receipts. No HTTP server, SDK connection or wallet.
// Hashes are independently derived fixture identities, never public-chain pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDemosNetworkBinder, DEMOS_NETWORK_BINDING_VERSION, NetworkBindingError } from '../src/dacs/network-binding.mjs';

const hash = (label) => createHash('sha256').update(label).digest('hex');
const A = hash('offline-only-Demos-network-A');
const B = hash('offline-only-Demos-network-B');
const FIRST = hash('offline-only-network-A-block-one');
const TIME = 1_700_000_000_000;
const AGE = 1000;
const EXPECTED = Object.freeze({
  network: 'offline-demos-a', chainIdentity: A, pinVersion: 'offline-fixture-pin-v1',
  endpoint: 'https://fixture.invalid/rpc', transportAuthority: 'offline-fixture-transport-v1',
});
const FALLBACK = Object.freeze({
  blockZeroUnavailable: 'literal-error',
  documentation: 'offline fixture contract: block zero returns literal error; block one has its confirmed genesis predecessor',
});
const zero = () => ({ number: 0, status: 'confirmed', hash: A });
const first = () => ({ number: 1, status: 'confirmed', hash: FIRST, content: { previousHash: A } });
const err = (code) => (error) => error instanceof NetworkBindingError && error.code === code;

function fixture(t, { block0 = zero(), block1 = first(), fallback = null, expected = { ...EXPECTED }, age = AGE } = {}) {
  const state = {
    time: TIME, reads: [], contextReads: 0,
    active: { network: EXPECTED.network, endpoint: EXPECTED.endpoint, transportAuthority: EXPECTED.transportAuthority, connectionId: 'connection-1' },
    blocks: [block0, block1], receipt: {}, effects: { signatures: 0, broadcasts: 0 },
    failContext: false, failRead: false, onRead: null, onContext: null,
  };
  const reader = {
    getContext: async () => {
      state.contextReads += 1;
      if (state.failContext) throw new Error('offline context unavailable');
      if (state.onContext) await state.onContext(state.contextReads);
      return { ...state.active };
    },
    getBlockByNumber: async (height, policy) => {
      assert.deepEqual(policy, { cache: 'no-store', redirect: 'error' });
      assert.equal(Object.isFrozen(policy), true);
      state.reads.push(height);
      if (state.failRead) throw new Error('offline read unavailable');
      if (state.onRead) await state.onRead(height);
      return {
        value: structuredClone(state.blocks[height]), context: { ...state.active },
        observedAt: state.time, fromCache: false, redirected: false, ...state.receipt,
      };
    },
    // Deliberately available on the fixture: the binder must never use them.
    sign: () => { state.effects.signatures += 1; },
    broadcast: () => { state.effects.broadcasts += 1; },
  };
  t.after(() => assert.deepEqual(state.effects, { signatures: 0, broadcasts: 0 }));
  const binder = createDemosNetworkBinder({ expected, reader, fallback, now: () => state.time, maxAgeMs: age });
  return { state, reader, binder, expected };
}

test('accepting control: exact genesis identity persists an independently expected identity tuple', async (t) => {
  const { binder, state } = fixture(t);
  const saved = await binder.bind();
  const id = hash(JSON.stringify([
    'dacs-demos-network-binding/v1', EXPECTED.network, A, EXPECTED.pinVersion, EXPECTED.endpoint, EXPECTED.transportAuthority,
  ]));
  assert.deepEqual(saved, {
    bindingVersion: 'dacs-demos-network-binding/v1', bindingId: id, ...EXPECTED,
    connectionId: 'connection-1',
    source: { kind: 'block-zero-hash', blockNumber: 0, blockHash: A, fallbackDocumentation: null },
    observedAt: TIME, expiresAt: TIME + AGE,
  });
  assert.equal(saved.bindingVersion, DEMOS_NETWORK_BINDING_VERSION);
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.source), true);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
  assert.deepEqual(state.reads, [0]);
});

for (const [label, value] of [
  ['SDK result envelope', { result: 200, response: zero() }],
  ['SDK response wrapper', { response: zero() }],
  ['explicit genesis id alias', { id: 0, status: 'confirmed', hash: A }],
  ['consistent height and identity aliases', { ...zero(), id: 0, chainIdentity: `0x${A}`, genesisHash: A }],
  ['canonical lowercase 0x hash', { ...zero(), hash: `0x${A}` }],
]) test(`accepting control: ${label}`, async (t) => {
  const { binder } = fixture(t, { block0: value });
  assert.equal((await binder.bind()).chainIdentity, A);
});

for (const value of ['error', { result: 200, response: 'error' }]) {
  test(`accepting control: documented block-one predecessor with ${typeof value} marker`, async (t) => {
    const { binder, state } = fixture(t, { block0: value, block1: { result: 200, response: first() }, fallback: FALLBACK });
    const saved = await binder.bind();
    assert.equal(saved.chainIdentity, A);
    assert.deepEqual(saved.source, { kind: 'confirmed-block-one-predecessor', blockNumber: 1, blockHash: FIRST, fallbackDocumentation: FALLBACK.documentation });
    assert.deepEqual(state.reads, [0, 1]);
  });
}

test('a label without an independent pin/version/endpoint/authority cannot establish trust', (t) => {
  const { reader } = fixture(t);
  for (const key of Object.keys(EXPECTED)) {
    const expected = { ...EXPECTED };
    delete expected[key];
    assert.throws(() => createDemosNetworkBinder({ expected, reader }), err('unpinned_network'));
  }
  for (const change of [
    { chainIdentity: null }, { chainIdentity: '' }, { chainIdentity: A.toUpperCase() }, { chainIdentity: `${A}\n` },
    { endpoint: 'http://fixture.invalid/rpc' }, { endpoint: 'https://fixture.invalid' },
    { endpoint: 'https://user:password@fixture.invalid/rpc' }, { endpoint: 'https://fixture.invalid/rpc?q=1' },
    { endpoint: 'https://fixture.invalid/rpc#fragment' }, { pinVersion: '' }, { transportAuthority: '' },
    { network: 'Demos-testnet' }, { network: `${EXPECTED.network}\n` }, { pinVersion: `${EXPECTED.pinVersion}\n` },
    { transportAuthority: `${EXPECTED.transportAuthority}\n` }, { trusted: true },
  ]) assert.throws(() => createDemosNetworkBinder({ expected: { ...EXPECTED, ...change }, reader }), err('unpinned_network'));
});

test('construction snapshots mutable expectations and the documented fallback policy', async (t) => {
  const expected = { ...EXPECTED };
  const fallback = { ...FALLBACK };
  const { binder } = fixture(t, { expected, fallback, block0: 'error' });
  expected.chainIdentity = B;
  expected.endpoint = 'https://elsewhere.invalid/rpc';
  fallback.documentation = 'altered reference';
  const saved = await binder.bind();
  assert.equal(saved.chainIdentity, A);
  assert.equal(saved.source.fallbackDocumentation, FALLBACK.documentation);
});

for (const [label, value, code] of [
  ['wrong height', { ...zero(), number: 1 }, 'wrong_block'],
  ['string height', { ...zero(), number: '0' }, 'wrong_block'],
  ['missing height', { status: 'confirmed', hash: A }, 'wrong_block'],
  ['conflicting heights', { ...zero(), id: 1 }, 'wrong_block'],
  ['unconfirmed status', { ...zero(), status: 'pending' }, 'wrong_block'],
  ['missing status', { number: 0, hash: A }, 'wrong_block'],
  ['malformed hash', { ...zero(), hash: 'bad' }, 'malformed_observation'],
  ['space-normalized hash', { ...zero(), hash: ` ${A}` }, 'malformed_observation'],
  ['uppercase hash', { ...zero(), hash: A.toUpperCase() }, 'malformed_observation'],
  ['trailing newline hash', { ...zero(), hash: `${A}\n` }, 'malformed_observation'],
  ['conflicting identity alias', { ...zero(), chainIdentity: B }, 'conflicting_identity'],
  ['conflicting genesis alias', { ...zero(), genesisHash: B }, 'conflicting_identity'],
  ['wrong chain under the same label', { ...zero(), hash: B }, 'identity_mismatch'],
  ['null observation', null, 'malformed_observation'],
  ['array observation', [], 'malformed_observation'],
  ['undefined response', { result: 200 }, 'malformed_observation'],
  ['non-200 response', { result: 503, response: zero() }, 'unavailable'],
  ['outer and inner block aliases', { response: zero(), hash: A }, 'ambiguous_observation'],
]) test(`genesis refusal: ${label}, with no fallback read`, async (t) => {
  const { binder, state } = fixture(t, { block0: value, fallback: FALLBACK });
  await assert.rejects(binder.bind(), err(code));
  assert.deepEqual(state.reads, [0]);
});

test('literal error is unavailable without a reviewed fallback; transport failures never enable it', async (t) => {
  const noFallback = fixture(t, { block0: 'error' });
  await assert.rejects(noFallback.binder.bind(), err('unavailable'));
  assert.deepEqual(noFallback.state.reads, [0]);
  const failed = fixture(t, { fallback: FALLBACK });
  failed.state.failRead = true;
  await assert.rejects(failed.binder.bind(), err('unavailable'));
  assert.deepEqual(failed.state.reads, [0]);
  failed.state.failRead = false;
  failed.state.failContext = true;
  await assert.rejects(failed.binder.bind(), err('unavailable'));
  assert.deepEqual(failed.state.reads, [0]);
});

for (const [label, value, code] of [
  ['wrong height', { ...first(), number: 2 }, 'wrong_block'],
  ['id without required number', { id: 1, status: 'confirmed', hash: FIRST, content: { previousHash: A } }, 'wrong_block'],
  ['conflicting height aliases', { ...first(), id: 0 }, 'wrong_block'],
  ['unconfirmed status', { ...first(), status: 'pending' }, 'wrong_block'],
  ['malformed first-block hash', { ...first(), hash: 'nonblank-but-invalid' }, 'malformed_observation'],
  ['missing predecessor', { ...first(), content: {} }, 'malformed_observation'],
  ['wrong predecessor', { ...first(), content: { previousHash: B } }, 'identity_mismatch'],
  ['conflicting predecessor alias', { ...first(), previousHash: B }, 'conflicting_identity'],
  ['conflicting identity alias', { ...first(), genesisHash: B }, 'conflicting_identity'],
  ['unavailable first block', 'error', 'unavailable'],
]) test(`documented fallback refusal: ${label}`, async (t) => {
  const { binder, state } = fixture(t, { block0: 'error', block1: value, fallback: FALLBACK });
  await assert.rejects(binder.bind(), err(code));
  assert.deepEqual(state.reads, [0, 1]);
});

for (const [label, change, code] of [
  ['cached read', { fromCache: true }, 'cached_observation'],
  ['unspecified cache status', { fromCache: undefined }, 'cached_observation'],
  ['followed redirect', { redirected: true }, 'redirected_observation'],
  ['unspecified route status', { redirected: undefined }, 'redirected_observation'],
  ['stale response', { observedAt: TIME - AGE - 1 }, 'stale_observation'],
  ['prior response even within age limit', { observedAt: TIME - 1 }, 'stale_observation'],
  ['future response', { observedAt: TIME + 1 }, 'stale_observation'],
  ['noninteger response time', { observedAt: TIME + 0.5 }, 'stale_observation'],
]) test(`transport receipt refusal: ${label}`, async (t) => {
  const { binder, state } = fixture(t);
  state.receipt = change;
  await assert.rejects(binder.bind(), err(code));
});

for (const [key, replacement] of [
  ['network', 'demos-testnet'], ['endpoint', 'https://fixture.invalid/other-rpc'],
  ['endpoint', 'https://swapped.invalid/rpc'], ['transportAuthority', 'different-transport-v1'],
]) test(`transport authority refusal: changed ${key}=${replacement}`, async (t) => {
  const { binder, state } = fixture(t);
  state.active[key] = replacement;
  await assert.rejects(binder.bind(), err('transport_mismatch'));
  assert.deepEqual(state.reads, []);
});

test('a receipt from another endpoint or connection cannot borrow the active transport authority', async (t) => {
  for (const change of [{ endpoint: 'https://fixture.invalid/swapped' }, { connectionId: 'old-connection' }]) {
    const { binder, state } = fixture(t);
    state.receipt.context = { ...state.active, ...change };
    await assert.rejects(binder.bind(), err('transport_mismatch'));
  }
});

test('reconnect and endpoint changes during the read invalidate the observation', async (t) => {
  const reconnect = fixture(t);
  reconnect.state.onRead = () => { reconnect.state.active.connectionId = 'connection-2'; };
  await assert.rejects(reconnect.binder.bind(), err('transport_mismatch'));
  const endpointSwap = fixture(t);
  endpointSwap.state.onContext = (count) => {
    if (count === 3) endpointSwap.state.active.endpoint = 'https://fixture.invalid/swapped';
  };
  await assert.rejects(endpointSwap.binder.bind(), err('transport_mismatch'));
  const lateReconnect = fixture(t);
  lateReconnect.state.onContext = (count) => {
    if (count === 4) lateReconnect.state.active.connectionId = 'connection-2';
  };
  await assert.rejects(lateReconnect.binder.bind(), err('connection_changed'));
});

test('reconnect at a stable reviewed endpoint requires and accepts another identity read', async (t) => {
  const { binder, state } = fixture(t);
  const before = await binder.bind();
  state.active.connectionId = 'connection-2';
  const after = await binder.recheck(before);
  assert.equal(after.bindingId, before.bindingId);
  assert.equal(after.connectionId, 'connection-2');
  assert.deepEqual(state.reads, [0, 0]);
});

test('signature and broadcast fences each read again; a later chain swap fails with zero payment effects', async (t) => {
  const { binder, state } = fixture(t);
  const initial = await binder.bind();
  const signature = await binder.beforeSignature(initial);
  const broadcast = await binder.beforeBroadcast(signature);
  assert.equal(broadcast.bindingId, initial.bindingId);
  assert.deepEqual(state.reads, [0, 0, 0]);
  state.blocks[0] = { ...zero(), hash: B };
  await assert.rejects(binder.beforeSignature(broadcast), err('identity_mismatch'));
  await assert.rejects(binder.beforeBroadcast(broadcast), err('identity_mismatch'));
  state.active.endpoint = 'https://fixture.invalid/swapped';
  await assert.rejects(binder.recheck(broadcast), err('transport_mismatch'));
  assert.deepEqual(state.reads, [0, 0, 0, 0, 0]);
});

test('freshness boundary is inclusive; expired binding cannot be used at a signature or broadcast fence', async (t) => {
  const { binder, state } = fixture(t);
  const saved = await binder.bind();
  state.time = TIME + AGE;
  assert.equal((await binder.beforeSignature(saved)).observedAt, TIME + AGE);
  state.time += 1;
  await assert.rejects(binder.recheck(saved), err('stale_observation'));
  await assert.rejects(binder.beforeSignature(saved), err('stale_observation'));
  await assert.rejects(binder.beforeBroadcast(saved), err('stale_observation'));
  assert.deepEqual(state.reads, [0, 0]);
});

test('recovery compares a serialized record but requires a new observation even when the record has expired', async (t) => {
  const { binder, state } = fixture(t);
  const saved = JSON.parse(JSON.stringify(await binder.bind()));
  state.time += AGE + 10;
  state.active.connectionId = 'recovered-connection';
  const recovered = await binder.recover(saved);
  assert.equal(recovered.bindingId, saved.bindingId);
  assert.equal(recovered.connectionId, 'recovered-connection');
  assert.equal(recovered.observedAt, TIME + AGE + 10);
  assert.deepEqual(state.reads, [0, 0]);
  state.receipt.fromCache = true;
  await assert.rejects(binder.recover(saved), err('cached_observation'));
  state.receipt.fromCache = false;
  state.blocks[0] = { ...zero(), hash: B };
  await assert.rejects(binder.recover(saved), err('identity_mismatch'));
});

test('recovery refuses mismatched identities, versions, authorities and malformed saved records before reads', async (t) => {
  const { binder, state } = fixture(t);
  const saved = await binder.bind();
  for (const change of [
    { bindingVersion: 'future/v2' }, { bindingId: B }, { chainIdentity: B }, { network: 'demos-testnet' },
    { pinVersion: 'different-pin-v2' }, { endpoint: 'https://fixture.invalid/other' },
    { transportAuthority: 'different-authority' }, { connectionId: '' }, { executable: true },
    { observedAt: TIME + 1, expiresAt: TIME + AGE + 1 }, { expiresAt: TIME + AGE + 1 },
    { source: { ...saved.source, kind: 'unverified-label' } }, { source: { ...saved.source, blockHash: B } },
    { source: { ...saved.source, blockNumber: 1 } },
  ]) await assert.rejects(binder.recover({ ...saved, ...change }), err('binding_mismatch'));
  assert.deepEqual(state.reads, [0]);
  for (const method of ['recheck', 'recover', 'beforeSignature', 'beforeBroadcast']) {
    assert.throws(() => binder[method](), err('binding_mismatch'));
  }
});

test('an expired block-zero-unavailable observation cannot authorize a later fallback response', async (t) => {
  const { binder, state } = fixture(t, { block0: 'error', fallback: FALLBACK });
  state.onRead = (height) => { if (height === 1) state.time += AGE + 1; };
  await assert.rejects(binder.bind(), err('stale_observation'));
});

test('invalid policies, unstable configuration and malformed time fail closed', async (t) => {
  const { reader } = fixture(t);
  for (const maxAgeMs of [0, -1, 0.5, 60001, Infinity]) {
    assert.throws(() => createDemosNetworkBinder({ expected: EXPECTED, reader, maxAgeMs }), err('invalid_policy'));
  }
  for (const timeoutMs of [0, -1, 0.5, 60001, Infinity]) {
    assert.throws(() => createDemosNetworkBinder({ expected: EXPECTED, reader, timeoutMs }), err('invalid_policy'));
  }
  for (const fallback of [{}, { blockZeroUnavailable: 'any-error', documentation: 'reference' }, { blockZeroUnavailable: 'literal-error', documentation: '' }]) {
    assert.throws(() => createDemosNetworkBinder({ expected: EXPECTED, reader, fallback }), err('invalid_policy'));
  }
  const accessor = { ...EXPECTED };
  Object.defineProperty(accessor, 'chainIdentity', { get: () => A });
  assert.throws(() => createDemosNetworkBinder({ expected: accessor, reader }), err('unpinned_network'));
  assert.throws(() => createDemosNetworkBinder({ expected: new Proxy(EXPECTED, {}), reader }), err('unpinned_network'));
  const badClock = createDemosNetworkBinder({ expected: EXPECTED, reader, now: () => 0 });
  await assert.rejects(badClock.bind(), err('invalid_clock'));
  const overflow = fixture(t);
  overflow.state.time = Number.MAX_SAFE_INTEGER;
  await assert.rejects(overflow.binder.bind(), err('invalid_clock'));
});

test('concurrent identity observations fail closed and do not reuse an in-flight answer', async (t) => {
  const { binder, state } = fixture(t);
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  state.onRead = async () => { entered(); await held; };
  const pending = binder.bind();
  await ready;
  await assert.rejects(binder.bind(), err('binding_busy'));
  release();
  assert.equal((await pending).chainIdentity, A);
  assert.deepEqual(state.reads, [0]);
});

test('an unresponsive read or context has a bounded deadline, never activates fallback, and releases the busy fence', async (t) => {
  const { reader, state } = fixture(t);
  const binder = createDemosNetworkBinder({ expected: EXPECTED, reader, fallback: FALLBACK, now: () => state.time, timeoutMs: 20 });
  state.onRead = () => new Promise(() => {});
  await assert.rejects(binder.bind(), err('unavailable'));
  assert.deepEqual(state.reads, [0]);
  state.onRead = null;
  assert.equal((await binder.bind()).chainIdentity, A);
  const activeContext = reader.getContext;
  reader.getContext = () => new Promise(() => {});
  await assert.rejects(binder.bind(), err('unavailable'));
  reader.getContext = activeContext;
  assert.equal((await binder.bind()).chainIdentity, A);
  assert.deepEqual(state.reads, [0, 0, 0]);
});
