// The enabled purchase entry, run in a VM on the minimal portal DOM with a
// fake clock. `storage` is the tab's sessionStorage: pass the same one to a
// second harness to model a reload of that tab. `transport` replaces the
// scripted fetch, for example with loopback HTTP to a real harness, and
// `token` is the handoff token in the page fragment. `reportView` marks the
// shell as DACS_SHOWCASE_REPORT_VIEW=1 does.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {autoAdvancePortalSource} from '../../src/portal/auto-advance-assets.mjs';
import {createPurchaseAutoAdvance,createPurchaseWalletIdle} from '../../src/portal/purchase-auto-advance.mjs';
import {Node,fakeDocument,fakeClock} from './portal-auto-dom.mjs';
// portal.js imports this renderer; the harness strips imports, so it supplies it.
import {renderShowcaseProgress} from '../../public/portal/showcase-progress.mjs';
// The report renderer runs in the VM, so it builds on this page's document.
import {PURCHASED_REPORT_SCRIPT} from '../../public/portal/purchased-report.mjs';

export function tabStorage(){
  const items=new Map();
  return{getItem:k=>items.get(k)??null,setItem:(k,v)=>{items.set(k,String(v));},keys:()=>[...items.keys()]};
}

export function portalHarness(initial,answer,{storage=tabStorage(),transport=null,token='TEST',reportView=false}={}){
  const document=fakeDocument(),clock=fakeClock(),requests=[],wallet=[];
  if(reportView)document.body.setAttribute('data-showcase-report-view','1');
  const source=autoAdvancePortalSource(readFileSync(new URL('../../public/portal/portal.js',import.meta.url),'utf8'));
  const runnable=source.slice(0,source.indexOf('// ---------------- boot ----------------')).replace(/^import .*;$/gm,'');
  const terms={buyer:{wallet:'0x'+'1'.repeat(64)},listing:{listingId:'TEST',version:1,contentHash:'x'},seller:{claim:'TEST-seller',payee:'TEST-payee'},price:{amount:'1',amountOs:'1000000000'},domain:{mode:'simulated-fixture',network:'TEST'},network:'TEST',rail:'TEST',approvalExpiresAt:Date.now()+100000};
  const layers={transfer:'not-observed',dacsPurchase:'not-evidenced',service:'not-delivered',completedCopies:'not-exchanged',humanAcceptance:'not-recorded'};
  const enrich=view=>({...view,terms,evidence:{...view.evidence,...(view.status==='settled_verified'?{receipt:{txHash:'TEST-hash',verifiedAt:Date.now()}}:{}),...(view.evidence?.protocol?{protocol:{layers,...view.evidence.protocol}}:{})}});
  const scripted=async(path,options)=>{requests.push({path,body:JSON.parse(options.body),deadline:options.signal});const response=path.endsWith('/view')?{ok:true,data:enrich(initial)}:await answer(path,JSON.parse(options.body),enrich);return{ok:response.ok,status:response.status??200,json:async()=>{if(response.brokenJson)throw new SyntaxError('TEST truncated result');return response.data;}};};
  const context=vm.createContext({Node,document,renderShowcaseProgress,createPurchaseAutoAdvance:options=>createPurchaseAutoAdvance({...options,...clock}),createPurchaseWalletIdle:options=>createPurchaseWalletIdle({...options,...clock,document}),
    window:{addEventListener(){}},location:{pathname:'/portal/purchase/TEST',hash:`#t=${token}`},history:{replaceState(){}},sessionStorage:storage,URLSearchParams,URL,AbortSignal,Date,setTimeout,clearTimeout,
    fetch:transport??scripted});
  vm.runInContext(PURCHASED_REPORT_SCRIPT,context);
  vm.runInContext(runnable,context);
  context.fakeProvider={isDacsEmbeddedWallet:true,writeProfile:()=>({profile:'simulated-loopback',network:'TEST',evidenceMode:'simulated-fixture',methods:['sendTransaction']}),request:async req=>{wallet.push(req);return{success:true,data:req.method==='sign'?'TEST-signature':{hash:'a'.repeat(64)}};}};
  vm.runInContext("provider=fakeProvider;walletSource='embedded';address='0x'+'1'.repeat(64);",context);
  return{document,clock,requests,wallet,context,storage,start:(id='TEST')=>vm.runInContext(`purchaseFlow(${JSON.stringify(id)})`,context),destroy:()=>vm.runInContext('purchaseAuto.destroy();purchaseIdle.destroy()',context)};
}
