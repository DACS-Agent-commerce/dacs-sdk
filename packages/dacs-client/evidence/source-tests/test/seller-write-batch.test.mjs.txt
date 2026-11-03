import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';
const {createApp}=await import(process.env.DACS_SELLER_BATCH_TEST_APP?pathToFileURL(process.env.DACS_SELLER_BATCH_TEST_APP).href:new URL('../src/app.mjs',import.meta.url).href);
const {loadConfig,ConfigError}=await import(process.env.DACS_SELLER_BATCH_TEST_CONFIG?pathToFileURL(process.env.DACS_SELLER_BATCH_TEST_CONFIG).href:new URL('../src/config.mjs',import.meta.url).href);

const {createSellerWriteBatch}=await import(process.env.DACS_SELLER_BATCH_TEST_MODULE?pathToFileURL(process.env.DACS_SELLER_BATCH_TEST_MODULE).href:new URL('../src/devnet-demo/seller-write-batch.mjs',import.meta.url).href);
const wallet=`0x${'51'.repeat(32)}`,network='offline-seller',chainIdentity='fake-chain';
const jobId='01ARZ3NDEKTSV4RRFFQ69G5FAV',lane=JSON.stringify([network,chainIdentity,wallet]);
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const rejected=(promise,code)=>assert.rejects(promise,error=>{assert.equal(error.code,code);return true;});
const input=(batchId='delivery',{job=jobId,rail='dem'}={})=>({batchId,jobId:job,railId:rail,paymentPhaseIndex:2,writes:
  [`dacs4:deliverable:${job}`,paymentEvidenceAddress(job,rail,2),`dacs4:evidence:${job}`].map((logicalAddress,index)=>{
    const artifactKind=index===0?'Deliverable':'SettlementEvidence';
    const transaction={content:{type:'storageProgram',from:wallet,nonce:11+index,network,chainIdentity,
      data:['storageProgram',{operation:'CREATE_STORAGE_PROGRAM',data:{testArtifact:index},metadata:{logicalAddress,artifactKind,artifactBinding:{jobId:job,writer:`did:demos:agent:${wallet.slice(2)}`}}}]},signature:null,hash:''};
    return {artifactKind,logicalAddress,transaction,approval:{method:'sendTransaction',exactTransaction:JSON.stringify(transaction)}};
  })});

function fixture(t,changes={}) {
  const directory=mkdtempSync(join(tmpdir(),'seller-batch-')),path=join(directory,'journal.sqlite');
  let journal=openDurableWalletJournal({path,mode:'create',lockTimeoutMs:0});
  t.after(()=>{journal.close();rmSync(directory,{recursive:true,force:true});});
  const events=[],state={nonce:10,observations:new Map()};
  const options={enabled:true,network,chainIdentity,wallet,
    approve:async()=>{events.push('approval');return true;},
    verifyPrepared:async plan=>plan.approval.exactTransaction===JSON.stringify(plan.transaction),
    readNonce:async()=>{events.push('nonce');return state.nonce;},
    sign:async transaction=>{events.push(`sign:${transaction.content.nonce}`);return {...transaction,hash:sha(JSON.stringify(transaction.content)),signature:{type:'offline-fake',data:'public'}};},
    verifySigned:async({transaction,signedBytes})=>JSON.stringify(JSON.parse(signedBytes).content)===JSON.stringify(transaction.content),
    broadcast:async({nonce,hash})=>{
      events.push(`send:${nonce}`);
      const retained=await journal.get(lane);
      assert.equal(retained.writes.length,3);
      assert.equal((await journal.entries()).find(([key])=>key.startsWith('wallet-batch-nonce/'))[1].reservedNonce,13);
      assert.deepEqual(retained.writes.map(write=>write.nonce),[11,12,13]);
      state.observations.set(nonce,{disposition:'included',proof:'offline-inclusion',receipt:{logicalAddress:input().writes[nonce-11].logicalAddress,checked:true}});
      return {disposition:'submitted',hash};
    },
    readback:async({hash,nonce})=>{events.push(`read:${nonce}`);return {wallet,hash,nonce,...(state.observations.get(nonce)??{disposition:'absent'})};},
    verifyIncluded:async({observation})=>observation?.proof==='offline-inclusion',
    verifyReceipt:async({plan,observation})=>observation?.receipt?.logicalAddress===plan.logicalAddress&&observation.receipt.checked===true,
    ...changes};
  const api=()=>createSellerWriteBatch({...options,journal:{...journal,put:async(key,value)=>{
    await journal.put(key,value);if(key===lane)events.push(`journal:${value.stage}`);
  }}});
  return {api,options,state,events,journal:()=>journal,reopen:()=>{
    const expectedJournalId=journal.journalId;journal.close();journal=openDurableWalletJournal({path,mode:'open',expectedJournalId,lockTimeoutMs:0});
  }};
}

test('clean batch: all approvals before signing, one reservation, journal before sending, Deliverable read first',async t=>{
  const f=fixture(t),request=input(),api=f.api();
  const out=await api.submitPrepared(request);
  assert.deepEqual(f.events.slice(0,8),['approval','approval','approval','nonce','sign:11','sign:12','sign:13','journal:batch-unresolved']);
  assert.equal(f.events.filter(event=>event==='nonce').length,1);
  assert.deepEqual(f.events.filter(event=>event.startsWith('send:')),['send:11','send:12','send:13']);
  assert.equal(out.deliverable,null,'acknowledgement alone cannot expose the Deliverable');
  const entries=await f.journal().entries(),decisions=entries.find(([key])=>key.endsWith('/approvals'))[1];
  assert.equal(decisions.length,3);
  assert.deepEqual(decisions,request.writes.map(plan=>({requestBytes:JSON.stringify(plan.approval),approvalHash:sha(JSON.stringify(plan.approval)),decision:'approved'})));
  const resolved=await api.reconcile({batchId:request.batchId});
  assert.deepEqual(f.events.filter(event=>event.startsWith('read:')),['read:11','read:12','read:13']);
  assert.deepEqual(resolved.writes.map(write=>write.disposition),['included','included','included']);
  assert.equal(resolved.deliverable.logicalAddress,request.writes[0].logicalAddress);
  assert.equal(resolved.batch.stage,'broadcast-accepted');
});

test('second send unknown fences third, exposes verified Deliverable and blocks new signing until readback',async t=>{
  const f=fixture(t),broadcast=f.options.broadcast;
  f.options.broadcast=async request=>{if(request.nonce===12){f.events.push('send:12');throw new Error('connection dropped');}return broadcast(request);};
  const api=f.api(),out=await api.submitPrepared(input());
  assert.deepEqual(out.writes.map(write=>write.disposition),['submitted','indeterminate','indeterminate']);
  const reads=await api.reconcile({batchId:'delivery'});
  assert.equal(reads.deliverable.logicalAddress,input().writes[0].logicalAddress);
  assert.deepEqual(reads.writes.map(write=>write.disposition),['included','indeterminate','indeterminate']);
  await rejected(api.submitPrepared(input('other')),'batch-blocked');
  await rejected(api.submitPrepared(input()),'seller-batch-replay');
  assert.equal(f.events.filter(event=>event.startsWith('sign:')).length,3);
  assert.deepEqual(f.events.filter(event=>event.startsWith('send:')),['send:11','send:12']);
  for(const nonce of [12,13])f.state.observations.set(nonce,{disposition:'absent',chainNonce:14,proof:'offline-finalized-absence'});
  f.options.absencePolicy={id:'offline-finalized-absence',verify:async({observation})=>observation.proof==='offline-finalized-absence'};
  const reconciled=await f.api().reconcile({batchId:'delivery'});
  assert.deepEqual(reconciled.writes.map(write=>write.disposition),['included','not-landed','not-landed']);
  assert.equal(reconciled.batch.stage,'broadcast-accepted');
  assert.equal(f.events.filter(event=>event.startsWith('sign:')).length,3);
  assert.deepEqual(f.events.filter(event=>event.startsWith('send:')),['send:11','send:12']);
});

test('manual or policy refusal of write two signs nothing and records its exact declined request',async t=>{
  for(const mode of ['manual','policy'])await t.test(mode,async s=>{
    let approvals=0;
    const f=fixture(s,{approve:async()=>++approvals!==2});
    await rejected(f.api().submitPrepared(input()),'seller-batch-declined');
    assert.equal(approvals,2);assert.deepEqual(f.events,[]);
    assert.equal(await f.journal().get(lane),undefined);
    const decisions=(await f.journal().entries()).find(([key])=>key.endsWith('/approvals'))[1];
    assert.deepEqual(decisions.map(decision=>decision.decision),['approved','rejected']);
    assert.equal(decisions[1].requestBytes,JSON.stringify(input().writes[1].approval));
    f.reopen();await rejected(f.api().submitPrepared(input()),'seller-batch-replay');
    assert.equal(approvals,2);
  });
});

test('restart mid-batch is readback-only, including retained plans and receipts',async t=>{
  const f=fixture(t),broadcast=f.options.broadcast;
  f.options.broadcast=async request=>{if(request.nonce===12){f.events.push('send:12');throw new Error('process stopped mid-send');}return broadcast(request);};
  await f.api().submitPrepared(input());f.reopen();const before=[...f.events];
  await rejected(f.api().submitPrepared(input()),'seller-batch-replay');
  const out=await f.api().reconcile({batchId:'delivery'});
  assert.deepEqual(out.writes.map(write=>write.disposition),['included','indeterminate','indeterminate']);
  assert.deepEqual(f.events.slice(before.length).filter(event=>!event.startsWith('journal:')),['read:11','read:12','read:13']);
  assert.equal(out.deliverable.logicalAddress,input().writes[0].logicalAddress);
});

test('wrong receipt never releases lane or exposes Deliverable; correct readback later can resolve it',async t=>{
  const f=fixture(t),api=f.api();await api.submitPrepared(input());
  f.state.observations.get(11).receipt.logicalAddress='another-purchase';
  const out=await api.reconcile({batchId:'delivery'});
  assert.equal(out.deliverable,null);assert.equal(out.writes[0].disposition,'indeterminate');
  assert.equal(out.batch.stage,'batch-unresolved');
  f.state.observations.get(11).receipt.logicalAddress=input().writes[0].logicalAddress;
  assert.equal((await api.reconcile({batchId:'delivery'})).batch.stage,'broadcast-accepted');
  const [key,receipt]=(await f.journal().entries()).find(([key])=>key.includes('/receipt/'));
  await f.journal().put(key,{...receipt,receipt:{...receipt.receipt,checked:false}});
  await rejected(api.reconcile({batchId:'delivery'}),'seller-batch-receipt-invalid');
});

test('incomplete approval bytes, cross-step writes, reordering and already signed plans are refused before approval',async t=>{
  for(const mutation of ['approval','job','order','signed','kind'])await t.test(mutation,async s=>{
    const f=fixture(s),request=input();
    if(mutation==='approval')request.writes[1].approval.exactTransaction='different bytes';
    if(mutation==='job')request.writes[1].transaction.content.data[1].metadata.artifactBinding.jobId='01ARZ3NDEKTSV4RRFFQ69G5FAX';
    if(mutation==='order'){request.writes[0].logicalAddress=`dacs4:evidence:${jobId}`;request.writes[0].transaction.content.data[1].metadata.logicalAddress=request.writes[0].logicalAddress;}
    if(mutation==='signed')request.writes[1].transaction.signature={type:'already-signed'};
    if(mutation==='kind'){request.writes[1].artifactKind='CompositeVerificationRecord';request.writes[1].transaction.content.data[1].metadata.artifactKind='CompositeVerificationRecord';}
    if(mutation!=='approval')for(const plan of request.writes)plan.approval.exactTransaction=JSON.stringify(plan.transaction);
    await rejected(f.api().submitPrepared(request),'seller-batch-invalid');
    assert.deepEqual(f.events,[]);assert.deepEqual(await f.journal().entries(),[]);
  });
});

test('off returns the original publisher: writes, journal and output snapshots unchanged',async()=>{
  const singlePublisher={publish:async(value)=>{writes.push(JSON.stringify(value));journal.push(JSON.stringify({stage:'issued',value}));return {status:'present',value};}};
  const value={artifactKind:'SettlementEvidence',logicalAddress:'legacy-payment',artifact:{evidenceVersion:'1'}};
  const writes=[],journal=[];
  const direct=JSON.stringify(await singlePublisher.publish(value)),directWrites=[...writes],directJournal=[...journal];writes.length=0;journal.length=0;
  const off=createSellerWriteBatch({singlePublisher});
  assert.equal(off,singlePublisher);
  assert.equal(JSON.stringify(await off.publish(value)),direct);
  assert.deepEqual(writes,directWrites);assert.deepEqual(journal,directJournal);
});

test('runtime switch is off by default, strict, and on fails before app construction',async()=>{
  const base={DACS_PUBLIC_ORIGIN:'https://plugin.example',DACS_OAUTH_COOKIE_KEYS:'k'.repeat(32)};
  assert.equal(loadConfig(base).sellerWriteBatches,'off');
  assert.throws(()=>loadConfig({...base,DACS_SELLER_WRITE_BATCHES:'on'}),error=>error instanceof ConfigError&&/DACS_SELLER_WRITE_BATCHES=on is held/.test(error.message));
  for(const value of ['', 'true', '1', 'ON'])assert.throws(()=>loadConfig({...base,DACS_SELLER_WRITE_BATCHES:value}),/DACS_SELLER_WRITE_BATCHES/);
  await assert.rejects(createApp({config:{sellerWriteBatches:'on',logLevel:'info'},logger:{}}),/seller write batches are held/);
  const contract=contractView();
  assert.deepEqual(Object.keys(contract.variables).sort(),runtimeNames());
  assert.equal(contract.variables.DACS_SELLER_WRITE_BATCHES.default,'off');
  assert.equal(contract.variables.DACS_SELLER_WRITE_BATCHES.deployValue,'off');
});

test('prepared journal exact readback failure stops before approval or signing',async t=>{
  const f=fixture(t),journal=f.journal();let stored=false;
  const api=createSellerWriteBatch({...f.options,journal:{...journal,
    put:async(key,value)=>{await journal.put(key,value);stored=true;},
    get:async key=>{const value=await journal.get(key);return stored&&value?.format==='dacs-seller-prepared-batch/v1'?{...value,format:'changed'}:value;}}});
  await rejected(api.submitPrepared(input()),'seller-batch-journal-error');
  assert.deepEqual(f.events,[]);assert.equal(await journal.get(lane),undefined);
});

test('caller and approval callback mutations cannot change retained plans or approved signing bytes',async t=>{
  const request=input(),original=structuredClone(request),f=fixture(t);
  f.options.approve=async approval=>{
    f.events.push('approval');approval.exactTransaction='callback mutation';
    request.writes[0].transaction.content.nonce=900;return true;
  };
  await f.api().submitPrepared(request);
  const retained=(await f.journal().entries()).find(([,value])=>value?.format==='dacs-seller-prepared-batch/v1')[1];
  assert.deepEqual(retained.input,original);
  assert.deepEqual(f.events.filter(event=>event.startsWith('sign:')),['sign:11','sign:12','sign:13']);
});

test('reopened terminal batch must still match the retained approved transaction bytes',async t=>{
  const f=fixture(t),api=f.api();await api.submitPrepared(input());await api.reconcile({batchId:'delivery'});
  const [key,retained]=(await f.journal().entries()).find(([,value])=>value?.format==='dacs-seller-prepared-batch/v1');
  retained.input.writes[0].transaction.content.data[1].data={testArtifact:'changed'};
  retained.input.writes[0].approval.exactTransaction=JSON.stringify(retained.input.writes[0].transaction);
  await f.journal().put(key,retained);f.reopen();
  await rejected(f.api().reconcile({batchId:'delivery'}),'seller-batch-invalid');
  assert.equal(f.events.filter(event=>event.startsWith('sign:')).length,3);
  assert.equal(f.events.filter(event=>event.startsWith('send:')).length,3);
});

test('delivery evidence off permits exactly the two fully prepared writes',async t=>{
  const f=fixture(t),request=input();request.writes.pop();
  f.options.broadcast=async({nonce,hash})=>{
    f.events.push(`send:${nonce}`);assert.equal((await f.journal().get(lane)).writes.length,2);
    f.state.observations.set(nonce,{disposition:'included',proof:'offline-inclusion',receipt:{logicalAddress:request.writes[nonce-11].logicalAddress,checked:true}});
    return {disposition:'submitted',hash};
  };
  const api=f.api();await api.submitPrepared(request);
  assert.equal((await api.reconcile({batchId:'delivery'})).batch.stage,'broadcast-accepted');
  assert.deepEqual(f.events.filter(event=>event.startsWith('send:')),['send:11','send:12']);
  assert.equal((await f.journal().entries()).find(([key])=>key.startsWith('wallet-batch-nonce/'))[1].reservedNonce,12);
});


test('switch and trusted adapter callbacks must be explicit',async t=>{
  const f=fixture(t);
  for(const enabled of [null, 'on', 1])assert.throws(()=>createSellerWriteBatch({enabled}),/explicit boolean/);
  for(const name of ['approve','verifyPrepared','verifyReceipt'])assert.throws(()=>createSellerWriteBatch({...f.options,journal:f.journal(),[name]:null}),/verifiers are required/);
  for(const name of ['readNonce','sign','verifySigned','broadcast','readback','verifyIncluded'])assert.throws(()=>createSellerWriteBatch({...f.options,journal:f.journal(),[name]:null}),/callbacks are required/);
  assert.deepEqual(f.events,[]);
});

test('prepared plan guards refuse wrong chain, sender, CREATE, locator and coordinates before approval',async t=>{
  const mutations={
    shape:r=>{r.unexpected=true;},batchId:r=>{r.batchId='';},count:r=>{r.writes.length=1;},
    planShape:r=>{r.writes[0].unexpected=true;},sender:r=>{r.writes[0].transaction.content.from=`0x${'52'.repeat(32)}`;},
    network:r=>{r.writes[0].transaction.content.network='other-network';},chain:r=>{r.writes[0].transaction.content.chainIdentity='other-chain';},
    hash:r=>{r.writes[0].transaction.hash='a'.repeat(64);},type:r=>{r.writes[0].transaction.content.type='native';},
    dataKind:r=>{r.writes[0].transaction.content.data[0]='native';},operation:r=>{r.writes[0].transaction.content.data[1].operation='UPDATE_STORAGE_PROGRAM';},
    nonceSafe:r=>{for(const [i,plan] of r.writes.entries())plan.transaction.content.nonce=11.5+i;},
    noncePositive:r=>{for(const [i,plan] of r.writes.entries())plan.transaction.content.nonce=i;},
    nonceSequence:r=>{r.writes[2].transaction.content.nonce=15;},
    metadataLocator:r=>{r.writes[0].transaction.content.data[1].metadata.logicalAddress='other-locator';},
    metadataKind:r=>{r.writes[0].transaction.content.data[1].metadata.artifactKind='Listing';},
    metadataWriter:r=>{r.writes[0].transaction.content.data[1].metadata.artifactBinding.writer=`did:demos:agent:${'52'.repeat(32)}`;},
    transactionNull:r=>{r.writes[0].transaction=null;},
    // Consistent across every plan, so only the input-level guard can refuse them.
    jobIdCanonical:()=>input('delivery',{job:jobId.toLowerCase()}),railIdLabel:()=>input('delivery',{rail:'r'.repeat(129)}),
    phaseNegative:r=>{r.paymentPhaseIndex=-1;},phaseType:r=>{r.paymentPhaseIndex='2';},
  };
  for(const [name,mutate] of Object.entries(mutations))await t.test(name,async s=>{
    const f=fixture(s),original=input(),request=mutate(original)??original;
    for(const plan of request.writes)plan.approval.exactTransaction=JSON.stringify(plan.transaction);
    await rejected(f.api().submitPrepared(request),'seller-batch-invalid');
    assert.deepEqual(f.events,[]);assert.deepEqual(await f.journal().entries(),[]);
  });
});

test('a correct receipt with a forged inclusion proof never resolves the write or exposes the Deliverable',async t=>{
  const f=fixture(t),api=f.api();await api.submitPrepared(input());
  f.state.observations.get(11).proof='forged';
  const out=await api.reconcile({batchId:'delivery'});
  assert.equal((await f.journal().get(lane)).writes[0].disposition,'indeterminate');
  assert.equal(out.writes[0].disposition,'indeterminate');assert.equal(out.deliverable,null);
  assert.equal(out.batch.stage,'batch-unresolved');
  assert.equal((await f.journal().entries()).filter(([key])=>key.includes('/receipt/')).length,2);
});

test('a resolved write whose retained inclusion proof no longer verifies is refused when results are shown',async t=>{
  const f=fixture(t),api=f.api();await api.submitPrepared(input());
  assert.equal((await api.reconcile({batchId:'delivery'})).batch.stage,'broadcast-accepted');
  const [key,observation]=(await f.journal().entries()).find(([key])=>key.includes('/receipt/'));
  await f.journal().put(key,{...observation,proof:'forged'});
  await rejected(api.reconcile({batchId:'delivery'}),'seller-batch-receipt-invalid');
});

test('readback never resolves a retained signed write whose bytes differ from its prepared plan',async t=>{
  const f=fixture(t);await f.api().submitPrepared(input());
  const record=await f.journal().get(lane),signed=JSON.parse(record.writes[0].signedBytes);
  signed.content.data[1].data={testArtifact:'swapped'};
  const signedBytes=JSON.stringify(signed);
  await f.journal().put(lane,{...record,writes:record.writes.map((write,index)=>index===0?{...write,signedBytes,bytesHash:sha(signedBytes)}:write)});
  await rejected(f.api().reconcile({batchId:'delivery'}),'seller-batch-invalid');
  const retained=await f.journal().get(lane);
  assert.equal(retained.stage,'batch-unresolved');assert.equal(retained.writes[0].disposition,'indeterminate');
  assert.equal((await f.journal().entries()).some(([key])=>key.endsWith(`/receipt/${record.writes[0].hash}`)),false);
});

test('recovery reads back and resolves after the prepare-time authorization has gone stale',async t=>{
  const f=fixture(t),verifyPrepared=f.options.verifyPrepared;let stale=false;
  f.options.verifyPrepared=async(...args)=>!stale&&verifyPrepared(...args);
  await f.api().submitPrepared(input());stale=true;f.reopen();
  const out=await f.api().reconcile({batchId:'delivery'});
  assert.deepEqual(f.events.filter(event=>event.startsWith('read:')),['read:11','read:12','read:13']);
  assert.equal(out.batch.stage,'broadcast-accepted');
  assert.equal(out.deliverable.logicalAddress,input().writes[0].logicalAddress);
});

test('recovery still refuses a structurally changed retained plan before any readback',async t=>{
  const f=fixture(t),broadcast=f.options.broadcast;
  f.options.broadcast=async request=>{if(request.nonce===12)throw new Error('connection dropped');return broadcast(request);};
  await f.api().submitPrepared(input());
  const [key,retained]=(await f.journal().entries()).find(([,value])=>value?.format==='dacs-seller-prepared-batch/v1');
  retained.input.writes[0].logicalAddress='dacs4:deliverable:another-purchase';
  await f.journal().put(key,retained);
  await rejected(f.api().reconcile({batchId:'delivery'}),'seller-batch-invalid');
  assert.deepEqual(f.events.filter(event=>event.startsWith('read:')),[]);
});

test('a check failing after broadcast reports a sent, unverified batch that only reconcile may resolve',async t=>{
  for(const mode of ['false','throw'])await t.test(mode,async s=>{
    const f=fixture(s),verifySigned=f.options.verifySigned;
    f.options.verifySigned=async request=>{
      if(!f.events.some(event=>event.startsWith('send:')))return verifySigned(request);
      if(mode==='throw')throw new Error('verifier unavailable');
      return false;
    };
    await assert.rejects(f.api().submitPrepared(input()),error=>{
      assert.equal(error.code,'seller-batch-submitted-unverified');assert.equal(error.batchId,'delivery');
      assert.equal(error.noResend,true);assert.match(error.message,/reconcile/);return true;
    });
    await rejected(f.api().submitPrepared(input()),'seller-batch-replay');
    f.options.verifySigned=verifySigned;
    assert.equal((await f.api().reconcile({batchId:'delivery'})).batch.stage,'broadcast-accepted');
    assert.deepEqual(f.events.filter(event=>event.startsWith('send:')),['send:11','send:12','send:13']);
  });
});

test('a failure to retain an inclusion proof escapes reconcile and leaves the write fenced',async t=>{
  const f=fixture(t),journal=f.journal();await f.api().submitPrepared(input());
  let broken=true;
  const api=createSellerWriteBatch({...f.options,journal:{...journal,put:async(key,value)=>{
    if(broken&&key.includes('/receipt/'))throw Object.assign(new Error('disk full'),{code:'journal-disk-full'});
    await journal.put(key,value);
  }}});
  await rejected(api.reconcile({batchId:'delivery'}),'journal-disk-full');
  const retained=await journal.get(lane);
  assert.equal(retained.stage,'batch-unresolved');
  assert.deepEqual(retained.writes.map(write=>write.disposition),['indeterminate','indeterminate','indeterminate']);
  broken=false;
  assert.equal((await api.reconcile({batchId:'delivery'})).batch.stage,'broadcast-accepted');
  assert.equal(f.events.filter(event=>event.startsWith('send:')).length,3);
});

test('the CLI refuses DACS_SELLER_WRITE_BATCHES=on as a configuration error before starting',()=>{
  const env={PATH:process.env.PATH,DACS_PUBLIC_ORIGIN:'https://plugin.example',DACS_OAUTH_COOKIE_KEYS:'k'.repeat(32),DACS_SELLER_WRITE_BATCHES:'on'};
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/dacs-chatgpt-plugin.mjs',import.meta.url))],{env,encoding:'utf8',timeout:30000});
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/^configuration error: DACS_SELLER_WRITE_BATCHES=on is held/);
  assert.doesNotMatch(result.stderr,/\n\s+at /);
});
