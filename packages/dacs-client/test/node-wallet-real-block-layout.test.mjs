import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { world } from './helpers/tp1-node-fixture.mjs';
import { TP1_APPROVED_IDENTITY_RECORD as record } from '@kynesyslabs/dacs/wire';
import { createDevnetAgreementTransport, DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,
  DEVNET_NODE2_BLOCK_LAYOUT, TP1_REVIEWED_BLOCK_TWO_HASH } from '../src/wallet/devnet-native-transport.mjs';

const observations = new URL('../../../conformance/tp1-node-observations/', import.meta.url);
const files = ['block0-2026-10-20.json', 'block1-2026-10-20.json', 'block2-2026-11-08.json'];
const bodies = files.map(file => JSON.parse(JSON.parse(readFileSync(new URL(file, observations))).body));
const otherHash = 'f'.repeat(64);
function recorded(w, mutate = () => {}) {
  const counts = [0, 0, 0];
  w.node.intercept = row => {
    const call = row.body.params[0];
    if (call.message !== 'getBlockByNumber') return;
    const height = call.data.blockNumber;
    assert.ok(height >= 0 && height <= 2, 'only the reviewed identity heights are read');
    const answer = structuredClone(bodies[height]);
    const replacement = mutate(answer, height, ++counts[height]);
    return new Response(JSON.stringify(replacement === undefined ? answer : replacement), { headers: { 'content-type': 'application/json' } });
  };
  return counts;
}
function causes(w, result) {
  const codes = [];
  for (let error = w.session.internalCauseOf(result); error; error = error.cause) codes.push(error.code);
  return codes;
}
async function signSpy(t) {
  const { Demos } = await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
  const original = Demos.prototype.sign;
  let count = 0;
  t.mock.method(Demos.prototype, 'sign', function (...args) { count++; return Reflect.apply(original, this, args); });
  return () => count;
}

test('the TP-1 reviewed block-two pin equals the recorded body and links through recorded block one to the approved identity', () => {
  assert.equal(TP1_REVIEWED_BLOCK_TWO_HASH, bodies[2].response.hash);
  assert.equal(bodies[2].response.content.previousHash, bodies[1].response.hash);
  assert.equal(bodies[1].response.content.previousHash, record.chainIdentity);
  const manifest = JSON.parse(readFileSync(new URL('manifest-2026-10-20.json', observations)));
  assert.equal(manifest.sha256[files[2]], createHash('sha256').update(readFileSync(new URL(files[2], observations))).digest('hex'));
});

test('buyer session accepts the recorded four-field block-zero error and block-one layout', async t => {
  const w = await world(t), counts = recorded(w), signs = await signSpy(t);
  const result = await w.send();
  assert.equal(result.success, true, JSON.stringify({ result, codes: causes(w, result) }));
  assert.equal(w.session.wallet.getWriteProfile().transportBinding.chainIdentity, record.chainIdentity);
  assert.equal(signs(), 1);
  assert.equal(w.node.confirms.length, 1);
  assert.equal(w.node.broadcasts.length, 1);
  assert.ok(counts.every(n => n >= 3), 'identity is freshly checked at the signing and broadcast fences');
});

test('reviewed transport binds the recorded block-one number 1 id 2', async t => {
  const w = await world(t), counts = recorded(w);
  const { profile, local } = w.admission.binding;
  const transport = createDevnetAgreementTransport({
    expected: { network: record.network, chainIdentity: profile.chainIdentity, pinVersion: profile.pinVersion,
      endpoint: local.endpoint, transportAuthority: local.transportAuthority },
    transportOwner: w.owner, journal: w.journal(), now: w.clock.now, fetchImpl: w.owner.fetchImpl,
    fallback: { blockZeroUnavailable: 'literal-error', documentation: record.provenance.documentation },
    blockZeroErrorEnvelope: DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,
    blockOneLayout: DEVNET_NODE2_BLOCK_LAYOUT, reviewedBlockTwoHash: TP1_REVIEWED_BLOCK_TWO_HASH,
  });
  t.after(() => transport.close());
  for (let i = 0; i < 2; i++) {
    const binding = await transport.observeBinding();
    assert.equal(binding.chainIdentity, record.chainIdentity);
    assert.equal(binding.source.kind, 'confirmed-block-one-predecessor');
    assert.equal(binding.source.blockHash, bodies[1].response.hash);
  }
  assert.deepEqual(counts, [2, 2, 2]);
});

const refusals = [
  ['wrong chain identity', 1, a => { a.response.content.previousHash = otherHash; }, 'identity_mismatch'],
  ['wrong block-two hash', 2, a => { a.response.hash = otherHash; }, 'identity_mismatch'],
  ['wrong block-two predecessor', 2, a => { a.response.content.previousHash = otherHash; }],
  ['legacy block-zero envelope', 0, a => { delete a.extra; delete a.require_reply; }],
  ['unknown block-zero error', 0, a => { a.extra = 'Unknown block'; }],
];
for (let height = 0; height <= 2; height++) {
  const code = 'malformed_observation';
  for (const value of ['error', null, []]) {
    refusals.push([`non-object envelope ${JSON.stringify(value)} at block ${height}`, height, () => value, code]);
  }
  refusals.push([`extra envelope field at block ${height}`, height, a => { a.unreviewed = true; }, code]);
  refusals.push([`reply requested at block ${height}`, height, a => { a.require_reply = true; }, code]);
  for (const field of Object.keys(bodies[height])) {
    refusals.push([`missing envelope ${field} at block ${height}`, height, a => { delete a[field]; }, code]);
  }
}
for (const height of [1, 2]) {
  refusals.push([`wrong height at block ${height}`, height, a => { a.response.number++; }]);
  refusals.push([`wrong database id at block ${height}`, height, a => { a.response.id++; }]);
  refusals.push([`unconfirmed block ${height}`, height, a => { a.response.status = 'pending'; }]);
  refusals.push([`unknown success envelope at block ${height}`, height, a => { a.extra = null; }]);
  refusals.push([`extra block field at block ${height}`, height, a => { a.response.unreviewed = true; }]);
  refusals.push([`extra identity alias at block ${height}`, height, a => { a.response.chainIdentity = record.chainIdentity; }]);
  refusals.push([`extra content field at block ${height}`, height, a => { a.response.content.unreviewed = true; }]);
  for (const field of Object.keys(bodies[height].response)) {
    refusals.push([`missing block ${field} at block ${height}`, height, a => { delete a.response[field]; }]);
  }
  for (const field of Object.keys(bodies[height].response.content)) {
    refusals.push([`missing content ${field} at block ${height}`, height, a => { delete a.response.content[field]; }]);
  }
}
for (const [name, height, mutate, code = 'malformed_observation'] of refusals) {
  test(`recorded buyer path refuses ${name} before signing`, async t => {
    const w = await world(t), signs = await signSpy(t);
    recorded(w, (answer, at) => { if (at === height) return mutate(answer); });
    const result = await w.send();
    assert.equal(result.success, false, JSON.stringify(result));
    assert.ok(causes(w, result).includes(code), JSON.stringify({ result, codes: causes(w, result) }));
    assert.equal(signs(), 0);
    assert.equal(w.node.confirms.length, 0);
    assert.equal(w.node.broadcasts.length, 0);
  });
}

for (const height of [1, 2]) {
  test(`recorded buyer path refuses block ${height} changing between binding and signature`, async t => {
    const w = await world(t), signs = await signSpy(t);
    recorded(w, (answer, at, count) => { if (at === height && count > 1) answer.response.content.timestamp++; });
    const result = await w.send();
    assert.equal(result.success, false);
    assert.ok(causes(w, result).includes('identity_mismatch'));
    assert.equal(signs(), 0);
    assert.equal(w.node.broadcasts.length, 0);
  });
}
test('recorded buyer path refuses a changed block-two answer at the broadcast fence', async t => {
  const w = await world(t), signs = await signSpy(t);
  recorded(w, (answer, height) => { if (height === 2 && signs() > 0) answer.response.content.timestamp++; });
  const result = await w.send();
  assert.equal(result.success, false);
  assert.ok(causes(w, result).includes('identity_mismatch'));
  assert.equal(signs(), 1);
  assert.equal(w.node.broadcasts.length, 0);
});
