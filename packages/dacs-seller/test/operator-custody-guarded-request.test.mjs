// The custody wallet's `request` goes through the real wallet session. A request
// carrying `authorize` is checked again after the operator approves it, and a
// refusal there signs nothing. The custody source is loaded with the real session
// (packages/dacs-client) and a stand-in for the Demos SDK that counts signatures.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateModule } from './helpers/private-module.mjs';

const ORIGIN = 'https://TEST.invalid';
const SESSION_URL = new URL('../../dacs-client/src/public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url);
const CLAIMS_URL = new URL('../src/dacs/demos-claims.mjs', import.meta.url);
const STATE_NAME = 'TEST_CUSTODY_GUARDED_REQUEST';
const HASH = 'a'.repeat(64);
const TRANSPORT = Object.freeze({
  profile: 'devnet-agreement',
  network: 'TEST-network',
  rpcUrl: `${ORIGIN}/portal/api/devnet-native-wallet-rpc`,
  bindingUrl: `${ORIGIN}/portal/api/devnet-native-wallet-binding`,
  transportBinding: {
    source: 'devnet-agreement-transport/v1',
    bindingVersion: 'dacs-demos-network-binding/v1',
    bindingId: HASH,
    network: 'TEST-network',
    chainIdentity: HASH,
    pinVersion: '1',
    endpoint: `${ORIGIN}/`,
    transportAuthority: 'TEST-authority',
  },
});

const demosRuntimeStandIn = `
import { createHash } from 'node:crypto';
const state = globalThis.${STATE_NAME};
export class Demos {
  newMnemonic() { state.generated += 1; return \`TEST mnemonic \${state.generated}\`; }
  async connectWallet(mnemonic) { this.mnemonic = mnemonic; this.keypair = { privateKey: new Uint8Array(32).fill(7) }; }
  getAddress() { return '0x' + createHash('sha256').update(this.mnemonic.toLowerCase()).digest('hex'); }
  disconnect() {}
  async signMessage() { state.signatures += 1; return { type: 'ed25519', data: '0'.repeat(128) }; }
}
export class Identities {}
export const validateMnemonic = (mnemonic) => /^test mnemonic \\d+$/i.test(mnemonic);
`;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const quoted = (value) => JSON.stringify(String(value));

let custody;
let directory;
before(async () => {
  globalThis[STATE_NAME] = { generated: 0, signatures: 0 };
  custody = await privateModule(new URL('../src/devnet-demo/operator-custody.mjs', import.meta.url), [], (source) => source
    .replace("'../../public/portal/embedded-wallet/sdk-provider.mjs'", quoted(SESSION_URL.href))
    .replace("'../wallet/demos-signature.mjs'", quoted(CLAIMS_URL.href))
    .replace("'../../public/portal/embedded-wallet/demos-runtime.mjs'", quoted(dataUrl(demosRuntimeStandIn))));
  directory = await mkdtemp(join(tmpdir(), 'custody-guarded-request-'));
  await custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
});
after(async () => {
  delete globalThis[STATE_NAME];
  await rm(directory, { recursive: true, force: true });
});

async function openSeller() {
  const opened = await custody.openTestWalletCustody({ directory, role: 'seller', publicOrigin: ORIGIN, transactionTransport: TRANSPORT, approve: async () => true });
  return opened.wallet;
}
const signMessage = { method: 'sign', params: ['TEST message'] };

test('the custody wallet built with a transport tells callers it checks authorization right before signing', async () => {
  assert.equal((await openSeller()).guardsSigning, true);
});

test('a request whose authorize refuses after the operator approved it signs nothing', async () => {
  const wallet = await openSeller();
  const before = globalThis[STATE_NAME].signatures;
  let checks = 0;
  const answer = await wallet.request(signMessage, { authorize: () => { checks += 1; return 'TEST withdrawn'; } });
  assert.equal(answer.success, false);
  assert.equal(checks, 1, 'authorize ran once, after the approval');
  assert.equal(globalThis[STATE_NAME].signatures, before, 'nothing was signed');
});

test('a request whose authorize allows it is signed', async () => {
  const wallet = await openSeller();
  const before = globalThis[STATE_NAME].signatures;
  const answer = await wallet.request(signMessage, { authorize: () => true });
  assert.equal(answer.success, true);
  assert.equal(globalThis[STATE_NAME].signatures, before + 1);
});
