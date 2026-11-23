import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vetHostProcess } from './helpers/host-context-vet-fixture.mjs';

async function runWorker(program) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-vet-process-events-'));
  const worker = join(root, 'worker.cjs');
  const previousTmp = process.env.TMPDIR;
  const previousFork = childProcess.fork;
  let cleanup;
  let child;
  await writeFile(worker, program);
  process.env.TMPDIR = root;
  childProcess.fork = (_worker, args, options) => {
    child = previousFork(worker, args, options);
    return child;
  };
  syncBuiltinESMExports();
  try {
    const startedAt = performance.now();
    let result;
    try {
      const host = await vetHostProcess({ after: (fn) => { cleanup = fn; } },
        { dataDirectory: null }, {}, {}, { startupTimeoutMs: 2_000 });
      result = { status: 'started', host: host.host };
    } catch (error) {
      result = { status: 'rejected', error };
    }
    const readyAt = performance.now() - startedAt;
    assert.equal(typeof cleanup, 'function');
    await cleanup();
    const cleanupAt = performance.now() - startedAt;
    const leftovers = (await readdir(root)).filter((name) => name !== 'worker.cjs');
    assert.deepEqual(leftovers, [], 'startup cleanup removes the fixture folder');
    return { result, readyAt, cleanupAt };
  } finally {
    childProcess.fork = previousFork;
    syncBuiltinESMExports();
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    if (cleanup) await cleanup();
    else if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}

test('an early exit keeps its exit code and stderr in the startup error', async () => {
  const { result, cleanupAt } = await runWorker(
    `process.on('message', () => { process.stderr.write('TEST early-exit-detail\\n', () => process.exit(7)); });`);

  assert.equal(result.status, 'rejected');
  assert.match(result.error.message, /host process ended \(7\)/);
  assert.match(result.error.message, /TEST early-exit-detail/);
  assert.ok(cleanupAt < 900, `startup cleanup took ${cleanupAt.toFixed(1)} ms`);
});

test('an IPC disconnect from a still-live child rejects startup promptly', async () => {
  const { result, readyAt, cleanupAt } = await runWorker(
    `process.on('message', () => { setTimeout(() => process.disconnect(), 25); setInterval(() => {}, 1000); });`);

  assert.equal(result.status, 'rejected');
  assert.match(result.error.message, /process disconnected before reporting startup/);
  assert.ok(readyAt < 900, `disconnect rejection took ${readyAt.toFixed(1)} ms`);
  assert.ok(cleanupAt < 1_200, `direct-child cleanup took ${cleanupAt.toFixed(1)} ms`);
});

test('an inherited stderr descriptor does not delay direct-child cleanup', async () => {
  const { result, cleanupAt } = await runWorker(
    `process.on('message', () => { const { spawn } = require('node:child_process'); const reader = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'ignore', 2] }); reader.unref(); process.stderr.write('TEST inherited-pipe-detail\\n', () => process.exit(7)); });`);

  assert.equal(result.status, 'rejected');
  assert.match(result.error.message, /host process ended \(7\)/);
  assert.match(result.error.message, /TEST inherited-pipe-detail/);
  assert.ok(cleanupAt < 900, `inherited stderr delayed cleanup to ${cleanupAt.toFixed(1)} ms`);
});

