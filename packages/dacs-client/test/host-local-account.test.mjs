// The shipped local account: one accounts row for one wallet, named after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PURCHASE_STATE_SCHEMA, createSqlitePurchaseStore, createLocalPurchaseAccount, OperationError, WalletFormatError } from '../src/index.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const NOW = 1_900_000_000_000;

function openState(t, path = ':memory:') {
  const db = new DatabaseSync(path);
  t.after(() => { if (db.isOpen) db.close(); });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
  db.exec(PURCHASE_STATE_SCHEMA);
  return { db, store: createSqlitePurchaseStore() };
}
const accountRows = (db) => db.prepare('SELECT * FROM accounts ORDER BY rowid').all().map((row) => ({ ...row }));
const insertAccount = (db, id, issuer, subject) =>
  db.prepare('INSERT INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES (?, ?, ?, ?)').run(id, issuer, subject, new Date(NOW).toISOString());

test('the local account is one accounts row named after the wallet, with issuer local-wallet and the address as subject, written once and found again after a rebuild', (t) => {
  const { db, store } = openState(t);
  const { address } = createEphemeralWallet();
  const account = createLocalPurchaseAccount({ db, store, wallet: address, now: () => NOW });
  assert.equal(account.accountId, `local:${address}`);
  assert.equal(Object.isFrozen(account), true);
  const expected = [{ id: `local:${address}`, auth_issuer: 'local-wallet', auth_subject: address, display_name: null, created_at: new Date(NOW).toISOString() }];
  assert.deepEqual(accountRows(db), expected);
  const rebuilt = createLocalPurchaseAccount({ db, store, wallet: address, now: () => NOW + 60_000 });
  assert.equal(rebuilt.accountId, account.accountId);
  assert.deepEqual(accountRows(db), expected);
});

test('listWallets answers the one wallet for its own account id and nothing for any other', (t) => {
  const { db, store } = openState(t);
  const { address } = createEphemeralWallet();
  const account = createLocalPurchaseAccount({ db, store, wallet: address, now: () => NOW });
  assert.deepEqual(account.listWallets(account.accountId), [{ address }]);
  for (const other of [`local:${createEphemeralWallet().address}`, address, 'TEST-other', undefined]) assert.deepEqual(account.listWallets(other), [], String(other));
});

test('a malformed wallet address is refused before any row is written', (t) => {
  const { db, store } = openState(t);
  for (const wallet of ['TEST-not-an-address', '0x' + 'g'.repeat(64), '0x' + 'a'.repeat(63), undefined, 42]) {
    assert.throws(() => createLocalPurchaseAccount({ db, store, wallet, now: () => NOW }), WalletFormatError, String(wallet));
  }
  assert.deepEqual(accountRows(db), []);
});

test('the local account id is local: and the normalized address for every spelling of one wallet and in two state directories, and a mismatched row for that wallet is refused local_account_mismatch', (t) => {
  const { address } = createEphemeralWallet();
  const hex = address.slice(2);
  const { db, store } = openState(t);
  for (const wallet of [address, `0x${hex.toUpperCase()}`, `0X${hex}`, hex, `  ${address}  `]) {
    assert.equal(createLocalPurchaseAccount({ db, store, wallet, now: () => NOW }).accountId, `local:${address}`, wallet);
  }
  assert.equal(accountRows(db).length, 1);

  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-account-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ids = ['first', 'second'].map((name) => {
    const state = openState(t, join(directory, `${name}.db`));
    return createLocalPurchaseAccount({ ...state, wallet: address, now: () => NOW }).accountId;
  });
  assert.deepEqual(ids, [`local:${address}`, `local:${address}`]);

  for (const [id, issuer, subject] of [[`local:${address}`, 'TEST-issuer', address], ['TEST-other', 'local-wallet', address]]) {
    const fresh = openState(t);
    insertAccount(fresh.db, id, issuer, subject);
    const before = accountRows(fresh.db);
    assert.throws(() => createLocalPurchaseAccount({ ...fresh, wallet: address, now: () => NOW }),
      (error) => error instanceof OperationError && error.code === 'local_account_mismatch', id);
    assert.deepEqual(accountRows(fresh.db), before);
  }
});
