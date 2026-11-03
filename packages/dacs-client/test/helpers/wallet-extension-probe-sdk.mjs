// Real bundled SDK 4.0.16 sign() (public/portal/embedded-wallet/demos-runtime.mjs)
// for the probe tests, offline. Without a node fee quote the SDK derives its own
// fee from its edits. The fork mode selects its pre- or
// post-fork serializer, as a node's getNetworkInfo would. Nothing is broadcast.
import { createPrivateKey, sign } from 'node:crypto';

const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos } = await import('../../public/portal/embedded-wallet/demos-runtime.mjs');
for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
// A fresh SDK key per instance, with a Node signer for the same key, so tests
// can re-sign a mutated SDK result like createEphemeralWallet() does.
export async function createSdkWallet() {
  const demos = new Demos();
  const address = await demos.connectWallet(demos.newMnemonic(128), { algorithm: 'ed25519' });
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(demos.keypair.privateKey).subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  let postFork = false, networkParameters = null, queue = Promise.resolve();
  demos._getNetworkParametersCached = async () => networkParameters;
  demos._isPostForkCached = async () => postFork;
  return {
    address,
    signHex: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')}`,
    // One sign at a time, so concurrent calls cannot mix fork modes. An optional
    // node fee quote ({ networkFee, rpcFee } in DEM) replaces the derived fee.
    sdkSign(tx, fork, quote = null) {
      const run = queue.then(() => { postFork = fork; networkParameters = quote; return demos.sign(structuredClone(tx)); });
      queue = run.catch(() => {});
      return run;
    },
  };
}
// Replaces a signedTransaction() draft's content with the real SDK output.
export async function honestSdk(wallet, tx, postFork) {
  const { content } = await wallet.sdkSign(tx, postFork);
  return (s) => { s.content = structuredClone(content); };
}
