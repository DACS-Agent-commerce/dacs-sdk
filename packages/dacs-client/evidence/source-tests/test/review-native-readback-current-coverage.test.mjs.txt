// Exact-current coverage for the repaired Node2 native transfer readback
// matcher: devnet-native-transport.mjs executedMatches -> readback() -> durable
// journal transitions, through the admitted Node2 demo transport (operator.mjs
// composition) and the native payment evidence consumer's chain reader.
// Offline only: .invalid fetch stubs, an in-memory or TMPDIR node:sqlite
// journal and one in-process TEST key. No confirm, broadcast, CREATE, payment,
// wallet, TLS, browser or socket is reachable; the stub records and refuses any
// confirmTx/broadcastTx it would receive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observePayDemTransferCore } from '@kynesyslabs/dacs/seller';
import { createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { ENDPOINT, OTHER, admittedTransport, blockZeroAdmission, envelopeAdmission, envelopeChain, layoutAdmission, layoutChain, memoryJournal, offsetTwo, zeroBlock } from './helpers/review-node2-current-coverage-fixture.mjs';
import { AMOUNT, BLOCK_NUMBER, FEE_KEYS, NODE_KEY, NONCE, PAYEE, PAYER, TIMESTAMP, WRONG_MATCHERS, contractAccepts, exactProjection, executeCalls, inclusionAnswers,
  intentKey, issuedRow, laneKey, node2Projection, receiptFor, sdkHeaders, signTransaction, signedContent } from './helpers/review-native-readback-current-fixture.mjs';

const clone=(value)=>structuredClone(value);
const UNSAFE=Number.MAX_SAFE_INTEGER+1;
const STAGES=['broadcast-started','broadcast-answered','broadcast-accepted'];
// The shared fixture's run.bind() binds its own WALLET lane; this pass's lane is PAYER.
const bindPayer=(run)=>run.capability.binding({phase:'bind',address:PAYER});

// One admitted transport with an issued row seeded exactly as rpc() retains it.
async function world(t,{retained=()=>{},node=()=>{},tx,block,status,raw,admission=layoutAdmission,chain=layoutChain,journal=memoryJournal(),stage='broadcast-accepted'}={}){
  const content=signedContent();retained(content);
  const signed=signTransaction(content);
  const nodeContent=node2Projection(signed.content,signed.hash);node(nodeContent,signed);
  const run=admittedTransport(await admission(),{...chain(),...inclusionAnswers(signed.hash,nodeContent,{tx,block,status,raw})},{journal});
  t.after(()=>run.capability.close());
  const binding=(await bindPayer(run)).binding;
  const issued=issuedRow(signed,binding,stage);
  journal.seed(intentKey(signed.hash),issued);journal.seed(laneKey(PAYER),issued);
  const mark=run.stub.calls.length;
  return {run,journal,signed,nodeContent,issued,binding,mark,read:()=>run.capability.binding({phase:'readback',address:PAYER,hash:signed.hash})};
}
async function outcomeOf(w){
  try{const r=await w.read();return r.disposition==='included'?'accept':`other:${r.disposition}`;}
  catch(error){return error.code==='readback_unverified'?'reject':`error:${error.code}`;}
}
async function assertObserved(w){
  const rows=Object.fromEntries(await w.journal.entries());
  assert.deepEqual(w.journal.puts,[intentKey(w.signed.hash),laneKey(PAYER)],'only the exact intent and current lane are marked');
  for(const key of [intentKey(w.signed.hash),laneKey(PAYER)]){
    const row=rows[key];
    assert.equal(row.stage,'observed');assert.equal(row.hash,w.signed.hash);assert.equal(row.nonce,w.signed.content.nonce);
    assert.equal(JSON.stringify(row.signedTransaction),JSON.stringify(w.signed),'original signed bytes and signature retained byte-identical');
    assert.deepEqual(row.receipt,receiptFor(w.signed));
  }
  assert.deepEqual(executeCalls(w.run.stub),[]);
}
async function assertHeld(w,before){
  assert.deepEqual(await w.journal.entries(),before,'issued rows unchanged and still fencing');
  assert.deepEqual(w.journal.puts,[]);
  assert.deepEqual(executeCalls(w.run.stub),[]);
}

// ---------------------------------------------------------------------------
// 1-3. Accepting controls, negative and boundary vectors. `expect` is written
// from the doc; 'either' marks a point the doc leaves open (actual recorded).
const projectOnly=(field)=>(v,s)=>{
  const exact=exactProjection(s.content,s.hash);for(const key of Object.keys(v))delete v[key];Object.assign(v,exact);
  if(field==='nonce'||field==='timestamp')v[field]=String(v[field]);
  else if(field==='amount')v.amount=Number(v.amount);
  else v.transaction_fee[field]=Number(v.transaction_fee[field]);
};
const rawSwap=(from,to)=>(text)=>{assert.ok(text.includes(from));return text.replace(from,to);};
const VECTORS=[
  // accepting controls
  ['A01','documented projection: nonce/timestamp strings, amount + 3 fees numbers, filled txhash carriers','accept',{}],
  ['A02','exact unprojected readback','accept',{node:(v,s)=>{for(const k of Object.keys(v))delete v[k];Object.assign(v,exactProjection(s.content,s.hash));}}],
  ...['nonce','timestamp','amount',...FEE_KEYS].map((field,i)=>[`A0${3+i}`,`only ${field} projected, all else exact`,'accept',{node:projectOnly(field)}]),
  ['A09','txhash carriers left empty by the node','accept',{node:(v)=>{for(const e of v.gcr_edits)e.txhash='';}}],
  ['A10','root and fee key order reversed','either',{node:(v)=>{const r=Object.fromEntries(Object.entries(v).reverse());r.transaction_fee=Object.fromEntries(Object.entries(v.transaction_fee).reverse());for(const k of Object.keys(v))delete v[k];Object.assign(v,r);}}],
  ['A11','wire JSON literal amount 2.5e9 (same JSON number)','accept',{raw:rawSwap('"amount":2500000000','"amount":2.5e9')}],
  ['A12','wire JSON literal amount 2500000000.0 (same JSON number)','accept',{raw:rawSwap('"amount":2500000000','"amount":2500000000.0')}],
  ['A13','boundary: nonce 0 -> "0"','accept',{retained:(c)=>{c.nonce=0;}}],
  ['A14','boundary: amount/additional fee "0" -> 0','accept',{retained:(c)=>{c.amount='0';}}],
  ['A15','boundary: amount MAX_SAFE string -> MAX_SAFE number','accept',{retained:(c)=>{c.amount=String(Number.MAX_SAFE_INTEGER);}}],
  ['A16','boundary: fee MAX_SAFE string -> MAX_SAFE number','accept',{retained:(c)=>{c.transaction_fee.rpc_fee=String(Number.MAX_SAFE_INTEGER);}}],
  ['A17','retained string nonce "7" read back exactly as "7"','accept',{retained:(c)=>{c.nonce='7';}}],
  ['A18','retained numeric amount read back as the same number','accept',{retained:(c)=>{c.amount=2500000000;}}],
  // root nonce / timestamp substitutions
  ...[['07'],['+7'],['-7'],['7.0'],['7e0'],[' 7'],['7 '],['0x7'],[''],['8'],[8],[7.5],[null],[true]].map(([value],i)=>[`N${String(i+1).padStart(2,'0')}`,`nonce ${JSON.stringify(value)}`,'reject',{node:(v)=>{v.nonce=value;}}]),
  ['N15','nonce missing','reject',{node:(v)=>{delete v.nonce;}}],
  ['N16','retained string nonce "7" read back as number 7 (reverse direction)','reject',{retained:(c)=>{c.nonce='7';},node:(v)=>{v.nonce=7;}}],
  ...[`+${TIMESTAMP}`,`0${TIMESTAMP}`,`${TIMESTAMP}.0`,`-${TIMESTAMP}`,String(TIMESTAMP+1),TIMESTAMP+1].map((value,i)=>[`T0${i+1}`,`timestamp ${JSON.stringify(value)}`,'reject',{node:(v)=>{v.timestamp=value;}}]),
  // root amount substitutions
  ...[[2500000001],[2500000000.5],[-2500000000],['02500000000'],['+2500000000'],['2500000000.0'],['2.5e9'],['2500000001'],['0x9502f900'],[true],[null],[[2500000000]],[{value:2500000000}]]
    .map(([value],i)=>[`M${String(i+1).padStart(2,'0')}`,`amount ${JSON.stringify(value)}`,'reject',{node:(v)=>{v.amount=value;}}]),
  ['M14','amount unsafe 2^53 against canonical "9007199254740992"','reject',{retained:(c)=>{c.amount=String(UNSAFE);}}],
  ['M15','wire JSON literal 9007199254740993 against "9007199254740993" (parses unsafe)','reject',{retained:(c)=>{c.amount='9007199254740993';},raw:rawSwap('"amount":9007199254740992','"amount":9007199254740993')}],
  ['M16','non-canonical retained "02500000000" read back as 2500000000','reject',{retained:(c)=>{c.amount='02500000000';}}],
  ['M17','retained numeric amount read back as string (reverse direction)','reject',{retained:(c)=>{c.amount=2500000000;},node:(v)=>{v.amount='2500000000';}}],
  ['M18','wire JSON literal amount -0 against retained "0"','either',{retained:(c)=>{c.amount='0';},raw:rawSwap('"amount":0','"amount":-0')}],
  // three fees
  ...FEE_KEYS.flatMap((key,k)=>[[(v)=>v+1,'+1'],[(v)=>v+0.5,'fractional'],[(v)=>-v-1,'negative'],[()=>UNSAFE,'unsafe'],[(v)=>`0${v}`,'leading-zero string'],[(v)=>`+${v}`,'signed string'],
    [(v)=>`${v}.0`,'decimal string'],[()=>null,'null']].map(([f,name],i)=>[`F${k+1}${i+1}`,`${key} ${name}`,'reject',{node:(v)=>{v.transaction_fee[key]=f(v.transaction_fee[key]);}}])),
  ['F41','wire JSON literal additional_fee -0 against "0"','either',{raw:rawSwap('"additional_fee":0','"additional_fee":-0')}],
  ['F42','fee key missing','reject',{node:(v)=>{delete v.transaction_fee.rpc_fee;}}],
  ['F43','extra fee key','reject',{node:(v)=>{v.transaction_fee.gas_fee=0;}}],
  ['F44','fee recipient filled with a node key','reject',{node:(v)=>{v.transaction_fee.rpc_address=NODE_KEY;}}],
  // nested amount-like fields get no numeric normalization
  ['G01','data native send args amount as number','reject',{node:(v)=>{v.data[1].args[1]=Number(AMOUNT);}}],
  ['G02','data native send args amount "02500000000"','reject',{node:(v)=>{v.data[1].args[1]='02500000000';}}],
  ...[0,1,2].map((i)=>[`G0${3+i}`,`gcr_edits[${i}].amount as number`,'reject',{node:(v)=>{v.gcr_edits[i].amount=Number(v.gcr_edits[i].amount);}}]),
  ['G06','gcr nonce edit amount 1 as "1" (reverse direction)','reject',{node:(v)=>{v.gcr_edits[3].amount='1';}}],
  ['G07','gcr debit amount tampered','reject',{node:(v)=>{v.gcr_edits[0].amount='2500000001';}}],
  ['G08','gcr edit account swapped','reject',{node:(v)=>{v.gcr_edits[1].account=PAYER;}}],
  ['G09','gcr edits reordered','reject',{node:(v)=>{v.gcr_edits.reverse();}}],
  ['G10','gcr edit removed','reject',{node:(v)=>{v.gcr_edits.pop();}}],
  ['G11','gcr edit added','reject',{node:(v)=>{v.gcr_edits.push(clone(v.gcr_edits[2]));}}],
  ['G12','gcr isRollback true','reject',{node:(v)=>{v.gcr_edits[0].isRollback=true;}}],
  ['G13','gcr txhash carrier filled with another hash','reject',{node:(v)=>{v.gcr_edits[0].txhash=OTHER;}}],
  ['G14','gcr txhash carrier 0x-prefixed','reject',{node:(v,s)=>{v.gcr_edits[0].txhash=`0x${s.hash}`;}}],
  ['G15','gcr txhash carrier uppercase','reject',{node:(v,s)=>{v.gcr_edits[0].txhash=s.hash.toUpperCase();}}],
  // payer/payee/type/data/object keys
  ['S01','different payer','reject',{node:(v)=>{v.from=PAYEE;}}],
  ['S02','different payee','reject',{node:(v)=>{v.to=NODE_KEY;}}],
  ['S03','different native type','reject',{node:(v)=>{v.type='identity';}}],
  ['S04','different from_ed25519_address','reject',{node:(v)=>{v.from_ed25519_address=NODE_KEY;}}],
  ['S05','data nativeOperation changed','reject',{node:(v)=>{v.data[1].nativeOperation='pay';}}],
  ['S06','data payee arg changed','reject',{node:(v)=>{v.data[1].args[0]=NODE_KEY;}}],
  ['S07','extra root key','reject',{node:(v)=>{v.executionHint='accepted';}}],
  ['S08','extra custom_charges:null','reject',{node:(v)=>{v.custom_charges=null;}}],
  ['S09','missing root key from_ed25519_address','reject',{node:(v)=>{delete v.from_ed25519_address;}}],
  ['S10','extra nested data key','reject',{node:(v)=>{v.data[1].amount=Number(AMOUNT);}}],
  // retained hash / status / ordered block membership
  ['H01','tx hash different','reject',{tx:(x)=>{x.hash=OTHER;}}],
  ['H02','tx hash 0x-prefixed','reject',{tx:(x)=>{x.hash=`0x${x.hash}`;}}],
  ['H03','tx hash uppercase','reject',{tx:(x)=>{x.hash=x.hash.toUpperCase();}}],
  ['H04','tx status included','reject',{tx:(x)=>{x.status='included';}}],
  ['H05','tx status finalized','reject',{tx:(x)=>{x.status='finalized';}}],
  ['H06','tx blockNumber 11','reject',{tx:(x)=>{x.blockNumber=11;}}],
  ['H07','tx blockNumber "10"','reject',{tx:(x)=>{x.blockNumber='10';}}],
  ['H08','block number 11','reject',{block:(b)=>{b.number=11;}}],
  ['H09','block status pending','reject',{block:(b)=>{b.status='pending';}}],
  ['H10','block membership empty','reject',{block:(b)=>{b.content.ordered_transactions=[];}}],
  ['H11','block membership other hash only','reject',{block:(b)=>{b.content.ordered_transactions=[OTHER];}}],
  ['H12','block membership 0x-prefixed hash','reject',{block:(b)=>{b.content.ordered_transactions=b.content.ordered_transactions.map((h)=>`0x${h}`);}}],
  ['H13','block membership uppercase hash','reject',{block:(b)=>{b.content.ordered_transactions=b.content.ordered_transactions.map((h)=>h.toUpperCase());}}],
  ['H14','block content missing','reject',{block:(b)=>{delete b.content;}}],
  ['H15','retained hash second in ordered membership','accept',{block:(b)=>{b.content.ordered_transactions.unshift(OTHER);}}],
  ['H16','status pending: no inclusion claimed','other:pending',{status:{state:'pending'}}],
  ['H17','status included with string blockNumber','other:pending',{status:{state:'included',blockNumber:'10'}}],
];
const CONTENT_VECTOR=(options)=>!options.tx&&!options.block&&!options.status;
const byId=Object.fromEntries(VECTORS.map(([id,,,options])=>[id,options]));

for(const [id,name,expect,options] of VECTORS)test(`${id} ${name}: expected ${expect}`,async t=>{
  const w=await world(t,options);
  const before=await w.journal.entries();
  const outcome=await outcomeOf(w);
  // The oracle sees the content the node actually returned (wire literals parsed).
  const seen=options.raw?JSON.parse(options.raw(JSON.stringify({response:{content:w.nodeContent}}))).response.content:w.nodeContent;
  const oracle=CONTENT_VECTOR(options)?(contractAccepts(w.signed.content,seen,w.signed.hash)?'accept':'reject'):null;
  t.diagnostic(JSON.stringify({id,expect,actual:outcome,oracle}));
  if(expect!=='either')assert.equal(outcome,expect);
  else assert.ok(['accept','reject'].includes(outcome),outcome);
  if(oracle!==null&&expect!=='either')assert.equal(oracle,expect,'independent oracle agrees with the documented expectation');
  if(outcome==='accept')await assertObserved(w);else await assertHeld(w,before);
  // Readback never re-binds through confirm/broadcast; its only node reads are inclusion reads.
  assert.ok(w.run.stub.messages(w.mark).every((m)=>['getBlockByNumber','getTransactionStatus','getTxByHash'].includes(m)),JSON.stringify(w.run.stub.messages(w.mark)));
});

test('A01 accepted readback returns the exact receipt with the original string amount and reads status, tx and block once',async t=>{
  const w=await world(t);
  assert.deepEqual(await w.read(),{disposition:'included',receipt:receiptFor(w.signed),noResend:true});
  await assertObserved(w);
  const replay=await w.read();
  assert.equal(replay.receipt.amount,AMOUNT,'replayed receipt keeps the original OS string, not the node number');
  assert.equal(w.journal.puts.length,4,'replay rewrites only the same two rows');
  const tail=w.run.stub.calls.slice(w.mark).filter((c)=>c.message!=='getBlockByNumber'||c.blockNumber===BLOCK_NUMBER).map((c)=>c.message);
  assert.deepEqual(tail,['getTransactionStatus','getTxByHash','getBlockByNumber','getTransactionStatus','getTxByHash','getBlockByNumber']);
  assert.deepEqual(executeCalls(w.run.stub),[]);
});

// ---------------------------------------------------------------------------
// 4. Restart / replay / issued-unknown / no-resend.
for(const stage of STAGES)test(`L1 ${stage}: signature refused before any fence, mismatch held, documented projection releases once, resend still refused`,async t=>{
  const w=await world(t,{stage,node:(v)=>{v.transaction_fee.rpc_fee+=1;}});
  await assert.rejects(w.run.capability.binding({phase:'signature',address:PAYER,binding:w.binding}),{code:'outcome_unknown'});
  assert.deepEqual((await bindPayer(w.run)).pending,{hash:w.signed.hash,nonce:NONCE,stage});
  const before=await w.journal.entries();
  await assert.rejects(w.read(),{code:'readback_unverified'});
  await assertHeld(w,before);
  w.run.stub.set(inclusionAnswers(w.signed.hash,node2Projection(w.signed.content,w.signed.hash)));
  assert.equal((await w.read()).disposition,'included');
  await assertObserved(w);
  assert.equal((await bindPayer(w.run)).pending,null);
  // The observed lane admits a NEW signature lease, but the same signed hash is readback-only.
  const lease=await w.run.capability.binding({phase:'signature',address:PAYER,binding:w.binding});
  await assert.rejects(w.run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:clone(w.signed)}]},sdkHeaders()),{code:'outcome_unknown'});
  await assert.rejects(w.run.capability.rpc({method:'execute',params:[{extra:'broadcastTx',data:{response:{data:{transaction:clone(w.signed)}}}}]},sdkHeaders()),{code:'native_confirmation_required'});
  await w.run.capability.binding({phase:'release',address:PAYER,leaseId:lease.leaseId});
  assert.deepEqual(executeCalls(w.run.stub),[]);
  const intents=(await w.journal.entries()).filter(([key,value])=>key===intentKey(value?.hash)&&value?.signedTransaction);
  assert.equal(intents.length,1,'exactly one retained signed transaction');
});

test('L2 durable node:sqlite journal: held mismatch survives restart, pending replay, release after restart, observed survives second restart; zero confirm/broadcast',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'review-native-readback-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'node2-transport.sqlite');
  const content=signedContent(),signed=signTransaction(content);
  const projected=node2Projection(signed.content,signed.hash);
  const wrong=clone(projected);wrong.gcr_edits[2].amount=Number(wrong.gcr_edits[2].amount);
  const execute=[];
  const open=async(mode,journalId,answers)=>{
    const journal=openDurableWalletJournal({path,mode,...(journalId?{expectedJournalId:journalId}:{})});
    const run=admittedTransport(await layoutAdmission(),{...layoutChain(),...answers},{journal});
    return {journal,run,close:async()=>{execute.push(...executeCalls(run.stub));await run.capability.close();journal.close();},
      read:()=>run.capability.binding({phase:'readback',address:PAYER,hash:signed.hash})};
  };
  // Process 1: issue rows exactly as rpc() retains them, then a mismatching readback.
  const p1=await open('create',null,inclusionAnswers(signed.hash,wrong));
  const binding=(await bindPayer(p1.run)).binding;
  const issued=issuedRow(signed,binding,'broadcast-accepted');
  await p1.journal.put(laneKey(PAYER),issued);await p1.journal.put(intentKey(signed.hash),issued);
  const journalId=p1.journal.journalId,heldRows=await p1.journal.entries();
  await assert.rejects(p1.read(),{code:'readback_unverified'});
  assert.deepEqual(await p1.journal.entries(),heldRows);
  await p1.close();
  // Process 2: restart; the same mismatch is still held, a pending status changes nothing.
  const p2=await open('open',journalId,inclusionAnswers(signed.hash,wrong));
  assert.deepEqual(await p2.journal.entries(),heldRows,'issued rows survive restart byte-identically');
  assert.deepEqual((await bindPayer(p2.run)).pending,{hash:signed.hash,nonce:NONCE,stage:'broadcast-accepted'});
  await assert.rejects(p2.run.capability.binding({phase:'signature',address:PAYER,binding}),{code:'outcome_unknown'});
  await assert.rejects(p2.read(),{code:'readback_unverified'});
  p2.run.stub.set(inclusionAnswers(signed.hash,projected,{status:{state:'pending'}}));
  assert.deepEqual(await p2.read(),{disposition:'pending',hash:signed.hash,nonce:NONCE,noResend:true});
  assert.deepEqual(await p2.journal.entries(),heldRows);
  p2.run.stub.set(inclusionAnswers(signed.hash,projected));
  assert.deepEqual(await p2.read(),{disposition:'included',receipt:receiptFor(signed),noResend:true});
  const observedRows=await p2.journal.entries();
  assert.deepEqual(observedRows.map(([key,value])=>[key,value.stage]),[[laneKey(PAYER),'observed'],[intentKey(signed.hash),'observed']]);
  await p2.close();
  // Process 3: observed state survives; replayed readback is idempotent; resend refused.
  const p3=await open('open',journalId,inclusionAnswers(signed.hash,projected));
  assert.deepEqual(await p3.journal.entries(),observedRows);
  assert.equal((await bindPayer(p3.run)).pending,null);
  assert.equal((await p3.read()).disposition,'included');
  for(const [,row] of await p3.journal.entries())assert.equal(JSON.stringify(row.signedTransaction),JSON.stringify(signed));
  const lease=await p3.run.capability.binding({phase:'signature',address:PAYER,binding});
  await assert.rejects(p3.run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:clone(signed)}]},sdkHeaders()),{code:'outcome_unknown'});
  await p3.run.capability.binding({phase:'release',address:PAYER,leaseId:lease.leaseId});
  assert.equal((await p3.journal.entries()).filter(([key])=>key.startsWith('devnet/native-transfer/')).length,1);
  await p3.close();
  assert.deepEqual(execute,[],'no confirmTx or broadcastTx reached the stub in any process');
});

test('L3 unknown hash or wrong writer is refused before any inclusion read; concurrent duplicate readbacks serialize on the lane',async t=>{
  const w=await world(t);
  await assert.rejects(w.run.capability.binding({phase:'readback',address:PAYER,hash:OTHER}),{code:'not_issued'});
  await assert.rejects(w.run.capability.binding({phase:'readback',address:PAYEE,hash:w.signed.hash}),{code:'not_issued'});
  assert.deepEqual(w.run.stub.messages(w.mark),[]);
  const [a,b]=await Promise.all([w.read(),w.read()]);
  assert.deepEqual(a,b);assert.equal(a.disposition,'included');
  assert.equal(w.journal.puts.length,4);assert.deepEqual(executeCalls(w.run.stub),[]);
});

// ---------------------------------------------------------------------------
// 5. Consumers and adjacent binding checks.
async function consumerWorld(t,options={}){
  const w=await world(t,options);
  const consumer=createNativePaymentEvidenceConsumer({rpcUrl:ENDPOINT,sourceCapability:w.run.capability});
  const sdkAlone=await observePayDemTransferCore(w.signed.hash,{
    getTransactionStatus:async()=>({result:200,response:options.status??{state:'included',blockNumber:BLOCK_NUMBER}}),
    getTxByHash:async()=>clone(inclusionAnswers(w.signed.hash,w.nodeContent,options).getTxByHash),
    getBlockByNumber:async()=>clone(inclusionAnswers(w.signed.hash,w.nodeContent,options)[BLOCK_NUMBER])});
  return {...w,consumer,sdkAlone};
}

test('D1 native payment evidence consumer: SDK pay-DEM observation then retained-intent readback accepts the documented projection',async t=>{
  const w=await consumerWorld(t);
  const observed=await w.consumer.observeDemosTransfer(w.signed.hash);
  assert.equal(observed.status,'included');assert.equal(observed.txHash,w.signed.hash);assert.equal(observed.amountOs,AMOUNT);assert.equal(observed.blockNumber,BLOCK_NUMBER);
  await assertObserved(w);
});

for(const [id,name,options] of [
  ['D2','data args amount as number: SDK alone reads legacy DEM units',byId.G01],
  ['D3','block membership 0x/uppercase: SDK alone canonicalizes it',{block:(b)=>{b.content.ordered_transactions=b.content.ordered_transactions.map((h)=>`0x${h.toUpperCase()}`);}}],
  ['D4','tx status finalized: SDK alone accepts the label',byId.H05],
  ['D5','wrong network fee: SDK alone does not read fees',byId.F11],
  ['D6','gcr amount as number: SDK alone does not read GCR edits',byId.G03],
  ['D7','fee recipient filled: SDK alone does not read it',byId.F44],
])test(`${id} consumer holds where the SDK observer alone says included (${name})`,async t=>{
  const w=await consumerWorld(t,options);
  assert.equal(w.sdkAlone.status,'included',JSON.stringify(w.sdkAlone));
  if(id==='D2')assert.equal(w.sdkAlone.amountOs,'2500000000000000000','SDK alone would accept a 1e9x amount; only the retained-bytes matcher prevents it');
  const before=await w.journal.entries();
  await assert.rejects(w.consumer.observeDemosTransfer(w.signed.hash),{code:'readback_unverified'});
  await assertHeld(w,before);
});

for(const [name,admission,chain] of [['block-zero (v1)',blockZeroAdmission,()=>({0:zeroBlock()})],['four-field envelope',envelopeAdmission,envelopeChain],['layout',layoutAdmission,layoutChain]])
  test(`B1 ${name} admission: documented projection is released through the same readback`,async t=>{
    const w=await world(t,{admission,chain});
    assert.equal(await outcomeOf(w),'accept');await assertObserved(w);
  });

test('B2 changed reviewed block-two hash at readback holds before any transaction read',async t=>{
  const w=await world(t);
  w.run.stub.set({2:offsetTwo({hash:OTHER})});
  const before=await w.journal.entries();
  const outcome=await outcomeOf(w);
  t.diagnostic(JSON.stringify({outcome}));
  assert.notEqual(outcome,'accept');
  assert.deepEqual(w.run.stub.messages(w.mark).filter((m)=>m!=='getBlockByNumber'),[]);
  await assertHeld(w,before);
});

test('B3 issued row bound to another chain identity is not recovered or released',async t=>{
  const w=await world(t);
  const tampered={...w.issued,networkBinding:{...w.issued.networkBinding,chainIdentity:OTHER}};
  w.journal.seed(intentKey(w.signed.hash),tampered);w.journal.seed(laneKey(PAYER),tampered);
  const before=await w.journal.entries();
  const outcome=await outcomeOf(w);
  t.diagnostic(JSON.stringify({outcome}));
  assert.notEqual(outcome,'accept');
  assert.deepEqual(w.run.stub.messages(w.mark).filter((m)=>m!=='getBlockByNumber'),[]);
  await assertHeld(w,before);
});

// ---------------------------------------------------------------------------
// 6. Wrong-implementation witnesses: each model accepts A01 (credible), admits
// its listed vectors, and the actual readback entry point holds those vectors.
const WITNESSES={
  broadRecursiveCoercion:['N01','N02','N04','M04','M06','G01','G03','G06','F15'],
  ignoresFeeAndGcr:['F11','F21','F31','F44','G07','G08','G13'],
  pathInsensitiveKeys:['G03','G04','G05'],
  numberCoercedCounters:['N01','N02','N04','N05','N06','N08','T01','T02','T03'],
};
for(const [model,ids] of Object.entries(WITNESSES))test(`W ${model}: model admits ${ids.join(',')} that the actual readback holds`,async t=>{
  const wrong=WRONG_MATCHERS[model];
  const control=await world(t);
  assert.equal(wrong(control.signed.content,control.nodeContent,control.signed.hash),true,'model accepts the documented projection');
  for(const id of ids){
    const w=await world(t,byId[id]);
    assert.equal(wrong(w.signed.content,w.nodeContent,w.signed.hash),true,`${model} admits ${id}`);
    assert.equal(contractAccepts(w.signed.content,w.nodeContent,w.signed.hash),false,`oracle rejects ${id}`);
    const before=await w.journal.entries();
    assert.equal(await outcomeOf(w),'reject',`actual readback holds ${id}`);
    await assertHeld(w,before);
  }
});

test('txhash projection is rejected outside the documented gcr_edits index carrier path',async t=>{
  const cases=[
    ['data container',(c)=>{c.data[1].txhash='';},(v,s)=>{v.data[1].txhash=s.hash;}],
    ['root container',(c)=>{c.txhash='';},(v,s)=>{v.txhash=s.hash;}],
    ['fee container',(c)=>{c.transaction_fee.txhash='';},(v,s)=>{v.transaction_fee.txhash=s.hash;}],
    ['nested below a valid GCR index',(c)=>{c.gcr_edits[0].metadata={txhash:''};},(v,s)=>{v.gcr_edits[0].metadata.txhash=s.hash;}],
  ];
  for(const [name,retained,node] of cases){
    const w=await world(t,{retained,node});
    const before=await w.journal.entries();
    assert.equal(contractAccepts(w.signed.content,w.nodeContent,w.signed.hash),false,`${name}: independent path-scoped oracle rejects`);
    assert.equal(await outcomeOf(w),'reject',name);
    await assertHeld(w,before);
  }
});
