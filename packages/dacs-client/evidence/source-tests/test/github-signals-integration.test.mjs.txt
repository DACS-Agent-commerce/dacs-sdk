import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomBytes, createHash } from 'node:crypto';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, toolRaw, seedSellerListing, portal, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createSellerIdentityReader } from '../src/seller-identities.mjs';
import { createGithubSignals } from '../src/identity-signals/github.mjs';
import { createGithubQueue } from '../src/identity-signals/github-http.mjs';
import { createApp } from '../src/app.mjs';
import { purchaseCommitment, approvalBinding } from '../src/purchases.mjs';
import { canonicalize } from '../src/dacs/listing.mjs';
import { sellerIdentityPanel } from '../public/portal/seller-identity.mjs';
import { ESC_HELPER, LISTINGS_RENDER } from '../src/mcp/ui.mjs';

const el=(tag,props,...children)=>({tag,props,children});
const coords=(seller,listingId)=>({seller:seller.claim,listingId,version:1});
function setup(h,{now,timeoutMs}={}) {
  const seller=createEphemeralWallet(),login='checked-seller',listingId='github-checked',calls=[];
  seedSellerListing(h,seller,{listingId});
  const entry={username:login,userId:'client-chosen-999',proof:`https://gist.github.com/${login}/abcdef`};
  h.chain.seedWeb2Identity(seller.address,'github',entry);
  const gist={owner:{login,id:123},files:{proof:{truncated:false,content:`demos:dw2p:ed25519:${seller.signHex(`demos-web2:v1:github:${login}:${seller.address}`)}`}}};
  let fail=false;
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options});
    assert.equal(url.origin,'https://api.github.com');
    if(fail)throw Error(h.config.identityGithubToken);
    const data=url.pathname.startsWith('/gists/')?gist:url.pathname==='/user/123'?{id:123,login,type:'User',created_at:'2012-01-01T00:00:00Z',followers:0}:[{id:1,owner:{id:123},fork:false,archived:true,name:'work',stargazers_count:17}];
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  };
  const signals=createGithubSignals({config:h.config,now,queue:createGithubQueue({now}),fetchImpl});
  Object.assign(h.app.services.sellerIdentities,createSellerIdentityReader({config:h.config,chain:h.app.services.chain,githubSignals:signals,now,timeoutMs}));
  return {seller,listingId,calls,entry,fetchImpl,fail:()=>{fail=true;}};
}

test('on: checked fields and labels survive search schema, text, App, prepare_purchase and portal; token never logs',async()=>{
  const token=randomBytes(24).toString('hex');
  const h=await startHarness({env:{DACS_SELLER_IDENTITIES:'on',DACS_IDENTITY_GITHUB_SIGNALS:'on',DACS_IDENTITY_GITHUB_TOKEN:token}});
  try {
    const f=setup(h),user=await linkedUser(h);
    const raw=await toolRaw(h,null,'search_agents',{}),row=raw.structuredContent.results.find(r=>r.listingId===f.listingId),signal=row.sellerIdentity.identities.github[0].signals;
    assert.equal(signal.bindingStatus,'bound');assert.equal(signal.accountId,123);assert.equal(signal.stars.total,17);assert.equal(signal.stars.top[0].archived,true);assert.match(raw.content[0].text,/17 stars across 1 public, non-fork/);
    const node={innerHTML:''};vm.runInNewContext(`${ESC_HELPER}${LISTINGS_RENDER};render(data)`,{document:{getElementById:()=>node},data:raw.structuredContent});assert.match(node.innerHTML,/17 stars/);assert.match(node.innerHTML,/href="https:\/\/github.com\/checked-seller\/work"/);
    const prepared=await tool(h,user,'prepare_purchase',{...coords(f.seller,f.listingId),idempotencyKey:'github-on-review'});
    assert.equal(prepared.sellerIdentity.identities.github[0].signals.stars.total,17);
    const view=await portal(h,`/portal/api/purchase/${prepared.operationId}/view`,{token:tokenFrom(prepared.approvalUrl)});
    assert.equal(view.sellerIdentity.identities.github[0].signals.stars.total,17);assert.match(JSON.stringify(sellerIdentityPanel(view.sellerIdentity,el)),/17 stars.*archived/);
    assert.equal(f.calls.length,3,'binding and statistics shared across surfaces');
    const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');const client=new Client({name:'github-schemas',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
    try { const tools=Object.fromEntries((await client.listTools()).tools.map(t=>[t.name,t]));
      for(const name of ['search_agents','get_listing'])assert.equal(tools[name]._meta.ui.resourceUri,'ui://dacs/listings-v4.html');
      const resources=await client.listResources();assert.ok(resources.resources.some(r=>r.uri==='ui://dacs/listings-v4.html'));
      assert.match((await client.readResource({uri:'ui://dacs/listings-v4.html'})).contents[0].text,/e\.signals/);
      for(const identity of [tools.search_agents.outputSchema.properties.results.items.properties.sellerIdentity,tools.prepare_purchase.outputSchema.properties.sellerIdentity]) {
        const gh=identity.properties.identities.anyOf.find(v=>v.type==='object').properties.github.items;
        assert.ok(gh.properties.signals);assert.ok(!gh.required.includes('signals'));
      }
    } finally {await client.close();}
    for(const output of [JSON.stringify(raw),JSON.stringify(prepared),JSON.stringify(view),h.logs.join('\n'),node.innerHTML])assert.ok(!output.includes(token));
    assert.ok(f.calls.every(c=>c.options.headers.Authorization===`Bearer ${token}`));
  } finally {await h.close();}
});

test('off with token: all surfaces keep PR1 GitHub entries without signals and make no calls',async()=>{
  const h=await startHarness({env:{DACS_SELLER_IDENTITIES:'on',DACS_IDENTITY_GITHUB_TOKEN:randomBytes(24).toString('hex')}});
  try {
    const f=setup(h),user=await linkedUser(h),search=await tool(h,null,'search_agents',{});
    const prepared=await tool(h,user,'prepare_purchase',{...coords(f.seller,f.listingId),idempotencyKey:'github-off-review'});
    const view=await portal(h,`/portal/api/purchase/${prepared.operationId}/view`,{token:tokenFrom(prepared.approvalUrl)});
    for(const identity of [search.results.find(r=>r.listingId===f.listingId).sellerIdentity,prepared.sellerIdentity,view.sellerIdentity])assert.deepEqual(identity.identities.github,[{value:'checked-seller',url:'https://github.com/checked-seller'}]);
    assert.equal(f.calls.length,0);
  } finally {await h.close();}
});

test('on/off preparations have identical bound terms, termsHash, approval bytes and replay commitment',async()=>{
  const h=await startHarness({env:{DACS_SELLER_IDENTITIES:'on'}});let off,on;
  try {
    const f=setup(h),user=await linkedUser(h),accountId=(await tool(h,user,'get_account_status')).accountId,time=Date.now();
    off=await createApp({config:{...h.config,identityGithubSignals:'off'},now:()=>time});
    on=await createApp({config:{...h.config,identityGithubSignals:'on'},fetchImpl:async(url,options)=>new URL(url).origin==='https://api.github.com'?f.fetchImpl(new URL(url),options):globalThis.fetch(url,options),now:()=>time});
    const args={accountId,...coords(f.seller,f.listingId),idempotencyKey:'github-terms-off'},a=await off.services.purchases.prepare(args);
    const binding=canonicalize(approvalBinding(a.operation)),commitment=purchaseCommitment(a.operation);
    const observed=await on.services.sellerIdentities.read(f.seller.claim);assert.equal(observed.identities.github[0].signals.bindingStatus,'bound');
    const replay=await on.services.purchases.prepare(args);assert.equal(canonicalize(replay.operation.terms),canonicalize(a.operation.terms));assert.equal(replay.operation.termsHash,a.operation.termsHash);assert.equal(canonicalize(approvalBinding(replay.operation)),binding);assert.equal(purchaseCommitment(replay.operation),commitment);
    await off.services.purchases.cancel({accountId,operationId:a.operation.id});const b=await on.services.purchases.prepare({...args,idempotencyKey:'github-terms-on'});assert.equal(canonicalize(b.operation.terms),canonicalize(a.operation.terms));assert.equal(b.operation.termsHash,a.operation.termsHash);
  } finally {await on?.close();await off?.close();await h.close();}
});

test('portal action routes use cache only; stale GitHub refresh never fails portal review',async()=>{
  const h=await startHarness({env:{DACS_SELLER_IDENTITIES:'on',DACS_IDENTITY_GITHUB_SIGNALS:'on'}});
  try {
    let time=Date.now();const f=setup(h,{now:()=>time,timeoutMs:30}),user=await linkedUser(h);
    const prepared=await tool(h,user,'prepare_purchase',{...coords(f.seller,f.listingId),idempotencyKey:'github-cache-actions'}),token=tokenFrom(prepared.approvalUrl),purchases=h.app.services.purchases,operation=purchases.portalOperation(prepared.operationId,token);
    assert.equal(prepared.sellerIdentity.identities.github[0].signals.stars.total,17);time+=3600001;f.fail();
    const routes={approve:'approve',handoff:'prepareHandoff',report:'reportWalletResult','agreement/identity':'agreementIdentity','agreement/plan':'agreementPlan','agreement/sign':'agreementSubmit','completion/request':'completionRequest','completion/countersign':'completionCountersign','protocol/recheck':'protocolRecheck'};
    for(const method of Object.values(routes))purchases[method]=()=>({operation,request:{}});
    for(const route of Object.keys(routes)) {const out=await portal(h,`/portal/api/purchase/${prepared.operationId}/${route}`,{token,address:user.wallet.address});assert.equal(out.sellerIdentity.identities.github[0].signals.cache,'stale');assert.equal(out.sellerIdentity.identities.github[0].signals.stars.total,17);}
    assert.equal(f.calls.length,3);
    const view=await portal(h,`/portal/api/purchase/${prepared.operationId}/view`,{token});assert.equal(view.status,'awaiting_approval');assert.equal(view.sellerIdentity.identities.github[0].signals.cache,'stale');assert.match(view.sellerIdentity.identities.github[0].signals.label,/refresh unavailable/);
  } finally {await h.close();}
});


test('off MCP discovery and v3 HTML match hashes computed from PR1 outputs',async()=>{
  // Generated from git archive of PR 1's head bf1b43e (main 5f8eb9b merged), with the same harness/client and serializer.
  // Tools re-captured for PR the source change on main bcdb2cf (was 93bb2287...): the only change is the source change's, terms.amount and
  // terms.amountOs of prepare_purchase, get_purchase_status and verify_deal also accept a seller-data envelope.
  // Re-captured for an earlier review of the source change's review (was ee8bb5d5...): the only change is the status view's URI,
  // status-v2 -> status-v5, in the tools' _meta; with status-v2 put back the listing hashes to ee8bb5d5... again.
  const expectedTools='ff6f2d822ebbfedff2637f9031bc7181663a62622914ca05b3914f813dc08162';
  const expectedHtml='717983175bb1ba4c47d7853a1a59ffcb47abbc8c46f01125f8aee126d669a87a';
  const sha=s=>createHash('sha256').update(s).digest('hex');
  const h=await startHarness({env:{DACS_SELLER_IDENTITIES:'on',DACS_IDENTITY_GITHUB_SIGNALS:'off'}});
  const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');
  const client=new Client({name:'baseline',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
    assert.equal(sha(JSON.stringify(await client.listTools())),expectedTools);
    assert.equal(sha((await client.readResource({uri:'ui://dacs/listings-v3.html'})).contents[0].text),expectedHtml);
    assert.deepEqual((await client.listResources()).resources.map(r=>r.uri).sort(),['ui://dacs/listings-v3.html','ui://dacs/status-v5.html']);
  } finally {await client.close();await h.close();}
});
