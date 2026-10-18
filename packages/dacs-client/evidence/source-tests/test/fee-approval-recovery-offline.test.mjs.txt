import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSecureContext } from 'node:tls';
import { isIP } from 'node:net';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import * as approvals from '../src/devnet-demo/operator-buyer-approval.mjs';
import * as buyerAccess from '../src/devnet-demo/buyer-access.mjs';
import * as signatures from '../src/wallet/demos-signature.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import * as purchases from '../src/purchases.mjs';
import * as sellerHttp from '../src/dacs/seller-http.mjs';
import { SELLER_TLS_PROBE_PATH } from '../src/devnet-demo/seller-tls.mjs';
import * as sessionLimits from '../public/portal/seller-session-limits.mjs';
import * as stop from '../src/devnet-demo/stop.mjs';
import { PURCHASE_TERMINAL_STATUSES } from '../src/purchases.mjs';

// Default repository discovery runs this same test file in a flagged child.
// VM import mocks keep the actual operator module and its recovery callback,
// while sockets, custody, seller and chain work are inert. The certificate
// is generated locally and parsed by the real validity check.
if(!vm.SourceTextModule){
  test('offline actual-operator fee approval recovery cases',()=>{
    const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,['--experimental-vm-modules','--disable-warning=ExperimentalWarning','--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{encoding:'utf8',timeout:60000,env:childEnv});
    assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,child.stdout+child.stderr);
    assert.match(child.stdout,/# fail 0/);assert.match(child.stdout,/# skipped 0/);
    assert.match(child.stdout,/^# tests 40$/m,'all forty recovery cases were discovered');
    assert.match(child.stdout,/^# pass 40$/m);
  });
}else{
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const clone=value=>structuredClone(value);
  const format='dacs-node2-operator-buyer-approval-evidence/v1';
  const source=await fsp.readFile(new URL('../src/devnet-demo/operator.mjs',import.meta.url),'utf8');
  const walletKeys=generateKeyPairSync('ed25519');
  const payer=`0x${walletKeys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex')}`,payee=`0x${'b'.repeat(64)}`;
  const buyer=signatures.claimForAddress(payer),seller=signatures.claimForAddress(payee),network='demos-devnet',chainIdentity='c'.repeat(64);
  const sourceBinding={bindingId:'d'.repeat(64),chainIdentity,endpoint:'https://source.invalid/',network,pinVersion:'TEST-fee-pin-v1',transportAuthority:'TEST-fee-source'};
  const listing={listingId:'fee-recovery',listingVersion:1,seller:{identity:{presentedBy:seller},displayName:'TEST',publicEndpoint:'https://seller.invalid/'},offering:{title:'TEST',description:'TEST',category:'TEST',tags:[]},pricing:{kind:'fixed',price:{amount:'1'}}};
  const listingHash=contentHash(listing),listingPin={listingId:listing.listingId,version:listing.listingVersion,contentHash:listingHash};
  const expectation={kind:'native-payment',address:payer,buyer,seller,listingId:listing.listingId,listingVersion:listing.listingVersion,listingContentHash:listingHash,jobId:'fee-job',agreementHash:'e'.repeat(64),network,chainIdentity,payee,amountOs:'1000000000'};
  const request={method:'sendTransaction',address:payer,purpose:`Send 1 DEM from this embedded wallet to ${payee}. Total debit 5 DEM: the amount, the SDK's 1 DEM gas and the node fees (explicit independently supplied transport pin; single node, not finality).`,content:{action:'native DEM transfer',from:payer,to:payee,amountOs:'1000000000',amountDem:'1',nonce:7,
    debit:{sellerAmountDem:'1',sdkGasDem:'1',networkFeeDem:'2',rpcFeeDem:'1',additionalFeeDem:'0',totalDem:'5',totalOs:'5000000000',note:'public complete debit'},network,
    evidence:'public source-supplied pin',networkBinding:{network,chainIdentity,pinVersion:sourceBinding.pinVersion,endpoint:sourceBinding.endpoint,transportAuthority:sourceBinding.transportAuthority,connectionId:'TEST-original-connection'},sending:'one original send only'}};
  const intent={format:'dacs-node2-operator-native-payment-intent/v1',payer,payee,amountOs:'1000000000',nonce:7,timestamp:1791259000000,data:['native',{nativeOperation:'send',args:[payee,'1000000000']}],network,chainIdentity,sourceBinding};
  const record={approvalOffset:0,scope:{buyer,seller,listing:listingPin},jobId:expectation.jobId,agreementHash:expectation.agreementHash,terms:{payee,amountOs:intent.amountOs}};
  function signedCandidate(postFork=true,change=()=>{}){
    const wire=os=>postFork?String(os):Number(BigInt(os)/1000000000n);
    const edit=(type,operation,account,amount)=>({type,operation,isRollback:false,account,txhash:'',amount});
    const content={type:'native',from:payer,from_ed25519_address:payer,to:payee,amount:wire(intent.amountOs),data:clone(intent.data),nonce:intent.nonce,timestamp:intent.timestamp,
      transaction_fee:{network_fee:wire('2000000000'),rpc_fee:wire('1000000000'),additional_fee:wire('0'),rpc_address:null},
      gcr_edits:[edit('balance','remove',payer,wire(intent.amountOs)),edit('balance','add',payee,wire(intent.amountOs)),edit('balance','remove',payer,wire('1000000000')),edit('nonce','add',payer,1)]};
    const row={networkBinding:{...clone(sourceBinding),connectionId:'TEST-reconnected-readback'},signedTransaction:{content}};
    change(row,wire);const hash=sha(JSON.stringify(content));row.hash=hash;row.signedTransaction.hash=hash;
    row.signedTransaction.signature={type:'ed25519',data:sign(null,Buffer.from(hash),walletKeys.privateKey).toString('hex')};
    assert.equal(signatures.verifyDemosSignature({address:payer,message:hash,signature:row.signedTransaction.signature.data}),true);
    return row;
  }
  const resign=row=>{row.hash=sha(JSON.stringify(row.signedTransaction.content));row.signedTransaction.hash=row.hash;row.signedTransaction.signature.data=sign(null,Buffer.from(row.hash),walletKeys.privateKey).toString('hex');return row;};
  function inertServer(){return{listening:false,once(){},off(){},listen(_port,_host,done){this.listening=true;done();},closeAllConnections(){},close(done){this.listening=false;done();}};}
  async function harness(t,{candidate=signedCandidate(),evidenceChange=()=>{},requestChange=()=>{},reject=false,readbackChange=()=>{},readbackError=false,extraCandidates=[]}={}){
    const root=await fsp.mkdtemp(path.join(tmpdir(),'fee-recovery-owned-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
    const stateDirectory=path.join(root,'state'),evidencePath=path.join(stateDirectory,'evidence','buyer-approvals.jsonl');
    let approvalCount=0,walletSends=0,reads=0,journalWrites=0;const closes=[];
    const controller=approvals.createExactBuyerApproval({maxTotalOs:'10000000000',evidencePath,authorize:()=>{approvalCount++;return !reject;},now:()=>1791259000000});
    controller.expect(expectation);const changedRequest=clone(request);requestChange(changedRequest);await controller.approve(changedRequest);
    const evidence=JSON.parse((await fsp.readFile(evidencePath,'utf8')).trim());const evidenceList=[evidence];evidenceChange(evidence,evidenceList);
    await fsp.writeFile(evidencePath,evidenceList.map(value=>JSON.stringify(value)).join('\n')+'\n',{mode:0o600});
    const tls=createLoopbackTestTlsMaterial({temporaryRoot:root});
    const tlsKey=path.join(root,'test-key.pem'),tlsCert=path.join(root,'test-cert.pem');await fsp.writeFile(tlsKey,tls.key,{mode:0o600});await fsp.writeFile(tlsCert,tls.cert,{mode:0o600});
    const config={format:'dacs-node2-demo-operator/v1',authority:'TEST-RUN-fee-recovery',publicOrigin:'http://127.0.0.1:10001',sellerOrigin:'https://127.0.0.1:10002',directoryOrigin:'http://127.0.0.1:10003',sellerTls:{keyPath:tlsKey,certificatePath:tlsCert},stateDirectory,custodyDirectory:path.join(root,'inert-custody'),networkAdmissionPath:path.join(root,'inert-admission'),
      listing:{listingId:listing.listingId,listingVersion:1,displayName:'TEST',title:'TEST',description:'TEST',category:'TEST',tags:[],priceDem:'1',validForMs:60000,deadlineSecAfterCommit:3600},sellerFeeBudget:{maxTotalOs:'10000000000'},buyerFeeBudget:{maxTotalOs:'10000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'TEST'}};
    const configPath=path.join(root,'config.json');await fsp.writeFile(configPath,JSON.stringify(config),{mode:0o600});
    const rows=[candidate,...extraCandidates].filter(Boolean).map(value=>[`devnet/native-transfer/${value.hash}`,value]);
    const journal={entries:async()=>clone(rows),inspectLocks:()=>[],close(){},put:async()=>{journalWrites++;throw new Error('TEST forbids journal write');}};
    const capability={transportBinding:clone(sourceBinding),journal,profile:()=>({}),close(){closes.push('source');},onStorageWriteResend:()=>()=>{},reserveRpcAuth:()=>{},binding:async input=>{
      reads++;assert.equal(input.phase,'readback');assert.equal(input.address,payer);assert.equal(input.hash,candidate.hash);if(readbackError)throw Object.assign(new Error('TEST offline unavailability'),{code:'TEST_UNAVAILABLE'});
      const answer={disposition:'included',receipt:{hash:candidate.hash,nonce:intent.nonce,blockNumber:9,blockHash:'f'.repeat(64),payer,payee,amount:candidate.signedTransaction.content.amount,network,chainIdentity,finality:'not-established',commitmentOnChain:false}};readbackChange(answer);return answer;
    }};
    const signer=address=>({address,claim:signatures.claimForAddress(address),signBytes:()=>Buffer.alloc(64)});
    let sellerTlsChecks=0;
    const testFetch=()=>{throw new Error('TEST forbids fetch');};
    const mocks={
      // Network is inert throughout this fee-recovery VM harness. Pin both
      // startup probes to its exact injected client; real TLS is exercised in
      // devnet-operator-seller-tls without these VM mocks.
      './seller-tls.mjs':{SELLER_TLS_PROBE_PATH,assertSellerTlsClientHandshake:async(origin,fetchImpl,defaultClient)=>{assert.equal(origin,config.sellerOrigin);assert.equal(fetchImpl,testFetch);assert.equal(defaultClient,false);sellerTlsChecks++;}},
      '../../public/portal/seller-session-limits.mjs':sessionLimits,
      'node:http':{default:{createServer:inertServer}},'node:https':{default:{createServer:inertServer}},'node:tls':{createSecureContext},'node:net':{isIP},'node:crypto':crypto,'node:fs':fs,'node:fs/promises':fsp,'node:path':path,
      // Preserve actual SDK canonicalization over JSON fixture values while
      // crossing the VM realm (SDK deliberately rejects foreign prototypes).
      '@kynesyslabs/dacs':{canonicalize:value=>canonicalize(JSON.parse(JSON.stringify(value))),contentHash:value=>contentHash(JSON.parse(JSON.stringify(value)))},'../config.mjs':{loadConfig:value=>({...value,commitOnSignature:value.DACS_COMMIT_ON_SIGNATURE==='on'})},
      '../dacs/listing.mjs':{buildListingDraft:()=>listing,buildUnsignedIdentityBundle:()=>({message:'TEST-public-listing'}),attachIdentityPresentation:()=>({}),DEM_RAIL:{railId:'TEST',railVersion:'1'}},
      '../dacs/purchase-protocol.mjs':{listingPin:()=>listingPin},'../dacs/demos-sr2-adapter.mjs':{createDemosSr2Adapter:()=>({}),createInMemoryDemosSr2Journal:()=>({})},
      '../dacs/demos-sr2-wallet-bridge.mjs':{createDemosSr2WalletBridge:()=>({})},'../dacs/native-payment-evidence-consumer.mjs':{createNativePaymentEvidenceConsumer:()=>({})},
      '../dacs/seller-sr2-agreement-consumer.mjs':{createSellerSr2AgreementAnchor:()=>({})},'../dacs/source-demo-seller-transport.mjs':{createSourceDemoSellerTransport:()=>({})},'../dacs/seller-http.mjs':{createSellerHttpHandler:()=>()=>{},loopbackSocket:sellerHttp.loopbackSocket,SellerTlsUnusableError:sellerHttp.SellerTlsUnusableError},
      '../dacs/seller-transport-auth.mjs':{createSellerTransportClientAuth:()=>({}),createSellerTransportServerAuth:()=>({}),createSellerTransportStore:()=>({close(){}}),verifySellerSessionDelegation:()=>{throw new Error('TEST forbids peer authentication');}},
      '../wallet/demos-signature.mjs':signatures,'../wallet/durable-journal.mjs':{openDurableWalletJournal:()=>journal},
      './party-vet-store.mjs':{openPartyVetStore:()=>({close(){}})},'../purchases.mjs':{PURCHASE_APPROVAL_TTL_MS:purchases.PURCHASE_APPROVAL_TTL_MS,PURCHASE_TERMINAL_STATUSES},'./operator-approval.mjs':{composeSellerApproval:()=>()=>false,createExactOperatorApproval:()=>({}),sellerApprovalSettings:()=>({mode:'manual'})},'./operator-buyer-approval.mjs':approvals,
      './operator-buyer.mjs':{createOperatorBuyerDriver:value=>value},'./operator-buyer-run.mjs':{openOperatorBuyerRunStore:async()=>({})},'./buyer-access.mjs':buyerAccess,'./seller-relay.mjs':{createInProcessSellerRelay:()=>{throw new Error('TEST forbids the seller relay');}},
      './operator-sessions.mjs':{SELLER_SESSION_KEY_GRACE_MS,createOperatorSellerSessions:()=>({request(){throw new Error('TEST forbids session delegation');},accept(){throw new Error('TEST forbids session delegation');},signerFor(){throw new Error('TEST forbids session signing');}})},
      './operator-custody.mjs':{ensureOperatorSecret:async()=>'TEST-cookie-placeholder',openTestWalletCustody:async({role})=>({signer:signer(role==='buyer'?payer:payee),wallet:{request:()=>{walletSends++;throw new Error('TEST forbids wallet send');}},close(){}})},
      './stop.mjs':stop,
      './operator-network.mjs':{readNode2Admission:async()=>({authority:config.authority,...sourceBinding}),createNode2TransportOwner:()=>({fetchImpl:()=>{throw new Error('TEST forbids network');},drain(){closes.push('owner-drain');},close(){closes.push('owner');}}),createAdmittedNode2DemoTransport:()=>capability},
    };
    // The owned stop's approval cut and its grace and plan bounds need these host globals.
    const context=vm.createContext({Buffer,URL,process,AbortController,setTimeout,clearTimeout}),module=new vm.SourceTextModule(source,{context,identifier:'actual-operator.mjs'});
    await module.link(specifier=>{assert.ok(Object.hasOwn(mocks,specifier),`unmocked ${specifier}`);const values=mocks[specifier],names=Object.keys(values);return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,values[name]);},{context});});await module.evaluate();
    const operator=await module.namespace.createDevnetDemoOperator({configPath,fetchImpl:testFetch,authorizeBuyerApproval:()=>{approvalCount++;throw new Error('TEST forbids new approval');}});
    // operator.close() alone stops everything (stop.mjs contract v1): the source after the drain, then the app and agent, once each.
    t.after(async()=>{await operator.close();assert.deepEqual(closes.filter((name,index)=>name!==closes[index-1]),['owner-drain','source','owner','application','agent']);});
    const readiness=(await operator.prepareDevnetDemo()).operatorEvidence.sellerTls;
    assert.equal(readiness.status,'ready');assert.equal(readiness.notAfter,new Date(new crypto.X509Certificate(tls.cert).validTo).toISOString());
    const composition={authority:config.authority,listing,published:{ref:'TEST-public-listing'}};
    const application={app:()=>{throw new Error('TEST forbids HTTP');},close:async()=>{closes.push('application');}};
    assert.equal(await operator.attachSellerAgent({sellerAgent:{claim:seller,listingPin,close(){closes.push('agent');}},application,composition}),stop.OWNED_SHUTDOWN);await operator.listen({application});
    assert.equal(sellerTlsChecks,2,'attachment and listen both check the injected client');
    const driver=operator.createBuyerDriver({composition});
    return{evidence,root,recover:(changedRecord=record,changedIntent=intent)=>driver.recoverIssuedPayment({record:clone(changedRecord),intent:clone(changedIntent)}),counts:()=>({approvalCount,walletSends,reads,journalWrites})};
  }
  async function assertHold(t,options={},reason=/count is [02]|missing, malformed|not uniquely|differs|readback|malformed|unreadable/){const h=await harness(t,options),before=h.counts(),outcome=await h.recover();assert.equal(outcome.status,'held');assert.match(outcome.reason,reason);assert.equal(h.counts().walletSends,0);assert.equal(h.counts().journalWrites,0);assert.equal(h.counts().approvalCount,before.approvalCount);return{h,outcome};}

  for(const postFork of [true,false])test(`actual operator recovers exact approved ${postFork?'OS-string':'whole-DEM'} signed candidate after fresh module construction`,async t=>{
    const candidate=signedCandidate(postFork),h=await harness(t,{candidate}),before=h.counts(),outcome=await h.recover();assert.equal(outcome.status,'recovered');assert.equal(outcome.transactionHash,candidate.hash);assert.equal(outcome.approvalHash,h.evidence.approvalHash);assert.deepEqual(h.counts(),{...before,reads:1});
    assert.equal(h.evidence.format,format);assert.deepEqual(h.evidence.approvedRequest,request);assert.equal(h.evidence.requestHash,sha(JSON.stringify(request)));assert.equal(h.evidence.approvalHash,sha(JSON.stringify({scope:h.evidence.scope,request})));
  });
  const candidateChanges={
    'same total different network/rpc fee split':(row,wire)=>{row.signedTransaction.content.transaction_fee.network_fee=wire('1000000000');row.signedTransaction.content.transaction_fee.rpc_fee=wire('2000000000');},
    'same total different additional fee split':(row,wire)=>{row.signedTransaction.content.transaction_fee.network_fee=wire('1000000000');row.signedTransaction.content.transaction_fee.additional_fee=wire('1000000000');},
    'different RPC fee recipient':row=>{row.signedTransaction.content.transaction_fee.rpc_address=payee;},
    'different RPC endpoint':row=>{row.networkBinding.endpoint='https://other.invalid/';},
    'different network':row=>{row.networkBinding.network='other-devnet';},
    'different chain identity':row=>{row.networkBinding.chainIdentity='1'.repeat(64);},
    'different pin version':row=>{row.networkBinding.pinVersion='TEST-other';},
    'different transport authority':row=>{row.networkBinding.transportAuthority='TEST-other';},
    'different binding id':row=>{row.networkBinding.bindingId='1'.repeat(64);},
    'conflicting signed network alias':row=>{row.signedTransaction.content.network='other-devnet';},
    'conflicting signed chain alias':row=>{row.signedTransaction.content.chainIdentity='1'.repeat(64);},
    'different signed gas debit':(row,wire)=>{row.signedTransaction.content.gcr_edits[2].amount=wire('2000000000');},
    'extra signed custom charge':row=>{row.signedTransaction.content.custom_charges={fee:'1'};},
  };
  for(const [label,change] of Object.entries(candidateChanges))test(`actual operator HOLD: authentic ${label}`,async t=>{const {h}=await assertHold(t,{candidate:signedCandidate(true,change)});assert.equal(h.counts().reads,0);});
  test('whole-DEM same-total split also holds',async t=>{const {h}=await assertHold(t,{candidate:signedCandidate(false,candidateChanges['same total different network/rpc fee split'])});assert.equal(h.counts().reads,0);});
  const evidenceChanges={
    'legacy hash-only evidence':entry=>{delete entry.approvedRequest;delete entry.requestProjectionFormat;},
    'missing request':entry=>{delete entry.approvedRequest;},
    'changed request hash':entry=>{entry.requestHash='1'.repeat(64);},
    'changed approval hash':entry=>{entry.approvalHash='1'.repeat(64);},
    'mutated exact request fees':entry=>{entry.approvedRequest.content.debit.networkFeeDem='1';entry.approvedRequest.content.debit.rpcFeeDem='2';},
    'unknown request field':entry=>{entry.approvedRequest.extra='not public schema';},
    'noncanonical fee encoding':entry=>{entry.approvedRequest.content.debit.networkFeeDem='2.0';},
    'duplicate approved evidence':(entry,list)=>list.push(clone(entry)),
    'malformed second evidence for same job':(entry,list)=>{const malformed=clone(entry);malformed.requestHash='broken';list.push(malformed);},
    'conflicting decision':(entry,list)=>{const rejected=clone(entry);rejected.decision='rejected';list.push(rejected);},
    'request unknown projection version':entry=>{entry.requestProjectionFormat='unknown';},
    'unassignable malformed native evidence':(entry,list)=>{const malformed=clone(entry);delete malformed.scope.jobId;list.push(malformed);},
    'unknown evidence format':entry=>{entry.format='unknown';},
  };
  for(const [label,evidenceChange] of Object.entries(evidenceChanges))test(`actual operator HOLD: ${label}`,async t=>{const {h}=await assertHold(t,{evidenceChange});assert.equal(h.counts().reads,0);});
  test('otherwise valid rehashed approval for a different RPC still holds',async t=>{const {h}=await assertHold(t,{requestChange:value=>{value.content.networkBinding.endpoint='https://other.invalid/';}});assert.equal(h.counts().reads,0);});
  test('rejected normal exact approval is not issuance authority',async t=>{const {h}=await assertHold(t,{reject:true});assert.equal(h.counts().reads,0);});
  test('missing candidate and invalid signature cannot recover',async t=>{await assertHold(t,{candidate:null});const invalid=signedCandidate();invalid.signedTransaction.signature.data='00'.repeat(64);await assertHold(t,{candidate:invalid});});
  test('two authentic approved candidates HOLD as ambiguous',async t=>{const second=signedCandidate();second.signedTransaction.content.gcr_edits[0].txhash='test-other-carrier';resign(second);const {h}=await assertHold(t,{extraCandidates:[second]});assert.equal(h.counts().reads,0);});
  test('unavailable and mismatching readback HOLD without new effects',async t=>{await assertHold(t,{readbackError:true});await assertHold(t,{readbackChange:answer=>{answer.receipt.payee=payer;}});});
  test('missing all approval evidence and malformed offset HOLD',async t=>{const h=await harness(t);await fsp.writeFile(path.join(h.root,'state/evidence/buyer-approvals.jsonl'),'');assert.equal((await h.recover()).status,'held');const other=await harness(t);assert.equal((await other.recover({...record,approvalOffset:-1})).status,'held');assert.equal(other.counts().reads,0);});
  test('unreadable JSON evidence HOLD without wallet or approval effects',async t=>{const h=await harness(t);await fsp.writeFile(path.join(h.root,'state/evidence/buyer-approvals.jsonl'),'malformed JSON\n');const before=h.counts(),outcome=await h.recover();assert.equal(outcome.status,'held');assert.match(outcome.reason,/unreadable/);assert.deepEqual(h.counts(),before);});
  test('valid unrelated native approval for another job does not authorize or make this job ambiguous',async t=>{const h=await harness(t,{evidenceChange:(entry,list)=>{const other=clone(entry);other.scope.jobId='other-job';other.approvalHash=sha(JSON.stringify({scope:other.scope,request:other.approvedRequest}));list.push(other);}});assert.equal((await h.recover()).status,'recovered');assert.equal(h.counts().walletSends,0);assert.equal(h.counts().approvalCount,1);});
  test('normal sign approval remains hash-only and exact expectation remains consumed',async t=>{
    const root=await fsp.mkdtemp(path.join(tmpdir(),'fee-sign-owned-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const evidencePath=path.join(root,'evidence');let count=0;
    const controller=approvals.createExactBuyerApproval({maxTotalOs:'5000000000',evidencePath,authorize:()=>{count++;return true;}});controller.expect({...expectation,kind:'payment-terms',message:'TEST exact terms'});
    assert.equal(await controller.approve({method:'sign',address:payer,message:'TEST exact terms'}),true);const evidence=JSON.parse((await fsp.readFile(evidencePath,'utf8')).trim());assert.equal(evidence.approvedRequest,undefined);assert.equal(count,1);assert.equal(controller.hasPending(),false);await assert.rejects(controller.approve(request),/no exact/);
  });
  test('normal native ceiling and scope mismatch still reject before approval',async t=>{
    const root=await fsp.mkdtemp(path.join(tmpdir(),'fee-scope-owned-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));let count=0;const controller=approvals.createExactBuyerApproval({maxTotalOs:'4000000000',evidencePath:path.join(root,'evidence'),authorize:()=>{count++;return true;}});
    controller.expect(expectation);await assert.rejects(controller.approve(request),/ceiling/);controller.expect(expectation);const wrong=clone(request);wrong.content.to=payer;await assert.rejects(controller.approve(wrong),/differs/);assert.equal(count,0);
  });
  test('TTY remains mandatory without injected test authorization, boolean flags do not authorize',async t=>{
    const root=await fsp.mkdtemp(path.join(tmpdir(),'fee-tty-owned-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));const controller=approvals.createExactBuyerApproval({maxTotalOs:'5000000000',evidencePath:path.join(root,'evidence'),approved:true});controller.expect(expectation);
    assert.equal(Boolean(process.stdin.isTTY&&process.stderr.isTTY),false);await assert.rejects(controller.approve(request),/interactive TTY/);assert.equal(fs.existsSync(path.join(root,'evidence')),false);
  });
}
