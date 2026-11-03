// One complete native-Node seller test entry; --list exposes the exact registry.
// Every test process, children included, gets the unshipped kit-guard fixture loader through NODE_OPTIONS.
import {readdirSync}from'node:fs';
import {spawnSync}from'node:child_process';
import {fileURLToPath,pathToFileURL}from'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../packages/dacs-seller/test/',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort();
const guardFixture=pathToFileURL(fileURLToPath(new URL('../packages/dacs-seller/test/helpers/kit-guard-fixture.mjs',import.meta.url))).href;
const nodeOptions=[process.env.NODE_OPTIONS,'--import='+guardFixture].filter(Boolean).join(' ');
if(process.argv.includes('--list'))process.stdout.write(JSON.stringify(files)+'\n');
else{const child=spawnSync(process.execPath,['--experimental-vm-modules','--test','--test-concurrency=1',...files.map(name=>'packages/dacs-seller/test/'+name)],{cwd:root,stdio:'inherit',env:{...process.env,NODE_OPTIONS:nodeOptions}});if(child.error)throw child.error;process.exitCode=child.status??1;}
