import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCanonicalJobId } from '@kynesyslabs/dacs';
import { createApp } from '../src/app.mjs';
import { createDevnetDemoComposition } from '../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../src/devnet-demo/operator-network.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { SELLER_TRANSPORT_HEADER, createSellerTransportClientAuth, sellerSessionDelegationSigningBytes } from '../src/dacs/seller-transport-auth.mjs';
import { startOperatorNode2 } from './helpers/devnet-operator-node2.mjs';

const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});

async function startOperator(t,{openBuyerAccess,removeBuyerCustody=false}){
  const node2=await startOperatorNode2();t.after(()=>node2.close());
  const root=await realpath(await mkdtemp(join(tmpdir(),'devnet-operator-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const [appPort,sellerPort,directoryPort]=await Promise.all([freePort(),freePort(),freePort()]);
  const publicOrigin=`http://127.0.0.1:${appPort}`,sellerOrigin=`https://127.0.0.1:${sellerPort}`,directoryOrigin=`http://127.0.0.1:${directoryPort}`;
  const custodyDirectory=join(root,'custody'),stateDirectory=join(root,'state');
  const custody=await bootstrapTestWalletCustody({directory:custodyDirectory,publicOrigin});
  assert.equal(custody.wallets.length,2);assert.notEqual(custody.wallets[0].address,custody.wallets[1].address);
  if(removeBuyerCustody)await rm(custody.wallets.find((wallet)=>wallet.role==='buyer').path);
  const observation=await observeNode2Identity({endpoint:node2.endpoint,network:'demos-devnet',fetchImpl:node2.fetchImpl});
  const authority='TEST-RUN-operator-startup-001';
  const admission=admitObservedNode2Identity({observation,authority,transportAuthority:'TEST-owned-operator-node2',pinVersion:'TEST-operator-pin-v1',reviewedChainIdentity:observation.chainIdentity});
  const admissionPath=join(root,'admission.json');await writeFile(admissionPath,`${JSON.stringify(admission)}\n`,{mode:0o600});
  const sellerKeyPath=join(root,'seller-key.pem'),sellerCertificatePath=join(root,'seller-cert.pem');
  await writeFile(sellerKeyPath,node2.key,{mode:0o600});await writeFile(sellerCertificatePath,node2.cert,{mode:0o600});
  const config={format:'dacs-node2-demo-operator/v1',authority,publicOrigin,sellerOrigin,sellerTls:{keyPath:sellerKeyPath,certificatePath:sellerCertificatePath},directoryOrigin,stateDirectory,custodyDirectory,networkAdmissionPath:admissionPath,
    listing:{listingId:'operator-native-report',listingVersion:1,displayName:'Operator Seller',title:'Node2 purchased report',description:'A seller-produced report returned only after the fixed-price DEM lifecycle.',category:'services.market-report',tags:['report','node2'],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
    sellerFeeBudget:{maxTotalOs:'10000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'Purchased Node2 report bytes from the operator content service.'},...(openBuyerAccess===undefined?{}:{openBuyerAccess})};
  const configPath=join(root,'operator.json');await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
  const approvals=[];
  const testFetch=(url,options)=>new URL(url).protocol==='https:'?node2.fetchImpl(url,options):fetch(url,options);
  const operator=await createDevnetDemoOperator({configPath,fetchImpl:testFetch,authorizeSellerApproval:({approvalHash,request})=>{approvals.push({approvalHash,request});return true;}});
  t.after(()=>operator.close());
  const prepared=await operator.prepareDevnetDemo();
  assert.equal((await fetch(prepared.devnetAgreementTransport.profile(publicOrigin).rpcUrl)).status,200);
  const {Demos}=await import('../public/portal/embedded-wallet/demos-runtime.mjs');const probe=new Demos();
  try{await probe.connect(prepared.devnetAgreementTransport.profile(publicOrigin).rpcUrl);}catch(error){t.diagnostic(JSON.stringify({directSdkConnectError:error.message,code:error.code,cause:error.cause?.message}));throw error;}finally{probe.disconnect();}
  let composition;try{composition=await createDevnetDemoComposition(prepared.composition);}catch(error){const evidence=await readFile(join(stateDirectory,'evidence','seller-approvals.jsonl'),'utf8').catch((readError)=>`READ-ERROR:${readError.message}`);t.diagnostic(JSON.stringify({publicationError:error.message,cause:error.cause?.message,code:error.cause?.code,approvalCount:approvals.length,evidence}));throw error;}
  const application=await createApp({config:prepared.config,dacsProtocol:composition.dacsProtocol,devnetAgreementTransport:prepared.devnetAgreementTransport,fetchImpl:testFetch});const state={applicationClosed:false};
  t.after(()=>state.applicationClosed?undefined:application.close());
  await operator.attachSellerAgent({sellerAgent:composition.sellerAgent,application,composition});
  const running=await operator.listen({application,composition});t.after(()=>running.close());
  assert.ok(approvals.length>=1);assert.ok(approvals.every((entry)=>entry.request.method==='sendTransaction'&&BigInt(entry.request.content.debit.totalOs)<=10000000000n));
  const approvalLines=(await readFile(join(stateDirectory,'evidence','seller-approvals.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(approvalLines.length,approvals.length);assert.ok(approvalLines.every((line)=>line.decision==='approved'));
  const health=await fetch(`${publicOrigin}/health`).then((response)=>response.json());assert.equal(health.status,'ok');
  const directory=await fetch(`${directoryOrigin}/api/dacs/listings?primaryClaim=${encodeURIComponent(composition.listing.seller.identity.presentedBy)}`).then((response)=>response.json());
  assert.equal(directory.listings.length,1);assert.equal(directory.listings[0].contentHash,composition.published.listingPin.contentHash);
  const readState=async(auth,{jobId,buyer,seller,agreementHash})=>{
    const body={transportIdentity:{jobId,buyer,seller,agreementHash}};const text=JSON.stringify(body);const signed=await auth.request('/dacs/v1/agreements/state',body,text);
    const response=await testFetch(`${sellerOrigin}/dacs/v1/agreements/state`,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:signed.header},body:text});
    return{signed,response,responseText:await response.text()};
  };
  const restart=async()=>{
    const createsBeforeRestart=node2.chain.wire.record.accepted.length;
    await running.close();await application.close();state.applicationClosed=true;composition.sellerAgent.close();await operator.close();
    const restartApprovals=[];
    const restarted=await createDevnetDemoOperator({configPath,fetchImpl:testFetch,authorizeSellerApproval:(input)=>{restartApprovals.push(input);return true;}});t.after(()=>restarted.close());
    const preparedAgain=await restarted.prepareDevnetDemo(),compositionAgain=await createDevnetDemoComposition(preparedAgain.composition);
    const applicationAgain=await createApp({config:preparedAgain.config,dacsProtocol:compositionAgain.dacsProtocol,devnetAgreementTransport:preparedAgain.devnetAgreementTransport,fetchImpl:testFetch});t.after(()=>applicationAgain.close());
    await restarted.attachSellerAgent({sellerAgent:compositionAgain.sellerAgent,application:applicationAgain,composition:compositionAgain});const runningAgain=await restarted.listen({application:applicationAgain,composition:compositionAgain});t.after(()=>runningAgain.close());
    assert.equal((await fetch(`${publicOrigin}/health`).then((value)=>value.json())).status,'ok');assert.equal(restartApprovals.length,0,'retained Listing is read back and never re-approved or resent');
    assert.equal(node2.chain.wire.record.accepted.length,createsBeforeRestart);assert.deepEqual(compositionAgain.published.listingPin,composition.published.listingPin);
    return{createsBeforeRestart,sellerApprovals:approvals.length};
  };
  return{prepared,composition,stateDirectory,approvals,health,readState,restart,testFetch,sellerOrigin};
}

test('built-in Node2 operator consumes admission, durable custody and exact seller approval before serving app/directory/signed seller boundary',{timeout:150000},async t=>{
  // Default config: open buyer access is off. Only the operator's custody
  // test buyer authenticates to the seller, with its own key, as before.
  const h=await startOperator(t,{});
  const {prepared,composition}=h;
  assert.equal(prepared.operatorEvidence.openBuyerAccess,false);assert.match(prepared.operatorEvidence.buyer,/^did:demos:agent:[0-9a-f]{64}$/);
  assert.equal(prepared.composition.sellerTransport.sessionDelegation,null);assert.equal(prepared.composition.sellerTransport.declaration.request,'buyer-ed25519-complete-body');assert.equal(Object.hasOwn(prepared.composition.sellerTransport.declaration,'delegation'),false);
  const jobId=generateCanonicalJobId(),agreementHash='a'.repeat(64),buyer=prepared.operatorEvidence.buyer,seller=prepared.operatorEvidence.seller;
  const operation={terms:{buyer:{wallet:`0x${buyer.slice('did:demos:agent:'.length)}`},protocol:{jobId}},state:{protocol:{listing:composition.listing,planned:{plan:{agreementHash}}}}};
  const auth=prepared.composition.sellerTransport.authenticationFor(operation);
  const {signed,response,responseText}=await h.readState(auth,{jobId,buyer,seller,agreementHash});
  assert.equal(response.status,200);assert.ok(response.headers.get(SELLER_TRANSPORT_HEADER));
  const verified=auth.verifyResponse(signed.payload,{header:response.headers.get(SELLER_TRANSPORT_HEADER),status:response.status,text:responseText});
  assert.equal(verified.principal,seller);assert.deepEqual(JSON.parse(responseText),{proposal:null,contribution:null});
  // The custody buyer and seller hold the source's reserved RPC auth memory:
  // two of its four places, and reserving either again takes no other place.
  const source=prepared.devnetAgreementTransport,addressOf=(claim)=>`0x${claim.slice('did:demos:agent:'.length)}`;
  source.reserveRpcAuth(createEphemeralWallet().address);source.reserveRpcAuth(createEphemeralWallet().address);
  assert.throws(()=>source.reserveRpcAuth(createEphemeralWallet().address),TypeError);
  source.reserveRpcAuth(addressOf(buyer));source.reserveRpcAuth(addressOf(seller));
  // Any other buyer wallet is refused before a request is signed, with the same error as before.
  const other=createEphemeralWallet();
  assert.throws(()=>prepared.composition.sellerTransport.authenticationFor({...operation,terms:{...operation.terms,buyer:{wallet:other.address}}}),/seller peer authentication buyer differs from operator test custody/);
  // The seller does not read a delegation envelope while open buyer access is off.
  const session=createEphemeralWallet(),now=Date.now();
  const payload={version:'1',kind:'seller-session-delegation',buyer:other.claim,sessionPublicKey:session.claim.slice('did:demos:agent:'.length),seller,listingPin:composition.published.listingPin,jobId,notBefore:now,expiresAt:now+600000};
  const delegation={payload,signature:other.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url')};
  const delegatedAuth=createSellerTransportClientAuth({sessionSigner:{claim:session.claim,sign:session.signBytes},delegation,seller,resolveJob:()=>({listingPin:composition.published.listingPin,agreementHash})});
  const refused=await h.readState(delegatedAuth,{jobId,buyer:other.claim,seller,agreementHash});
  assert.equal(refused.response.status,401);assert.equal(JSON.parse(refused.responseText).error,'peer_envelope_invalid');
  const publicEvidence=prepared.operatorEvidence;assert.equal(publicEvidence.trust,'operator-reviewed single-node TEST observation; not an independent genesis pin or consensus-finality proof');
  assert.equal(publicEvidence.custody,'separate mode-0600 TEST wallet records');
  const restarted=await h.restart();
  t.diagnostic(JSON.stringify({openBuyerAccess:false,listingCreates:restarted.createsBeforeRestart,sellerApprovals:restarted.sellerApprovals,authenticatedSellerRead:true,otherBuyerRefused:true,delegatedEnvelopeRefused:true,appHealth:h.health.status,directoryListing:true,restartReadback:true,restartCreates:0,restartApprovals:0,publicTransactions:0,scope:'owned-loopback-only'}));
});

test('with openBuyerAccess on, a seller-only operator authenticates a fresh buyer wallet through its delegated session key',{timeout:150000},async t=>{
  const h=await startOperator(t,{openBuyerAccess:true,removeBuyerCustody:true});
  const {prepared,composition}=h;
  assert.equal(prepared.operatorEvidence.openBuyerAccess,true);assert.equal(prepared.operatorEvidence.buyer,null);
  const wallet=createEphemeralWallet(),jobId=generateCanonicalJobId(),agreementHash='a'.repeat(64),buyer=wallet.claim,seller=prepared.operatorEvidence.seller;
  const operation={id:'session-startup-test',accountId:'acct_session_startup',expiresAt:new Date(Date.now()+600000).toISOString(),terms:{buyer:{wallet:wallet.address},seller:{claim:seller},listing:composition.published.listingPin,protocol:{jobId}},state:{protocol:{listing:composition.listing,planned:{draft:{terms:{deadline:Date.now()+3600000}},plan:{agreementHash}}}}};
  const requested=prepared.composition.sellerTransport.sessionDelegation.request(operation);
  operation.state.protocol.planned.draft.terms.deadline=requested.payload.expiresAt;
  operation.state.protocol.sessionDelegation={payload:requested.payload};
  operation.state.protocol.sessionDelegation=prepared.composition.sellerTransport.sessionDelegation.accept(operation,wallet.signHex(requested.message));
  const auth=prepared.composition.sellerTransport.authenticationFor(operation);
  const {signed,response,responseText}=await h.readState(auth,{jobId,buyer,seller,agreementHash});
  assert.equal(response.status,200);assert.ok(response.headers.get(SELLER_TRANSPORT_HEADER));
  const verified=auth.verifyResponse(signed.payload,{header:response.headers.get(SELLER_TRANSPORT_HEADER),status:response.status,text:responseText});
  assert.equal(verified.principal,seller);assert.deepEqual(JSON.parse(responseText),{proposal:null,contribution:null});
  // The seller now requires a delegation: a buyer signing with its own key is refused.
  const direct=createSellerTransportClientAuth({buyerSigner:{claim:wallet.claim,sign:wallet.signBytes},seller,resolveJob:()=>({listingPin:composition.published.listingPin,agreementHash})});
  const refused=await h.readState(direct,{jobId,buyer,seller,agreementHash});
  assert.equal(refused.response.status,401);assert.equal(JSON.parse(refused.responseText).error,'peer_delegation_required');
  assert.equal(prepared.operatorEvidence.custody,'seller-only mode-0600 TEST wallet record');
  const restarted=await h.restart();
  t.diagnostic(JSON.stringify({openBuyerAccess:true,listingCreates:restarted.createsBeforeRestart,sellerApprovals:restarted.sellerApprovals,authenticatedSellerRead:true,directBuyerKeyRefused:true,appHealth:h.health.status,restartReadback:true,restartCreates:0,restartApprovals:0,publicTransactions:0,scope:'owned-loopback-only'}));
});

test('openBuyerAccess must be an explicit boolean',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'devnet-operator-config-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=join(root,'operator.json');
  const config={format:'dacs-node2-demo-operator/v1',authority:'TEST-RUN-config',publicOrigin:'http://127.0.0.1:41001',sellerOrigin:'https://127.0.0.1:41002',sellerTls:{keyPath:join(root,'k'),certificatePath:join(root,'c')},directoryOrigin:'http://127.0.0.1:41003',
    stateDirectory:join(root,'state'),custodyDirectory:join(root,'custody'),networkAdmissionPath:join(root,'admission.json'),
    listing:{listingId:'operator-native-report',listingVersion:1,displayName:'Operator Seller',title:'t',description:'d',category:'services.market-report',tags:[],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
    sellerFeeBudget:{maxTotalOs:'10000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'x'},openBuyerAccess:'1'};
  await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
  await assert.rejects(createDevnetDemoOperator({configPath}),/openBuyerAccess must be an explicit boolean/);
});

test('operator config refuses a delegation deadline longer than 24 hours before admission',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'session-config-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=join(root,'config.json');
  const config={format:'dacs-node2-demo-operator/v1',authority:'TEST',publicOrigin:'http://127.0.0.1:41001',sellerOrigin:'https://127.0.0.1:41002',directoryOrigin:'http://127.0.0.1:41003',sellerTls:{keyPath:join(root,'k'),certificatePath:join(root,'c')},stateDirectory:join(root,'state'),custodyDirectory:join(root,'custody'),networkAdmissionPath:join(root,'missing'),listing:{listingId:'test',listingVersion:1,displayName:'Seller',title:'t',description:'d',category:'services.market-report',tags:[],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:86401},sellerFeeBudget:{maxTotalOs:'10000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'x'}};
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  await assert.rejects(createDevnetDemoOperator({configPath}),/24 hours/);
});
