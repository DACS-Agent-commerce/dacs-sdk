import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {readFileSync,readdirSync} from 'node:fs';
import {startHarness} from './helpers/harness.mjs';
import {createPortalRouter} from '../src/portal/routes.mjs';
import {loadConfig} from '../src/config.mjs';
import {contractView,runtimeNames} from './helpers/env-contract-view.mjs';
import {OperationError} from '../src/operations.mjs';

// Keep byte checks on direct private loopback sockets, without inherited
// global fetch proxy agents. This adapter never accepts an external URL.
function fetch(input,options={}){
  const url=new URL(input);assert.equal(url.hostname,'127.0.0.1');
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method:options.method??'GET',headers:options.headers,agent:false},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,ok:res.statusCode>=200&&res.statusCode<300,text:async()=>bytes.toString('utf8'),json:async()=>JSON.parse(bytes.toString('utf8')),arrayBuffer:async()=>bytes});});
    });
    req.on('error',reject);req.end(options.body);
  });
}
const publicDir=new URL('../public/portal/',import.meta.url);
function assets(dir=publicDir,prefix=''){
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?assets(new URL(`${entry.name}/`,dir),`${prefix}${entry.name}/`):/\.(html|js|mjs|css)$/.test(entry.name)?[`${prefix}${entry.name}`]:[]);
}
const configEnv={DACS_PUBLIC_ORIGIN:'https://TEST.example',DACS_AUTH_MODE:'external',DACS_OAUTH_ISSUER:'https://TEST-issuer.example'};

test('auto-advance config defaults off, rejects typos, and matches its deployment contract entry',()=>{
  assert.equal(loadConfig(configEnv).portalAutoAdvance,'off');
  assert.equal(loadConfig({...configEnv,DACS_PORTAL_AUTO_ADVANCE:'on'}).portalAutoAdvance,'on');
  for(const value of ['', '1', 'true', 'ON'])assert.throws(()=>loadConfig({...configEnv,DACS_PORTAL_AUTO_ADVANCE:value}),/DACS_PORTAL_AUTO_ADVANCE/);
  const contract=contractView();
  assert.equal(contract.variables.DACS_PORTAL_AUTO_ADVANCE.default,'off');assert.equal(contract.variables.DACS_PORTAL_AUTO_ADVANCE.deployValue,'off');
  assert.deepEqual(Object.keys(contract.variables).sort(),runtimeNames());
});

test('switch off serves every existing portal HTML, JS and CSS byte unchanged and exposes no auto endpoint',async()=>{
  const h=await startHarness();
  try{
    assert.deepEqual(Buffer.from(await fetch(`${h.origin}/portal/purchase/TEST`).then(r=>r.arrayBuffer())),readFileSync(new URL('index.html',publicDir)));
    for(const file of assets()){
      const response=await fetch(`${h.origin}/portal/assets/${file}`);assert.equal(response.status,200,file);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(new URL(file,publicDir)),file);
    }
    assert.equal((await fetch(`${h.origin}/portal/assets/auto-portal.js`)).status,404);
    assert.equal((await fetch(`${h.origin}/portal/api/purchase/TEST/auto/recheck`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
    const {linkedUser,tool,seedSellerListing,tokenFrom}=await import('./helpers/flows.mjs'),{createEphemeralWallet}=await import('./fixtures/wallet.mjs');
    const seller=createEphemeralWallet();seedSellerListing(h,seller,{listingId:'TEST-off-auto',price:'1'});const u=await linkedUser(h);
    const p=await tool(h,u,'prepare_purchase',{listingId:'TEST-off-auto',version:1,seller:seller.claim,idempotencyKey:'TEST-off-auto'});
    const body=JSON.stringify({token:tokenFrom(p.approvalUrl)});
    assert.equal((await fetch(`${h.origin}/portal/api/purchase/${p.operationId}/auto/recheck`,{method:'POST',headers:{'content-type':'application/json'},body})).status,404,'even a valid purchase token cannot enable the off route');
    const view=await fetch(`${h.origin}/portal/api/purchase/${p.operationId}/view`,{method:'POST',headers:{'content-type':'application/json'},body}).then(r=>r.json());assert.equal(view.autoAdvance,undefined);
  }finally{await h.close();}
});

test('switch on changes only the purchase entry; other portal and standalone wallet entries keep their bytes',async()=>{
  const h=await startHarness({env:{DACS_PORTAL_AUTO_ADVANCE:'on'}});
  try{
    const original=readFileSync(new URL('index.html',publicDir),'utf8');
    assert.equal(await fetch(`${h.origin}/portal/purchase/TEST`).then(r=>r.text()),original.replace('/portal/assets/portal.js','/portal/assets/auto-portal.js'));
    for(const path of ['/portal/authorize/TEST','/portal/link','/portal/publish/TEST','/portal/identity/TEST'])assert.equal(await fetch(h.origin+path).then(r=>r.text()),original);
    const source=await fetch(`${h.origin}/portal/assets/auto-portal.js`).then(r=>r.text());assert.match(source,/createPurchaseAutoAdvance/);assert.match(source,/purchaseAuto\.markWrite\(\)/);
    assert.equal(await fetch(`${h.origin}/portal/assets/portal.js`).then(r=>r.text()),readFileSync(new URL('portal.js',publicDir),'utf8'));
    assert.equal(await fetch(`${h.origin}/portal/assets/embedded-wallet/ui.mjs`).then(r=>r.text()),readFileSync(new URL('embedded-wallet/ui.mjs',publicDir),'utf8'));
  }finally{await h.close();}
});

test('enabled readback authenticates the token, uses the bound account and reports signature readiness without leaking signatures',async()=>{
  const calls=[];let operation={id:'TEST',accountId:'TEST-bound-account',status:'agreement_pending',terms:{protocol:{jobId:'TEST-job'}},state:{protocol:{stage:'agreement-signing'}}};
  const purchases={portalOperation(id,token){if(id!=='TEST'||token!=='TEST-token')throw new OperationError('not_found','invalid purchase token');return operation;},portalEvidence:op=>({protocol:{stage:op.state.protocol.stage}}),verifyDeal:async args=>{calls.push(args);return{operation};}};
  const app=express(),router=createPortalRouter({config:{portalAutoAdvance:'on'},db:{prepare:()=>({get(){},run(){}})},purchases,logger:{error(){},info(){},debug(){}},timeline:{record(){}}});app.use(router);
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body)=>{const r=await fetch(`${origin}/portal/api/purchase/TEST/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  try{
    assert.equal((await post('auto/recheck',{token:'BAD',accountId:'TEST-bound-account'})).status,404);assert.equal(calls.length,0);
    for(const [status,state,required] of [
      ['agreement_pending',{stage:'identity'},true],['agreement_pending',{stage:'agreement-signing'},true],['agreement_pending',{stage:'agreement-signing',signatures:{agreement:'TEST-signature'}},false],['awaiting_approval',{stage:'committed'},true],['settled_verified',{stage:'awaiting-countersignature',bundle:{}},true],['settled_verified',{stage:'awaiting-countersignature',bundle:{buyerSignature:'TEST-signature'}},false]]){
      operation={...operation,status,state:{protocol:state}};
      const result=await post('auto/recheck',{token:'TEST-token',accountId:'TEST-attacker',txHash:'a'.repeat(64)});
      assert.equal(result.status,200);assert.equal(result.body.autoAdvance.requiresSignature,required);assert.doesNotMatch(JSON.stringify(result.body),/TEST-signature/);
      assert.deepEqual(calls.at(-1),{accountId:'TEST-bound-account',operationId:'TEST',txHash:'a'.repeat(64),attachOnly:true});
      assert.equal((await post('view',{token:'TEST-token'})).body.autoAdvance.requiresSignature,required);
    }
  }finally{await router.drainPurchasePolls();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});

test('automatic readback refreshes a pending payment observation on the existing fixture purchase path',async()=>{
  const {linkedUser,tool,portal,seedSellerListing,approvePurchase,reportPurchase}=await import('./helpers/flows.mjs');
  const {createEphemeralWallet}=await import('./fixtures/wallet.mjs');
  const h=await startHarness({env:{DACS_PORTAL_AUTO_ADVANCE:'on'}});
  try{
    const seller=createEphemeralWallet();seedSellerListing(h,seller,{listingId:'TEST-auto-payment',price:'1'});const u=await linkedUser(h);
    const p=await tool(h,u,'prepare_purchase',{listingId:'TEST-auto-payment',version:1,seller:seller.claim,idempotencyKey:'TEST-auto-payment'});
    const {approved,token}=await approvePurchase(h,p.operationId,p.approvalUrl,u.wallet),hash=h.chain.walletBroadcast(approved.payload);
    h.chain.faults.pendingHashes.add(hash);assert.equal((await reportPurchase(h,p.operationId,token,{txHash:hash})).status,'broadcast_reported');h.chain.faults.pendingHashes.delete(hash);
    let checked;do{checked=await portal(h,`/portal/api/purchase/${p.operationId}/auto/recheck`,{token});}while(checked.poll?.pending);
    assert.equal(checked.status,'settled_verified');assert.equal(checked.evidence.receipt.txHash,hash);assert.equal(checked.autoAdvance.requiresSignature,false);
  }finally{await h.close();}
});

test('real pending /auto/recheck responses back off instead of polling every 500 ms',async()=>{
  const {linkedUser,tool,portal,seedSellerListing,approvePurchase,reportPurchase}=await import('./helpers/flows.mjs');
  const {createEphemeralWallet}=await import('./fixtures/wallet.mjs');
  const {createPurchaseAutoAdvance}=await import('../src/portal/purchase-auto-advance.mjs');
  const {fakeClock}=await import('./helpers/portal-auto-dom.mjs');
  const h=await startHarness({env:{DACS_PORTAL_AUTO_ADVANCE:'on'}});
  try{
    const seller=createEphemeralWallet();seedSellerListing(h,seller,{listingId:'TEST-auto-pending',price:'1'});const u=await linkedUser(h);
    const p=await tool(h,u,'prepare_purchase',{listingId:'TEST-auto-pending',version:1,seller:seller.claim,idempotencyKey:'TEST-auto-pending'});
    const {approved,token}=await approvePurchase(h,p.operationId,p.approvalUrl,u.wallet),hash=h.chain.walletBroadcast(approved.payload);
    h.chain.faults.pendingHashes.add(hash);assert.equal((await reportPurchase(h,p.operationId,token,{txHash:hash})).status,'broadcast_reported');
    const clock=fakeClock(),seen=[];
    const read=async()=>{await new Promise(resolve=>setTimeout(resolve,5));const view=await portal(h,`/portal/api/purchase/${p.operationId}/auto/recheck`,{token});seen.push(view);return view;};
    const auto=createPurchaseAutoAdvance({...clock,read,render(){}});auto.observe(await read());
    const delays=[];
    for(let i=0;i<5;i++){
      for(let wait=0;!clock.timers.size;wait++){assert.ok(wait<2000,'the readback finished');await new Promise(resolve=>setTimeout(resolve,5));}
      const timer=[...clock.timers.values()][0];delays.push(timer.ms);await clock.advance(timer.ms);
    }
    auto.destroy();
    assert.ok(seen.every(view=>view.status==='broadcast_reported'&&view.verification?.outcome==='awaiting_inclusion'),JSON.stringify(seen.map(v=>[v.status,v.verification?.outcome])));
    assert.ok(new Set(seen.map(view=>JSON.stringify(view))).size>1,'the pending responses themselves differ between reads');
    assert.deepEqual(delays,[500,1000,2000,4000,8000]);
  }finally{await h.close();}
});

test('enabled startup fails closed when the purchase page has no single script entry; switch off is unaffected',async()=>{
  const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
  const real=fs.readFileSync,deps={db:{prepare:()=>({get(){},run(){}})},purchases:{},logger:{error(){},info(){},debug(){}},timeline:{record(){}}};
  fs.readFileSync=function(path,...rest){const out=real.call(this,path,...rest);return String(path).endsWith('/public/portal/index.html')?String(out).replace('/portal/assets/portal.js','/portal/assets/portal-v2.js'):out;};
  syncBuiltinESMExports();
  let routes;try{routes=await import('../src/portal/routes.mjs?TEST-entry-drift');}finally{fs.readFileSync=real;syncBuiltinESMExports();}
  assert.throws(()=>routes.createPortalRouter({config:{portalAutoAdvance:'on'},...deps}),/entry drift/);
  assert.doesNotThrow(()=>routes.createPortalRouter({config:{portalAutoAdvance:'off'},...deps}));
});

test('a pointer the buyer corrects through verify_deal is not overwritten by the page hash; the purchase settles on the corrected hash',async()=>{
  const {linkedUser,tool,seedSellerListing,approvePurchase}=await import('./helpers/flows.mjs');
  const {createEphemeralWallet}=await import('./fixtures/wallet.mjs');
  const {createPurchaseAutoAdvance}=await import('../src/portal/purchase-auto-advance.mjs');
  const {fakeClock}=await import('./helpers/portal-auto-dom.mjs');
  const h=await startHarness({env:{DACS_PORTAL_AUTO_ADVANCE:'on'}});
  try{
    const seller=createEphemeralWallet();seedSellerListing(h,seller,{listingId:'TEST-auto-pointer',price:'1'});const u=await linkedUser(h);
    const p=await tool(h,u,'prepare_purchase',{listingId:'TEST-auto-pointer',version:1,seller:seller.claim,idempotencyKey:'TEST-auto-pointer'});
    const {approved,token}=await approvePurchase(h,p.operationId,p.approvalUrl,u.wallet),right=h.chain.walletBroadcast(approved.payload),wrong='c'.repeat(64);
    const post=(part,body)=>fetch(`${h.origin}/portal/api/purchase/${p.operationId}/${part}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,...body})});
    const sent=[],shown=[],clock=fakeClock();
    const read=async hash=>{const r=await post('auto/recheck',hash?{txHash:hash}:{}),body=await r.json();sent.push({hash,status:r.status,error:body.error});if(!r.ok)throw Object.assign(new Error(body.message),{code:body.error,status:r.status});return body;};
    const auto=createPurchaseAutoAdvance({...clock,read,render:v=>shown.push(v)});
    const step=async()=>{const before=sent.length;await clock.advance([...clock.timers.values()][0].ms);for(let wait=0;sent.length===before||!clock.timers.size&&!shown.some(v=>v.status==='settled_verified');wait++){assert.ok(wait<2000,'the readback finished');await new Promise(resolve=>setTimeout(resolve,5));}};
    auto.rememberHash(wrong);auto.observe(await post('view',{}).then(r=>r.json()));
    await step();assert.equal(sent[0].hash,wrong,'a page hash stands in for a lost report');
    const corrected=await tool(h,u,'verify_deal',{operationId:p.operationId,txHash:right});assert.equal(corrected.status,'settled_verified',JSON.stringify(corrected));
    const after=sent.length;
    for(let i=0;i<4&&clock.timers.size;i++)await step();
    auto.destroy();
    assert.deepEqual(sent.slice(after).map(s=>[s.hash,s.status]),sent.slice(after).map(()=>[null,200]),JSON.stringify(sent));
    assert.equal(shown.at(-1).status,'settled_verified');assert.equal(shown.at(-1).evidence.receipt.txHash,right);
  }finally{await h.close();}
});

// an earlier review. The PR's switch-off asset test enumerates the PR's own public tree,
// so it could not see an added route; this compares the controller URL with an
// asset that never existed, as main answers both.
test('switch off: the controller URL answers exactly like an asset that never existed, for GET, HEAD, Range and conditional GET; switch on serves it',async()=>{
  const variants=[['GET',{}],['HEAD',{}],['GET',{range:'bytes=0-9'}],['GET',{'if-none-match':'*'}],['GET',{'if-modified-since':'Fri, 01 Jan 2100 00:00:00 GMT'}]];
  // The dev 404 page names the requested file's absolute path; only that differs.
  const answer=async(origin,file,method,headers)=>{const r=await fetch(`${origin}/portal/assets/${file}`,{method,headers}),{date,...rest}=r.headers;return{status:r.status,headers:{...rest,'content-length':undefined},body:(await r.text()).replace(file,'FILE')};};
  const off=await startHarness();
  try{
    for(const [method,headers] of variants){
      const controller=await answer(off.origin,'purchase-auto-advance.mjs',method,headers);
      assert.equal(controller.status,404,`${method} ${JSON.stringify(headers)}`);
      assert.deepEqual(controller,await answer(off.origin,'TEST-never-existed.mjs',method,headers),`${method} ${JSON.stringify(headers)}`);
    }
  }finally{await off.close();}
  const on=await startHarness({env:{DACS_PORTAL_AUTO_ADVANCE:'on'}});
  try{
    const r=await fetch(`${on.origin}/portal/assets/purchase-auto-advance.mjs`);
    assert.equal(r.status,200);assert.match(r.headers['content-type'],/javascript/);
    assert.equal(await r.text(),readFileSync(new URL('../src/portal/purchase-auto-advance.mjs',import.meta.url),'utf8'));
  }finally{await on.close();}
});

test('a correction made through verify_deal before the page reads again stands: the stale page hash is not attached over it, and the purchase settles on the correction',async()=>{
  const {linkedUser,tool,portal,seedSellerListing,approvePurchase}=await import('./helpers/flows.mjs');
  const {createEphemeralWallet}=await import('./fixtures/wallet.mjs');
  const {createPurchaseAutoAdvance}=await import('../src/portal/purchase-auto-advance.mjs');
  const {fakeClock}=await import('./helpers/portal-auto-dom.mjs');
  const h=await startHarness({env:{DACS_PORTAL_AUTO_ADVANCE:'on'}});
  try{
    const seller=createEphemeralWallet();seedSellerListing(h,seller,{listingId:'TEST-auto-early-fix',price:'1'});const u=await linkedUser(h);
    const p=await tool(h,u,'prepare_purchase',{listingId:'TEST-auto-early-fix',version:1,seller:seller.claim,idempotencyKey:'TEST-auto-early-fix'});
    const {approved,token}=await approvePurchase(h,p.operationId,p.approvalUrl,u.wallet),right=h.chain.walletBroadcast(approved.payload),wrong='c'.repeat(64);
    h.chain.faults.pendingHashes.add(right);
    const initial=await portal(h,`/portal/api/purchase/${p.operationId}/view`,{token});
    assert.equal((await tool(h,u,'verify_deal',{operationId:p.operationId,txHash:right})).status,'broadcast_reported');
    const sent=[],auto=createPurchaseAutoAdvance({...fakeClock(),read:hash=>{sent.push(hash);return portal(h,`/portal/api/purchase/${p.operationId}/auto/recheck`,{token,...(hash?{txHash:hash}:{})});},render(){}});
    auto.observe(initial);auto.rememberHash(wrong);
    const first=await auto.check();
    assert.equal(sent[0],wrong,'the page still offers its hash: the server, not the page, decides');
    assert.equal(first.evidence.reportedTxHash,right,'the recorded correction is read back, not replaced');
    assert.equal((await portal(h,`/portal/api/purchase/${p.operationId}/view`,{token})).evidence.reportedTxHash,right);
    h.chain.faults.pendingHashes.delete(right);
    let settled;for(let i=0;i<10&&settled?.status!=='settled_verified';i++)settled=await auto.check();
    auto.destroy();
    assert.deepEqual(sent.slice(1),sent.slice(1).map(()=>null),'the page hash is retired after the first read');
    assert.equal(settled.status,'settled_verified');assert.equal(settled.evidence.receipt.txHash,right);
    const late=await portal(h,`/portal/api/purchase/${p.operationId}/auto/recheck`,{token,txHash:wrong});
    assert.equal(late.status,'settled_verified','a stale page hash on a settled purchase reads back the receipt');assert.equal(late.evidence.receipt.txHash,right);
  }finally{await h.close();}
});
