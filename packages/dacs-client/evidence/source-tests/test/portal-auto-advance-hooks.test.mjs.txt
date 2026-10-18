// Regression tests for the enabled purchase page's merged hooks (the source change's notSaved
// and counter-signature guards, the standalone CREATE, already_countersigned and
// closed buyer access), and for the readiness the enabled server reports.
import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import express from 'express';
import {createPortalRouter} from '../src/portal/routes.mjs';
import {protocolView} from '../src/dacs/protocol-purchases.mjs';
import {OperationError} from '../src/operations.mjs';
import {createPurchaseAutoAdvance,purchasePhase,recoverable} from '../src/portal/purchase-auto-advance.mjs';
import {fakeClock,flush} from './helpers/portal-auto-dom.mjs';
import {portalHarness} from './helpers/portal-auto-harness.mjs';
import {reportProjection} from './helpers/purchased-report-dom.mjs';

const notSaved={savedRevision:3,savedStage:'agreement-anchored'};
const agreement=(protocol,requiresSignature)=>({status:'agreement_pending',autoAdvance:{requiresSignature},evidence:{protocol}});
const bundle=(protocol,requiresSignature)=>({status:'settled_verified',autoAdvance:{requiresSignature},evidence:{protocol:{stage:'awaiting-countersignature',...protocol}}});
const echo=view=>async(_path,_body,enrich)=>({ok:true,data:enrich(view)});
const buttons=h=>h.document.getElementById('flow').querySelectorAll('button').map(b=>b.attributes.id??b.text);
const SIGNING=['dacs-sign-agreement','dacs-countersign','Approve Agreement CREATE'];
const CLOSED={error:'buyer_access_closed',message:'this operator accepts only its configured custody buyer while openBuyerAccess is off; nothing was prepared, signed or sent'};

// Readiness is checked through the enabled router with the source change's own protocol view,
// so the displayed stage and notSaved marker are the ones the page receives.
test('enabled readiness follows the displayed stage and is never "needs signature" on a notSaved view',async()=>{
  let operation=null;
  const purchases={portalOperation(id,token){if(id!=='TEST'||token!=='TEST-token')throw new OperationError('not_found','invalid purchase token');return operation;},portalEvidence:op=>({protocol:protocolView(op)}),verifyDeal:async()=>({operation})};
  const app=express(),router=createPortalRouter({config:{portalAutoAdvance:'on'},db:{prepare:()=>({get(){},run(){}})},purchases,logger:{error(){},info(){},debug(){}},timeline:{record(){}}});app.use(router);
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const post=(path)=>new Promise((resolve,reject)=>{
    const req=http.request(`http://127.0.0.1:${server.address().port}/portal/api/purchase/TEST/${path}`,{method:'POST',headers:{'content-type':'application/json'},agent:false},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});
    req.on('error',reject);req.end(JSON.stringify({token:'TEST-token'}));
  });
  try{
    for(const [name,status,state,required,stage] of [
      ['notSaved Agreement at agreement-signing','agreement_pending',{stage:'agreement-signing',notSaved},false,'agreement-signing'],
      ['notSaved Agreement at identity','agreement_pending',{stage:'identity',notSaved},false,'identity'],
      ['notSaved bundle','settled_verified',{stage:'awaiting-countersignature',notSaved,bundle:{}},false,'awaiting-countersignature'],
      ['saved bundle needing the counter-signature','settled_verified',{stage:'awaiting-countersignature',bundle:{}},true,'awaiting-countersignature'],
      ['legacy completed row, counter-signed, copy not read back','settled_verified',{stage:'completed',bundle:{buyerSignature:'TEST-signature'}},false,'awaiting-countersignature'],
      ['completed row without a buyer signature, shown as awaiting it','settled_verified',{stage:'completed',bundle:{}},true,'awaiting-countersignature'],
      ['completed row with the copy read back','settled_verified',{stage:'completed',bundle:{buyerSignature:'TEST-signature',buyerCopyReadBack:true}},false,'completed']]){
      operation={id:'TEST',accountId:'TEST-account',status,terms:{protocol:{jobId:'TEST-job',profile:'TEST'}},state:{protocol:state}};
      for(const path of ['auto/recheck','view']){
        const {status:code,body}=await post(path);
        assert.equal(code,200,`${name} ${path}`);assert.equal(body.evidence.protocol.stage,stage,`${name} ${path}`);
        assert.equal(body.autoAdvance.requiresSignature,required,`${name} ${path}`);assert.doesNotMatch(JSON.stringify(body),/TEST-signature/);
      }
    }
  }finally{await router.drainPurchasePolls();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});

test('a notSaved view keeps automatic polling and offers nothing to sign',async()=>{
  for(const [name,view] of [
    ['Agreement, own copy says needs signature',agreement({stage:'agreement-signing',notSaved},true)],
    ['Agreement, held payment, identity stage',agreement({stage:'identity',notSaved,limits:{payment:'held'}},true)],
    ['Agreement, identity stage, readiness false',agreement({stage:'identity',notSaved},false)],
    ['bundle, own copy says needs signature',bundle({notSaved,bundle:{counterSigned:false}},true)],
    ['bundle, readiness false',bundle({notSaved,bundle:{counterSigned:false}},false)]]){
    assert.equal(purchasePhase(view),'readback',name);
    const h=portalHarness(view,echo(view));await h.start();await flush();
    const shown=buttons(h);
    assert.deepEqual(shown.filter(id=>SIGNING.includes(id)),[],`${name}: ${JSON.stringify(shown)}`);assert.ok(shown.includes('dacs-recheck'),name);
    assert.equal(h.clock.timers.size,1,`${name}: automatic polling continues`);
    await h.clock.advance([...h.clock.timers.values()][0].ms);
    assert.ok(h.requests.some(r=>r.path.endsWith('/auto/recheck')),`${name}: the next check reads the saved state`);
    assert.equal(h.wallet.length,0,name);h.destroy();
  }
});

test('the standalone Agreement CREATE is offered on a saved view only, never on a notSaved one',async()=>{
  for(const saved of [true,false]){
    const view=agreement({stage:'agreement-signing',...(saved?{}:{notSaved})},false),h=portalHarness(view,echo(view));
    h.context.fakeBroker={authenticate:async()=>{},approveOne:async()=>{throw new Error('TEST no CREATE expected');}};vm.runInContext('offlineAgreementBroker=fakeBroker',h.context);
    await h.start();await flush();
    assert.equal(buttons(h).includes('Approve Agreement CREATE'),saved,JSON.stringify(buttons(h)));assert.ok(buttons(h).includes('dacs-recheck'));
    assert.equal(h.wallet.length,0);h.destroy();
  }
});

test('a counter-signed bundle offers no signing button, even when its readiness says otherwise',async()=>{
  for(const requiresSignature of [true,false]){
    const view=bundle({bundle:{counterSigned:true}},requiresSignature),h=portalHarness(view,echo(view));await h.start();await flush();
    assert.ok(!buttons(h).includes('dacs-countersign'),JSON.stringify(buttons(h)));assert.ok(buttons(h).includes('dacs-recheck'));
    assert.equal(h.wallet.length,0);h.destroy();
  }
  const ready=bundle({bundle:{counterSigned:false}},true),h=portalHarness(ready,echo(ready));await h.start();await flush();
  assert.deepEqual(buttons(h),['dacs-countersign'],'control: an unsigned saved bundle still asks for the counter-signature');h.destroy();
});

test('already_countersigned claims nothing, asks the wallet nothing, re-checks and keeps polling',async()=>{
  const view=bundle({bundle:{counterSigned:false}},true),after=bundle({bundle:{counterSigned:true}},false);
  const h=portalHarness(view,async(path,_body,enrich)=>path.endsWith('/completion/request')
    ?{ok:false,status:409,data:{error:'already_countersigned',message:'your counter-signature is already saved, so nothing is signed again; re-check shows the saved state'}}
    :{ok:true,data:enrich(after)});
  await h.start();await flush();assert.equal(h.clock.timers.size,0,'waits for the buyer first');
  await h.document.getElementById('flow').querySelector('button[id="dacs-countersign"]').fire('click');await flush();
  assert.equal(h.wallet.length,0);assert.equal(h.storage.getItem('dacs:auto:TEST:bundle'),null);
  assert.ok(h.requests.some(r=>r.path.endsWith('/protocol/recheck')));assert.ok(!h.requests.some(r=>r.path.endsWith('/completion/countersign')));
  const shown=buttons(h);assert.ok(!shown.includes('dacs-countersign'));assert.ok(shown.includes('dacs-recheck'));
  assert.ok(h.document.getElementById('flow').querySelectorAll('button').every(b=>!b.disabled),'buttons stay enabled');
  assert.equal(h.clock.timers.size,1,'readback polling continues');
  assert.doesNotMatch(h.document.getElementById('log').text,/Checking purchase state/);h.destroy();
});

const refusal=h=>h.document.getElementById('flow').querySelectorAll('p').find(p=>p.className==='bad')?.text??null;
const closed=async()=>({ok:false,status:409,data:CLOSED});

test('buyer_access_closed on the first view shows main\'s refusal, stops polling and keeps a manual Re-check',async()=>{
  const h=portalHarness({status:'awaiting_approval',autoAdvance:{requiresSignature:true}},closed);
  h.context.fetch=async(path,options)=>{h.requests.push({path,body:JSON.parse(options.body)});return{ok:false,status:409,json:async()=>CLOSED};};
  await h.start();await flush();
  // Main renders the same text in the same place: flow(<p class="bad">message</p>).
  assert.equal(refusal(h),CLOSED.message);assert.deepEqual(buttons(h),['dacs-recheck']);
  assert.equal(h.clock.timers.size,0,'no automatic polling');
  await h.clock.advance(60000);assert.equal(h.requests.length,1,'nothing is read again by itself');
  const recheck=h.document.getElementById('flow').querySelector('button[id="dacs-recheck"]');assert.equal(recheck.disabled,undefined);
  await recheck.fire('click');await flush();
  assert.ok(h.requests.slice(1).some(r=>r.path.endsWith('/auto/recheck')),'the manual Re-check reads again');
  assert.equal(refusal(h),CLOSED.message);assert.deepEqual(buttons(h),['dacs-recheck']);
  assert.ok(h.document.getElementById('flow').querySelectorAll('button').every(b=>!b.disabled),'Re-check stays usable');
  assert.equal(h.clock.timers.size,0);assert.equal(h.wallet.length,0);
  assert.doesNotMatch(h.document.getElementById('log').text,/Checking purchase state/);h.destroy();
});

test('buyer_access_closed during readback, even after a recoverable 409, shows the refusal and stops polling',async()=>{
  const view=agreement({stage:'agreement-anchored'},false);let reads=0;
  const h=portalHarness(view,async()=>++reads===1?{ok:false,status:409,data:{error:'protocol_check_stale',message:'TEST stale'}}:{ok:false,status:409,data:CLOSED});
  await h.start();await flush();assert.equal(h.clock.timers.size,1);
  // Once access closes, the server refuses /view the same way (portalOperation).
  const scripted=h.context.fetch;
  h.context.fetch=async(path,options)=>reads>=2&&path.endsWith('/view')?(h.requests.push({path}),{ok:false,status:409,json:async()=>CLOSED}):scripted(path,options);
  await h.clock.advance([...h.clock.timers.values()][0].ms);assert.equal(reads,1);assert.equal(h.clock.timers.size,1,'a generic 409 still recovers');
  await h.clock.advance([...h.clock.timers.values()][0].ms);assert.equal(reads,2);
  assert.equal(refusal(h),CLOSED.message);assert.deepEqual(buttons(h),['dacs-recheck']);assert.equal(h.clock.timers.size,0);
  await h.clock.advance(60000);assert.equal(reads,2,'no automatic polling after the refusal');
  await h.document.getElementById('flow').querySelector('button[id="dacs-recheck"]').fire('click');await flush();
  assert.ok(reads>2,'the manual Re-check is not blocked by the earlier recovery');assert.equal(refusal(h),CLOSED.message);h.destroy();
});

test('the controller treats buyer_access_closed as terminal, not as a recoverable 409',async()=>{
  const error={status:409,code:'buyer_access_closed',message:CLOSED.message};
  assert.equal(recoverable(error),false);assert.equal(recoverable({status:409,code:'protocol_check_stale'}),true);
  const clock=fakeClock(),notices=[],refusals=[];let ends=0;
  const auto=createPurchaseAutoAdvance({...clock,read:async()=>{throw error;},render(){},notice:(...v)=>notices.push(v),end:()=>ends++,refusal:e=>refusals.push(e.message)});
  auto.observe(agreement({stage:'agreement-anchored'},false));await clock.advance(500);
  assert.deepEqual(refusals,[CLOSED.message]);assert.equal(ends,1);assert.equal(clock.timers.size,0);assert.equal(auto.recovering,false);assert.deepEqual(notices,[]);
  assert.equal(auto.recover(error),true,'an action refused the same way shows the refusal instead of recovering');
  assert.equal(refusals.length,2);assert.equal(auto.recovering,false);assert.equal(clock.timers.size,0);auto.destroy();
});

// The portal answers almost every OperationError with 409. Only conflicts whose
// answer is in the saved purchase state read back; every other code the portal
// can answer is the buyer's to act on and is shown.
// (buyer_balance_unavailable, a transient chain read failure, is retryable: see below.)
const FINAL_CODES=['buyer_balance_insufficient','unpaid_purchase_account_limit','unpaid_purchase_wallet_limit','purchase_start_limit',
  'seller_delegation_expiring','seller_delegation_unavailable','seller_delegation_invalid','agreement_context_held','agreement_terms_mismatch','bad_signature','wrong_wallet',
  'network_identity_mismatch','network_identity_unverified','network_identity_unpinned','dacs_protocol_unavailable','dacs_protocol_held','devnet_execution_held',
  'agreement_payment_held','native_completion_held','native_payment_lane_held','terms_changed','listing_recheck_unavailable','listing_not_transactable','listing_not_dacs_protocol',
  'seller_agent_unavailable','seller_agent_changed','seller_transport_changed','seller_commitment_unavailable','commitment_required','commitment_unverified','agreement_unverified',
  'agreement_projection_unavailable','delivery_check_not_ready','unresolved_payment','wallet_fenced','wallet_lane_mismatch','invalid_tx_hash','origin_mismatch','self_purchase',
  'wallet_required','wallet_not_linked','wallet_ambiguous','wallet_linked_elsewhere','unknown_account','invalid_protocol','idempotency_conflict','intent_refused','intent_unsupported',
  'broker_session_expired','broker_scope_changed','broker_signed_scope_invalid','broker_result_invalid','broker_unavailable',undefined];
const AMBIGUOUS=['invalid_state','protocol_check_stale','hash_conflict','already_countersigned','native_payment_already_issued'];

test('only conflicts answered by the saved state are recoverable; every other 409 is final for the buyer',()=>{
  for(const code of FINAL_CODES)assert.equal(recoverable({status:409,code}),false,String(code));
  for(const code of AMBIGUOUS)assert.equal(recoverable({status:409,code}),true,code);
  // Not by code alone: the same name on another status is not a conflict.
  for(const status of [400,404,500,503])assert.equal(recoverable({status,code:'invalid_state'}),false,String(status));
  // Unknown outcomes recover whatever their code or status, as on main.
  for(const error of [{indeterminate:true},{indeterminate:true,status:409,code:'bad_signature'},{code:'outcome_unknown'},{status:503,code:'upstream_unavailable'}])assert.equal(recoverable(error),true,JSON.stringify(error));
  assert.equal(recoverable({status:409,code:'buyer_access_closed'}),false);
});

// a review reproduction, as a table: the shipped purchase page refused at
// identity (nothing asked of the wallet) or at plan (after the one identity
// signature) shows the server's refusal and never asks the wallet again.
// the source change checks the current stage before planning: identity means no plan is saved.
const HELD={status:'agreement_pending',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage:'identity',limits:{payment:'held'}}}};
const refusingAt=(step,code,message)=>async(path,_body,enrich)=>path.endsWith(`/agreement/${step}`)?{ok:false,status:409,data:{error:code,message}}
  :path.endsWith('/agreement/identity')?{ok:true,data:{signRequest:{message:'TEST-identity'}}}:{ok:true,data:enrich(HELD)};

test('a final refusal at identity or plan is shown as the server\'s text; the wallet is never asked again',async()=>{
  const codes=['seller_delegation_expiring','seller_delegation_unavailable','seller_delegation_invalid','agreement_context_held','agreement_terms_mismatch','bad_signature','wrong_wallet',
    'network_identity_mismatch','unpaid_purchase_account_limit','unpaid_purchase_wallet_limit','purchase_start_limit','dacs_protocol_unavailable','terms_changed','listing_recheck_unavailable'];
  for(const step of ['identity','plan'])for(const code of codes){
    const message=`TEST ${code} <b>at ${step}</b>. Prepare a new purchase.`,label=`${step} ${code}`;
    const h=portalHarness(HELD,refusingAt(step,code,message));
    await h.start();
    const reads=h.requests.length,log=()=>h.document.getElementById('log').text;
    await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    assert.ok(log().includes(message),`${label}: ${log()}`);
    assert.doesNotMatch(log(),/Checking purchase state/,label);
    assert.ok(!h.requests.slice(reads).some(r=>r.path.endsWith('/auto/recheck')),`${label}: no recovery read`);
    assert.equal(h.wallet.length,step==='plan'?1:0,label);
    assert.ok(h.document.getElementById('flow').querySelectorAll('button').every(b=>!b.disabled),`${label}: buttons stay usable`);
    if(step==='identity')assert.equal(h.clock.timers.size,0,`${label}: nothing was asked, so the page waits for the buyer`);
    else{
      // The tab journal holds the asked identity signature: main's readback-only
      // rule keeps reading and never asks the wallet again, even on a new click
      // of the still-shown sign button.
      await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
      assert.equal(h.wallet.length,1,`${label}: a second click asks the wallet nothing`);
      assert.match(log(),/Checking purchase state/,`${label}: the guard's outcome_unknown reads back`);
      await h.clock.advance(500);
      assert.match(h.document.getElementById('flow').text,/will not be requested again/,label);
      for(const b of h.document.getElementById('flow').querySelectorAll('button'))if(b.attributes.id!=='dacs-recheck'){await b.fire('click');await flush();}
      await h.clock.advance(8000);
      assert.equal(h.wallet.length,1,`${label}: the journaled signature is never requested again`);
      assert.ok(log().includes(message),label);
    }
    h.destroy();
  }
});

test('an ambiguous conflict at identity or plan still reads the saved state back and asks the wallet nothing more',async()=>{
  for(const step of ['identity','plan'])for(const code of ['invalid_state','protocol_check_stale']){
    const label=`${step} ${code}`,h=portalHarness(HELD,refusingAt(step,code,`TEST ${code}`));
    await h.start();
    await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    assert.match(h.document.getElementById('log').text,/Checking purchase state. Nothing is signed or resent./,label);
    assert.ok(!h.document.getElementById('log').text.includes(`TEST ${code}`),label);
    await h.clock.advance(500);
    assert.ok(h.requests.some(r=>r.path.endsWith('/auto/recheck')),`${label}: reads the saved state back`);
    await h.clock.advance(8000);
    assert.equal(h.wallet.length,step==='plan'?1:0,label);
    h.destroy();
  }
});

// Final review of the source change, finding 2: an unreadable balance is a transient chain
// read failure, not the buyer's to act on. The page shows the server's text,
// keeps reading and stays usable; it never asks the wallet again by itself.
test('buyer_balance_unavailable at identity or plan is retryable: the page shows the text, reads the state back and does not end',async()=>{
  const message='The buyer balance or buyer fees could not be read exactly from the bound chain. Try again after the chain read is available; no seller write or wallet approval was requested.';
  for(const status of [409,503])assert.equal(recoverable({status,code:'buyer_balance_unavailable',message}),true,String(status));
  for(const step of ['identity','plan']){
    let readable=false;
    const unavailable={ok:false,status:409,data:{error:'buyer_balance_unavailable',message}};
    const answer=async(path,_body,enrich)=>path.endsWith(`/agreement/${step}`)&&!readable?unavailable
      :path.endsWith('/agreement/plan')?{ok:false,status:409,data:{error:'agreement_terms_mismatch',message:'TEST stop after the plan'}}
      :path.endsWith('/agreement/identity')?{ok:true,data:{signRequest:{message:'TEST-identity'}}}:{ok:true,data:enrich(HELD)};
    const h=portalHarness(HELD,answer),log=()=>h.document.getElementById('log').text;
    await h.start();
    await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    assert.ok(log().includes(message),`${step}: the server's text`);
    assert.match(log(),/Checking purchase state. Nothing is signed or resent./,step);
    await h.clock.advance(500);
    assert.ok(h.requests.some(r=>r.path.endsWith('/auto/recheck')),`${step}: reads the saved state back`);
    assert.equal(h.wallet.length,step==='plan'?1:0,`${step}: nothing more asked of the wallet`);
    assert.ok(h.document.getElementById('flow').querySelectorAll('button').every(b=>!b.disabled),`${step}: buttons stay usable`);
    if(step==='identity'){
      // Nothing was asked, so once the chain read works the same page continues.
      readable=true;
      await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
      assert.equal(h.wallet.length,1,'the same page asks for the identity signature');
      assert.ok(log().includes('TEST stop after the plan'));
    }else{
      // This tab already asked for the identity signature: it keeps reading and never asks again.
      await h.clock.advance(8000);
      assert.ok(h.clock.timers.size>0,'the page keeps reading');
      assert.equal(h.wallet.length,1);
    }
    h.destroy();
  }
});

test('after a closed-access refusal, a successful manual Re-check leaves zero timers; reload resumes polling',async()=>{
  const view=agreement({stage:'agreement-anchored'},false);let restored=false;
  const answer=async(_path,_body,enrich)=>restored?{ok:true,data:enrich(view)}:{ok:false,status:409,data:CLOSED};
  const h=portalHarness(view,answer);
  try{
    await h.start();await flush();await h.clock.advance(500);
    assert.equal(refusal(h),CLOSED.message);assert.equal(h.clock.timers.size,0);
    restored=true;
    await h.document.getElementById('flow').querySelector('button[id="dacs-recheck"]').fire('click');await flush();
    assert.equal(refusal(h),null,'the successful Re-check shows the saved purchase');
    assert.ok(h.requests.some(r=>r.path.endsWith('/auto/recheck')));
    assert.equal(h.clock.timers.size,0,'a successful manual Re-check does not resume polling');
    const reads=h.requests.length;await h.clock.advance(60000);
    assert.equal(h.requests.length,reads,'no automatic read after the successful Re-check');assert.equal(h.wallet.length,0);
    const reloaded=portalHarness(view,answer,{storage:h.storage});
    try{
      await reloaded.start();await flush();assert.equal(reloaded.clock.timers.size,1,'reload resumes polling');
      await reloaded.clock.advance(500);assert.ok(reloaded.requests.some(r=>r.path.endsWith('/auto/recheck')));assert.equal(reloaded.wallet.length,0);
    }finally{reloaded.destroy();}
  }finally{h.destroy();}
  const docs=readFileSync(new URL('../docs/portal-auto-advance.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  assert.match(docs,/A successful Re-check updates the page but leaves automatic reads stopped; reload to resume polling after access is restored\./);
});


test('report view keeps saved-plan continuation free of identity signatures and plan resubmission',async()=>{
  const view=agreement({stage:'agreement-signing',limits:{payment:'held'}},true);
  const h=portalHarness(view,async(path,_body,enrich)=>path.endsWith('/agreement/plan')
    ?{ok:true,data:{signRequest:{agreementHash:'TEST-agreement',summary:{amount:'1',amountOs:'1000000000',payee:'TEST-payee',deadline:'TEST-deadline'},agreementMessage:'TEST-agreement',anchorMessage:'TEST-anchor'}}}
    :{ok:true,data:enrich({status:'awaiting_approval'})},{reportView:true});
  try{
    await h.start();
    await h.document.getElementById('flow').querySelector('button[id="dacs-sign-agreement"]').fire('click');await flush();
    assert.deepEqual(h.wallet.map(r=>r.params[0]),['TEST-agreement','TEST-anchor']);
    assert.ok(!h.requests.some(r=>r.path.endsWith('/agreement/identity')));
    const plans=h.requests.filter(r=>r.path.endsWith('/agreement/plan'));
    assert.equal(plans.length,1);assert.deepEqual(plans[0].body,{token:'TEST'});
    assert.ok(h.requests.at(-3).path.endsWith('/view'),'status is read before the saved plan');
    assert.match(h.document.getElementById('log').text,/The Agreement plan is saved/);
    assert.ok(h.document.getElementById('purchased-report'),'report mount remains present');
  }finally{h.destroy();}
});

test('funding refusals retain their code and sentence with report view on, without a running-plan warning or stale report',async()=>{
  const message='TEST balance refusal',funding='TEST fund this buyer <b>0.25 DEM</b>',code='buyer_balance_insufficient';
  const refusal={ok:false,status:409,data:{error:code,message,buyerFunding:{message:funding}}};
  const h=portalHarness(HELD,async(path,_body,enrich)=>path.endsWith('/agreement/plan')?refusal
    :path.endsWith('/agreement/identity')?{ok:true,data:{signRequest:{message:'TEST-identity'}}}:{ok:true,data:enrich(HELD)},{reportView:true});
  try{
    await h.start();await h.document.getElementById('flow').querySelector('button[id="dacs-sign-agreement"]').fire('click');await flush();
    const log=h.document.getElementById('log').text;
    assert.ok(log.includes(`${message} ${funding}`));assert.doesNotMatch(log,/may still be running|Checking purchase state/);
    assert.equal(h.wallet.length,1);assert.ok(!h.requests.some(r=>r.path.endsWith('/agreement/sign')));
  }finally{h.destroy();}
  const p=reportProjection();
  const read=portalHarness({status:'settled_verified',evidence:{protocol:p}},async()=>refusal,{reportView:true});
  try{
    await read.start();const report=read.document.getElementById('purchased-report');assert.match(report.text,/TEST signed report text/);
    await assert.rejects(vm.runInContext("api('/portal/api/purchase/TEST/auto/recheck',{token:'TEST'})",read.context),error=>error.code===code&&error.status===409&&error.message===`${message} ${funding}`);
    assert.doesNotMatch(report.text,/TEST signed report text/);assert.ok(report.text.includes(`Fresh purchase status read failed: ${message} ${funding}`));
    assert.equal(read.wallet.length,0);
  }finally{read.destroy();}
});
