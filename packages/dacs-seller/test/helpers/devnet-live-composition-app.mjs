import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDevnetLiveCompositionTransport } from './devnet-live-composition-transport.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { fixtureListing, summaryFor } from '../fixtures/listings.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { openPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';
import { createDevnetDemoComposition } from '../../src/devnet-demo/composition.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { createDemosSr2WalletBridge } from '../../src/dacs/demos-sr2-wallet-bridge.mjs';
import { createNativePaymentEvidenceConsumer } from '../../src/dacs/native-payment-evidence-consumer.mjs';
import { createSellerSr2AgreementAnchor } from '../../src/dacs/seller-sr2-agreement-consumer.mjs';
import { createSourceDemoSellerTransport } from '../../src/dacs/source-demo-seller-transport.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createSellerTransportServerAuth, createSellerTransportStore } from '../../src/dacs/seller-transport-auth.mjs';
import { DEM_RAIL } from '../../src/dacs/listing.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';

const listen=(server)=>new Promise((resolve)=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=(server)=>new Promise((resolve)=>{server.closeAllConnections();server.close(resolve);});
const railAuthority=()=>({trustPhase:'PA-1',trustPolicyAcceptsPA1:true,registry:{state:'not-used',entries:[],definitions:[]},inCodeDefinitions:[{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion,phaseHandler:'pay-dem',governanceAnchoring:'in-code',signatureValid:true}]});

// approve: the seller's approval for each of its CREATEs (default: approve).
// planWaitMs: the app's wait bound for a running Agreement plan step.
// buyerChainReadback follows DACS_BUYER_CHAIN_READBACK, so the existing suites
// run unchanged with the switch on. The seller journals are passed through a
// TEST gate: `sellerJournals.deleted` makes every seller journal call throw, so
// a buyer read that consults them fails. `rpcOverride` may answer a source RPC
// and `afterSellerCommit` observes each seller commit answer; both unset by default.
export async function startDevnetLiveCompositionApp({sellerNativeEvidenceDelayMs=0,approve=null,planWaitMs,intentApproval=false,commitOnSignature=false,appCommitOnSignature=commitOnSignature,signatureBuyer=null,onCommitmentSign=()=>{},beforeBuyerBroadcast=null,rpcOverride=null,buyerChainReadback=process.env.DACS_BUYER_CHAIN_READBACK??'off',env={},sellerRequestTimeoutMs=15000}={}){
  if(!Number.isSafeInteger(sellerNativeEvidenceDelayMs)||sellerNativeEvidenceDelayMs<0||sellerNativeEvidenceDelayMs>60000)throw new TypeError('sellerNativeEvidenceDelayMs must be an integer from 0 through 60000');
  const trace=(value)=>{if(process.env.DACS_TEST_TRACE==='1')process.stderr.write(`composition-app:${value}\n`);};
  const testHooks={rpcOverride:null,afterSellerCommit:null},sellerJournals={deleted:false,touched:0};
  const transport=await startDevnetLiveCompositionTransport({queueConnectionFences:commitOnSignature,rpcResponse:async(body,headers)=>{const hooked=await testHooks.rpcOverride?.(body,headers);if(hooked!==undefined)return hooked;const override=await rpcOverride?.(body);if(override!==undefined)return override;const tx=body?.params?.[0]?.data?.response?.data?.transaction;if(body?.params?.[0]?.extra==='broadcastTx'&&tx?.content?.data?.[1]?.metadata?.artifactKind==='Agreement')await beforeBuyerBroadcast?.();}}),directory=await startDirectoryFixture(),logs=[];
  trace('transport');
  const gated=(journal)=>new Proxy(journal,{get(target,key){const value=target[key];if(typeof value!=='function'||key==='close')return value;
    return(...args)=>{if(sellerJournals.deleted){sellerJournals.touched+=1;throw Object.assign(new Error('TEST seller journal deleted'),{code:'ENOENT'});}return value.apply(target,args);};}});
  const dir=mkdtempSync(join(tmpdir(),'devnet-live-composition-app-')),publicJournal=gated(openDurableWalletJournal({path:join(dir,'seller-artifact-intents.sqlite'),mode:'create'})),partyVetStore=openPartyVetStore({path:join(dir,'seller-party-vet.sqlite')}),sellerWalletJournal=gated(openDurableWalletJournal({path:join(dir,'seller-public-wallet.sqlite'),mode:'create'}));
  let appHandler=async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;try{if(req.method==='GET'&&req.url==='/portal/api/devnet-native-wallet-rpc'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok'}));return;}const input=body?JSON.parse(body):{};const answer=req.url==='/portal/api/devnet-native-wallet-binding'?await transport.capability.binding(input):await transport.capability.rpc(input,Object.fromEntries(Object.entries(req.headers).map(([key,value])=>[key,String(value)])));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));}catch(error){if(process.env.DACS_TEST_TRACE==='1')process.stderr.write(`composition-app:pre-handler-error:${error.code??'failed'}:${error.message}\n`);res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({error:error.code??'failed',message:error.message}));}};
  const appServer=http.createServer((req,res)=>appHandler(req,res)),origin=`http://127.0.0.1:${await listen(appServer)}`;
  globalThis.location=new URL(origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const profile=transport.capability.profile(origin),sellerActor=await createEphemeralPackagedSeller({network:'demos-devnet',transactionTransport:createDevnetAgreementWalletTransport(profile),approve});
  trace('seller-wallet');
  const authenticationRegistry=new Map(),jobContexts=new Map(),endpoints=new Map();
  const sellerTransport=createSourceDemoSellerTransport({authority:transport.authority,authenticationFor:(operation)=>authenticationRegistry.get(operation.terms.seller.claim)});
  const signed=fixtureListing(sellerActor.signer,{listingId:'native-composed-e2e',version:1,now:Date.now()-1000,notAfter:Date.now()+86400000});
  const {signature:_signature,...listingDraft}=signed;listingDraft.offering={...listingDraft.offering,title:'Fresh Node2 fixed-price report',description:'Fresh purchased bytes produced for one DEM Agreement.',tags:['report','devnet']};listingDraft.terms={...listingDraft.terms,deadlineSecAfterCommit:345600};
  let evidenceBridge;
  const sellerWalletFactory=()=>{trace('seller-wallet-factory');return sellerActor.walletFactory({anchorJournal:sellerWalletJournal});};
  const readSignedProjection=async({logicalAddress,writer})=>{const records=(await sellerWalletJournal.entries()).map(([,value])=>value).filter((value)=>value?.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===logicalAddress&&`did:demos:agent:${value.signedTransaction.content.from.replace(/^0x/,'')}`===writer);return records.length===1?structuredClone(records[0].signedTransaction):undefined;};
  const sellerTimingState={active:0,maxActive:0,submitPaymentCalls:0,reconcileTransportCalls:0,signatureCommitmentCalls:0,anchorCalls:0,delayedAnchors:0,events:[]},idleWaiters=new Set();
  const timestamp=()=>Date.now();
  const wakeIdle=()=>{if(sellerTimingState.active===0)for(const waiter of [...idleWaiters]){idleWaiters.delete(waiter);waiter();}};
  const trackSeller=async(kind,work)=>{sellerTimingState.active+=1;sellerTimingState.maxActive=Math.max(sellerTimingState.maxActive,sellerTimingState.active);sellerTimingState[`${kind}Calls`]+=1;sellerTimingState.events.push({kind,event:'start',at:timestamp()});try{return await work();}finally{sellerTimingState.events.push({kind,event:'finish',at:timestamp()});sellerTimingState.active-=1;wakeIdle();}};
  let delayAvailable=sellerNativeEvidenceDelayMs>0;
  const nativePaymentEvidence=createNativePaymentEvidenceConsumer({rpcUrl:transport.capability.pins.endpoint,sourceCapability:transport.capability,anchorEvidence:async(input)=>{sellerTimingState.anchorCalls+=1;const answer=await evidenceBridge.anchor(input);if(delayAvailable){delayAvailable=false;sellerTimingState.delayedAnchors+=1;sellerTimingState.events.push({kind:'nativeEvidenceAnchor',event:'delay-start',at:timestamp(),delayMs:sellerNativeEvidenceDelayMs});await new Promise(resolve=>setTimeout(resolve,sellerNativeEvidenceDelayMs));sellerTimingState.events.push({kind:'nativeEvidenceAnchor',event:'delay-finish',at:timestamp(),delayMs:sellerNativeEvidenceDelayMs});}return answer;},readSignedProjection});
  const agreementAnchor=createSellerSr2AgreementAnchor({reader:createDemosSr2Adapter({rpcUrl:transport.capability.pins.endpoint,sourceCapability:transport.capability,journal:createInMemoryDemosSr2Journal()})});
  const composition=await createDevnetDemoComposition({buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true}),authority:transport.authority,sourceCapability:transport.capability,publicJournal,partyVetStore,sellerWalletFactory,
    commitOnSignature,signatureBuyer,sellerSigner:{claim:sellerActor.signer.claim,sign:(bytes)=>{if(bytes.toString().startsWith('dacs-finality-commitment:v1:'))onCommitmentSign();return sellerActor.signer.signBytes(bytes);}},listingDraft,
    scanOwnListings:async(prefix)=>{trace('scan-start');const answer=await transport.capability.readRpc('/',{method:'nodeCall',params:[{message:'searchStoragePrograms',data:{query:prefix,options:{exactMatch:false,limit:50,offset:0}}}]});trace('scan-end');return answer?.result===200&&Array.isArray(answer.response)&&answer.response.length===0?{status:'ok',anchors:[]}:{status:'indeterminate',reason:'fresh seller history scan is unavailable or nonempty'};},
    loadRailResolution:(listing)=>{trace('rail');return railAuthority(listing);},agreementAnchor,nativePaymentEvidence,sellerTransport,sellerEndpoint:(claim)=>endpoints.get(claim)??null,durableDirectory:join(dir,'seller-state'),
    observeDemosTransfer:(hash)=>transport.capability.chainReader().observeTransfer(hash),producePurchasedContent:({settlementId})=>`Fresh purchased Node2 report for ${settlementId}.`,
    ...(buyerChainReadback==='on'?{publicSignedCreates:true}:{})});
  trace('composition');
  evidenceBridge=createDemosSr2WalletBridge({rpcUrl:transport.capability.pins.endpoint,network:'demos-devnet',journal:sellerWalletJournal,walletFactory:sellerWalletFactory,sourceCapability:transport.capability});
  directory.add(summaryFor(composition.listing,composition.published.ref),composition.listing);
  const store=createSellerTransportStore({path:join(dir,'seller-transport.sqlite')});
  const serverAuth=createSellerTransportServerAuth({sellerSigner:{claim:sellerActor.signer.claim,sign:(bytes)=>sellerActor.signer.signBytes(bytes)},listingPin:composition.sellerAgent.listingPin,store});
  const observedSellerAgent={...composition.sellerAgent,commitOnSignature:(input)=>trackSeller('signatureCommitment',()=>composition.sellerAgent.commitOnSignature(input)),commit:async(input)=>{const answer=await composition.sellerAgent.commit(input);await testHooks.afterSellerCommit?.(structuredClone(answer));return answer;},submitPayment:(input)=>trackSeller('submitPayment',()=>composition.sellerAgent.submitPayment(input)),reconcileTransport:(input)=>trackSeller('reconcileTransport',()=>composition.sellerAgent.reconcileTransport(input))};
  // Every response the seller sends, as sent (TEST inspection only).
  const sellerResponses=[],sellerHandler=createSellerHttpHandler(observedSellerAgent,{authentication:serverAuth,commitOnSignature,...(composition.publicSignedCreates?{publicSignedCreates:composition.publicSignedCreates}:{})});
  const sellerServer=http.createServer((req,res)=>{const end=res.end.bind(res);res.end=(chunk,...rest)=>{if(chunk!=null&&typeof chunk!=='function')sellerResponses.push({path:req.url,status:res.statusCode,text:String(chunk)});return end(chunk,...rest);};return sellerHandler(req,res);}),sellerOrigin=`http://127.0.0.1:${await listen(sellerServer)}`;endpoints.set(sellerActor.signer.claim,sellerOrigin);
  trace('seller-http');
  const config=loadConfig({DACS_INTENT_APPROVAL:intentApproval?'on':'off',DACS_COMMIT_ON_SIGNATURE:appCommitOnSignature?'on':'off',DACS_PUBLIC_ORIGIN:origin,DACS_ALLOW_INSECURE_LOCALHOST:'1',DACS_OAUTH_COOKIE_KEYS:randomBytes(32).toString('hex'),DACS_DATA_DIR:join(dir,'app'),DACS_DIRECTORY_ORIGIN:directory.url,DACS_CHAIN_RPC_URL:transport.chain.url,DACS_ALLOWED_REDIRECT_ORIGINS:CALLBACK_ORIGIN,DACS_LOG_LEVEL:'debug',DACS_BUYER_CHAIN_READBACK:buyerChainReadback,...env});
  const app=await createApp({config,devnetAgreementTransport:transport.capability,dacsProtocol:{...composition.dacsProtocol,sellerRequestTimeoutMs,...(planWaitMs?{planWaitMs}:{})},logger:createLogger({level:'debug',sink:(line)=>logs.push(line)})});
  trace('app');
  appHandler=(req,res)=>app.app(req,res);
  const sellerTiming={snapshot:()=>structuredClone(sellerTimingState),waitForIdle:({timeoutMs=60000}={})=>{if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('timeoutMs must be a positive integer');if(sellerTimingState.active===0)return Promise.resolve();return new Promise((resolve,reject)=>{let timer;const ready=()=>{clearTimeout(timer);resolve();};idleWaiters.add(ready);timer=setTimeout(()=>{idleWaiters.delete(ready);reject(new Error('seller timing idle deadline exceeded'));},timeoutMs);});}};
  // Closes the seller's journals and removes their files; every later seller journal call throws.
  let sellerJournalsClosed=false;
  const deleteSellerJournals=()=>{sellerJournals.deleted=true;if(!sellerJournalsClosed){sellerJournalsClosed=true;publicJournal.close();sellerWalletJournal.close();}
    for(const name of ['seller-artifact-intents.sqlite','seller-public-wallet.sqlite'])for(const suffix of ['','-wal','-shm'])rmSync(join(dir,`${name}${suffix}`),{force:true});};
  // TEST inspection only: the seller's journal rows and its private state directory.
  const readSellerJournals=async()=>({artifacts:await publicJournal.entries(),wallet:await sellerWalletJournal.entries()});
  return{origin,mcpUrl:`${origin}/mcp`,app,config,logs,transport,directory,composition,partyVetStore,sellerActor,authenticationRegistry,jobContexts,sellerOrigin,sellerTiming,testHooks,sellerJournals,deleteSellerJournals,readSellerJournals,stateDirectory:dir,sellerResponses,
    async close(){await close(appServer);await app.close();await close(sellerServer);composition.sellerAgent.close();store.close();if(!sellerJournalsClosed){publicJournal.close();sellerWalletJournal.close();}partyVetStore.close();await sellerActor.close();await directory.close();await transport.close();rmSync(dir,{recursive:true,force:true});}};
}
