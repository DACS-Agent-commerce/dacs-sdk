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
