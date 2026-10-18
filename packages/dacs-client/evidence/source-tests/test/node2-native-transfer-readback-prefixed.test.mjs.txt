// Offline exact-current regression for Node2's getTxByHash execution
// projection. Uses .invalid fetch stubs and a test-owned in-memory journal;
// TEST-key fixture bytes also exercise confirmation leases; no socket, real
// wallet, CREATE, payment or chain broadcast is reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedTransport, CHAIN, layoutAdmission, layoutChain, memoryJournal, NETWORK, NOW, sha, WALLET } from './helpers/review-node2-current-coverage-fixture.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createAgentService } from '../src/agents.mjs';
import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { contentHash, createInMemorySellerReceiptStore, finalityCommitmentAddress, generateCanonicalJobId, identityBundleHash, verifySellerPaymentIntake } from '@kynesyslabs/dacs';
import { createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { DEM_RAIL_DEFINITION, planAgreement, RAIL_REGISTRY_VERSION } from '../src/dacs/purchase-protocol.mjs';
import { validateListing } from '../src/dacs/listing.mjs';
import { fixtureIdentityBundle, fixtureListing } from './fixtures/listings.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { PAYER, sdkHeaders, signedContent, signHex, signTransaction } from './helpers/review-native-readback-current-fixture.mjs';
import { once } from 'node:events';
import express from 'express';
import { createWalletRpcRouter } from '../src/portal/wallet-rpc.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';

const PAYEE=`0x${'7'.repeat(64)}`;
const BLOCK=sha('node2-native-transfer-readback:block-10');
const OTHER=sha('node2-native-transfer-readback:other');
const clone=(value)=>structuredClone(value);
const expectedContent=()=>({
  type:'native',
  from:WALLET,
  to:PAYEE,
  amount:'2500000000',
  data:['native',{nativeOperation:'send',args:[PAYEE,'2500000000']}],
  nonce:7,
  timestamp:1_900_000_000_123,
  transaction_fee:{network_fee:'1000000000',rpc_fee:'2000000000',additional_fee:'0',rpc_address:null},
  from_ed25519_address:WALLET,
  gcr_edits:[{address:WALLET,amount:'-5500000000'},{address:PAYEE,amount:'2500000000'}],
});
const nodeProjection=(content)=>{
  const value=clone(content);
  value.nonce=String(value.nonce);
  value.timestamp=String(value.timestamp);
  value.amount=Number(value.amount);
  for(const key of ['network_fee','rpc_fee','additional_fee'])value.transaction_fee[key]=Number(value.transaction_fee[key]);
  return value;
};
const lane=(address)=>`devnet/native-wallet/${JSON.stringify([NETWORK,CHAIN,address])}`;
const intent=(hash)=>`devnet/native-transfer/${hash}`;
// The journal without the source's transfer claims (a lease's claim on the
// native transfer it confirms, removed when the lease ends): they hold no hash
// or signed transaction, and issue nothing.
const unclaimed=async(journal)=>(await journal.entries()).filter(([key])=>!key.startsWith('devnet/transfer-claims/'));
const unclaimedPuts=(journal)=>journal.puts.filter((key)=>!key.startsWith('devnet/transfer-claims/')).length;

for(const path of ['seller intake','native evidence consumer'])test(`failed retained native execution is unpaid: ${path}`,async t=>{
  const clock=1_900_000_000_000,seller=createEphemeralWallet();
  const buyer={address:PAYER,claim:`did:demos:agent:${PAYER.slice(2)}`,signBytes:bytes=>Buffer.from(signHex(bytes),'hex')};
  const listing=fixtureListing(seller,{now:clock}),buyerBundle=fixtureIdentityBundle(buyer,clock);
  const validation=await validateListing(listing,{now:()=>clock,revocationSurfaces:[{kind:'catalog',status:'active',readStatus:'ok',catalogObservedAt:clock}],readMarker:async()=>null});
  assert.equal(validation.disposition,'verified');
  const planned=planAgreement({jobId:generateCanonicalJobId(),listing,buyerBundle,generatedAt:clock});
  const agreement={...planned.draft,signatures:[buyer,seller].map(wallet=>({party:wallet.claim,algorithm:'ed25519',value:wallet.signBytes(Buffer.from(planned.agreementMessage)).toString('base64url')}))};
  const content=signedContent();content.to=seller.address;content.data[1].args[0]=seller.address;content.gcr_edits[1].account=seller.address;
  const signed=signTransaction(content),w=await world(t,undefined,{signed});
  w.run.stub.set({10:{result:200,response:{number:10,status:'confirmed',hash:BLOCK,content:{ordered_transactions:[w.hash],timestamp:(clock+10_000)/1000}}}});
  let anchors=0,observations=0,claims=0;
  const consumer=createNativePaymentEvidenceConsumer({rpcUrl:w.run.capability.pins.endpoint,sourceCapability:w.run.capability,anchorEvidence:()=>{anchors++;throw new Error('TEST no evidence write permitted');}});
  const observer=path==='seller intake'?hash=>w.run.capability.chainReader().observeTransfer(hash):consumer.observeDemosTransfer;
  const deps={
    resolveCommittedAgreement:async()=>({disposition:'verified',agreement,agreementHash:contentHash(agreement),railRegistryVersion:RAIL_REGISTRY_VERSION,
      commitment:{finality:'finalized',ref:finalityCommitmentAddress(agreement.jobId),contentHash:sha('TEST-finalized-commitment'),jobId:agreement.jobId,agreementHash:contentHash(agreement),listingRef:agreement.listingRef,committedAt:clock+1000,signer:seller.claim}}),
    resolveListingAtCommit:async()=>({rawListing:listing,validation}),
    resolveRail:async()=>({disposition:'verified',rail:DEM_RAIL_DEFINITION,railRegistryVersion:RAIL_REGISTRY_VERSION}),
    resolveIdentityBundle:async hash=>({disposition:'verified',bundle:hash===identityBundleHash(buyerBundle)?buyerBundle:listing.seller.identity}),
    resolvePayerAddress:async()=>{throw new Error('TEST no x402');},resolvePayeeDestination:async()=>{throw new Error('TEST no x402');},
    observeDemosTransfer:hash=>{observations++;return observer(hash);},observeX402Transfer:async()=>{throw new Error('TEST no x402');},
    verifyX402ReceiptExtensions:()=>{throw new Error('TEST no x402');},classifyX402SettlementChain:()=>{throw new Error('TEST no x402');},
  };
  const intake=()=>{
    const store=createInMemorySellerReceiptStore();
    return verifySellerPaymentIntake({jobId:agreement.jobId,phaseIndex:2,railId:'demos-native:DEM',payerPayingKey:buyer.claim,receipt:{kind:'pay-dem',txHash:w.hash}},
      {...deps,receiptStore:{...store,claim:(...args)=>{claims++;return store.claim(...args);}}});
  };
  assert.equal((await intake()).disposition,'verified','the same fully admitted tuple can authorize payment when execution confirms');
  w.journal.seed(intent(w.hash),w.issued);w.journal.seed(lane(PAYER),w.issued);
  // The SDK sees an earlier included body; fresh source readback proves failure.
  let bodies=0;
  w.run.stub.set({getTxByHash:()=>new Response(JSON.stringify({result:200,response:{hash:w.hash,status:++bodies===1?'confirmed':'failed',blockNumber:10,content:nodeProjection(signed.content)}}),{status:200,headers:{'content-type':'application/json'}})});
  const before=await w.journal.entries(),writes=w.journal.puts.length;observations=0;claims=0;
  const result=await intake();
  assert.equal(observations,1,'intake reaches the real source observer');
  assert.equal(result.disposition,'indeterminate',JSON.stringify(result));assert.equal(result.reason,'demos-observation-unavailable');
  assert.equal(result.evidenceInput,undefined,'no successful SettlementEvidence is produced');
  assert.equal(result.fulfilment,'none','no delivery permit is issued');assert.equal(claims,0);assert.equal(anchors,0);
  assert.equal(bodies,2);bodies=0;
  await assert.rejects(observer(w.hash),{code:'readback_unverified'});
  w.run.stub.set({getTxByHash:{result:200,response:{hash:w.hash,status:'failed',blockNumber:10,content:nodeProjection(signed.content)}}});
  assert.notEqual((await observer(w.hash)).status,'included','a consistently failed body is unpaid too');
  const failed=await intake();assert.notEqual(failed.disposition,'verified');assert.equal(failed.evidenceInput,undefined);assert.equal(failed.fulfilment,'none');
  assert.equal(claims,0);assert.equal(anchors,0);
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.ok((await w.run.bind()).pending,'failed execution still holds the buyer source lane for explicit resolution');
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

async function world(t,change=(value)=>value,{txHash=null,txStatus='confirmed',signed=null,unissued=false,now}={}){
  const content=signed?.content??expectedContent(),hash=sha(JSON.stringify(content)),actual=change(nodeProjection(content)) ?? nodeProjection(content);
  const observedHash=txHash??hash,journal=memoryJournal();
  const run=admittedTransport(await layoutAdmission(),{
    ...layoutChain(),
    getTransactionStatus:{result:200,response:{state:'included',blockNumber:10}},
    getTxByHash:{result:200,response:{hash:observedHash,status:txStatus,blockNumber:10,content:actual}},
    getAddressNonce:{result:200,response:6},
    10:{result:200,response:{number:10,status:'confirmed',hash:BLOCK,content:{ordered_transactions:[hash]}}},
  },{journal,...(now?{now}:{})});
  run.bind=()=>run.capability.binding({phase:'bind',address:content.from});
  t.after(()=>run.capability.close());
  const binding=(await run.bind()).binding;
  const signedTransaction=signed??{hash,content:clone(content),signature:{type:'ed25519',data:'TEST-retained-original-signature'}};
  const issued={stage:'broadcast-accepted',hash,nonce:content.nonce,signedTransaction:clone(signedTransaction),networkBinding:clone(binding)};
  if(!unissued){journal.seed(intent(hash),issued);journal.seed(lane(content.from),issued);}
  return{run,journal,hash,issued,signedTransaction,read:()=>run.capability.binding({phase:'readback',address:WALLET,hash})};
}

for(const resolution of ['nonce proof','advanced nonce','late confirmation']){
  test(`retained failed native transfer: ${resolution}`,async t=>{
    const w=await world(t,undefined,{txStatus:'failed'}),before=await w.journal.entries();
    const failed=await w.read();
    assert.equal(failed.disposition,'failed');assert.equal(failed.resolved,false);
    assert.deepEqual(await w.journal.entries(),before,'failed read alone never releases the issued lane');
    assert.ok((await w.run.bind()).pending);
    if(resolution==='advanced nonce')w.run.stub.set({getAddressNonce:{result:200,response:7}});
    const resolved=await w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,failedNonceFence:6});
    assert.equal(resolved.resolved,resolution!=='advanced nonce');
    if(resolution==='advanced nonce'){
      assert.deepEqual(await w.journal.entries(),before);assert.ok((await w.run.bind()).pending);
    }else{
      const row=await w.journal.get(intent(w.hash));
      assert.equal(row.stage,'failed');assert.deepEqual(row.signedTransaction,w.signedTransaction);
      const bound=await w.run.bind();
      assert.equal(bound.pending,null,'nonce-proven failure releases the actual native lane');
      const lease=await w.run.capability.binding({phase:'signature',address:WALLET,binding:bound.binding});
      assert.ok(lease.leaseId,'a replacement can acquire the source signature fence');
      await w.run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});
      // Resolving the older hash must never rewrite a replacement's lane.
      const replacement={...w.issued,hash:OTHER,stage:'broadcast-started'};
      w.journal.seed(lane(WALLET),replacement);
      assert.equal((await w.read()).disposition,'failed');
      assert.deepEqual(await w.journal.get(lane(WALLET)),replacement);
      if(resolution==='late confirmation'){
        w.run.stub.set({getTxByHash:{result:200,response:{hash:w.hash,status:'confirmed',blockNumber:10,content:nodeProjection(w.signedTransaction.content)}}});
        assert.equal((await w.read()).disposition,'included');
        assert.equal((await w.journal.get(intent(w.hash))).stage,'observed');
        assert.deepEqual(await w.journal.get(lane(WALLET)),replacement);
      }
    }
    assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)),'resolution is read-only on chain');
  });
}

test('observed Node2 decimal-string nonce/timestamp and safe-number amount/fees authenticate the exact retained transfer and release it without resend',async t=>{
  const w=await world(t);
  const read=await w.read();
  assert.deepEqual(read,{disposition:'included',receipt:{hash:w.hash,nonce:7,blockNumber:10,blockHash:BLOCK,payer:WALLET,payee:PAYEE,amount:'2500000000',network:NETWORK,chainIdentity:CHAIN,attribution:'tuple-only',finality:'not-established',commitmentOnChain:false},noResend:true});
  const rows=Object.fromEntries(await w.journal.entries());
  assert.equal(rows[intent(w.hash)].stage,'observed');
  assert.equal(rows[lane(WALLET)].stage,'observed');
  assert.deepEqual(rows[intent(w.hash)].signedTransaction,w.signedTransaction,'the original signed bytes/signature stay retained');
  assert.equal(w.journal.puts.length,2,'readback only marks the exact intent and current lane observed');
  assert.deepEqual(w.run.stub.messages().filter((message)=>message!=='getBlockByNumber'),['getTransactionStatus','getTxByHash'],'no confirm or broadcast request is sent');
});

for(const [label,response,resolved] of [
  ['wrapped fence',{nonce:6},true], ['wrapped advanced nonce',{nonce:7},false],
])test(`failed-intent nonce response: ${label}`,async t=>{
  const w=await world(t,undefined,{txStatus:'failed'}),before=await w.journal.entries();
  w.run.stub.set({getAddressNonce:{result:200,response}});
  assert.equal(await w.run.capability.chainReader().getAddressNonce(WALLET),response.nonce, 'application chain reader accepts the same wrapped RPC nonce');
  const result=await w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,failedNonceFence:6});
  assert.equal(result.resolved,resolved);
  if(resolved){
    assert.equal((await w.run.bind()).pending,null);
    assert.equal((await w.journal.get(intent(w.hash))).stage,'failed');
    assert.deepEqual((await w.journal.get(intent(w.hash))).signedTransaction,w.signedTransaction);
    const lease=await w.run.capability.binding({phase:'signature',address:WALLET,binding:(await w.run.bind()).binding});
    assert.ok(lease.leaseId,'wrapped nonce proof releases the actual source lane');
    await w.run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});
  }else{
    assert.deepEqual(await w.journal.entries(),before);assert.ok((await w.run.bind()).pending);
  }
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

for(const [label,response] of [
  ['missing nonce',{}], ['null',null], ['numeric text',{nonce:'6'}],
  ['negative',{nonce:-1}], ['fractional',{nonce:6.5}], ['unsafe integer',{nonce:Number.MAX_SAFE_INTEGER+1}],
])test(`failed-intent nonce response: rejects ${label}`,async t=>{
  const w=await world(t,undefined,{txStatus:'failed'}),before=await w.journal.entries();
  w.run.stub.set({getAddressNonce:{result:200,response}});
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,failedNonceFence:6}),{kind:'invalid',message:'nonce response is malformed'});
  assert.deepEqual(await w.journal.entries(),before);assert.ok((await w.run.bind()).pending);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

async function supersessionWorld(t, stage='broadcast-started', existingOwner=false, options={}) {
  const w=await world(t,undefined,options),source=w.run.capability,payer=w.signedTransaction.content.from;
  const issued={...w.issued,stage};if(!options.unissued){w.journal.seed(intent(w.hash),issued);w.journal.seed(lane(payer),issued);}
  const consuming={hash:OTHER,status:'confirmed',blockNumber:10,content:clone(w.signedTransaction.content)};
  consuming.content.timestamp+=1;
  const originalA={hash:OTHER,content:clone(consuming.content),signature:clone(w.signedTransaction.signature)};
  // An owner signed outside the source transport (e.g. by an alternate key) has no retained intent.
  if(!options.ownerUnretained)w.journal.seed(intent(OTHER),{...w.issued,hash:OTHER,stage:'failed',signedTransaction:originalA,failure:{nonceFence:6}});
  consuming.content=nodeProjection(consuming.content);
  const block={number:10,status:'confirmed',hash:BLOCK,content:{timestamp:1_900_000_000_123,ordered_transactions:[OTHER]}};
  w.run.stub.set({getTxByHash:{result:200,response:consuming},getAddressNonce:{result:200,response:7},10:{result:200,response:block}});
  const db=openDatabase(':memory:');t.after(()=>db.close());
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer','TEST','TEST-buyer',new Date().toISOString());
  const ops=createOperationStore({db,handoffSecret:'TEST-only-supersession-secret-000000000000'}),coordinates=createCoordinateStore({db});
  const terms={buyer:{wallet:payer},seller:{payee:PAYEE},price:{amountOs:'2500000000'},listing:{listingId:'TEST-listing',version:1,contentHash:sha('TEST-listing')},network:NETWORK,rail:'demos-native:DEM',domain:{network:NETWORK,rail:'demos-native:DEM',mode:'public-chain-read',chainIdentity:CHAIN}};
  const create=(key,status,native)=>ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:key,request:{key},status,terms:{...terms,...(native?{protocol:{profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',nativePayment:NATIVE_AGREEMENT_PAYMENT,sellerAgreementProjection:'public-signed-create',transportBinding:source.transportBinding}}:{})},termsHash:sha(key),expiresAt:new Date(Date.now()+60000).toISOString(),state:{protocol:{stage:'seller-committed'}}}).operation;
  const a=create('TEST-cancelled-A',existingOwner?'settled_verified':'cancelled',true),b=create('TEST-unknown-B',options.bStatus??'payment_uncertain',true);
  for(const op of [a,b])coordinates.save({operationId:op.id,kind:'native-dem-transfer',network:NETWORK,from:payer,nonceFence:6,expectedNonce:7,target:PAYEE,amountOs:'2500000000',payload:op.id===a.id?originalA:w.signedTransaction});
  coordinates.reportHash(a.id,OTHER); // B's unknown broadcast hash never reached the purchase database.
  if(existingOwner)coordinates.recordObservation(a.id,{txHash:OTHER,txStatus:'confirmed',slotConsumed:true,observation:{status:'included',blockNumber:10}},true);
  const protocolConfig={db,ops,coordinates,dacsProtocol:{sellerEndpoint:()=>source.pins.endpoint,sellerSr2Commitment:{commitmentSubstrate:'fixture',publicProjection:true},walletAgreement:{rpcUrl:source.pins.endpoint,network:NETWORK,sourceCapability:source,journal:w.journal,bridgeFor:()=>null},nativeAgreementPayment:source}};
  const protocol=createProtocolPurchases(protocolConfig);
  const reader=source.chainReader(),chain={...reader,networkIdentity:async()=>({identity:(await source.observeBinding()).chainIdentity,mode:'public-chain-read'})};
  const build=(p)=>createPurchaseService({db,config:{},ops,coordinates,chain,protocol:p});
  let purchases=build(protocol);
  const verify=(id)=>purchases.verifyDeal({accountId:'TEST-buyer',operationId:id});
  return {...w,db,ops,coordinates,protocol,purchases,chain,a,b,consuming,block,verify,recreate:()=>{purchases=build(createProtocolPurchases(protocolConfig));}};
}

for(const scenario of ['broadcast-started','broadcast-accepted','crash after database commit','crash after intent write','verified-owner recovery','foreign journal intent']) {
  test(`native supersession resolves source lane: ${scenario}`,async t=>{
    const w=await supersessionWorld(t,scenario==='broadcast-accepted'?'broadcast-accepted':'broadcast-started',scenario==='verified-owner recovery');
    const binding=(await w.run.bind()).binding;
    const foreign={...w.issued,hash:sha('foreign-intent'),networkBinding:{...w.issued.networkBinding,chainIdentity:sha('foreign-chain')}};
    if(scenario==='foreign journal intent')w.journal.seed(intent(foreign.hash),foreign);
    await assert.rejects(w.run.capability.binding({phase:'signature',address:WALLET,binding}),{code:'outcome_unknown'});
    const resolve=w.protocol.nativePaymentSuperseded,put=w.journal.put;
    if(scenario==='crash after database commit')w.protocol.nativePaymentSuperseded=async()=>{throw new Error('TEST interruption before source resolution');};
    if(scenario==='crash after intent write')w.journal.put=async(key,value)=>{if(key===lane(WALLET)&&value.stage==='failed')throw new Error('TEST interruption before lane write');return put(key,value);};
    const settled=await w.verify(w.a.id);
    assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.outcome,'verified');
    assert.equal(w.ops.get('TEST-buyer',w.b.id).status,scenario==='verified-owner recovery'?'payment_uncertain':'superseded');
    if(scenario.startsWith('crash')){
      assert.ok((await w.run.bind()).pending,'committed supersession keeps its durable retry proof while source completion is interrupted');
      assert.equal(w.coordinates.get(w.b.id).observation.supersededBy,w.a.id);assert.equal(w.coordinates.get(w.b.id).observation.txHash,OTHER);
      if(scenario==='crash after intent write')assert.equal((await w.journal.get(intent(w.hash))).stage,'failed');
      w.protocol.nativePaymentSuperseded=resolve;w.journal.put=put;
      w.recreate(); // recovery reads the stores through new purchase/protocol services
      if(scenario==='crash after database commit')assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified','a recheck of A also completes B\'s stored resolution');
      const recovered=await w.verify(w.b.id);
      assert.equal(recovered.operation.status,'superseded');assert.equal(recovered.verification.nativeLaneResolved,true);
    }
    if(scenario==='verified-owner recovery'){
      // A was already settled in the persisted fixture; resolve B through the older route.
      const recovered=await w.purchases.verifyDeal({accountId:'TEST-buyer',operationId:w.b.id,txHash:OTHER});
      assert.equal(recovered.operation.status,'superseded');assert.equal(recovered.verification.nativeLaneResolved,true);
    }
    assert.equal((await w.run.bind()).pending,null,'a superseded purchase releases its actual source signature lane');
    const row=await w.journal.get(intent(w.hash));assert.equal(row.stage,'failed');
    if(scenario==='foreign journal intent')assert.deepEqual(await w.journal.get(intent(foreign.hash)),foreign);
    assert.equal(row.failure.supersededByHash,OTHER);assert.deepEqual(row.signedTransaction,w.signedTransaction,'original signed bytes remain retained');
    assert.equal(await w.run.capability.chainReader().getAddressNonce(WALLET),7,'the new payment uses the next nonce after A');
    const lease=await w.run.capability.binding({phase:'signature',address:WALLET,binding:(await w.run.bind()).binding});
    assert.ok(lease.leaseId,'a new native purchase can acquire the actual signature connection fence');
    await w.run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});
    assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)),'supersession never resends either payment');
  });
}

test('native supersession preserves a newer source lane',async t=>{
  const w=await supersessionWorld(t);
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  const newer={...w.issued,hash:sha('newer-intent'),nonce:8,stage:'broadcast-started',signedTransaction:{...w.signedTransaction,content:{...w.signedTransaction.content,nonce:8}}};
  w.journal.seed(intent(newer.hash),newer);w.journal.seed(lane(WALLET),newer);
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  assert.deepEqual(await w.journal.get(lane(WALLET)),newer);assert.deepEqual(await w.journal.get(intent(newer.hash)),newer);
  assert.equal((await w.run.bind()).pending.hash,newer.hash);
});

test('native supersession completion survives recreation and skips all source work',async t=>{
  const w=await supersessionWorld(t);
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  const reads=w.run.stub.messages().length,writes=w.journal.puts.length,history=w.ops.history(w.b.id);
  w.recreate();
  w.run.stub.set({getTransactionStatus:{result:200,response:{state:'unavailable'}}});
  assert.equal((await w.verify(w.a.id)).verification.outcome,'verified');
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  assert.equal(w.run.stub.messages().length,reads,'completed A and B make no source node reads');
  assert.equal(w.journal.puts.length,writes,'completed A and B make no journal writes');
  assert.deepEqual(w.ops.history(w.b.id),history);
  assert.equal(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true);
});

async function fenceFailedIntent(w) {
  w.run.stub.set({getTxByHash:{result:200,response:{hash:w.hash,status:'failed',blockNumber:10,content:nodeProjection(w.signedTransaction.content)}},getAddressNonce:{result:200,response:6},10:{result:200,response:{...w.block,content:{...w.block.content,ordered_transactions:[w.hash]}}}});
  assert.equal((await w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,failedNonceFence:6})).resolved,true);
  const failed=await w.journal.get(intent(w.hash));
  assert.deepEqual(failed.failure,{blockNumber:10,nonceFence:6});
  w.run.stub.set({getTxByHash:{result:200,response:w.consuming},getAddressNonce:{result:200,response:7},10:{result:200,response:w.block}});
  return failed;
}

test('native supersession preserves an intent previously resolved by the nonce fence',async t=>{
  const w=await supersessionWorld(t),failed=await fenceFailedIntent(w);
  const writes=()=>w.journal.puts.filter(key=>key===intent(w.hash)||key===lane(WALLET)).length,before=writes();
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  assert.deepEqual(await w.journal.get(intent(w.hash)),failed);
  assert.deepEqual(await w.journal.get(lane(WALLET)),failed);
  assert.equal(writes(),before,'already failed intents need no source update');
});

for(const stage of ['observed','differently failed'])test(`supersession proof refuses an intent already ${stage}`,async t=>{
  const w=await supersessionWorld(t);
  if(stage==='observed'){
    w.run.stub.set({getTxByHash:{result:200,response:{hash:w.hash,status:'confirmed',blockNumber:10,content:nodeProjection(w.signedTransaction.content)}},10:{result:200,response:{...w.block,content:{...w.block.content,ordered_transactions:[w.hash]}}}});
    assert.equal((await w.read()).disposition,'included');
    w.run.stub.set({getTxByHash:{result:200,response:w.consuming},10:{result:200,response:w.block}});
  }else{
    // A nonce-fence failure is now accepted as proof; a different supersession is not.
    const other={...await fenceFailedIntent(w),failure:{supersededByHash:sha('a-third-transfer'),blockNumber:10}};
    w.journal.seed(intent(w.hash),other);w.journal.seed(lane(WALLET),other);
  }
  const before=await w.journal.entries(),reads=w.run.stub.messages().length,writes=w.journal.puts.length;
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OTHER}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);
  assert.equal(w.journal.puts.length,writes);
  assert.equal(w.run.stub.messages().length,reads,'a terminal intent is refused before node reads');
});

test('supersession proof repairs only the lane from the retained matching failure without reads',async t=>{
  const w=await supersessionWorld(t),put=w.journal.put;
  w.journal.put=async(key,value)=>{if(key===lane(WALLET)&&value.stage==='failed')throw new Error('TEST interruption before lane write');return put(key,value);};
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  w.journal.put=put;
  const failed=await w.journal.get(intent(w.hash)),reads=w.run.stub.messages().length,writes=w.journal.puts.length;
  assert.equal(failed.failure.supersededByHash,OTHER);
  w.run.stub.set({getTransactionStatus:{result:200,response:{state:'unavailable'}}});
  assert.equal((await w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OTHER})).resolved,true);
  assert.equal(w.run.stub.messages().length,reads,'repair uses the original retained inclusion proof');
  assert.equal(w.journal.puts.length,writes+1,'repair writes only the unfinished lane');
  assert.deepEqual(await w.journal.get(intent(w.hash)),failed);
  assert.deepEqual(await w.journal.get(lane(WALLET)),failed);
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  assert.equal(w.run.stub.messages().length,reads,'the purchase also finishes from stored proof');
});

test('native supersession completion recovers after source commit without repeating source work',async t=>{
  const w=await supersessionWorld(t),resolve=w.protocol.nativePaymentSuperseded;
  w.protocol.nativePaymentSuperseded=async(...args)=>{await resolve(...args);throw new Error('TEST interruption before database completion marker');};
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  const reads=w.run.stub.messages().length,writes=w.journal.puts.length;
  assert.equal((await w.journal.get(lane(WALLET))).stage,'failed');
  assert.notEqual(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true);
  w.recreate();
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  assert.equal(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true);
  assert.equal(w.run.stub.messages().length,reads);
  assert.equal(w.journal.puts.length,writes);
});

test('native supersession records a repeated pending reason only once',async t=>{
  const w=await supersessionWorld(t);
  let reason='TEST source unavailable';
  w.protocol.nativePaymentSuperseded=async()=>{throw new Error(reason);};
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  await w.verify(w.a.id);
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,false);
  const pending=()=>w.ops.history(w.b.id).filter(e=>e.type==='native_supersession_pending');
  assert.equal(pending().length,1);
  reason='TEST source still held';
  await w.verify(w.b.id);await w.verify(w.a.id);
  assert.deepEqual(pending().map(e=>e.data.reason),['TEST source unavailable','TEST source still held']);
});

test('native supersession adds no source work when a settled owner superseded nothing',async t=>{
  const w=await supersessionWorld(t,'broadcast-started',true),writes=w.journal.puts.length;
  assert.equal((await w.verify(w.a.id)).verification.outcome,'verified');
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain');
  // A's own confirmed hash consumed the nonce of B's held intent: released once by own-nonce proof.
  assert.equal(w.journal.puts.length,writes+2);assert.equal((await w.journal.get(intent(w.hash))).failure.supersededByHash,OTHER);
  const reads=w.run.stub.messages().length;
  assert.equal((await w.verify(w.a.id)).verification.nativeNonceResolved,true);
  assert.equal(w.run.stub.messages().length,reads);
  assert.equal(w.journal.puts.length,writes+2);
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain');
});

for(const [label,reply] of [
  ['missing block',()=>({result:200,response:null})],
  ['unconfirmed block',(block)=>({result:200,response:{...block,status:'failed'}})],
  ['different block number',(block)=>({result:200,response:{...block,number:11}})],
  ['absent failed hash',(block)=>({result:200,response:{...block,content:{...block.content,ordered_transactions:[OTHER]}}})],
  ['pending block',(block)=>({result:200,response:{...block,status:'pending'}})],
  ['unavailable block',()=>({result:503,response:'TEST block unavailable'})],
])test(`failed native resolution holds both lanes for ${label} until confirmed membership`,async t=>{
  const w=await supersessionWorld(t);
  const block={...w.block,content:{...w.block.content,ordered_transactions:[w.hash]}};
  w.run.stub.set({getTxByHash:{result:200,response:{hash:w.hash,status:'failed',blockNumber:10,content:nodeProjection(w.signedTransaction.content)}},getAddressNonce:{result:200,response:6},10:{result:200,response:block}});
  w.coordinates.reportHash(w.b.id,w.hash);
  const verified=await w.verify(w.b.id);
  assert.equal(verified.verification.outcome,'execution_failed');assert.equal(verified.operation.status,'payment_uncertain');
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  w.run.stub.set({10:reply(block)});
  const code=label==='unavailable block'?'upstream_unavailable':'readback_unverified';
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,failedNonceFence:6}),{code});
  try {
    const cancelled=await w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id});
    assert.equal(cancelled.cancelled,false);assert.equal(cancelled.operation.status,'payment_uncertain');
  }catch(error){assert.equal(error.code,code);}
  assert.deepEqual(await w.journal.entries(),before,'inconsistent block readback retains no failure evidence');
  assert.equal(w.journal.puts.length,writes);
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain');
  assert.equal(w.coordinates.get(w.b.id).verifiedAt,null);assert.equal(w.coordinates.get(w.b.id).observation.slotConsumed,false);
  const bound=await w.run.bind();assert.ok(bound.pending);
  await assert.rejects(w.run.capability.binding({phase:'signature',address:WALLET,binding:bound.binding}),{code:'outcome_unknown'});
  w.run.stub.set({10:{result:200,response:block}});
  const resolved=await w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id});
  assert.equal(resolved.cancelled,true);assert.equal(resolved.operation.status,'cancelled');
  assert.equal((await w.run.bind()).pending,null);
  const retained=await w.journal.get(intent(w.hash));
  assert.equal(retained.stage,'failed');assert.deepEqual(retained.failure,{blockNumber:10,nonceFence:6});
  assert.deepEqual(retained.signedTransaction,w.signedTransaction);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

for(const path of ['failed native','confirmed inclusion','supersession']) {
  for(const [label,membership] of [
    ['hash string',(hash)=>hash],
    ['containing string',(hash)=>`prefix:${hash}:suffix`],
    ['hash-keyed object',(hash)=>({[hash]:true})],
    ['null',()=>null],
    ['missing',()=>undefined],
  ])test(`block membership requires an array: ${path}, ${label}`,async t=>{
    const w=path==='supersession'?await supersessionWorld(t):await world(t,undefined,{txStatus:path==='failed native'?'failed':'confirmed'});
    const hash=path==='supersession'?OTHER:w.hash;
    w.run.stub.set({10:{result:200,response:{number:10,status:'confirmed',hash:BLOCK,content:{ordered_transactions:membership(hash)}}}});
    const before=await w.journal.entries(),writes=w.journal.puts.length;
    const request={phase:'readback',address:WALLET,hash:w.hash,...(path==='failed native'?{failedNonceFence:6}:path==='supersession'?{consumedByHash:OTHER}:{})};
    await assert.rejects(w.run.capability.binding(request),{code:'readback_unverified'});
    assert.deepEqual(await w.journal.entries(),before);
    assert.equal(w.journal.puts.length,writes,'malformed membership retains no intent or lane evidence');
    const bound=await w.run.bind();assert.equal(bound.pending.hash,w.hash);
    await assert.rejects(w.run.capability.binding({phase:'signature',address:WALLET,binding:bound.binding}),{code:'outcome_unknown'});
    assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
  });
}

for(const [label,change] of Object.entries({
  'different sender':(tx)=>{tx.content.from=PAYEE;delete tx.content.from_ed25519_address;},
  'different nonce owner':(tx)=>{tx.content.from_ed25519_address=PAYEE;},
  'different nonce owner and signer':(tx)=>{tx.content.from=PAYEE;tx.content.from_ed25519_address=PAYEE;},
  'different nonce':(tx)=>{tx.content.nonce=8;},
  'unknown status':(tx)=>{tx.status='pending';},
  'different hash':(tx)=>{tx.hash=sha('another-body');},
  'different network':(tx)=>{tx.content.network='another-network';},
  'different chain':(tx)=>{tx.content.chainIdentity=sha('another-chain');},
  'different block':(tx)=>{tx.blockNumber=11;},
}))test(`native supersession refuses ${label}`,async t=>{
  const w=await supersessionWorld(t),before=await w.journal.entries();change(w.consuming);
  w.run.stub.set({getTxByHash:{result:200,response:w.consuming}});
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OTHER}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.ok((await w.run.bind()).pending);
});

for(const [label,change] of [
  ['unconfirmed block',(b)=>{b.status='pending';}],
  ['absent block membership',(b)=>{b.content.ordered_transactions=[];}],
])test(`native supersession refuses ${label}`,async t=>{
  const w=await supersessionWorld(t),before=await w.journal.entries();change(w.block);
  w.run.stub.set({10:{result:200,response:w.block}});
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OTHER}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.ok((await w.run.bind()).pending);
});

const negatives={
  'wrong nonce':(v)=>{v.nonce='8';},
  'non-canonical nonce':(v)=>{v.nonce='07';},
  'wrong timestamp':(v)=>{v.timestamp=String(Number(v.timestamp)+1);},
  'non-canonical timestamp':(v)=>{v.timestamp=`+${v.timestamp}`;},
  'wrong amount':(v)=>{v.amount+=1;},
  'ambiguous decimal amount':(v)=>{v.amount='2500000000.0';},
  'unsafe numeric amount':(v)=>{v.amount=Number.MAX_SAFE_INTEGER+1;},
  'fractional numeric amount':(v)=>{v.amount=2500000000.5;},
  'negative numeric amount':(v)=>{v.amount=-2500000000;},
  'wrong network fee':(v)=>{v.transaction_fee.network_fee+=1;},
  'wrong rpc fee':(v)=>{v.transaction_fee.rpc_fee+=1;},
  'wrong additional fee':(v)=>{v.transaction_fee.additional_fee=1;},
  'unsafe numeric fee':(v)=>{v.transaction_fee.network_fee=Number.MAX_SAFE_INTEGER+1;},
  'fractional numeric fee':(v)=>{v.transaction_fee.network_fee=1000000000.5;},
  'ambiguous string fee':(v)=>{v.transaction_fee.rpc_fee='02000000000';},
  'different fee recipient':(v)=>{v.transaction_fee.rpc_address=WALLET;},
  'tampered data':(v)=>{v.data[1].args[1]='2500000001';},
  'tampered debit edit':(v)=>{v.gcr_edits[0].amount='-5500000001';},
  'different payer':(v)=>{v.from=PAYEE;},
  'different payee':(v)=>{v.to=WALLET;},
  'different type':(v)=>{v.type='identity';},
  'extra field':(v)=>{v.executionHint='accepted';},
};

for(const [label,change] of Object.entries(negatives))test(`Node2 native readback rejects ${label}; retained intent stays fenced and no resend occurs`,async t=>{
  const w=await world(t,(value)=>{change(value);return value;});
  await assert.rejects(w.read(),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),[[intent(w.hash),w.issued],[lane(WALLET),w.issued]]);
  assert.deepEqual(w.journal.puts,[]);
  assert.deepEqual(w.run.stub.messages().filter((message)=>message!=='getBlockByNumber'),['getTransactionStatus','getTxByHash']);
});

test('Node2 native readback rejects a different transaction hash before releasing the retained intent',async t=>{
  const w=await world(t,(value)=>value,{txHash:OTHER});
  await assert.rejects(w.read(),{code:'readback_unverified'});
  assert.deepEqual(w.journal.puts,[]);
  assert.equal((Object.fromEntries(await w.journal.entries()))[intent(w.hash)].stage,'broadcast-accepted');
});

async function unissuedSupersessionWorld(t) {
  const signed=signTransaction(signedContent());
  const w=await supersessionWorld(t,'broadcast-started',true,{signed,unissued:true});
  w.coordinates.recordObservation(w.b.id,{txHash:OTHER,supersededBy:w.a.id,slotConsumed:true},false);
  w.ops.transition(w.b.id,'payment_uncertain','superseded',{data:{supersededBy:w.a.id,txHash:OTHER}});
  // The .invalid stub models the confirmation received before A consumed the slot.
  const confirmation={result:200,response:{data:{valid:true,transaction:signed}}};
  w.run.stub.set({'GET /':confirmation});
  return {...w,signed,confirmation};
}

for(const stage of ['signed','confirmed'])test(`native supersession waits for an unjournaled ${stage} lease`,async t=>{
  const w=await unissuedSupersessionWorld(t);
  const binding=(await w.run.bind()).binding;
  const lease=await w.run.capability.binding({phase:'signature',address:PAYER,binding});
  try{
    if(stage==='confirmed')await w.run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:w.signed}]},sdkHeaders());
    const result=await w.verify(w.b.id);
    assert.equal(result.verification.nativeLaneResolved,false);
    assert.notEqual(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true);
    assert.equal(await w.journal.get(intent(w.hash)),undefined,'a browser lease has not issued a journal intent');
    const owner=await w.verify(w.a.id);
    assert.equal(owner.operation.status,'settled_verified');
    assert.notEqual(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true,'owner recheck also preserves the pending repair');
    if(stage==='confirmed'){
      const before=await unclaimed(w.journal),writes=unclaimedPuts(w.journal);
      await w.run.capability.binding({phase:'broadcast',address:PAYER,leaseId:lease.leaseId,hash:w.hash});
      await assert.rejects(w.run.capability.rpc({method:'execute',params:[{extra:'broadcastTx',data:w.confirmation}]},sdkHeaders()),{code:'nonce_consumed'});
      assert.deepEqual(await unclaimed(w.journal),before);assert.equal(unclaimedPuts(w.journal),writes);
      assert.ok(!w.run.stub.messages().includes('broadcastTx'));
      assert.equal((await w.run.bind()).pending,null,'the pre-confirmed lease cannot issue new held evidence after cleanup');
    }
  }finally{await w.run.capability.binding({phase:'release',address:PAYER,leaseId:lease.leaseId});}
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  assert.equal(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true);
});

async function failedPaymentWorld(t,options={}) {
  const w=await supersessionWorld(t,'broadcast-started',false,options);
  const body={hash:w.hash,status:'failed',blockNumber:10,content:nodeProjection(w.signedTransaction.content)};
  const block={...w.block,content:{...w.block.content,ordered_transactions:[w.hash]}};
  w.run.stub.set({getTxByHash:{result:200,response:body},getAddressNonce:{result:200,response:{nonce:6}},10:{result:200,response:block}});
  w.coordinates.reportHash(w.b.id,w.hash);
  assert.equal((await w.verify(w.b.id)).verification.outcome,'execution_failed');
  return {...w,body};
}

test('purchase-only failed source readback preserves execution_failed and nonce-proof cancellation',async t=>{
  const w=await failedPaymentWorld(t,{signed:signTransaction(signedContent())});
  w.run.stub.set({10:{result:200,response:{...w.block,content:{...w.block.content,ordered_transactions:[w.hash]}}}});
  let bodies=0;
  w.run.stub.set({getTxByHash:()=>new Response(JSON.stringify({result:200,response:{...w.body,status:++bodies===1?'confirmed':'failed'}}),{status:200,headers:{'content-type':'application/json'}})});
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  const result=await w.verify(w.b.id);
  assert.equal(result.verification.observation.status,'included');assert.equal(bodies,3,'buyer checks the fresh canonical body after source failure readback');
  assert.equal(result.verification.outcome,'execution_failed');assert.equal(result.operation.status,'payment_uncertain');
  assert.equal(result.verification.slotConsumed,false);assert.equal(result.verification.txStatus,'failed');assert.equal(w.coordinates.get(w.b.id).verifiedAt,null);
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  bodies=0;
  await assert.rejects(w.run.capability.chainReader().observeTransfer(w.hash),{code:'readback_unverified'});
  bodies=0;
  const cancelled=await w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id});
  assert.equal(cancelled.cancelled,true);assert.equal(cancelled.operation.status,'cancelled');
  assert.deepEqual((await w.journal.get(intent(w.hash))).failure,{blockNumber:10,nonceFence:6});
  assert.equal((await w.run.bind()).pending,null);assert.equal(w.coordinates.get(w.b.id).verifiedAt,null);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

test('native supersession cannot complete between replacement confirmation and its later broadcast',async t=>{
  const signed=signTransaction(signedContent());
  const w=await supersessionWorld(t,'broadcast-started',false,{signed,unissued:true,bStatus:'payment_handoff'});
  const confirmation={result:200,response:{data:{valid:true,transaction:signed}}};
  w.run.stub.set({'GET /':confirmation,getAddressNonce:{result:200,response:6}});
  const bound=(await w.run.bind()).binding;
  const lease=await w.run.capability.binding({phase:'signature',address:PAYER,binding:bound});
  try{
    await w.run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:signed}]},sdkHeaders());
    assert.equal(await w.journal.get(intent(w.hash)),undefined);
    w.run.stub.set({getAddressNonce:{result:200,response:7}});
    // The application reads the same pinned stub independently of the browser's held connection.
    const chain=createDemosChainReader({rpcUrl:w.run.capability.pins.endpoint,network:NETWORK,pinnedIdentity:CHAIN,fetchImpl:w.run.stub.fetchImpl});
    const purchases=createPurchaseService({db:w.db,config:{},ops:w.ops,coordinates:w.coordinates,chain,protocol:w.protocol});
    const settled=await purchases.verifyDeal({accountId:'TEST-buyer',operationId:w.a.id});
    assert.equal(settled.operation.status,'settled_verified');assert.equal(settled.verification.outcome,'verified');
    assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'superseded');
    assert.notEqual(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true,'the confirmed browser lease keeps cleanup pending');
    const before=await unclaimed(w.journal),writes=unclaimedPuts(w.journal);
    await w.run.capability.binding({phase:'broadcast',address:PAYER,leaseId:lease.leaseId,hash:w.hash});
    await assert.rejects(w.run.capability.rpc({method:'execute',params:[{extra:'broadcastTx',data:confirmation}]},sdkHeaders()),{code:'nonce_consumed'});
    assert.deepEqual(await unclaimed(w.journal),before);assert.equal(unclaimedPuts(w.journal),writes);
    assert.ok(!w.run.stub.messages().includes('broadcastTx'));
  }finally{await w.run.capability.binding({phase:'release',address:PAYER,leaseId:lease.leaseId});}
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  const leaseAfter=await w.run.capability.binding({phase:'signature',address:PAYER,binding:(await w.run.bind()).binding});
  await w.run.capability.binding({phase:'release',address:PAYER,leaseId:leaseAfter.leaseId});
});

for(const [transient,fresh] of [
  ['pending','failed'],['unavailable','failed'],['invalid body','failed'],
  ['pending','pending'],['unavailable','confirmed'],
])test(`source-backed failed native cancel re-reads after ${transient}: ${fresh}`,async t=>{
  const w=await failedPaymentWorld(t),observe=w.chain.observePurchaseTransfer,getTransaction=w.chain.getTransaction;
  const view=(state)=>{
    w.chain.observePurchaseTransfer=['pending','unavailable'].includes(state)?async()=>({status:state}):observe;
    w.chain.getTransaction=state==='invalid body'?async hash=>{const body=await getTransaction(hash);delete body.hash;return body;}:getTransaction;
  };
  view(transient);
  assert.equal((await w.verify(w.b.id)).operation.status,'payment_uncertain');
  assert.equal(Object.hasOwn(w.coordinates.get(w.b.id).observation,'txStatus'),false);
  view(fresh);
  if(fresh==='confirmed')w.run.stub.set({getTxByHash:{result:200,response:{...w.body,status:'confirmed'}},getAddressNonce:{result:200,response:{nonce:7}}});
  const proof=w.protocol.nativePaymentFailed;let sourceProofs=0;
  w.protocol.nativePaymentFailed=(...args)=>{sourceProofs++;return proof(...args);};
  const reads=w.run.stub.messages().length;
  const result=await w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id});
  assert.equal(result.cancelled,fresh==='failed');
  assert.equal(result.operation.status,fresh==='failed'?'cancelled':fresh==='confirmed'?'settled_verified':'payment_uncertain');
  const retained=await w.journal.get(intent(w.hash));
  if(fresh==='failed'){
    assert.equal(sourceProofs,1,'the real protocol performs source failure readback');
    assert.ok(w.run.stub.messages().slice(reads).filter(x=>x==='getAddressNonce').length>=2,'wrapped nonce is read by the application and source transport');
    assert.deepEqual(retained.failure,{blockNumber:10,nonceFence:6});
    assert.equal(retained.stage,'failed');assert.equal((await w.run.bind()).pending,null);
    const bound=(await w.run.bind()).binding;
    const lease=await w.run.capability.binding({phase:'signature',address:WALLET,binding:bound});
    await w.run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});
  }else if(fresh==='pending'){
    assert.equal(sourceProofs,0);assert.equal(retained.stage,'broadcast-started');assert.ok((await w.run.bind()).pending);
  }else{assert.equal(retained.stage,'observed');assert.equal((await w.run.bind()).pending,null);}
  assert.deepEqual(retained.signedTransaction,w.signedTransaction);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

for(const order of ['cancel source proof first','settlement commit first'])test(`source-backed failed native cancellation races confirmed verification: ${order}`,async t=>{
  const w=await failedPaymentWorld(t),getAddressNonce=w.chain.getAddressNonce,getTransaction=w.chain.getTransaction;
  let nonceRead,releaseNonce,bodyRead,releaseBody;
  const nonceStarted=new Promise(resolve=>{nonceRead=resolve;}),nonceHeld=new Promise(resolve=>{releaseNonce=resolve;});
  const bodyStarted=new Promise(resolve=>{bodyRead=resolve;}),bodyHeld=new Promise(resolve=>{releaseBody=resolve;});
  w.chain.getAddressNonce=async address=>{const nonce=await getAddressNonce(address);nonceRead();await nonceHeld;return nonce;};
  w.chain.getTransaction=async hash=>{const body=await getTransaction(hash);if(body.status==='confirmed'){bodyRead();await bodyHeld;}return body;};
  let cancelling,verifying;
  try{
    cancelling=w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id});
    await nonceStarted;
    w.run.stub.set({getTxByHash:{result:200,response:{...w.body,status:'confirmed'}},getAddressNonce:{result:200,response:7}});
    verifying=w.verify(w.b.id);
    await bodyStarted;
    assert.equal((await w.journal.get(intent(w.hash))).stage,'observed','confirmed source readback finishes before the database write');
    assert.equal(w.coordinates.get(w.b.id).verifiedAt,null);
    if(order==='cancel source proof first'){
      releaseNonce();const result=await cancelling;
      assert.equal(result.cancelled,false,'the source now sees confirmed, so the earlier application nonce cannot cancel');
      assert.equal(result.operation.status,'payment_uncertain');
      assert.equal(w.coordinates.get(w.b.id).verifiedAt,null);
      releaseBody();
    }else{
      releaseBody();assert.equal((await verifying).operation.status,'settled_verified');
      releaseNonce();const result=await cancelling;
      assert.equal(result.cancelled,false);assert.equal(result.operation.status,'settled_verified');
    }
    const result=await verifying;
    assert.equal(result.operation.status,'settled_verified');assert.equal(result.verification.outcome,'verified');
    assert.equal(w.ops.get('TEST-buyer',w.b.id).status,result.operation.status);
    assert.ok(w.coordinates.get(w.b.id).verifiedAt);
    assert.equal(w.ops.history(w.b.id).filter(event=>event.type==='settled_verified').length,1);
    assert.equal((await w.journal.get(intent(w.hash))).stage,'observed');
    assert.equal((await w.run.bind()).pending,null);
    assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
  }finally{
    releaseNonce();releaseBody();await Promise.allSettled([cancelling,verifying]);
    w.chain.getAddressNonce=getAddressNonce;w.chain.getTransaction=getTransaction;
  }
});

test('source-backed completed failed native cancellation permits a later confirmed settlement',async t=>{
  const w=await failedPaymentWorld(t);
  const cancelled=await w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id});
  assert.equal(cancelled.cancelled,true);assert.equal(cancelled.operation.status,'cancelled');
  assert.equal((await w.journal.get(intent(w.hash))).stage,'failed');
  assert.equal((await w.run.bind()).pending,null);
  w.run.stub.set({getTxByHash:{result:200,response:{...w.body,status:'confirmed'}},getAddressNonce:{result:200,response:7}});
  const result=await w.verify(w.b.id);
  assert.equal(result.operation.status,'settled_verified');assert.equal(result.verification.outcome,'verified');
  assert.ok(w.coordinates.get(w.b.id).verifiedAt);assert.equal((await w.journal.get(intent(w.hash))).stage,'observed');
  assert.equal(w.ops.history(w.b.id).filter(event=>event.type==='settled_verified').length,1);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

test('native supersession refuses a later stale-lease broadcast before retaining a lane',async t=>{
  const w=await unissuedSupersessionWorld(t);
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  const binding=(await w.run.bind()).binding;
  const lease=await w.run.capability.binding({phase:'signature',address:PAYER,binding});
  const before=await unclaimed(w.journal),writes=unclaimedPuts(w.journal);
  try{
    await w.run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:w.signed}]},sdkHeaders());
    await w.run.capability.binding({phase:'broadcast',address:PAYER,leaseId:lease.leaseId,hash:w.hash});
    // Node2 rejects this nonce; the transport must refuse before creating the intent.
    w.run.stub.set({'GET /':{result:400,response:{message:'Failed to add transaction to mempool'},extra:{confirmationBlock:null,error:'Invalid nonce for transaction'}}});
    await assert.rejects(w.run.capability.rpc({method:'execute',params:[{extra:'broadcastTx',data:w.confirmation}]},sdkHeaders()),{code:'nonce_consumed'});
    assert.deepEqual(await unclaimed(w.journal),before);assert.equal(unclaimedPuts(w.journal),writes);
    assert.ok(!w.run.stub.messages().includes('broadcastTx'));
    assert.equal((await w.run.bind()).pending,null);
    assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  }finally{await w.run.capability.binding({phase:'release',address:PAYER,leaseId:lease.leaseId});}
});

for(const interleaving of ['signature acquiring','lease during scan'])test(`native supersession stays pending: ${interleaving}`,async t=>{
  const w=await unissuedSupersessionWorld(t),binding=(await w.run.bind()).binding;
  let read,resume,paused=false,lease,signing,resolving;
  const started=new Promise(resolve=>{read=resolve;}),held=new Promise(resolve=>{resume=resolve;});
  const get=w.journal.get,entries=w.journal.entries;
  try{
    if(interleaving==='signature acquiring'){
      w.journal.get=async key=>{if(key===lane(PAYER)&&!paused){paused=true;read();await held;}return get(key);};
      signing=w.run.capability.binding({phase:'signature',address:PAYER,binding});
      await started;
      resolving=w.verify(w.b.id);
    }else{
      w.journal.entries=async()=>{const rows=await entries();read();await held;return rows;};
      resolving=w.verify(w.b.id);
      await started;
      lease=await w.run.capability.binding({phase:'signature',address:PAYER,binding});
      resume();
    }
    assert.equal((await resolving).verification.nativeLaneResolved,false);
    assert.notEqual(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true);
  }finally{
    resume();
    await Promise.allSettled([resolving]);
    if(signing)lease=await signing;
    if(lease)await w.run.capability.binding({phase:'release',address:PAYER,leaseId:lease.leaseId});
    w.journal.get=get;w.journal.entries=entries;
  }
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
});

test('public binding route refuses server-only lane proofs before the source transport',async t=>{
  const w=await world(t,undefined,{txStatus:'failed'});
  const app=express();app.use(createWalletRpcRouter({config:{publicOrigin:'https://dacs.test'},logger:null,nativeTransport:w.run.capability,buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const post=async body=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/portal/api/devnet-native-wallet-binding`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const before=await w.journal.entries(),writes=w.journal.puts.length,reads=w.run.stub.messages().length;
  for(const proof of [{failedNonceFence:6},{consumedByHash:OTHER},{failedNonceFence:null}]){
    assert.deepEqual(await post({phase:'readback',address:WALLET,hash:w.hash,...proof}),{status:400,body:{error:'invalid_params'}},JSON.stringify(proof));
  }
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.equal(w.run.stub.messages().length,reads,'a refused body makes no node RPC');
  const read=await post({phase:'readback',address:WALLET,hash:w.hash});
  assert.equal(read.status,200);assert.equal(read.body.disposition,'failed');assert.equal(read.body.resolved,false);
  assert.ok(w.run.stub.messages().length>reads,'a plain readback still reaches the source transport');
  assert.deepEqual(await w.journal.entries(),before);assert.ok((await w.run.bind()).pending);
});

async function interruptedFenceCancel(t) {
  const w=await failedPaymentWorld(t),put=w.journal.put;
  w.journal.put=async(key,value)=>{if(key===lane(WALLET)&&value.stage==='failed')throw new Error('TEST interruption before lane write');return put(key,value);};
  await w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id}).catch(()=>null);
  w.journal.put=put;
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain');
  assert.deepEqual((await w.journal.get(intent(w.hash))).failure,{blockNumber:10,nonceFence:6});
  assert.equal((await w.run.bind()).pending.hash,w.hash,'the interrupted cancel leaves the source lane held');
  // A's old transfer now consumes the nonce, so the fence can never be re-proven.
  w.run.stub.set({getTxByHash:{result:200,response:w.consuming},getAddressNonce:{result:200,response:7},10:{result:200,response:w.block}});
  return w;
}

test('native supersession releases a lane held behind a retained nonce-fence failure',async t=>{
  const w=await interruptedFenceCancel(t),failed=await w.journal.get(intent(w.hash));
  const laneWrites=()=>w.journal.puts.filter(key=>key===lane(WALLET)).length,before=laneWrites();
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'superseded');
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);
  assert.equal(laneWrites(),before+1,'the lane is released exactly once');
  assert.deepEqual(await w.journal.get(lane(WALLET)),failed);assert.deepEqual(await w.journal.get(intent(w.hash)),failed);
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,true);assert.equal(laneWrites(),before+1);
  assert.equal((await w.run.bind()).pending,null);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

test('native supersession still refuses a retained failure superseded by a different hash',async t=>{
  const w=await interruptedFenceCancel(t);
  const other={...await w.journal.get(intent(w.hash)),failure:{supersededByHash:sha('a-third-transfer'),blockNumber:10}};
  w.journal.seed(intent(w.hash),other);
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  assert.equal((await w.verify(w.b.id)).verification.nativeLaneResolved,false);
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OTHER}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.equal((await w.run.bind()).pending.hash,w.hash);
});

test('purchase settlement requires a failed source readback to agree with the confirmed body read',async t=>{
  const w=await failedPaymentWorld(t),answers=['confirmed','failed','confirmed'];
  let bodies=0;
  w.run.stub.set({getTxByHash:()=>new Response(JSON.stringify({result:200,response:{...w.body,status:answers[bodies++]??'confirmed'}}),{status:200,headers:{'content-type':'application/json'}})});
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  const result=await w.verify(w.b.id);
  assert.equal(bodies,3,'SDK observation, source readback and canonical body are each read once');
  assert.notEqual(result.operation.status,'settled_verified',JSON.stringify(result.verification));assert.notEqual(result.verification.outcome,'verified');
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain');assert.equal(result.verification.observation.sourceDisposition,'failed');
  assert.equal(w.coordinates.get(w.b.id).verifiedAt,null);assert.equal(w.coordinates.get(w.b.id).observation.slotConsumed,false);
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.equal((await w.run.bind()).pending.hash,w.hash);
  // Every read now agrees on confirmed, so the next verification settles normally.
  w.run.stub.set({getTxByHash:{result:200,response:{...w.body,status:'confirmed'}},getAddressNonce:{result:200,response:{nonce:7}}});
  const settled=await w.verify(w.b.id);
  assert.equal(settled.operation.status,'settled_verified');assert.equal(settled.verification.outcome,'verified');
  assert.ok(w.coordinates.get(w.b.id).verifiedAt);assert.equal((await w.journal.get(intent(w.hash))).stage,'observed');
  assert.equal(w.ops.history(w.b.id).filter(event=>event.type==='settled_verified').length,1);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

const OWN=sha('node2-native-transfer-readback:own-nonce-replacement');
// B's own reported replacement, signed outside the source transport, consumes B's nonce.
async function ownNonceWorld(t,options={}) {
  const w=await supersessionWorld(t,'broadcast-started',false,options);
  w.run.stub.set({getTxByHash:{result:200,response:{...w.consuming,hash:OWN}},10:{result:200,response:{...w.block,content:{...w.block.content,ordered_transactions:[OWN]}}}});
  return {...w,report:(purchases=w.purchases)=>purchases.verifyDeal({accountId:'TEST-buyer',operationId:w.b.id,txHash:OWN})};
}

test('a confirmed different hash at a purchase\'s own nonce releases its retained source intent once',async t=>{
  const w=await ownNonceWorld(t),laneWrites=()=>w.journal.puts.filter(key=>key===lane(WALLET)).length;
  assert.equal((await w.run.bind()).pending.hash,w.hash);
  const settled=await w.report();
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.txHash,OWN);
  assert.equal(laneWrites(),1,'the retained source lane is released exactly once');
  assert.equal(settled.verification.nativeNonceResolved,true);
  const row=await w.journal.get(intent(w.hash));
  assert.equal(row.stage,'failed');assert.equal(row.failure.supersededByHash,OWN);assert.deepEqual(row.signedTransaction,w.signedTransaction);
  assert.equal((await w.run.bind()).pending,null);
  assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  const reads=w.run.stub.messages().length,writes=w.journal.puts.length,history=w.ops.history(w.b.id);
  w.recreate();
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,true);
  assert.equal(w.journal.puts.length,writes,'a repeated verify_deal makes no journal writes');
  assert.equal(w.run.stub.messages().length,reads);assert.deepEqual(w.ops.history(w.b.id),history);
  const lease=await w.run.capability.binding({phase:'signature',address:WALLET,binding:(await w.run.bind()).binding});
  await w.run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

test('own-nonce source reconciliation stays pending while a signature lease is in flight',async t=>{
  const w=await ownNonceWorld(t,{unissued:true});
  const lease=await w.run.capability.binding({phase:'signature',address:WALLET,binding:(await w.run.bind()).binding});
  // The intent was retained under an older lease; this lease makes the wallet non-idle.
  const issued={...w.issued,stage:'broadcast-started'};w.journal.seed(intent(w.hash),issued);w.journal.seed(lane(WALLET),issued);
  try{
    const before=await w.journal.entries(),writes=w.journal.puts.length;
    // The application reads the same pinned stub independently of the browser's held connection.
    const chain=createDemosChainReader({rpcUrl:w.run.capability.pins.endpoint,network:NETWORK,pinnedIdentity:CHAIN,fetchImpl:w.run.stub.fetchImpl});
    const settled=await w.report(createPurchaseService({db:w.db,config:{},ops:w.ops,coordinates:w.coordinates,chain,protocol:w.protocol}));
    assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,false);
    assert.notEqual(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
    assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
    assert.deepEqual(await w.journal.get(lane(WALLET)),issued,'the source lane stays held');
  }finally{await w.run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});}
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,true);
  assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  assert.equal((await w.run.bind()).pending,null);
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

test('failed native cancellation refuses a negative block height before any journal write',async t=>{
  const w=await failedPaymentWorld(t),proof=w.protocol.nativePaymentFailed;
  const block={...w.block,number:-1,content:{...w.block.content,ordered_transactions:[w.hash]}};
  // The application's own reads stay valid; the source failure proof reads height -1.
  let sourceProofs=0;
  w.protocol.nativePaymentFailed=(...args)=>{
    sourceProofs++;
    w.run.stub.set({getTransactionStatus:{result:200,response:{state:'included',blockNumber:-1}},getTxByHash:{result:200,response:{...w.body,blockNumber:-1}},'-1':{result:200,response:block}});
    return proof(...args);
  };
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  let cancelled=null;
  try{cancelled=await w.purchases.cancel({accountId:'TEST-buyer',operationId:w.b.id});}catch(error){assert.equal(error.code,'readback_unverified');}
  if(cancelled){assert.equal(cancelled.cancelled,false);assert.equal(cancelled.operation.status,'payment_uncertain');}
  assert.equal(sourceProofs,1,'cancellation reaches the source failure proof');
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain');assert.equal(w.coordinates.get(w.b.id).verifiedAt,null);
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  const bound=await w.run.bind();assert.equal(bound.pending.hash,w.hash);
  await assert.rejects(w.run.capability.binding({phase:'signature',address:WALLET,binding:bound.binding}),{code:'outcome_unknown'});
  assert.ok(!w.run.stub.messages().some(x=>['confirmTx','broadcastTx'].includes(x)));
});

// An alternate signing key: `from` is another key, the nonce owner is the buyer wallet.
const ALT=`0x${'a'.repeat(64)}`;
const ownNonceBody=(w,change)=>{const body=clone({...w.consuming,hash:OWN});change(body.content);w.run.stub.set({getTxByHash:{result:200,response:body}});return body;};
const sends=(w)=>w.run.stub.messages().filter(x=>['confirmTx','broadcastTx'].includes(x));
// Answers getTransactionStatus per hash: the retained transfer gets `own`, every other hash stays included at 10.
const retainedStatus=(w,own={state:'unknown'})=>{
  const hashes=[];
  w.run.stub.set({getTransactionStatus:(entry,data)=>{hashes.push(data?.hash);return new Response(JSON.stringify({result:200,response:data?.hash===w.hash?own:{state:'included',blockNumber:10}}),{status:200,headers:{'content-type':'application/json'}});}});
  return hashes;
};

test('own-nonce reconciliation accepts an alternate signer once the bound sender nonce is consumed',async t=>{
  const w=await ownNonceWorld(t),laneWrites=()=>w.journal.puts.filter(key=>key===lane(WALLET)).length;
  ownNonceBody(w,c=>{c.from=ALT;c.from_ed25519_address=WALLET;});retainedStatus(w);
  const reads=w.run.stub.messages().length;
  const settled=await w.report();
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.txHash,OWN);
  assert.equal(settled.verification.nativeNonceResolved,true,JSON.stringify(settled.verification));
  assert.equal(laneWrites(),1,'the retained source lane is released exactly once');
  assert.ok(w.run.stub.messages().slice(reads).includes('getAddressNonce'),'the alternate-signer proof reads the bound sender nonce');
  const row=await w.journal.get(intent(w.hash));
  assert.equal(row.stage,'failed');assert.equal(row.failure.supersededByHash,OWN);assert.deepEqual(row.signedTransaction,w.signedTransaction);
  assert.equal((await w.run.bind()).pending,null);
  assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,true);assert.equal(laneWrites(),1);
  assert.deepEqual(sends(w),[]);
});

test('own-nonce reconciliation holds an alternate signer until the bound sender nonce advances',async t=>{
  const w=await ownNonceWorld(t),laneWrites=()=>w.journal.puts.filter(key=>key===lane(WALLET)).length;
  ownNonceBody(w,c=>{c.from=ALT;c.from_ed25519_address=WALLET;});retainedStatus(w);
  w.run.stub.set({getAddressNonce:{result:200,response:6}});
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  const settled=await w.report();
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,false);
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OWN}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.notEqual(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  assert.equal((await w.run.bind()).pending.hash,w.hash,'the source lane stays held');
  w.run.stub.set({getAddressNonce:{result:200,response:7}});
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,true);
  assert.equal(laneWrites(),1);assert.equal((await w.run.bind()).pending,null);
  assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  assert.deepEqual(sends(w),[]);
});

test('an alternate-signer proof refuses while the retained transfer itself is included',async t=>{
  const w=await ownNonceWorld(t);
  // The alternate key's nonce let r land too; r, not OWN, may have consumed the bound sender nonce.
  ownNonceBody(w,c=>{c.from=ALT;c.from_ed25519_address=WALLET;});retainedStatus(w,{state:'included',blockNumber:10});
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OWN}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  const settled=await w.report();
  assert.notEqual(settled.verification.nativeNonceResolved,true,JSON.stringify(settled.verification));
  assert.notEqual(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.equal((await w.run.bind()).pending.hash,w.hash,'the source lane still holds r');
  assert.deepEqual(sends(w),[]);
});

// Only the pinned node's absent answer, exactly {state:'unknown'}, proves r was not included.
for(const own of [{state:'pending'},{state:'unavailable'},{state:'Included'},{state:'confirmed'},{state:'Unknown'},{},null])test(`an alternate-signer proof refuses the retained transfer status ${JSON.stringify(own)}`,async t=>{
  const w=await ownNonceWorld(t);
  ownNonceBody(w,c=>{c.from=ALT;c.from_ed25519_address=WALLET;});retainedStatus(w,own);
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OWN}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  if(own?.state==='unavailable'){
    const settled=await w.report();
    assert.notEqual(settled.verification.nativeNonceResolved,true,JSON.stringify(settled.verification));
    assert.notEqual(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
    assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  }
  assert.equal((await w.run.bind()).pending.hash,w.hash,'the source lane still holds r');
  assert.deepEqual(sends(w),[]);
});

test('an alternate-signer proof refused on a pending retained status releases once the node answers unknown',async t=>{
  const w=await ownNonceWorld(t),laneWrites=()=>w.journal.puts.filter(key=>key===lane(WALLET)).length;
  ownNonceBody(w,c=>{c.from=ALT;c.from_ed25519_address=WALLET;});retainedStatus(w,{state:'pending'});
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  const settled=await w.report();
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.notEqual(settled.verification.nativeNonceResolved,true);
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.equal((await w.run.bind()).pending.hash,w.hash,'the source lane stays held');
  retainedStatus(w);
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,true);
  assert.equal(laneWrites(),1,'the retained source lane is released exactly once');
  assert.equal((await w.run.bind()).pending,null);assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,true);assert.equal(laneWrites(),1);
  assert.deepEqual(sends(w),[]);
});

test('an alternate-signer proof reads the bound sender nonce before the retained transfer status',async t=>{
  const w=await ownNonceWorld(t);
  ownNonceBody(w,c=>{c.from=ALT;c.from_ed25519_address=WALLET;});const hashes=retainedStatus(w);
  const reads=w.run.stub.messages().length;
  assert.equal((await w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OWN})).resolved,true);
  assert.deepEqual(w.run.stub.messages(reads).filter(m=>['getAddressNonce','getTransactionStatus'].includes(m)),['getTransactionStatus','getAddressNonce','getTransactionStatus']);
  assert.deepEqual(hashes,[OWN,w.hash],'OWN is read first, r only after the nonce');
  assert.equal((await w.run.bind()).pending,null);assert.deepEqual(sends(w),[]);
});

for(const [label,change] of [
  ['from_ed25519_address names a different wallet',c=>{c.from_ed25519_address=ALT;}],
  ['both fields name a different wallet',c=>{c.from=ALT;c.from_ed25519_address=ALT;}],
])test(`own-nonce proof refuses a competing transfer: ${label}`,async t=>{
  const w=await ownNonceWorld(t);
  ownNonceBody(w,change);
  const before=await w.journal.entries(),writes=w.journal.puts.length;
  const reported=await w.report();
  assert.equal(reported.verification.outcome,'pointer_rejected',JSON.stringify(reported.verification));
  await assert.rejects(w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,consumedByHash:OWN}),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.equal((await w.run.bind()).pending.hash,w.hash);
  assert.deepEqual(sends(w),[]);
});

// A settles with a body signed by an alternate key (from=ALT, from_ed25519_address=WALLET);
// B is a native purchase whose retained intent r (signed by WALLET) holds the same nonce.
async function altOwnerWorld(t,{nonce=7,own={state:'unknown'},...options}={}) {
  const w=await supersessionWorld(t,'broadcast-started',false,{ownerUnretained:true,...options});
  w.consuming.content.from=ALT;retainedStatus(w,own);
  w.run.stub.set({getTxByHash:{result:200,response:w.consuming},getAddressNonce:{result:200,response:nonce}});
  return {...w,laneWrites:()=>w.journal.puts.filter(key=>key===lane(WALLET)).length,superseded:()=>w.ops.history(w.b.id).filter(event=>event.type==='superseded').length};
}
const assertBHeld=async(w,{before,writes,history,status='payment_uncertain'})=>{
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,status,'B keeps its blocking state');
  assert.equal(w.coordinates.get(w.b.id).observation?.supersededBy,undefined,'B has no supersededBy observation');
  assert.deepEqual(w.ops.history(w.b.id),history);
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  assert.equal((await w.run.bind()).pending.hash,w.hash,'B still holds its source lane');
  assert.deepEqual(sends(w),[]);
};

for(const [label,options] of [['the bound sender nonce is not consumed',{nonce:6}],['r answers pending',{own:{state:'pending'}}]])test(`an alternate-signer settlement leaves a competing native purchase open while ${label}`,async t=>{
  const w=await altOwnerWorld(t,options);
  const before=await w.journal.entries(),writes=w.journal.puts.length,history=w.ops.history(w.b.id);
  const settled=await w.verify(w.a.id);
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));
  assert.equal(settled.verification.nativeNonceResolved,false);assert.match(settled.verification.nextStep,/Retry verify_deal/);
  await assertBHeld(w,{before,writes,history});
});

test('an alternate-signer settlement supersedes a competing native purchase once the lane proof resolves its retained intent',async t=>{
  const w=await altOwnerWorld(t);w.coordinates.reportHash(w.b.id,w.hash);
  const settled=await w.verify(w.a.id);
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,true);
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'superseded');assert.equal(w.superseded(),1);
  const evidence=w.coordinates.get(w.b.id).observation;
  assert.equal(evidence.supersededBy,w.a.id);assert.equal(evidence.nativeLaneResolved,true);assert.equal(evidence.txHash,OTHER);
  assert.equal(w.laneWrites(),1,'the lane is released exactly once');
  const row=await w.journal.get(intent(w.hash));assert.equal(row.stage,'failed');assert.equal(row.failure.supersededByHash,OTHER);
  assert.equal((await w.run.bind()).pending,null);
  const reads=w.run.stub.messages().length,writes=w.journal.puts.length;
  const again=await w.verify(w.b.id);
  assert.equal(again.verification.outcome,'superseded');assert.equal(again.verification.nativeLaneResolved,true);
  assert.equal(w.run.stub.messages().length,reads,'the recorded resolution is not re-proved');assert.equal(w.journal.puts.length,writes);
  assert.equal(w.superseded(),1);assert.deepEqual(sends(w),[]);
  assert.equal(settled.verification.signedByAlternateKey,true);
});

// Contradictory single-node views: B's own wallet-signed hash was read confirmed
// at nonce 7 (a mismatch), then a failed read put B back in payment_uncertain.
// The journal later releases that hash and A's alternate-signed settlement
// overwrites B's observation; the durable record still counts B's nonce use.
for(const kind of ['purchase','publication'])test(`an alternate-signer supersession of a competitor keeps its recorded wallet-signed nonce use for a nonce-lagging ${kind} handoff`,async t=>{
  const w=await altOwnerWorld(t);w.coordinates.reportHash(w.b.id,w.hash);
  const view={...w.chain,observePurchaseTransfer:undefined,
    observeTransfer:async()=>({status:'included',txHash:w.hash,blockNumber:10,payer:WALLET,payee:PAYEE,amountOs:'1'}),
    getTransaction:async()=>({hash:w.hash,status:'confirmed',blockNumber:10,content:{from:WALLET,nonce:7}})};
  const viewed=createPurchaseService({db:w.db,config:{},ops:w.ops,coordinates:w.coordinates,chain:view});
  const mismatch=await viewed.verifyDeal({accountId:'TEST-buyer',operationId:w.b.id});
  assert.equal(mismatch.operation.status,'payment_mismatch',JSON.stringify(mismatch.verification));assert.equal(mismatch.verification.slotConsumed,true);
  view.observeTransfer=async()=>({status:'failed',txHash:w.hash,reason:'TEST-view-changed'});
  assert.equal((await viewed.verifyDeal({accountId:'TEST-buyer',operationId:w.b.id})).operation.status,'payment_uncertain');
  const carried=w.coordinates.get(w.b.id);
  assert.equal(carried.reportedTxHash,w.hash);assert.equal(carried.observation.slotConsumedCarried,true);assert.equal(carried.observation.signedByAlternateKey,undefined);
  const settled=await w.verify(w.a.id);
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,true);
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'superseded');assert.equal(w.superseded(),1);
  const evidence=w.coordinates.get(w.b.id).observation;
  assert.equal(evidence.txHash,OTHER);assert.equal(evidence.signedByAlternateKey,true,'the supersession replaced B\'s wallet-signed observation');
  assert.deepEqual(w.coordinates.walletConsumedSenderNonce(WALLET,NETWORK,7).map(({operationId})=>operationId),[w.b.id]);
  // A handoff whose nonce read still lags (6) would reuse nonce 7.
  const lagging={network:NETWORK,pinnedIdentity:CHAIN,evidenceMode:'public-chain-read',networkIdentity:async()=>({mode:'public-chain-read',identity:CHAIN}),getAddressNonce:async()=>6,readStorageProgram:async()=>({status:'absent'})};
  const expiresAt=new Date(Date.now()+60000).toISOString();
  const {protocol:_,...plain}=w.b.terms;
  const c=kind==='purchase'
    ?w.ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:'TEST-lagging-C',request:{key:'TEST-lagging-C'},status:'approved',terms:plain,termsHash:sha('TEST-lagging-C'),expiresAt})
    :w.ops.createIdempotent({accountId:'TEST-buyer',kind:'listing_publication',idempotencyKey:'TEST-lagging-C',request:{key:'TEST-lagging-C'},status:'listing_signed',terms:{wallet:WALLET,network:NETWORK},termsHash:sha('TEST-lagging-C'),expiresAt,
      state:{signedListing:{listingId:'TEST-listing',listingVersion:1,seller:{identity:{presentedBy:`did:demos:agent:${WALLET.slice(2)}`}}}}});
  const verifier={verify:async()=>({transactable:true,contentHash:plain.listing.contentHash,price:plain.price,payee:PAYEE,evidence:{chainMode:'public-chain-read'}})};
  const service=kind==='purchase'?createPurchaseService({db:w.db,config:{demAmountEncoding:'os-string'},ops:w.ops,coordinates:w.coordinates,chain:lagging,verifier})
    :createAgentService({db:w.db,config:{},ops:w.ops,coordinates:w.coordinates,chain:lagging});
  await assert.rejects(service.prepareHandoff({operationId:c.operation.id,token:c.handoffToken}),{code:'nonce_readback_unavailable'});
  assert.equal(w.coordinates.get(c.operation.id),null);assert.equal(w.ops.get('TEST-buyer',c.operation.id).status,kind==='purchase'?'approved':'listing_signed');
  assert.deepEqual(sends(w),[]);
});

test('an alternate-signer settlement retried after a pending retained status supersedes the competing purchase once',async t=>{
  const w=await altOwnerWorld(t,{own:{state:'pending'}});w.coordinates.reportHash(w.b.id,w.hash);
  const before=await w.journal.entries(),writes=w.journal.puts.length,history=w.ops.history(w.b.id);
  assert.equal((await w.verify(w.a.id)).verification.nativeNonceResolved,false);
  await assertBHeld(w,{before,writes,history});
  retainedStatus(w);
  const retried=await w.verify(w.a.id);
  assert.equal(retried.verification.outcome,'verified');assert.equal(retried.verification.nativeNonceResolved,true);
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'superseded');assert.equal(w.coordinates.get(w.b.id).observation.nativeLaneResolved,true);
  assert.equal(w.laneWrites(),1);assert.equal((await w.run.bind()).pending,null);
  assert.equal((await w.verify(w.a.id)).verification.nativeNonceResolved,true);
  assert.equal(w.superseded(),1,'B is superseded exactly once');assert.equal(w.laneWrites(),1);
  assert.deepEqual(sends(w),[]);
});

test('an alternate-signer settlement leaves a hashless competitor open even after the lane proof releases its retained intent',async t=>{
  const w=await altOwnerWorld(t);
  const history=w.ops.history(w.b.id),evidence=w.coordinates.get(w.b.id);
  const settled=await w.verify(w.a.id);
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,true);
  const row=await w.journal.get(intent(w.hash));assert.equal(row.stage,'failed');assert.equal(row.failure.supersededByHash,OTHER);
  assert.equal(w.laneWrites(),1);assert.equal((await w.run.bind()).pending,null);
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain','B keeps its blocking state');
  assert.deepEqual(w.ops.history(w.b.id),history);assert.deepEqual(w.coordinates.get(w.b.id),evidence);assert.equal(w.superseded(),0);
  // B resolves through its existing pointer path: A's verified hash supersedes it.
  const resolved=await w.purchases.verifyDeal({accountId:'TEST-buyer',operationId:w.b.id,txHash:OTHER});
  assert.equal(resolved.operation.status,'superseded',JSON.stringify(resolved.verification));assert.equal(resolved.verification.nativeLaneResolved,true);
  assert.equal(w.superseded(),1);assert.deepEqual(sends(w),[]);
});

// B's transfer failed execution and B was cancelled with the nonce-fence proof:
// that proves only B's transfer can never land, not that WALLET's nonce was used.
const fenceFailed=(w)=>{const failed={...w.issued,stage:'failed',failure:{blockNumber:10,nonceFence:6}};w.journal.seed(intent(w.hash),failed);w.journal.seed(lane(WALLET),failed);};

test('an alternate-signer settlement never supersedes a hashless competitor on a fence-only journal',async t=>{
  const w=await altOwnerWorld(t,{nonce:6,bStatus:'cancelled'});fenceFailed(w);
  // C reserves the same nonce in payment_handoff: no reported hash and no retained intent.
  const c=w.ops.createIdempotent({accountId:'TEST-buyer',kind:'purchase',idempotencyKey:'TEST-handoff-C',request:{key:'TEST-handoff-C'},status:'payment_handoff',terms:w.b.terms,termsHash:sha('TEST-handoff-C'),expiresAt:new Date(Date.now()+60000).toISOString(),state:{protocol:{stage:'seller-committed'}}}).operation;
  w.coordinates.save({operationId:c.id,kind:'native-dem-transfer',network:NETWORK,from:WALLET,nonceFence:6,expectedNonce:7,target:PAYEE,amountOs:'2500000000',payload:{...w.signedTransaction,hash:sha('TEST-handoff-C')}});
  const history=w.ops.history(c.id),evidence=w.coordinates.get(c.id),before=await w.journal.entries();
  const settled=await w.verify(w.a.id);
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,true);
  assert.equal(w.ops.get('TEST-buyer',c.id).status,'payment_handoff','C keeps its open handoff');
  assert.deepEqual(w.ops.history(c.id),history);assert.deepEqual(w.coordinates.get(c.id),evidence);
  assert.deepEqual(await w.journal.entries(),before,'the fence failure stays fence-only');assert.deepEqual(sends(w),[]);
});

test('an alternate-signer settlement never supersedes a competitor whose reported hash is only fence-failed',async t=>{
  const w=await altOwnerWorld(t,{nonce:6});fenceFailed(w);w.coordinates.reportHash(w.b.id,w.hash);
  const history=w.ops.history(w.b.id),evidence=w.coordinates.get(w.b.id),before=await w.journal.entries();
  const settled=await w.verify(w.a.id);
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,true);
  assert.equal(w.ops.get('TEST-buyer',w.b.id).status,'payment_uncertain','B keeps its blocking state');
  assert.deepEqual(w.ops.history(w.b.id),history);assert.deepEqual(w.coordinates.get(w.b.id),evidence);assert.equal(w.superseded(),0);
  assert.deepEqual(await w.journal.entries(),before);assert.deepEqual(sends(w),[]);
});

test('an alternate-signer settlement does not supersede on a vacuous proof without a source capability',async t=>{
  const w=await altOwnerWorld(t);
  // The same stores and chain, but the fixture native payment profile has no source journal to examine.
  const protocol=createProtocolPurchases({db:w.db,ops:w.ops,coordinates:w.coordinates,dacsProtocol:{sellerEndpoint:()=>w.run.capability.pins.endpoint,sellerSr2Commitment:{commitmentSubstrate:'fixture',publicProjection:true},walletAgreement:{rpcUrl:'http://127.0.0.1:9',network:NETWORK,journal:memoryJournal(),bridgeFor:()=>null},nativeAgreementPayment:{enabled:true}}});
  assert.equal(await protocol.nativePaymentSuperseded(w.b,{...w.coordinates.get(w.b.id),observation:{supersededBy:w.a.id}}),true,'the fixture proof returns true without reading anything');
  const purchases=createPurchaseService({db:w.db,config:{},ops:w.ops,coordinates:w.coordinates,chain:w.chain,protocol});
  const before=await w.journal.entries(),writes=w.journal.puts.length,history=w.ops.history(w.b.id);
  const settled=await purchases.verifyDeal({accountId:'TEST-buyer',operationId:w.a.id});
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));
  await assertBHeld(w,{before,writes,history});
});

test('an alternate-signer settlement leaves a competing purchase to settle on its own retained transfer',async t=>{
  const w=await altOwnerWorld(t,{nonce:6});
  const before=await w.journal.entries(),writes=w.journal.puts.length,history=w.ops.history(w.b.id);
  assert.equal((await w.verify(w.a.id)).operation.status,'settled_verified');
  await assertBHeld(w,{before,writes,history});
  // The node counted A against ALT, so r also landed at WALLET's nonce 7.
  const own={hash:w.hash,status:'confirmed',blockNumber:10,content:nodeProjection(w.signedTransaction.content)};
  w.run.stub.set({getTxByHash:(entry,data)=>new Response(JSON.stringify({result:200,response:data?.hash===w.hash?own:w.consuming}),{status:200,headers:{'content-type':'application/json'}}),
    getAddressNonce:{result:200,response:7},10:{result:200,response:{...w.block,content:{...w.block.content,ordered_transactions:[OTHER,w.hash]}}}});
  retainedStatus(w,{state:'included',blockNumber:10});
  const settled=await w.purchases.verifyDeal({accountId:'TEST-buyer',operationId:w.b.id,txHash:w.hash});
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.txHash,w.hash);
  assert.ok(w.coordinates.get(w.b.id).verifiedAt);assert.equal((await w.journal.get(intent(w.hash))).stage,'observed');
  assert.equal(w.superseded(),0,'B is never superseded');
  assert.deepEqual(sends(w),[]);
});

test('a temporary re-read of a reconciled payment_mismatch keeps nativeNonceResolved',async t=>{
  const w=await ownNonceWorld(t),laneWrites=()=>w.journal.puts.filter(key=>key===lane(WALLET)).length;
  ownNonceBody(w,c=>{c.amount=1000000000;c.data[1].args[1]='1000000000';});
  const mismatch=await w.report();
  assert.equal(mismatch.operation.status,'payment_mismatch',JSON.stringify(mismatch.verification));assert.equal(mismatch.verification.nativeNonceResolved,true);
  assert.equal(laneWrites(),1,'the retained source lane is released exactly once');
  assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  w.run.stub.set({getTransactionStatus:{result:200,response:{state:'unavailable'}}});
  const unavailable=await w.verify(w.b.id);
  assert.ok(['chain_unavailable','awaiting_inclusion'].includes(unavailable.verification.outcome),JSON.stringify(unavailable.verification));
  assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true,'the completed reconciliation survives an unverified re-read');
  w.run.stub.set({getTransactionStatus:{result:200,response:{state:'included',blockNumber:10}}});
  // A browser lease is in flight; a completed reconciliation never needs the source again.
  const lease=await w.run.capability.binding({phase:'signature',address:WALLET,binding:(await w.run.bind()).binding});
  try{
    const writes=w.journal.puts.length,pending=w.ops.history(w.b.id).filter(e=>e.type==='native_nonce_pending').length;
    const chain=createDemosChainReader({rpcUrl:w.run.capability.pins.endpoint,network:NETWORK,pinnedIdentity:CHAIN,fetchImpl:w.run.stub.fetchImpl});
    const again=await createPurchaseService({db:w.db,config:{},ops:w.ops,coordinates:w.coordinates,chain,protocol:w.protocol}).verifyDeal({accountId:'TEST-buyer',operationId:w.b.id});
    assert.equal(again.operation.status,'payment_mismatch');
    assert.equal(again.verification.nativeNonceResolved,true,JSON.stringify(again.verification));assert.equal(again.verification.nextStep,undefined);
    assert.equal(w.journal.puts.length,writes,'no journal writes');
    assert.equal(w.ops.history(w.b.id).filter(e=>e.type==='native_nonce_pending').length,pending,'nothing is reported pending');
  }finally{await w.run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});}
  assert.equal(laneWrites(),1);assert.deepEqual(sends(w),[]);
});

test('walletBinding refuses server-only lane proofs before any journal read, node RPC or sender auth',async t=>{
  const w=await world(t,undefined,{txStatus:'failed'}),get=w.journal.get;
  let gets=0;w.journal.get=async key=>{gets++;return get(key);};
  const before=await w.journal.entries(),writes=w.journal.puts.length,reads=w.run.stub.messages().length;
  for(const proof of [{failedNonceFence:6},{consumedByHash:OTHER},{failedNonceFence:null},{consumedByHash:undefined}]){
    for(const phase of ['readback','bind','signature']){
      await assert.rejects(w.run.capability.walletBinding({phase,address:WALLET,hash:w.hash,...proof},{}),{code:'invalid_params'},`${phase} ${JSON.stringify(proof)}`);
    }
  }
  assert.equal(gets,0,'no journal read');assert.equal(w.run.stub.messages().length,reads,'no node RPC');
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  const read=await w.run.capability.walletBinding({phase:'readback',address:WALLET,hash:w.hash},{});
  assert.equal(read.disposition,'failed');assert.equal(read.resolved,false);
  assert.ok(gets>0&&w.run.stub.messages().length>reads,'a plain readback still reaches the source');
  assert.deepEqual(await w.journal.entries(),before);assert.ok((await w.run.bind()).pending);
  // Server-side callers keep the proof through binding().
  assert.equal((await w.run.capability.binding({phase:'readback',address:WALLET,hash:w.hash,failedNonceFence:6})).resolved,true);
  assert.equal((await w.run.bind()).pending,null);
});

// An abandoned browser signature lease expires on the transport clock.
async function expiredLeaseWorld(t) {
  let at=NOW;
  const signed=signTransaction(signedContent()),w=await ownNonceWorld(t,{unissued:true,signed,now:()=>at});
  const lease=await w.run.capability.binding({phase:'signature',address:PAYER,binding:(await w.run.bind()).binding});
  // The intent was retained under an older lease.
  const issued={...w.issued,stage:'broadcast-started'};w.journal.seed(intent(w.hash),issued);w.journal.seed(lane(PAYER),issued);
  const chain=createDemosChainReader({rpcUrl:w.run.capability.pins.endpoint,network:NETWORK,pinnedIdentity:CHAIN,fetchImpl:w.run.stub.fetchImpl});
  const settled=await w.report(createPurchaseService({db:w.db,config:{},ops:w.ops,coordinates:w.coordinates,chain,protocol:w.protocol}));
  assert.equal(settled.operation.status,'settled_verified',JSON.stringify(settled.verification));assert.equal(settled.verification.nativeNonceResolved,false);
  return {...w,lease,issued,signed,laneWrites:()=>w.journal.puts.filter(key=>key===lane(PAYER)).length,advance:(ms)=>{at+=ms;},expiry:lease.expiresAt-NOW};
}

test('own-nonce resolution releases the retained lane once an abandoned signature lease expires',async t=>{
  const w=await expiredLeaseWorld(t),before=await w.journal.entries(),writes=w.journal.puts.length;
  w.advance(w.expiry-1);
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,false,'a current lease still holds the wallet');
  assert.deepEqual(await w.journal.entries(),before);assert.equal(w.journal.puts.length,writes);
  w.advance(1);
  // Nothing can start under the expired lease.
  const replacement=signTransaction({...signedContent(),timestamp:signedContent().timestamp+5});
  await assert.rejects(w.run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:replacement}]},sdkHeaders()),{code:'network_binding_required'});
  await assert.rejects(w.run.capability.binding({phase:'broadcast',address:PAYER,leaseId:w.lease.leaseId,hash:replacement.hash}),{code:'network_binding_required'});
  const resolved=await w.verify(w.b.id);
  assert.equal(resolved.verification.nativeNonceResolved,true,JSON.stringify(resolved.verification));
  assert.equal(w.laneWrites(),1,'the retained source lane is released exactly once');
  assert.equal(w.coordinates.get(w.b.id).observation.nativeNonceResolved,true);
  assert.equal((await w.journal.get(intent(w.hash))).failure.supersededByHash,OWN);
  assert.equal((await w.run.bind()).pending,null);
  const next=await w.run.capability.binding({phase:'signature',address:PAYER,binding:(await w.run.bind()).binding});
  assert.notEqual(next.leaseId,w.lease.leaseId,'the expired lease was freed');
  await w.run.capability.binding({phase:'release',address:PAYER,leaseId:next.leaseId});
  assert.deepEqual(sends(w),[]);
});

test('an expired signature lease with a running confirm still blocks own-nonce resolution',async t=>{
  const w=await expiredLeaseWorld(t),before=await unclaimed(w.journal),writes=unclaimedPuts(w.journal);
  const replacement=signTransaction({...signedContent(),timestamp:signedContent().timestamp+5});
  let started,finish;const reached=new Promise(resolve=>{started=resolve;}),held=new Promise(resolve=>{finish=resolve;});
  w.run.stub.set({'GET /':async()=>{started();await held;return new Response(JSON.stringify({result:200,response:{data:{valid:true,transaction:replacement}}}),{status:200,headers:{'content-type':'application/json'}});}});
  const confirming=w.run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:replacement}]},sdkHeaders());
  try{
    await reached;
    w.advance(w.expiry+1);
    assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,false,'a running confirm keeps the expired lease');
    assert.deepEqual(await unclaimed(w.journal),before);assert.equal(unclaimedPuts(w.journal),writes);
    assert.equal((await w.journal.get(lane(PAYER))).stage,'broadcast-started');
  }finally{finish();await confirming.catch(()=>null);}
  assert.equal((await w.verify(w.b.id)).verification.nativeNonceResolved,true,'once the confirm exits, the expired lease is idle');
  assert.equal(w.laneWrites(),1);assert.equal((await w.run.bind()).pending,null);
  assert.ok(!w.run.stub.messages().includes('broadcastTx'));
});
