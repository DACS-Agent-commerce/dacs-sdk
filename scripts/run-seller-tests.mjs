// One complete native-Node seller test entry; --list exposes the exact registry.
// Every test process, children included, gets the unshipped kit-guard fixture loader through NODE_OPTIONS.
// DACS_SELLER_TEST_SHARD=K/N (CI only) runs just the files scripts/ci-shards.mjs assigns to shard K of N; --list
// always prints the whole registry, and the test processes never see the variable.
import {readdirSync}from'node:fs';
import {spawnSync}from'node:child_process';
import {fileURLToPath,pathToFileURL}from'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../packages/dacs-seller/test/',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort();
const guardFixture=pathToFileURL(fileURLToPath(new URL('../packages/dacs-seller/test/helpers/kit-guard-fixture.mjs',import.meta.url))).href;
const nodeOptions=[process.env.NODE_OPTIONS,'--import='+guardFixture].filter(Boolean).join(' ');
const{DACS_SELLER_TEST_SHARD:shardText,...childEnv}=process.env;
if(process.argv.includes('--list'))process.stdout.write(JSON.stringify(files)+'\n');
else{let selected=files;
if(shardText){const{parseShard,shardFiles}=await import('./ci-shards.mjs');const shard=parseShard(shardText,'seller');selected=shardFiles('seller',files,shard.index);
console.log(`[seller-tests] shard ${shard.index}/${shard.count}: ${selected.length} of ${files.length} files`);}
const child=spawnSync(process.execPath,['--experimental-vm-modules','--test','--test-concurrency=1',...selected.map(name=>'packages/dacs-seller/test/'+name)],{cwd:root,stdio:'inherit',env:{...childEnv,NODE_OPTIONS:nodeOptions}});if(child.error)throw child.error;process.exitCode=child.status??1;}
