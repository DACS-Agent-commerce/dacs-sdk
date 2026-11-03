import net from 'node:net';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDevnetDemoComposition } from '../../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../../src/devnet-demo/operator.mjs';
import { bootstrapTestWalletCustody } from '../../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../../src/devnet-demo/operator-network.mjs';
import { startOperatorNode2 } from './devnet-operator-node2.mjs';

// Every probe socket stays bound until all are allocated, so the ports are
// distinct: a port released by one probe can't be handed to the next. Each
// probe is then held until right before the operator binds its port, so another
// test process can take that port only in the short gap. release(...indexes) is
// idempotent.
export const holdFreePorts=async(count)=>{
  const servers=[],released=new Set();
  const release=(...indexes)=>Promise.all(indexes.map((index)=>servers[index]).filter((server)=>server&&!released.has(server)).map((server)=>{released.add(server);return new Promise((resolve)=>server.close(()=>resolve()));}));
  try{
    for(let i=0;i<count;i++){const server=net.createServer();servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
    return{ports:servers.map((server)=>server.address().port),release};
  }catch(error){await release(...servers.keys());throw error;}
};

// A port can still be taken in that gap. On EADDRINUSE the whole construction
// (Node2 fixture, state, custody and a fresh complete port set) is retried, at
// most this many attempts in all. Any other error, and an EADDRINUSE whose
// cleanup failed (it carries `suppressed`), is thrown at once.
const PORT_ATTEMPTS=3;
// A discarded attempt's cleanup close must not touch the test's shutdown clock
// or its beforeSourceClose hook: it runs on zero budgets, with nothing to wait for.
// An attempt counts as discarded until its first boot has succeeded: a failed
// attachment closes its own operator before the error reaches this helper.
const shieldedShutdownTimer=(timer,discarded)=>timer&&{
  get graceMs(){return discarded.value?0:timer.graceMs;},get laneMs(){return discarded.value?0:timer.laneMs;},get approvalMs(){return discarded.value?0:timer.approvalMs;},
  now:()=>discarded.value?0:timer.now(),sleep:(ms)=>discarded.value?Promise.resolve():timer.sleep(ms),
  beforeSourceClose:()=>{if(!discarded.value)timer.beforeSourceClose?.();}};

// Optional test-only fault seams: wrapPublicJournal(journal) may wrap the
// seller artifact journal handed to the composition, and rpcFault({url,body,headers})
// may answer an owned-loopback Node2 call itself (returning a Response) instead
// of forwarding it. Both default to the unchanged pass-through behaviour.
// evidenceResumeTimer ({every,cancel}) replaces the operator's evidence resume
// interval. restart() stops the operator, app and seller agent and starts them
// again on the same state, chain and custody.
// beforeAttach({composition}) runs on every boot after the composition is built
// and before attachSellerAgent. allocatePorts(count) (default holdFreePorts)
// returns {ports:[app,seller,directory],release}; a retried attempt may already
// have called the other callbacks above for its discarded operator.
// stateParent (default the OS temp directory) is where each attempt makes its
// state root; a failed attempt removes its own.
export async function startOperatorPurchaseNode2({allocatePorts=holdFreePorts,shutdownTimer=null,...options}){
  for(let attempt=1;;attempt++){
    const held=await allocatePorts(3),discarded={value:true};
    try{return await startOnce({...options,held,discarded,shutdownTimer:shieldedShutdownTimer(shutdownTimer,discarded)});}
    catch(error){if(error?.code!=='EADDRINUSE'||error?.suppressed!=null||attempt>=PORT_ATTEMPTS)throw error;}
    finally{await held.release(0,1,2);}
  }
}

async function startOnce({authorizeSellerApproval,authorizeBuyerApproval,sellerApproval,sellerDeliveryEvidence,tlsFixture,wrapPublicJournal=null,wrapSellerWalletFactory=null,rpcFault=null,openBuyerAccess,evidenceResumeTimer=null,sessionSweepTimer=null,listen=true,beforeAttach=null,shutdownTimer,now=()=>Date.now(),stateParent=tmpdir(),held,discarded}){
  const node2=await startOperatorNode2({tlsFixture,...(sellerApproval?.mode==='policy'?{nativeFees:{networkFee:1,rpcFee:1}}:{})}),root=await realpath(await mkdtemp(join(stateParent,'devnet-operator-purchase-')));
  let operator=null,composition=null,application=null,running=null,closed=false;
  try{
    const [appPort,sellerPort,directoryPort]=held.ports;
    const publicOrigin=`http://127.0.0.1:${appPort}`,sellerOrigin=`https://127.0.0.1:${sellerPort}`,directoryOrigin=`http://127.0.0.1:${directoryPort}`;
    const custodyDirectory=join(root,'custody'),stateDirectory=join(root,'state');await bootstrapTestWalletCustody({directory:custodyDirectory,publicOrigin});
    const observation=await observeNode2Identity({endpoint:node2.endpoint,network:'demos-devnet',fetchImpl:node2.fetchImpl});
    const authority='TEST-RUN-operator-purchase-001',admission=admitObservedNode2Identity({observation,authority,transportAuthority:'TEST-owned-operator-purchase-node2',pinVersion:'TEST-operator-purchase-pin-v1',reviewedChainIdentity:observation.chainIdentity});
    const admissionPath=join(root,'admission.json'),sellerKeyPath=join(root,'seller-key.pem'),sellerCertificatePath=join(root,'seller-cert.pem');
    await writeFile(admissionPath,`${JSON.stringify(admission)}\n`,{mode:0o600});await writeFile(sellerKeyPath,node2.key,{mode:0o600});await writeFile(sellerCertificatePath,node2.cert,{mode:0o600});
    const config={format:'dacs-node2-demo-operator/v1',authority,publicOrigin,sellerOrigin,sellerTls:{keyPath:sellerKeyPath,certificatePath:sellerCertificatePath},directoryOrigin,stateDirectory,custodyDirectory,networkAdmissionPath:admissionPath,
      listing:{listingId:'operator-purchased-report',listingVersion:1,displayName:'Operator Purchase Seller',title:'Purchased Node2 operator report',description:'Fresh seller bytes after the complete purpose-bound buyer flow.',category:'services.market-report',tags:['report','operator'],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
      ...(sellerApproval?{sellerApproval}:{}),...(sellerDeliveryEvidence?{sellerDeliveryEvidence}:{}),
      sellerFeeBudget:{maxTotalOs:'10000000000'},buyerFeeBudget:{maxTotalOs:'12000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'Genuine purchased bytes from the built-in operator seller.'},...(openBuyerAccess===undefined?{}:{openBuyerAccess})};
    const configPath=join(root,'operator.json');await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
    const observedBlockTimes=new Map();let latestBlockTime=0;
    const fetchImpl=async(url,options)=>{
      if(new URL(url).protocol!=='https:')return fetch(url,options);
      if(rpcFault){let body=null;try{body=JSON.parse(options?.body??'null');}catch{}const faulted=await rpcFault({url,body,headers:options?.headers??{}});if(faulted)return faulted;}
      const response=await node2.fetchImpl(url,options);let text=await response.text();
      try{const call=JSON.parse(options?.body??'{}')?.params?.[0],body=JSON.parse(text),value=body?.response;if(call?.message==='getBlockByNumber'&&Number.isSafeInteger(value?.number)&&Number.isSafeInteger(value?.content?.timestamp)){
        let timestamp=observedBlockTimes.get(value.number);if(timestamp===undefined){timestamp=Math.max(value.content.timestamp,latestBlockTime+1,Math.ceil(Date.now()/1000)+1);observedBlockTimes.set(value.number,timestamp);latestBlockTime=timestamp;}
        value.content.timestamp=timestamp;text=JSON.stringify(body);const wait=timestamp*1000-Date.now();if(wait>0){if(wait>30000)throw new Error('operator purchase source clock exceeded its bounded wait');await new Promise((resolve)=>setTimeout(resolve,wait));}
      }}catch(error){if(error.message==='operator purchase source clock exceeded its bounded wait')throw error;}
      return new Response(text,{status:response.status,headers:response.headers});
    };
    const boot=async()=>{
      await held.release(0);
      operator=await createDevnetDemoOperator({configPath,fetchImpl,authorizeSellerApproval,authorizeBuyerApproval,now,...(shutdownTimer?{testOnlyShutdownTimer:shutdownTimer}:{}),...(sessionSweepTimer?{testOnlySessionSweepTimer:sessionSweepTimer}:{}),...(evidenceResumeTimer?{testOnlyEvidenceResumeTimer:evidenceResumeTimer}:{})});
      const prepared=await operator.prepareDevnetDemo();composition=await createDevnetDemoComposition({...prepared.composition,
        ...(wrapPublicJournal?{publicJournal:wrapPublicJournal(prepared.composition.publicJournal)}:{}),...(wrapSellerWalletFactory?{sellerWalletFactory:wrapSellerWalletFactory(prepared.composition.sellerWalletFactory)}:{})});
      application=await createApp({config:prepared.config,dacsProtocol:composition.dacsProtocol,devnetAgreementTransport:prepared.devnetAgreementTransport,fetchImpl,now:prepared.now});
      await beforeAttach?.({composition});
      // The seller listener binds at attachment, the directory at listen.
      await held.release(1);
      await operator.attachSellerAgent({sellerAgent:composition.sellerAgent,application,composition});
      if(listen)await held.release(2);running=listen?await operator.listen({application,composition}):null;
      return prepared;
    };
    const stop=async()=>{await running?.close?.();await application?.close?.();composition?.sellerAgent?.close?.();await operator?.close?.();running=application=composition=operator=null;};
    const h={root,node2,config,configPath,prepared:await boot(),composition,application,operator,running,fetchImpl};
    h.stop=stop;
    discarded.value=false;
    h.restart=async()=>{await stop();h.prepared=await boot();Object.assign(h,{composition,application,operator,running});};
    h.close=async()=>{if(closed)return;closed=true;await stop();await node2.close();await rm(root,{recursive:true,force:true});};
    return h;
  }catch(error){
    discarded.value=true;
    // Each step runs even when an earlier one throws, so a refused operator
    // close still closes Node2 and removes the root. A failed step never
    // replaces the error: as in the operator's own construction cleanup, it is
    // attached as `suppressed`, and then the attempt is not retried.
    const failures=[];
    for(const step of [()=>running?.close?.(),()=>application?.close?.(),()=>composition?.sellerAgent?.close?.(),()=>operator?.close?.(),()=>node2.close(),()=>rm(root,{recursive:true,force:true})]){
      try{await step();}catch(failure){failures.push(failure);}
    }
    if(failures.length){
      try{error.suppressed=new AggregateError([...(Object.hasOwn(error,'suppressed')?[error.suppressed]:[]),...failures],'operator purchase helper cleanup failed after this error');}
      catch{throw new AggregateError([error,...failures],'operator purchase helper cleanup failed after this error');}
    }
    throw error;
  }
}
