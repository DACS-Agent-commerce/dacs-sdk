import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { createInMemoryDemosSr2Journal, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { seller } from './helpers/protocol-fixture.mjs';

const FOREIGN_ROWS = 40;
const RPC_ORIGIN = 'http://127.0.0.1:9922';
const MISSING_ADDRESS = `stor-${'f'.repeat(40)}`;
const foreignAddress = index => `stor-${index.toString(16).padStart(40, '0')}`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });

// The fixture's own program plus `count` same-name programs owned by someone else.
function foreignFixture({ count = FOREIGN_ROWS, retainedNativeAddress, ownRowInIndex = true, indexDown = false } = {}) {
  const foreignReads = [];
  const probe = readbackFixture();
  const foreignRows = Array.from({ length: count }, (_, index) => ({ programName: probe.native.programName, storageAddress: foreignAddress(index + 1) }));
  const journal = createInMemoryDemosSr2Journal(retainedNativeAddress === undefined ? [] : [{
    planId: 'TEST-retained-plan', scope: canonicalize([RPC_ORIGIN, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY]),
    logicalAddress: probe.logicalAddress, writer: seller.claim, nativeAddress: retainedNativeAddress, stage: 'verified',
    authorizationProfile: 'embedded-storage-anchor-create', authorizationMessage: probe.signed.hash, authorizedTransaction: probe.signed,
    envelopeHash: sha256Hex(canonicalize(probe.native.data)), hash: probe.native.metadata.contentHash, artifactKind: probe.native.metadata.artifactKind }]);
  const f = readbackFixture({ journal, respond: (url, init, state) => {
    const { pathname } = new URL(url);
    if (pathname === `/storage-program/${MISSING_ADDRESS}`) return json({ success: false }, 404);
    if (indexDown && init?.body &&JSON.parse(init.body).params[0].message === 'searchStoragePrograms') return json({ error: 'TEST name index unavailable' }, 503);
    if (pathname.startsWith('/storage-program/stor-') && pathname.slice('/storage-program/'.length) !== state.native.storageAddress) {
      foreignReads.push(pathname);
      return json({ ...state.native, storageAddress: pathname.slice('/storage-program/'.length), owner: 'TEST-other-owner' });
    }
  } });
  f.rows.splice(0, f.rows.length, ...(ownRowInIndex ? f.rows : []), ...foreignRows);
  return { ...f, foreignReads };
}
const read = (f, options = {}) => f.adapter.read(f.logicalAddress, { expectedWriter: seller.claim, ...options });
const budgetExceeded = { code: 'indeterminate', message: /native candidate budget exceeded/ };

test('a supplied native address is read as present without reading more foreign same-name programs than the cap', async () => {
  const f = foreignFixture();
  const result = await read(f, { nativeAddress: f.native.storageAddress });
  assert.equal(result.status, 'present');
  assert.deepEqual(f.foreignReads, []);
});

test('a supplied native address with a few foreign same-name programs is present after their owner check', async () => {
  const f = foreignFixture({ count: 3 });
  assert.equal((await read(f, { nativeAddress: f.native.storageAddress })).status, 'present');
  assert.equal(f.foreignReads.length, 3);
});

test('a retained native address is read as present without reading more foreign same-name programs than the cap', async () => {
  const probe = readbackFixture();
  const f = foreignFixture({ retainedNativeAddress: probe.native.storageAddress });
  const result = await read(f);
  assert.equal(result.status, 'present');
  assert.deepEqual(f.foreignReads, []);
});

test('a supplied native address owned by someone else falls back to the name index and exceeds the foreign read budget', async () => {
  const f = foreignFixture();
  await assert.rejects(read(f, { nativeAddress: foreignAddress(1) }), budgetExceeded);
});

test('a supplied native address owned by someone else falls back to the name index within the budget', async () => {
  const f = foreignFixture({ count: 3 });
  const result = await read(f, { nativeAddress: foreignAddress(1) });
  assert.equal(result.status, 'present');
  assert.equal(f.foreignReads.length, 3);
});

test('without any address more foreign same-name programs than the read budget stay indeterminate', async () => {
  const f = foreignFixture();
  await assert.rejects(read(f), budgetExceeded);
  assert.deepEqual(f.foreignReads, []);
});

test('without any address a few foreign same-name programs do not hide the writer program', async () => {
  const f = foreignFixture({ count: 3 });
  assert.equal((await read(f)).status, 'present');
});

test('foreign programs alone leave the read indeterminate rather than absent', async () => {
  const f = foreignFixture({ count: 3, ownRowInIndex: false });
  await assert.rejects(read(f), { code: 'indeterminate', message: /does not establish authenticated absence/ });
});

test('a supplied native address that is not found falls back to the name index and finds the writer program', async () => {
  const f = foreignFixture({ count: 3 });
  assert.equal((await read(f, { nativeAddress: MISSING_ADDRESS })).status, 'present');
});

test('a supplied native address that is not found stays a miss when the name index lists nothing of the writer', async () => {
  const f = foreignFixture({ count: 3, ownRowInIndex: false });
  await assert.rejects(read(f, { nativeAddress: MISSING_ADDRESS }), { observation: 'native-address-miss' });
});

test('a supplied native address that is not found is not a miss while the name index is unavailable', async () => {
  const f = foreignFixture({ count: 3, indexDown: true });
  await assert.rejects(read(f, { nativeAddress: MISSING_ADDRESS }), error => error.observation !== 'native-address-miss' && /503/.test(error.message));
});
