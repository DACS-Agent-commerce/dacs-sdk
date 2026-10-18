import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe,it} from 'vitest';

// Seller modules use node:test and Node's synchronous module hooks. Run each
// isolated file under its native runner, serially, through the normal SDK CI.
const files = [
  'd5-admission.test.mjs', 'd5-challenge-retention.test.mjs',
  'd5-limits-before-effects.test.mjs', 'd5-vet-decisions.test.mjs',
  'd5-recovery.test.mjs', 'bilateral-vet.test.mjs',
  'seller-raw-json.test.mjs', 'devnet-storage-write-recovery.test.mjs',
  'settlement-collisions.test.mjs', 'seller-lifecycle-gates.test.mjs', 'provenance-checkout.test.mjs',
];
const artifacts=mkdtempSync(join(tmpdir(),'seller-standalone-'));
process.stderr.write(`seller TAP artifacts: ${artifacts}\n`);
describe.sequential('standalone seller conformance gates',()=>{
  for(const file of files)it(file,()=>{
    try { const output=execFileSync(process.execPath,['--experimental-vm-modules','--disable-warning=ExperimentalWarning','--test','--test-concurrency=1',fileURLToPath(new URL(`../../packages/dacs-seller/test/${file}`,import.meta.url))],{encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024}); writeFileSync(join(artifacts,file+'.tap'),output); } catch(error) { const failure=error as {stdout?:string;stderr?:string}; writeFileSync(join(artifacts,file+'.tap'),`${failure.stdout??''}\n${failure.stderr??''}`); throw new Error(`${file}\n${failure.stdout??''}\n${failure.stderr??''}`); }
  },100000);
});
