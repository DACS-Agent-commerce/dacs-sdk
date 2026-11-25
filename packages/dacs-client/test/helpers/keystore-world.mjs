// The buyer's keystore wallet world. Keystores are written the way the wallet plugin's writer does: JSON.stringify(ks, null, 2) + '\n',
// base64 members, mode 0600, create only.
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, mnemonicBytes, scriptedNode } from './tp1-node-fixture.mjs';
import { finalizedWorld } from './finalized-node-world.mjs';
const { passContext } = await import('../../src/wallet/pass-context.mjs');
const { OWNER_AUTHORITY, OWNER_ENDPOINT } = await import('./queued-owner.mjs');

export const PASSPHRASE = 'TEST-keystore-passphrase';
export const PHRASE = new TextDecoder().decode(mnemonicBytes());
export const N_TEST = 2 ** 14;

export const scryptKey = (passphrase, salt, N) => scryptSync(passphrase.normalize('NFKC'), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 });

/** The plugin's encryptMnemonic, with `plaintext` encrypted as given (the plugin trims it first). */
export function keystoreOf(plaintext, { passphrase = PASSPHRASE, N = N_TEST, address } = {}) {
  const salt = randomBytes(32), iv = randomBytes(12), key = scryptKey(passphrase, salt, N);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: 1, kdf: 'scrypt', kdfparams: { N, r: 8, p: 1, salt: salt.toString('base64') }, cipher: 'aes-256-gcm',
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), ...(address ? { address } : {}) };
}

/** The plugin's writeKeystore: create only, mode 0600. */
function writeKeystore(path, ks) {
  writeFileSync(path, typeof ks === 'string' ? ks : JSON.stringify(ks, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}

export function keystoreDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keystore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  return { dir, file: (ks = keystoreOf(PHRASE)) => writeKeystore(join(dir, `ks-${n++}.json`), ks) };
}

// The fixture phrase's address, read once from a composition made the existing way.
let fixtureAddress;
export async function addressOfFixture(t) {
  if (!fixtureAddress) { const w = await finalizedWorld(t); await w.build(); fixtureAddress = w.session.wallet.getPublicAccount().address; await w.close(); }
  return fixtureAddress;
}
/** The fixture address once `addressOfFixture` has read it, else undefined. */
export const knownFixtureAddress = () => fixtureAddress;

/**
 * A finalized world whose session is composed by openKeystoreWalletSession over `keystorePath`, with a synchronous stop check. Its owner is
 * the exported transport owner over the world's scripted node (`passOwner`), because an effect pass needs a lease the composition's own owner made.
 */
export async function keystoreWorld(t, keystorePath, input = {}) {
  const expectedAddress = await addressOfFixture(t), node = scriptedNode();
  const passOwner = api.createNodeTransportOwner({ endpoint: OWNER_ENDPOINT, transportAuthority: OWNER_AUTHORITY, fetchImpl: node.fetch });
  const w = await finalizedWorld(t, { node, input: { owner: passOwner, keystorePath, passphrase: PASSPHRASE, expectedAddress, stopped: () => false, ...input },
    compose: options => api.openKeystoreWalletSession(Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'key'))) });
  t.after(() => passOwner.close());
  return Object.assign(w, { passOwner });
}

/** Counts the key signatures of the session's SDK instance (`inner`, source authentication included) and those made inside its SDK sign (`inSign`). */
export async function buildCountingSigns(t, w) {
  const { Demos } = await (await import('../../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
  const connect = Demos.prototype.connectWallet;
  let instance;
  t.mock.method(Demos.prototype, 'connectWallet', function spyConnect(...args) { instance = this; return Reflect.apply(connect, this, args); });
  await w.build();
  const sdkCrypto = Object.getPrototypeOf(instance.crypto), innerSign = sdkCrypto.sign, proto = Object.getPrototypeOf(instance), sign = proto.sign;
  const counts = { inner: 0, inSign: 0 };
  t.mock.method(sdkCrypto, 'sign', function spyInner(...args) { counts.inner += 1; return Reflect.apply(innerSign, this, args); });
  t.mock.method(proto, 'sign', async function spySign(...args) {
    const before = counts.inner;
    try { return await Reflect.apply(sign, this, args); } finally { counts.inSign += counts.inner - before; }
  });
  return counts;
}

/** Runs `work` in a plain effect pass (passContext(), no job class) on the owner's fence, with the pass fee ceiling `feeCeilingOs`. */
export async function inPlainPass(w, work, feeCeilingOs = '50000000000') {
  const lease = await w.passOwner.acquireConnectionFence();
  try {
    const handle = w.session.effectPass({ fence: lease, deadline: w.clock.now() + 5000, refreshAuthority: () => {}, finalStop: () => {},
      synchronousChecks: [], feeCeilingOs, context: passContext() });
    return await w.session.runInEffectPass(handle, work);
  } finally { lease.release(); }
}
