import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Fixture trees are written to a scratch directory; the catalog itself never ships package manifests.
const tools=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(tools,'../../..');
const npmRoot=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm');
function tree(files){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'s55-tools-'));
  for(const [file,value] of Object.entries(files)){
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
    fs.writeFileSync(path.join(root,file),typeof value==='string'?value:JSON.stringify(value));
  }
  return root;
}
const run=(args,options={})=>spawnSync(process.execPath,args,{encoding:'utf8',...options});
const consumer=(deps)=>({name:'consumer',version:'1.0.0',engines:{node:'^20.19.0 || >=22.12.0'},dependencies:Object.fromEntries(deps.map(d=>[d,'1.0.0']))});

test('engines check lists floor rejections and upper-bound gaps, and fails the gate',()=>{
  const root=tree({
    'package.json':consumer(['floor','covered','capped']),
    'node_modules/floor/package.json':{name:'floor',version:'1.0.0',engines:{node:'^22.22.2 || ^24.15.0 || >=26.0.0'}},
    'node_modules/covered/package.json':{name:'covered',version:'1.0.0',engines:{node:'>=18'}},
    'node_modules/capped/package.json':{name:'capped',version:'1.0.0',engines:{node:'20.x || 22.x || 23.x || 24.x || 25.x'}},
  });
  const result=run([path.join(tools,'engines-check.cjs'),root,path.join(root,'engines.json')]);
  assert.equal(result.status,1,result.stderr);
  const {outside,checked}=JSON.parse(fs.readFileSync(path.join(root,'engines.json'),'utf8'));
  assert.equal(checked,3);
  assert.deepEqual(outside.map(r=>[r.location,r.rejected_probes]),[
    ['node_modules/capped',[]],
    ['node_modules/floor',['20.19.0','20.19.1','22.12.0','22.22.1','23.0.0','24.0.0','24.14.0','25.0.0']],
  ]);
});

test('engines check passes a tree inside the advertised range',()=>{
  const root=tree({'package.json':consumer(['covered']),'node_modules/covered/package.json':{name:'covered',version:'1.0.0',engines:{node:'>=18'}}});
  const result=run([path.join(tools,'engines-check.cjs'),root,path.join(root,'engines.json')]);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'engines.json'),'utf8')).outside,[]);
});

test('physical export moves user-defined license references out of license.id',()=>{
  const root=tree({
    'package.json':{name:'consumer',version:'1.0.0',dependencies:{custom:'1.0.0',plain:'1.0.0'}},
    'node_modules/custom/package.json':{name:'custom',version:'1.0.0',license:'LicenseRef-Custom'},
    'node_modules/plain/package.json':{name:'plain',version:'1.0.0',license:'MIT'},
  });
  const result=run([path.join(tools,'physical-sbom.cjs'),root,root]);
  assert.equal(result.status,0,result.stderr);
  const raw=JSON.parse(fs.readFileSync(path.join(root,'sbom-physical.cdx.json'),'utf8'));
  assert.deepEqual(raw.components.find(c=>c.name==='custom').licenses,[{license:{id:'LicenseRef-Custom'}}]);
  const bom=JSON.parse(fs.readFileSync(path.join(root,'sbom-installed.cdx.json'),'utf8'));
  assert.deepEqual(bom.components.find(c=>c.name==='custom').licenses,[{license:{name:'LicenseRef-Custom'}}]);
  assert.deepEqual(bom.components.find(c=>c.name==='plain').licenses,[{license:{id:'MIT'}}]);
});

test('full trace attributes files under nameless module stubs to the installed package',()=>{
  const sdk='node_modules/@kynesyslabs/demosdk/';
  const root=tree({
    'package.json':{name:'consumer',version:'1.0.0'},
    [sdk+'package.json']:{name:'@kynesyslabs/demosdk',version:'4.0.16',type:'module'},
    [sdk+'build/websdk/index.js']:"import {value} from 'stubbed';\nexport {value};\n",
    [sdk+'build/storage/index.js']:'export {};\n',
    [sdk+'build/abstraction/index.js']:'export {};\n',
    [sdk+'build/d402/client/index.js']:'export {};\n',
    'node_modules/stubbed/package.json':{name:'stubbed',version:'2.0.0',main:'./lib.esm/index.js'},
    'node_modules/stubbed/lib.esm/package.json':{type:'module'},
    'node_modules/stubbed/lib.esm/index.js':'export const value=1;\n',
  });
  const output=path.join(root,'trace.json');
  const result=run(['--experimental-import-meta-resolve',path.join(tools,'trace-full.mjs'),root,output,repo]);
  assert.equal(result.status,0,result.stderr);
  const trace=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.deepEqual(Object.keys(trace.packages).sort(),['node_modules/@kynesyslabs/demosdk','node_modules/stubbed']);
  assert.equal(trace.files['node_modules/stubbed/lib.esm/index.js'].package.name,'stubbed');
});

test('exact-range matching uses the pinned npm semver, resolved without a fixed install path',()=>{
  const jobs=JSON.stringify([{versions:['8.18.3','8.21.0'],range:'>=8.0.0 <8.21.0',inherited:false},{versions:['1.0.0'],range:'',inherited:true}]);
  // A copy of the running npm's semver relabelled 7.7.4, so the test also runs where npm bundles another 7.x
  // (Node 20.19.0 ships 7.6.2); the version check, not the matching code, is what the pin guards.
  const fake=tree({'node_modules/.keep':''});
  const copy=path.join(fake,'node_modules/semver');
  fs.cpSync(path.join(npmRoot,'node_modules/semver'),copy,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(copy,'package.json'),'utf8'));
  fs.writeFileSync(path.join(copy,'package.json'),JSON.stringify({...manifest,version:'7.7.4'}));
  const ok=run([path.join(tools,'semver-match.cjs'),fake],{input:jobs});
  assert.equal(ok.status,0,ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout),[[true,false],[true]]);
  const other=tree({'node_modules/semver/package.json':{name:'semver',version:'7.7.1'}});
  const refused=run([path.join(tools,'semver-match.cjs'),other],{input:jobs});
  assert.equal(refused.status,1);
  assert.match(refused.stderr,/7\.7\.4/);
  for(const file of ['assess.py','semver-match.cjs'])assert.ok(!fs.readFileSync(path.join(tools,file),'utf8').includes('/usr/lib/node_modules'),file);
});
