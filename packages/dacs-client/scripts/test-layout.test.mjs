import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
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
  assert.equal(readJson(join(pkg,'package.json')).scripts.test,'node scripts/check-hold.mjs && node scripts/test.mjs');
});
test('historical tests are labelled text with exact snapshot bytes, outside executable discovery',()=>{
  const {baseline,files:archive}=readJson(join(pkg,'evidence/source-tests/INDEX.json'));
  assert.equal(baseline,'aac03055bdbeabc7c0771642d99f0c4baf7e3de9');
  assert.ok(archive.length>0);
  for(const row of archive){
    assert.ok(row.path.startsWith('evidence/source-tests/')&&row.path.endsWith('.txt'));
    const bytes=readFileSync(join(pkg,row.path));
    const old=execFileSync('git',['--no-replace-objects','-C',sdk,'show',baseline+':packages/dacs-client/'+row.original]);
    assert.deepEqual(bytes,old,row.original);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),row.blob);
  }
  assert.deepEqual(files(join(pkg,'evidence/source-tests')).filter(f=>f.endsWith('.txt')).sort(),archive.map(r=>r.path.slice('evidence/source-tests/'.length)).sort());
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
