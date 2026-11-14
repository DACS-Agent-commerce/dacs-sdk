import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { installPackedPair, lockMissingEntries, sdkDir } from './helpers/packed-install.mjs';
import { childOwnStderr, runFreshChild } from './helpers/fresh-node-child.mjs';

let installed;
const cleanups = [];
test.after(() => { for (const cleanup of cleanups) cleanup(); });
test.before(() => { installed = installPackedPair({ after: cleanup => cleanups.push(cleanup) }, { installedDependencyGraph: true }); });

test('the packed client, dacs-node and core installed outside the checkout with optional dependencies omitted import node-wallet with demosdk resolved, better-sqlite3 absent and dacs-node resolved to its packed archive', t => {
  const { app, nodeArchive } = installed;
  assert.ok(relative(sdkDir, app).startsWith('..'));
  const lock = JSON.parse(readFileSync(join(app, 'package-lock.json')));
  assert.deepEqual(lockMissingEntries(lock), []);
  assert.equal(resolve(app, lock.packages['node_modules/@kynesyslabs/dacs-node'].resolved.slice('file:'.length)), resolve(app, nodeArchive.slice('file:'.length)));
  assert.equal(existsSync(join(app, 'node_modules/better-sqlite3')), false);
  assert.equal(lock.packages['node_modules/@kynesyslabs/demosdk'].version, JSON.parse(readFileSync(join(sdkDir, 'node_modules/@kynesyslabs/demosdk/package.json'))).version);
  const child = runFreshChild(t, `
    import assert from 'node:assert/strict';
    import {writeFileSync, realpathSync} from 'node:fs';
    const api = await import('@kynesyslabs/dacs-client/node-wallet');
    assert.equal(typeof api.createNodeSellerComposition, 'function');
    assert.equal(typeof api.createHeldTransportFacade, 'function');
    await import('@kynesyslabs/dacs');
    await import('@kynesyslabs/dacs-client');
    await import('@kynesyslabs/dacs-node/demos-loader');
    assert.match(import.meta.resolve('@kynesyslabs/demosdk/websdk'), /node_modules/);
    assert.ok(realpathSync(new URL(import.meta.resolve('@kynesyslabs/dacs-node'))).startsWith(process.cwd()+'/node_modules/'));
    assert.throws(() => import.meta.resolve('better-sqlite3'), {code:'ERR_MODULE_NOT_FOUND'});
    writeFileSync('result.json', JSON.stringify({exports:Object.keys(api).sort()}));
  `, [], { directory: app });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(childOwnStderr(child.stderr), '');
  for (const name of ['createNodeSellerComposition', 'createHeldTransportFacade', 'createNodeObserver', 'isDevnetDemoTransport']) assert.ok(child.result.exports.includes(name));
});

test('in a fresh child in the consumer directory, the packed node-wallet entry constructs a wallet from a generated valid mnemonic, completes an offline native-send control and writes nothing to stdout or stderr', t => {
  const { app } = installed;
  for (const name of ['purchase-admission-hook.mjs', 'purchase-admission-double.mjs']) cpSync(new URL('./helpers/' + name, import.meta.url), join(app, name));
  const fixture = readFileSync(new URL('./helpers/tp1-node-fixture.mjs', import.meta.url), 'utf8');
  const nodeSource = fixture.slice(fixture.indexOf('export function scriptedNode()'), fixture.indexOf('export async function world')).replace('export ', '');
  const child = runFreshChild(t, `
    import assert from 'node:assert/strict';
    import {writeFileSync} from 'node:fs';
    import {randomBytes} from 'node:crypto';
    import {entropyToMnemonic} from '@scure/bip39';
    import {wordlist} from '@scure/bip39/wordlists/english.js';
    import {installPurchaseAdmissionHook,loadAdmissionDouble} from './purchase-admission-hook.mjs';
    installPurchaseAdmissionHook(); (await loadAdmissionDouble()).setPurchaseAdmission('testnet-tp1');
    const api = await import('@kynesyslabs/dacs-client/node-wallet');
    const {bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD} = await import('@kynesyslabs/dacs/wire');
    const T0=1793102400000, ok=response=>({result:200,response,require_reply:false,extra:null});
    ${nodeSource}
    const node=scriptedNode(), owner=api.createNodeTransportOwner({endpoint:'https://rpc.example.invalid/',transportAuthority:'vector-authority',fetchImpl:node.fetch});
    const binding=await bindTp1Profile({record:TP1_APPROVED_IDENTITY_RECORD,local:owner.local,readAuthority:async scope=>({local:scope.local,chainIdentity:TP1_APPROVED_IDENTITY_RECORD.chainIdentity,provenance:'TEST-packed-authority',sessionId:scope.sessionId,participants:[]})});
    const rows=new Map(), journal={get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,structuredClone(v)),entries:async()=>[...rows],withWalletLock:async(k,work)=>work()};
    const key=new TextEncoder().encode(entropyToMnemonic(randomBytes(32),wordlist));
    const options={admission:{binding,currentLocal:owner.currentLocal},owner,journal,approve:async()=>true,clock:{now:()=>T0}};
    const bootstrap=await api.createNodeWalletSession({...options,key});
    assert.ok(key.every(byte=>byte===0));
    await bootstrap.close();
    const {Demos}=await import('@kynesyslabs/demosdk/websdk');
    const session=await api.createNodeWalletSession({...options,key:new TextEncoder().encode(new Demos().newMnemonic())});
    const from=session.wallet.getPublicAccount().address;
    const to='0x'+'2'.repeat(64), amount='2500000000';
    const content={type:'native',from,to,amount,data:['native',{nativeOperation:'send',args:[to,amount]}],nonce:1,timestamp:T0,transaction_fee:{network_fee:'0',rpc_fee:'0',additional_fee:'0',rpc_address:null}};
    // Same public unsigned payload as a host's native-send handoff.
    const payload={content,signature:null,hash:'',status:'',blockNumber:null};
    const answer=await session.wallet.request({method:'sendTransaction',params:[payload]});
    assert.equal(answer.success,true,JSON.stringify(answer));
    assert.equal(node.broadcasts.length,1);
    await session.close(); owner.close();
    writeFileSync('result.json',JSON.stringify({broadcasts:node.broadcasts.length}));
  `, [], { directory: app });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(childOwnStderr(child.stderr), '');
  assert.deepEqual(child.result, { broadcasts: 1 });
});
