import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeAgreementChain } from './native-agreement-payment-harness.mjs';
import { FIXTURE_IDENTITY } from './dacs-storage-anchor-wallet-fixture.mjs';
import { createNode2TransportOwner } from '../../src/devnet-demo/operator-network.mjs';
import { createDevnetDemoTransport, DEVNET_DEMO_ARTIFACT_POLICY, DEVNET_DEMO_ARTIFACT_TYPES, DEVNET_DELIVERY_POLICY, DEVNET_SETTLEMENT_POLICY } from '../../src/wallet/devnet-native-transport.mjs';

const listen=(server)=>new Promise((resolve)=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=(server)=>new Promise((resolve)=>{server.closeAllConnections();server.close(resolve);});
function memoryJournal(){const rows=new Map(),tails=new Map();return{get:async(k)=>structuredClone(rows.get(k)??null),put:async(k,v)=>rows.set(k,structuredClone(v)),entries:async()=>[...rows.entries()].map(([k,v])=>[k,structuredClone(v)]),async withWalletLock(k,work){const prior=tails.get(k)??Promise.resolve();let release;const next=new Promise(r=>release=r);tails.set(k,next);await prior;try{return await work();}finally{release();if(tails.get(k)===next)tails.delete(k);}}};}

export async function startDevnetLiveCompositionTransport({pendingStatusPolls=0,transportOptions={},rpcResponse,sourceJournal,deliveryEvidenceEnabled=false,queueConnectionFences=false}={}){
  // Optional TEST block latency: answer the first N status reads as pending.
  let pendingStatusLeft=pendingStatusPolls;
  // OpenSSL cannot reopen a piped /dev/stdout on every supported OS. Generate
  // this test's fresh TLS material in a private directory, then remove it before
  // opening servers so a generation failure cannot leave a listening chain.
  const tlsDirectory=mkdtempSync(join(tmpdir(),'devnet-composition-tls-'));
  let key,cert;
  try{
    const keyPath=join(tlsDirectory,'key.pem'),certPath=join(tlsDirectory,'cert.pem');
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=TEST-devnet-demo','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyPath,'-out',certPath],{stdio:['ignore','pipe','pipe']});
    key=readFileSync(keyPath);cert=readFileSync(certPath);
  }finally{rmSync(tlsDirectory,{recursive:true,force:true});}
  const chain=await startNativeAgreementChain();
  // Bind each applied block to the immutable accepted transaction that created
  // it, rather than to whichever verifier happens to read it first. CREATE and
  // native-transfer timestamps are milliseconds; the block projection is the
  // containing whole second and is returned only once that second is real.
  // This preserves one receipt projection across independent fresh readers
  // without inventing time from read order or rewriting hash/height/content.
  const blockTimestamps=new Map();
  // Every source read and write passes this owned TLS endpoint: record each
  // request's nodeCall message, execute extra, or GET path kind.
  const requests=[];
  const tls=https.createServer({key,cert},async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const parsed=JSON.parse(body||'{}');requests.push(parsed?.params?.[0]?.message??parsed?.params?.[0]?.extra??`${req.method} /${req.url.split('/')[1]}`);const override=await rpcResponse?.(parsed,req.headers);if(override!==undefined){res.writeHead(200,{'content-type':'application/json',connection:'close'});return res.end(JSON.stringify(override));}if(parsed?.params?.[0]?.message==='getTransactionStatus'&&pendingStatusLeft>0){pendingStatusLeft--;res.writeHead(200,{'content-type':'application/json',connection:'close'});return res.end(JSON.stringify({result:200,response:{state:'pending'}}));}const upstream=await fetch(`${chain.url}${req.url}`,{method:req.method,headers:{'content-type':'application/json',...(req.headers.identity?{identity:req.headers.identity,signature:req.headers.signature,timestamp:req.headers.timestamp}:{})},...(body?{body}:{})});const data=await upstream.json();if(parsed?.params?.[0]?.message==='getTransactionStatus'){const number=chain.inclusion.numberFor(parsed.params[0].data.hash);if(Number.isSafeInteger(number))data.response={state:'included',blockNumber:number};}if(parsed?.params?.[0]?.message==='getBlockByNumber'&&data.response?.content&&Number.isSafeInteger(Number(data.response.number))){const number=Number(data.response.number);let timestamp=blockTimestamps.get(number);if(timestamp===undefined){const ordered=new Set(Array.isArray(data.response.content.ordered_transactions)?data.response.content.ordered_transactions:[]);const transaction=[...chain.wire.record.accepted,...chain.record.accepted].find(candidate=>ordered.has(candidate.hash));const createdAt=Number(transaction?.content?.timestamp);timestamp=Number.isSafeInteger(createdAt)&&createdAt>=0?Math.ceil(createdAt/1000):Number(data.response.content.timestamp);blockTimestamps.set(number,timestamp);}data.response.content.timestamp=timestamp;const remaining=timestamp*1000-Date.now();if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));}if(parsed?.params?.[0]?.message==='getNetworkInfo'){delete data.response.simulated;delete data.response.chainIdentity;}res.writeHead(upstream.status,{'content-type':'application/json',connection:'close'});res.end(JSON.stringify(data));});
  const endpoint=`https://127.0.0.1:${await listen(tls)}/`;
  const context={network:'demos-devnet',endpoint,transportAuthority:'TEST-owned-devnet-demo',connectionId:'TEST-demo-connection'};let fenced=false;
  // TEST inspection only (queued fences): each fence asked for, with its claim and when it was granted and released.
  const fences=[],queued=queueConnectionFences?createNode2TransportOwner({admission:context,queueConnectionFences:true}):null;
  const transportOwner=queued?{getContext:()=>queued.getContext(),async acquireConnectionFence(claim){const entry={claim:claim??null,asked:performance.now(),granted:null,released:null};fences.push(entry);const fence=await queued.acquireConnectionFence(claim);entry.granted=performance.now();
    return{context:fence.context,release(){entry.released??=performance.now();return fence.release();}};}}:{getContext:()=>({...context}),async acquireConnectionFence(){if(fenced)throw new Error('TEST source busy');fenced=true;let live=true;return{context:{...context},release(){if(live){live=false;fenced=false;}}};}};
  const tlsFetch=(url,options={})=>new Promise((resolve,reject)=>{const request=https.request(url,{method:options.method,headers:options.headers,ca:cert,signal:options.signal,agent:false},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));response.on('error',reject);});request.on('error',reject);request.end(options.body);});
  const journal=sourceJournal ?? memoryJournal(),authority='TEST-RUN-native-demo-001';
  const sourceOptions={expected:{network:context.network,chainIdentity:FIXTURE_IDENTITY,pinVersion:'TEST-demo-pin-v1',endpoint,transportAuthority:context.transportAuthority},transportOwner,journal,fetchImpl:tlsFetch,...transportOptions,
    settlementPublication:{policy:DEVNET_SETTLEMENT_POLICY,artifactKind:'SettlementEvidence',phase:'pay-dem',railId:'demos-native:DEM',phaseIndex:2,authority},
    deliveryPublication:{policy:DEVNET_DELIVERY_POLICY,artifactKind:'Deliverable',phase:'deliver-storage-program',phaseIndex:3,authority},
    demoArtifactPublication:{policy:DEVNET_DEMO_ARTIFACT_POLICY,artifactKinds:deliveryEvidenceEnabled?[...DEVNET_DEMO_ARTIFACT_TYPES,'SettlementEvidence']:DEVNET_DEMO_ARTIFACT_TYPES,authority}};
  let capability=createDevnetDemoTransport(sourceOptions);
  const errors=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;try{if(req.method==='GET'&&req.url==='/portal/api/devnet-native-wallet-rpc'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok'}));return;}if(req.url==='/portal/api/devnet-native-wallet-profile'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(capability.profile(origin)));return;}const input=body?JSON.parse(body):{};const answer=req.url==='/portal/api/devnet-native-wallet-binding'?await capability.binding(input):await capability.rpc(input,Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k,String(v)])));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));}catch(error){errors.push({code:error.code??'failed',message:error.message});res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({error:error.code??'failed',message:error.message}));}});
  const origin=`http://127.0.0.1:${await listen(server)}`;
  return{origin,chain,get journal(){return capability.journal;},get capability(){return capability;},authority,errors,requests,fences,async restartSource(journal){await capability.close();capability=createDevnetDemoTransport({...sourceOptions,journal});},async close(){await capability.close();await close(server);await close(tls);await chain.close();}};
}
