// vetHostProcess (host-context-vet-fixture.mjs) bounds its child's startup, and removes the child's temporary folder also when fork throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as later } from 'node:timers/promises';
import { vetHostProcess } from './helpers/host-context-vet-fixture.mjs';

const SILENT = new URL('./helpers/silent-host-process.mjs', import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const gone = async (pid, ms) => { for (const end = performance.now() + ms; alive(pid); await sleep(10)) if (performance.now() > end) return false; return true; };

/** Runs `work` with TMPDIR, and so the fixture's folders, in a folder of its own, and returns the names `work` left in it. */
async function leftIn(work) {
  const own = await mkdtemp(join(tmpdir(), 'TEST-vet-fixture-'));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try { await work(); return await readdir(own); } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    await rm(own, { recursive: true, force: true });
  }
}

test('a child that never reports its start is killed at the startup deadline, and its folder is removed', async (t) => {
  let outcome;
  const left = await leftIn(() => t.test('start', async (st) => {
    const started = performance.now();
    // Without a deadline the fixture would wait forever: a 5 s race stands in, and the subtest's end then kills the child.
    outcome = await Promise.race([vetHostProcess(st, { dataDirectory: null }, {}, {}, { worker: SILENT, startupTimeoutMs: 1_000 }).then(() => 'started', (error) => error), later(5_000, 'no deadline', { ref: false })]);
    outcome = { outcome, elapsedMs: performance.now() - started };
    if (outcome.outcome instanceof Error) {
      const pid = Number(outcome.outcome.message.match(/pid=(\d+)/)?.[1]);
      outcome.killedAtDeadline = await gone(pid, 2_000);
    }
  }));
  assert.match(outcome.outcome?.message ?? String(outcome.outcome), /did not report its start within 1000 ms/);
  assert.ok(outcome.elapsedMs < 4_000, `the deadline ended the wait after ${outcome.elapsedMs} ms`);
  assert.equal(outcome.killedAtDeadline, true, 'the child is killed at the deadline, not only when the test ends');
  assert.deepEqual(left, [], 'no temporary folder is left');
});

test('the child\'s temporary folder is removed also when fork throws', async (t) => {
  const fork = childProcess.fork;
  childProcess.fork = () => { throw Object.assign(new Error('TEST fork refuses'), { code: 'TEST_FORK' }); };
  syncBuiltinESMExports();
  try {
    const left = await leftIn(() => t.test('fork throws', async (st) => {
      await assert.rejects(vetHostProcess(st, { dataDirectory: null }, {}, {}, { worker: SILENT }), { code: 'TEST_FORK' });
    }));
    assert.deepEqual(left, [], 'no temporary folder is left');
  } finally {
    childProcess.fork = fork;
    syncBuiltinESMExports();
  }
});
