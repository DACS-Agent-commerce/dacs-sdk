import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorFixture,signSdkCreate} from './helpers/anchor-isolated-fixture.mjs';
import {readbackFixture} from './helpers/sr2-readback-fixture.mjs';
import {seller,JOB,protocolFixture} from './helpers/protocol-fixture.mjs';
import {fixtureListing} from './fixtures/listings.mjs';
import {canonicalize,contentHash} from '@kynesyslabs/dacs';
import {createDevnetPurchasedReportProducer} from '../src/devnet-demo/deliverable.mjs';
async function world(kind='Listing',options={}){
 const f=await anchorFixture({artifactKinds:[kind]});
 f.source.binding=async()=>({disposition:'included'});f.source.observeBinding=async()=>({});
 f.controls.request=async request=>{const signed=await signSdkCreate(request.transaction,options);const backend=readbackFixture({signedTransaction:signed,observedAt:1800000000000});for(const edit of backend.state.tx.content.gcr_edits)edit.txhash=signed.hash;Object.assign(f.controls.reader,backend.adapter);await f.journal.put('demo/wallet/sdk',{stage:'broadcast-started',hash:signed.hash,signedTransaction:signed});return {success:true,data:{hash:signed.hash}};};return f;
}
function listing(extra){const pipeline=fixtureListing(seller).pipeline;pipeline[2].parameters.extra=extra;return {logicalAddress:'dacs1:listing:fixture-report:1',artifact:fixtureListing(seller,{pipeline}),artifactKind:'Listing'};}
for(const [name,extra,accepted] of [ ['list control',Array(3968).fill(0),true],['list edge',Array(3969).fill(0),false],['list max',Array(4096).fill(0),false],... [21,22,24].map(depth=>{let extra=0;for(let i=0;i<depth;i++)extra={nested:extra};return ['depth '+depth,extra,depth===21];})])test('SDK-shaped admission '+name,async()=>{
 const f=await world(),input=listing(extra);
 if(accepted){const result=await f.open().publish(input);assert.equal(result.status,'present');assert.equal(await f.open().verifyReceipt({...input,receipt:result.receipt,signedProjection:result.signedProjection,fresh:true}),'valid');}
 else{for(let run=0;run<2;run++)await assert.rejects(f.open().publish(input),{code:'invalid'});assert.equal(f.captured.length,0);assert.equal(f.journal.rows.size,0);assert.equal(await f.open().hasIntent(input.logicalAddress),false);assert.equal((await f.open().publish(listing(0))).status,'present');}
});
for(const copy of ['wallet','source','both'])for(const method of ['read','readRetained','publish'])test('signed evidence overrides user refusal '+copy+' '+method,async()=>{
 const f=await world('FinalityCommitmentRecord');const request=f.controls.request;
 f.controls.request=async r=>{const result=await request(r),row=await f.journal.get('demo/wallet/sdk');if(copy!=='wallet')await f.sourceJournal.put('source/sdk',row);if(copy==='source')f.journal.rows.delete('demo/wallet/sdk');return {success:false,error:{code:'user_rejected'}};};
 await f.publish(f.open(),JOB);const input=[...f.journal.rows.values()].find(row=>row.input).input;
 assert.equal((await f.open()[method]({...input,fresh:true})).status,'present');assert.equal(f.captured.length,1);
});
for(const method of ['read','readRetained','publish'])test('overbudget retained CREATE cannot become verified via '+method,async()=>{
 const f=await world(),small=listing(0);await f.open().publish(small);const [key,row]=[...f.journal.rows].find(([,r])=>r.input);
 const input=listing(Array(4096).fill(0)),tx=structuredClone(row.transaction);tx.content.data[1].data=input.artifact;
 const signed=await signSdkCreate(tx);Object.assign(row,{stage:'issued',input:{...row.input,artifact:input.artifact,receiptContentHash:contentHash(input.artifact)},hash:signed.hash,signedTransaction:signed});delete row.signedProjection;delete row.receipt;
 // read/readRetained use the original intent; publish also requires its exact input hash.
 const {sha256Hex}=await import('@kynesyslabs/dacs');row.inputHash=sha256Hex(canonicalize(row.input));await f.journal.put(key,row);await f.journal.put('demo/wallet/sdk',{stage:'broadcast-started',hash:signed.hash,signedTransaction:signed});
 let reads=0;f.controls.reader.read=async()=>{reads++;throw Error('unexpected reader');};
 assert.equal((await f.open()[method](input)).status,'indeterminate');assert.equal(reads,0);assert.notEqual((await f.journal.get(key)).stage,'verified');assert.equal(await f.open().retainedSignedCreate(input),null);await f.journal.put(key,{...row,stage:'verified',signedProjection:signed});assert.equal(await f.open().retainedSignedCreate(input),null);
});
for(const postFork of [false,true])test('full byte-budget Deliverable authenticates with SDK edits '+postFork,async()=>{
 const f=await world('Deliverable',{postFork}),protocol=await protocolFixture(),produce=text=>createDevnetPurchasedReportProducer({producer:f.seller,produce:()=>text})({agreement:protocol.agreement,listing:protocol.listing,settlementId:'TEST-settlement'});
 const report=produce('x'.repeat(16384-(Buffer.byteLength(canonicalize(produce('x')))-1)));
 const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:report.jobId,phase:'deliver-storage-program',phaseIndex:3,listing:report.listing,agreementHash:report.agreementHash,fulfilmentId:'TEST-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(report)};
 const input={logicalAddress:`dacs4:deliverable:${JOB}`,artifact:report,artifactKind:'Deliverable',deliveryBinding};const result=await f.open().publish(input);assert.equal(result.status,'present');assert.equal(await f.open().verifyReceipt({...input,receipt:result.receipt,signedProjection:result.signedProjection,fresh:true}),'valid');
});
