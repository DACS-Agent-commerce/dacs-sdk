import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createDevnetDemoComposition } from '../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../src/devnet-demo/operator-network.mjs';
import { startOperatorNode2 } from './helpers/devnet-operator-node2.mjs';

const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const getWithHost=(origin,path,host)=>new Promise((resolve,reject)=>{const request=http.request(`${origin}${path}`,{headers:{host,'x-forwarded-proto':'https'}},(response)=>{let body='';response.on('data',(chunk)=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body}));});request.on('error',reject);request.end();});
const baseConfig=(root,ports)=>({format:'dacs-node2-demo-operator/v1',authority:'TEST-RUN-operator-external-001',publicOrigin:`http://127.0.0.1:${ports[0]}`,sellerOrigin:`https://127.0.0.1:${ports[1]}`,
  sellerTls:{keyPath:join(root,'seller-key.pem'),certificatePath:join(root,'seller-cert.pem')},directoryOrigin:`http://127.0.0.1:${ports[2]}`,stateDirectory:join(root,'state'),custodyDirectory:join(root,'custody'),networkAdmissionPath:join(root,'admission.json'),
  listing:{listingId:'operator-external-report',listingVersion:1,displayName:'External Operator Seller',title:'Externally advertised report',description:'Seller bytes for a remote MCP client.',category:'services.market-report',tags:['report'],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
  sellerFeeBudget:{maxTotalOs:'10000000000'},buyerFeeBudget:{maxTotalOs:'12000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'Purchased bytes for the remote client.'}});

test('external origin configuration is exact HTTPS, public, and redirect origins require it; refusal happens before any network or custody',async t=>{
  const root=await mkdtemp(join(tmpdir(),'devnet-operator-external-bad-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=baseConfig(root,[18901,18902,18903]);
  const cases=[{externalOrigin:'http://plugin.example'},{externalOrigin:'https://127.0.0.1:8443'},{externalOrigin:'https://plugin.example/mcp'},{externalOrigin:'https://user@plugin.example'},
    {allowedRedirectOrigins:['https://chatgpt.com']},{externalOrigin:'https://plugin.example',allowedRedirectOrigins:['http://chatgpt.com']},{externalOrigin:'https://plugin.example',allowedRedirectOrigins:[]}];
  for(const [index,extra] of cases.entries()){
    const configPath=join(root,`operator-${index}.json`);await writeFile(configPath,`${JSON.stringify({...config,...extra})}\n`,{mode:0o600});
    await assert.rejects(createDevnetDemoOperator({configPath,fetchImpl:()=>{throw new Error('no network before config validation');}}),/externalOrigin|allowedRedirectOrigins|exact public HTTPS origin/,JSON.stringify(extra));
  }
});

test('an externally advertised operator listens on loopback, advertises the HTTPS issuer and ChatGPT redirect, and refuses the local buyer driver',{timeout:150000},async t=>{
  const node2=await startOperatorNode2();t.after(()=>node2.close());
  const root=await mkdtemp(join(tmpdir(),'devnet-operator-external-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const ports=await Promise.all([freePort(),freePort(),freePort()]);
  const config={...baseConfig(root,ports),externalOrigin:'https://plugin-test.example',allowedRedirectOrigins:['https://chatgpt.com']};
  await bootstrapTestWalletCustody({directory:config.custodyDirectory,publicOrigin:config.publicOrigin});
  const observation=await observeNode2Identity({endpoint:node2.endpoint,network:'demos-devnet',fetchImpl:node2.fetchImpl});
  const admission=admitObservedNode2Identity({observation,authority:config.authority,transportAuthority:'TEST-owned-external-node2',pinVersion:'TEST-external-pin-v1',reviewedChainIdentity:observation.chainIdentity});
  await writeFile(config.networkAdmissionPath,`${JSON.stringify(admission)}\n`,{mode:0o600});
  await writeFile(config.sellerTls.keyPath,node2.key,{mode:0o600});await writeFile(config.sellerTls.certificatePath,node2.cert,{mode:0o600});
  const configPath=join(root,'operator.json');await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
  const testFetch=(url,options)=>new URL(url).protocol==='https:'?node2.fetchImpl(url,options):fetch(url,options);
  const operator=await createDevnetDemoOperator({configPath,fetchImpl:testFetch,authorizeSellerApproval:()=>true});t.after(()=>operator.close());
  for(const path of ['/mcp','/health','/portal/api/devnet-native-wallet-rpc','/arbitrary']){
    const starting=await getWithHost(config.publicOrigin,path,'plugin-test.example');
    assert.equal(starting.status,503,path);assert.equal(JSON.parse(starting.body).error,'operator_starting');
  }
  const prepared=await operator.prepareDevnetDemo();
  assert.equal(prepared.config.publicOrigin,'https://plugin-test.example');assert.deepEqual(prepared.config.allowedRedirectOrigins,['https://plugin-test.example','https://chatgpt.com']);assert.equal(prepared.config.trustProxy,true);
  const composition=await createDevnetDemoComposition(prepared.composition);t.after(()=>composition.sellerAgent.close?.());
  const application=await createApp({config:prepared.config,dacsProtocol:composition.dacsProtocol,devnetAgreementTransport:prepared.devnetAgreementTransport,fetchImpl:testFetch});t.after(()=>application.close());
  await operator.attachSellerAgent({sellerAgent:composition.sellerAgent,application,composition});
  const running=await operator.listen({application,composition});t.after(()=>running.close());
  const metadata=await getWithHost(config.publicOrigin,'/.well-known/oauth-authorization-server/oauth','plugin-test.example');
  assert.equal(metadata.status,200,metadata.body);assert.equal(JSON.parse(metadata.body).issuer,'https://plugin-test.example/oauth');
  const resource=await getWithHost(config.publicOrigin,'/.well-known/oauth-protected-resource/mcp','plugin-test.example');
  assert.equal(resource.status,200,resource.body);assert.equal(JSON.parse(resource.body).resource,'https://plugin-test.example/mcp');
  assert.equal((await getWithHost(config.publicOrigin,'/.well-known/oauth-authorization-server/oauth','attacker.example')).status>=400,true,'unknown hosts stay refused');
  assert.throws(()=>operator.createBuyerDriver({composition}),/remote MCP client/);
});
