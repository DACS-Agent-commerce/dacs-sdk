import test from 'node:test';
import assert from 'node:assert/strict';
import { world, agreementRequest } from './helpers/tp1-node-fixture.mjs';

test("a native send and an Agreement storage CREATE signed under the installed demosdk version match the transport's exact projection", async t => {
const w=await world(t); const native=await w.send();assert.equal(native.success,true,JSON.stringify(native)); assert.deepEqual(w.node.confirms[0],w.node.broadcasts[0]); const storageWorld=await world(t); const storage=await agreementRequest(storageWorld); const sw=storageWorld;  sw.node.mode='drop'; const result=await sw.session.wallet.request(storage); assert.equal(sw.node.confirms.length,1,JSON.stringify(result)); assert.equal(sw.node.broadcasts.length,1,JSON.stringify(result)); assert.deepEqual(sw.node.confirms[0],sw.node.broadcasts[0]); assert.equal(sw.node.confirms[0].content.type,'storageProgram');
});
