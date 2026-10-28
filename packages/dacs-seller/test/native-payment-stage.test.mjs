import test from 'node:test';
import assert from 'node:assert/strict';
import {commitmentFixture} from './helpers/commitment-fixture.mjs';
import {JOB} from './helpers/protocol-fixture.mjs';
test('native commitment is registered with the native payment implementation',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();
 assert.equal((await agent.commit({jobId:JOB})).status,'committed');assert.equal(f.local.writes.length,1);
});
