// Explicit ephemeral TEST authority. Fresh fixture material is generated here,
// shared in RAM with a separate fixture operator and the actual packaged seller
// wallet. Never recover/export/read browser private keys, or persist/log the
// fixture phrase/key. This is NOT a production noncustodial operator resolver.
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { createSdkWalletSession } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript:null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../../public/portal/embedded-wallet/demos-runtime.mjs');

export async function createEphemeralPackagedSeller({ rpcUrl, network, transactionTransport = null, approve = null }) {
  let phrase = new Demos().newMnemonic(256);
  const operator = new Demos();
  await operator.connectWallet(phrase,{algorithm:'ed25519'});
  const address = operator.getAddress().toLowerCase();
  // Only this separate, freshly fixture-generated operator's material; not
  // browser/session secrets. Node signer is needed by the unchanged synchronous
  // authenticated seller-store contract. Public signatures prove same actor.
  const bytes = Buffer.from(operator.keypair.privateKey);
  assert.ok(bytes.length >= 32);
  const key = createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),bytes.subarray(0,32)]),format:'der',type:'pkcs8'});
  bytes.fill(0);
  operator.disconnect();
  const signer = { address, claim:`did:demos:agent:${address.slice(2)}`, signBytes:(bytes)=>sign(null,Buffer.from(bytes),key), signHex:(message)=>`0x${sign(null,Buffer.from(message),key).toString('hex')}` };
  const approvals=[];
  let delegate;
  const wallet = createSdkWalletSession({DemosCtor:Demos,IdentitiesCtor:Identities,validateMnemonic,
    transactionTransport:transactionTransport ?? {profile:'simulated-loopback',network,rpcUrl},
    anchorJournal:{get:(k)=>delegate.get(k),put:(k,v)=>delegate.put(k,v),withWalletLock:(k,work)=>delegate.withWalletLock(k,work)},
    approve:async(r)=>{approvals.push(structuredClone(r));return approve ? approve(r) : true;} });
  await wallet.importMnemonic(phrase);phrase=null;
  assert.equal(wallet.getPublicAccount().address,address);
  return {signer,wallet,approvals,walletFactory:({anchorJournal})=>{delegate=anchorJournal;return wallet;},
    close:()=>wallet.lock(),authority:'ephemeral-fixture-shared-operator-and-packaged-seller-key; production-noncustodial-resolver-unproved'};
}
