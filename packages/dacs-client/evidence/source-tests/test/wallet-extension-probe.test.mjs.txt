import { createSdkWallet, honestSdk } from './helpers/wallet-extension-probe-sdk.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createExtensionProbeAdapter } from '../public/wallet-extension-probe/adapter.mjs';
import { addressOf, checkSignedTransaction, jsonCopy, sha256, verifyExact } from '../public/wallet-extension-probe/checks.mjs';
import { MESSAGE_VECTORS, nativeVector, storageVector, PROBE_NETWORK, PROBE_CHAIN_IDENTITY, PROBE_NONCE, PROBE_MAX_BALANCE_OS } from '../public/wallet-extension-probe/vectors.mjs';
import { buildNativeTransferPayload, buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { canonicalize, contentHash, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { verifyDemosSignature } from '../src/wallet/demos-signature.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fakeExtension, fakeWindow, signedTransaction, installProbeDom } from './helpers/wallet-extension-probe-dom.mjs';

async function setup(options = {}, adapterOptions = {}) {
  const fake = fakeExtension(options), win = fakeWindow(fake.provider);
  const adapter = createExtensionProbeAdapter({ windowObject: win, readAccount: async () => ({ currentNonce: 7, balanceOs: '1' }), ...adapterOptions });
  await adapter.discover(); return { ...fake, win, adapter };
}
const native = (address, options = {}) => nativeVector({ from: address, nonce: PROBE_NONCE, timestamp: 1234, ...options });
const storage = (address) => storageVector({ from: address, nonce: PROBE_NONCE, timestamp: 1234 });

test('discovery observes present and late providers, never confuses absent or locked with connected', async () => {
  const { provider, calls } = fakeExtension({ accountsResponse: { code: 401, data: null } });
  for (const delay of [0, 5]) {
    const win = fakeWindow(provider, { delay }), adapter = createExtensionProbeAdapter({ windowObject: win, discoveryTimeoutMs: 50 });
    assert.equal((await adapter.discover()).state, 'present');
    assert.equal((await adapter.accounts()).state, 'locked');
    assert.equal(win.requests, 1);
  }
  const win = fakeWindow(provider, { absent: true }), adapter = createExtensionProbeAdapter({ windowObject: win, discoveryTimeoutMs: 5 });
  assert.equal((await adapter.discover()).state, 'not-observed'); win.announce();
  await assert.rejects(adapter.connect(), /provider_unavailable/);
  assert.ok(calls.every((c) => c.method === 'accounts'));
});

test('accounts distinguishes absent, malformed, readable and different accounts', async () => {
  for (const [response, state] of [[{ code: 404, data: null }, 'wallet-absent'], [{ success: false, error: 'Module not found' }, 'malformed-account-response'], [{ code: 401, data: 'bad' }, 'malformed-account-response'], [{ code: 200, data: createEphemeralWallet().address, extra: 1 }, 'malformed-account-response']]) {
    const { adapter } = await setup({ accountsResponse: response }); assert.equal((await adapter.accounts()).state, state);
  }
  const same = await setup(); await same.adapter.connect(); assert.equal((await same.adapter.accounts()).ok, true);
  const other = await setup({ accountsResponse: { code: 200, data: createEphemeralWallet().address } });
  await other.adapter.connect(); assert.equal((await other.adapter.accounts()).ok, false);
});

test('connect approved, denied, malformed addresses and wrong method envelopes fail closed', async () => {
  const approved = await setup(); assert.equal((await approved.adapter.connect()).address, approved.wallet.address);
  for (const data of ['bad', { address: 'bad' }, { address: approved.wallet.address, secret: 'do not retain' }]) {
    const { adapter } = await setup({ connectResponse: { success: true, data } }); await assert.rejects(adapter.connect());
  }
  for (const response of [{ success: false, data: { address: approved.wallet.address } }, { success: false, error: { message: '<img src=x onerror=alert(1)>' } }, { success: true, method: 'sendTransaction', data: { address: approved.wallet.address } }, { success: true, type: 'wrong', data: { address: approved.wallet.address } }, { data: { address: approved.wallet.address } }, { success: true, data: { address: approved.wallet.address }, extra: 1 }]) {
    const { adapter } = await setup({ connectResponse: response }); await assert.rejects(adapter.connect());
  }
  assert.throws(() => addressOf('0xabc')); assert.equal(addressOf(approved.wallet.address.toUpperCase()), approved.wallet.address);
});

test('full extension response envelopes are accepted only with the exact method, type, id and field set', async () => {
  const wallet = createEphemeralWallet();
  const full = { type: 'demosProviderResponse', id: '00000000-0000-0000-0000-000000000000', method: 'connect', success: true, data: { address: wallet.address } };
  const { adapter } = await setup({ wallet, connectResponse: full }); assert.equal((await adapter.connect()).address, wallet.address);
  assert.equal(adapter.report().records.find((r) => r.method === 'connect').response.id, full.id);
  for (const patch of [{ id: 1 }, { id: 'bad' }, { id: 'a'.repeat(36) }, { method: 'sendTransaction' }, { type: 'wrong' }, { extra: 1 }]) {
    const { adapter: invalid } = await setup({ connectResponse: { ...full, ...patch } }); await assert.rejects(invalid.connect(), /malformed_envelope/);
  }
});

test('P3 verifies all exact UTF-8 vectors locally with hex and base64url, matching the server verifier', async () => {
  for (const encoding of ['hex', 'base64url']) {
    const wallet = createEphemeralWallet();
    const { adapter, calls } = await setup({ wallet, signMessage: (message) => ({ success: true, data: encoding === 'hex' ? { type: 'ed25519', data: wallet.signHex(message) } : wallet.signBytes(Buffer.from(message)).toString('base64url') }) });
    await adapter.connect();
    for (const message of MESSAGE_VECTORS) {
      assert.equal((await adapter.signMessage(message)).ok, true);
      assert.equal(verifyDemosSignature({ address: wallet.address, message, signature: wallet.signHex(message) }), true);
    }
    assert.deepEqual(calls.filter((c) => c.method === 'sign').map((c) => c.params[0]), [...MESSAGE_VECTORS]);
  }
});

test('P3 rejects wrong account, prefixed, prehashed, algorithm, claimed-account and malformed signatures', async () => {
  const wallet = createEphemeralWallet(), other = createEphemeralWallet();
  const responses = [
    (m) => ({ type: 'ed25519', data: other.signHex(m) }),
    (m) => ({ type: 'ed25519', data: wallet.signHex(`prefix:${m}`) }),
    (m) => ({ type: 'ed25519', data: wallet.signBytes(createHash('sha256').update(m).digest()).toString('hex') }),
    (m) => ({ type: 'rsa', data: wallet.signHex(m) }),
    (m) => ({ type: 'ed25519', signature: wallet.signHex(m), address: other.address }),
    (m) => ({ type: 'ed25519', data: wallet.signHex(m), extra: 1 }),
    () => 'ab'.repeat(63),
  ];
  for (const response of responses) {
    const { adapter } = await setup({ wallet, signMessage: (m) => ({ success: true, data: response(m) }) });
    await adapter.connect(); for (const message of MESSAGE_VECTORS) assert.equal((await adapter.signMessage(message)).ok, false);
  }
  assert.equal(await verifyExact('bad', 'hello', wallet.signHex('hello')), false);
  const preconnect = await setup({ wallet }); assert.equal((await preconnect.adapter.signMessage(MESSAGE_VECTORS[0])).ok, false);
});

test('native vectors match the smallest self-transfer with the already-used nonce 1; bad coordinates stop before signing', () => {
  const from = createEphemeralWallet().address;
  assert.equal(PROBE_NONCE, 1); assert.equal(PROBE_MAX_BALANCE_OS, 10n * 1_000_000_000n);
  const options={from,to:from,encoding:'os-string',amountOs:'1',nonce:1,timestamp:1234};
  assert.deepEqual(native(from),buildNativeTransferPayload(options));
  assert.equal(native(from).content.data[1].args.length,2);
  for(const options of [{nonce:0},{nonce:2},{nonce:1.5},{nonce:-1},{timestamp:-1}]) assert.throws(()=>native(from,options));
});

test('P5 exact CREATE has derived address, current program name, artifact hashes, metadata and source fields', async () => {
  const from = createEphemeralWallet().address, tx = await storage(from), op = tx.content.data[1];
  assert.match(JSON.stringify(op.data), /^[\x20-\x7e]+$/);
  assert.equal(op.programName, logicalToStorageProgramName(op.metadata.logicalAddress));
  assert.equal(op.storageAddress, deriveStorageAddress(from, op.programName, 1));
  assert.equal(op.metadata.contentHash, contentHash(op.data));
  assert.equal(op.metadata.envelopeHash, await sha256(canonicalize(op.data)));
  const expected = buildStorageProgramCreatePayload({ from, storageAddress: op.storageAddress, programName: op.programName, logicalAddress: op.metadata.logicalAddress, signedListing: op.data, nonce: 1, timestamp: 1234 });
  expected.content.data[1].metadata = { ...op.metadata };
  expected.content.from_ed25519_address = from; expected.content.network = PROBE_NETWORK; expected.content.chainIdentity = PROBE_CHAIN_IDENTITY;
  assert.deepEqual(tx, expected);
});

test('P4/P5 exact signed transactions verify; nonce, fee, recipient, denomination and every other field mutation are findings', async () => {
  const wallet = createEphemeralWallet(), { adapter } = await setup({ wallet }); await adapter.connect();
  for (const tx of [native(wallet.address), await storage(wallet.address)]) {
    assert.equal((await adapter.signTransaction(tx)).ok, true);
    const mutations = [
      (s) => { s.content.nonce++; }, (s) => { s.content.transaction_fee.network_fee = 1; },
      (s) => { s.content.to = createEphemeralWallet().address; }, (s) => { s.content.amount = '2'; },
      (s) => { s.content.data[1].unexpected = 'unknown'; }, (s) => { s.content.timestamp++; },
      (s) => { s.status = 'accepted'; }, (s) => { s.blockNumber = 9; }, (s) => { s.extra = true; },
      (s) => { delete s.content.from; }, (s) => { s.content.from_ed25519_address = createEphemeralWallet().address; },
    ];
    for (const mutate of mutations) {
      const changed = signedTransaction(wallet, tx, mutate), result = await checkSignedTransaction(tx, changed, wallet.address);
      assert.equal(result.ok, false); assert.ok(result.diffs.length > 0); assert.equal(result.hashValid, true); assert.equal(result.signatureValid, true);
    }
  }
  await assert.rejects(adapter.signTransaction(native(createEphemeralWallet().address)), /connected_account_required/);
});

test('P4/P5 reject bad hash, signature, account, algorithm, missing fields and content serialization changes', async () => {
  const wallet = createEphemeralWallet(), tx = native(wallet.address);
  const mutations = [
    (s) => { s.hash = 'a'.repeat(64); }, (s) => { s.signature.data = createEphemeralWallet().signHex(s.hash); },
    (s) => { s.signature.type = 'rsa'; }, (s) => { s.signature.extra = true; }, (s) => { s.signature.data = 'bad'; },
    (s) => { delete s.hash; }, (s) => { delete s.signature; }, (s) => { s.content = Object.fromEntries(Object.entries(s.content).reverse()); s.hash = createHash('sha256').update(JSON.stringify(s.content)).digest('hex'); s.signature.data = wallet.signHex(s.hash); },
  ];
  for (const mutate of mutations) { const signed = signedTransaction(wallet, tx); mutate(signed); assert.equal((await checkSignedTransaction(tx, signed, wallet.address)).ok, false); }
  const wrongHash = signedTransaction(wallet, tx); wrongHash.hash = 'a'.repeat(64);
  assert.equal((await checkSignedTransaction(tx, wrongHash, wallet.address)).hashValid, false);
});

test('adapter surface is frozen, has no generic request or send method, provider calls are strictly sign-only', async () => {
  const { adapter, calls, win } = await setup();
  assert.deepEqual(Object.keys(adapter).sort(), ['accounts', 'connect', 'discover', 'observeUi', 'openPopup', 'report', 'signMessage', 'signTransaction'].sort());
  assert.equal(Object.isFrozen(adapter), true);
  const address = (await adapter.connect()).address;
  await adapter.accounts(); await adapter.signMessage(MESSAGE_VECTORS[0]); await adapter.signTransaction(native(address));
  await adapter.signTransaction(await storage(address));
  adapter.openPopup(); assert.throws(() => adapter.openPopup(), /popup_already_requested/);
  assert.deepEqual(win.posts, [{ type: 'openpopup' }]);
  assert.deepEqual(calls.map((c) => c.method), ['connect', 'accounts', 'sign', 'accounts', 'signTransaction', 'accounts', 'signTransaction']);
  const source = readFileSync(new URL('../public/wallet-extension-probe/adapter.mjs', import.meta.url), 'utf8');
  assert.match(source, /const REQUEST_METHODS = Object.freeze\(\['connect', 'sign', 'signTransaction'\]\)/);
});

test('timeouts fence the session and never retry signing, including after a late response', async () => {
  for (const method of ['sign', 'signTransaction']) {
    let resolve;
    const pending = new Promise((r) => { resolve = r; });
    const options = method === 'sign' ? { signMessage: () => pending } : { signTransaction: () => pending };
    const { adapter, calls, wallet } = await setup(options, { requestTimeoutMs: 5 }); await adapter.connect();
    const tx = native(wallet.address);
    await assert.rejects(method === 'sign' ? adapter.signMessage(MESSAGE_VECTORS[0]) : adapter.signTransaction(tx), /timeout/);
    resolve({ success: true, data: method === 'sign' ? wallet.signHex(MESSAGE_VECTORS[0]) : signedTransaction(wallet, tx) });
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(adapter.signMessage(MESSAGE_VECTORS[0]), /session_fenced/);
    await assert.rejects(adapter.signTransaction(tx), /session_fenced/);
    await assert.rejects(adapter.discover(), /session_fenced/);
    assert.equal(calls.filter((c) => c.method === method).length, 1);
    assert.equal(adapter.report().records.filter((r) => r.code === 'timeout').length, 1);
    const r=adapter.report().records.find((r)=>r.code==='timeout');
    if(method==='sign') assert.deepEqual(r.request.params,[MESSAGE_VECTORS[0]]);
    else assert.equal(Object.hasOwn(r,'request'),false);
  }
});

test('provider cannot mutate retained requests; concurrent approvals and non-JSON responses fail closed', async () => {
  const wallet = createEphemeralWallet(); let release;
  const { adapter, calls } = await setup({ wallet, signTransaction: (tx) => { tx.content.nonce++; return { success: true, data: signedTransaction(wallet, tx) }; }, signMessage: () => new Promise((r) => { release = r; }) }, { requestTimeoutMs: 50 });
  await adapter.connect(); const result = await adapter.signTransaction(native(wallet.address));
  assert.equal(result.ok, false); assert.equal(result.diffs.find((d) => d.path === '$.content.nonce').kind, 'changed');
  assert.equal(adapter.report().records.find((r) => r.method === 'signTransaction').requestedHash, await sha256(JSON.stringify(native(wallet.address).content)));
  const signing = adapter.signMessage(MESSAGE_VECTORS[0]); await new Promise((r) => setImmediate(r));
  await assert.rejects(adapter.signMessage(MESSAGE_VECTORS[1]), /session_fenced/);
  release({ success: false }); await assert.rejects(signing, /denied_or_locked/);
  assert.equal(calls.filter((c) => c.method === 'sign').length, 1);
  const messageMutation=await setup({onRequest:(r)=>{if(r.method==='sign') r.params[0]='altered vector';}});
  await messageMutation.adapter.connect();await messageMutation.adapter.signMessage(MESSAGE_VECTORS[0]);
  assert.equal(messageMutation.adapter.report().records.find((r)=>r.method==='sign').request.params[0],MESSAGE_VECTORS[0]);
  let getterCalls = 0; const bad = { get success() { getterCalls++; return true; } };
  const hostile = await setup({ connectResponse: bad }); await assert.rejects(hostile.adapter.connect(), /response_not_json/); assert.equal(getterCalls, 0);
  let deep = true; for (let i = 0; i < 22; i++) deep = { nested: deep };
  for (const v of [NaN, undefined, () => {}, new Date(), 'x'.repeat(65537), { [Symbol('x')]: true }, Array(2), Object.defineProperty({}, 'secret', { value: 'x' }), deep, Array(4097).fill(true)]) assert.throws(() => jsonCopy(v));
});

test('caller mutation after a signing handoff cannot change the retained requested transaction', async () => {
  const { adapter, wallet } = await setup(); await adapter.connect();
  const tx = native(wallet.address), pending = adapter.signTransaction(tx); tx.content.nonce++;
  assert.equal((await pending).ok, true);
  assert.equal(adapter.report().records.find((r) => r.method === 'signTransaction').requestedHash, await sha256(JSON.stringify(native(wallet.address).content)));
});

test('public report omits arbitrary response fields, error strings and secrets; report copies cannot alter memory', async () => {
  const privateCanary = 'do not retain this arbitrary private string', wallet = createEphemeralWallet();
  const { adapter } = await setup({ wallet, signTransaction: (tx) => ({ success: true, data: signedTransaction(wallet, tx, (s) => { s.content.data[1].privateMaterial = privateCanary; s.content.to = privateCanary; }) }) });
  const connected = await adapter.connect(); connected.address = privateCanary;
  const findings = await adapter.signTransaction(native(wallet.address)); assert.equal(findings.ok, false); findings.diffs.length = 0;
  const report = adapter.report(); assert.ok(!JSON.stringify(report).includes(privateCanary)); assert.ok(!JSON.stringify(report).includes('privateMaterial'));
  assert.ok(report.records.find((r) => r.probe === 'P4').diffs.length > 0);
  assert.ok(report.records.find((r)=>r.probe==='P4').diffs.every((d)=>Object.keys(d).length===2));
  report.records.length = 0; assert.ok(adapter.report().records.length > 0);
  const denied = await setup({ connectResponse: { success: false, error: { message: privateCanary, details: { mnemonic: privateCanary } } } });
  await assert.rejects(denied.adapter.connect()); assert.ok(!JSON.stringify(denied.adapter.report()).includes(privateCanary));
  for (const secretShaped of ['a'.repeat(64), 'b'.repeat(128), 'x'.repeat(86)]) {
    const unexpected = await setup({ connectResponse: { success: false, error: { message: secretShaped, details: { token: secretShaped } } } });
    await assert.rejects(unexpected.adapter.connect()); assert.ok(!JSON.stringify(unexpected.adapter.report()).includes(secretShaped));
  }
  const signatureShaped = await setup({ wallet, signTransaction: (tx) => ({ success: true, data: signedTransaction(wallet, tx, (s) => { s.content.extra = { type: 'ed25519', data: 'b'.repeat(128) }; }) }) });
  await signatureShaped.adapter.connect(); assert.equal((await signatureShaped.adapter.signTransaction(native(wallet.address))).ok, false);
  assert.ok(!JSON.stringify(signatureShaped.adapter.report()).includes('b'.repeat(128)));
});

test('probe DOM requires explicit transaction opt-in, renders untrusted data as text, and copies only local JSON', async () => {
  const dom = installProbeDom(); let copied;
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    const fake = await setup();
    mountProbe(dom.root, { adapter: fake.adapter, clipboard: { writeText: async (v) => { copied = v; } } });
    assert.equal(fake.calls.length, 0, 'mount has no provider calls');
    await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
    await dom.button('P4 Sign native transfer only').click(); await dom.button('P5 Sign storage CREATE only').click();
    assert.ok(!fake.calls.some((c) => c.method === 'signTransaction'));
    dom.nodes().find((n) => n.attributes.type === 'checkbox').checked = true;
    await dom.button('P4 Sign native transfer only').click(); await dom.button('P5 Sign storage CREATE only').click();
    await dom.button('P3 Sign vector 1').click(); await dom.button('P8 Request raw openpopup once').click();
    await dom.button('Record UI observation').click(); await dom.button('Copy JSON report').click();
    assert.deepEqual(JSON.parse(copied), JSON.parse(JSON.stringify(fake.adapter.report())));
    assert.equal(fake.calls.filter((c) => c.method === 'signTransaction').length, 2);
    const maliciousText = '<img src=x onerror=alert(1)>';
    const stub = { ...fake.adapter, connect: async () => ({ address: fake.wallet.address, finding: maliciousText }) };
    mountProbe(dom.root, { adapter: stub, clipboard: { writeText: async () => {} } });
    await dom.button('P2 / P8 Connect (approve or deny in wallet)').click(); assert.ok(dom.root.textContent.includes(maliciousText));
    assert.throws(() => fake.adapter.observeUi(maliciousText), /invalid_observation/);
    for (const file of ['main.mjs', 'adapter.mjs']) assert.doesNotMatch(readFileSync(new URL(`../public/wallet-extension-probe/${file}`, import.meta.url), 'utf8'), /\b(?:XMLHttpRequest|localStorage|sessionStorage)\b/);
  } finally { dom.restore(); }
});


test('transaction probes refuse unused, next or future nonces and require a fresh readable account nonce', async () => {
  for (const current of [0, 7]) {
    const { adapter, wallet, calls } = await setup({}, { readAccount: async () => ({ currentNonce: current, balanceOs: '1' }) }); await adapter.connect();
    for (const nonce of current === 0 ? [PROBE_NONCE] : [0, current+1, current+2]) {
      const tx = native(wallet.address); tx.content.nonce = nonce;
      await assert.rejects(adapter.signTransaction(tx));
    }
    assert.equal(calls.filter((c)=>c.method==='signTransaction').length,0);
  }
  const account=(currentNonce)=>async()=>({currentNonce,balanceOs:'1'});
  for(const readAccount of [async()=>{throw new Error('unavailable');},async()=>null,async()=>7,account(-1),account(1.5),account(Number.MAX_SAFE_INTEGER),account('7')]) {
    const {adapter,wallet,calls}=await setup({}, {readAccount});await adapter.connect();
    await assert.rejects(adapter.signTransaction(native(wallet.address)));assert.equal(calls.filter((c)=>c.method==='signTransaction').length,0);
  }
});
test('transaction records and clipboard never retain signed transactions or signatures, including mutated responses', async () => {
  const dom=installProbeDom();let copied;
  try {
    for(const mutate of [()=>{},(s)=>{s.content.nonce++;}]) {
      let signature;
      const fake=await setup({signTransaction:(tx)=>{const signed=signedTransaction(fake.wallet,tx,mutate);signature=signed.signature.data;return {success:true,data:signed};}});
      const {mountProbe}=await import('../public/wallet-extension-probe/main.mjs');
      mountProbe(dom.root,{adapter:fake.adapter,clipboard:{writeText:async(v)=>{copied=v;}}});
      await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
      dom.nodes().find((n)=>n.attributes.type==='checkbox').checked=true;
      await dom.button('P4 Sign native transfer only').click();
      assert.ok(signature,'provider signed the probe');
      await dom.button('Copy JSON report').click();
      assert.ok(!copied.includes(signature),'clipboard must not include spendable signature');
      const r=fake.adapter.report().records.find((r)=>r.method==='signTransaction');
      assert.ok(!Object.hasOwn(r,'response'));assert.ok(!Object.hasOwn(r,'request'));
      assert.ok(!JSON.stringify(fake.adapter.report()).includes(signature));
    }
  } finally {dom.restore();}
});
test('transaction shape allowlist refuses identity, token and arbitrary storage before provider signing', async () => {
  const {adapter,wallet,calls}=await setup();await adapter.connect();
  const base=native(wallet.address);
  const create=await storage(wallet.address);
  const invalid=[{...base,content:{...base.content,type:'identityWrite'}},{...base,content:{...base.content,type:'token'}},
    {...base,content:{...base.content,data:['native',{nativeOperation:'send',args:[wallet.address,base.content.amount,'extra']}]}}];
  for(const change of [(t)=>{t.content.data[1].operation='DELETE_STORAGE_PROGRAM';},(t)=>{t.content.data[1].data.statement='arbitrary authorization';},(t)=>{t.content.data[1].extra=true;},(t)=>{t.extra=true;}]) {const t=structuredClone(create);change(t);invalid.push(t);}
  for(const tx of invalid) await assert.rejects(adapter.signTransaction(tx));
  assert.equal(calls.filter((c)=>c.method==='signTransaction').length,0);
  const identity=structuredClone(base);identity.content.type='identityWrite';
  await assert.rejects(checkSignedTransaction(identity,signedTransaction(wallet,identity),wallet.address));
});

test('both transaction probes always sign the already-used nonce 1 after a fresh account read', async () => {
  const reads=[], {adapter,wallet,calls}=await setup({}, {readAccount:async(address)=>{reads.push(address);return {currentNonce:reads.length,balanceOs:'1'};}});
  await adapter.connect();
  for(const tx of [native(wallet.address),await storage(wallet.address)]) assert.equal((await adapter.signTransaction(tx)).ok,true);
  const signed=calls.filter((c)=>c.method==='signTransaction');
  assert.deepEqual(reads,[wallet.address,wallet.address]);
  for(const [i,c] of signed.entries()) {assert.equal(c.params[0].content.nonce,PROBE_NONCE);assert.ok(c.params[0].content.nonce<=i+1);}
  assert.equal(signed[0].params[0].content.to,wallet.address);assert.equal(signed[0].params[0].content.amount,'1');
});
test('default nonce read is owner-session same-origin, bounded, account-bound and fail-closed', async () => {
  const original=globalThis.fetch;
  try {
    const fake=fakeExtension(),adapter=createExtensionProbeAdapter({windowObject:fakeWindow(fake.provider)});
    await adapter.discover();await adapter.connect();
    const good={address:fake.wallet.address,currentNonce:1,nextNonce:2,balanceOs:'10000000000'};
    const {balanceOs:_,...noBalance}=good;
    for(const body of [{...good,address:createEphemeralWallet().address},{...good,nextNonce:3},{...good,extra:1},noBalance,{...good,balanceOs:'10000000001'},{...good,currentNonce:0,nextNonce:1},{...good,currentNonce:-1,nextNonce:0},{...good,currentNonce:1.5,nextNonce:2.5}]) {
      globalThis.fetch=async()=>({ok:true,json:async()=>body});await assert.rejects(adapter.signTransaction(native(fake.wallet.address)));
    }
    globalThis.fetch=async()=>({ok:false});await assert.rejects(adapter.signTransaction(native(fake.wallet.address)));
    assert.equal(fake.calls.filter((c)=>c.method==='signTransaction').length,0);
    globalThis.fetch=async(url,options)=>{assert.equal(url,`/portal/wallet-extension-probe/nonce/${fake.wallet.address}`);assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);return {ok:true,json:async()=>good};};
    assert.equal((await adapter.signTransaction(native(fake.wallet.address))).ok,true);
  } finally {globalThis.fetch=original;}
});

// an earlier review. A wallet that treats nonce zero as unset (`nonce ||= 1`) or rewrites
// to the next nonce turns a request into a spendable signature, so prevention
// must hold before the provider is asked. These go through the page buttons, so
// they exercise exactly the vectors an owner would sign. `readNonce` is the
// pre-an earlier review option name; passing it too lets these reproduce against HEAD.
async function clickTransactionProbes(account, options = {}) {
  const dom = installProbeDom();
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    const fake = await setup(options, { readNonce: async () => account.currentNonce, readAccount: async () => account });
    mountProbe(dom.root, { adapter: fake.adapter, clipboard: { writeText: async () => {} } });
    await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
    dom.nodes().find((n) => n.attributes.type === 'checkbox').checked = true;
    await dom.button('P4 Sign native transfer only').click(); await dom.button('P5 Sign storage CREATE only').click();
    return fake;
  } finally { dom.restore(); }
}
test('a nonce-normalizing wallet is never asked to sign while the account has no used positive nonce', async () => {
  const wallet = createEphemeralWallet(), signedNonces = [];
  const normalizing = (tx) => { tx.content.nonce ||= 1; signedNonces.push(tx.content.nonce); return { success: true, data: signedTransaction(wallet, tx) }; };
  const fake = await clickTransactionProbes({ currentNonce: 0, balanceOs: '1' }, { wallet, signTransaction: normalizing });
  assert.deepEqual(signedNonces, [], 'no next-nonce signature may exist for a nonce-0 account');
  assert.equal(fake.calls.filter((c) => c.method === 'signTransaction').length, 0);
});
test('transaction probes request only an already-used positive nonce and the one-OS self-transfer', async () => {
  for (const currentNonce of [1, 7]) {
    const fake = await clickTransactionProbes({ currentNonce, balanceOs: '10000000000' });
    const signed = fake.calls.filter((c) => c.method === 'signTransaction').map((c) => c.params[0].content);
    assert.equal(signed.length, 2);
    for (const content of signed) assert.ok(content.nonce >= 1 && content.nonce <= currentNonce, `nonce ${content.nonce} must already be used`);
    assert.equal(signed[0].to, fake.wallet.address); assert.equal(signed[0].amount, '1');
  }
});
test('balance cap refuses a non-throwaway or unreadable balance before signing', async () => {
  for (const balanceOs of ['10000000001', '1000000000000', '-1', '1.5', '01', '', 10, null, undefined]) {
    const fake = await clickTransactionProbes({ currentNonce: 7, balanceOs });
    assert.equal(fake.calls.filter((c) => c.method === 'signTransaction').length, 0, `balance ${balanceOs}`);
  }
});
const probeNonce = PROBE_NONCE;
test('concurrent transaction probes are fenced before the first await, while account reads are pending', async () => {
  const pending = [], hold = (value) => () => new Promise((resolve) => pending.push(() => resolve(value)));
  const { adapter, calls, wallet } = await setup({}, { readNonce: hold(7), readAccount: hold({ currentNonce: 7, balanceOs: '1' }) }); await adapter.connect();
  const tx = native(wallet.address, { nonce: probeNonce }), first = adapter.signTransaction(tx), second = adapter.signTransaction(structuredClone(tx));
  const settled = Promise.allSettled([first, second]);
  const waitForRead = async () => { for (let i = 0; i < 100 && !pending.length; i++) await new Promise((r) => setTimeout(r, 5)); };
  await waitForRead(); pending.shift()(); await Promise.allSettled([first]);
  await waitForRead(); while (pending.length) pending.shift()();
  const [a, b] = await settled;
  assert.equal(a.status, 'fulfilled', a.reason?.message); assert.equal(a.value.ok, true);
  assert.equal(b.status, 'rejected'); assert.match(b.reason.message, /session_fenced/);
  assert.equal(calls.filter((c) => c.method === 'signTransaction').length, 1, 'only one probe may reach signing');
});
test('the transaction reservation is held through signature verification', async (t) => {
  const { adapter, calls, wallet } = await setup({}, { readNonce: async () => 7, readAccount: async () => ({ currentNonce: 7, balanceOs: '1' }) }); await adapter.connect();
  const original = crypto.subtle.verify.bind(crypto.subtle); let entered, release;
  const inVerification = new Promise((r) => { entered = r; }), gate = new Promise((r) => { release = r; });
  t.mock.method(crypto.subtle, 'verify', async (...args) => { if (entered) { const e = entered; entered = null; e(); await gate; } return original(...args); });
  const signing = adapter.signTransaction(native(wallet.address, { nonce: probeNonce }));
  await inVerification;
  const during = await adapter.signMessage(MESSAGE_VECTORS[0]).then(() => 'signed', (e) => e.message);
  release();
  assert.equal((await signing).ok, true);
  assert.equal(during, 'session_fenced'); assert.equal(calls.filter((c) => c.method === 'sign').length, 0);
});

// an earlier review. The extension may switch its active account after connect; the SDK's
// sign() then signs as that account, whose nonce and balance were never read.
function switchingExtension(wallet, signer) {
  const log = [], state = { active: { code: 200, data: wallet.address }, holdAccounts: null };
  const provider = {
    accounts: async () => { log.push('accounts'); if (state.holdAccounts) await state.holdAccounts; if (state.active === 'throws') throw new Error('locked'); return state.active; },
    request: async (r) => {
      log.push(r.method);
      if (r.method === 'connect') return { success: true, data: { address: wallet.address } };
      if (r.method === 'sign') return { success: true, data: { type: 'ed25519', data: wallet.signHex(r.params[0]) } };
      const tx = r.params[0]; tx.content.from = signer.address; return { success: true, data: signedTransaction(signer, tx) };
    },
  };
  const adapter = createExtensionProbeAdapter({ windowObject: fakeWindow(provider), readAccount: async () => { log.push('read'); return { currentNonce: 7, balanceOs: '1' }; } });
  return { log, state, adapter };
}
test('an extension account switch between connect and signing is refused before the wallet is asked to sign', async () => {
  const wallet = createEphemeralWallet(), funded = createEphemeralWallet();
  for (const switched of [{ code: 200, data: funded.address }, { code: 401, data: null }, { code: 404, data: null }, { code: 401, data: wallet.address },
    { code: 200, data: wallet.address, extra: 1 }, { code: 200, data: 'bad' }, { code: 200, data: null }, { success: true, data: wallet.address }, 'throws']) {
    const { log, state, adapter } = switchingExtension(wallet, funded);
    await adapter.discover(); await adapter.connect(); state.active = switched;
    for (const tx of [native(wallet.address), await storage(wallet.address)]) await assert.rejects(adapter.signTransaction(tx), JSON.stringify(switched));
    assert.ok(!log.includes('signTransaction'), `wallet asked to sign after ${JSON.stringify(switched)}`);
  }
  const { log, state, adapter } = switchingExtension(wallet, funded);
  await adapter.discover(); await adapter.connect(); state.active = { code: 200, data: funded.address };
  await assert.rejects(adapter.signTransaction(native(wallet.address)), /connected_account_changed/);
  assert.deepEqual(log, ['connect', 'read', 'accounts']);
});
test('the account re-check runs inside the reservation, after the account read and right before signTransaction', async () => {
  const wallet = createEphemeralWallet(), { log, state, adapter } = switchingExtension(wallet, wallet);
  await adapter.discover(); await adapter.connect();
  state.active = { code: 200, data: wallet.address.toUpperCase().replace(/^0X/, '0x') };
  assert.equal((await adapter.signTransaction(native(wallet.address))).ok, true, 'same account in another letter case');
  assert.deepEqual(log, ['connect', 'read', 'accounts', 'signTransaction']);
  let release; state.holdAccounts = new Promise((r) => { release = r; });
  const signing = adapter.signTransaction(await storage(wallet.address));
  for (let i = 0; i < 100 && log.length < 6; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log.slice(4), ['read', 'accounts'], 'paused on the account re-check');
  await assert.rejects(adapter.signMessage(MESSAGE_VECTORS[0]), /session_fenced/);
  release(); assert.equal((await signing).ok, true);
  assert.deepEqual(log.slice(4), ['read', 'accounts', 'signTransaction']);
});

// The page states the remaining risk and needs an explicit click on a
// confirmation of the probe-key condition before P4 or P5 can run.
test('P4/P5 need an explicit click on a confirmation that states the probe-key condition and the residual risk', async () => {
  const dom = installProbeDom();
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    const fake = await setup();
    mountProbe(dom.root, { adapter: fake.adapter, clipboard: { writeText: async () => {} } });
    await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
    const boxes = dom.nodes().filter((n) => n.attributes.type === 'checkbox');
    assert.equal(boxes.length, 1);
    const confirmation = dom.nodes().find((n) => n.tag === 'label' && n.children.includes(boxes[0])).textContent;
    for (const condition of [/fresh key created only for this probe/, /at most 10 testnet DEM/, /used nowhere else/]) assert.match(confirmation, condition);
    const text = dom.root.textContent;
    for (const residual of [/P4 risks one admissible self-transfer plus fees/, /P5 risks a public storage-program create in the dacs3:agreement: namespace plus storage fees/,
      /honest, unmodified nonce-1 signature is also admissible on any network where this account's nonce is 0/, /switch(?:es)? accounts?/, /short race/, /deposit/]) assert.match(text, residual);
    await dom.button('P4 Sign native transfer only').click(); await dom.button('P5 Sign storage CREATE only').click();
    assert.equal(fake.calls.filter((c) => c.method === 'signTransaction').length, 0, 'no signing without the explicit confirmation');
    boxes[0].checked = true;
    await dom.button('P4 Sign native transfer only').click(); await dom.button('P5 Sign storage CREATE only').click();
    assert.equal(fake.calls.filter((c) => c.method === 'signTransaction').length, 2);
  } finally { dom.restore(); }
});

// The bundled SDK's sign() always sets gcr_edits, adds from_ed25519_address when
// absent and replaces the transaction_fee values, so an honest wallet's ok:false
// must read differently from a nonce, recipient or signer change. Real SDK
// output, post-fork: there both P4 and P5 are SDK-expected.
test('honest SDK signing diffs are reported apart from nonce, recipient and signer changes', async () => {
  const wallet = await createSdkWallet(), other = createEphemeralWallet();
  const summary = (reading, extra = {}) => ({ reading, nonceChanged: false, recipientChanged: false, signerChanged: false, amountChanged: false, ...extra });
  for (const tx of [native(wallet.address), await storage(wallet.address)]) {
    const check = async (mutate) => checkSignedTransaction(tx, signedTransaction(wallet, tx, mutate), wallet.address);
    const sdk = await honestSdk(wallet, tx, true);
    const exact = await check(() => {});
    assert.equal(exact.ok, true); assert.deepEqual(exact.diffSummary, summary('no-field-diffs', { sdkProfile: null, sdkExpected: 0, unexpected: 0 }));
    const honest = await check(sdk);
    assert.equal(honest.ok, false); assert.equal(honest.hashValid, true); assert.equal(honest.signatureValid, true); assert.equal(honest.hashMatchesRequested, false);
    assert.ok(honest.diffs.length >= 3);
    assert.deepEqual(honest.diffSummary, summary('sdk-expected-only', { sdkProfile: 'post-fork', sdkExpected: honest.diffs.length, unexpected: 0 }));
    const rewritten = await check((s) => { sdk(s); s.content.nonce = 8; });
    assert.equal(rewritten.diffSummary.reading, 'nonce-recipient-or-signer-changed'); assert.equal(rewritten.diffSummary.nonceChanged, true);
    const recipient = await check((s) => { sdk(s); if (s.content.type === 'native') s.content.data[1].args[0] = other.address; else s.content.data[1].storageAddress = `stor-${'1'.repeat(40)}`; });
    assert.equal(recipient.diffSummary.reading, 'nonce-recipient-or-signer-changed'); assert.equal(recipient.diffSummary.recipientChanged, true); assert.equal(recipient.diffSummary.nonceChanged, false);
    const to = await check((s) => { sdk(s); s.content.to = other.address; });
    assert.equal(to.diffSummary.recipientChanged, true);
    const signer = await check(await honestSdk(wallet, { ...tx, content: { ...tx.content, from_ed25519_address: other.address } }, true));
    assert.equal(signer.diffSummary.reading, 'nonce-recipient-or-signer-changed'); assert.equal(signer.diffSummary.signerChanged, true);
    for (const mutate of [(s) => { s.content.memo = 'x'; }, (s) => { s.content.transaction_fee.network_fee = '01'; }, (s) => { s.content.transaction_fee = 1; }, (s) => { delete s.content.transaction_fee.rpc_address; }, (s) => { s.content.amount = '2'; }]) {
      const unexpected = await check((s) => { sdk(s); mutate(s); });
      assert.equal(unexpected.diffSummary.reading, 'other-unexpected-diffs'); assert.ok(unexpected.diffSummary.unexpected > 0);
    }
  }
  const dom = installProbeDom();
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    const status = () => dom.nodes().find((n) => n.attributes.role === 'status').textContent;
    for (const [mutate, expected, reading] of [[() => {}, /not a nonce rewrite/, 'sdk-expected-only'],
      [(s) => { s.content.nonce = 8; }, /Finding: the wallet changed the nonce, recipient or signing account/, 'nonce-recipient-or-signer-changed']]) {
      const fake = await setup({ wallet, signTransaction: async (tx) => {
        const sdk = await honestSdk(wallet, tx, true);
        return { success: true, data: signedTransaction(wallet, tx, (s) => { sdk(s); mutate(s); }) };
      } });
      mountProbe(dom.root, { adapter: fake.adapter, clipboard: { writeText: async () => {} } });
      await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
      dom.nodes().find((n) => n.attributes.type === 'checkbox').checked = true;
      await dom.button('P4 Sign native transfer only').click();
      assert.match(status(), expected);
      assert.equal(fake.adapter.report().records.find((r) => r.probe === 'P4').diffSummary.reading, reading);
    }
  } finally { dom.restore(); }
});
