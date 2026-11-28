import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {test} from 'node:test';
const sdk=join(dirname(fileURLToPath(import.meta.url)),'../../..');
const pkg=join(sdk,'packages/dacs-client');
const readJson=file=>JSON.parse(readFileSync(file,'utf8'));
function files(dir,prefix='') {
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);
}
test('launch review: npm test discovers every executable package test',async()=>{
  const {discoverTests}=await import(pathToFileURL(join(pkg,'scripts/test.mjs')));
  const expected=['scripts','test'].flatMap(dir=>files(join(pkg,dir)).filter(f=>f.endsWith('.test.mjs')).map(f=>dir+'/'+f)).sort();
  assert.deepEqual(discoverTests(pkg),expected);
  assert.ok(expected.includes('scripts/test-layout.test.mjs'));
  assert.ok(expected.includes('test/purchase-integrity.test.mjs'));
  assert.equal(readJson(join(pkg,'package.json')).scripts.test,'node scripts/test.mjs');
});
test('the package carries no copied-source records or pin files',()=>{
  for(const name of ['records','HOLD.json','evidence','DELTA-LEDGER.json','DELTA-COMMITS.json','PROVENANCE.json'])
    assert.equal(existsSync(join(pkg,name)),false,`packages/dacs-client/${name} must not exist`);
});

test('the test runner refuses empty and failing files and accepts a registered passing test',async t=>{
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'client-test-runner-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'test'));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  for(const [source,status] of [
    ['',1],
    ["import{test}from'node:test';test('works',()=>{});",0],
    ["import{test}from'node:test';test('fails',()=>{throw Error('expected failure')});",1],
  ]){
    writeFileSync(join(dir,'test/example.test.mjs'),source);
    const code=`import{runTests}from ${JSON.stringify(pathToFileURL(join(pkg,'scripts/test.mjs')).href)};process.exitCode=runTests(${JSON.stringify(dir)});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env});
    assert.equal(result.status,status,result.stdout+result.stderr);
    if(source==='')assert.match(result.stderr,/no registered test cases/);
  }
});
