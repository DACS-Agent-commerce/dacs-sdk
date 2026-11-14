import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createAuthorityFixture } from '../fixtures/tp1-authority-reader.mjs';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './purchase-admission-hook.mjs';
import { recordingApproval } from './payment-evidence-approval-double.mjs';
installPurchaseAdmissionHook();
export const { setPurchaseAdmission } = await loadAdmissionDouble();
export const api = await import('../../src/wallet/node-wallet-session.mjs');
const { openDurableWalletJournal } = await import('../../src/wallet/durable-journal.mjs');
const { buildNativeTransferPayload } = await import('../../src/dacs/wallet-transactions.mjs');
export const T0 = 1793102400000;
export const mnemonicBytes = () => new TextEncoder().encode(entropyToMnemonic(new Uint8Array(32).fill(3), wordlist));
export const ok = response => ({ result: 200, response, require_reply: false, extra: null });
export function scriptedNode() {
  const node = { calls: [], broadcasts: [], confirms: [], applied: new Map(), mode: 'accept', nonce: 0, intercept: null };
  node.fetch = async (url, init) => {
    const body = init.body === undefined ? null : JSON.parse(init.body), call = body?.params[0];
    const row = { url: String(url), body, headers: { ...init.headers }, redirect: init.redirect };
    node.calls.push(row);
    const intercepted = await node.intercept?.(row);
    if (intercepted) return intercepted;
    let answer;
    if (body === null) {
      // The storage program read: the program an applied storage CREATE made, or a 404.
      const address = new URL(url).pathname.split('/storage-program/')[1];
      const created = [...node.applied.values()].find(tx => tx.content.to === address && tx.content.data?.[0] === 'storageProgram');
      if (!created) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      const operation = created.content.data[1];
      answer = { success: true, data: operation.data, owner: created.content.from, programName: operation.programName };
    } else if (body.method === 'nodeCall') {
      const { message, data } = call;
      if (message === 'getBlockByNumber') answer = ok(data.blockNumber === 0
        ? { number: 0, status: 'confirmed', hash: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, content: {} }
        : { number: data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64), content: { previousHash: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, ordered_transactions: [...node.applied.keys()] } });
      else if (message === 'getAddressNonce') answer = ok(node.nonce);
      else if (message === 'getNetworkParameters') answer = ok({ networkFee: 1, rpcFee: 0, additionalFee: 0 });
      else if (message === 'getNetworkInfo') answer = ok({ forks: { osDenomination: { activated: true } } });
      else if (message === 'getTransactionStatus') answer = ok(node.applied.has(data.hash) ? { state: 'included', blockNumber: 1 } : { state: 'unknown' });
      else if (message === 'getTxByHash') answer = node.applied.has(data.hash) ? ok({ ...structuredClone(node.applied.get(data.hash)), status: 'confirmed', blockNumber: 1 }) : { result: 400, response: 'error' };
      else throw new Error('TEST-unscripted-node-read:' + message);
    } else if (call.extra === 'confirmTx') {
      node.confirms.push(structuredClone(call.data));
      if (node.mode === 'confirm-lost') throw new Error('TEST-confirm-lost');
      answer = ok({ data: { valid: node.mode !== 'confirm-refuse', message: 'TEST-insufficient-balance', gas_operation: null, transaction: call.data } });
    } else {
      assert.equal(call.extra, 'broadcastTx');
      const tx = call.data.response.data.transaction;
      node.broadcasts.push(structuredClone(tx));
      if (node.mode === '503') return new Response('TEST-unavailable', { status: 503 });
      if (['auth-refuse','auth-stale'].includes(node.mode)) answer = { result: 401, response: node.mode==='auth-stale'?'wallet_auth_stale':'wallet_auth_replayed' };
      else if (node.mode === 'refuse') answer = { result: 400, response: 'TEST-refused' };
      else {
        node.applied.set(tx.hash, structuredClone(tx)); node.nonce = tx.content.nonce;
        if (node.mode === 'drop') throw new Error('TEST-acknowledgement-lost');
        answer = ok({ message: 'TEST-accepted' });
      }
    }
    return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
  };
  return node;
}
export async function world(t, { held = false, journalWrap = x => x, ownerWrap = x => x, createSession = api.createNodeWalletSession, sessionOptions = {} } = {}) {
  setPurchaseAdmission(held ? 'held' : 'testnet-tp1');
  const dir = mkdtempSync(join(tmpdir(), 'node-wallet-session-')), path = join(dir, 'journal.sqlite');
  const node = scriptedNode(), authority = createAuthorityFixture(), key = mnemonicBytes();
  let journal, session;
  const owners = [], sessions = [];
  const clock = { now: () => T0 };
  async function start() {
    journal = openDurableWalletJournal({ path, mode: journal ? 'open' : 'create' });
    const owner = ownerWrap(api.createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl: node.fetch }));
    owners.push(owner);
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(), readAuthority: authority.read });
    const admission = { binding, currentLocal: owner.currentLocal };
    // A seller composition requires the host's proof that it owns the state directory and its payment-evidence approval ledger.
    const sellerInputs = createSession === api.createNodeSellerComposition
      ? { stateOwnership: { directory: dir, held: () => true }, paymentEvidenceApproval: recordingApproval() } : {};
    session = await createSession({ admission, owner, journal: journalWrap(journal), key: mnemonicBytes(), approve: async () => true, clock, ...sellerInputs, ...sessionOptions });
    sessions.push(session);
    return { owner, admission };
  }
  const initial = await start();
  t.after(async () => { setPurchaseAdmission('held'); for (const s of sessions) await s.close(); for (const o of owners) await o.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const address = session.wallet.getPublicAccount().address;
  const request = { method: 'sendTransaction', params: [buildNativeTransferPayload({ from: address, to: '0x' + '2'.repeat(64), amountOs: '2500000000', nonce: 1, timestamp: T0, encoding: 'os-string' })] };
  return { ...initial, path, node, authority, key, clock, request, get session() { return session; },
    send: () => session.wallet.request(request), journal: () => journal,
    lane: async () => (await journal.entries()).find(([k]) => k.startsWith('devnet/native-wallet/'))?.[1],
    restart: async () => { await session.close(); journal.close(); return start(); } };
}
export async function agreementRequest(w) {
  const { canonicalize, sha256Hex } = await import('@kynesyslabs/dacs');
  const { createPrivateKey, createPublicKey, sign } = await import('node:crypto');
  const { deriveStorageAddress } = await import('../../src/dacs/wallet-transactions.mjs');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), Buffer.alloc(32,2)]), format:'der', type:'pkcs8' });
  const seller = 'did:demos:agent:' + Buffer.from(createPublicKey(privateKey).export({format:'jwk'}).x,'base64url').toString('hex');
  const address = w.session.wallet.getPublicAccount().address, owner = 'did:demos:agent:' + address.slice(2);
  const jobId = '01M5YKPJG0248H248H248H248H', logicalAddress = 'dacs3:agreement:' + jobId;
  const scope = { payeeBoundAgreementVersion:'1', derivedFromPattern:'fixed-price', jobId,
    parties:[{role:'buyer',primaryClaim:owner},{role:'seller',primaryClaim:seller}],
    terms:{price:{currency:'DEM',amount:'1'},rail:{railId:'demos-native:DEM',railVersion:1},payoutBindings:[{payeeAddress:'0x'+seller.slice('did:demos:agent:'.length),phaseIndex:2,railId:'demos-native:DEM'}]} };
  const contentHash = sha256Hex(canonicalize(scope)), message = 'dacs-payee-bound-agreement:v1:' + contentHash;
  const signed = await w.session.wallet.request({method:'sign',params:[message]});
  assert.equal(signed.success,true,JSON.stringify(signed));
  const artifact = {...scope,signatures:[{party:owner,algorithm:'ed25519',value:Buffer.from(signed.data.signature,'hex').toString('base64url')},{party:seller,algorithm:'ed25519',value:sign(null,Buffer.from(message),privateKey).toString('base64url')}]};
  const envelopeHash=sha256Hex(canonicalize(artifact)), networkBinding=w.session.wallet.getWriteProfile().transportBinding;
  const nonce=w.node.nonce+1, programName=logicalAddress.replace(/:/g,'%3A'), storageAddress=deriveStorageAddress(address,programName,nonce,'');
  const op={operation:'CREATE_STORAGE_PROGRAM',programName,storageAddress,salt:'',encoding:'json',storageLocation:'onchain',acl:{mode:'public'},data:artifact,metadata:{logicalAddress,contentHash,envelopeHash,artifactKind:'Agreement',networkBinding}};
  const transaction={content:{type:'storageProgram',from:address,to:storageAddress,amount:0,data:['storageProgram',op],nonce,timestamp:T0,transaction_fee:{network_fee:0,rpc_fee:0,additional_fee:0,rpc_address:null},network:networkBinding.network,chainIdentity:networkBinding.chainIdentity},signature:null,hash:'',status:'',blockNumber:null};
  return {method:'sendTransaction',params:[{kind:'devnet-agreement-storage-create',profile:'devnet-agreement',network:networkBinding.network,owner,artifactKind:'Agreement',jobId,logicalAddress,contentHash,envelopeHash,transaction}]};
}
