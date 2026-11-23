import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spyOnFsync } from './helpers/fsync-spy.mjs';

const fixture = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-fsync-spy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const syncFile = (path) => {
  const descriptor = fs.openSync(path, 'a');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};

test('the fsync spy names a synced file without reading /proc', async (t) => {
  const path = join(await fixture(t), 'file');
  const { realpathSync, readlinkSync } = fs;
  const refuseProc = (read) => (target, ...rest) => {
    if (String(target).startsWith('/proc/')) throw new Error(`TEST /proc is not available: ${target}`);
    return read(target, ...rest);
  };
  fs.realpathSync = refuseProc(realpathSync);
  fs.readlinkSync = refuseProc(readlinkSync);
  syncBuiltinESMExports();
  const spy = spyOnFsync();
  try {
    syncFile(path);
  } finally {
    spy.restore();
    fs.realpathSync = realpathSync;
    fs.readlinkSync = readlinkSync;
    syncBuiltinESMExports();
  }
  assert.deepEqual(spy.synced, [path]);
});

test('the fsync spy runs its hook before the real sync, so a hook that throws makes the sync fail', async (t) => {
  const path = join(await fixture(t), 'file');
  const cause = new Error('TEST sync failed');
  const spy = spyOnFsync({ onSync: (synced) => { if (synced === path) throw cause; } });
  try {
    assert.throws(() => syncFile(path), (error) => error === cause);
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.synced, [path]);
});

test('the fsync spy puts back the original fs functions when restored', async (t) => {
  const path = join(await fixture(t), 'file');
  const { openSync, closeSync, fsyncSync } = fs;
  const spy = spyOnFsync();
  assert.notEqual(fs.fsyncSync, fsyncSync);
  spy.restore();
  assert.equal(fs.openSync, openSync);
  assert.equal(fs.closeSync, closeSync);
  assert.equal(fs.fsyncSync, fsyncSync);
  syncFile(path);
  assert.deepEqual(spy.synced, []);
});
