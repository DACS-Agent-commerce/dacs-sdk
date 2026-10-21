// Actual app/assets/bridge/UI/bundled SDK. Explicit TEST source authority at
// an owned marker-free HTTPS loopback node, not provided Devnet/live authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetNativeTransportHarness } from './helpers/devnet-native-transport-harness.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { launchTestChrome,openRecordedPage,createCleanupStack,freshPassword,uiCreate,UI,assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';

test('Chrome actual app native-only capability: same-origin SDK transport, trusted exact-debit click, original signed bytes, marker-free HTTPS TEST binding, durable readback/restart no resend', {timeout:150000}, async t=>{
  const cleanup=createCleanupStack();t.after(()=>cleanup.run());
  const h=await startDevnetNativeTransportHarness();cleanup.add('owned native app/TLS fixture',10000,()=>h.close());
  const launched=await launchTestChrome(cleanup);t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}`);
  const rec=await openRecordedPage(launched.browser,cleanup),{page}=rec;
  await page.route('**/*',route=>new URL(route.request().url()).origin===h.origin?route.continue():route.abort());
  await page.goto(`${h.origin}/portal/assets/embedded-wallet/index.html`);
  await page.evaluate(async()=>{
    const {openEmbeddedWallet}=await import('/portal/assets/embedded-wallet-bridge.mjs');
    const {createDevnetNativeWalletTransport}=await import('/portal/assets/embedded-wallet/sdk-provider.mjs');
    const profile=await fetch('/portal/api/devnet-native-wallet-profile',{method:'POST'}).then(r=>r.json());
    document.getElementById('embedded-wallet').hidden=true;
    const root=document.createElement('div');root.id='native-test-wallet';document.body.append(root);
    window.nativeUi=await openEmbeddedWallet(root,{transactionTransport:createDevnetNativeWalletTransport(profile),onProviderReady:p=>{window.nativeProvider=p;}});
    await window.nativeUi.ready;
  });
  const password=freshPassword(),walletUi=page.locator('#native-test-wallet');
  const address=await uiCreate(walletUi,password);
  await page.waitForFunction(()=>Boolean(window.nativeProvider));
  const tx=buildNativeTransferPayload({from:address,to:'0x'+'71'.repeat(32),amountOs:'2500000000',nonce:1,timestamp:Date.now(),encoding:'os-string'});
  await page.evaluate(tx=>{window.nativeResult=null;void window.nativeProvider.request({method:'sendTransaction',params:[tx]}).then(r=>window.nativeResult=r);},tx);
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Exact content to approve').waitFor();
  const shown=JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.action,'native DEM transfer');assert.equal(shown.amountOs,'2500000000');assert.equal(shown.debit.totalOs,'8500000000');assert.equal(shown.nonce,1);
  assert.equal(shown.networkBinding.chainIdentity,h.expected.chainIdentity);assert.match(shown.networkBinding.transportAuthority,/^TEST-/);
  assert.equal(h.chain.record.broadcasts.length,0);assert.equal((await h.journal.entries()).length,0);
  await dialog.getByRole('button',{name:UI.approve}).click();
  await page.waitForFunction(()=>window.nativeResult!==null);const sent=await page.evaluate(()=>window.nativeResult);
  assert.equal(sent.success,true,JSON.stringify(sent));assert.equal(h.chain.record.broadcasts.length,1);assert.equal(h.chain.record.accepted.length,1);
  const issued=(await h.journal.entries())[0][1];assert.deepEqual(issued.signedTransaction,h.chain.record.accepted[0]);assert.equal(issued.hash,sent.data.hash);
  await h.restart();
  const repeated=await page.evaluate(tx=>window.nativeProvider.request({method:'sendTransaction',params:[tx]}),tx);
  assert.equal(repeated.error.code,'outcome_unknown');assert.equal(h.chain.record.broadcasts.length,1);assert.equal(await page.getByRole('dialog').count(),0);
  const read=await page.evaluate(hash=>window.nativeProvider.request({method:'readNativeTransfer',params:[{hash}]}),sent.data.hash);
  assert.equal(read.success,true,JSON.stringify(read));assert.equal(read.data.disposition,'included');assert.equal(read.data.receipt.blockNumber,1);assert.equal(read.data.receipt.finality,'not-established');
  assert.equal(h.chain.record.broadcasts.length,1);assert.equal(h.chain.wire.record.accepted.length,0,'the new native transport never CREATEs');
  assert.ok(h.responseMarkers.length>0);assert.ok(h.responseMarkers.every(m=>m===null));
  assertNoSecrets(rec.requests,[password],'owned native browser requests');assertNoSecrets(h.logs,[password],'owned native app logs');
  assert.ok(rec.requests.every(r=>new URL(r.url).origin===h.origin));assert.deepEqual(rec.consoleErrors,[]);
  t.diagnostic(JSON.stringify({browser:launched.version,hash:sent.data.hash,nonce:1,totalDebitOs:shown.debit.totalOs,block:1,appRestarts:h.restarts(),nativeBroadcasts:1,authority:shown.networkBinding.transportAuthority,markerRequired:false,finality:'not-established',consumer:'actual app same-origin bridge/UI SDK; protected purchase UI remains held'}));
});
