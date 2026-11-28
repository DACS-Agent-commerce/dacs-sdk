// The Agreement CREATE storage reserve the client root exports: the buyer funds check at prepare holds exactly that amount,
// and the packed client defines it once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPurchaseAdmission, T0 } from './helpers/wire-client-fixture.mjs';
import { installPackedPair } from './helpers/packed-install.mjs';

const { compositionWorld } = await import('./helpers/public-composition-world.mjs');
const client = await import('../src/index.mjs');

// The composed listing's price in OS.
const PRICE_OS = 2_500_000_000n;

// Prepares a protocol purchase with a buyer balance one OS under the price plus two network fees plus `reserveOs`, then at that sum.
async function assertFundsBoundary(t, reserveOs) {
  t.mock.method(Date, 'now', () => T0);
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const world = await compositionWorld(t);
  const buyerFeesOs = 2n * await world.chain.getTransactionFees() + BigInt(reserveOs), requiredOs = PRICE_OS + buyerFeesOs;
  world.chain.getAddressBalance = async () => requiredOs - 1n;
  await assert.rejects(world.prepare('TEST-under'), (error) => error.code === 'buyer_balance_insufficient'
    && error.details.buyerFeesOs === buyerFeesOs.toString() && error.details.requiredOs === requiredOs.toString());
  assert.equal(world.tableCounts().operations, 0);
  world.chain.getAddressBalance = async () => requiredOs;
  assert.equal((await world.prepare('TEST-at')).created, true);
}

test('the root CREATE_STORAGE_RESERVE_OS is the storage reserve the buyer funds check holds for an Agreement CREATE: a balance one OS under price plus two fees plus the export refuses, and a balance at that sum proceeds', async (t) => {
  await assertFundsBoundary(t, client.CREATE_STORAGE_RESERVE_OS);
});

test('assigning to the root CREATE_STORAGE_RESERVE_OS throws and the funds check still holds the same reserve; the export is a plain string', async (t) => {
  assert.throws(() => { client.CREATE_STORAGE_RESERVE_OS = '1'; }, TypeError);
  assert.equal(typeof client.CREATE_STORAGE_RESERVE_OS, 'string');
  await assertFundsBoundary(t, client.CREATE_STORAGE_RESERVE_OS);
});

test('the funds check and both fee ceiling paths import the one storage reserve definition', (t) => {
  const { app } = installPackedPair(t);
  const sourceDir = join(app, 'node_modules/@kynesyslabs/dacs-client/src');
  const read = (path) => readFileSync(join(sourceDir, path), 'utf8');
  const importsReserve = /^import \{[^}]*\bCREATE_STORAGE_RESERVE_OS\b[^}]*\} from '(?:\.|\.\.)\/public-admission\.mjs';$/m;
  assert.match(read('purchases.mjs'), importsReserve);
  const protocolSource = read('dacs/protocol-purchases.mjs');
  if (/\bCREATE_STORAGE_RESERVE_OS\b/.test(protocolSource)) assert.match(protocolSource, importsReserve);
  const sources = readdirSync(sourceDir, { recursive: true }).filter((path) => path.endsWith('.mjs'));
  assert.deepEqual(sources.filter((path) => /\bconst CREATE_STORAGE_RESERVE_OS\s*=/.test(read(path))), ['public-admission.mjs']);
  const reserveValue = /=\s*(?:(['"`])3_?000_?000_?000\1|3_?000_?000_?000n?\b)/;
  assert.deepEqual(sources.filter((path) => reserveValue.test(read(path))), ['public-admission.mjs'], 'no other constant holds the reserve amount');
});
