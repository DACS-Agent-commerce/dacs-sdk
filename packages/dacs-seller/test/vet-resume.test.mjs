import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,JOBS} from './helpers/bilateral-vet-fixture.mjs';
import {provenUnsignedAbsence} from '../src/dacs/native-dem-delivery-consumer.mjs';
import {compositeVerificationAddress} from '@kynesyslabs/dacs';
for(const status of ['proven','absent','indeterminate','present'])test(`resume with ${status} evidence before proof checkpoints is read-only`,async()=>{
 const w=fixture(),input=w.input();let signs=0;w.config.wallet.signBytes=()=>{signs++;throw new Error('TEST signer interrupted');};
 await assert.rejects(w.provider().resolveBuyer(input),/TEST signer interrupted/);
 const calls=[];w.anchor.hasIntent=async address=>{calls.push(address);return true;};w.anchor.readRetained=async()=>status==='proven'?provenUnsignedAbsence('TEST interrupted unsigned approval'):{status};
 w.config.store.update=()=>assert.fail('resume wrote state');const result=await w.provider().resumableBuyer(input);
 assert.deepEqual(result,status==='proven'?{writes:2}:null);assert.equal(signs,1);assert.equal(w.local.writes.length,0);assert.equal(w.seen.length,0);
 assert.deepEqual(calls,status==='proven'?[w.buyer.claim,w.seller.claim].map(party=>compositeVerificationAddress(JOBS[0],party)):[compositeVerificationAddress(JOBS[0],w.buyer.claim)]);w.base.close();
});
test('one finalized buyer proof and one interrupted unsigned seller intent need exactly one remaining write',async()=>{
 const w=fixture(),input=w.input(),sellerAddress=compositeVerificationAddress(JOBS[0],w.seller.claim),publish=w.anchor.publish,read=w.anchor.readRetained;
 w.anchor.publish=async asked=>asked.logicalAddress===sellerAddress?{status:'indeterminate'}:publish(asked);
 await assert.rejects(w.provider().resolveBuyer(input),{code:'indeterminate'});
 w.anchor.hasIntent=async()=>true;w.anchor.readRetained=async asked=>asked.logicalAddress===sellerAddress?provenUnsignedAbsence('TEST unsigned seller intent'):read(asked);
 const effects=[w.controls.signs,w.local.writes.length,w.seen.length];w.config.store.update=()=>assert.fail('resume wrote state');
 assert.deepEqual(await w.provider().resumableBuyer(input),{writes:1});assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length],effects);w.base.close();
});
