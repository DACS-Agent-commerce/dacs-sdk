// Owned loopback TEST authority only. Real TLS to the fixed loopback endpoint,
// with an ephemeral TEST certificate trusted only by this injected client.
// No disabled TLS checks, external network, real chain pin or private inventory.
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeAgreementChain } from './native-agreement-payment-harness.mjs';
import { FIXTURE_IDENTITY } from './dacs-storage-anchor-wallet-fixture.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { startAnchorFixture } from '../dacs-loopback-fixture.test.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { createDevnetAgreementTransport, createDevnetSettlementTransport, createDevnetDeliveryTransport, DEVNET_SETTLEMENT_POLICY, DEVNET_DELIVERY_POLICY } from '../../src/wallet/devnet-native-transport.mjs';
import { createNativePaymentEvidenceConsumer } from '../../src/dacs/native-payment-evidence-consumer.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { createLoopbackTestTlsMaterial } from './loopback-test-tls.mjs';

const listen=(s)=>new Promise((r)=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const close=(s)=>new Promise((r)=>{s.closeAllConnections();s.close(r);});
export async function startDevnetAgreementTransportHarness({ enabled=true,beforeNativeBroadcast=null,settlementEnabled=false,deliveryEnabled=false,sellerTransport=null,demDeliveryContext=null,nativeDemDelivery=null,env={},nativeFees=null,readbackCache='0',commitOnSignature=false,buyerChainReadback='off' }={}) {
  // Generate before starting fixtures: a setup failure cannot leak live servers.
  // Fresh private files are removed by the helper; material is never logged.
  const {key,cert}=createLoopbackTestTlsMaterial();
  const chain=await startNativeAgreementChain(nativeFees?{nativeFees}:undefined), directory=await startDirectoryFixture(), anchors=await startAnchorFixture(),endpoints=new Map(),closers=[],requests=[],logs=[],responseMarkers=[];
  const server=https.createServer({key,cert},async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    const parsed=body?JSON.parse(body):null;requests.push({method:parsed?.method,message:parsed?.params?.[0]?.message,extra:parsed?.params?.[0]?.extra});
    try{
      if(parsed?.method==='execute' && parsed?.params?.[0]?.extra==='broadcastTx') await beforeNativeBroadcast?.();
      const r=await fetch(`${chain.url}${req.url}`,{method:req.method,headers:{'content-type':'application/json',...(req.headers.identity?{identity:req.headers.identity,signature:req.headers.signature,timestamp:req.headers.timestamp}:{})},...(body?{body}:{})});
      const data=await r.json();
      if(parsed?.params?.[0]?.message==='getTransactionStatus'){const number=chain.inclusion.numberFor(parsed.params[0].data.hash);if(Number.isSafeInteger(number))data.response={state:'included',blockNumber:number};}
      if(parsed?.params?.[0]?.message==='getBlockByNumber'&&data.response?.validation_data)delete data.response.validation_data.simulated;
      // Deliberately NO simulation header. Native SDK network preparation also
      // gets no simulated/chainIdentity shortcut; only binder block reads pin.
      if(parsed?.params?.[0]?.message === 'getNetworkInfo'){delete data.response.simulated;delete data.response.chainIdentity;}
      res.writeHead(r.status,{'content-type':'application/json',connection:'close'});res.end(JSON.stringify(data));
    }catch{res.writeHead(503,{'content-type':'application/json',connection:'close'});res.end(JSON.stringify({error:'TEST upstream outcome unavailable'}));}
  });
  const endpoint=`https://127.0.0.1:${await listen(server)}/`;
  const context={network:'demos-devnet',endpoint,transportAuthority:'TEST-owned-loopback-https',connectionId:'test-connection-1'};
  let fenced=false,closed=false;
  const fenceEvents=[];
  const transportOwner={
    getContext:()=>({...context}),
    async acquireConnectionFence(){if(fenced)throw Error('TEST actual connection busy');fenced=true;fenceEvents.push('acquire');let live=true;return{context:{...context},release(){if(live){live=false;fenced=false;fenceEvents.push('release');}}};},
  };
  const tlsFetch=(url,options={})=>new Promise((resolve,reject)=>{
    if(new URL(url).origin!==new URL(endpoint).origin)return reject(Error('TEST non-owned TLS origin refused'));
    const r=https.request(url,{method:options.method,headers:options.headers,ca:cert,signal:options.signal,agent:false},response=>{
      const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024)response.destroy(Error('TEST response cap'));else chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{responseMarkers.push(response.headers['x-dacs-simulation']??null);resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers}));});
    });r.on('error',reject);r.end(options.body);
  });
  const expected={network:context.network,chainIdentity:FIXTURE_IDENTITY,pinVersion:'TEST-fixture-pin-v1',endpoint,transportAuthority:context.transportAuthority};
  const dataDir=mkdtempSync(join(tmpdir(),'devnet-native-source-')),journalPath=join(dataDir,'public-native.sqlite');
  let journal=openDurableWalletJournal({path:journalPath,mode:'create'});const journalId=journal.journalId;
  const appServer=http.createServer(),origin=`http://127.0.0.1:${await listen(appServer)}`;
  const config=loadConfig({DACS_COMMIT_ON_SIGNATURE:commitOnSignature?'on':'off',DACS_PUBLIC_ORIGIN:origin,DACS_ALLOW_INSECURE_LOCALHOST:'1',DACS_OAUTH_COOKIE_KEYS:randomBytes(32).toString('hex'),DACS_DATA_DIR:dataDir,DACS_LOG_LEVEL:'debug',DACS_READBACK_CACHE:readbackCache,DACS_BUYER_CHAIN_READBACK:buyerChainReadback,DACS_CHAIN_RPC_URL:chain.url,DACS_DIRECTORY_ORIGIN:directory.url,DACS_ALLOWED_REDIRECT_ORIGINS:CALLBACK_ORIGIN,...env});
  let app,capability,restarts=0;
  async function build(){
    const transportOptions={expected,transportOwner,journal,fetchImpl:tlsFetch};
    const settlementPublication={policy:DEVNET_SETTLEMENT_POLICY,artifactKind:'SettlementEvidence',phase:'pay-dem',railId:'demos-native:DEM',phaseIndex:2,authority:'TEST-owned-loopback-https-ephemeral-seller'};
    capability=enabled?(deliveryEnabled?createDevnetDeliveryTransport({...transportOptions,settlementPublication,deliveryPublication:{policy:DEVNET_DELIVERY_POLICY,artifactKind:'Deliverable',phase:'deliver-storage-program',phaseIndex:3,authority:'TEST-owned-loopback-https-ephemeral-seller'}}):settlementEnabled?createDevnetSettlementTransport({...transportOptions,settlementPublication}):createDevnetAgreementTransport(transportOptions)):null;
    const nativePaymentEvidence=settlementEnabled&&capability?createNativePaymentEvidenceConsumer({rpcUrl:expected.endpoint,sourceCapability:capability,fetchImpl:tlsFetch}):null;
    app=await createApp({config,devnetAgreementTransport:capability,dacsProtocol:{buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true}),anchorUrl:anchors.url,sellerEndpoint:claim=>endpoints.get(claim)??null,sellerSr2Commitment:{commitmentSubstrate:'fixture',publicProjection:true},...(nativePaymentEvidence?{nativePaymentEvidence}:{}) ,...(sellerTransport?{sellerTransport}:{}),...(demDeliveryContext?{demDeliveryContext}:{}),...(nativeDemDelivery?{nativeDemDelivery}:{})},logger:createLogger({level:'debug',sink:l=>logs.push(l)})});
  }
  // A refused startup (e.g. DACS_BUYER_CHAIN_READBACK=on with a capability
  // that cannot read the chain only) leaves no live fixture behind.
  try{await build();}catch(error){await close(appServer);journal.close();await close(server);await anchors.close();await directory.close();await chain.close();rmSync(dataDir,{recursive:true});throw error;}
  appServer.on('request',(req,res)=>app.app(req,res));
  return{origin,mcpUrl:`${origin}/mcp`,chain,directory,anchors,endpoints,onClose:fn=>closers.push(fn),requests,expected,fenceEvents,config,logs,responseMarkers,get app(){return app;},get journal(){return journal;},get capability(){return capability;},
    profile:()=>fetch(`${origin}/portal/api/devnet-native-wallet-profile`,{method:'POST'}).then(r=>r.json()),
    restarts:()=>restarts,
    async restart(){await app.close();journal.close();journal=openDurableWalletJournal({path:journalPath,mode:'open',expectedJournalId:journalId});context.connectionId=`test-connection-${++restarts+1}`;await build();},
    async close(){if(closed)return;closed=true;await close(appServer);await app.close();journal.close();await close(server);for(const fn of closers.reverse())await fn();await anchors.close();await directory.close();await chain.close();rmSync(dataDir,{recursive:true});},
  };
}
