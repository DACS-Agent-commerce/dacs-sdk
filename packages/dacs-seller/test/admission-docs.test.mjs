import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync}from'node:fs';
const readme=()=>readFileSync(new URL('../README.md',import.meta.url),'utf8');
test('source-only quickstart uses modules available before package activation',async()=>{
 if(existsSync(new URL('../package.json',import.meta.url)))return;
 const text=readme();assert.doesNotMatch(text,/from ['"]@kynesyslabs\/dacs-seller['"]/);assert.doesNotMatch(text,/workspace package is marked `private`/);assert.match(text,/\.\/src\/index\.mjs/);assert.equal(typeof(await import('../src/index.mjs')).startSellerHost,'function');assert.equal(typeof(await import('../src/devnet-demo/buyer-access.mjs')).createOperatorBuyerAccess,'function');
});
test('documented seller checks use the actual direct Node runner and explain incomplete validation',()=>{
 const text=readFileSync(new URL('../ADMISSION.md',import.meta.url),'utf8');assert.match(text,/node --experimental-vm-modules --test --test-concurrency=1 packages\/dacs-seller\/test\/\*\.test\.mjs/);assert.match(text,/npm test[\s\S]{0,150}(TypeScript|Vitest)/);assert.match(text,/blocked[\s\S]{0,300}supersession/i);
});
test('directory and minimum-runtime claims match the portable immediate-directory implementation',()=>{
 const text=readme();assert.doesNotMatch(text,/check every ancestor|22\.13 or later \(`node:sqlite`\)/);assert.match(text,/immediate (store )?directories/);assert.match(text,/20\.19/);
});

test("ADMISSION.md describes both producer modes, the absent seller session freshness and the exact G3 label",async()=>{const {readFile}=await import('node:fs/promises');const docs=await readFile(new URL('../ADMISSION.md',import.meta.url),'utf8');assert.match(docs,/counterparty/);assert.match(docs,/tp1-g3-orchestrator/);assert.match(docs,/no seller session freshness/);assert.ok(docs.includes('The seller writes and signs both Vet records as orchestrator (known testnet gap G3); the buyer-written Vet arrives in N1.'));});
test('README describes the W rule, finalized receipts and the exact Listing bundle, and carries the exact G3 label',()=>{
 const docs=readme().replace(/\s+/g,' ');
 for(const part of ['TP-1 G3 orchestrator mode (W)','`vetMode`','`tp1-g3-orchestrator`','only a `finalized` receipt counts','must be exactly the Listing\'s, with no fresh presentation','`vet_mode_mismatch`'])assert.ok(docs.includes(part),part);
 assert.ok(readme().includes('"The seller writes and signs both Vet records as orchestrator (known testnet gap G3); the buyer-written Vet arrives in N1."'));
});
