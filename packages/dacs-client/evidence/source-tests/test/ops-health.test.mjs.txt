import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { canonicalize, compositeVerificationAddress, contentHash } from '@kynesyslabs/dacs';
import { openDatabase } from '../src/store/database.mjs';
import { createAccountService } from '../src/accounts.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createExactOperatorApproval } from '../src/devnet-demo/operator-approval.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import * as health from '../src/ops/health.mjs';
const { opsHealth, formatOpsHealth, readOnlySnapshot, STAGE_THRESHOLDS } = health;

const NOW=Date.now(),address=`0x${'a'.repeat(64)}`,buyer=`did:demos:agent:${'b'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'ops-health-')),path=join(root,'app','dacs-chatgpt.sqlite');
  const db=openDatabase(path),clock={now:NOW},accounts=createAccountService({db,builtinIssuer:'test',now:()=>clock.now});
  const account=accounts.resolveFromToken({issuer:'test-external',subject:'fixture'}),ops=createOperationStore({db,handoffSecret:'TEST ONLY '.repeat(4),now:()=>clock.now});
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const create=({stage='awaiting_approval',status=stage,protocol=false,at=NOW}={})=>{
    clock.now=at;
    return ops.createIdempotent({accountId:account.id,kind:'purchase',idempotencyKey:String(counter++),request:{n:counter},status,terms:{buyer:{wallet:`0x${'b'.repeat(64)}`},seller:{payee:address},...(protocol?{protocol:{jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'}}:{})},termsHash:'c'.repeat(64),expiresAt:new Date(at+3600000).toISOString(),state:protocol?{protocol:{stage}}:{}}).operation;
  };
  let counter=0;
  const report=(options={})=>opsHealth({databasePath:path,now:NOW,operatorState:root,...options});
  const cli=(args=[])=>spawnSync(process.execPath,['scripts/ops-health.mjs','--database',path,'--operator-state',root,...args],{cwd:resolve('.'),encoding:'utf8',timeout:10000});
  const durable=(file)=>{const j=openDurableWalletJournal({path:join(root,file),mode:'create'});t.after(()=>j.close());return j;};
  return {root,path,db,clock,ops,create,report,cli,durable};
}

test('healthy and empty real-schema databases; text and JSON CLI; terminal purchases stay terminal',t=>{
  const h=fixture(t);
  assert.equal(h.report().healthy,true);assert.deepEqual(h.report().purchases,[]);
  const empty=h.cli(['--json']);assert.equal(empty.status,0,empty.stderr);assert.deepEqual(JSON.parse(empty.stdout).purchases,[]);
  assert.match(h.cli().stdout,/recent purchases: none/);
  h.create();h.create({status:'cancelled',stage:'identity',protocol:true,at:NOW-90000000});
  h.create({status:'settled_verified',stage:'completed',protocol:true,at:NOW-90000000});
  h.create({status:'settled_verified',at:NOW-90000000});
  const report=h.report();assert.equal(report.healthy,true);assert.equal(report.purchases.length,1);assert.deepEqual(report.stuck,[]);
});

for(const [stage,thresholdMs] of Object.entries(STAGE_THRESHOLDS))test(`stuck boundary and override: ${stage}`,t=>{
  const h=fixture(t),payment=new Set(['agreement_pending','awaiting_approval','approved','payment_handoff','broadcast_reported','payment_uncertain']);
  const protocol=!payment.has(stage),initial=h.create({protocol,status:protocol?'agreement_pending':stage,stage:protocol?'identity':stage,at:NOW-thresholdMs});
  let operation=initial;
  if(protocol){h.clock.now=NOW-thresholdMs;operation=h.ops.transition(initial.id,initial.status,initial.status,{state:{protocol:{stage}},event:'protocol_step',data:{stage}});}
  else h.clock.now=NOW-thresholdMs;
  const entered=NOW-thresholdMs;
  assert.equal(h.report({now:entered+thresholdMs}).stuck.length,0,'exact threshold is healthy');
  const stuck=h.report({now:entered+thresholdMs+1}).stuck;
  assert.equal(stuck.length,1);assert.equal(stuck[0].stage,stage);assert.equal(stuck[0].ageMs,thresholdMs+1);assert.ok(stuck[0].nextExpected);
  assert.equal(h.report({now:entered+thresholdMs+1,thresholds:{[stage]:thresholdMs+2000}}).stuck.length,0,'override controls the alert');
  h.clock.now=NOW;
  h.ops.transition(operation.id,operation.status,operation.status,{event:protocol?'protocol_step':'payment_readback_pending',data:protocol?{stage}: {reason:'still waiting'}});
  assert.equal(h.report({now:entered+thresholdMs+1}).stuck[0].ageMs,thresholdMs+1,'poll does not reset stage age');
});

test('purchase event timeline and optional logged stages retain timestamps and gaps',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-6000});
  h.clock.now=NOW-4000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing'}},event:'protocol_agreement_planned',data:{stage:'agreement-signing'}});
  h.clock.now=NOW-1000;h.ops.transition(p.id,p.status,p.status,{event:'protocol_step',data:{stage:'agreement-signing'}});
  h.ops.record(p.id,'commitment_recheck_refused',{stage:'pre-approval',reason:'secret not a stage'});
  const log=join(h.root,'server.log');
  writeFileSync(log,JSON.stringify({event:'purchase_timeline',purchaseId:p.id,steps:[{step:'stage-change',timestampMs:NOW-3000,stage:'agreement-signing',token:'FAKE SECRET'}]}));
  const r=h.report({logPath:log}),timeline=r.purchases[0].timeline;
  assert.deepEqual(timeline.map(e=>[e.lane,e.stage,e.gapMs]),[['purchase','agreement_pending',0],['protocol','identity',0],['protocol','agreement-signing',2000],['log','agreement-signing',1000]]);
  assert.equal(r.purchases[0].ageMs,4000);assert.equal(timeline[2].at,new Date(NOW-4000).toISOString());
  assert.match(formatOpsHealth(r),/gapMs=2000 protocol:agreement-signing/);
});

test('unknown outcomes require readback, never failure; CLI exit 1 and old purchases remain checked',t=>{
  const h=fixture(t),p=h.create({stage:'payment_uncertain',at:NOW-2*86400000});
  const report=h.report({limit:1});assert.equal(report.purchases.length,0);assert.equal(report.healthy,false);
  assert.equal(report.stuck[0].purchaseId,p.id);assert.equal(report.stuck[0].outcome,'unknown-readback-required');
  assert.match(report.stuck[0].nextExpected,/readback; never resend/);assert.doesNotMatch(formatOpsHealth(report),/failed/);
  const cli=h.cli(['--json']);assert.equal(cli.status,1,cli.stderr);assert.equal(JSON.parse(cli.stdout).stuck[0].outcome,'unknown-readback-required');
});

test('settled payment with unfinished protocol is still monitored',t=>{
  const h=fixture(t),p=h.create({stage:'committed',protocol:true,status:'agreement_pending',at:NOW-600000});
  h.clock.now=NOW-400000;h.ops.transition(p.id,p.status,'settled_verified');
  const r=h.report();assert.equal(r.stuck[0].stage,'awaiting-claim');assert.equal(r.stuck[0].ageMs,400000);
});

function policyRequest(job){
  const pin={listingId:'fixture',version:1,contentHash:'c'.repeat(64)},binding={network:'demos-devnet',chainIdentity:'d'.repeat(64)};
  const artifact={recordVersion:'1',jobId:job,evaluatedParty:buyer,verifier:seller},logicalAddress=compositeVerificationAddress(job,buyer),programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=deriveStorageAddress(address,programName,1);
  const tx=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce:1,timestamp:NOW});
  Object.assign(tx.content.data[1].metadata,{contentHash:contentHash(artifact),envelopeHash:sha(canonicalize(artifact)),artifactKind:'CompositeVerificationRecord',networkBinding:binding});
  const request={method:'sendTransaction',address,purpose:'TEST ONLY',content:{kind:'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind:'CompositeVerificationRecord',jobId:job,owner:seller,wallet:address,logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',envelopeHash:sha(canonicalize(artifact)),storageBytes:Buffer.byteLength(JSON.stringify(artifact)),exactStorageBytes:JSON.stringify(artifact),exactCreate:JSON.stringify(tx.content.data[1]),nonce:1,timestamp:NOW,debit:{storageFeeDem:'1',sellerAmountDem:'0',sdkGasDem:'1',networkFeeDem:'1',rpcFeeDem:'1',additionalFeeDem:'0',totalDem:'4',totalOs:'4000000000',note:'TEST'},network:binding.network,chainIdentity:binding.chainIdentity,networkBinding:binding,evidence:'TEST',sending:'TEST'}};
  const policy={address,seller,sourceBinding:binding,listingPin:()=>pin,resolvePurchase:()=>({jobId:job,seller,buyer,listingPin:pin,sourceBinding:binding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:false,prePaymentOpen:true})};
  return {request,policy};
}
test('real L4 approvals: rolling-hour near, at and over budgets, exact large amounts and configured limits',async t=>{
  const h=fixture(t),evidencePath=join(h.root,'evidence','seller-approvals.jsonl');
  const job='01ARZ3NDEKTSV4RRFFQ69G5FAV',{request,policy}=policyRequest(job);
  // Each write is spent when approved; the source change holds a spent write for an hour after completion.
  for(const recordedAt of [NOW-3600000,NOW-60000,NOW]){
    const approve=createExactOperatorApproval({evidencePath,maxTotalOs:'4000000000',sellerApproval:{mode:'policy'},policy,now:()=>recordedAt});
    assert.equal(await approve(request),true);await approve.settle(request,'spent');
  }
  const near={mode:'policy',maxWritesPerHour:100,maxTotalOsPerHour:'10000000000'};
  let report=h.report({sellerApproval:near});assert.equal(report.seller.budget.writes,2);assert.equal(report.seller.budget.totalDem,'8.000000000');assert.equal(report.seller.budget.status,'near');
  assert.equal(report.healthy,true,'budget warning alone is not a stuck purchase');
  assert.equal(h.report({sellerApproval:{mode:'policy',maxWritesPerHour:2}}).seller.budget.status,'at-limit');
  assert.equal(h.report({sellerApproval:{mode:'policy',maxWritesPerHour:1}}).seller.budget.status,'over');
  assert.equal(h.report({sellerApproval:{mode:'policy',maxTotalOsPerHour:'7000000000'}}).seller.budget.status,'over');
  const config=join(h.root,'operator.json');writeFileSync(config,JSON.stringify({stateDirectory:h.root,sellerApproval:near,custodyDirectory:'DO NOT OPEN'}));
  const cli=h.cli(['--operator-config',config,'--json']);assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).seller.budget.status,'near');
  const approved=JSON.parse(readFileSync(evidencePath,'utf8').trim().split('\n')[0]);
  approved.recordedAt=NOW;approved.totalOs='900719925474099312345';writeFileSync(evidencePath,`${JSON.stringify(approved)}\n`);
  assert.equal(h.report().seller.budget.totalDem,'900719925474.099312345');
});

test('manual/rejected decisions do not use policy budget; malformed evidence fails closed',async t=>{
  const h=fixture(t),evidencePath=join(h.root,'evidence','seller-approvals.jsonl');
  const approve=createExactOperatorApproval({evidencePath,maxTotalOs:'4000000000',authorize:()=>true,now:()=>NOW});
  assert.equal(await approve({method:'sendTransaction',content:{debit:{totalOs:'4000000000'}}}),true);
  const {request,policy}=policyRequest('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  request.content.debit.totalOs='5000000000';
  assert.equal(await createExactOperatorApproval({evidencePath,maxTotalOs:'4000000000',sellerApproval:{mode:'policy'},policy,now:()=>NOW})(request),false);
  assert.equal(h.report().seller.budget.writes,0);
  writeFileSync(evidencePath,readFileSync(evidencePath,'utf8').replace(/"approvalHash":"[a-f0-9]+"/,'"approvalHash":"bad"'));
  assert.throws(()=>h.report());assert.equal(h.cli(['--json']).status,2);
});

test('seller journals show pending writes, exclude buyer transport and verified/denied writes, retain live locks',async t=>{
  const h=fixture(t),artifacts=h.durable('seller-artifacts.sqlite'),wallet=h.durable('seller-wallet.sqlite'),transport=h.durable('node2-transport.sqlite');
  h.create();
  const hash='e'.repeat(64),content={from:address};
  await artifacts.put('demo/artifact/TEST',{stage:'issued',hash,transaction:{content}});
  await artifacts.put('demo/artifact/verified',{stage:'verified',hash:'f'.repeat(64),transaction:{content}});
  await artifacts.put('demo/artifact/denied',{stage:'denied',transaction:{content}});
  await wallet.put('sr2/wallet/TEST',{stage:'sr2-readback-pending',hash,signedTransaction:{content}});
  await wallet.put('sr2/wallet/settled',{stage:'broadcast-accepted',hash:'f'.repeat(64),signedTransaction:{content}});
  await transport.put('seller-transport',{stage:'broadcast-started',hash,signedTransaction:{content}});
  await transport.put('buyer-transport',{stage:'broadcast-started',hash:'b'.repeat(64),signedTransaction:{content:{from:`0x${'b'.repeat(64)}`}}});
  await artifacts.withWalletLock('demo/artifact/TEST',async()=>{
    const locks=artifacts.inspectLocks(),r=h.report();assert.equal(r.seller.unconfirmed.length,3);assert.equal(r.healthy,false);
    assert.deepEqual(r.seller.unconfirmed.map(row=>row.stage),['issued','sr2-readback-pending','broadcast-started']);
    assert.deepEqual(artifacts.inspectLocks(),locks,'health never acquires or removes operator locks');
    assert.equal(h.cli(['--json']).status,1);
  });
  await artifacts.put('demo/artifact/TEST',{stage:'verified',hash,transaction:{content}});
  await wallet.put('sr2/wallet/TEST',{stage:'broadcast-accepted',hash,signedTransaction:{content}});
  await transport.put('seller-transport',{stage:'observed',hash,signedTransaction:{content}});
  assert.equal(h.report().healthy,true);
});

function bytes(root){
  const result={};
  for(const name of readdirSync(root,{withFileTypes:true})){
    const path=join(root,name.name);
    if(name.isDirectory()){for(const [key,value] of Object.entries(bytes(path)))result[`${name.name}/${key}`]=value;}
    else result[name.name]=sha(readFileSync(path));
  }
  return result;
}
test('read-only driver rejects writes; database, WAL, SHM, journals and evidence are byte-identical after CLI',async t=>{
  const h=fixture(t);h.create();const j=h.durable('seller-artifacts.sqlite');await j.put('TEST',{stage:'verified',transaction:{content:{from:address}}});
  mkdirSync(join(h.root,'evidence'));writeFileSync(join(h.root,'evidence','seller-approvals.jsonl'),'');
  const scratch=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('dacs-ops-health-')).sort(),originalScratch=scratch();
  const before=bytes(h.root),cli=h.cli(['--json']);assert.equal(cli.status,0,cli.stderr);assert.deepEqual(bytes(h.root),before);
  assert.throws(()=>readOnlySnapshot(h.path,db=>{db.exec('PRAGMA query_only=OFF');db.exec("UPDATE meta SET value='99' WHERE key='schema_version'");}),/readonly/);
  assert.deepEqual(bytes(h.root),before);
  assert.deepEqual(scratch(),originalScratch,'scratch copies are removed on success and error');
});

test('concurrent WAL writer proceeds while health reads; uncommitted state stays invisible',t=>{
  const h=fixture(t),p=h.create(),writer=new DatabaseSync(h.path);
  t.after(()=>writer.close());
  writer.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  writer.prepare("UPDATE operations SET status='payment_uncertain' WHERE id=?").run(p.id);
  const cli=h.cli(['--json']);assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).purchases[0].stage,'awaiting_approval');
  readOnlySnapshot(h.path,()=>{writer.exec('COMMIT');writer.exec('BEGIN IMMEDIATE');writer.exec('COMMIT');});
  assert.equal(h.report().purchases[0].stage,'payment_uncertain');
});

test('redaction: payloads, arbitrary labels, keys, sessions, tokens and error text never escape',async t=>{
  const h=fixture(t),fake='FAKE_PRIVATE_KEY_0x'+'9'.repeat(64),p=h.create();
  h.ops.transition(p.id,p.status,p.status,{state:{privateKey:fake,sessionKey:fake,cookie:fake,token:fake,signedTransaction:{signature:fake}},event:'debug',data:{reason:fake,stage:fake}});
  h.db.prepare('INSERT INTO secrets VALUES (?,?,?)').run('FAKE',fake,new Date(NOW).toISOString());
  const j=h.durable('seller-artifacts.sqlite');await j.put(fake,{stage:'issued',hash:'e'.repeat(64),transaction:{content:{from:address,signature:fake}},input:{artifact:{privateKey:fake}}});
  const log=join(h.root,'server.log');writeFileSync(log,JSON.stringify({event:'purchase_step',purchaseId:p.id,step:'stage-change',stage:'awaiting_approval',timestampMs:NOW,token:fake,sessionKey:fake,signedPayload:fake}));
  const report=h.report({logPath:log});assert.ok(!JSON.stringify(report).includes(fake));assert.ok(!formatOpsHealth(report).includes(fake));
  for(const args of [[],['--json']]){const cli=h.cli([...args,'--log',log]);assert.ok(!`${cli.stdout}${cli.stderr}`.includes(fake));}
  h.db.prepare('UPDATE operations SET status=? WHERE id=?').run(fake,p.id);
  for(const args of [[],['--json']]){const cli=h.cli(args);assert.ok(!`${cli.stdout}${cli.stderr}`.includes(fake));assert.equal(cli.status,2);}
  writeFileSync(log,`{"${fake}":`);
  const invalid=h.cli(['--json','--operator-config',log]);assert.equal(invalid.status,2);assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(fake));
  const missing=h.cli(['--json','--operator-config',join(h.root,fake)]);assert.equal(missing.status,2);assert.ok(!`${missing.stdout}${missing.stderr}`.includes(fake));
});

test('errors never create absent state; invalid flags, schemas and damaged journals return 2',async t=>{
  const h=fixture(t),before=bytes(h.root);
  for(const args of [['--database',join(h.root,'absent.sqlite')],['--threshold','identity=0'],['--threshold','no-stage=5'],['--limit','1.5'],['--bad','secret'],['--recent-hours','0']])assert.equal(h.cli(args).status,2);
  assert.deepEqual(bytes(h.root),before);
  h.db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();assert.equal(h.cli().status,2);
  h.db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
  const j=h.durable('seller-wallet.sqlite');await j.put('TEST',{stage:'verified'});
  const corrupt=new DatabaseSync(join(h.root,'seller-wallet.sqlite'));corrupt.exec(`UPDATE records SET digest='${'0'.repeat(64)}'`);corrupt.close();
  assert.equal(h.cli(['--json']).status,2);
});

test('CLI path selection, filters and threshold flags are explicit; absent database is not created',t=>{
  // Only the CLI reads these, on the wall clock, which can be minutes past NOW by this test on a loaded host.
  const h=fixture(t),wall=Date.now();h.create({at:wall-600000});h.create({at:wall});
  const run=(args,env={})=>spawnSync(process.execPath,['scripts/ops-health.mjs',...args],{cwd:resolve('.'),env:{...process.env,DACS_DATA_DIR:'',DACS_DATABASE_PATH:'',...env},encoding:'utf8',timeout:10000});
  let cli=run(['--data-dir',join(h.root,'app'),'--json','--limit','1','--recent-hours','1','--threshold','awaiting_approval=60']);
  assert.equal(cli.status,1,cli.stderr);assert.equal(JSON.parse(cli.stdout).purchases.length,1);assert.equal(JSON.parse(cli.stdout).stuck.length,1);
  cli=run(['--json'],{DACS_DATABASE_PATH:h.path});assert.equal(cli.status,0,cli.stderr);
  cli=run(['--operator-state',h.root,'--json']);assert.equal(cli.status,0,cli.stderr);
  const before=bytes(h.root),absent=join(h.root,'absent.sqlite');cli=run(['--database',absent,'--json']);assert.equal(cli.status,2);assert.deepEqual(bytes(h.root),before);
});

test('unknown protocol attempts keep their stage and advertise readback only',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-400000});
  h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-anchored',attempts:[{step:'agreement',outcome:'indeterminate',reason:'TEST'}]}},event:'protocol_commit-request',data:{stage:'agreement-anchored'}});
  const stuck=h.report().stuck[0];assert.equal(stuck.stage,'agreement-anchored');assert.equal(stuck.outcome,'unknown-readback-required');assert.match(stuck.nextExpected,/readback; never resend/);
});

test('transport-only seller writes can be attributed from purchase terms; unknown ownership fails closed',async t=>{
  const h=fixture(t),transport=h.durable('node2-transport.sqlite');
  await transport.put('TEST',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:address}}});
  assert.throws(()=>h.report());h.create();assert.equal(h.report().seller.unconfirmed.length,1);
});

test('threshold defaults allow human approvals and multiple block readbacks',()=>{
  const expected={identity:1800000,'agreement-signing':600000,'agreement-anchored':300000,committed:1800000,'seller-committed':1800000,agreement_pending:600000,awaiting_approval:1800000,approved:300000,payment_handoff:300000,broadcast_reported:300000,payment_uncertain:300000,unknown:300000,'payment-observed':300000,'awaiting-claim':300000,'native-payment-evidence-held':300000,'payment-evidenced':300000,'delivery-ready':600000,delivered:600000,'awaiting-countersignature':1800000};
  assert.deepEqual(STAGE_THRESHOLDS,expected);
});

test('a DB/WAL pair changing during the copy fails closed without opening a snapshot',t=>{
  const h=fixture(t),p=h.create(),original=fs.readFileSync;
  let reads=0,opened=false;
  fs.readFileSync=(path,...args)=>{
    if(path===h.path&&++reads===2)h.ops.transition(p.id,p.status,'payment_uncertain');
    return original(path,...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(()=>readOnlySnapshot(h.path,()=>{opened=true;}),/could not read valid state/);assert.equal(opened,false); }
  finally { fs.readFileSync=original;syncBuiltinESMExports(); }
});


test('review: symlink database includes committed uncheckpointed real WAL',t=>{
  const h=fixture(t);h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const p=h.create({stage:'payment_uncertain',at:NOW-600000});
  const alias=join(h.root,'alias.sqlite');fs.symlinkSync(h.path,alias);
  const before=bytes(h.root),r=h.report({databasePath:alias});
  assert.equal(r.healthy,false);assert.equal(r.stuck[0].purchaseId,p.id);
  assert.deepEqual(bytes(h.root),before);
});

test('review: cross-service database and operator roots fail closed',async t=>{
  const a=fixture(t),b=fixture(t);a.create();
  assert.throws(()=>a.report({operatorState:b.root}),'even an empty foreign operator root is invalid');
  await b.durable('node2-transport.sqlite').put('other-service',{stage:'broadcast-started',signedTransaction:{content:{from:`0x${'c'.repeat(64)}`}}});
  assert.throws(()=>a.report({operatorState:b.root}));
  const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',a.path,'--operator-state',b.root,'--json'],{encoding:'utf8'});
  assert.equal(cli.status,2);
});

test('review: pending transport owners must be known sellers or explicit buyers',async t=>{
  const h=fixture(t);h.create();const j=h.durable('node2-transport.sqlite');
  await j.put('unknown-owner',{stage:'unknown',signedTransaction:{content:{from:`0x${'c'.repeat(64)}`}}});
  assert.throws(()=>h.report());assert.equal(h.cli(['--json']).status,2);
  await j.put('unknown-owner',{stage:'observed',signedTransaction:{content:{from:`0x${'c'.repeat(64)}`}}});
  await j.put('buyer',{stage:'broadcast-started',signedTransaction:{content:{from:`0x${'b'.repeat(64)}`}}});
  assert.equal(h.report().healthy,true);
  await j.put('buyer',{stage:'unknown'});assert.throws(()=>h.report());
});

test('review: settled artifact wallet namespace clears while transport still needs readback',async t=>{
  const h=fixture(t),j=h.durable('seller-artifacts.sqlite');h.create();
  await j.put('demo/artifact/settled',{stage:'verified',transaction:{content:{from:address}}});
  await j.put('demo/wallet/settled',{stage:'broadcast-accepted',signedTransaction:{content:{from:address}}});
  assert.equal(h.report().healthy,true);
  await j.put('demo/artifact/pending',{stage:'broadcast-accepted',transaction:{content:{from:address}}});
  const transport=h.durable('node2-transport.sqlite');
  await transport.put('pending',{stage:'broadcast-accepted',signedTransaction:{content:{from:address}}});
  assert.equal(h.report().seller.unconfirmed.length,2);
});

test('review: elapsed approval windows are expired at equality, other outcomes retain readback',t=>{
  const h=fixture(t);
  for(const protocol of [false,true]){
    const p=h.create({protocol,stage:protocol?'identity':'awaiting_approval',status:protocol?'agreement_pending':'awaiting_approval',at:NOW-3600000});
    assert.equal(h.report({now:NOW-1}).purchases.find(row=>row.purchaseId===p.id).stage,protocol?'identity':'awaiting_approval');
    assert.equal(h.report().purchases.find(row=>row.purchaseId===p.id).stage,'expired');
  }
  assert.deepEqual(h.report().stuck,[]);
  h.create({stage:'payment_uncertain',at:NOW-3600000});assert.equal(h.report().stuck[0].stage,'payment_uncertain');
  h.db.exec("UPDATE operations SET expires_at='invalid'");assert.throws(()=>h.report());
});

test('review: scratch root cannot overlap live state, including symlink aliases',t=>{
  const h=fixture(t);h.create();const before=bytes(h.root);
  for(const scratch of [h.root,join(h.root,'app')]){
    const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:scratch},encoding:'utf8'});
    assert.equal(cli.status,2,'live state cannot host scratch');
    assert.deepEqual(bytes(h.root),before);
  }
  const alias=join(tmpdir(),`scratch-alias-${process.pid}`);fs.symlinkSync(h.root,alias);t.after(()=>rmSync(alias));
  const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:alias},encoding:'utf8'});
  assert.equal(cli.status,2);
});

async function interruptedSnapshot(t,h,signal){
  const root=mkdtempSync(join(tmpdir(),'interrupt-health-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=`import {readOnlySnapshot} from ${JSON.stringify(new URL('../src/ops/health.mjs',import.meta.url).href)};readOnlySnapshot(process.argv[1],()=>{process.stdout.write('copied\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,h.path],{env:{...process.env,TMPDIR:root},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const closed=new Promise(resolve=>child.once('close',(code,sig)=>resolve({code,sig})));
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(new Error('snapshot child exited before copy')));});
  const dirs=readdirSync(root);assert.equal(dirs.length,1);assert.equal(fs.statSync(join(root,dirs[0])).mode&0o777,0o700);
  assert.equal(fs.statSync(join(root,dirs[0],'state.sqlite')).mode&0o777,0o600);
  child.kill(signal);await closed;
  return root;
}
for(const signal of ['SIGINT','SIGTERM'])test(`review: ${signal} removes private database scratch`,async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,signal);assert.deepEqual(readdirSync(root),[]);
});

test('review: next run sweeps only owned stale scratch after SIGKILL',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL');
  assert.equal(readdirSync(root).length,1);
  const decoy=join(root,'dacs-ops-health-unrelated');mkdirSync(decoy,{mode:0o700});writeFileSync(join(decoy,'keep'),'unrelated');
  const link=join(root,'dacs-ops-health-symlink');fs.symlinkSync(decoy,link);
  const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:root},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(readdirSync(root).sort(),['dacs-ops-health-symlink','dacs-ops-health-unrelated']);
});

test('review: health projection agrees with L4 budgetRefusal ledger fields and limits',async t=>{
  const h=fixture(t),evidencePath=join(h.root,'evidence','seller-approvals.jsonl');mkdirSync(join(h.root,'evidence'));
  const {request,policy}=policyRequest('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  const requestBytes=JSON.stringify(request),base={format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(requestBytes),requestBytes,approvalMode:'policy',decision:'approved',totalOs:'4000000000'};
  for(const [label,rows,writes,total] of [
    ['uncompleted approval at the window edge stays held',[{...base,recordedAt:NOW-3600000}],1,'4000000000'],
    ['recent',[{...base,recordedAt:NOW-3599999}],1,'4000000000'],
    ['manual',[{...base,approvalMode:undefined,recordedAt:NOW}],0,'0'],
    ['rejected',[{...base,decision:'rejected',recordedAt:NOW}],0,'0'],
    ['future',[{...base,recordedAt:NOW+1}],1,'4000000000'],
  ]){
    writeFileSync(evidencePath,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const limits={mode:'policy',maxWritesPerHour:1,maxTotalOsPerHour:'4000000000'};
    const budget=h.report({sellerApproval:limits}).seller.budget;
    assert.equal(budget.writes,writes,label);assert.equal(budget.totalOs,total,label);
    const accepted=await createExactOperatorApproval({evidencePath,maxTotalOs:'4000000000',sellerApproval:limits,policy,now:()=>NOW})(request);
    assert.equal(accepted,writes===0,label);
  }
});

test('review: explicit process exit also removes active scratch',async t=>{
  const h=fixture(t);h.create();const root=mkdtempSync(join(tmpdir(),'exit-health-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=`import {readOnlySnapshot} from ${JSON.stringify(new URL('../src/ops/health.mjs',import.meta.url).href)};readOnlySnapshot(process.argv[1],()=>process.exit(7));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source,h.path],{env:{...process.env,TMPDIR:root},encoding:'utf8'});
  assert.equal(child.status,7);assert.deepEqual(readdirSync(root),[]);
});

test('review: stale sweep preserves live processes, invalid markers, links and unexpected contents',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL');
  const stale=join(root,readdirSync(root)[0]),owner=JSON.parse(readFileSync(join(stale,'owner.json'),'utf8'));
  const keep=[];
  function decoy(pid=owner.pid){
    const directory=mkdtempSync(join(root,`dacs-ops-health-${pid}-`)),name=directory.slice(root.length+1);keep.push(name);
    writeFileSync(join(directory,'owner.json'),JSON.stringify({...owner,pid,directory:name}),{mode:0o600});return directory;
  }
  decoy(process.pid);
  let directory=decoy();fs.chmodSync(directory,0o755);
  directory=decoy();writeFileSync(join(directory,'unexpected'),'unrelated',{mode:0o600});
  directory=decoy();fs.symlinkSync(h.path,join(directory,'state.sqlite'));
  directory=decoy();writeFileSync(join(directory,'owner.json'),JSON.stringify({...owner,directory:directory.slice(root.length+1),format:'unrelated'}));
  directory=decoy();writeFileSync(join(directory,'owner.json'),JSON.stringify({...owner,directory:directory.slice(root.length+1),pid:owner.pid+1}));
  directory=decoy();fs.chmodSync(join(directory,'owner.json'),0o644);
  const before=bytes(h.root),cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:root},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(readdirSync(root).sort(),keep.sort());assert.deepEqual(bytes(h.root),before);
});

test('review: scratch excludes every journal target before copying any database',async t=>{
  const h=fixture(t);h.create();const external=mkdtempSync(join(tmpdir(),'external-journal-'));t.after(()=>rmSync(external,{recursive:true,force:true}));
  const journalPath=join(external,'journal.sqlite'),j=openDurableWalletJournal({path:journalPath,mode:'create'});t.after(()=>j.close());
  await j.put('TEST',{stage:'verified'});fs.symlinkSync(journalPath,join(h.root,'seller-artifacts.sqlite'));
  const original=fs.writeFileSync;let writes=0;
  fs.writeFileSync=(...args)=>{writes++;return original(...args);};syncBuiltinESMExports();
  const previous=process.env.TMPDIR;process.env.TMPDIR=external;
  try{assert.throws(()=>h.report());assert.equal(writes,0,'reject overlap before creating a scratch marker or copy');}
  finally{process.env.TMPDIR=previous;fs.writeFileSync=original;syncBuiltinESMExports();}
});


test('review: stale sweep never removes selected state or foreign-owned entries',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL'),stale=join(root,readdirSync(root)[0]);
  const previous=process.env.TMPDIR;process.env.TMPDIR=root;
  try{
    const original=fs.lstatSync;
    fs.lstatSync=(path,...args)=>{const st=original(path,...args);if(path===stale)Object.defineProperty(st,'uid',{value:process.getuid()+1});return st;};syncBuiltinESMExports();
    try{h.report();assert.ok(fs.existsSync(stale),'foreign entry preserved');}
    finally{fs.lstatSync=original;syncBuiltinESMExports();}
    const before=bytes(stale);
    opsHealth({databasePath:join(stale,'state.sqlite'),now:NOW});
    assert.deepEqual(bytes(stale),before,'selected state never swept even with a stale CLI marker');
  }finally{process.env.TMPDIR=previous;}
});

// an earlier review reproductions. Each builds its live state, then checks the report
// fails closed (exit 2) or stays unhealthy, and that live files survive.
const cliWith=(args,env={})=>spawnSync(process.execPath,['scripts/ops-health.mjs',...args],{cwd:resolve('.'),env:{...process.env,...env},encoding:'utf8',timeout:10000});
// The schema is checkpointed into the main file; the unresolved purchase is
// committed only to the WAL, so losing the WAL would look like a healthy database.
const unresolvedPurchase=(h)=>{h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return h.create({stage:'payment_uncertain',at:NOW-600000});};

test('an earlier review: stale sweep never deletes a selected WAL reached through a sidecar symlink',async t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const root=await interruptedSnapshot(t,h,'SIGKILL'),stale=join(root,readdirSync(root)[0]),target=join(stale,'state.sqlite-wal');
  rmSync(target,{force:true});fs.renameSync(`${h.path}-wal`,target);fs.chmodSync(target,0o600);fs.symlinkSync(target,`${h.path}-wal`);
  const before=sha(readFileSync(target)),cli=cliWith(['--database',h.path,'--operator-state',h.root,'--json'],{TMPDIR:root});
  assert.ok(fs.existsSync(target),'live WAL target retained');assert.equal(sha(readFileSync(target)),before);assert.equal(cli.status,2,cli.stdout);
});

test('an earlier review: symlinked live WAL and SHM are refused before any scratch is created beside them',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const external=mkdtempSync(join(tmpdir(),'external-sidecars-'));t.after(()=>rmSync(external,{recursive:true,force:true}));
  for(const suffix of ['-wal','-shm']){fs.renameSync(`${h.path}${suffix}`,join(external,`live${suffix}`));fs.symlinkSync(join(external,`live${suffix}`),`${h.path}${suffix}`);}
  const original=fs.mkdtempSync;let scratch=0;
  fs.mkdtempSync=(...args)=>{scratch++;return original(...args);};syncBuiltinESMExports();
  const previous=process.env.TMPDIR;process.env.TMPDIR=external;
  try{assert.throws(()=>h.report(),/could not read valid state/);assert.equal(scratch,0,'no scratch directory created');}
  finally{process.env.TMPDIR=previous;fs.mkdtempSync=original;syncBuiltinESMExports();}
  assert.equal(cliWith(['--database',h.path,'--operator-state',h.root,'--json'],{TMPDIR:external}).status,2);
  assert.deepEqual(readdirSync(external).sort(),['live-shm','live-wal']);
});

test('an earlier review: a renamed main database whose WAL stays under the old (now alias) name fails closed',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const renamed=join(h.root,'app','renamed.sqlite');fs.renameSync(h.path,renamed);fs.symlinkSync(renamed,h.path);
  assert.throws(()=>h.report({operatorState:null}),/could not read valid state/,'alias WAL is not silently dropped');
  assert.equal(cliWith(['--database',h.path,'--json']).status,2);
});

test('an earlier review: operator mode binds the canonical database name, so a renamed database cannot drop its WAL',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const renamed=join(h.root,'app','renamed.sqlite');fs.renameSync(h.path,renamed);
  assert.throws(()=>h.report({databasePath:renamed}),/could not read valid state/);
  assert.equal(cliWith(['--database',renamed,'--operator-state',h.root,'--json']).status,2);
});

test('an earlier review: a WAL renamed away while SHM remains fails closed instead of reading checkpointed state',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  assert.equal(h.report().healthy,false);
  fs.renameSync(`${h.path}-wal`,`${h.path}-wal.moved`);
  assert.throws(()=>h.report({operatorState:null}),/could not read valid state/);
  assert.equal(cliWith(['--database',h.path,'--json']).status,2);
});

test('an earlier review: a database renamed behind an alias during the copy fails the after-copy file-set check',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const renamed=join(h.root,'app','renamed.sqlite'),original=fs.readFileSync;let reads=0,opened=false;
  fs.readFileSync=(path,...args)=>{
    if(path===h.path&&++reads===2){fs.renameSync(h.path,renamed);fs.symlinkSync(renamed,h.path);}
    return original(path,...args);
  };
  syncBuiltinESMExports();
  try{assert.throws(()=>readOnlySnapshot(h.path,()=>{opened=true;}),/could not read valid state/);assert.equal(opened,false);}
  finally{fs.readFileSync=original;syncBuiltinESMExports();}
});

test('an earlier review: a rollback journal, or WAL state beside a database not in WAL mode, fails closed',t=>{
  const h=fixture(t);h.create();
  writeFileSync(`${h.path}-journal`,'');
  assert.throws(()=>readOnlySnapshot(h.path,()=>{}),/could not read valid state/);rmSync(`${h.path}-journal`);
  const legacy=join(h.root,'legacy.sqlite'),db=new DatabaseSync(legacy);db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t(x)');db.close();
  assert.equal(readOnlySnapshot(legacy,db=>db.prepare('SELECT count(*) AS n FROM t').get().n),0);
  writeFileSync(`${legacy}-wal`,'');
  assert.throws(()=>readOnlySnapshot(legacy,()=>{}),/could not read valid state/);
});

test('an earlier review: scratch is never created in a directory holding a selected database alias',t=>{
  const h=fixture(t);h.create();
  const aliases=mkdtempSync(join(tmpdir(),'alias-dir-'));t.after(()=>rmSync(aliases,{recursive:true,force:true}));
  fs.symlinkSync(h.path,join(aliases,'dacs-chatgpt.sqlite'));
  assert.equal(cliWith(['--database',join(aliases,'dacs-chatgpt.sqlite'),'--json'],{TMPDIR:aliases}).status,2);
  assert.deepEqual(readdirSync(aliases),['dacs-chatgpt.sqlite']);
});

test('an earlier review: journal SHM without WAL, and retained sidecars of an absent journal, fail closed',async t=>{
  const h=fixture(t);h.create();const j=h.durable('seller-wallet.sqlite'),path=join(h.root,'seller-wallet.sqlite');
  const checkpoint=new DatabaseSync(path);checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');checkpoint.close();
  await j.put('sr2/wallet/TEST',{stage:'issued',hash:'e'.repeat(64),signedTransaction:{content:{from:address}}});
  assert.equal(h.report().seller.unconfirmed.length,1);
  fs.renameSync(`${path}-wal`,`${path}-wal.moved`);
  assert.throws(()=>h.report(),/could not read valid state/,'SHM without WAL');
  fs.renameSync(`${path}-wal.moved`,`${path}-wal`);fs.renameSync(path,`${path}.moved`);
  assert.throws(()=>h.report(),/could not read valid state/,'absent journal with retained sidecars');
  assert.equal(h.cli(['--json']).status,2);
});

test('an earlier review: an app/ symlink to another service cannot bind its database to this operator state',async t=>{
  const a=fixture(t),b=fixture(t),sellerB=`0x${'b'.repeat(64)}`;
  a.create();// A's buyer wallet is B's seller address
  await b.durable('node2-transport.sqlite').put('seller-b',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:sellerB}}});
  fs.renameSync(join(b.root,'app'),join(b.root,'app-old'));fs.symlinkSync(join(a.root,'app'),join(b.root,'app'));
  assert.throws(()=>opsHealth({databasePath:join(b.root,'app','dacs-chatgpt.sqlite'),operatorState:b.root,now:NOW}),/could not read valid state/);
  assert.equal(cliWith(['--operator-state',b.root,'--json']).status,2);
});

test('an earlier review: dangling selected journal and ledger links are broken state, not absence',t=>{
  const h=fixture(t);h.create();
  fs.symlinkSync(join(h.root,'missing.sqlite'),join(h.root,'seller-wallet.sqlite'));
  assert.throws(()=>h.report(),/could not read valid state/);assert.equal(h.cli(['--json']).status,2);
  rmSync(join(h.root,'seller-wallet.sqlite'));assert.equal(h.report().healthy,true,'real absence stays optional');
  fs.symlinkSync(join(h.root,'missing-evidence'),join(h.root,'evidence'));
  assert.throws(()=>h.report(),/could not read valid state/,'dangling ledger directory');rmSync(join(h.root,'evidence'));
  mkdirSync(join(h.root,'evidence'));fs.symlinkSync(join(h.root,'missing.jsonl'),join(h.root,'evidence','seller-approvals.jsonl'));
  assert.throws(()=>h.report(),/could not read valid state/);
});

test('an earlier review: logical or persisted expiry never hides an indeterminate write',t=>{
  const h=fixture(t),start=NOW-3600000-400000;
  const p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:start});
  h.clock.now=start+60000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-anchored',attempts:[{step:'agreement',outcome:'indeterminate',reason:'TEST'}]}},event:'protocol_commit-request',data:{stage:'agreement-anchored'}});
  let r=h.report();
  assert.equal(r.purchases[0].stage,'expired','display stage may change');assert.equal(r.healthy,false);
  assert.equal(r.stuck[0].purchaseId,p.id);assert.equal(r.stuck[0].outcome,'unknown-readback-required');assert.match(r.stuck[0].nextExpected,/readback; never resend/);
  assert.equal(h.cli(['--json']).status,1);
  h.clock.now=NOW;h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  r=h.report();assert.equal(r.healthy,false,'persisted expiry keeps the readback alert');assert.equal(r.stuck[0].outcome,'unknown-readback-required');
});

test('an earlier review: health budget projection matches the source change admission, including reserved holds without an approved row',async t=>{
  const h=fixture(t),evidencePath=join(fs.realpathSync(h.root),'evidence','seller-approvals.jsonl');mkdirSync(join(h.root,'evidence'));
  const {request:probe,policy}=policyRequest('01ARZ3NDEKTSV4RRFFQ69G5FAV'),heldJob='01ARZ3NDEKTSV4RRFFQ69G5FAX';
  const seedBytes=(declared)=>JSON.stringify({method:'sendTransaction',content:{jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',debit:{totalOs:declared}}});
  const approved=(id,recordedAt,{totalOs='4000000000',declared=totalOs,decision='approved',policyMode=true}={})=>{
    const requestBytes=seedBytes(declared);
    return {format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(requestBytes),requestBytes,decision,totalOs,...(policyMode?{approvalMode:'policy',reservationId:id}:{}),recordedAt};
  };
  const completed=(row,outcome,recordedAt)=>({format:'dacs-node2-seller-policy-attempt/v1',reservationId:row.reservationId,approvalHash:row.approvalHash,outcome,recordedAt});
  const hour=3600000,scenarios=[];
  // [label, ledger rows, expected held writes, expected held OS, in-memory preparation]
  {const row=approved('old-unresolved',NOW-2*hour);scenarios.push(['approval without completion stays held past the hour',[row],1,'4000000000']);}
  {const row=approved('spent-recent',NOW-2*hour);scenarios.push(['spent within the hour after completion',[row,completed(row,'spent',NOW-hour/2)],1,'4000000000']);}
  {const row=approved('spent-old',NOW-3*hour);scenarios.push(['spent over an hour ago',[row,completed(row,'spent',NOW-2*hour)],0,'0']);}
  {const row=approved('released',NOW-60000);scenarios.push(['released attempt',[row,completed(row,'released',NOW-30000)],0,'0']);}
  scenarios.push(['declared debit above recorded total',[approved('declared',NOW,{totalOs:'3000000000',declared:'4000000000'})],1,'4000000000']);
  scenarios.push(['rejected and manual decisions',[approved('rejected',NOW,{decision:'rejected'}),approved('manual',NOW,{policyMode:false})],0,'0']);
  scenarios.push(['reserved hold without an approved row',[],1,'4000000000',true]);
  for(const [label,rows,writes,totalOs,provisional] of scenarios){
    const seeded=rows.map(row=>`${JSON.stringify(row)}\n`).join('');writeFileSync(evidencePath,seeded);
    let holder=null;const held=policyRequest(heldJob);
    if(provisional){
      holder=createExactOperatorApproval({evidencePath,maxTotalOs:'4000000000',sellerApproval:{mode:'policy'},policy:held.policy,now:()=>NOW});
      assert.equal(await holder.prepare(held.request),true,label);assert.equal(readFileSync(evidencePath,'utf8'),seeded,'a preparation writes no approved row');
    }
    const budget=h.report({sellerApproval:{mode:'policy'}}).seller.budget,total=BigInt(budget.totalOs);
    assert.deepEqual([budget.writes,budget.totalOs],[writes,totalOs],`${label}: the source change hold semantics`);
    const admit=async(limits)=>{
      writeFileSync(evidencePath,seeded);
      try{return await createExactOperatorApproval({evidencePath,maxTotalOs:'4000000000',sellerApproval:{mode:'policy',...limits},policy,now:()=>NOW})(structuredClone(probe));}
      finally{writeFileSync(evidencePath,seeded);}
    };
    assert.equal(await admit({maxWritesPerHour:budget.writes+1,maxTotalOsPerHour:String(total+4000000000n)}),true,`${label}: admission has room exactly where health projects it`);
    if(budget.writes>0){
      assert.equal(await admit({maxWritesPerHour:budget.writes,maxTotalOsPerHour:String(total+4000000000n)}),false,`${label}: projected writes fill the write limit`);
      assert.equal(await admit({maxWritesPerHour:budget.writes+1,maxTotalOsPerHour:String(total+3999999999n)}),false,`${label}: projected DEM fills the DEM limit`);
    }
    if(provisional)await holder.settle(held.request,'released');
  }
});

// an earlier review. Attempts recorded the way protocol-purchases.mjs note() records them.
const NO_PROVIDER='CONTEXT_PROVIDER_UNAVAILABLE: no operator Agreement context provider is configured';
// Fix 5: the structured mark note() records where no Agreement-context provider was invoked (fix 6: only there).
const NOT_WRITTEN={written:false};
const attempt=(step,outcome,reason,extra={})=>({at:new Date(NOW-1000).toISOString(),step,outcome,...(reason?{reason}:{}),...extra});
const expiredWith=(h,step,outcome,stage,reason='TEST',extra={})=>{
  const start=NOW-3600000-400000,p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:start});
  h.clock.now=start+60000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage,attempts:[attempt(step,outcome,reason,extra)]}},event:`protocol_${step}`,data:{outcome,reason,...extra}});
  h.clock.now=NOW;return p;
};
const dbOnly=(h,args=['--json'])=>spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,...args],{cwd:resolve('.'),encoding:'utf8',timeout:10000});
// Fix 4: every pair protocol-purchases.mjs can record, read from that file and its callees.
// A write pair may have issued a write (or asked the seller for one) whose outcome is unknown.
// 'pending' stands for any status of the seller's own choosing (claim: protocol-purchases.mjs:823).
// Integration on main 25977d1 (the source change): the buyer copy is written once, then only read back, so its
// absent and rejected readbacks leave that write unresolved.
const WRITE_PAIRS=[['agreement','indeterminate'],['commit-request','unavailable'],['claim','unavailable'],['claim','accepted'],['claim','indeterminate'],['claim','pending'],
  ['buyer-copy','unavailable'],['buyer-copy','absent'],['buyer-copy','rejected'],['seller-copy','unavailable'],['native-evidence','held']];
const OTHER_PAIRS=[['agreement','waiting'],['agreement','rejected'],['agreement','anchored'],['commit-request','refused'],
  ...['verified','rejected','absent','unavailable'].flatMap(outcome=>[['commitment',outcome],['payment-evidence',outcome],['delivery',outcome]]),['commitment','indeterminate'],
  ['claim','rejected'],...['ready','rejected','refused','unavailable'].map(outcome=>['bundle-request',outcome]),['countersign','rejected'],['buyer-copy','anchored'],
  ['seller-copy','verified'],['seller-copy','rejected'],['seller-copy','absent'],['seller-copy','refused'],
  ['seller-confirmation','verified'],['seller-confirmation','unknown'],['seller-confirmation','unavailable'],['seller-confirmation','rejected'],
  ['native-evidence','verified-fixture-native-read'],['agreement-context','indeterminate',NO_PROVIDER,NOT_WRITTEN],
  // the source change (DACS_BUYER_CHAIN_READBACK=on): a fresh read that kept an already verified delivery.
  ['chain-readback','indeterminate'],
  ['agreement-context','indeterminate','CONTEXT_PROVIDER_UNAVAILABLE: DEM delivery context capability is absent',NOT_WRITTEN]];
// Recorded after the Agreement-context provider ran: it may have published seller Vet records.
const VET_PAIRS=[['agreement-context','absent'],['agreement-context','rejected'],['agreement-context','indeterminate']];
// Records one attempt exactly as note() does: the stored ten-attempt tail and a protocol_<step> event.
const noted=(h,p,step,outcome,{reason,stage,toStatus,extra={},patch={}}={})=>{
  const current=h.ops.get(p.accountId,p.id),protocol=current.state.protocol;
  const attempts=[...(protocol.attempts??[]).slice(-9),{at:new Date(h.clock.now).toISOString(),step,outcome,...(reason?{reason}:{}),...extra}];
  return h.ops.transition(p.id,current.status,toStatus??current.status,{state:{protocol:{...protocol,...patch,...(stage?{stage}:{}),attempts}},event:`protocol_${step}`,data:{stage:stage??protocol.stage,outcome,...(reason?{reason}:{}),...extra}});
};

test('an earlier review: a missing Agreement-context provider is not a write: its expired purchase raises no readback alert',t=>{
  const h=fixture(t);
  // Fix 4: the exact reason agreement-context-consumer.mjs records when no provider is configured
  // (the an earlier review fixture used reason 'TEST'). Fix 5: plus the not-written mark note() records with it.
  const p=expiredWith(h,'agreement-context','indeterminate','identity',NO_PROVIDER,NOT_WRITTEN);
  let r=h.report();
  assert.equal(r.purchases[0].stage,'expired');assert.equal(r.healthy,true,'no write was issued');assert.deepEqual(r.stuck,[]);
  assert.equal(r.purchases[0].outcome,'unresolved-read');assert.doesNotMatch(formatOpsHealth(r),/never resend/);
  assert.equal(h.cli(['--json']).status,0);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  r=h.report();assert.equal(r.healthy,true,'persisted expiry stays healthy');assert.deepEqual(r.stuck,[]);
  r=h.report({operatorState:null});assert.equal(r.healthy,true,'database only: nothing to read back');assert.equal(dbOnly(h).status,0);
});

test('an earlier review: a seller confirmation without a status on a completed purchase raises no alert',t=>{
  const h=fixture(t),p=h.create({status:'settled_verified',stage:'awaiting-countersignature',protocol:true,at:NOW-600000});
  // The buyer's own readback verified the seller copy; the seller's answer to confirmBuyerCopy had no status.
  h.clock.now=NOW-60000;
  h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'completed',attempts:[attempt('buyer-copy','anchored'),attempt('seller-copy','verified'),attempt('seller-confirmation','unknown')]}},event:'protocol_seller-confirmation',data:{outcome:'unknown'}});
  const r=h.report();
  assert.equal(r.purchases[0].stage,'completed');assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);
  assert.equal(r.purchases[0].outcome,'unresolved-read');assert.doesNotMatch(formatOpsHealth(r),/never resend/);
  assert.equal(h.cli(['--json']).status,0);
});

test('an earlier review: an unknown Agreement write on an expired or completed purchase still alerts, readback only',t=>{
  const h=fixture(t),p=expiredWith(h,'agreement','indeterminate','agreement-signing');
  const alert=[[p.id,'expired',0,'unknown-readback-required','original write readback; never resend']];
  const rows=(r)=>r.stuck.map(s=>[s.purchaseId,s.stage,s.thresholdMs,s.outcome,s.nextExpected]);
  let r=h.report();
  assert.equal(r.healthy,false);assert.deepEqual(rows(r),alert);assert.equal(r.purchases[0].outcome,'unknown-readback-required');
  assert.equal(h.cli(['--json']).status,1);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  r=h.report();assert.equal(r.healthy,false,'persisted expiry keeps the alert');assert.deepEqual(rows(r),alert);
  // A completed purchase whose last recorded step is a seller write request with an unknown answer
  // (fix 4: the real 'unavailable' outcome; protocol-purchases.mjs never records seller-copy/unknown).
  const c=h.create({status:'settled_verified',stage:'awaiting-countersignature',protocol:true,at:NOW-600000});
  h.ops.transition(c.id,c.status,c.status,{state:{protocol:{stage:'completed',attempts:[attempt('seller-copy','unavailable')]}},event:'protocol_seller-copy',data:{outcome:'unavailable'}});
  r=h.report();assert.deepEqual(rows({stuck:r.stuck.filter(s=>s.purchaseId===c.id)}),[[c.id,'completed',0,'unknown-readback-required','original write readback; never resend']]);
});

test('an earlier review: every write pair keeps the terminal readback alert; every other pair does not',t=>{
  // Fix 4: real (step, outcome) pairs from protocol-purchases.mjs, read from the code independently
  // of the table in health.mjs (an earlier review used synthetic indeterminate/unknown outcomes for every step).
  for(const [step,outcome] of WRITE_PAIRS){
    const h=fixture(t),p=expiredWith(h,step,outcome,'agreement-anchored'),r=h.report();
    assert.equal(r.healthy,false,`${step} ${outcome}`);assert.equal(r.stuck[0]?.purchaseId,p.id,step);assert.equal(r.stuck[0].outcome,'unknown-readback-required',step);
  }
  for(const [step,outcome,reason,extra] of OTHER_PAIRS){
    const h=fixture(t);expiredWith(h,step,outcome,'agreement-anchored',reason,extra);const r=h.report();
    assert.equal(r.healthy,true,`${step} ${outcome}`);assert.deepEqual(r.stuck,[],`${step} ${outcome}`);
    assert.equal(r.purchases[0].outcome,['indeterminate','unknown'].includes(outcome)?'unresolved-read':'recorded',`${step} ${outcome}`);
  }
});

test('an earlier review: an unresolved read before expiry waits on its stage threshold without write-readback advice',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-40*60000});
  h.clock.now=NOW-35*60000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'identity',attempts:[attempt('agreement-context','indeterminate',NO_PROVIDER,NOT_WRITTEN)]}},event:'protocol_agreement-context',data:{outcome:'indeterminate',reason:NO_PROVIDER,...NOT_WRITTEN}});
  const stuck=h.report().stuck;
  assert.deepEqual(stuck.map(s=>[s.purchaseId,s.stage,s.outcome,s.nextExpected]),[[p.id,'identity','waiting','buyer identity presentation']]);
  assert.equal(h.report({thresholds:{identity:41*60000}}).healthy,true);
});

test('an earlier review: an unresolved attempt with an unrecognized or missing step fails closed',t=>{
  for(const extra of [{step:'future-step'},{}]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing',attempts:[{at:new Date(NOW).toISOString(),...extra,outcome:'indeterminate'}]}},event:'protocol_step',data:{}});
    assert.throws(()=>h.report(),/could not read valid state/);assert.equal(h.cli(['--json']).status,2);
  }
});

test('an earlier review: the budget says it excludes the one in-flight preparation, without changing the exit code',async t=>{
  const h=fixture(t),evidencePath=join(h.root,'evidence','seller-approvals.jsonl');
  const {request,policy}=policyRequest('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  const approve=createExactOperatorApproval({evidencePath,maxTotalOs:'4000000000',sellerApproval:{mode:'policy'},policy,now:()=>NOW});
  assert.equal(await approve(request),true);await approve.settle(request,'spent');
  const limits={mode:'policy',maxWriteTotalOs:'3000000000',maxWritesPerHour:1};
  const report=h.report({sellerApproval:limits});
  assert.equal(report.seller.budget.status,'at-limit');assert.equal(report.healthy,true);
  assert.deepEqual(report.seller.budget.inFlightPreparation,{counted:false,maxWrites:1,maxTotalOs:'3000000000',maxTotalDem:'3.000000000'});
  assert.match(formatOpsHealth(report),/^seller budget rolling-hour writes=1\/1 DEM=4\.000000000\/96\.000000000 at-limit \(approvals; excludes ≤1 in-flight preparation\)$/m);
  const config=join(h.root,'operator.json');writeFileSync(config,JSON.stringify({stateDirectory:h.root,sellerApproval:limits}));
  for(const args of [[],['--json']]){const cli=h.cli(['--operator-config',config,...args]);assert.equal(cli.status,0,cli.stderr);}
  assert.equal(JSON.parse(h.cli(['--operator-config',config,'--json']).stdout).seller.budget.inFlightPreparation.counted,false);
});

// Fix 4: classify the whole attempt history against an explicit table.
const UNAVAILABLE='seller agent response is unavailable or unauthenticated; the operation outcome may be unknown';
const READBACK='original write readback; never resend';
const stuckOf=(r,p)=>r.stuck.filter(s=>s.purchaseId===p.id).map(s=>[s.stage,s.thresholdMs,s.outcome,s.nextExpected,s.unresolvedWrites]);
const expiredSeq=(h,pairs,stage='agreement-anchored')=>{
  const start=NOW-3600000-400000,p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:start});
  h.clock.now=start+60000;for(const [step,outcome,reason] of pairs)noted(h,p,step,outcome,{reason,stage});
  h.clock.now=NOW;return p;
};

test('provider-effect: a commit request that lost its answer, then an unavailable commitment readback, is not healthy after expiry',t=>{
  const h=fixture(t),start=NOW-3600000-400000,p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:start});
  h.clock.now=start+60000;
  noted(h,p,'agreement','anchored',{stage:'agreement-anchored'});
  noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE});
  noted(h,p,'commitment','unavailable',{reason:'SR-2 read failed: TEST'});
  h.clock.now=NOW;
  for(const r of [h.report(),h.report({operatorState:null})]){
    assert.equal(r.healthy,false);assert.equal(r.purchases[0].outcome,'unknown-readback-required');
    assert.deepEqual(stuckOf(r,p),[['expired',0,'unknown-readback-required',READBACK,['commit-request']]]);
  }
  assert.match(formatOpsHealth(h.report()),/^stuck \S+ stage=expired ageMs=\d+ thresholdMs=0 outcome=unknown-readback-required writes=commit-request next=original write readback; never resend$/m);
  assert.equal(h.cli(['--json']).status,1);assert.equal(dbOnly(h).status,1);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  assert.deepEqual(stuckOf(h.report(),p),[['expired',0,'unknown-readback-required',READBACK,['commit-request']]],'persisted expiry keeps it');
});

// the source change an earlier review (code P3-1 / a review P3-1, mutant X6): an indeterminate
// commitment readback (node junk, the source change) reads nothing back either, so the lost
// commit request stays unresolved.
test('provider-effect: a commit request that lost its answer, then an indeterminate commitment readback, is not healthy after expiry',t=>{
  const h=fixture(t),start=NOW-3600000-400000,p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:start});
  h.clock.now=start+60000;
  noted(h,p,'agreement','anchored',{stage:'agreement-anchored'});
  noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE});
  noted(h,p,'commitment','indeterminate',{reason:'native FinalityCommitmentRecord read: invalid: TEST node bytes do not authenticate'});
  h.clock.now=NOW;
  for(const r of [h.report(),h.report({operatorState:null})]){
    assert.equal(r.healthy,false);assert.equal(r.purchases[0].outcome,'unknown-readback-required');
    assert.deepEqual(stuckOf(r,p),[['expired',0,'unknown-readback-required',READBACK,['commit-request']]]);
  }
  assert.equal(h.cli(['--json']).status,1);
});

test('provider-effect: a later verified commitment readback clears the lost commit answer, even past the stored ten attempts',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-anchored',at:NOW-120000});
  h.clock.now=NOW-100000;
  noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE});
  for(let i=0;i<10;i++)noted(h,p,'commitment','absent',{reason:'no finalized commitment at the canonical address yet'});
  h.clock.now=NOW;
  assert.equal(h.ops.get(p.accountId,p.id).state.protocol.attempts.some(a=>a.step==='commit-request'),false,'the stored tail no longer holds it');
  let r=h.report();
  assert.equal(r.healthy,false,'a fresh purchase with an unresolved write is not healthy');
  assert.deepEqual(stuckOf(r,p),[['agreement-anchored',0,'unknown-readback-required',READBACK,['commit-request']]]);
  h.clock.now=NOW-1000;noted(h,p,'commitment','verified',{stage:'committed',toStatus:'awaiting_approval'});h.clock.now=NOW;
  r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);assert.equal(r.purchases[0].outcome,'recorded');
  assert.equal(h.cli(['--json']).status,0);assert.equal(dbOnly(h).status,0);
});

test('provider-effect: a fresh held native-evidence purchase is not healthy until a verified evidence or delivery readback',t=>{
  const h=fixture(t);
  const held=(reason)=>{const p=h.create({status:'settled_verified',stage:'payment-observed',protocol:true,at:NOW-120000});h.clock.now=NOW-60000;noted(h,p,'native-evidence','held',{reason,stage:'native-payment-evidence-held'});h.clock.now=NOW;return p;};
  const evidence=held(UNAVAILABLE),delivery=held('delivery-held');
  let r=h.report();
  assert.equal(r.healthy,false);
  for(const p of [evidence,delivery])assert.deepEqual(stuckOf(r,p),[['native-payment-evidence-held',0,'unknown-readback-required',READBACK,['native-evidence']]]);
  assert.equal(dbOnly(h).status,1);
  h.clock.now=NOW-30000;
  noted(h,evidence,'native-evidence','verified-fixture-native-read',{stage:'payment-evidenced'});
  assert.equal(h.report().healthy,false,'one is still held');
  noted(h,delivery,'delivery','verified',{stage:'delivery-ready'});
  h.clock.now=NOW;
  r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);
  // The CLI reads the wall clock, which can be minutes past NOW by this test on a loaded host;
  // longer thresholds keep its exit code about the readbacks, not the 5-minute stage age.
  const relaxed=['--threshold','payment-evidenced=86400','--threshold','delivery-ready=86400'];
  assert.equal(h.cli(['--json',...relaxed]).status,0);assert.equal(dbOnly(h,['--json',...relaxed]).status,0);
});

test('provider-effect: a readback clears only the write it reads back; a write stays unresolved across later attempts',t=>{
  const stays=[
    [['commit-request','unavailable'],['payment-evidence','verified']],[['claim','unavailable'],['commitment','verified']],
    [['claim','unavailable'],['delivery','verified']],[['buyer-copy','unavailable'],['seller-copy','verified']],
    [['seller-copy','unavailable'],['seller-confirmation','verified']],[['native-evidence','held'],['payment-evidence','verified']],
    [['agreement','indeterminate'],['commitment','verified']],[['agreement','indeterminate'],['agreement','waiting']],
    [['claim','unavailable'],['claim','accepted']],[['claim','accepted'],['payment-evidence','absent']],
    [['commit-request','unavailable'],['commitment','verified'],['commit-request','unavailable'],['commitment','absent']],
  ];
  const clears=[
    [['agreement','indeterminate'],['agreement','anchored']],[['commit-request','unavailable'],['commitment','verified']],
    [['claim','unavailable'],['claim','accepted'],['payment-evidence','verified']],[['buyer-copy','unavailable'],['buyer-copy','anchored']],
    [['seller-copy','unavailable'],['seller-copy','verified']],[['native-evidence','held'],['delivery','rejected']],
  ];
  for(const pairs of stays){
    const h=fixture(t),p=expiredSeq(h,pairs),r=h.report(),label=JSON.stringify(pairs);
    assert.equal(r.healthy,false,label);assert.equal(stuckOf(r,p)[0]?.[2],'unknown-readback-required',label);
  }
  for(const pairs of clears){
    const h=fixture(t);expiredSeq(h,pairs);const r=h.report();
    assert.equal(r.healthy,true,JSON.stringify(pairs));assert.deepEqual(r.stuck,[],JSON.stringify(pairs));
  }
});

test('provider-effect: an Agreement context that may have published seller Vet records is not healthy with --database only',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
  h.clock.now=NOW-30000;noted(h,p,'agreement-context','indeterminate',{reason:'DEM delivery context failed: TEST Vet publish answer lost'});h.clock.now=NOW;
  const r=h.report({operatorState:null});
  assert.equal(r.healthy,false);assert.equal(r.seller.journals,null);
  assert.deepEqual(r.stuck.map(s=>[s.purchaseId,s.stage,s.thresholdMs,s.outcome]),[[p.id,'identity',0,'seller-journal-not-read']]);
  assert.match(r.stuck[0].nextExpected,/seller Vet write readback.*--operator-state.*never resend/);
  assert.equal(r.purchases[0].outcome,'seller-journal-not-read');
  const text=formatOpsHealth(r);
  assert.match(text,/^STUCK /);assert.match(text,/^seller journals: not selected$/m);assert.match(text,new RegExp(`^stuck ${p.id} stage=identity .*outcome=seller-journal-not-read next=`,'m'));
  for(const args of [['--json'],[]]){const cli=dbOnly(h,args);assert.equal(cli.status,1,cli.stderr);}
  // Every disposition recorded after the provider ran, on an expired purchase too.
  for(const outcome of ['absent','rejected','indeterminate']){
    const e=fixture(t);expiredWith(e,'agreement-context',outcome,'identity',`CONTEXT_${outcome.toUpperCase()}: TEST`);
    const x=e.report({operatorState:null});assert.equal(x.healthy,false,outcome);assert.deepEqual(x.stuck.map(s=>[s.stage,s.outcome]),[['expired','seller-journal-not-read']],outcome);
  }
  // Recorded with the not-written mark (fix 5) where no provider was invoked: no alert.
  for(const reason of [NO_PROVIDER,'CONTEXT_PROVIDER_UNAVAILABLE: DEM delivery context capability is absent']){
    const e=fixture(t),q=e.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
    e.clock.now=NOW-30000;noted(e,q,'agreement-context','indeterminate',{reason,extra:NOT_WRITTEN});e.clock.now=NOW;
    const x=e.report({operatorState:null});assert.equal(x.healthy,true,reason);assert.equal(x.purchases[0].outcome,'unresolved-read',reason);assert.equal(dbOnly(e).status,0,reason);
  }
});

test('provider-effect: with --operator-state, the seller journal decides a possibly-written Agreement context',async t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
  h.clock.now=NOW-30000;noted(h,p,'agreement-context','indeterminate',{reason:'DEM delivery context failed: TEST Vet publish answer lost'});h.clock.now=NOW;
  // Operator state without the seller artifact journal cannot decide.
  let r=h.report();
  assert.equal(r.healthy,false);assert.deepEqual(r.seller.journals,[]);assert.deepEqual(r.stuck.map(s=>[s.purchaseId,s.outcome]),[[p.id,'seller-journal-not-read']]);
  assert.equal(h.cli(['--json']).status,1);
  const artifacts=h.durable('seller-artifacts.sqlite'),key='demo/artifact/vet-TEST',content={from:address};
  await artifacts.put(key,{stage:'intent',transaction:{content}});
  r=h.report();
  assert.equal(r.healthy,false,'the retained Vet intent needs readback');assert.deepEqual(r.stuck,[]);
  assert.deepEqual(r.seller.unconfirmed.map(u=>[u.source,u.stage,u.nextExpected]),[['seller-artifacts.sqlite','intent',READBACK]]);
  assert.equal(r.purchases[0].outcome,'seller-journal-checked');
  assert.equal(h.cli(['--json']).status,1);
  await artifacts.put(key,{stage:'verified',hash:'f'.repeat(64),transaction:{content}});
  r=h.report();assert.equal(r.healthy,true,'the seller journal shows the Vet write verified');assert.deepEqual(r.stuck,[]);
  assert.equal(h.cli(['--json']).status,0);
  assert.equal(h.report({operatorState:null}).healthy,false,'the database alone still cannot see the seller journal');
});

test('provider-effect: a (step, outcome) pair missing from the table fails closed, resolved or not',t=>{
  for(const [step,outcome] of [['commit-request','indeterminate'],['commitment','pending'],['native-evidence','unknown'],['agreement','unknown'],['future-step','verified'],['agreement-context','present'],['claim',null]]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    noted(h,p,step,outcome);
    assert.throws(()=>h.report(),/could not read valid state/,`${step} ${outcome}`);
    assert.equal(h.cli(['--json']).status,2,`${step} ${outcome}`);assert.equal(dbOnly(h).status,2,`${step} ${outcome}`);
  }
  // A stored attempt the event log lacks is still checked against the table.
  for(const attempts of ['xx',[null],[{}],[{step:'claim'}],[attempt('delivery','pending')]]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'identity',attempts}},event:'protocol_step',data:{stage:'identity'}});
    assert.throws(()=>h.report(),/could not read valid state/,JSON.stringify(attempts));
  }
});

test('provider-effect: the attempt table covers every note() call site in protocol-purchases.mjs',()=>{
  const source=readFileSync(resolve('src/dacs/protocol-purchases.mjs'),'utf8'),table=health.ATTEMPT_EFFECTS,seller=health.SELLER_STATUS;
  assert.ok(Array.isArray(table)&&typeof seller==='string','health.mjs exports its attempt table');
  // Fix 6: and every noteLost( call (an attempt only the event log can hold), apart from note() forwarding its own.
  // Integration on main 25977d1: and every settle( call (note() for native evidence and delivery), apart from settle() forwarding its own.
  const calls=[...source.matchAll(/\bnote(?:Lost)?\(\s*\w+\s*,\s*'([a-z-]+)'\s*,\s*([^,]+?)\s*,/g),...source.matchAll(/\bsettle\(\s*'([a-z-]+)'\s*,\s*([^,]+?)\s*,/g)];
  assert.equal(source.match(/\bnoteLost\(operation, step, /g)?.length,1,'note() forwards to noteLost() once');
  assert.equal(source.match(/\bnote\(operation, step, /g)?.length,1,'settle() forwards to note() once');
  assert.equal(calls.length,source.match(/\bnote(?:Lost)?\(|\bsettle\(/g).length-2,'every other note(, noteLost( and settle( call names a literal step');
  // Outcome expressions that are not literals, and what their callee can return there.
  const DOMAINS={
    'resolved.disposition':['absent','rejected','indeterminate'],  // both Agreement-context consumers; present is planned
    'progress.disposition':['indeterminate','waiting'],             // SDK progress after anchored/rejected
    'readback.status':['absent','unavailable','indeterminate'],     // readCommitment/readDevnetNativeCommitment after verified/rejected
    "answer.status ?? 'indeterminate'":[seller],                    // the seller's own claim status
    'verified.status':['absent'],                                   // verifyPaymentEvidence after rejected/verified
    'delivery.status':['absent','unavailable'],                     // readDelivery after verified/rejected
    'check.status':['absent'],                                      // verifyAnchoredCopy after rejected/verified
    "confirmation.status ?? 'unknown'":[seller],                    // the seller's own confirmation status
  };
  const recorded=new Set();
  for(const [,step,expression] of calls){
    const literals=[...expression.matchAll(/'([^']*)'/g)].map(m=>m[1]);
    const dynamic=expression.replace(/^error instanceof SellerRefusedError \? '[^']*' : '[^']*'$|^'[^']*'$/,'');
    if(dynamic)assert.ok(Object.hasOwn(DOMAINS,expression),`note(…, '${step}', ${expression}): unknown outcome expression; add its domain`);
    for(const outcome of [...literals,...(dynamic?DOMAINS[expression]:[])])recorded.add(`${step} ${outcome}`);
  }
  const rows=new Set(table.map(([step,outcome])=>`${step} ${outcome}`));
  assert.equal(rows.size,table.length,'one row per pair');
  assert.deepEqual([...recorded].filter(pair=>!rows.has(pair)).sort(),[],'recorded pairs missing from the table');
  assert.deepEqual([...rows].filter(pair=>!recorded.has(pair)).sort(),[],'table rows no call site records');
  assert.deepEqual([...new Set(calls.map(m=>m[1]))].sort(),[...new Set(table.map(([step])=>step))].sort());
  // The independent pair lists above agree with the table, pair for pair.
  const pair=(step,outcome)=>rows.has(`${step} ${outcome}`)?`${step} ${outcome}`:`${step} ${seller}`;
  assert.deepEqual(new Set([...WRITE_PAIRS,...OTHER_PAIRS,...VET_PAIRS].map(([step,outcome])=>pair(step,outcome))),rows);
});

// Fix 5: durable write intents, and the structured not-written mark.
// Saved exactly as protocol-purchases.mjs continueWalletAgreement saves them: the
// retained CREATE in state and a protocol_wallet_anchor_intent event, before the
// one-shot wallet anchor; protocol_wallet_anchor_not_issued withdraws a fresh intent.
const walletIntent=(h,p,type='protocol_wallet_anchor_intent')=>{
  const current=h.ops.get(p.accountId,p.id),protocol=current.state.protocol,logicalAddress=`TEST-${'1'.repeat(64)}`,agreementHash='2'.repeat(64);
  return h.ops.transition(p.id,current.status,current.status,{state:{protocol:{...protocol,walletAnchor:type==='protocol_wallet_anchor_intent'?{logicalAddress,writer:buyer,artifactKind:'Agreement'}:null}},
    event:type,data:{stage:protocol.stage,logicalAddress,agreementHash,...(type==='protocol_wallet_anchor_intent'?{}:{reason:'wallet-fenced'})}});
};

test('provider-status: a wallet Agreement CREATE intent with no recorded attempt is not healthy until withdrawn or read back',t=>{
  const start=NOW-3600000-400000;
  const intended=(h,after=[])=>{
    const p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:start});
    h.clock.now=start+60000;walletIntent(h,p);
    for(const [step,outcome,stage] of after)step.startsWith('protocol_')?walletIntent(h,p,step):noted(h,p,step,outcome,{stage});
    h.clock.now=NOW;return p;
  };
  // The process stopped after the intent, before any attempt was noted; the purchase then expired.
  let h=fixture(t),p=intended(h);
  assert.deepEqual(h.ops.get(p.accountId,p.id).state.protocol.attempts,undefined,'no attempt was recorded');
  for(const r of [h.report(),h.report({operatorState:null})]){
    assert.equal(r.healthy,false);assert.deepEqual(stuckOf(r,p),[['expired',0,'unknown-readback-required',READBACK,['wallet-anchor']]]);
  }
  assert.equal(h.cli(['--json']).status,1);assert.equal(dbOnly(h).status,1);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  assert.deepEqual(stuckOf(h.report(),p),[['expired',0,'unknown-readback-required',READBACK,['wallet-anchor']]],'persisted expiry keeps it');
  // Later attempts that do not read the CREATE back leave it open.
  for(const after of [[['agreement','waiting']],[['agreement','rejected','agreement-rejected']],[['commitment','verified']]]){
    h=fixture(t);p=intended(h,after);
    assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['wallet-anchor']],JSON.stringify(after));
  }
  // Withdrawn before issue, or read back anchored: nothing to read back.
  for(const after of [[['protocol_wallet_anchor_not_issued']],[['agreement','indeterminate'],['agreement','anchored','agreement-anchored']]]){
    h=fixture(t);p=intended(h,after);
    const r=h.report();assert.equal(r.healthy,true,JSON.stringify(after));assert.deepEqual(r.stuck,[]);assert.equal(dbOnly(h).status,0);
  }
  // A withdrawal resolves only the intent, not an earlier unknown Agreement write, even once
  // that write has left the stored ten attempts and only the event log holds it.
  h=fixture(t);p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:start});h.clock.now=start+60000;
  noted(h,p,'agreement','indeterminate');for(let i=0;i<10;i++)noted(h,p,'agreement','waiting');
  walletIntent(h,p);walletIntent(h,p,'protocol_wallet_anchor_not_issued');h.clock.now=NOW;
  assert.equal(h.ops.get(p.accountId,p.id).state.protocol.attempts.some(a=>a.outcome==='indeterminate'),false);
  assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['agreement']]);
});

test('provider-status: an Agreement context counts as not written only by its recorded mark, never by its reason text',t=>{
  // A provider can choose its reason text, so text that claims no write is a possible write.
  for(const [reason,extra] of [[NO_PROVIDER,{}],['CONTEXT_NOT_WRITTEN: provider-controlled after-write claim',{}],['CONTEXT_PROVIDER_UNAVAILABLE: TEST',{}],
    ['CONTEXT_NOT_WRITTEN: TEST',{written:'false'}],['CONTEXT_NOT_WRITTEN: TEST',{written:0}],['CONTEXT_NOT_WRITTEN: TEST',{written:null}]]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
    h.clock.now=NOW-30000;noted(h,p,'agreement-context','indeterminate',{reason,extra});h.clock.now=NOW;
    const r=h.report({operatorState:null}),label=JSON.stringify([reason,extra]);
    assert.equal(r.healthy,false,label);assert.deepEqual(r.stuck.map(s=>[s.purchaseId,s.outcome]),[[p.id,'seller-journal-not-read']],label);
    assert.equal(dbOnly(h).status,1,label);
  }
  // The mark is honoured only on the event log and stored attempt that note() writes together.
  for(const outcome of ['absent','rejected','indeterminate']){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
    h.clock.now=NOW-30000;noted(h,p,'agreement-context',outcome,{reason:'TEST any text',extra:NOT_WRITTEN});h.clock.now=NOW;
    const r=h.report({operatorState:null});assert.equal(r.healthy,true,outcome);assert.deepEqual(r.stuck,[],outcome);
  }
  // The mark never downgrades any other step's write.
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-anchored',at:NOW-60000});
  h.clock.now=NOW-30000;noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE,extra:NOT_WRITTEN});h.clock.now=NOW;
  assert.deepEqual(stuckOf(h.report({operatorState:null}),p).map(s=>s.at(-1)),[['commit-request']]);
});

test('provider-status: every protocol event saved outside note() is a replayed write intent or listed here as no write',()=>{
  const source=readFileSync(resolve('src/dacs/protocol-purchases.mjs'),'utf8');
  const events=new Set([...source.matchAll(/event: '(protocol_[a-z_]+)'/g)].map(m=>m[1]));
  // Not writes of their own: local state, a planned or signed message the buyer has not sent,
  // or a payment the purchase status already holds readback-only (payment_handoff onward).
  const NOT_WRITES=['protocol_identity_requested','protocol_seller_session_requested','protocol_seller_session_delegated','protocol_agreement_planned',
    'protocol_agreement_signed','protocol_agreement_public_projection_retained','protocol_transfer_observed','protocol_native_transfer_observed','protocol_native_wallet_guard_issued','protocol_step',
    // the source change: signed CREATE bytes kept after they authenticated on chain, and the operator-action hold (local state only).
    'protocol_chain_pointer_kept','protocol_chain_readback_held'];
  assert.deepEqual([...events].filter(e=>!NOT_WRITES.includes(e)).sort(),Object.keys(health.INTENT_EFFECTS).sort());
  // Integration on main 25977d1: health holds the same list, to replay a not-saved check of any of these events.
  assert.deepEqual([...health.NO_WRITE_EVENTS].sort(),[...NOT_WRITES].sort());
});

// Integration on main 25977d1. the source change saves protocol state with a revision CAS: a check
// that read an older revision saves nothing and save() logs it as protocol_check_not_saved,
// with the event it would have saved under data.event beside that event's own data.
// It also writes the buyer copy once, after saving the counter-signature
// (protocol_buyer_copy_intent), and saves the copy reference only from an authenticated readback.
const notSaved=(h,p,event,data={})=>{
  const protocol=h.ops.get(p.accountId,p.id).state.protocol;
  h.ops.record(p.id,'protocol_check_not_saved',{...data,event,stage:data.stage??protocol.stage,revision:0,savedRevision:1,savedStage:protocol.stage});
};
const buyerCopyIntent=(h,p)=>{
  const current=h.ops.get(p.accountId,p.id),protocol=current.state.protocol;
  return h.ops.transition(p.id,current.status,current.status,{state:{protocol:{...protocol,bundle:{...protocol.bundle,buyerSignature:'TEST-countersignature'}}},
    event:'protocol_buyer_copy_intent',data:{stage:protocol.stage,logicalAddress:'TEST-buyer-copy-address'}});
};
const countersigning=(h,at=NOW-120000)=>{const p=h.create({status:'settled_verified',stage:'awaiting-countersignature',protocol:true,at});h.clock.now=at+30000;return p;};
const READ_BACK={bundle:{buyerSignature:'TEST-countersignature',buyerCopyReadBack:true}};

test('integration: every event protocol-purchases.mjs logs outside save() is replayed, and no other module records a protocol event health does not know',()=>{
  const source=readFileSync(resolve('src/dacs/protocol-purchases.mjs'),'utf8');
  const logged=[...source.matchAll(/\bops\.(?:record|appendEvent)\(\s*[\w.]+\s*,\s*(`[^`]*`|'[^']*')/g)].map(m=>m[1]);
  assert.equal(logged.length,source.match(/\bops\.(?:record|appendEvent)\(/g).length,'every logged event names its type');
  assert.deepEqual(logged.sort(),["'protocol_check_not_saved'",'`protocol_${step}`'],'only not-saved checks and lost attempts are logged outside save()');
  assert.equal(health.NOT_SAVED_EVENT,'protocol_check_not_saved');
  // The not-saved event carries the original event's data and its name under data.event.
  assert.match(source,/ops\.appendEvent\(operation\.id, 'protocol_check_not_saved', \{ \.\.\.data, event, stage: own\.stage, /);
  // Other modules: the delivery deadline watch's local observation carries no outcome or stage.
  const recorded=new Set();
  for(const file of readdirSync('src',{recursive:true}).filter(f=>f.endsWith('.mjs')).map(f=>join('src',f))){
    if(file===join('src','dacs','protocol-purchases.mjs')||file.startsWith(join('src','ops')))continue;
    const text=readFileSync(file,'utf8');
    for(const m of text.matchAll(/event:\s*'(protocol_[a-z_-]+)'|\b(?:record|appendEvent)\([^,()]+,\s*['`](protocol_[^'`]*)['`]/g))recorded.add(m[1]??m[2]);
  }
  assert.deepEqual([...recorded],['protocol_delivery_deadline_overdue']);
});

test('integration: a buyer copy written once stays unresolved until its authenticated readback',t=>{
  // The process stopped after the intent, or the write's answer was lost, or the readback is not there yet.
  for(const after of [[],[['buyer-copy','unavailable']],[['buyer-copy','absent']],[['buyer-copy','unavailable'],['buyer-copy','absent']],
    [['buyer-copy','rejected','bundle-rejected']],[['seller-copy','verified']]]){
    const h=fixture(t),p=countersigning(h);buyerCopyIntent(h,p);
    for(const [step,outcome,stage] of after)noted(h,p,step,outcome,{stage});
    h.clock.now=NOW;
    const r=h.report(),label=JSON.stringify(after);
    assert.equal(r.healthy,false,label);assert.deepEqual(stuckOf(r,p).map(s=>[s[1],s[2],s[3],s[4]]),[[0,'unknown-readback-required',READBACK,['buyer-copy']]],label);
    assert.equal(dbOnly(h).status,1,label);
  }
  // An authenticated readback resolves it.
  const h=fixture(t),p=countersigning(h);buyerCopyIntent(h,p);noted(h,p,'buyer-copy','absent');noted(h,p,'buyer-copy','anchored',{patch:READ_BACK});h.clock.now=NOW;
  let r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);assert.equal(dbOnly(h).status,0);
  // A later failed readback on another check does not reopen a read-back copy's write; a lost seller countersign answer is its own write.
  h.clock.now=NOW-1000;noted(h,p,'seller-copy','unavailable');h.clock.now=NOW;
  assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['seller-copy']]);
  // Older code saved the copy reference from the write acknowledgement; protocol-purchases still shows a completed
  // or counter-signing purchase resting on one as awaiting the readback, so it is unresolved too.
  for(const stage of ['completed','awaiting-countersignature']){
    const e=fixture(t),q=countersigning(e);
    noted(e,q,'buyer-copy','anchored',{stage,patch:{bundle:{buyerSignature:'TEST-countersignature',buyerCopyRef:{anchor:{kind:'storage-program',locator:'TEST'}}}}});e.clock.now=NOW;
    assert.deepEqual(stuckOf(e.report(),q).map(s=>[s[0],s.at(-1)]),[[stage,['buyer-copy']]],stage);
    e.clock.now=NOW-1000;noted(e,q,'buyer-copy','anchored',{patch:READ_BACK});e.clock.now=NOW;
    assert.equal(e.report().healthy,true,stage);
  }
  // an earlier review: a legacy bundle rejected after an acknowledged copy is never re-checked by protocol-purchases, and the
  // acknowledgement is not a readback, so its buyer copy write stays unresolved at bundle-rejected (it was reported healthy).
  const e=fixture(t),q=countersigning(e);
  noted(e,q,'buyer-copy','anchored',{patch:{bundle:{buyerSignature:'TEST-countersignature'}}});noted(e,q,'seller-copy','rejected',{stage:'bundle-rejected'});e.clock.now=NOW;
  assert.deepEqual(stuckOf(e.report(),q),[['bundle-rejected',0,'unknown-readback-required',READBACK,['buyer-copy']]]);assert.equal(dbOnly(e).status,1);
  // A copy read back before the seller copy was rejected raises nothing.
  const g=fixture(t),s=countersigning(g);
  buyerCopyIntent(g,s);noted(g,s,'buyer-copy','anchored',{patch:READ_BACK});noted(g,s,'seller-copy','rejected',{stage:'bundle-rejected'});g.clock.now=NOW;
  r=g.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);
});

test('integration: a check that lost to newer saved progress can add a write but never settles one, and never moves the timeline',t=>{
  const fresh=(h,stage='agreement-anchored')=>{const p=h.create({protocol:true,status:'agreement_pending',stage,at:NOW-60000});h.clock.now=NOW-30000;return p;};
  // A possibly-issued write in a not-saved check alerts, and the check's own stage never enters the timeline.
  let h=fixture(t),p=fresh(h);
  notSaved(h,p,'protocol_commit-request',{outcome:'unavailable',reason:UNAVAILABLE});h.clock.now=NOW;
  let r=h.report();
  assert.deepEqual(stuckOf(r,p),[['agreement-anchored',0,'unknown-readback-required',READBACK,['commit-request']]]);
  assert.equal(r.purchases[0].timeline.some(e=>e.stage==='committed'),false,'the not-saved stage is not in the timeline');
  assert.equal(dbOnly(h).status,1);
  // A saved verified readback resolves it; a not-saved one does not resolve a saved write.
  h.clock.now=NOW-1000;noted(h,p,'commitment','verified',{stage:'committed',toStatus:'awaiting_approval'});h.clock.now=NOW;
  assert.equal(h.report().healthy,true);
  // an earlier review: a check is not saved because another saved first, so its write is logged after that check's saved
  // readback, which is never recorded again. A saved resolving readback of the same step settles it in either order,
  // not-saved or lost (logged with no stage). Nothing else does: another step's readback, or none.
  for(const [readback,write,lost,writes] of [[['commitment','verified',{stage:'committed',toStatus:'awaiting_approval'}],'commit-request',false,[]],
    [['commitment','verified',{stage:'committed',toStatus:'awaiting_approval'}],'commit-request',true,[]],
    [['payment-evidence','verified',{stage:'payment-evidenced'}],'claim',false,[]],[['delivery','verified',{stage:'delivery-ready'}],'native-evidence',false,[]],
    [['payment-evidence','verified',{stage:'payment-evidenced'}],'commit-request',false,['commit-request']],[null,'claim',true,['claim']]]){
    h=fixture(t);p=fresh(h);
    if(readback)noted(h,p,readback[0],readback[1],readback[2]);
    const outcome=write==='native-evidence'?'held':'unavailable';
    if(lost)h.ops.record(p.id,`protocol_${write}`,{outcome,reason:UNAVAILABLE});else notSaved(h,p,`protocol_${write}`,{outcome,reason:UNAVAILABLE});
    h.clock.now=NOW;
    const label=JSON.stringify([readback?.slice(0,2),write,lost]);
    assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),writes.length?[writes]:[],label);
  }
  // A saved write after the readback is not settled by it.
  h=fixture(t);p=fresh(h);noted(h,p,'commitment','verified',{stage:'committed',toStatus:'awaiting_approval'});noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE});h.clock.now=NOW;
  assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['commit-request']]);
  // The write is held by the event log only (logged as note() does when the purchase changed mid-call),
  // so the stored attempts cannot keep it open in its place.
  h=fixture(t);p=fresh(h);h.ops.record(p.id,'protocol_commit-request',{outcome:'unavailable',reason:UNAVAILABLE});notSaved(h,p,'protocol_commitment',{outcome:'verified',stage:'committed'});h.clock.now=NOW;
  r=h.report();assert.deepEqual(stuckOf(r,p).map(s=>s.at(-1)),[['commit-request']]);
  assert.equal(r.purchases[0].stage,'agreement-anchored');assert.equal(r.purchases[0].timeline.some(e=>e.stage==='committed'),false);
  // A not-saved Agreement-context answer may follow a seller Vet write, unless no provider was invoked.
  h=fixture(t);p=fresh(h,'identity');notSaved(h,p,'protocol_agreement-context',{outcome:'indeterminate',reason:'TEST Vet publish answer lost'});h.clock.now=NOW;
  assert.deepEqual(h.report({operatorState:null}).stuck.map(s=>[s.purchaseId,s.outcome]),[[p.id,'seller-journal-not-read']]);
  h=fixture(t);p=fresh(h,'identity');notSaved(h,p,'protocol_agreement-context',{outcome:'indeterminate',reason:NO_PROVIDER,...NOT_WRITTEN});h.clock.now=NOW;
  assert.equal(h.report({operatorState:null}).healthy,true);
  // A not-saved intent or other event sent nothing: save() throws before the write that follows an intent.
  for(const event of [...Object.keys(health.INTENT_EFFECTS),...health.NO_WRITE_EVENTS]){
    h=fixture(t);p=fresh(h);notSaved(h,p,event);h.clock.now=NOW;
    r=h.report();assert.equal(r.healthy,true,event);assert.deepEqual(r.stuck,[],event);
  }
  // A not-saved check health cannot classify fails closed.
  for(const data of [{event:'protocol_future_event'},{event:'protocol_commit-request'},{event:'protocol_commit-request',outcome:'indeterminate'},{event:'protocol_future-step',outcome:'verified'},{outcome:'verified'},{event:7}]){
    h=fixture(t);p=fresh(h);h.ops.record(p.id,'protocol_check_not_saved',data);
    assert.throws(()=>h.report(),/could not read valid state/,JSON.stringify(data));assert.equal(dbOnly(h).status,2,JSON.stringify(data));
  }
});

for(const source of ['events','stored','both'])test(`later cause-free attempt clears health cause (${source})`,t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing'});
  const attempts=[{step:'agreement',outcome:'indeterminate',causeCode:'tls'},{step:'agreement',outcome:'waiting'}];
  if(source!=='stored')for(const attempt of attempts)h.ops.record(p.id,'protocol_agreement',{...attempt,stage:'agreement-signing'});
  if(source!=='events')h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing',attempts}},event:'protocol_step',data:{stage:'agreement-signing'}});
  const row=h.report().purchases[0];
  assert.equal(Object.hasOwn(row,'causeCode'),false);
  assert.deepEqual(row.unresolvedWrites,['agreement'],'clearing a cause does not resolve an unknown write');
});

for(const source of ['events','stored','both'])test(`not-sent attempt preserves earlier unknown writes (${source})`,t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing'});
  const attempts=[{step:'agreement',outcome:'indeterminate',causeCode:'network'},{step:'agreement',outcome:'indeterminate',causeCode:'tls',dispatched:false}];
  if(source!=='stored')for(const attempt of attempts)h.ops.record(p.id,'protocol_agreement',{...attempt,stage:'agreement-signing'});
  if(source!=='events')h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing',attempts}},event:'protocol_step',data:{stage:'agreement-signing'}});
  const row=h.report().purchases[0];
  assert.equal(row.outcome,'unknown-readback-required');assert.deepEqual(row.unresolvedWrites,['agreement']);assert.equal(row.causeCode,'tls');
});

// DACS_BUYER_CHAIN_READBACK=on: a final purchase held for the operator
// (chainReadbackHeld) stays operator-action-required, as its stuck entry says,
// when its last attempt was refused locally before dispatch; JSON and text
// still show that attempt as not sent. Without the hold it is not-sent.
for(const held of [true,false])test(`not-sent last attempt on a final purchase (${held?'held for the operator':'not held'})`,t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'settled_verified',stage:'delivered'});
  const attempts=[{step:'bundle-request',outcome:'unavailable',causeCode:'tls',dispatched:false}];
  const hold=held?{chainReadbackHeld:{action:'chain-readback-pointers-missing',since:new Date(NOW).toISOString(),missing:['payment-evidence'],reason:'the seller session key is retired'}}:{};
  for(const attempt of attempts)h.ops.record(p.id,'protocol_bundle-request',{...attempt,stage:'delivered'});
  h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'delivered',attempts,...hold}},event:'protocol_step',data:{stage:'delivered'}});
  const report=h.report(),row=report.purchases[0],outcome=held?'operator-action-required':'not-sent';
  assert.equal(row.outcome,outcome);assert.equal(row.lastAttemptDispatched,false);assert.equal(row.causeCode,'tls');assert.deepEqual(row.unresolvedWrites,[]);
  assert.match(formatOpsHealth(report),new RegExp(`outcome=${outcome} cause=tls last-attempt=not-sent`));
  assert.deepEqual(report.stuck.map(({outcome,thresholdMs})=>({outcome,thresholdMs})),held?[{outcome:'operator-action-required',thresholdMs:0}]:[]);
});
