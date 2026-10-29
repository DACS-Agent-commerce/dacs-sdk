import { fixtureListing } from '../fixtures/listings.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { purchaseSupport } from '../../src/dacs/listing.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from '../../src/dacs/agreement-context-consumer.mjs';
import DatabaseSync from 'better-sqlite3';
import { testWallet } from './protocol-fixture.mjs';
let nextTestWallet = 30;
const key = () => { const wallet = testWallet(nextTestWallet++); return { claim: wallet.claim, sign: wallet.signBytes }; };
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {canonicalize,identityBundleHash,sha256Hex} from '@kynesyslabs/dacs';
const {createSellerHttpHandler}=await import('../../src/dacs/seller-http.mjs');
const {createSellerContextRoute,SELLER_CONTEXT_LIMITS}=await import('../../src/dacs/seller-context-route.mjs');
const {createSellerTransportStore,createSellerTransportServerAuth,createSellerTransportClientAuth,SELLER_TRANSPORT_HEADER,SELLER_CONTEXT_PATH,SELLER_CONTEXT_CHALLENGE_PATH,sellerContextChallengeScope,sellerContextScopeHash}=await import('../../src/dacs/seller-transport-auth.mjs');
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ'];
const T=1800000000000;
function bundleFor(buyer){const b={bundleVersion:'1',presentedBy:buyer.claim,presentedAt:T,sessionNonce:'a'.repeat(64),claims:[{ref:buyer.claim}]};return {...b,presentation:{kind:'per-claim',signatures:[{ref:buyer.claim,signature:buyer.sign(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(b))).toString('base64url')}]}};}
function exchange(handler,{text='{}',header,url=SELLER_CONTEXT_PATH,headers={},method='POST',chunks}={}){
 const req=new PassThrough();Object.assign(req,{url,method,headers:{'content-type':'application/json',...(header?{[SELLER_TRANSPORT_HEADER]:header}:{}),...headers},socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1'}});
 const res={destroyed:false,writableEnded:false,headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true},end(text){this.text=text;this.writableEnded=true;}};
 const pending=handler(req,res);queueMicrotask(()=>{for(const chunk of chunks??[text])req.write(chunk);req.end()});return Promise.resolve(pending).then(()=>res);
}
// A present context answer; as recover it reads back and verifies both Vet records.
const presentContext=async body=>({disposition:'present',value:{scope:body.scope,input:{jobId:body.scope.jobId}}});
async function world(t,{limits={maxStartsPerHour:2,maxStartsPerBuyerPerHour:1},maxRecords=10000,maxChallenges=10000,maxContextRecords=10000,contextSessionState=()=>null,assertBuyerAccess=()=>{},maxNoncesPerBuyerPerWindow=120,releaseFails=false,releaseWrites=null,admitWrites=null,writable=()=>true,recover=async()=>null,resumable=null,perform=presentContext,...http}={}){
 const dir=await mkdtemp(join(tmpdir(),'d5-wire-'));t.after(()=>rm(dir,{recursive:true,force:true}));let time=T;
 const seller=key(),buyer=key(),other=key(),listing=fixtureListing({...seller,signBytes:seller.sign},{now:T}),pin=listingPin(listing),support=purchaseSupport(listing);
 const path=join(dir,'transport.sqlite'),store=createSellerTransportStore({path,maxRecords,maxChallenges,maxContextRecords,contextSessionState,maxNoncesPerBuyerPerWindow,now:()=>time});t.after(()=>store.close());
 const auth=createSellerTransportServerAuth({sellerSigner:seller,listingPin:pin,store,now:()=>time});let holds=0,writes=0,logs=0,releases=0;
 const route=createSellerContextRoute({listing,resolveBuyer:async (body,options)=>{writes++;return perform(body,options)},assertBuyerAccess,now:()=>time,limits,recover,resumable,writable,
  admitWrites:async input=>{holds++;return admitWrites?admitWrites(input):null},releaseWrites:async input=>{releases++;if(releaseFails)throw new Error('release fixture failure');return releaseWrites?.(input)}});
 const agent={claim:seller.claim,listingPin:pin,agreementState:()=>({proposal:null,contribution:null})};
 const handler=createSellerHttpHandler(agent,{authentication:auth,context:route,...http});
 const bundles=new Map();
 const wire=async({actor=buyer,jobId=JOBS[0],alter=()=>{},fresh=false}={})=>{
  const cacheKey=actor.claim+jobId+time;
  if(fresh)bundles.delete(cacheKey);
  const bundle=structuredClone(bundles.get(cacheKey)??bundleFor(actor)),scope={source:AGREEMENT_CONTEXT_SOURCE,wallet:'0x'+actor.claim.slice(16),jobId,buyer:actor.claim,buyerBundleHash:identityBundleHash(bundle),seller:seller.claim,listingPin:pin,rail:{railId:'demos-native:DEM',railVersion:1},payee:support.payee,price:support.price,generatedAt:time};
  const body={scope,buyerIdentityBundle:bundle};alter(body);
  // Challenge issuance is fixture setup. HTTP issuance and its own limits
  // are exercised separately below, without this setup shortcut.
  const challenge=bundles.has(cacheKey)?{sessionNonce:bundle.sessionNonce}:store.issueContextChallenge({jobId,buyer:actor.claim},sellerContextChallengeScope(scope),{maxPerBuyer:1000,maxGlobal:1000,admit:()=>time});
  bundle.sessionNonce=challenge.sessionNonce;
  bundles.set(cacheKey,structuredClone(bundle));
  // Keep the presenter's signature and both request hashes valid even for
  // negative schema/profile vectors, so a later binding failure cannot mask them.
  scope.buyerBundleHash=identityBundleHash(bundle);
  bundle.presentation.signatures[0].signature=actor.sign(Buffer.from('dacs-bundle-presentation:v1:'+scope.buyerBundleHash)).toString('base64url');
  const text=JSON.stringify(body);
  const client=createSellerTransportClientAuth({buyerSigner:actor,seller:seller.claim,resolveJob:()=>({listingPin:pin,agreementHash:sellerContextScopeHash(scope)}),now:()=>time});
  const {header}=await client.request(SELLER_CONTEXT_PATH,body,text);return {text,header};
 };
 const counts=()=>{const db=new DatabaseSync(path,{readonly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'peer_%' AND name NOT IN ('peer_meta','peer_context_challenges') ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n]))}finally{db.close()}};
 const effects=()=>({holds,writes,logs,releases,counts:counts()});
 return {handler,wire,store,auth,route,buyer,other,seller,listing,pin,path,effects,now:()=>time,advance:ms=>{time+=ms}};
}


export {JOBS,T,key,bundleFor,exchange,presentContext,world};
