import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const prefix = 'packages/dacs-client/';
const moved = prefix + 'src/dacs/buyer-chain-readback.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-merge-snapshots-'));
  execFileSync('git', ['clone','--quiet','--shared',root,dir]); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const git = (...args) => execFileSync('git',['-C',dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','-c','commit.gpgsign=false',...args],{encoding:'utf8'}).trim();
  const node = (...args) => execFileSync(process.execPath,args,{cwd:dir,stdio:'pipe'});
  copyFileSync(join(root,prefix+'scripts/delta-map.mjs'),join(dir,prefix+'scripts/delta-map.mjs'));
  copyFileSync(join(root,prefix+'DELTA-LEDGER.json'),join(dir,prefix+'DELTA-LEDGER.json'));
  const json = path => JSON.parse(readFileSync(join(dir,prefix+path),'utf8'));
  const save = (path,value) => writeFileSync(join(dir,prefix+path),JSON.stringify(value,null,2)+'\n');
  const check = () => {
    const result = spawnSync(process.execPath,[prefix+'scripts/check-provenance.mjs','--local-only'],{cwd:dir,encoding:'utf8'});
    return { status: result.status, text: result.stdout+result.stderr };
  };
  return { dir,git,node,json,save,check };
}
function merged(t, selectParent = false) {
  const f = fixture(t), { dir,git,node,json,save } = f;
  const base = readFileSync(join(dir,moved),'utf8'), start = git('rev-parse','HEAD');
  const histories = [];
  for (const side of ['one','two']) {
    git('switch','--quiet','-c',`TEST-${side}`,start);
    writeFileSync(join(dir,moved),base+`\n// TEST merge side ${side}\n`); git('add','--',moved);
    const subject = `fix(client): D11 TEST snapshot side ${side}`;
    node(prefix+'scripts/delta-map.mjs','--record','D11',subject);
    const files = [moved,...['DELTA-LEDGER.json','DELTA-COMMITS.json','DELTA-MAP.md'].map(path=>prefix+path)];
    if (git('diff','--name-only','HEAD','--',prefix+'scripts/delta-map.mjs')) files.push(prefix+'scripts/delta-map.mjs');
    const inventory = json('DELTA-COMMITS.json'); inventory.push({sha:null,subject,files:files.sort()}); save('DELTA-COMMITS.json',inventory);
    node(prefix+'scripts/delta-map.mjs'); git('add','--',...files); git('commit','--quiet','-m',subject);
    histories.push({ledger:json('DELTA-LEDGER.json'),inventory:json('DELTA-COMMITS.json')});
  }
  spawnSync('git',['-C',dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','merge','--no-ff','--no-commit','TEST-one'],{encoding:'utf8'});
  writeFileSync(join(dir,moved),base+(selectParent ? '\n// TEST merge side one\n' : '\n// TEST merge side one\n// TEST merge side two\n'));
  const ledger=histories[1].ledger; ledger.mergeSnapshots=histories[0].ledger.mergeSnapshots ?? []; ledger.changes.push(histories[0].ledger.changes.at(-1)); save('DELTA-LEDGER.json',ledger);
  const inventory=histories[1].inventory; inventory.push(histories[0].inventory.at(-1)); save('DELTA-COMMITS.json',inventory);
  node(prefix+'scripts/delta-map.mjs'); git('add','--',moved,prefix+'DELTA-LEDGER.json',prefix+'DELTA-COMMITS.json',prefix+'DELTA-MAP.md');
  git('commit','--quiet','-m','merge: TEST reviewed source snapshot');
  const commit=git('rev-parse','HEAD'),parents=git('rev-list','--parents','-n','1',commit).split(' ').slice(1);
  const snapshot={commit,parents,files:[{path:moved,parentBlobs:parents.map(parent=>git('rev-parse',`${parent}:${moved}`)),after:git('rev-parse',`${commit}:${moved}`)}]};
  const record=()=>{const data=json('DELTA-LEDGER.json');data.mergeSnapshots=[...(data.mergeSnapshots??[]),snapshot];save('DELTA-LEDGER.json',data);node(prefix+'scripts/delta-map.mjs');};
  return {...f,snapshot,record};
}
test('combined source requires an immutable merge snapshot and rejects later working or staged edits', t => {
  const f=merged(t);
  assert.equal(f.check().status,1);
  f.record(); let result=f.check(); assert.equal(result.status,0,result.text);
  const bytes=readFileSync(join(f.dir,moved)); writeFileSync(join(f.dir,moved),Buffer.concat([bytes,Buffer.from('\n// TEST unrecorded\n')]));
  result=f.check(); assert.equal(result.status,1); assert.match(result.text,/current blob differs/);
  f.git('add','--',moved); writeFileSync(join(f.dir,moved),bytes);
  result=f.check(); assert.equal(result.status,1); assert.match(result.text,/index differs/);
});
for (const [label,mutate] of [
  ['parent identity',s=>{s.parents[0]='0'.repeat(40);}],
  ['parent blob',s=>{s.files[0].parentBlobs[0]='0'.repeat(40);}],
  ['merged blob',s=>{s.files[0].after='0'.repeat(40);}],
  ['non-merge commit',s=>{s.commit=s.parents[0];}],
]) {
  test(`merge snapshot rejects a changed ${label}`,t=>{
    const f=merged(t); mutate(f.snapshot); f.record(); const result=f.check();
    assert.equal(result.status,1,result.text); assert.match(result.text,/merge snapshot/);
  });
}
test('removing or duplicating a merge snapshot cannot admit a combined blob',t=>{
  const f=merged(t); f.record();
  const data=f.json('DELTA-LEDGER.json'); data.mergeSnapshots.pop(); f.save('DELTA-LEDGER.json',data); f.node(prefix+'scripts/delta-map.mjs');
  assert.equal(f.check().status,1);
  f.record(); f.record(); const result=f.check(); assert.equal(result.status,1); assert.match(result.text,/duplicate merge snapshot/);
});

test('a working substitution from the other reviewed merge parent is refused',t=>{
  const f=merged(t,true);
  let result=f.check();assert.equal(result.status,0,result.text);
  const other=f.git('show',`${f.snapshot.parents[0]}:${moved}`)+'\n';
  writeFileSync(join(f.dir,moved),other);
  f.node(prefix+'scripts/delta-map.mjs');
  result=f.check();assert.equal(result.status,1,result.text);assert.match(result.text,/current blob differs/);
});
