import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
import { shared, native, captured, envelope, record, local, ownLocal, hash, expected, fallback, NOW, stabilisedGenesis, stabilisedReplies, stabilisedShared } from './helpers/chain-identity-fixture.mjs';
// Loaded after the admission hook, so the effect boundary under test sees the admission double.
const { createDemosNetworkBinder } = await import('../src/dacs/network-binding.mjs');
const { createSourceObserver } = await import('../src/wallet/devnet-native-transport.mjs');
const { createHeldTransportFacade } = await import('../src/wallet/node-wallet-session.mjs');

const OTHER = hash('TEST-other-chain');
const reader = { getContext: () => ({ ...local }), getBlockByNumber: () => {}, getChainIdentity: () => {} };
const BINDER_OPTIONS = { expected, stabilisedGenesis, now: () => NOW, reader };

test('a stabilised genesis is part of the pin and is checked when the binder is built', async t => {
  await t.test('a pin that carries both the literal-error fallback and a stabilised genesis is refused', () => {
    assert.throws(() => createDemosNetworkBinder({ ...BINDER_OPTIONS, fallback }), { code: 'invalid_policy' });
  });
  const withoutBlockOneHash = Object.fromEntries(Object.entries(stabilisedGenesis).filter(([key]) => key !== 'blockOneHash'));
  for (const [name, policy] of [
    ['an unknown representation', { ...stabilisedGenesis, representation: 'literal-error' }],
    ['a missing reviewed value', withoutBlockOneHash],
    ['an extra field', { ...stabilisedGenesis, extra: true }],
    ['a block-one hash that is not canonical', { ...stabilisedGenesis, blockOneHash: stabilisedGenesis.blockOneHash.toUpperCase() }],
    ['a genesis hash that is not the pinned chain identity', { ...stabilisedGenesis, genesisHash: OTHER }],
    ['a chain id that is neither text nor null', { ...stabilisedGenesis, chainId: 7 }],
    ['empty documentation', { ...stabilisedGenesis, documentation: ' ' }],
    ['a policy that is not a record', stabilisedGenesis.representation],
  ]) await t.test(`a stabilised genesis policy with ${name} is refused`, () => {
    assert.throws(() => createDemosNetworkBinder({ ...BINDER_OPTIONS, stabilisedGenesis: policy }), { code: 'invalid_policy' });
  });
  await t.test('a stabilised genesis needs a reader with a chain-identity read', () => {
    assert.throws(() => createDemosNetworkBinder({ ...BINDER_OPTIONS, reader: { getContext: reader.getContext, getBlockByNumber: reader.getBlockByNumber } }), { code: 'invalid_reader' });
  });
});

test('numeric block zero, the chain-identity read and confirmed block one bind only when all three match every reviewed value', async t => {
  await t.test('matching reads bind, and the requests are numeric 0, the chain identity and numeric 1 in that order', async () => {
    const h = stabilisedShared();
    const binding = await h.binder.bind();
    assert.equal(binding.chainIdentity, record.chainIdentity);
    assert.deepEqual(binding.source, { kind: 'stabilised-genesis', blockNumber: 0, blockHash: record.chainIdentity, fallbackDocumentation: stabilisedGenesis.documentation });
    assert.deepEqual(h.reads, [0, 'chainIdentity', 1]);
  });
  await t.test('a pin that reviewed a null chain id binds when the node reports null', async () => {
    const replies = stabilisedReplies();
    replies.chainIdentity.response.chainId = null;
    const h = stabilisedShared({ replies, policy: { ...stabilisedGenesis, chainId: null } });
    assert.equal((await h.binder.bind()).chainIdentity, record.chainIdentity);
    assert.deepEqual(h.reads, [0, 'chainIdentity', 1]);
  });
  await t.test('every bind and every fence reads block zero, the chain identity and block one again', async () => {
    const h = stabilisedShared();
    const binding = await h.binder.bind();
    await h.binder.recheck(binding);
    await h.binder.beforeSignature(binding);
    await h.binder.beforeBroadcast(binding);
    await h.binder.recover(binding);
    assert.deepEqual(h.reads, Array(5).fill([0, 'chainIdentity', 1]).flat());
  });
  for (const [name, change] of [
    ['the genesis hash on all three reads', r => { r[0].response.hash = OTHER; r.chainIdentity.response.genesisHash = OTHER; r[1].response.content.previousHash = OTHER; }],
    ['the chain id', r => { r.chainIdentity.response.chainId = 'TEST-other-chain-id'; }],
    ['the genesis data hash', r => { r.chainIdentity.response.genesisDataHash = hash('TEST-other-data'); }],
    ['the block-one hash', r => { r[1].response.hash = hash('TEST-other-block-one'); }],
  ]) await t.test(`reads that agree with each other but differ from the reviewed ${name} refuse`, async () => {
    const replies = stabilisedReplies(); change(replies);
    await assert.rejects(stabilisedShared({ replies }).binder.bind(), { code: 'identity_mismatch' });
  });
  for (const [name, change] of [
    ['block zero and the chain-identity read', r => { r[0].response.hash = OTHER; }],
    ['the chain-identity read and block zero', r => { r.chainIdentity.response.genesisHash = OTHER; }],
    ['block one\'s predecessor and block zero', r => { r[1].response.content.previousHash = OTHER; }],
    ['a block\'s own chain identity alias and its hash', r => { r[0].response.chainIdentity = OTHER; }],
  ]) await t.test(`disagreement between ${name} refuses as conflicting`, async () => {
    const replies = stabilisedReplies(); change(replies);
    await assert.rejects(stabilisedShared({ replies }).binder.bind(), { code: 'conflicting_identity' });
  });
  for (const [name, change, code] of [
    ['block zero answers the literal error', r => { r[0] = 'error'; }, 'genesis_representation_mismatch'],
    ['block zero is unconfirmed', r => { r[0].response.status = 'pending'; }, 'wrong_block'],
    ['block zero has another number', r => { r[0].response.number = 1; }, 'wrong_block'],
    ['block zero has a string number instead of numeric zero', r => { r[0].response.number = '0'; }, 'wrong_block'],
    ['block zero has no hash', r => { delete r[0].response.hash; }, 'malformed_observation'],
    ['the chain-identity read is not result 200', r => { r.chainIdentity.result = 400; }, 'unavailable'],
    ['the chain-identity envelope has an extra field', r => { r.chainIdentity.extraField = 1; }, 'malformed_observation'],
    ['the chain-identity reply is not a record', r => { r.chainIdentity.response = 'error'; }, 'malformed_observation'],
    ['the chain-identity reply has an extra member', r => { r.chainIdentity.response.nodeClaim = 'TEST-claim'; }, 'malformed_observation'],
    ['the chain-identity reply has no genesis hash', r => { delete r.chainIdentity.response.genesisHash; }, 'malformed_observation'],
    ['the chain-identity genesis hash is not canonical', r => { r.chainIdentity.response.genesisHash = stabilisedGenesis.genesisHash.toUpperCase(); }, 'malformed_observation'],
    ['block one is unconfirmed', r => { r[1].response.status = 'pending'; }, 'wrong_block'],
    ['block one answers the literal error', r => { r[1] = 'error'; }, 'unavailable'],
    ['block one has no predecessor', r => { delete r[1].response.content.previousHash; }, 'malformed_observation'],
  ]) await t.test(`a malformed or refused read refuses with its own code: ${name}`, async () => {
    const replies = stabilisedReplies(); change(replies);
    await assert.rejects(stabilisedShared({ replies }).binder.bind(), { code });
  });
});

test('a change of connection or transport during the identity reads keeps the binding held', async t => {
  await t.test('a reconnect during the chain-identity read refuses as a connection change', async () => {
    let reconnected = false;
    const h = stabilisedShared({ getReply: key => { if (key === 'chainIdentity') reconnected = true; return stabilisedReplies()[key]; },
      getContext: () => ({ ...local, connectionId: reconnected ? 'TEST-other-connection' : local.connectionId }) });
    await assert.rejects(h.binder.bind(), { code: 'connection_changed' });
  });
  await t.test('a chain-identity receipt from another connection refuses as a transport mismatch', async () => {
    const h = stabilisedShared({ receiptContext: key => ({ ...local, connectionId: key === 'chainIdentity' ? 'TEST-other-connection' : local.connectionId }) });
    await assert.rejects(h.binder.bind(), { code: 'transport_mismatch' });
  });
  await t.test('a chain-identity read failure keeps its cause', async () => {
    const cause = Object.assign(new Error('TEST-reader-timeout'), { code: 'ETIMEDOUT' });
    const h = stabilisedShared({ getReply: key => { if (key === 'chainIdentity') throw cause; return stabilisedReplies()[key]; } });
    await assert.rejects(h.binder.bind(), error => error.code === 'unavailable' && error.cause === cause);
  });
  await t.test('one aggregate deadline includes the chain-identity read', async t => {
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    const h = stabilisedShared({ timeoutMs: 10, getReply: key => { elapsed += 4; return stabilisedReplies()[key]; } });
    await assert.rejects(h.binder.bind(), error => error.code === 'unavailable' && error.cause?.code === 'unavailable');
    assert.deepEqual(h.reads, [0, 'chainIdentity', 1]);
  });
});

test('a saved binding of the other genesis representation is refused under each pin', async () => {
  const literal = await shared().binder.bind();
  const stabilised = await stabilisedShared().binder.bind();
  const plain = await createDemosNetworkBinder({ expected, now: () => NOW, reader: { getContext: () => ({ ...local }),
    async getBlockByNumber() { return { value: { number: 0, status: 'confirmed', hash: record.chainIdentity, content: {} }, context: { ...local }, observedAt: NOW, fromCache: false, redirected: false }; } } }).bind();
  await stabilisedShared().binder.recheck(stabilised);
  await assert.rejects(stabilisedShared().binder.recheck(literal), { code: 'binding_mismatch' });
  await assert.rejects(stabilisedShared().binder.recheck(plain), { code: 'binding_mismatch' });
  await assert.rejects(shared().binder.recheck(stabilised), { code: 'binding_mismatch' });
});

test('a saved binding is refused when its source differs from the literal-error pin', async t => {
  const saved = await shared().binder.bind();
  await shared().binder.recheck(saved);
  for (const [name, source] of [
    ['another reviewed reference', { ...saved.source, fallbackDocumentation: 'TEST other reference' }],
    ['another block number', { ...saved.source, blockNumber: 0 }],
    ['a stabilised genesis kind', { ...saved.source, kind: 'stabilised-genesis' }],
  ]) await t.test(`a saved source with ${name} is refused`, async () => {
    await assert.rejects(shared().binder.recheck({ ...saved, source }), { code: 'binding_mismatch' });
  });
});

test('a block-one previousHash that contradicts its content refuses as conflicting under both genesis representations', async t => {
  await t.test('literal-error fallback', async () => {
    const one = envelope({ number: 1, status: 'confirmed', hash: captured.one.response.hash, previousHash: OTHER, content: { previousHash: record.chainIdentity } });
    await assert.rejects(shared({ answers: ['error', captured.genesis, one] }).binder.bind(), { code: 'conflicting_identity' });
  });
  await t.test('stabilised genesis', async () => {
    const replies = stabilisedReplies();
    replies[1].response.previousHash = OTHER;
    await assert.rejects(stabilisedShared({ replies }).binder.bind(), { code: 'conflicting_identity' });
  });
});

test('the client composition and native strict recovery bind and refuse on a stabilised genesis', async t => {
  await t.test('the held client facade binds through the native transport and strict recovery reaches the absence check', async t => {
    const h = native(t, { stabilised: true }), authority = createAuthorityFixture();
    const binding = await bindTp1Profile({ record, local: ownLocal, readAuthority: authority.read });
    const composed = createHeldTransportFacade({ admission: { binding, currentLocal: () => ownLocal }, transport: h.transport });
    const observation = await composed.observeBinding();
    assert.equal(observation.chainIdentity, record.chainIdentity);
    assert.deepEqual(h.heights, [0, 'chainIdentity', 1]);
    assert.equal(await h.recover(observation), true, 'strict reader reached the absence check after binding');
    assert.deepEqual(h.heights, [0, 'chainIdentity', 1]);
    assert.equal(h.effects(), 0);
  });
  await t.test('the source observer binds on a stabilised genesis with the same requests', async () => {
    const replies = stabilisedReplies(), reads = [];
    const observer = createSourceObserver({ record, timeoutMs: 1000, now: () => NOW, stabilisedGenesis, owner: {
      currentLocal: () => ({ endpoint: local.endpoint, transportAuthority: local.transportAuthority }), getContext: () => ({ ...local }),
      fetchImpl: async (_url, options) => {
        const call = JSON.parse(options.body).params[0], key = call.message === 'getChainIdentity' ? 'chainIdentity' : call.data.blockNumber;
        reads.push(key);
        return new Response(JSON.stringify(replies[key]), { headers: { 'content-type': 'application/json' } });
      } } });
    assert.equal((await observer.bind()).chainIdentity, record.chainIdentity);
    assert.deepEqual(reads, [0, 'chainIdentity', 1]);
  });
  for (const [name, change] of [
    ['block zero differing from the chain-identity read', h => { h.replies.get(0).response.hash = OTHER; }],
    ['a chain-identity read differing from a reviewed value', h => { h.replies.get('chainIdentity').response.chainId = 'TEST-other-chain-id'; }],
    ['a block-one hash differing from the review', h => { h.replies.get(1).response.hash = OTHER; }],
    ['a block-one predecessor differing from block zero', h => { h.replies.get(1).response.content.previousHash = OTHER; }],
    ['an unconfirmed block one', h => { h.replies.get(1).response.status = 'pending'; }],
    ['a chain-identity answer without the node envelope fields', h => { delete h.replies.get('chainIdentity').require_reply; }],
    ['a chain-identity read that is not result 200', h => { h.replies.get('chainIdentity').result = 503; }],
    ['a literal error for numeric block zero', h => { h.replies.set(0, { result: 400, response: 'error' }); }],
  ]) await t.test(`${name} refuses through native composition and strict recovery`, async t => {
    const h = native(t, { stabilised: true }), binding = await h.transport.observeBinding(); change(h);
    await assert.rejects(h.transport.observeBinding());
    assert.equal(await h.recover(binding), false);
    assert.equal(h.effects(), 0);
  });
  await t.test('strict recovery keeps the exact block schema for numeric block zero and block one', async t => {
    // Recovery signs its retained write once per transport, so each block's schema gets its own transport.
    const zero = native(t, { stabilised: true }), zeroBinding = await zero.transport.observeBinding();
    zero.replies.get(0).response.content = {};
    await zero.transport.observeBinding();
    assert.equal(await zero.recover(zeroBinding), false);
    const one = native(t, { stabilised: true }), oneBinding = await one.transport.observeBinding();
    delete one.replies.get(1).response.attrs;
    assert.equal(await one.recover(oneBinding), false);
    assert.equal(zero.effects() + one.effects(), 0);
  });
  for (const [name, value] of [['bytes', ' '.repeat(4 * 1024 * 1024 + 1)], ['list', { result: 200, response: Array(10_001).fill(0), require_reply: false, extra: '' }]]) await t.test(`an oversized chain-identity ${name} refuses without effects`, async t => {
    const h = native(t, { stabilised: true }); h.replies.set('chainIdentity', value);
    await assert.rejects(h.transport.observeBinding());
    assert.equal(h.effects(), 0);
  });
});
