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
  'd5-recovery.test.mjs', 'canonical-job-boundaries.test.mjs', 'bilateral-vet.test.mjs', 'party-vet-store.test.mjs',
  'seller-raw-json.test.mjs', 'devnet-storage-write-recovery.test.mjs', 'devnet-delivery-wallet-refusal.test.mjs',
  'settlement-collisions.test.mjs', 'seller-lifecycle-gates.test.mjs',
  'demos-claims.test.mjs', 'seller-substrate-profile.test.mjs', 'seller-settlement-profile.test.mjs', 'seller-http-roundtrip.test.mjs', 'seller-payment-retry.test.mjs', 'seller-host-native-delivery.test.mjs', 'installed-package.test.mjs',
  'payment-evidence-wallet-journal.test.mjs',
];
// Packing and installing the core and seller tarballs needs more time, and so
// do the two host-level suites and the settlement capacity/restart vectors.
const timeouts: Record<string, number> = {'installed-package.test.mjs': 420000, 'seller-host-native-delivery.test.mjs': 600000, 'seller-settlement-profile.test.mjs': 600000};
const [major=0,minor=0]=process.versions.node.split('.').map(Number);
const supported=major>22 || (major===22 && minor>=15);
if(process.env.DACS_REQUIRE_SELLER_TESTS==='1' && !supported)
  throw new Error('Seller tests require Node >=22.15; the required CI seller suite cannot skip');
if(!supported)process.stderr.write('Seller tests skipped: Node >=22.15 is required (node:sqlite and registerHooks)\n');
const artifacts=mkdtempSync(join(tmpdir(),'seller-standalone-'));
process.stderr.write(`seller TAP artifacts: ${artifacts}\n`);
describe.skipIf(!supported).sequential('standalone seller conformance gates',()=>{
  for(const file of files)it(file,()=>{
    try { const output=execFileSync(process.execPath,['--experimental-vm-modules','--disable-warning=ExperimentalWarning','--test','--test-concurrency=1',fileURLToPath(new URL(`../../packages/dacs-seller/test/${file}`,import.meta.url))],{encoding:'utf8',timeout:timeouts[file]??90000,maxBuffer:8*1024*1024}); writeFileSync(join(artifacts,file+'.tap'),output); } catch(error) { const failure=error as {stdout?:string;stderr?:string}; writeFileSync(join(artifacts,file+'.tap'),`${failure.stdout??''}\n${failure.stderr??''}`); throw new Error(`${file}\n${failure.stdout??''}\n${failure.stderr??''}`); }
  },(timeouts[file]??90000)+10000);
});
