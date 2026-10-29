import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, contentHash, canonicalize, finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { anchorFixture } from './helpers/anchor-isolated-fixture.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { seller, JOB, protocolFixture } from './helpers/protocol-fixture.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { createDevnetPurchasedReportProducer } from '../src/devnet-demo/deliverable.mjs';

for (const allowed of [true, false]) test(`fresh publication awaits durable authorization ${allowed}`, async () => {
  const f = await anchorFixture(), anchor = f.open();
  const input = { logicalAddress: finalityCommitmentAddress(JOB), artifact: await f.artifact(JOB), artifactKind: 'FinalityCommitmentRecord' };
  let resume, entered;
  const gate = new Promise(resolve => { resume = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const pending = anchor.publish({ ...input, authorize: async () => { entered(); return gate; } });
  const outcome = pending.catch(error => error);
  await ready;
  assert.equal(f.journal.rows.size, 0); assert.equal(f.captured.length, 0);
  resume(allowed);
  const result = await outcome;
  if (allowed) assert.equal(result.status, 'indeterminate');
  else assert.equal(result.code, 'not-authorized');
  assert.equal(f.captured.length, allowed ? 1 : 0); assert.equal(f.journal.rows.size, allowed ? 1 : 0);
});

test('fresh publication preserves a rejected durable authorization cause without effects', async () => {
  const f = await anchorFixture(), cause = new Error('TEST lifecycle store unavailable');
  const verdict = Promise.reject(cause); void verdict.catch(() => {});
  await assert.rejects(f.open().publish({ logicalAddress: finalityCommitmentAddress(JOB), artifact: await f.artifact(JOB),
    artifactKind: 'FinalityCommitmentRecord', authorize: () => verdict }), error => error === cause);
  assert.equal(f.journal.rows.size, 0); assert.equal(f.captured.length, 0);
});

for(const answer of [{result:200,response:0,success:false,error:'TEST failed'},{result:200,response:0},{result:200,response:0,require_reply:false,extra:null,error:'TEST refused'}]) test(`contradictory/incomplete nonce envelope refuses before wallet (${JSON.stringify(answer)})`,async()=>{
  const f=await anchorFixture();f.source.readRpc=async()=>answer;
  await assert.rejects(f.publish(f.open(),JOB),error=>error.code==='indeterminate');assert.equal(f.captured.length,0);assert.equal(f.journal.rows.size,0);
});
// The nonce read runs while the shared wallet nonce lane is held: bounded in bytes and time (rvd r4 D-2).
test('the nonce read passes its reply byte cap, deadline and signal to the source',async()=>{
  const f=await anchorFixture();let options;f.source.readRpc=async(path,body,supplied)=>{options=supplied;return {result:200,response:0,require_reply:false,extra:null};};
  await f.publish(f.open(),JOB);
  assert.equal(options.maxBytes,4096);assert.equal(options.timeoutMs,10000);assert.equal(options.signal.aborted,true,'the signal ends with the read');
});
test('a nonce read that never answers releases the lane at its deadline with no wallet request',async t=>{
  const f=await anchorFixture();let options,called;const reached=new Promise(done=>{called=done;});
  f.source.readRpc=(path,body,supplied)=>{options=supplied;called();return new Promise(()=>{});};
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.publish(f.open(),JOB);await reached;t.mock.timers.tick(10000);
  await assert.rejects(pending,error=>error.code==='indeterminate'&&/deadline/.test(error.message));
  assert.equal(options.signal.aborted,true);assert.equal(f.captured.length,0);assert.equal(f.journal.rows.size,0);
  t.mock.timers.reset();f.source.readRpc=async()=>({result:200,response:0,require_reply:false,extra:null});
  assert.equal((await f.publish(f.open(),JOB)).status,'indeterminate');assert.equal(f.captured.length,1,'the lane was released');
});
test('a nonce reply larger than its byte cap refuses before the wallet is asked',async()=>{
  const f=await anchorFixture();f.source.readRpc=async()=>({result:200,response:0,require_reply:false,extra:null,TEST:'x'.repeat(4096)});
  await assert.rejects(f.publish(f.open(),JOB),error=>error.code==='indeterminate'&&/byte limit/.test(error.message));assert.equal(f.captured.length,0);assert.equal(f.journal.rows.size,0);
});

// A caller's signed projection is bounded and JSON before it is hashed or read (rvd r4 D-4).
test('verifyReceipt refuses a caller projection larger than one signed CREATE, or not JSON, before any read',async()=>{
  const f=await anchorFixture(),anchor=f.open(),artifact=await f.artifact(JOB);let reads=0;
  f.controls.reader.verifyReceipt=async()=>{reads++;return 'valid';};
  const signedOfSize=(bytes)=>{
    const content={data:['storageProgram',{metadata:{artifactKind:'FinalityCommitmentRecord',artifactBinding:{jobId:JOB}}}],padding:''};
    content.padding='x'.repeat(bytes-Buffer.byteLength(JSON.stringify(content)));
    const hash=sha256Hex(JSON.stringify(content));
    return {hash,content,signature:{type:'ed25519',data:`0x${seller.signBytes(Buffer.from(hash)).toString('hex')}`}};
  };
  const verify=(projection)=>anchor.verifyReceipt({logicalAddress:finalityCommitmentAddress(JOB),artifact,artifactKind:'FinalityCommitmentRecord',receipt:{transactionRef:{value:projection.hash}},signedProjection:projection,fresh:true});
  assert.equal(await verify(signedOfSize(65_536)),'valid');assert.equal(reads,1,'an authentic projection within the budget is read');
  assert.equal(await verify(signedOfSize(65_537)),'invalid');
  const cyclic=signedOfSize(1024);cyclic.content.self=cyclic.content;assert.equal(await verify(cyclic),'invalid');
  assert.equal(reads,1);
});

// The largest report the producer admits is published through one CREATE (rvd r4 D-1).
test('the largest purchased report the producer admits reaches the wallet as one CREATE',async()=>{
  const f=await anchorFixture({artifactKinds:['Deliverable']}),p=await protocolFixture(),settlementId='TEST-settlement';
  const produce=(text)=>createDevnetPurchasedReportProducer({producer:f.seller,produce:()=>text})({agreement:p.agreement,listing:p.listing,settlementId});
  const capacity=16_384-(Buffer.byteLength(canonicalize(produce('x')))-1),report=produce('x'.repeat(capacity));
  assert.equal(Buffer.byteLength(canonicalize(report)),16_384);assert.throws(()=>produce('x'.repeat(capacity+1)),/one storage CREATE/);
  const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:report.jobId,phase:'deliver-storage-program',phaseIndex:3,listing:report.listing,agreementHash:report.agreementHash,
    fulfilmentId:'TEST-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(report)};
  assert.equal((await f.open().publish({logicalAddress:`dacs4:deliverable:${report.jobId}`,artifact:report,artifactKind:'Deliverable',deliveryBinding})).status,'indeterminate');
  assert.equal(f.captured.length,1);assert.deepEqual(f.captured[0].transaction.content.data[1].data,report);
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
  const result=await f.publish(anchor,JOB);assert.equal(result.status,'present');assert.equal(result.receipt.state,'included');assert.equal(result.receipt.substrate,'demos-sr2-simulated-fixture');assert.equal(f.captured.length,1);
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

for (const extra of [undefined, NaN, new Date(0), () => true]) test(`projection admission rejects converted JSON value ${String(extra)}`, async () => {
  const f = await anchorFixture(), artifact = await f.artifact(JOB);
  let reads = 0;
  f.controls.reader.verifyReceipt = async () => { reads++; return 'valid'; };
  const content = {data:['storageProgram',{metadata:{artifactKind:'FinalityCommitmentRecord',artifactBinding:{jobId:JOB}}}], extra};
  const hash = sha256Hex(JSON.stringify(content));
  const projection = {content, hash, signature:{type:'ed25519',data:`0x${seller.signBytes(Buffer.from(hash)).toString('hex')}`}};
  assert.equal(await f.open().verifyReceipt({logicalAddress:finalityCommitmentAddress(JOB), artifact, artifactKind:'FinalityCommitmentRecord',
    receipt:{transactionRef:{value:hash}}, signedProjection:projection, fresh:true}), 'invalid');
  assert.equal(reads, 0);
});

test('publication snapshots each journal a constant number of times as unsigned history grows', async () => {
  for (const count of [3, 12]) {
    const f = await anchorFixture();
    await f.publish(f.open(), JOB);
    const intent = [...f.journal.rows.values()][0];
    for (let i = 0; i < count; i++) {
      const row = structuredClone(intent);
      row.transaction.content.data[1].metadata.logicalAddress = `TEST-history-${i}`;
      await f.journal.put(`demo/artifact/TEST-${i}`, row);
    }
    let scans = 0;
    for (const journal of [f.journal, f.sourceJournal]) {
      const entries = journal.entries;
      journal.entries = async () => { scans++; return entries(); };
    }
    await f.publish(f.open(), JOB);
    assert.ok(scans <= 12, `${count} historical rows caused ${scans} scans`);
  }
});

for (const entry of ['publish', 'read', 'readRetained', 'retainedSignedCreate', 'verifyReceipt']) test(`real buyer access refuses protected ${entry}`, async () => {
  const f = await anchorFixture(), anchor = f.open();
  await f.publish(anchor, JOB);
  const input = {logicalAddress:finalityCommitmentAddress(JOB),artifact:await f.artifact(JOB),artifactKind:'FinalityCommitmentRecord'};
  f.controls.accessClosed = true;
  const before = f.captured.length;
  if (entry === 'retainedSignedCreate') assert.equal(await anchor[entry](input), null);
  else if (entry === 'verifyReceipt') {
    const content={data:['storageProgram',{metadata:{artifactKind:input.artifactKind,artifactBinding:{jobId:JOB}}}]};
    const hash=sha256Hex(JSON.stringify(content));
    await assert.rejects(anchor.verifyReceipt({...input,receipt:{transactionRef:{value:hash}},signedProjection:{hash,content,signature:{type:'ed25519',data:`0x${seller.signBytes(Buffer.from(hash)).toString('hex')}`}}}), {code:'buyer_access_closed'});
  } else await assert.rejects(anchor[entry](input), {code:'buyer_access_closed'});
  assert.equal(f.captured.length, before);
});

for (const which of ['sourceJournal', 'journal']) test(`failed ${which} snapshot never proves unsigned absence`, async () => {
  const f=await anchorFixture();
  await f.publish(f.open(),JOB);
  f[which].entries=async()=>{throw Object.assign(new Error('TEST snapshot unavailable'),{code:'TEST_IO'});};
  await assert.rejects(f.publish(f.open(),JOB),{code:'TEST_IO'});
  assert.equal(f.captured.length,1);
});

for (const abortAware of [false,true]) test(`nonce read preserves cause and releases lane, abort aware ${abortAware}`, async t => {
  const f=await anchorFixture(), cause=Object.assign(new Error('TEST RPC failure'),{code:'TEST_RPC'});
  f.source.readRpc=async()=>{throw cause;};
  await assert.rejects(f.publish(f.open(),JOB),error=>error.code==='indeterminate'&&error.cause===cause);
  f.source.readRpc=async()=>({result:200,response:0,require_reply:false,extra:null});
  await f.publish(f.open(),JOB);
  assert.equal(f.captured.length,1);
  if (!abortAware) return;
  let entered;
  const ready=new Promise(resolve=>entered=resolve);
  f.source.readRpc=(_path,_body,{signal})=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('TEST abort','AbortError')));entered();});
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.publish(f.open(),JOB), result=pending.catch(error=>error);
  await ready; t.mock.timers.tick(10000);
  assert.equal((await result).code,'indeterminate');
});

for (const where of ['sourceJournal','journal']) test(`orphan retained signature in ${where} never authorizes a new CREATE`, async () => {
  const f=await anchorFixture();
  await f.publish(f.open(),JOB);
  const request=f.captured[0];
  for(const key of f.journal.rows.keys()) if(key.startsWith('demo/artifact/'))f.journal.rows.delete(key);
  await f[where].put('demo/wallet/TEST-orphan',{stage:'observed',signedTransaction:request.transaction});
  f.controls.nonce=1;
  assert.equal((await f.publish(f.open(),JOB)).status,'indeterminate');
  assert.equal(f.captured.length,1);
});

for (const answer of [null,{}, {success:true}, {success:true,data:{hash:'TEST-invalid'}}, {success:true,data:{hash:'a'.repeat(64)}}]) test(`unbound wallet answer stays fenced ${JSON.stringify(answer)}`,async()=>{
  const f=await anchorFixture();f.controls.request=async()=>answer;
  await f.publish(f.open(),JOB);
  assert.equal((await f.publish(f.open(),JOB)).status,'indeterminate');
  assert.equal(f.captured.length,1);
});

for(const field of ['projection','signature'])test(`strict JSON admission includes the ${field} envelope before receipt reads`,async()=>{
 const f=await anchorFixture(),artifact=await f.artifact(JOB);let reads=0;f.controls.reader.verifyReceipt=async()=>{reads++;return 'valid';};
 const content={data:['storageProgram',{metadata:{artifactKind:'FinalityCommitmentRecord',artifactBinding:{jobId:JOB}}}]},hash=sha256Hex(JSON.stringify(content));
 const projection={hash,content,signature:{type:'ed25519',data:`0x${seller.signBytes(Buffer.from(hash)).toString('hex')}`}};
 (field==='projection'?projection:projection.signature).TESTomitted=undefined;
 assert.equal(await f.open().verifyReceipt({logicalAddress:finalityCommitmentAddress(JOB),artifact,artifactKind:'FinalityCommitmentRecord',receipt:{transactionRef:{value:hash}},signedProjection:projection,fresh:true}),'invalid');assert.equal(reads,0);
});

for (const shape of ['list', 'depth', 'supported']) test(`publication checks projection ${shape} budget before intent and wallet`, async () => {
  const f = await anchorFixture({artifactKinds: ['Listing']});
  let extra = shape === 'list' ? Array(4097).fill(0) : Array(4096).fill(0);
  if (shape === 'depth') for (let i = 0; i < 30; i++) extra = {nested: extra};
  const pipeline = fixtureListing(seller).pipeline; pipeline[2].parameters.extra = extra;
  const artifact = fixtureListing(seller, {pipeline});
  const publish = () => f.open().publish({logicalAddress: 'dacs1:listing:fixture-report:1', artifact, artifactKind: 'Listing'});
  if (shape === 'supported') { await publish(); assert.equal(f.captured.length, 1); }
  else { await assert.rejects(publish(), {code: 'invalid'}); assert.equal(f.captured.length, 0); assert.equal(f.journal.rows.size, 0); }
});
