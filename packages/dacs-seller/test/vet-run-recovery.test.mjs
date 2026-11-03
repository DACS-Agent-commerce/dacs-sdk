import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { fixture, JOBS } from './helpers/bilateral-vet-fixture.mjs';

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

test('a real crash before the first effect leaves no owner token and ending reclaims capacity',async t=>{
 const path=directory(t);crash(path,'create');const w=persistent(t,path),p=w.provider();
 assert.ok((await w.store.entries()).every(([,row])=>row.activeRuns===undefined));
 assert.deepEqual(await p.release({jobId:JOBS[0]}),{invalidated:true,deleted:true});
 assert.deepEqual(await w.store.entries(),[]);assert.equal(w.store.usage().remainingJobs,1);
 await assert.rejects(w.provider().resolveBuyer(w.input(),{writable:()=>false}),{code:'not-pending'});
 assert.equal((await w.provider().resolveBuyer(w.input(JOBS[1]))).disposition,'present');
});
