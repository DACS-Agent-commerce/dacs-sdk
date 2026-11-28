// One complete native-Node seller test entry; --list exposes the exact registry.
// Every test process, children included, gets the unshipped kit-guard fixture loader through NODE_OPTIONS.
// DACS_SELLER_TEST_SHARD=K/N (CI only) runs just the work scripts/ci-shards.mjs assigns to shard K of N: its whole
// files in one test process, as without the variable, then each file in SPLIT_FILES.seller that it holds tests of,
// with every other test of that file skipped by exact name; the shard fails unless the tests that ran there are
// exactly the ones it was given. --list always prints the whole registry, and no test process sees the variable.
import {readdirSync}from'node:fs';
import {spawnSync}from'node:child_process';
import {fileURLToPath,pathToFileURL}from'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../packages/dacs-seller/test/',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort();
const guardFixture=pathToFileURL(fileURLToPath(new URL('../packages/dacs-seller/test/helpers/kit-guard-fixture.mjs',import.meta.url))).href;
const nodeOptions=[process.env.NODE_OPTIONS,'--import='+guardFixture].filter(Boolean).join(' ');
const{DACS_SELLER_TEST_SHARD:shardText,...childEnv}=process.env;
const runWhole=selected=>{const child=spawnSync(process.execPath,['--experimental-vm-modules','--test','--test-concurrency=1',...selected.map(name=>'packages/dacs-seller/test/'+name)],{cwd:root,stdio:'inherit',env:{...childEnv,NODE_OPTIONS:nodeOptions}});if(child.error)throw child.error;return child.status??1;};
if(process.argv.includes('--list'))process.stdout.write(JSON.stringify(files)+'\n');
else if(!shardText)process.exitCode=runWhole(files);
else{
  // The name listing below also runs child processes; none of them sees the shard variable either.
  delete process.env.DACS_SELLER_TEST_SHARD;
  const{parseShard,sellerDir,shardEntries,splitTests}=await import('./ci-shards.mjs');
  const{runSome}=await import('./ci-test-names.mjs');
  const shard=parseShard(shardText,'seller');
  const split=splitTests('seller',files,sellerDir);
  const entries=shardEntries('seller',files,split,shard.index);
  const whole=entries.filter(entry=>entry.tests===null).map(entry=>entry.file);
  const parts=entries.filter(entry=>entry.tests!==null);
  console.log(`[seller-tests] shard ${shard.index}/${shard.count}: ${whole.length} whole files and part of ${parts.length} split files, of ${files.length} files`);
  let failed=false;
  // With no file names, node --test would look for test files on its own, so it is not started at all.
  if(whole.length>0&&runWhole(whole)!==0)failed=true;
  for(const{file,tests:given}of parts){
    console.log(`[seller-tests] ${file}: ${given.length} of its ${split[file].length} tests in this shard`);
    const{result,wrong}=await runSome('packages/dacs-seller/test/'+file,split[file],given,{cwd:root,env:{...childEnv,NODE_OPTIONS:nodeOptions},args:['--experimental-vm-modules','--test-concurrency=1']});
    if(result.error||result.status!==0||wrong){console.error(`[seller-tests] FAIL ${file}: ${result.error?.message??wrong??`exit ${result.status}`}`);failed=true;}
    else console.log(`[seller-tests] ${file}: ran exactly its ${given.length} tests`);
  }
  process.exitCode=failed?1:0;
}
