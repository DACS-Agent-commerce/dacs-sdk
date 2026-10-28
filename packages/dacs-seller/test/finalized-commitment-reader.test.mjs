import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizedCommitmentReader} from './helpers/finalized-commitment-reader.mjs';
import {readbackFixture} from './helpers/sr2-readback-fixture.mjs';
import {seller,NOW} from './helpers/protocol-fixture.mjs';
test('the explicit commitment finality fixture authenticates its own observation and preserves inclusion-only adapter labels',async()=>{
 const f=readbackFixture({artifactKind:'FinalityCommitmentRecord'}),reader=finalizedCommitmentReader(f.adapter,{claim:seller.claim,sign:seller.signBytes});
 const options={expectedWriter:seller.claim,expectedArtifactKind:'FinalityCommitmentRecord',signedProjection:f.signed};
 const included=await f.adapter.read(f.logicalAddress,options);assert.equal(included.receipt.state,'included');
 assert.equal((await reader.read(f.logicalAddress,options)).status,'indeterminate');
 reader.record({logicalAddress:f.logicalAddress,artifact:f.artifact,signedProjection:f.signed,blockRef:{id:f.block.hash,height:'1',timestamp:NOW}});
 const read=await reader.read(f.logicalAddress,options),input={logicalAddress:f.logicalAddress,artifact:f.artifact,artifactKind:'FinalityCommitmentRecord',expectedWriter:seller.claim,signedProjection:f.signed,receipt:read.receipt};
 assert.equal(read.receipt.state,'finalized');assert.equal(await reader.verifyReceipt(input),'valid');
 for(const field of ['state','contentHash','transactionRef','evidence']){
  const receipt=structuredClone(read.receipt);if(field==='state')receipt.state='included';else if(field==='contentHash')receipt.contentHash='e'.repeat(64);else if(field==='transactionRef')receipt.transactionRef.value='f'.repeat(64);else receipt.evidence.value='TEST-changed-proof';
  assert.equal(await reader.verifyReceipt({...input,receipt}),'invalid',field);
 }
 assert.equal(await reader.verifyReceipt({...input,artifact:{report:'TEST changed'}}),'invalid');
 const changed=structuredClone(f.signed);changed.content.nonce++;assert.equal(await reader.verifyReceipt({...input,signedProjection:changed}),'invalid');
 assert.equal((await f.adapter.read(f.logicalAddress,options)).receipt.state,'included');
 f.state.rows=[];f.state.native=null;await assert.rejects(reader.verifyReceipt(input),{code:'indeterminate'});
});
