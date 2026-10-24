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
const {createSellerTransportStore,createSellerTransportServerAuth,createSellerTransportClientAuth,SELLER_TRANSPORT_HEADER,SELLER_CONTEXT_PATH,SELLER_CONTEXT_CHALLENGE_PATH,sellerContextChallengeScope,sellerContextScopeHash}=await import('../../src/dacs/seller-transport-auth.mjs');
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ'];
const T=1800000000000;
function bundleFor(buyer){const b={bundleVersion:'1',presentedBy:buyer.claim,presentedAt:T,sessionNonce:'a'.repeat(64),claims:[{ref:buyer.claim}]};return {...b,presentation:{kind:'per-claim',signatures:[{ref:buyer.claim,signature:buyer.sign(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(b))).toString('base64url')}]}};}
function exchange(handler,{text='{}',header,url=SELLER_CONTEXT_PATH,headers={},method='POST',chunks}={}){
 const req=new PassThrough();Object.assign(req,{url,method,headers:{'content-type':'application/json',...(header?{[SELLER_TRANSPORT_HEADER]:header}:{}),...headers},socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1'}});
 const res={destroyed:false,writableEnded:false,headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true},end(text){this.text=text;this.writableEnded=true;}};
 const pending=handler(req,res);queueMicrotask(()=>{for(const chunk of chunks??[text])req.write(chunk);req.end()});return Promise.resolve(pending).then(()=>res);
}
export { JOBS,T,key,bundleFor,exchange };
