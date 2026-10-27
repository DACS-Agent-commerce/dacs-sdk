import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { contentHash } from '@kynesyslabs/dacs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createDevnetNativeTransport } from '../../src/wallet/devnet-native-transport.mjs';
import { createDemosChainReader } from '../../src/dacs/chain.mjs';
import { createExactBuyerApproval } from '../../src/devnet-demo/operator-buyer-approval.mjs';
import { createNativeDemDeliveryCapability } from '../../src/dacs/native-dem-delivery-consumer.mjs';
import { readDemDeliveryReady } from '../../src/dacs/dem-delivery-consumer.mjs';
import { protocolView } from '../../src/dacs/protocol-purchases.mjs';
import { evidenceStatus } from './showcase-safety-status.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');
const copy=(value)=>structuredClone(value);
export const pins=Object.freeze({network:'demos-devnet',chainIdentity:'c'.repeat(64),pinVersion:'TEST-showcase-v1',endpoint:'https://127.0.0.1:1/',transportAuthority:'TEST-showcase-callbacks'});
// The SDK's equivalent read-only checks in filesystem/privateStore are private;
// its public async helper creates directories. Keep this fixture check read-only.
function safeDirectory(path) {
  if(typeof process.getuid!=='function')throw new Error('showcase temporary paths require POSIX ownership checks');
  const uid=process.getuid();
  let leaf;
  for(let component=resolve(path);;component=dirname(component)){
    const info=lstatSync(component);
    if(info.isSymbolicLink())throw new Error(`showcase temporary path contains a symbolic link: ${component}`);
    if(!info.isDirectory())throw new Error(`showcase temporary path is not a directory: ${component}`);
    if(info.uid!==uid&&info.uid!==0)throw new Error(`showcase temporary path has an unsafe owner: ${component}`);
    if((info.mode&0o022)!==0&&(info.mode&0o1000)===0)throw new Error(`showcase temporary path is group/world writable without the sticky bit: ${component}`);
    leaf ??= info;
    if(dirname(component)===component)return leaf;
  }
}
function expectIdentity(info,identity) {
  if(!identity||info.dev!==identity.dev||info.ino!==identity.ino)throw new Error('showcase temporary directory identity changed');
  if(info.uid!==process.getuid()||(info.mode&0o077)!==0)throw new Error('showcase temporary directory must stay private and owned by the current user');
}
const checkDirectory=(root,identity)=>expectIdentity(safeDirectory(root),identity);
// Linux descriptor paths: the kernel resolves /proc/self/fd/N to the directory
// that was opened, so a later rename or replacement of `root` cannot redirect
// SQLite's open of the journal file or cleanup's removals (openat/unlinkat
// semantics without native bindings). SQLite's -wal/-shm still use a text path.
const bound=(fd,name)=>`/proc/self/fd/${fd}${name?'/'+name:''}`;
// O_DIRECTORY makes a FIFO or other non-directory swapped in fail at once
// (ENOTDIR) instead of blocking in open.
function bindDirectory(root,identity) {
  safeDirectory(root);
  const fd=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
  try{expectIdentity(fstatSync(fd),identity);return fd;}catch(error){closeSync(fd);throw error;}
}
// Without a working /proc/self/fd (macOS has no /proc) the fixture falls back to
// path-based opens and removals between checks; see the doc's Limits.
// DACS_SHOWCASE_DIRECTORY_BINDING=path forces that fallback for tests.
function viaDescriptor(fd,identity) {
  const forced=process.env.DACS_SHOWCASE_DIRECTORY_BINDING;
  if(forced!==undefined&&forced!=='path')throw new Error('DACS_SHOWCASE_DIRECTORY_BINDING must be unset or path');
  if(forced==='path')return false;
  try{const info=statSync(bound(fd));return info.dev===identity.dev&&info.ino===identity.ino;}catch{return false;}
}
export function directoryBinding() {
  const fd=openSync('/',constants.O_RDONLY|constants.O_DIRECTORY);
  try{return viaDescriptor(fd,fstatSync(fd))?'descriptor':'path';}finally{closeSync(fd);}
}
export const temporaryJournal=()=>{
  const parent=resolve(tmpdir());safeDirectory(parent);
  const root=mkdtempSync(join(parent,'showcase-safety-')),info=lstatSync(root);
  const identity=Object.freeze({dev:info.dev,ino:info.ino});
  let fd;
  try{fd=bindDirectory(root,identity);}
  catch(error){try{checkDirectory(root,identity);rmdirSync(root);}catch{/* refused: leave it untouched */}throw error;}
  let closed=false;
  return {path:join(root,'public.sqlite'),identity,close:()=>{
    if(closed)return;
    fd??=bindDirectory(root,identity);
    try{
      checkDirectory(root,identity);
      const descriptor=viaDescriptor(fd,identity);
      for(const name of readdirSync(descriptor?bound(fd):root))rmSync(descriptor?bound(fd,name):join(root,name),{recursive:true,force:true});
      // POSIX cannot remove a directory by descriptor. rmdir removes only an empty
      // directory, and only after `root` is again confirmed to name the bound one.
      checkDirectory(root,identity);rmdirSync(root);closed=true;
    }finally{closeSync(fd);fd=undefined;}
  }};
};

// The URL is an inert loopback label: every RPC is handled by this callback.
// Only public transactions and counters are persisted, in one temp SQLite file.
export function fixture({path,directoryIdentity,expectedJournalId,mode='create',boundary=null}={}) {
  const directory=bindDirectory(dirname(path),directoryIdentity);
  let journal;
  try{
    const descriptor=viaDescriptor(directory,directoryIdentity);
    journal=openDurableWalletJournal({path:descriptor?bound(directory,basename(path)):path,mode,expectedJournalId,lockTimeoutMs:0});
    // SQLite names -wal/-shm by text path after the open; refuse a swap still in place.
    try{checkDirectory(dirname(path),directoryIdentity);}catch(error){try{journal.close();}catch{/* report the swap */}throw error;}
  }catch(error){closeSync(directory);throw error;}
  const context={network:pins.network,endpoint:pins.endpoint,transportAuthority:pins.transportAuthority,connectionId:`TEST-process-${process.pid}`};
  const faults={lost:false,unavailable:false};
  const requests=[];
  let fenced=false,capability;
  const fetchImpl=async(url,options)=>{
    assert.equal(String(url),pins.endpoint,'no external destination');
    const body=JSON.parse(options.body),call=body.params[0];
    requests.push(copy(body));
    if(faults.unavailable)throw new Error('TEST chain read unavailable');
    let response;
    const chain=await journal.get('showcase/chain') ?? {broadcasts:0,transaction:null};
    if(body.method==='execute'&&call.extra==='confirmTx')response={data:{valid:true,transaction:copy(call.data)}};
    else if(body.method==='execute'&&call.extra==='broadcastTx'){
      const tx=call.data.response.data.transaction;
      assert.equal((await journal.get(`devnet/native-transfer/${tx.hash}`)).stage,'broadcast-started');
      await journal.put('showcase/chain',{broadcasts:chain.broadcasts+1,transaction:copy(tx)});
      await boundary?.('broadcast',tx);
      if(faults.lost)throw new Error('TEST broadcast acknowledgement lost');
      response={txHash:tx.hash};
    }else if(body.method==='nodeCall'){
      if(call.message==='getBlockByNumber')response=call.data.blockNumber===0
        ? {number:0,status:'confirmed',hash:pins.chainIdentity,content:{ordered_transactions:[]}}
        : {number:1,status:'confirmed',hash:'d'.repeat(64),content:{ordered_transactions:chain.transaction?[chain.transaction.hash]:[]}};
      else if(call.message==='getTransactionStatus')response=chain.transaction?.hash===call.data.hash?{state:'included',blockNumber:1}:{state:'not-found'};
      else if(call.message==='getTxByHash')response=chain.transaction?.hash===call.data.hash?{...copy(chain.transaction),status:'confirmed',blockNumber:1}:null;
      // The transport reads the sender nonce before it retains a native intent; only the broadcast transfer consumes it.
      else if(call.message==='getAddressNonce')response=chain.transaction?.content.from===call.data.address?chain.transaction.content.nonce:0;
      else assert.fail(`unexpected read ${call.message}`);
    }else assert.fail('unexpected RPC');
    return new Response(JSON.stringify({result:200,response}),{headers:{'content-type':'application/json'}});
  };
  const sourceJournal={...journal,put:async(key,value)=>{
    await journal.put(key,value);
    if(key.startsWith('devnet/native-transfer/')&&value.stage==='broadcast-started')await boundary?.('journal',value.signedTransaction);
  }};
  capability=createDevnetNativeTransport({expected:pins,journal:sourceJournal,fetchImpl,inclusionWaitMs:0,transportOwner:{
    getContext:()=>copy(context),acquireConnectionFence:async()=>{
      assert.equal(fenced,false);fenced=true;
      return {context:copy(context),release:()=>{fenced=false;}};
    },
  }});
  const broadcastCount=async()=>(await journal.get('showcase/chain'))?.broadcasts ?? 0;
  const prepare=async()=>{
    const wallet=createEphemeralWallet(),payee=`0x${'b'.repeat(64)}`;
    const content={type:'native',from:wallet.address,to:payee,amount:'1000000000',nonce:1,timestamp:1791450000000,
      data:['native',{nativeOperation:'send',args:[payee,'1000000000']}]};
    const hash=sha(JSON.stringify(content)),tx={hash,content,signature:{type:'ed25519',data:wallet.signHex(hash)}};
    // Sign a new RPC auth set from this process's clock for every request, as
    // the SDK and embedded wallet do: the transport accepts each set once,
    // within 2 minutes. Unlike them, a later request in the same millisecond
    // takes the next one, so these scenarios never depend on clock resolution.
    const identity=`ed25519:${wallet.address}`,auth=[];
    const signAuth=(timestamp)=>({identity,timestamp,signature:wallet.signHex(sha(`${identity}:${timestamp}`))});
    const headers=()=>{
      auth.push(signAuth(String(Math.max(Date.now(),Number(auth.at(-1)?.timestamp ?? 0)+1))));
      return copy(auth.at(-1));
    };
    const {binding}=await capability.binding({phase:'bind',address:wallet.address});
    const lease=await capability.binding({phase:'signature',address:wallet.address,binding});
    const confirmed=await capability.rpc({method:'execute',params:[{extra:'confirmTx',data:tx}]},headers());
    await capability.binding({phase:'broadcast',address:wallet.address,leaseId:lease.leaseId,hash});
    return {tx,auth,signAuth,send:()=>capability.rpc({method:'execute',params:[{extra:'broadcastTx',data:confirmed}]},headers())};
  };
  return {journal,capability,faults,requests,prepare,broadcastCount,
    observer:createDemosChainReader({rpcUrl:pins.endpoint,network:pins.network,pinnedIdentity:pins.chainIdentity,fetchImpl}),
    close:async()=>{try{await capability.close();journal.close();}finally{closeSync(directory);}}};
}

export async function recipientScenario(path) {
  let authorizations=0,signatures=0,broadcasts=0;
  const approval=createExactBuyerApproval({maxTotalOs:'2000000000',evidencePath:path,
    authorize:()=>{authorizations++;throw new Error('TEST changed recipient reached wallet authorization');}});
  const reviewed={kind:'native-payment',address:`0x${'a'.repeat(64)}`,buyer:`did:demos:agent:${'a'.repeat(64)}`,seller:`did:demos:agent:${'b'.repeat(64)}`,
    listingId:'showcase-report',listingVersion:1,listingContentHash:'c'.repeat(64),jobId:'showcase-job',agreementHash:'d'.repeat(64),network:pins.network,chainIdentity:pins.chainIdentity,payee:`0x${'b'.repeat(64)}`,amountOs:'1000000000'};
  const request={method:'sendTransaction',address:reviewed.address,purpose:'Review exact payment',content:{action:'native DEM transfer',from:reviewed.address,to:`0x${'e'.repeat(64)}`,
    amountOs:reviewed.amountOs,amountDem:'1',nonce:1,debit:{sellerAmountDem:'1',sdkGasDem:'1',networkFeeDem:'0',rpcFeeDem:'0',additionalFeeDem:'0',totalDem:'2',totalOs:'2000000000',note:'TEST'},
    network:pins.network,networkBinding:{...pins,connectionId:'TEST-review'},evidence:'TEST',sending:'TEST'}};
  approval.expect(reviewed);
  let refusal;
  try{if(await approval.approve(request)){signatures++;broadcasts++;}}catch(error){refusal=error.message;}
  assert.match(refusal ?? '',/differs from the expected native-payment scope/);
  assert.equal(authorizations,0);assert.equal(signatures,0);assert.equal(broadcasts,0);
  return {authorizations,signatures,broadcasts,refusal,lines:['Reviewed recipient: '+reviewed.payee,'Seller substitutes: '+request.content.to,'REFUSED before wallet authorization/signing. Signatures: 0; broadcasts: 0.']};
}

export async function unavailableScenario(path,directoryIdentity) {
  const h=fixture({path,directoryIdentity});
  try{
    h.faults.unavailable=true;
    const observation=await h.observer.observeTransfer('a'.repeat(64));
    assert.equal(observation.status,'unavailable');
    const status=evidenceStatus(observation);
    assert.equal(status,'unknown');
    assert.equal(await h.broadcastCount(),0);
    return {status,observation,broadcasts:0,lines:['Chain read throws: TEST chain read unavailable.','Evidence status: unknown (reader: unavailable). No success or failure inferred. Broadcasts: 0.']};
  }finally{await h.close();}
}

export async function lostScenario(path,directoryIdentity) {
  const h=fixture({path,directoryIdentity});
  try{
    const prepared=await h.prepare();h.faults.lost=true;
    await assert.rejects(prepared.send(),{kind:'unavailable'});
    const retained=await h.journal.get(`devnet/native-transfer/${prepared.tx.hash}`);
    assert.equal(retained.stage,'broadcast-started');assert.equal(retained.hash,prepared.tx.hash);
    assert.equal(await h.broadcastCount(),1);
    await assert.rejects(h.capability.binding({phase:'signature',address:prepared.tx.content.from,binding:retained.networkBinding}),{code:'outcome_unknown'});
    const answer=await h.capability.binding({phase:'readback',address:prepared.tx.content.from,hash:retained.hash});
    assert.equal(answer.disposition,'included');assert.equal(answer.receipt.hash,prepared.tx.hash);assert.equal(answer.noResend,true);
    const reads=h.requests.length;
    const replay=await h.capability.binding({phase:'readback',address:prepared.tx.content.from,hash:retained.hash});
    assert.deepEqual(replay,answer);assert.ok(h.requests.length>reads);
    assert.equal(await h.broadcastCount(),1);
    return {hash:retained.hash,recoveredHash:answer.receipt.hash,broadcasts:1,lines:['Broadcast acknowledgement lost for '+retained.hash+'.','New signature refused: outcome_unknown.','Readback reconciles the SAME hash; replay reads again. Broadcasts: 1.','Single fake node inclusion; consensus finality is not established.']};
  }finally{await h.close();}
}

export async function deliveryScenario(path,directoryIdentity) {
  const h=fixture({path,directoryIdentity});
  try{
    const prepared=await h.prepare();await prepared.send();
    const seller=createEphemeralWallet(),listing=fixtureListing(seller),agreement={jobId:'showcase-delivery',parties:[{role:'buyer',primaryClaim:`did:demos:agent:${prepared.tx.content.from.slice(2)}`},{role:'seller',primaryClaim:seller.claim}],
      terms:{price:{amount:'2.5',currency:'DEM'},payoutBindings:[{payeeAddress:seller.address}]}};
    const pointer={status:'delivery-ready',logicalAddress:'dacs4:deliverable:showcase-delivery',contentHash:'e'.repeat(64),evidenceHash:'f'.repeat(64),fulfilmentId:'showcase-output'};
    const states=[];let deliveryReads=0;
    for(const state of ['delayed','missing','read-failed']){
      const native=createNativeDemDeliveryCapability({authority:'TEST-showcase-read-only',submit:()=>assert.fail('no submit'),reconcile:()=>assert.fail('no reconcile'),verifyReceipt:()=>assert.fail('no receipt for missing output'),
        read:async()=>{deliveryReads++;if(state==='read-failed')throw new Error('TEST output unavailable');return {status:state==='delayed'?'indeterminate':'absent',reason:`TEST output ${state}`};}});
      const answer=await readDemDeliveryReady({nativeDemDelivery:native,agreement,listing,seller:seller.claim,answer:{delivery:pointer,settlementId:'showcase-payment'}});
      assert.equal(answer.disposition,'indeterminate');assert.equal(answer.delivery,undefined);
      const view=protocolView({status:'settled_verified',terms:{protocol:{profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',jobId:agreement.jobId}},
        state:{protocol:{stage:'payment-evidenced',delivery:{status:'delivery-ready',report:{historical:true}},attempts:[]}}});
      assert.equal(view.stage,'payment-evidenced');assert.equal(view.layers.service,'not-delivered');assert.equal(view.layers.completedCopies,'not-exchanged');assert.equal(view.delivery,null);
      assert.equal(await h.broadcastCount(),1);states.push({state,disposition:answer.disposition,stage:view.stage});
    }
    assert.equal(deliveryReads,3);
    return {states,broadcasts:1,lines:['Payment broadcast once; seller claims output is ready.','Fresh reads: delayed, missing, then unavailable. Each stays indeterminate.','Current report hidden; service not delivered; bundle not completed. No refund inferred. Broadcasts: 1.']};
  }finally{await h.close();}
}
