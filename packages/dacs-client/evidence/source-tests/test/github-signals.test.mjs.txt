import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { checkGistBinding, checkTlsnBinding, createGithubSignals, fetchGithubStatistics, gistIdFor, GITHUB_CACHE_BYTE_CAP, GITHUB_JOB_WAITER_CAP, sanitizeGithubEntry } from '../src/identity-signals/github.mjs';
import { createGithubHttp, createGithubQueue } from '../src/identity-signals/github-http.mjs';
import { createSellerIdentityReader, sellerIdentityText } from '../src/seller-identities.mjs';
import { sellerIdentityPanel } from '../public/portal/seller-identity.mjs';
import { SELLER_IDENTITY_RENDER } from '../src/mcp/ui.mjs';
import { loadConfig } from '../src/config.mjs';

const login='fixture-seller', gistId='abcdef123';
const deadline=()=>performance.now()+1000;
const profile={id:42,login,type:'User',created_at:'2010-01-02T03:04:05Z',followers:0,bio:'<script>secret</script>'};
const repo=(id,stars=1,extra={})=>({id,owner:{id:42},fork:false,archived:false,name:`repo-${id}`,stargazers_count:stars,...extra});
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const next=(page)=>`<https://api.github.com/\x75sers/${login}/repos?type=owner&per_page=100&sort=full_name&direction=asc&page=${page}>; rel="next"`;
function fixture({now,respond,token,maxEntries,maxCacheBytes,maxWaiters}={}) {
  const wallet=createEphemeralWallet(), calls=[];
  const entry={username:login,userId:'999',proof:`https://gist.github.com/${login}/${gistId}`};
  const gist={owner:{login,id:42},files:{proof:{truncated:false,content:`demos:dw2p:ed25519:${wallet.signHex(`demos-web2:v1:github:${login}:${wallet.address}`)}`}}};
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options});
    if(respond)return respond(url,options,calls.length,gist);
    return json(url.pathname.startsWith('/gists/')?gist:url.pathname==='/user/42'?profile:[repo(1,10),repo(2,3,{archived:true})]);
  };
  const service=createGithubSignals({config:{identityGithubToken:token},fetchImpl,queue:createGithubQueue({now}),now,maxEntries,maxCacheBytes,maxWaiters});
  service.observe('test',wallet.address,[entry]);
  return {wallet,entry,gist,calls,fetchImpl,service,get:(options={})=>service.signals('test',wallet.address,entry,login,{deadline:deadline(),...options})};
}
async function bind(f,gist=f.gist,seller=f.wallet.address,entry=f.entry) {
  return checkGistBinding({entry,login,seller,deadline:deadline(),request:async()=>({data:gist})});
}

test('claim-bound signature pins owner ID, ignores userId, accepts casing / optional prefix, rejects another key',async()=>{
  const f=fixture();assert.deepEqual(await bind(f),{bindingStatus:'bound',accountId:42,gistId});
  f.gist.owner.login=login.toUpperCase();f.gist.files.proof.content=f.gist.files.proof.content.replace('ed25519:0x','ed25519:');
  assert.equal((await bind(f)).bindingStatus,'bound');assert.equal((await bind(f,f.gist,createEphemeralWallet().address)).bindingStatus,'unresolved');
});

test('owner mismatch / renamed owner, missing / multiple / truncated files and malformed payloads fail closed',async()=>{
  const f=fixture();
  const gists=[null,{}, {...f.gist,owner:{login:'renamed',id:42}}, {...f.gist,owner:{login,id:0}}, {...f.gist,owner:{login,id:Number.MAX_SAFE_INTEGER+1}}, {...f.gist,files:{}}, {...f.gist,files:{...f.gist.files,other:{}}}, {...f.gist,files:{a:{truncated:true,content:f.gist.files.proof.content}}}, {...f.gist,files:{a:{content:f.gist.files.proof.content}}}, {...f.gist,files:{a:{truncated:false,content:'bad'}}}, {...f.gist,files:{a:{truncated:false,content:`${f.gist.files.proof.content}\nextra`}}}];
  for(const gist of gists)assert.equal((await bind(f,gist)).bindingStatus,'unresolved');
});

test('raw URLs, non-gist URLs, credentials, ports, queries and bad IDs cause no fetch',async()=>{
  const f=fixture();let calls=0;
  for(const proof of ['https://gist.githubusercontent.com/a/b/raw','https://raw.githubusercontent.com/a/b','https://github.com/a/b',`https://gist.github.com.evil/${login}/${gistId}`,`https://gist.github.com:443/${login}/${gistId}`,`https://gist.github.com/${login}/${gistId}?x=1`,`https://gist.github.com/${login}/${gistId}/raw`,`https://gist.github.com/other/${gistId}`,`https://gist.github.com/${login}/not-hex`,`http://gist.github.com/${login}/${gistId}`,`https://user@gist.github.com/${login}/${gistId}`]) {
    const out=await checkGistBinding({entry:{...f.entry,proof},login,seller:f.wallet.address,deadline:deadline(),request:async()=>{calls++;return {data:f.gist};}});
    assert.equal(out.bindingStatus,'unresolved',proof);
  }
  assert.equal(calls,0);
});

test('legacy and TLSNotary withhold statistics, TLSNotary causes zero calls',async()=>{
  const f=fixture();f.gist.files.proof.content=`demos:dw2p:ed25519:${f.wallet.signHex('dw2p')}`;
  const out=await f.get();assert.equal(out.bindingStatus,'legacy-proof');assert.equal(out.stars,undefined);assert.equal(out.accountId,undefined);assert.match(out.label,/old Demos proof format/);assert.equal(f.calls.length,1);
  const entry={username:login,proofType:'tlsn',userId:'42',proof:{presentation:'unchecked'}};
  assert.deepEqual(checkTlsnBinding(entry),{bindingStatus:'tlsn-unchecked'});f.service.observe('test',f.wallet.address,[entry]);
  const tlsn=await f.service.signals('test',f.wallet.address,entry,login,{deadline:deadline()});assert.equal(tlsn.bindingStatus,'tlsn-unchecked');assert.match(tlsn.label,/does not check TLSNotary/);assert.equal(tlsn.stars,undefined);assert.equal(f.calls.length,1);
});

test('stars count archived non-forks once, drop foreign owner IDs, whitelist fields and label zero followers',async()=>{
  let pages=0;
  const f=fixture({respond:(url,options,n,gist)=>{
    if(url.pathname.startsWith('/gists/'))return json(gist);
    if(url.pathname==='/user/42')return json(profile);
    pages++;
    return pages===1?json([repo(1,10),repo(2,3,{archived:true}),repo(3,100,{fork:true}),repo(5,100,{owner:{id:99}})],200,{link:next(2)}):json([repo(2,99),repo(4,5)]);
  }});
  const out=await f.get();assert.equal(out.stars.total,18);assert.equal(out.stars.repositories,3);assert.equal(out.stars.complete,true);
  assert.deepEqual(out.stars.top.map(r=>[r.name,r.stars,r.archived]),[['repo-1',10,false],['repo-4',5,false],['repo-2',3,true]]);
  assert.match(out.label,/0 followers reported; private profiles may report zero/);assert.equal(out.bio,undefined);assert.equal(out.userId,undefined);
});

test('ten-page cap, missing page, unsafe pagination and cycles produce at-least labels',async()=>{
  for(const mode of ['cap','fail','foreign-origin','foreign-path','cycle']) {
    let pages=0;const f=fixture({respond:(url,options,n,gist)=>{
      if(url.pathname.startsWith('/gists/'))return json(gist);if(url.pathname==='/user/42')return json(profile);
      pages++;if(mode==='fail'&&pages===2)throw Error('missing page');
      let link=next(pages+1);if(mode==='foreign-origin')link=link.replace('api.github.com','evil.example');if(mode==='foreign-path')link=link.replace(`/\x75sers/${login}/repos`,'/repos/other');if(mode==='cycle')link=next(2);
      return json([repo(pages,pages)],200,{link});
    }});
    const out=await f.get();assert.equal(out.stars.complete,false,mode);assert.match(out.label,/at least \d+ stars across \d+ checked repositories/);assert.equal(pages,mode==='cap'?10:mode==='fail'||mode==='cycle'?2:1);assert.ok(f.calls.every(c=>new URL(c.url).origin==='https://api.github.com'));
  }
});

test('hostile repository names are omitted; hostile profiles, mismatched account IDs and organizations reject',async()=>{
  for(const extra of [{login:'<script>'},{id:99},{type:'Organization'},{created_at:'2020-02-31T00:00:00Z'},{followers:-1}])await assert.rejects(fetchGithubStatistics({accountId:42,deadline:deadline(),request:async()=>({data:{...profile,...extra}})}));
  const out=await fetchGithubStatistics({accountId:42,deadline:deadline(),request:async(path)=>({data:path==='/user/42'?profile:[repo(1,5),repo(2,99,{name:'<img onerror=alert(1)>'}),repo(3,99,{name:'../evil'})]})});
  assert.equal(out.stars.total,5);assert.doesNotMatch(JSON.stringify(out),/onerror|\.\.\/evil/);
});

test('redirects, missing gists, oversized bodies, malformed JSON / UTF-8 and HTML fail closed',async()=>{
  const cases=[()=>new Response(null,{status:302,headers:{location:'https://evil.example'}}),()=>json({},404),()=>json({},200,{'content-length':'1000001'}),()=>new Response(JSON.stringify({padding:'x'.repeat(1000001)}),{headers:{'content-type':'application/json'}}),()=>new Response('{bad',{headers:{'content-type':'application/json'}}),()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),()=>new Response('{}',{headers:{'content-type':'text/html'}})];
  for(const response of cases){const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async()=>response()});await assert.rejects(http.request('/gists/a',deadline()),/GitHub fetch unavailable/);}
  const f=fixture({respond:()=>json({},404)});assert.equal((await f.get()).bindingStatus,'unresolved');
});

test('403 / 429 / quota-zero and Retry-After back off without spinning or retries',async()=>{
  for(const status of [403,429,200]) {
    let time=100000,calls=0;const http=createGithubHttp({queue:createGithubQueue({now:()=>time}),fetchImpl:async()=>{calls++;return json({},status,{'x-ratelimit-remaining':'0','x-ratelimit-reset':'200','retry-after':'120'});}});
    if(status===200)await http.request('/user/42',deadline());else await assert.rejects(http.request('/user/42',deadline()));
    for(let i=0;i<5;i++)await assert.rejects(http.request(`/user/${i}`,deadline()));assert.equal(calls,1);
    time=219999;await assert.rejects(http.request('/user/99',deadline()));assert.equal(calls,1);
    time=220001;if(status===200)await http.request('/user/99',deadline());else await assert.rejects(http.request('/user/99',deadline()));assert.equal(calls,2);
  }
});

test('anonymous 60-request ceiling, shared in-flight requests and global concurrency two',async()=>{
  let calls=0,active=0,max=0;const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async()=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return json({});}});
  await Promise.all(Array.from({length:8},()=>http.request('/user/42',deadline())));assert.equal(calls,1);
  await Promise.all(Array.from({length:8},(_,i)=>http.request(`/user/${i}`,deadline())));assert.equal(max,2);
  for(let i=0;i<51;i++)await http.request(`/user/${100+i}`,deadline());await assert.rejects(http.request('/user/999',deadline()));assert.equal(calls,60);
});

test('hanging fetch / body honor caller deadline and allow a new attempt after expiry',async()=>{
  for(const body of [false,true]) {
    let calls=0;const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async()=>{calls++;return body?new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}}):new Promise(()=>{});}});
    const start=performance.now();await assert.rejects(http.request('/gists/a',performance.now()+25));assert.ok(performance.now()-start<150);
    await new Promise(r=>setTimeout(r,5));await assert.rejects(http.request('/gists/a',performance.now()+25));assert.equal(calls,2);
  }
});

test('cache hit, separate binding / statistics expiry, failure TTL, stale labels and 24-hour cutoff',async()=>{
  let time=Date.now(),fail=false;const f=fixture({now:()=>time,respond:(url,options,n,gist)=>{if(fail)throw Error('unavailable');return json(url.pathname.startsWith('/gists/')?gist:url.pathname==='/user/42'?profile:[repo(1,8)]);}});
  const fresh=await f.get();assert.equal(fresh.cache,'fresh');assert.equal(f.calls.length,3);assert.equal((await f.get()).cache,'cached');assert.equal(f.calls.length,3);
  time+=900001;await f.get();assert.equal(f.calls.length,4);
  time+=3600001;fail=true;const stale=await f.get();assert.equal(stale.cache,'stale');assert.equal(stale.stars.total,8);assert.equal(stale.dataFetchedAt,fresh.dataFetchedAt);assert.match(stale.label,/Cached result last checked .*refresh unavailable/);
  const n=f.calls.length;await f.get();assert.equal(f.calls.length,n);assert.equal(f.service.cached('test',f.wallet.address,f.entry,login).cache,'stale');
  time+=86400001;const expired=await f.get();assert.equal(expired.stars,undefined);assert.equal(expired.accountId,undefined);
});

test('changed / removed chain links invalidate binding, including in-flight results',async()=>{
  const f=fixture();await f.get();const changed={...f.entry,proof:`https://gist.github.com/${login}/bbbbbb`};f.service.observe('test',f.wallet.address,[changed]);assert.equal(f.service.cached('test',f.wallet.address,f.entry,login).accountId,undefined);
  f.service.observe('test',f.wallet.address,[]);assert.equal(f.service.cached('test',f.wallet.address,changed,login).accountId,undefined);
  let release;const s=createGithubSignals({queue:createGithubQueue(),fetchImpl:()=>new Promise(r=>{release=r;})});s.observe('test',f.wallet.address,[f.entry]);
  const pending=s.signals('test',f.wallet.address,f.entry,login,{deadline:performance.now()+100});await new Promise(r=>setTimeout(r,5));s.observe('test',f.wallet.address,[]);release(json(f.gist));assert.equal((await pending).accountId,undefined);
});

test('bounded cache and search cap of ten fresh checks per minute',async()=>{
  let time=Date.now();const f=fixture({now:()=>time,maxEntries:2});
  const entries=Array.from({length:3},(_,i)=>({...f.entry,proof:`https://gist.github.com/${login}/${i+1}`}));
  f.service.observe('test',f.wallet.address,entries);
  for(const entry of entries)await f.service.signals('test',f.wallet.address,entry,login,{deadline:deadline()});
  assert.equal(f.service.cached('test',f.wallet.address,entries[0],login).accountId,undefined);
  for(let i=0;i<12;i++){const address=createEphemeralWallet().address;f.service.observe('test',address,[f.entry]);const out=await f.service.signals('test',address,f.entry,login,{deadline:deadline(),search:true});if(i>=10)assert.match(out.label,/Not checked yet/);}
  const n=f.calls.length;time+=60001;const address=createEphemeralWallet().address;f.service.observe('test',address,[f.entry]);await f.service.signals('test',address,f.entry,login,{deadline:deadline(),search:true});assert.equal(f.calls.length,n+1);
});

test('token only reaches API headers; errors and text / App / portal / structured outputs contain no token or raw fields',async()=>{
  const token='generated_test_secret',f=fixture({token});const out=await f.get();assert.doesNotMatch(JSON.stringify(out),new RegExp(token));
  assert.ok(f.calls.every(c=>new URL(c.url).origin==='https://api.github.com'&&c.options.headers.Authorization===`Bearer ${token}`&&c.options.redirect==='manual'));
  const http=createGithubHttp({token,queue:createGithubQueue(),fetchImpl:async()=>{throw Error(token);}});await assert.rejects(http.request('/gists/a',deadline()),e=>!e.message.includes(token));await assert.rejects(http.request('https://evil.example/a',deadline()));
  const reader=createSellerIdentityReader({config:{sellerIdentities:'on',identityGithubSignals:'on'},githubSignals:f.service,chain:{getIdentities:async()=>({result:200,response:{web2:{github:[f.entry]}}})}});
  const identity=await reader.read(f.wallet.claim),el=(tag,props,...children)=>({tag,props,children});
  const html=vm.runInNewContext(`${SELLER_IDENTITY_RENDER};sellerIdentityHtml(identity)`,{identity,esc:s=>String(s).replace(/[<>]/g,'_')});
  for(const value of [sellerIdentityText(identity),JSON.stringify(sellerIdentityPanel(identity,el)),html]){assert.doesNotMatch(value,new RegExp(token+'|secret</script>|payload|userId'));assert.match(value,/public repository statistics checked/);assert.match(value,/archived/);}
});

test('signals off is byte-identical to PR1; token alone enables nothing; invalid configs fail without echoing tokens',async()=>{
  const f=fixture();let calls=0;const chain={getIdentities:async()=>({result:200,response:{web2:{github:[f.entry]}}})},now=()=>1700000000000;
  const originalTimer=globalThis.setTimeout;let timers=0;
  globalThis.setTimeout=(...args)=>{timers++;return originalTimer(...args);};
  try {
    const a=createSellerIdentityReader({config:{sellerIdentities:'on'},chain,now}),before=JSON.stringify(await a.read(f.wallet.claim)),baselineTimers=timers;
    timers=0;
    const b=createSellerIdentityReader({config:{sellerIdentities:'on',identityGithubSignals:'off',identityGithubToken:'test_secret'},chain,now,fetchImpl:()=>{calls++;throw Error('forbidden');}});
    assert.equal(before,JSON.stringify(await b.read(f.wallet.claim)));assert.equal(timers,baselineTimers,'off adds no GitHub timers');assert.equal(calls,0);
  } finally {globalThis.setTimeout=originalTimer;}
  const env={DACS_PUBLIC_ORIGIN:'http://127.0.0.1:9999',DACS_ALLOW_INSECURE_LOCALHOST:'1',DACS_OAUTH_COOKIE_KEYS:'a'.repeat(64)};
  assert.equal(loadConfig(env).identityGithubSignals,'off');assert.equal(loadConfig({...env,DACS_IDENTITY_GITHUB_TOKEN:'test_secret'}).identityGithubSignals,'off');
  assert.throws(()=>loadConfig({...env,DACS_IDENTITY_GITHUB_SIGNALS:'on'}),/requires DACS_SELLER_IDENTITIES/);assert.throws(()=>loadConfig({...env,DACS_IDENTITY_GITHUB_SIGNALS:'invalid'}),/must be off or on/);assert.throws(()=>loadConfig({...env,DACS_IDENTITY_GITHUB_TOKEN:'bad\ntoken'}),e=>!e.message.includes('bad\ntoken'));
});

test('five-second request ceiling aborts a transport with a longer caller deadline',async()=>{
  let signal;
  const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async(url,options)=>{signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
  const start=performance.now();await assert.rejects(http.request('/gists/a',performance.now()+10000));
  assert.ok(signal.aborted);assert.ok(performance.now()-start>=4900);assert.ok(performance.now()-start<6000);
});

test('binding negative cache expires after five minutes; bad refreshed proof discards previous binding',async()=>{
  let time=Date.now();const f=fixture({now:()=>time});
  await f.get();time+=900001;f.gist.files.proof.content='bad';
  const bad=await f.get();assert.equal(bad.bindingStatus,'unresolved');assert.equal(bad.stars,undefined);
  const n=f.calls.length;await f.get();assert.equal(f.calls.length,n);
  time+=300001;await f.get();assert.equal(f.calls.length,n+1);
});

test('bound statistics failure is withheld without turning unavailable data into a complete zero',async()=>{
  const f=fixture({respond:(url,options,n,gist)=>url.pathname.startsWith('/gists/')?json(gist):json({},500)});
  const out=await f.get();assert.equal(out.bindingStatus,'bound');assert.equal(out.accountId,42);assert.equal(out.stars,undefined);assert.equal(out.createdAt,undefined);assert.match(out.label,/Identity statistics unavailable from GitHub/);
});

test('unvalidated repositories force lower-bound totals and userId-only entries are not facts',async()=>{
  const f=fixture(),stats=await fetchGithubStatistics({accountId:42,deadline:deadline(),request:async(path)=>({data:path==='/user/42'?profile:[repo(1,5),repo(2,99,{name:'<bad>'})]})});
  assert.equal(stats.stars.complete,false);assert.equal(stats.stars.total,5);
  const reader=createSellerIdentityReader({config:{sellerIdentities:'on',identityGithubSignals:'on'},fetchImpl:()=>{throw Error('must not fetch');},chain:{getIdentities:async()=>({result:200,response:{web2:{github:[{userId:'client-identifier',proof:f.entry.proof}]}}})}});
  const out=await reader.read(f.wallet.claim);assert.deepEqual(out.identities.github,[]);assert.doesNotMatch(JSON.stringify(out),/client-identifier/);
});

test('different sellers share only statistics after each seller proves its own key binding',async()=>{
  const f=fixture(),seller=createEphemeralWallet(),second={...f.entry,userId:'different'};
  await Promise.all([f.get(),f.get()]);assert.equal(f.calls.length,3);
  f.service.observe('test',seller.address,[second]);
  f.gist.files.proof.content=`demos:dw2p:ed25519:${seller.signHex(`demos-web2:v1:github:${login}:${seller.address}`)}`;
  const out=await f.service.signals('test',seller.address,second,login,{deadline:deadline()});
  assert.equal(out.bindingStatus,'bound');assert.equal(out.stars.total,13);assert.equal(f.calls.length,4,'second seller verifies gist, then uses statistics cache keyed by account ID');
});

test('off and on HTML escaping protects any signal label without rendering executable text',()=>{
  const identity={status:'observed',label:'chain',identities:{github:[{value:login,url:`https://github.com/${login}`,signals:{label:'<img onerror="run()">',stars:{top:[{name:'repo',stars:3,archived:false,url:`https://github.com/${login}/repo`}]}}}]},evidence:{mode:'test',network:'test',rpcOrigin:null,observedAt:'now',note:'note',readLimits:{authority:'node'}}};
  const html=vm.runInNewContext(`${SELLER_IDENTITY_RENDER};sellerIdentityHtml(identity)`,{identity,esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
  assert.match(html,/&lt;img onerror=&quot;run\(\)&quot;&gt;/);assert.doesNotMatch(html,/<img/);
  const tree=sellerIdentityPanel(identity,(tag,props,...children)=>({tag,props,children}));assert.ok(JSON.stringify(tree).includes('<img onerror='),'portal passes label as text children, never innerHTML');
});

test('reader drops a changed or removed link on the next chain observation; cache-only steps never fetch',async()=>{
  let time=Date.now(),entries;const f=fixture({now:()=>time});entries=[f.entry];
  const reader=createSellerIdentityReader({config:{sellerIdentities:'on',identityGithubSignals:'on'},githubSignals:f.service,now:()=>time,ttlMs:5,chain:{getIdentities:async()=>({result:200,response:{web2:{github:entries}}})}});
  const initial=await reader.read(f.wallet.claim);assert.equal(initial.identities.github[0].signals.accountId,42);
  entries=[{...f.entry,proof:'https://raw.githubusercontent.com/other/proof'}];time+=6;
  const changed=await reader.read(f.wallet.claim);assert.equal(changed.identities.github[0].signals.bindingStatus,'unresolved');assert.equal(changed.identities.github[0].signals.stars,undefined);assert.equal(f.calls.length,3);
  entries=[];time+=6;assert.deepEqual((await reader.read(f.wallet.claim)).identities.github,[]);assert.deepEqual(reader.cached(f.wallet.claim).identities.github,[]);assert.equal(f.calls.length,3);
});

test('a stale failure cache cannot extend either binding or statistics past 24 hours',async()=>{
  let time=Date.now(),fail=false;const f=fixture({now:()=>time,respond:(url,options,n,gist)=>{if(fail)throw Error('failed');return json(url.pathname.startsWith('/gists/')?gist:url.pathname==='/user/42'?profile:[]);}});
  await f.get();fail=true;time+=86400000-1000;assert.equal((await f.get()).cache,'stale');
  time+=1001;
  const out=await f.get();assert.equal(out.stars,undefined);assert.equal(out.accountId,undefined);
  const cached=f.service.cached('test',f.wallet.address,f.entry,login);assert.equal(cached.accountId,undefined);assert.equal(cached.stars,undefined);
});


test('failed repository refresh retains prior numbers as stale instead of replacing them with zero',async()=>{
  let time=Date.now(),fail=false;const f=fixture({now:()=>time,respond:(url,options,n,gist)=>{
    if(url.pathname.startsWith('/gists/'))return json(gist);if(url.pathname==='/user/42')return json(profile);
    return fail?json({},500):json([repo(1,19)]);
  }});
  const first=await f.get();time+=3600001;fail=true;const refresh=await f.get();
  assert.equal(refresh.stars.total,19);assert.equal(refresh.cache,'stale');assert.equal(refresh.dataFetchedAt,first.dataFetchedAt);assert.match(refresh.label,/refresh unavailable/);
});


test('bounded input validation retains digest keys and bounded bytes across many subjects',async()=>{
  const f=fixture(),oversized={...f.entry,proof:`https://gist.github.com/${login}/${'a'.repeat(500000)}`};
  for(let i=0;i<1100;i++)f.service.observe('test',`subject-${i}`,Array(32).fill(oversized));
  assert.equal((await f.service.signals('test',f.wallet.address,oversized,login,{deadline:deadline()})).bindingStatus,'unresolved');
  assert.equal(f.calls.length,0);
  let size=f.service.retainedSize();assert.ok(size.subjects<=1000);assert.equal(size.subjectKeys.length,0);assert.ok(size.subjectBytes<=64000);
  for(let i=0;i<1100;i++)f.service.observe('test',`subject-${i}`,Array.from({length:32},(_,n)=>({...f.entry,proof:`https://gist.github.com/${login}/${n.toString(16)}`})));
  size=f.service.retainedSize();assert.equal(size.subjectKeys.length,8000);assert.ok(size.subjectKeys.every(k=>/^[0-9a-f]{64}$/.test(k)));assert.ok(size.subjectBytes<=1000*9*64);assert.ok(size.cacheBytes<=GITHUB_CACHE_BYTE_CAP);
  for(const name of ['a'.repeat(40),'-a','a-','a--b','a_b','a\n']) {
    const entry={username:name,proof:`https://gist.github.com/${name}/a`};f.service.observe('test',f.wallet.address,[entry]);
    assert.equal((await f.service.signals('test',f.wallet.address,entry,name,{deadline:deadline()})).bindingStatus,'unresolved');
  }
  for(const proof of [`https://gist.github.com/${login}/${'a'.repeat(65)}`,`https://gist.github.com/${login}/ABC`,f.entry.proof+'\n'])assert.equal(gistIdFor({...f.entry,proof},login),null);
  assert.equal(gistIdFor({...f.entry,proof:`https://gist.github.com/${login}/12345`},login),'12345');
  assert.equal(f.calls.length,0);
  for(let i=0;i<1100;i++) {
    const seller='0x'+i.toString(16).padStart(64,'0');f.service.observe('test',seller,[f.entry]);
    await f.service.signals('test',seller,f.entry,login,{deadline:deadline()});
  }
  size=f.service.retainedSize();assert.equal(size.cacheEntries,1000);assert.ok(size.cacheBytes<=GITHUB_CACHE_BYTE_CAP);assert.ok(size.subjectBytes<=1000*9*64);
});

test('seller retains only eight bounded GitHub entries and shows the rest as not checked',async()=>{
  const wallet=createEphemeralWallet(),entries=Array.from({length:12},(_,i)=>({username:`seller-${i}`,proof:`https://gist.github.com/seller-${i}/${i.toString(16)}`,userId:'x'.repeat(100000)}));
  let calls=0;const reader=createSellerIdentityReader({config:{sellerIdentities:'on',identityGithubSignals:'on'},chain:{getIdentities:async()=>({result:200,response:{web2:{github:entries}}})},fetchImpl:async()=>{calls++;return json({});}});
  const result=await reader.read(wallet.claim);assert.equal(calls,8);assert.equal(result.identities.github.length,12);
  for(const entry of result.identities.github.filter(e=>Number(e.value.slice(7))>=8))assert.match(entry.signals.label,/Not checked yet/);
  for(const entry of reader.cached(wallet.claim).identities.github.filter(e=>Number(e.value.slice(7))>=8))assert.match(entry.signals.label,/Not checked yet/);
});

test('changing only userId or unrelated fields reuses the canonical binding',async()=>{
  const f=fixture();await f.get();const entry={...f.entry,userId:'different'};
  f.service.observe('test',f.wallet.address,[entry]);const out=await f.service.signals('test',f.wallet.address,entry,login,{deadline:deadline()});
  assert.equal(out.bindingStatus,'bound');assert.equal(f.calls.length,3);
  const extra={...entry,username:login.toUpperCase(),unrelated:'ignored'};f.service.observe('test',f.wallet.address,[extra]);
  assert.equal((await f.service.signals('test',f.wallet.address,extra,login,{deadline:deadline()})).bindingStatus,'bound');assert.equal(f.calls.length,3);
});

test('hostile rate-limit headers recover within one hour',async()=>{
  for(const headers of [
    {'x-ratelimit-remaining':'0','x-ratelimit-reset':'999999999999999'},
    {'retry-after':'999999999999999'},
    {'retry-after':'Fri, 01 Jan 2100 00:00:00 GMT'},
    {'x-ratelimit-remaining':'-1','x-ratelimit-reset':'-1','retry-after':'-1'},
    {'x-ratelimit-remaining':'garbage','x-ratelimit-reset':'garbage','retry-after':'garbage'},
    {'x-ratelimit-remaining':'0','x-ratelimit-reset':'100.5','retry-after':'1.5'},
    {'x-ratelimit-reset':'99','retry-after':'Thu, 01 Jan 1970 00:00:01 GMT'},
  ]) {
    let time=100000,calls=0;const http=createGithubHttp({queue:createGithubQueue({now:()=>time}),fetchImpl:async()=>{calls++;return calls===1?json({},429,headers):json({ok:true});}});
    await assert.rejects(http.request('/user/1',deadline()));time+=3600001;
    assert.deepEqual((await http.request('/user/2',deadline())).data,{ok:true});assert.equal(calls,2);
  }
  for(const remaining of ['-1','garbage','0.5']) {
    let calls=0;const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async()=>{calls++;return json({},200,{'x-ratelimit-remaining':remaining});}});
    await http.request('/user/1',deadline());await http.request('/user/2',deadline());assert.equal(calls,2);
  }
});

test('two hung jobs release both slots; a third succeeds and late responses are ignored',async()=>{
  const releases=[];let calls=0,active=0,max=0;const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async()=>{calls++;if(calls<=2)return new Promise(r=>releases.push(r));
    active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return json({ok:true});}});
  await Promise.all([1,2].map(n=>assert.rejects(http.request(`/user/${n}`,performance.now()+30))));
  assert.deepEqual((await http.request('/user/3',deadline())).data,{ok:true});assert.equal(calls,3);
  for(const release of releases)release(json({},429,{'retry-after':'999999999999999'}));
  await new Promise(r=>setTimeout(r,5));assert.deepEqual((await http.request('/user/4',deadline())).data,{ok:true});
  // Late settlements must not release their slots a second time.
  await Promise.all([5,6,7,8,9,10].map(n=>http.request(`/user/${n}`,deadline())));assert.equal(max,2);
});

test('a link that is not on chain is never fetched',async()=>{
  const f=fixture();f.service.observe('test',f.wallet.address,[]);
  assert.notEqual((await f.get()).bindingStatus,'bound');assert.equal(f.calls.length,0);
});

test('a link removed before its queued binding check starts is not fetched',async()=>{
  const f=fixture();const request=f.get();
  f.service.observe('test',f.wallet.address,[]);
  assert.notEqual((await request).bindingStatus,'bound');assert.equal(f.calls.length,0);
});

test('a link removed after its binding check but before its queued statistics fetch starts fetches no statistics',async()=>{
  let time=Date.now();
  const f=fixture({now:()=>time,respond:(url,options,n,gist)=>url.pathname.startsWith('/gists/')?json(gist):json({},500)});
  assert.equal((await f.get()).bindingStatus,'bound');
  // Failed statistics expire after 5 minutes; the binding stays cached for 15.
  const before=f.calls.length;time+=300_001;
  const request=f.get();queueMicrotask(()=>f.service.observe('test',f.wallet.address,[]));
  assert.notEqual((await request).bindingStatus,'bound');assert.deepEqual(f.calls.slice(before),[]);
});

// Two sellers bound to the same GitHub account, with statistics expired but both bindings cached.
async function sharedAccount({gateProfile,maxWaiters}) {
  let time=Date.now(),failing=true,gate=null;
  const f=fixture({now:()=>time,maxWaiters,respond:(url,options,n,gist)=>{
    if(url.pathname.startsWith('/gists/'))return json(gist);
    if(failing)return json({},500);
    const body=json(url.pathname==='/user/42'?profile:[repo(1,10)]);
    return url.pathname==='/user/42'&&gate?gate.then(()=>body):body;
  }});
  const b=createEphemeralWallet(),entryB={...f.entry};
  assert.equal((await f.get()).bindingStatus,'bound');
  f.gist.files.proof.content=`demos:dw2p:ed25519:${b.signHex(`demos-web2:v1:github:${login}:${b.address}`)}`;
  f.service.observe('test',b.address,[entryB]);
  const getB=()=>f.service.signals('test',b.address,entryB,login,{deadline:performance.now()+5_000});
  assert.equal((await getB()).bindingStatus,'bound');
  // Failed statistics expire after 5 minutes; both bindings stay cached for 15.
  time+=300_001;failing=false;let release=()=>{};
  if(gateProfile)gate=new Promise((r)=>{release=r;});
  const base=f.calls.length,since=(part)=>f.calls.slice(base).filter((c)=>c.url.includes(part)).length;
  const profileCalls=()=>since('/user/42'),repoCalls=()=>since('/repos');
  const profileStarted=async()=>{for(let i=0;i<200&&!profileCalls();i++)await new Promise((r)=>setTimeout(r,5));assert.equal(profileCalls(),1);};
  return {f,b,getB,release,profileStarted,repoCalls,profileCalls,advance:(ms)=>{time+=ms;}};
}

test('a statistics fetch stops before its next request once no waiting link is current',async()=>{
  const s=await sharedAccount({gateProfile:true});
  s.f.service.observe('test',s.b.address,[]);
  const request=s.f.get({deadline:performance.now()+5_000});await s.profileStarted();
  s.f.service.observe('test',s.f.wallet.address,[]);s.release();
  assert.notEqual((await request).bindingStatus,'bound');assert.equal(s.repoCalls(),0);
});

test('a shared statistics job keeps running and is cached while any waiting seller is still linked',async()=>{
  const s=await sharedAccount({gateProfile:true});
  const first=s.f.get({deadline:performance.now()+5_000});await s.profileStarted();
  const second=s.getB();await new Promise((r)=>setTimeout(r,5));
  s.f.service.observe('test',s.f.wallet.address,[]);s.release();
  assert.notEqual((await first).bindingStatus,'bound');
  const out=await second;assert.equal(out.bindingStatus,'bound');assert.equal(out.stars.total,10);
  assert.equal(s.profileCalls(),1,'the second seller joined the running job');
  const calls=s.f.calls.length;assert.equal((await s.getB()).stars.total,10);assert.equal(s.f.calls.length,calls,'the result was cached for the seller still linked');
});

test('a refresh that completes after its link was removed and re-added saves nothing and fetches no statistics',async()=>{
  let time=Date.now(),gate=null;
  const f=fixture({now:()=>time,respond:(url,options,n,gist)=>{
    if(url.pathname.startsWith('/gists/')){const body=json(gist);return gate?gate.then(()=>body):body;}
    return json(url.pathname==='/user/42'?profile:[repo(1,10)]);
  }});
  const statsCalls=()=>f.calls.filter((c)=>!new URL(c.url).pathname.startsWith('/gists/')).length;
  assert.equal((await f.get()).bindingStatus,'bound');
  // Past both TTLs, so the stale refresh would also have to fetch statistics.
  let release;gate=new Promise((r)=>{release=r;});time+=3600_001;
  const refresh=f.get({deadline:performance.now()+5_000});await new Promise((r)=>setTimeout(r,5));
  f.service.observe('test',f.wallet.address,[]);f.service.observe('test',f.wallet.address,[f.entry]);
  const before=statsCalls();release();
  assert.notEqual((await refresh).bindingStatus,'bound');
  assert.notEqual(f.service.cached('test',f.wallet.address,f.entry,login).bindingStatus,'bound');
  assert.equal(statsCalls(),before);
});

test('repeated calls for one link wait on a running job once',async()=>{
  const s=await sharedAccount({gateProfile:true});
  const calls=Array.from({length:20},()=>s.f.get({deadline:performance.now()+5_000}));await s.profileStarted();
  for(let i=0;i<20;i++)calls.push(s.f.get({deadline:performance.now()+5_000}));
  let size=s.f.service.retainedSize();assert.equal(size.pendingJobs,1);assert.equal(size.pendingWaiters,1);
  const second=s.getB();await new Promise((r)=>setTimeout(r,5));
  assert.equal(s.f.service.retainedSize().pendingWaiters,2,'one waiter per seller link');
  s.release();for(const out of await Promise.all([...calls,second]))assert.equal(out.stars.total,10);
  size=s.f.service.retainedSize();assert.equal(size.pendingJobs,0);assert.equal(size.pendingWaiters,0);
});

test('a running job keeps at most its cap of waiting links (64 by default)',async()=>{
  assert.equal(GITHUB_JOB_WAITER_CAP,64);
  const s=await sharedAccount({gateProfile:true,maxWaiters:3}),results=[];
  const gists=()=>s.f.calls.filter((c)=>c.url.includes('/gists/')).length;
  for(let i=0;i<5;i++){
    const w=createEphemeralWallet(),n=gists();
    s.f.gist.files.proof.content=`demos:dw2p:ed25519:${w.signHex(`demos-web2:v1:github:${login}:${w.address}`)}`;
    s.f.service.observe('test',w.address,[s.f.entry]);
    results.push(s.f.service.signals('test',w.address,s.f.entry,login,{deadline:performance.now()+4_000}));
    for(let j=0;j<200&&gists()===n;j++)await new Promise((r)=>setTimeout(r,5));
  }
  await new Promise((r)=>setTimeout(r,50));
  assert.equal(s.f.service.retainedSize().pendingWaiters,3);
  s.release();for(const out of await Promise.all(results))assert.equal(out.stars.total,10);
});

test('a shared job failing at its starter\'s deadline is kept only 30 seconds while another linked seller had longer',async()=>{
  const s=await sharedAccount({gateProfile:true});
  const first=s.f.get({deadline:performance.now()+150});await s.profileStarted();
  const second=s.getB();
  assert.equal((await first).stars,undefined);assert.equal((await second).stars,undefined);
  s.release();assert.equal((await s.getB()).stars,undefined);assert.equal(s.profileCalls(),1,'kept for 30 seconds');
  s.advance(30_001);const out=await s.getB();
  assert.equal(out.stars.total,10);assert.equal(s.profileCalls(),2,'after 30 seconds the second seller checked again instead of reading a cached failure');
});

test('the same link calling again with more time also keeps a failure at the first deadline only 30 seconds',async()=>{
  const s=await sharedAccount({gateProfile:true});
  const first=s.f.get({deadline:performance.now()+150});await s.profileStarted();
  const again=s.f.get({deadline:performance.now()+5_000});
  assert.equal((await first).stars,undefined);assert.equal((await again).stars,undefined);
  s.release();assert.equal((await s.f.get({deadline:performance.now()+5_000})).stars,undefined);assert.equal(s.profileCalls(),1);
  s.advance(30_001);assert.equal((await s.f.get({deadline:performance.now()+5_000})).stars.total,10);assert.equal(s.profileCalls(),2);
});

test('a search that starts both a binding check and a statistics fetch is charged once',async()=>{
  const f=fixture();
  for(let i=0;i<11;i++){
    const w=createEphemeralWallet();f.gist.files.proof.content=`demos:dw2p:ed25519:${w.signHex(`demos-web2:v1:github:${login}:${w.address}`)}`;
    f.service.observe('test',w.address,[f.entry]);
    const out=await f.service.signals('test',w.address,f.entry,login,{deadline:deadline(),search:true});
    if(i<10)assert.equal(out.bindingStatus,'bound',`search ${i+1} of 10 is allowed`);else assert.match(out.label,/Not checked yet/);
  }
});

test('searches that join a running job do not use up the search allowance',async()=>{
  const s=await sharedAccount({gateProfile:true});
  const searches=Array.from({length:10},()=>s.f.get({search:true,deadline:performance.now()+5_000}));await s.profileStarted();
  for(let i=0;i<9;i++)searches.push(s.f.get({search:true,deadline:performance.now()+5_000}));
  s.release();await Promise.all(searches);
  const other=createEphemeralWallet(),gists=()=>s.f.calls.filter((c)=>c.url.includes('/gists/')).length,before=gists();
  s.f.service.observe('test',other.address,[s.f.entry]);
  await s.f.service.signals('test',other.address,s.f.entry,login,{search:true,deadline:performance.now()+5_000});
  assert.equal(gists(),before+1,'one search started work, so another seller can still be checked');
});

test('a refresh that fails after its link was removed and re-added does not restore the old binding',async()=>{
  let time=Date.now(),gate=null;
  const f=fixture({now:()=>time,respond:(url,options,n,gist)=>{
    if(url.pathname.startsWith('/gists/'))return gate?gate.then(()=>json({},500)):json(gist);
    return json(url.pathname==='/user/42'?profile:[repo(1,10)]);
  }});
  assert.equal((await f.get()).bindingStatus,'bound');
  let release;gate=new Promise((r)=>{release=r;});time+=900_001;
  const refresh=f.get({deadline:performance.now()+5_000});await new Promise((r)=>setTimeout(r,5));
  f.service.observe('test',f.wallet.address,[]);f.service.observe('test',f.wallet.address,[f.entry]);release();
  assert.notEqual((await refresh).bindingStatus,'bound');
  assert.notEqual(f.service.cached('test',f.wallet.address,f.entry,login).bindingStatus,'bound');
});

test('a refresh started before a link was removed cannot restore it after the link is re-added',async()=>{
  let time=Date.now(),hang=false;
  const f=fixture({now:()=>time,respond:(url,options,n,gist)=>{
    if(url.pathname.startsWith('/gists/'))return hang?new Promise(()=>{}):json(gist);
    return json(url.pathname==='/user/42'?profile:[repo(1,10)]);
  }});
  assert.equal((await f.get()).bindingStatus,'bound');
  time+=900_001;hang=true;const refresh=f.get({deadline:performance.now()+50});await new Promise(r=>setTimeout(r,5));
  f.service.observe('test',f.wallet.address,[]);f.service.observe('test',f.wallet.address,[f.entry]);
  const joined=f.get({deadline:performance.now()+300});
  // The first refresh fails at its deadline; nothing it carried over may be saved.
  assert.notEqual((await refresh).bindingStatus,'bound');assert.notEqual(f.service.cached('test',f.wallet.address,f.entry,login).bindingStatus,'bound');
  assert.notEqual((await joined).bindingStatus,'bound');assert.notEqual(f.service.cached('test',f.wallet.address,f.entry,login).bindingStatus,'bound');
  hang=false;f.gist.files.proof.content='demos:dw2p:ed25519:'+'0'.repeat(128);
  assert.equal((await f.get()).bindingStatus,'unresolved');
});

test('an evicted seller loses its cached binding, so removing and re-adding a link checks it again',async()=>{
  const f=fixture({maxEntries:3});assert.equal((await f.get()).bindingStatus,'bound');assert.equal(f.calls.length,3);
  for(let i=0;i<3;i++)f.service.observe('test',createEphemeralWallet().address,[]);
  f.service.observe('test',f.wallet.address,[]);f.gist.files.proof.content='demos:dw2p:ed25519:'+'0'.repeat(128);
  f.service.observe('test',f.wallet.address,[f.entry]);
  const out=await f.get();assert.equal(out.bindingStatus,'unresolved');assert.equal(f.calls.length,4);
});

test('capped statistics remain cached beyond five minutes; failed pages retry after five minutes',async()=>{
  for(const failed of [false,true]) {
    let time=Date.now(),pages=0;const f=fixture({now:()=>time,respond:(url,options,n,gist)=>{
      if(url.pathname.startsWith('/gists/'))return json(gist);if(url.pathname==='/user/42')return json(profile);
      pages++;return failed?json({},500):json([repo(pages)],200,{link:next(pages+1)});
    }});
    const first=await f.get();assert.equal(first.stars.complete,false);assert.match(first.label,/at least/);
    const count=f.calls.length;time+=300001;await f.get();assert.equal(f.calls.length,failed?count+2:count);
    if(!failed){time+=3300000;await f.get();assert.equal(f.calls.length,count+12);}
  }
});

test('proof content accepts exactly one final LF and refuses every other whitespace padding with a reason',async()=>{
  const f=fixture(),content=f.gist.files.proof.content;
  for(const value of [' '+content,content+' ',content+'\r\n',content+'\n\n','\n'+content,'\u00a0'+content,content+'\u2003']) {
    f.gist.files.proof.content=value;const out=await bind(f);assert.equal(out.bindingStatus,'unresolved');assert.match(out.reason,/exact/);
  }
  f.gist.files.proof.content=content+'\n';assert.equal((await bind(f)).bindingStatus,'bound');
});

test('streaming byte cap refuses valid JSON without Content-Length',async()=>{
  const large=JSON.stringify({padding:'x'.repeat(1000001)});
  const direct=createGithubHttp({queue:createGithubQueue(),fetchImpl:async()=>new Response(large,{headers:{'content-type':'application/json'}})});
  await assert.rejects(direct.request('/user/1',deadline()));
});

test('streaming byte cap refuses real gzip expansion with a small compressed body',async()=>{
  const large=JSON.stringify({padding:'x'.repeat(1000001)});
  assert.ok(gzipSync(large).byteLength<1000000);
  const server=createServer((req,res)=>{const body=gzipSync(req.url==='/small'?'{}':large);res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});res.end(body);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async url=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`);
      return new Response(response.body,{headers:response.headers});
    }});
    assert.deepEqual((await http.request('/small',deadline())).data,{});
    await assert.rejects(http.request('/large',deadline()));
  } finally {await new Promise(r=>server.close(r));}
});

test('fixed origin refuses off-site URLs before a successful fake transport is called',async()=>{
  let calls=0;const http=createGithubHttp({queue:createGithubQueue(),fetchImpl:async()=>{calls++;return json({});}});
  for(const url of ['https://evil.example/user/1','https://api.github.com.evil.example/user/1','//evil.example/user/1'])await assert.rejects(http.request(url,deadline()));
  assert.equal(calls,0);
});


test('cache byte budget evicts independently of entry count; sanitized entries retain no raw oversized fields',async()=>{
  const f=fixture({maxCacheBytes:1024});await f.get();
  const size=f.service.retainedSize();assert.ok(size.cacheBytes>0);assert.ok(size.cacheBytes<=1024);assert.ok(size.cacheEntries<2);
  const hostile={...f.entry,proof:f.entry.proof+'a'.repeat(500000),userId:'b'.repeat(500000)};
  assert.deepEqual(sanitizeGithubEntry(hostile),{username:login});
  assert.deepEqual(sanitizeGithubEntry({...f.entry,userId:'b'.repeat(500000)}),{username:login,proof:f.entry.proof});
  assert.deepEqual(sanitizeGithubEntry({username:'a'.repeat(500000),proof:f.entry.proof}),{});
});


test('subject cap also leaves excess TLSNotary entries not checked',async()=>{
  const f=fixture(),entries=Array.from({length:9},(_,n)=>({username:`seller-${n}`,proofType:'tlsn',proof:{unchecked:'discard'}}));
  f.service.observe('test',f.wallet.address,entries);
  const excess=await f.service.signals('test',f.wallet.address,entries[8],entries[8].username,{deadline:deadline()});
  assert.match(excess.label,/Not checked yet/);assert.match(f.service.cached('test',f.wallet.address,entries[8],entries[8].username).label,/Not checked yet/);
  assert.equal(f.calls.length,0);
});
