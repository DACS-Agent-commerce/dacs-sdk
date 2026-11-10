// Loads demosdk's websdk in plain Node for the client's Node wallet session. Internal: not a
// package export, and the root import never reaches it.
//
// Once per process it (1) imports `@kynesyslabs/dacs-node/demos-loader`, which registers the SDK's
// package-scoped resolver for demosdk's one extensionless directory import, (2) registers
// demos-quiet-hooks.mjs, which empties demosdk's reviewed diagnostic statements (see that file),
// (3) imports `@kynesyslabs/demosdk/websdk` and `@scure/bip39`, and (4) asks the hook thread which
// targets it transformed. Those two registrations are the only process-level effects.
//
// Host rule: build the composition (call `loadNodeDemos`) first, before any other import of `@kynesyslabs/demosdk/websdk`
// in the process. A module imported earlier never passes through the hook, so the load refuses
// `node_wallet_sdk_preloaded` rather than run with SDK output on.
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { OperationError } from '../client-errors.mjs';

const QUIET_TARGET_FILES = ['GCRGeneration.js', 'demosclass.js'];
const UNREVIEWED = 'node_wallet_sdk_unreviewed';
const PRELOADED = 'node_wallet_sdk_preloaded';

let loading = null;

function askTransformedTargets(port) {
  return new Promise(resolve => {
    port.once('message', resolve);
    port.postMessage('transformed');
  });
}

async function importWebsdk() {
  try {
    return await import('@kynesyslabs/demosdk/websdk');
  } catch (error) {
    if (error?.code !== UNREVIEWED) throw error;
    throw new OperationError(UNREVIEWED, 'the installed demosdk is not a reviewed version; nothing was loaded', undefined, { cause: error });
  }
}

async function loadReviewedDemos() {
  await import('@kynesyslabs/dacs-node/demos-loader');
  const targets = QUIET_TARGET_FILES.map(name => new URL(name, import.meta.resolve('@kynesyslabs/demosdk/websdk')).href);
  const { port1, port2 } = new MessageChannel();
  try {
    register('./demos-quiet-hooks.mjs', { parentURL: import.meta.url, data: { port: port2, targets }, transferList: [port2] });
    const { Demos } = await importWebsdk();
    const [{ validateMnemonic }, { wordlist }] = await Promise.all([import('@scure/bip39'), import('@scure/bip39/wordlists/english.js')]);
    const transformed = await askTransformedTargets(port1);
    if (!targets.every(url => transformed.includes(url))) {
      throw new OperationError(PRELOADED, 'a demosdk target module did not pass through the quiet transform: it was imported before the loading module, or the SDK layout changed; build the composition before any other import of demosdk');
    }
    return { Demos, validateMnemonic: mnemonic => typeof mnemonic === 'string' && validateMnemonic(mnemonic, wordlist) };
  } finally {
    port1.close();
  }
}

/**
 * Loads demosdk's websdk quietly and returns `{Demos, validateMnemonic}`: the SDK's `Demos` class
 * and a check that a value is a string and a valid BIP-39 mnemonic on the English wordlist. The
 * first call does the work; every later call returns the same promise, including a refusal.
 * Rejects with an `OperationError` coded `node_wallet_sdk_unreviewed` (the installed source is not
 * a reviewed version; the hook's error is the `cause`) or `node_wallet_sdk_preloaded` (a target
 * module did not pass through the transform: it was imported before this call, or the SDK's file
 * layout changed). Any other import failure is rethrown unchanged.
 */
export function loadNodeDemos() {
  loading ??= loadReviewedDemos();
  return loading;
}
