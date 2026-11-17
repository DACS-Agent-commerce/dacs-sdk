import { withFixtureProfile } from './wire-authority-fixture.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { purchaseSupport } from '../../src/dacs/listing.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from '../../src/dacs/agreement-context-consumer.mjs';
import DatabaseSync from 'better-sqlite3';
import { testWallet } from './protocol-fixture.mjs';
let nextTestWallet = 30;
const key = () => { const wallet = testWallet(nextTestWallet++); return { claim: wallet.claim, sign: wallet.signBytes }; };
import { randomBytes } from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {identityBundleHash} from '@kynesyslabs/dacs';
import {distinctHeaders} from './listener-host.mjs';
// The transport comes from the package root, as a host composes it.
const {createSellerTransportClientAuth}=await import('../../src/index.mjs');
const {createSellerTransportStore}=await import('./bound-transport-store.mjs');
const {SELLER_TRANSPORT_HEADER,SELLER_CONTEXT_PATH,sellerContextChallengeScope,sellerContextScopeHash}=await import('../../src/dacs/seller-transport-auth.mjs');
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ'];
const T=1800000000000;
function bundleFor(buyer,at=T){const b={bundleVersion:'1',presentedBy:buyer.claim,presentedAt:at,sessionNonce:'a'.repeat(64),claims:[{ref:buyer.claim}]};return {...b,presentation:{kind:'per-claim',signatures:[{ref:buyer.claim,signature:buyer.sign(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(b))).toString('base64url')}]}};}
function exchange(handler,{text='{}',header,url=SELLER_CONTEXT_PATH,headers={},method='POST',chunks}={}){
 const req=new PassThrough();const requestHeaders={'content-type':'application/json',...(header?{[SELLER_TRANSPORT_HEADER]:header}:{}),...headers};Object.assign(req,{url,method,headers:requestHeaders,headersDistinct:distinctHeaders(requestHeaders),socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1'}});
 const res={destroyed:false,writableEnded:false,headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true},end(text){this.text=text;this.writableEnded=true;}};
 const pending=handler(req,res);queueMicrotask(()=>{for(const chunk of chunks??[text])req.write(chunk);req.end()});return Promise.resolve(pending).then(()=>res);
}
// A signed context request over a bound transport store, made with the transport's own client, for the store-level tests that need
// such a request. No HTTP handler or context route runs on it.
const START_LIMITS={maxStartsPerHour:2,maxStartsPerBuyerPerHour:1};
async function world(t){
 const dir=await mkdtemp(join(tmpdir(),'d5-wire-'));t.after(()=>rm(dir,{recursive:true,force:true}));let time=T;
 const seller=key(),buyer=key(),other=key(),listing=fixtureListing({...seller,signBytes:seller.sign},{now:T}),pin=listingPin(listing),support=purchaseSupport(listing);
 const path=join(dir,'transport.sqlite'),store=withFixtureProfile(createSellerTransportStore({path,maxRecords:10000,maxJobs:10000,maxChallenges:10000,maxContextRecords:10000,contextSessionState:()=>null,contextStartLimits:START_LIMITS,maxNoncesPerBuyerPerWindow:120,now:()=>time}));t.after(()=>store.close());
 store.bind({seller:seller.claim,listingPin:pin});
 const bundles=new Map();
 const wire=async({actor=buyer,jobId=JOBS[0],alter=()=>{}}={})=>{
  const cacheKey=actor.claim+jobId;
  const bundle=structuredClone(bundles.get(cacheKey)??bundleFor(actor,time)),scope={source:AGREEMENT_CONTEXT_SOURCE,wallet:'0x'+actor.claim.slice(16),jobId,buyer:actor.claim,buyerBundleHash:identityBundleHash(bundle),seller:seller.claim,listingPin:pin,rail:{railId:'demos-native:DEM',railVersion:1},payee:support.payee,price:support.price,generatedAt:bundle.presentedAt};
  const body={scope,buyerIdentityBundle:bundle};alter(body);
  // Challenge issuance is fixture setup: the nonce is written to the ledger directly.
  let challenge={sessionNonce:bundle.sessionNonce};
  if(!bundles.has(cacheKey)) {
   challenge={sessionNonce:randomBytes(32).toString('hex')};
   const db=new DatabaseSync(path);
   try { db.prepare("INSERT INTO kit_challenges (nonce,jobId,buyer,challengeScopeHash,origin,issuedAt,expiresAt,state) VALUES (?,?,?,?,'route',?,?,'issued')").run(challenge.sessionNonce,jobId,actor.claim,sellerContextScopeHash(sellerContextChallengeScope(scope)),time,time+600000); }
   finally { db.close(); }
  }
  bundle.sessionNonce=challenge.sessionNonce;
  bundles.set(cacheKey,structuredClone(bundle));
  // Keep the presenter's signature and both request hashes valid even for
  // negative schema/profile vectors, so a later binding failure cannot mask them.
  scope.buyerBundleHash=identityBundleHash(bundle);
  bundle.presentation.signatures[0].signature=actor.sign(Buffer.from('dacs-bundle-presentation:v1:'+scope.buyerBundleHash)).toString('base64url');
  const text=JSON.stringify(body);
  const client=createSellerTransportClientAuth({buyerSigner:actor,seller:seller.claim,resolveJob:()=>({listingPin:pin,agreementHash:sellerContextScopeHash(scope)}),now:()=>time});
  const {header,payload}=await client.request(SELLER_CONTEXT_PATH,body,text);return {text,header,request:payload};
 };
 const counts=()=>{const db=new DatabaseSync(path,{readonly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'peer_%' AND name NOT IN ('peer_meta','kit_challenges') ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n]))}finally{db.close()}};
 return {wire,store,buyer,other,seller,listing,pin,path,counts,now:()=>time,advance:ms=>{time+=ms}};
}

export {JOBS,T,key,bundleFor,exchange,world};
