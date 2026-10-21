import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDevnetDemoComposition } from '../../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../../src/devnet-demo/operator.mjs';
import { bootstrapTestWalletCustody } from '../../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../../src/devnet-demo/operator-network.mjs';
import { startOperatorNode2 } from './devnet-operator-node2.mjs';

const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});

export async function createOperatorRecoveryNode2({authorizeSellerApproval,authorizeBuyerApproval,now=()=>Date.now(),tlsFixture=null}){
  const node2=await startOperatorNode2({tlsFixture}),root=await mkdtemp(join(tmpdir(),'devnet-operator-recovery-'));
  let operator=null,composition=null,application=null,running=null,prepared=null,closed=false,dropReport=false,droppedReports=0,blockClaims=false,blockedClaims=0;
  const [appPort,sellerPort,directoryPort]=await Promise.all([freePort(),freePort(),freePort()]);
  const publicOrigin=`http://127.0.0.1:${appPort}`,sellerOrigin=`https://127.0.0.1:${sellerPort}`,directoryOrigin=`http://127.0.0.1:${directoryPort}`;
  const custodyDirectory=join(root,'custody'),stateDirectory=join(root,'state');await bootstrapTestWalletCustody({directory:custodyDirectory,publicOrigin});
  const observation=await observeNode2Identity({endpoint:node2.endpoint,network:'demos-devnet',fetchImpl:node2.fetchImpl});
  const authority='TEST-RUN-operator-recovery-001',admission=admitObservedNode2Identity({observation,authority,transportAuthority:'TEST-owned-operator-recovery-node2',pinVersion:'TEST-operator-recovery-pin-v1',reviewedChainIdentity:observation.chainIdentity});
  const admissionPath=join(root,'admission.json'),sellerKeyPath=join(root,'seller-key.pem'),sellerCertificatePath=join(root,'seller-cert.pem');
  await writeFile(admissionPath,`${JSON.stringify(admission)}\n`,{mode:0o600});await writeFile(sellerKeyPath,node2.key,{mode:0o600});await writeFile(sellerCertificatePath,node2.cert,{mode:0o600});
  const config={format:'dacs-node2-demo-operator/v1',authority,publicOrigin,sellerOrigin,sellerTls:{keyPath:sellerKeyPath,certificatePath:sellerCertificatePath},directoryOrigin,stateDirectory,custodyDirectory,networkAdmissionPath:admissionPath,
    listing:{listingId:'operator-recovery-report',listingVersion:1,displayName:'Operator Recovery Seller',title:'Recoverable purchased Node2 operator report',description:'Fresh seller bytes through one durable purpose-bound buyer run.',category:'services.market-report',tags:['report','operator','recovery'],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
    sellerFeeBudget:{maxTotalOs:'10000000000'},buyerFeeBudget:{maxTotalOs:'12000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'Genuine recoverable purchased bytes from the built-in operator seller.'}};
  const configPath=join(root,'operator.json');await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
  const observedBlockTimes=new Map();let latestBlockTime=0;
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);
    if(target.protocol==='https:'){
      if(blockClaims&&target.origin===sellerOrigin&&target.pathname==='/dacs/v1/payments'){blockedClaims++;throw Object.assign(new TypeError('TEST claim blocked before seller'),{cause:Object.assign(new Error('TEST connection refused'),{code:'ECONNREFUSED'})});}
      const response=await node2.fetchImpl(url,options);let text=await response.text();
      try{const call=JSON.parse(options?.body??'{}')?.params?.[0],body=JSON.parse(text),value=body?.response;if(call?.message==='getBlockByNumber'&&Number.isSafeInteger(value?.number)&&Number.isSafeInteger(value?.content?.timestamp)){
        let timestamp=observedBlockTimes.get(value.number);if(timestamp===undefined){timestamp=Math.max(value.content.timestamp,latestBlockTime+1,Math.ceil(Date.now()/1000)+1);observedBlockTimes.set(value.number,timestamp);latestBlockTime=timestamp;}
        value.content.timestamp=timestamp;text=JSON.stringify(body);const wait=timestamp*1000-Date.now();if(wait>0){if(wait>30000)throw new Error('operator recovery source clock exceeded its bounded wait');await new Promise((resolve)=>setTimeout(resolve,wait));}
      }}catch(error){if(error.message==='operator recovery source clock exceeded its bounded wait')throw error;}
      return new Response(text,{status:response.status,headers:response.headers});
    }
    const response=await fetch(url,options);
    if(dropReport&&options?.method==='POST'&&/^\/portal\/api\/purchase\/[^/]+\/report$/.test(target.pathname)){
      dropReport=false;droppedReports++;await response.arrayBuffer();throw Object.assign(new Error('TEST own-local response lost after applied report'),{code:'TEST_RESPONSE_LOST_AFTER_APPLY'});
    }
    return response;
  };
  const stop=async()=>{await running?.close?.();await application?.close?.();composition?.sellerAgent?.close?.();await operator?.close?.();running=null;application=null;composition=null;operator=null;prepared=null;};
  const start=async()=>{
    if(closed)throw new Error('operator recovery harness is closed');if(operator)throw new Error('operator recovery harness is already running');
    operator=await createDevnetDemoOperator({configPath,fetchImpl,authorizeSellerApproval,authorizeBuyerApproval,now});
    prepared=await operator.prepareDevnetDemo();composition=await createDevnetDemoComposition(prepared.composition);
    application=await createApp({config:prepared.config,dacsProtocol:composition.dacsProtocol,devnetAgreementTransport:prepared.devnetAgreementTransport,fetchImpl,now:prepared.now});
    await operator.attachSellerAgent({sellerAgent:composition.sellerAgent,application,composition});running=await operator.listen({application,composition});return{operator,composition,application,prepared,running};
  };
  const restart=async()=>{await stop();return start();};
  const close=async()=>{if(closed)return;closed=true;await stop();await node2.close();await rm(root,{recursive:true,force:true});};
  try{await start();}catch(error){await close();throw error;}
  return Object.freeze({root,node2,config,configPath,fetchImpl,start,stop,restart,close,blockSellerClaims(value){blockClaims=value;},get blockedClaims(){return blockedClaims;},loseNextAppliedReportResponse(){dropReport=true;},get droppedReports(){return droppedReports;},get operator(){return operator;},get composition(){return composition;},get application(){return application;},get prepared(){return prepared;}});
}
