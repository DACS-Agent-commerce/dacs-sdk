import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import Database from 'better-sqlite3';
import { seller } from './protocol-fixture.mjs';

const [dir, phase] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const databaseFile = path => /^seller-state(?:-[0-9a-f-]{36}\.init|\.sqlite)$/.test(basename(String(path)));
const open = fs.openSync, close = fs.closeSync, exec = Database.prototype.exec, link = fs.linkSync;
let creating;
fs.openSync = function(path, ...args) {
  const fd = open.call(this, path, ...args);
  if (databaseFile(path) && (args[0] & fs.constants.O_CREAT)) creating = fd;
  return fd;
};
fs.closeSync = function(fd) {
  const result = close.call(this, fd);
  if (phase === 'file' && fd === creating) crash();
  return result;
};
Database.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (phase === 'schema' && sql.includes('CREATE TABLE seller_meta')) crash();
  return result;
};
fs.linkSync = function(source, target) {
  if (basename(target) === 'seller-state.sqlite') {
    if (phase === 'publish') crash();
    if (phase === 'concurrent') {
      process.send({ ready: true });
      assert.equal(fs.readSync(0, Buffer.alloc(2), 0, 2, null), 2);
    }
  }
  return link.call(this, source, target);
};
const mkdir = fsPromises.mkdir, cause = new Error('TEST SDK initialization failed');
if (phase === 'sdk-failure') fsPromises.mkdir = async function(path, ...args) {
  if (basename(String(path)) === 'sdk-agreements') throw cause;
  return mkdir.call(this, path, ...args);
};
syncBuiltinESMExports();
const { createSellerDurableState } = await import('../../src/dacs/seller-durable-state.mjs');
const config = { dir, signer: { claim: seller.claim, sign: seller.signBytes }, listingPin: { contentHash: 'a'.repeat(64) } };
if (phase === 'sdk-failure') {
  await assert.rejects(createSellerDurableState(config), e => e.cause === cause);
  fsPromises.mkdir = mkdir; syncBuiltinESMExports();
}
const store = await createSellerDurableState(config);
if (phase === 'opened') crash();
assert(['sdk-failure', 'concurrent'].includes(phase), 'TEST interruption boundary was not reached');
assert.equal(store.context() === null || store.context().TEST === 'shared', true);
store.retainContext({ TEST: 'shared' }); store.close();
process.disconnect();
