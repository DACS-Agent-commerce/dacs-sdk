import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { createHeldTransportFacade } from '../src/wallet/node-wallet-session.mjs';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
import { shared, native, captured, record, local, ownLocal, hash, envelope } from './helpers/chain-identity-fixture.mjs';

test('the string-zero genesis is cross-checked against block one and the approved pin in the shared reader, the client composition and native strict recovery', async t => {
  await t.test('documented fallback binds the recorded two-field genesis and uses typed heights', async () => {
    const h = shared();
    assert.equal((await h.binder.bind()).chainIdentity, record.chainIdentity);
    assert.deepEqual(h.heights, [0, '0', 1]);
  });
  const mutations = [
    ['hash', g => { g.response.hash = hash('TEST-other-genesis'); }, 'conflicting_identity'],
    ['number', g => { g.response.number = '0'; }, 'wrong_block'],
    ['status added', g => { g.response.status = 'confirmed'; }, 'malformed_observation'],
    ['missing hash', g => { delete g.response.hash; }, 'malformed_observation'],
    ['extra field', g => { g.response.genesisHash = g.response.hash; }, 'malformed_observation'],
    ['non-200', g => { g.result = 400; }, 'unavailable'],
    ['reply required', g => { g.require_reply = true; }, 'malformed_observation'],
    ['extra text', g => { g.extra = null; }, 'malformed_observation'],
    ['envelope field', g => { g.extraField = false; }, 'malformed_observation'],
    ['envelope missing', g => { delete g.require_reply; }, 'malformed_observation'],
    ['unavailable', g => { g.response = 'error'; }, 'malformed_observation'],
  ];
  await t.test('matching genesis and predecessor on an unapproved chain refuse', async () => {
    const wrong = hash('TEST-unapproved-chain');
    const h = shared({ answers: ['error', envelope({ number: 0, hash: wrong }), envelope({ number: 1, status: 'confirmed', hash: hash('TEST-unapproved-one'), content: { previousHash: wrong } })] });
    await assert.rejects(h.binder.bind(), { code: 'identity_mismatch' });
    assert.deepEqual(h.heights, [0, '0', 1]);
  });
  for (const [name, value] of [['null', null], ['non-200', { result: 503, response: 'error' }], ['unconfirmed', { number: 0, hash: record.chainIdentity }]]) await t.test(`a malformed or refused numeric zero never enables fallback: ${name}`, async () => {
    const h = shared({ answers: [value] });
    await assert.rejects(h.binder.bind());
    assert.deepEqual(h.heights, [0]);
  });
  for (const [name, change, code] of mutations) await t.test(`genesis ${name} refuses in shared, composed and strict readers`, async t => {
    const genesis = structuredClone(captured.genesis); change(genesis);
    const direct = shared({ answers: ['error', genesis] });
    await assert.rejects(direct.binder.bind(), { code });
    const h = native(t), binding = await h.transport.observeBinding();
    h.replies.set('0', genesis);
    await assert.rejects(h.transport.observeBinding());
    assert.equal(await h.recover(binding), false);
    assert.equal(h.effects(), 0);
  });
  await t.test('recorded captures bind through the held client facade and strict storage recovery with synthetic block two', async t => {
    const h = native(t), authority = createAuthorityFixture();
    const binding = await bindTp1Profile({ record, local: ownLocal, readAuthority: authority.read });
    const composed = createHeldTransportFacade({ admission: { binding, currentLocal: () => ownLocal }, transport: h.transport });
    const observation = await composed.observeBinding();
    assert.equal(observation.chainIdentity, record.chainIdentity);
    assert.deepEqual(h.heights, [0, '0', 1, 2]);
    assert.equal(await h.recover(observation), true, 'strict reader reached the absence check after binding');
    assert.deepEqual(h.heights, [0, '0', 1, 2]);
    assert.equal(h.effects(), 0);
  });
  for (const [name, change] of [
    ['unconfirmed block one', h => { h.replies.get(1).response.status = 'pending'; }],
    ['block-one predecessor', h => { h.replies.get(1).response.content.previousHash = hash('TEST-wrong-predecessor'); }],
    ['block-two predecessor', h => { h.replies.get(2).response.content.previousHash = record.chainIdentity; }],
    ['block-two reviewed hash', h => { h.replies.get(2).response.hash = hash('TEST-wrong-block-two'); }],
    ['block-two field set', h => { delete h.replies.get(2).response.hash; }],
  ]) await t.test(`${name} refuses through native composition and strict recovery`, async t => {
    const h = native(t), binding = await h.transport.observeBinding(); change(h);
    await assert.rejects(h.transport.observeBinding());
    assert.equal(await h.recover(binding), false);
    assert.equal(h.effects(), 0);
  });
  await t.test('ordinary strict block schema remains exact', async t => {
    const h = native(t), binding = await h.transport.observeBinding();
    delete h.replies.get(2).response.attrs;
    assert.equal(await h.recover(binding), false);
    assert.equal(h.effects(), 0);
  });
  for (const stage of ['context', 0, '0', 1]) await t.test(`context or block read timeout keeps its cause: ${typeof stage}:${stage}`, async () => {
    const cause = Object.assign(new Error('TEST-reader-timeout'), { code: 'ETIMEDOUT' });
    const h = shared({ getContext: () => { if (stage === 'context') throw cause; return { ...local }; },
      getBlock: height => { if (height === stage) throw cause; return height === 0 ? 'error' : captured.genesis; } });
    await assert.rejects(h.binder.bind(), error => error.code === 'unavailable' && error.cause === cause);
  });
  await t.test('one aggregate deadline includes the string-zero read', async t => {
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    const h = shared({ timeoutMs: 10, getBlock: height => {
      elapsed += 4;
      return height === 0 ? 'error' : height === '0' ? captured.genesis : envelope({ number: 1, status: 'confirmed' });
    } });
    await assert.rejects(h.binder.bind(), error => error.code === 'unavailable' && error.cause?.code === 'unavailable');
    assert.deepEqual(h.heights, [0, '0', 1]);
  });
  await t.test('a stalled read times out without an eventual observation', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const h = shared({ getBlock: () => { started(); return new Promise(() => {}); } });
    const assertion = assert.rejects(h.binder.bind(), error => error.code === 'unavailable' && error.cause?.code === 'unavailable');
    await ready; t.mock.timers.tick(10_000); await assertion;
  });
  for (const [name, value] of [['bytes', ' '.repeat(4 * 1024 * 1024 + 1)], ['list', envelope(Array(10_001).fill(0))]]) await t.test(`oversized genesis ${name} refuses without effects`, async t => {
    const h = native(t); h.replies.set('0', value);
    await assert.rejects(h.transport.observeBinding());
    assert.equal(h.effects(), 0);
  });
});
