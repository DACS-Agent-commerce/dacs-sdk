import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256Hex, contentHash, finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { anchorFixture } from './helpers/anchor-isolated-fixture.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { seller, JOB } from './helpers/protocol-fixture.mjs';

test('CI seller runner enables the VM isolation API on both supported Node versions', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const command = workflow.split('\n').find(line => line.includes('run: node ') && line.includes('packages/dacs-seller/test/*.test.mjs'));
  assert(command?.includes('--experimental-vm-modules'));
});
for(const answer of [{result:200,response:0,success:false,error:'TEST failed'},{result:200,response:0},{result:200,response:0,require_reply:false,extra:null,error:'TEST refused'}]) test(`contradictory/incomplete nonce envelope refuses before wallet (${JSON.stringify(answer)})`,async()=>{
  const f=await anchorFixture();f.source.readRpc=async()=>answer;
  await assert.rejects(f.publish(f.open(),JOB),error=>error.code==='indeterminate');assert.equal(f.captured.length,0);assert.equal(f.journal.rows.size,0);
});
test('canonical decimal-string nonce reaches one reservation with the numeric successor',async()=>{
  const f=await anchorFixture();f.controls.nonce='0';assert.equal((await f.publish(f.open(),JOB)).status,'indeterminate');assert.equal(f.captured.length,1);assert.equal(f.captured[0].transaction.content.nonce,1);
});
test('accepted signed CREATE publishes, reopens, verifies receipts and preserves exact public bytes',async()=>{
  const f=await anchorFixture(),anchor=f.open(),logicalAddress=finalityCommitmentAddress(JOB);let backend;
  f.source.binding=async()=>({disposition:'included'});f.source.observeBinding=async()=>f.source.transportBinding;
  f.controls.request=async request=>{
    const signed=structuredClone(request.transaction);signed.hash=sha256Hex(JSON.stringify(signed.content));signed.signature={type:'ed25519',data:`0x${seller.signBytes(Buffer.from(signed.hash)).toString('hex')}`};
    backend=readbackFixture({signedTransaction:signed,observedAt:1800000000000});Object.assign(f.controls.reader,backend.adapter);
    await f.sourceJournal.put('TEST accepted',{stage:'observed',hash:signed.hash,signedTransaction:signed});
    return {success:true,data:{hash:signed.hash,writeProof:{disposition:'included'}}};
  };
  const result=await f.publish(anchor,JOB);assert.equal(result.status,'present');assert.equal(result.receipt.state,'finalized');assert.equal(f.captured.length,1);
  const input={logicalAddress,artifact:result.artifact,artifactKind:'FinalityCommitmentRecord',writer:f.seller};
  const reopened=f.open();assert.equal((await reopened.read({...input,fresh:true})).status,'present');
  assert.equal(await reopened.verifyReceipt({...input,receipt:result.receipt,signedProjection:result.signedProjection,fresh:true}),'valid');
  const retained=await reopened.retainedSignedCreate({logicalAddress,artifactKind:input.artifactKind});assert.deepEqual(retained,result.signedProjection);assert.equal(sha256Hex(JSON.stringify(retained.content)),retained.hash);
  const receipt=structuredClone(result.receipt);receipt.contentHash='b'.repeat(64);assert.equal(await reopened.verifyReceipt({...input,receipt,signedProjection:retained,fresh:true}),'invalid');
  const reordered=structuredClone(retained);reordered.content=Object.fromEntries(Object.entries(reordered.content).reverse());assert.equal(await reopened.verifyReceipt({...input,receipt:result.receipt,signedProjection:reordered,fresh:true}),'invalid');
  const changed=structuredClone(retained);changed.content.data[1].metadata.artifactBinding.jobId=JOB.slice(0,-1)+'B';changed.hash=sha256Hex(JSON.stringify(changed.content));changed.signature.data=`0x${seller.signBytes(Buffer.from(changed.hash)).toString('hex')}`;
  assert.equal(await reopened.verifyReceipt({...input,receipt:{...result.receipt,transactionRef:{...result.receipt.transactionRef,value:changed.hash}},signedProjection:changed,fresh:true}),'invalid');
  assert.equal((await reopened.publish(input)).status,'present');assert.equal(f.captured.length,1);assert.equal(contentHash(backend.native.data),result.receipt.contentHash);
});
