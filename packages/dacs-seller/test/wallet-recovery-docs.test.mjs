import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync}from'node:fs';
test('wallet recovery documentation specifies authenticated fenced absence and retains ordinary misses',()=>{
 const text=readFileSync(new URL('../README.md',import.meta.url),'utf8');assert.match(text,/checkedThroughBlock/);assert.match(text,/complete authenticated[\s\S]{0,100}transaction index/);assert.match(text,/pending/);assert.match(text,/inclusion[\s\S]{0,120}execution|execution[\s\S]{0,120}inclusion/);assert.match(text,/ordinary[\s\S]{0,100}miss[\s\S]{0,120}(alive|rebroadcast)/i);
});
