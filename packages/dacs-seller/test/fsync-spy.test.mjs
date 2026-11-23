import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, open, rm } from 'node:fs/promises';
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

test('the fsync spy names FileHandle syncs from the open path without reading /proc', async (t) => {
  const path = join(await fixture(t), 'file');
  const spy = spyOnFsync();
  let handle;
  try {
    handle = await open(path, 'a');
    await handle.sync();
  } finally {
    try { await handle?.close(); } finally { spy.restore(); }
  }
  assert.deepEqual(spy.synced, [path]);
});

test('the fsync spy scopes hooks to handles it opened and restores a still-open handle', async (t) => {
  const directory = await fixture(t);
  const unrelatedPath = join(directory, 'unrelated');
  const trackedPath = join(directory, 'tracked');
  const unrelated = await open(unrelatedPath, 'a');
  let handle;
  let outerSyncCalls = 0;
  let innerSyncCalls = 0;
  const spy = spyOnFsync({ aroundSync: (_path, sync) => { outerSyncCalls += 1; return sync(); } });
  const nestedSpy = spyOnFsync({ aroundSync: (_path, sync) => { innerSyncCalls += 1; return sync(); } });
  try {
    await unrelated.sync();
    handle = await open(trackedPath, 'a');
    await handle.sync();
    assert.deepEqual(spy.synced, [trackedPath]);
    assert.deepEqual(nestedSpy.synced, [trackedPath]);
    assert.equal(outerSyncCalls, 1, 'the injected sync hook runs only for a tracked handle');
    assert.equal(innerSyncCalls, 1);
    const wrappedSync = handle.sync;
    nestedSpy.restore();
    assert.notEqual(handle.sync, wrappedSync, 'restoring a nested spy restores the earlier handle wrapper');
    await handle.sync();
    assert.deepEqual(spy.synced, [trackedPath, trackedPath]);
    assert.deepEqual(nestedSpy.synced, [trackedPath]);
    assert.equal(outerSyncCalls, 2);
    assert.equal(innerSyncCalls, 1, 'the restored inner hook no longer runs');
    spy.restore();
    assert.equal(Object.hasOwn(handle, 'sync'), false, 'restoring the outer spy removes its handle wrapper');
    await unrelated.sync();
    await handle.sync();
    assert.deepEqual(spy.synced, [trackedPath, trackedPath]);
    assert.equal(outerSyncCalls, 2, 'restored and pre-existing handles no longer run the hook');
  } finally {
    try { await handle?.close(); } finally {
      try { await unrelated.close(); } finally { nestedSpy.restore(); spy.restore(); }
    }
  }
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
