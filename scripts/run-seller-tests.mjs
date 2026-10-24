// One complete native-Node seller test entry; --list exposes the exact registry.
import {readdirSync}from'node:fs';
import {spawnSync}from'node:child_process';
import {fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../packages/dacs-seller/test/',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort();
if(process.argv.includes('--list'))process.stdout.write(JSON.stringify(files)+'\n');
else{const child=spawnSync(process.execPath,['--experimental-vm-modules','--test','--test-concurrency=1',...files.map(name=>'packages/dacs-seller/test/'+name)],{cwd:root,stdio:'inherit'});if(child.error)throw child.error;process.exitCode=child.status??1;}
