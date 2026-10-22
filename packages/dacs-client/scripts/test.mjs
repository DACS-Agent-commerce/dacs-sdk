// Run each executable package test exactly once and report its registered count.
import {readdirSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export function discoverTests(packageDir) {
  const walk=(dir,prefix)=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const rel=prefix+entry.name;
    return entry.isDirectory()?walk(join(dir,entry.name),rel+'/'):entry.isFile()&&entry.name.endsWith('.test.mjs')?[rel]:[];
  });
  return ['scripts','test'].flatMap(dir=>walk(join(packageDir,dir),dir+'/')).sort();
}
export function runTests(packageDir) {
  const files=discoverTests(packageDir);
  if(files.length===0)throw new Error('no executable package tests found');
  let failed=false;
  for(const file of files){
    const result=spawnSync(process.execPath,['--test','--test-concurrency=1',file],{cwd:packageDir,encoding:'utf8',maxBuffer:16<<20});
    process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??'');
    const count=/^# tests (\d+)$/m.exec(result.stdout??'');
    // Node counts a file with no test() calls as one successful file subtest.
    const fileOnly=(result.stdout??'').split('\n').some(line=>line===`# Subtest: ${file}`||line===`# Subtest: ${join(packageDir,file)}`);
    if(result.status!==0||!count||Number(count[1])===0||fileOnly){
      console.error(`[client-tests] FAIL ${file}: ${result.error?.message??(fileOnly?'no registered test cases':`exit ${result.status}, registered ${count?.[1]??'no'} tests`)}`);
      failed=true;
    }else console.log(`[client-tests] ${file}: # tests ${count[1]}`);
  }
  return failed?1:0;
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  process.exitCode=runTests(join(dirname(fileURLToPath(import.meta.url)),'..'));
}
