import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { fixture, JOBS } from './helpers/bilateral-vet-fixture.mjs';
import { fixtureIdentityBundle } from './fixtures/listings.mjs';

const fixtureUrl = new URL('./helpers/bilateral-vet-fixture.mjs', import.meta.url).href;
const storeUrl = new URL('../src/devnet-demo/party-vet-store.mjs', import.meta.url).href;
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'vet-runs-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return join(path, 'state.sqlite');
}
function persistent(t, path) {
  const w = fixture(), store = openPartyVetStore({ path, mode: 'open', maxJobs: 1 });
  t.after(() => { store.close(); w.base.close(); });
  w.config.store = store;
  return { ...w, store };
}
const imports = `import {fixture} from ${JSON.stringify(fixtureUrl)};
  import {openPartyVetStore} from ${JSON.stringify(storeUrl)};
  const w=fixture(); const store=openPartyVetStore({path:process.argv[1],mode:process.argv[2],maxJobs:1});
  w.config.store=store;`;
function crash(path, mode) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', imports + `
    w.config.counterparty={...w.counterparty,issueChallenge:async()=>process.exit(73)};
    await w.provider().resolveBuyer(w.input());`, path, mode], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 73, result.stderr);
}

for (const boundary of ['completion', 'release', 'sweep']) test(`crashed run ownership is reclaimed before ${boundary} and frees one-job capacity`, async t => {
  const path = directory(t); crash(path, 'create');
  const w = persistent(t, path);
  assert.equal((await w.store.entries())[0][1].activeRuns.length, 1);
  if (boundary === 'completion') {
    assert.equal((await w.provider().resolveBuyer(w.input())).disposition, 'present');
    assert.deepEqual((await w.store.entries())[0][1].activeRuns, []);
    assert.deepEqual(await w.provider().release({ jobId: JOBS[0] }), { invalidated: true, deleted: true });
  } else {
    // A separately retained native intent fences replay after the ended row is deleted.
    w.config.anchor = { ...w.anchor, hasIntent: async () => true };
    if (boundary === 'release') assert.deepEqual(await w.provider().release({ jobId: JOBS[0] }), { invalidated: true, deleted: true });
    else assert.equal((await w.provider().sweep(() => true)).deleted, 1);
    w.config.anchor = w.anchor;
  }
  assert.equal(w.store.usage().jobs, 0);
  assert.equal((await w.provider().resolveBuyer(w.input(JOBS[1]))).disposition, 'present');
});

test('sixteen crash-left runs are reclaimed before the active-run capacity check', async t => {
  const path = directory(t);
  for (let i = 0; i < 16; i++) crash(path, i ? 'open' : 'create');
  const w = persistent(t, path);
  assert.equal((await w.provider().resolveBuyer(w.input())).disposition, 'present');
  assert.deepEqual((await w.store.entries())[0][1].activeRuns, []);
});

test('another live process retains its run fence until its operation settles', async t => {
  const path = directory(t), child = spawn(process.execPath, ['--input-type=module', '-e', imports + `
    const challenge=w.counterparty.issueChallenge;
    w.config.counterparty={...w.counterparty,issueChallenge:async input=>{
      process.send('active'); await new Promise(resolve=>process.once('message',resolve)); return challenge(input);
    }};
    try { await w.provider().resolveBuyer(w.input()); process.exitCode=1; }
    catch { process.send('settled'); }
    finally { store.close(); w.base.close(); process.disconnect(); }`, path, 'create'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.deepEqual(await once(child, 'message'), ['active', undefined]);
  const w = persistent(t, path);
  w.config.anchor = { ...w.anchor, hasIntent: async () => true };
  assert.deepEqual(await w.provider().release({ jobId: JOBS[0] }), { invalidated: true, deleted: false });
  assert.equal((await w.provider().sweep(() => true)).deleted, 0);
  assert.equal((await w.store.entries())[0][1].activeRuns.length, 1);
  const exited = once(child, 'exit'); child.send('resume');
  assert.deepEqual(await exited, [0, null], errors);
  assert.equal((await w.provider().sweep(() => true)).deleted, 1);
});

test('unknown legacy run ownership stays fenced rather than assuming a process died', async () => {
  const w = fixture();
  try {
    await w.provider().resolveBuyer(w.input());
    const [key] = (await w.store.entries())[0];
    await w.store.update(key, row => ({ ...row, activeRuns: ['TEST-legacy-unknown-owner'] }));
    assert.deepEqual(await w.provider().release({ jobId: JOBS[0] }), { invalidated: true, deleted: false });
    assert.equal((await w.provider().sweep(() => true)).deleted, 0);
  } finally { w.base.close(); }
});

async function activeChild(t, path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', imports + `
    w.config.counterparty={...w.counterparty,issueChallenge:async()=>{
      process.send('active'); await new Promise(()=>process.on('message',()=>{}));
    }};
    await w.provider().resolveBuyer(w.input());`, path, 'create'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.deepEqual(await once(child, 'message'), ['active', undefined]);
  return child;
}
async function stopChild(child) {
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}

test('a crashed pre-effect binding permits a different valid presentation', async t => {
  const path = directory(t); crash(path, 'create');
  const w = persistent(t, path), input = w.input();
  input.buyerIdentityBundle = fixtureIdentityBundle(w.buyer, input.buyerIdentityBundle.presentedAt - 1);
  assert.equal((await w.provider().resolveBuyer(input)).disposition, 'present');
});

for (const boundary of ['finally', 'unbind']) test(`another process exits before ${boundary}: failed unsigned work releases its binding`, async t => {
  const path = directory(t), child = await activeChild(t, path), w = persistent(t, path);
  let afterRun = null;
  w.config.store = { ...w.store, update: async (key, change) => {
    const before = await w.store.read(key), result = await w.store.update(key, change);
    if (before?.activeRuns?.length === 2 && result?.activeRuns?.length < 2) {
      afterRun = result.activeRuns;
      if (boundary === 'unbind') await stopChild(child);
    }
    return result;
  } };
  w.config.counterparty = { ...w.counterparty, issueChallenge: async () => {
    if (boundary === 'finally') await stopChild(child);
    throw new Error('TEST failed before any effect');
  } };
  await assert.rejects(w.provider().resolveBuyer(w.input()), { code: 'counterparty_vet_unavailable' });
  if (boundary === 'finally') assert.deepEqual(afterRun, []);
  assert.equal(w.store.usage().jobs, 0);
});
