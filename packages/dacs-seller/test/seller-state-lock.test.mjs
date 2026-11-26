import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { leaseFile } from '../src/dacs/process-lease.mjs';
import { SELLER_STATE_LOCK_FILE, SELLER_STATE_LOCK_REFUSALS } from '../src/devnet-demo/seller-state-lock.mjs';
import { privateModule } from './helpers/private-module.mjs';

const { takeOver } = await privateModule(new URL('../src/devnet-demo/seller-state-lock.mjs', import.meta.url), ['takeOver']);
const ORIGINAL = 'TEST original lock\n';
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-seller-takeover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'holders'), { mode: 0o700 });
  await writeFile(join(dir, SELLER_STATE_LOCK_FILE), ORIGINAL);
  return dir;
}
function refused(reason, cause) {
  return error => {
    assert.equal(error.code, 'seller_state_locked');
    assert.equal(error.reason, reason);
    assert.equal(error.message, SELLER_STATE_LOCK_REFUSALS[reason]);
    assert.equal(error.cause, cause());
    return true;
  };
}

test('a busy SQLite takeover section is held and keeps the native error as cause', async t => {
  const dir = await directory(t), file = leaseFile(dir, 'takeover');
  const holder = new Database(file);
  let cause;
  const exec = Database.prototype.exec;
  t.mock.method(Database.prototype, 'exec', function (...args) {
    try { return exec.apply(this, args); } catch (error) { cause = error; throw error; }
  });
  try {
    holder.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
    assert.throws(() => takeOver(dir, join(dir, SELLER_STATE_LOCK_FILE), 'TEST replacement'), refused('held', () => cause));
    assert(cause instanceof Database.SqliteError);
    assert.equal(cause.code, 'SQLITE_BUSY');
    assert.equal(await readFile(join(dir, SELLER_STATE_LOCK_FILE), 'utf8'), ORIGINAL);
  } finally { holder.close(); }
});

test('a corrupt SQLite takeover section is doubt and keeps the native error as cause', async t => {
  const dir = await directory(t);
  await writeFile(leaseFile(dir, 'takeover'), 'TEST not a SQLite database'.repeat(200));
  let cause;
  const exec = Database.prototype.exec;
  t.mock.method(Database.prototype, 'exec', function (...args) {
    try { return exec.apply(this, args); } catch (error) { cause = error; throw error; }
  });
  assert.throws(() => takeOver(dir, join(dir, SELLER_STATE_LOCK_FILE), 'TEST replacement'), refused('doubt', () => cause));
  assert(cause instanceof Database.SqliteError);
  assert.equal(cause.code, 'SQLITE_NOTADB');
  assert.equal(await readFile(join(dir, SELLER_STATE_LOCK_FILE), 'utf8'), ORIGINAL);
});

for (const [name, cause, reason] of [
  ['SQLITE_LOCKED', new Database.SqliteError('TEST locked section', 'SQLITE_LOCKED'), 'held'],
  ['SQLITE_IOERR', new Database.SqliteError('TEST SQLITE_BUSY text with an I/O code', 'SQLITE_IOERR'), 'doubt'],
  ['permission error', Object.assign(new Error('TEST SQLITE_LOCKED text with a filesystem code'), { code: 'EACCES' }), 'doubt'],
  ['missing code', new Error('TEST SQLITE_BUSY and SQLITE_LOCKED text without a code'), 'doubt'],
]) {
  test(`a takeover exec ${name} is ${reason}, preserves its cause and closes the section`, async t => {
    const dir = await directory(t);
    let section;
    t.mock.method(Database.prototype, 'exec', function () { section = this; throw cause; });
    assert.throws(() => takeOver(dir, join(dir, SELLER_STATE_LOCK_FILE), 'TEST replacement'), refused(reason, () => cause));
    assert.equal(section.open, false);
    assert.equal(await readFile(join(dir, SELLER_STATE_LOCK_FILE), 'utf8'), ORIGINAL);
  });
}
