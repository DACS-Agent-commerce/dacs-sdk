import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createAuthorityFixture, LOCAL } from './fixtures/tp1-authority-reader.mjs';
import { api } from './helpers/tp1-node-fixture.mjs';
import { isTp1AuthorityLabel } from '../src/dacs/tp1-authority-label.mjs';

const APPROVED_LABEL = 'TP1-4118a9181f5d6e475c446d44eebeb9fd';
async function boundFixture() {
  const authority = createAuthorityFixture(), current = { ...LOCAL };
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...LOCAL }, readAuthority: authority.read });
  return { binding, authority, current, currentLocal: () => ({ ...current }) };
}

test("admitTp1Authority over K7-BIND-1 returns a token labelled TP1-4118a9181f5d6e475c446d44eebeb9fd; a label string is not a token", async () => {
  const { binding, currentLocal } = await boundFixture();
  const token = await api.admitTp1Authority({ binding, currentLocal });
  assert.equal(token.label, APPROVED_LABEL);
  assert.equal(api.tp1AuthorityLabel(binding), APPROVED_LABEL);
  assert.equal(binding.recordDigest.startsWith(APPROVED_LABEL.slice('TP1-'.length)), true);
  assert.equal(Object.isFrozen(token), true);
  assert.equal(api.isTp1AuthorityToken(token), true);
  assert.equal(api.authorityLabelOf(token), APPROVED_LABEL);
  for (const notToken of [APPROVED_LABEL, { ...token }, structuredClone(token), Object.freeze({ label: APPROVED_LABEL }), null, undefined]) assert.equal(api.isTp1AuthorityToken(notToken), false);
  assert.equal(api.authorityLabelOf(APPROVED_LABEL), APPROVED_LABEL);
  assert.equal(api.authorityLabelOf('TEST-seller-settlement'), 'TEST-seller-settlement');
  for (const invalid of [{ label: APPROVED_LABEL }, 7, null, undefined, 'TP1-short', 'TP1-' + 'A'.repeat(32), '']) assert.throws(() => api.authorityLabelOf(invalid), error => error.code === 'authority_unbound');
  assert.throws(() => api.tp1AuthorityLabel({ ...binding, recordDigest: 'abc' }), error => error.code === 'tp1_binding_required');
  const labelModule = readFileSync(new URL('../src/dacs/tp1-authority-label.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(labelModule, /\bimport\b|\brequire\b|node:/, 'the pure label parser imports nothing');
  for (const label of [APPROVED_LABEL, 'TP1-' + '0'.repeat(32)]) assert.equal(isTp1AuthorityLabel(label), true);
  for (const value of ['TP1-' + '0'.repeat(31), 'TP1-' + '0'.repeat(33), 'TP1-' + 'A'.repeat(32), 'tp1-' + '0'.repeat(32), 'TEST-x', 7, null]) assert.equal(isTp1AuthorityLabel(value), false);
});

test("admitTp1Authority refuses a copied binding, another connection and a stalled reader with K7 codes and causes", async t => {
  const fixture = await boundFixture(), { binding, currentLocal } = fixture;
  await assert.rejects(api.admitTp1Authority({ binding: structuredClone(binding), currentLocal }), { code: 'tp1_binding_required' });
  await assert.rejects(api.admitTp1Authority({ binding, currentLocal: () => ({ ...LOCAL, connectionId: 'TEST-other-connection' }) }), { code: 'tp1_local_binding_changed' });
  let calls = 0;
  await assert.rejects(api.admitTp1Authority({ binding, currentLocal: () => ({ ...LOCAL, connectionId: calls++ === 0 ? LOCAL.connectionId : 'TEST-replaced' }) }), { code: 'tp1_local_binding_changed' });
  const failure = new Error('TEST-reader-failed');
  fixture.authority.state.failure = failure;
  await assert.rejects(api.admitTp1Authority({ binding, currentLocal }), error => error === failure || error.cause === failure);
  fixture.authority.state.failure = null;
  fixture.authority.state.chainIdentity = 'e'.repeat(64);
  await assert.rejects(api.admitTp1Authority({ binding, currentLocal }), { code: 'tp1_connection_unverified' });
  fixture.authority.state.chainIdentity = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fixture.authority.state.gate = () => new Promise(() => {});
  const stalled = api.admitTp1Authority({ binding, currentLocal });
  const outcome = assert.rejects(stalled, error => error.code === 'tp1_authority_timeout' && error.cause?.kind === 'timeout');
  await new Promise(setImmediate);
  t.mock.timers.tick(10_000);
  await outcome;
  for (const missing of [undefined, {}, { binding }, { currentLocal }]) await assert.rejects(api.admitTp1Authority(missing), error => error.code === 'tp1_binding_required');
});
