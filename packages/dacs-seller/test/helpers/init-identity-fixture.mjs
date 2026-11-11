// The identity seams `init` takes, as test doubles. Mnemonics are built at run
// time from a seed number, so no key-shaped literal is committed, and the
// double derives with node:crypto only because it stands in for the wallet.
import { createPrivateKey, createPublicKey } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const MNEMONIC_PATTERN = /^TEST mnemonic seed (\d{1,3})$/;
const SEED_BYTES = 32;

export const mnemonicFor = seed => `TEST mnemonic seed ${seed}`;

/** The identity the double derives for a seed number: { address, claim, privateKey } (privateKey is seed then public key). */
export function identityFor(seed) {
  const seedBytes = Buffer.alloc(SEED_BYTES, seed);
  const publicKey = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seedBytes]), format: 'der', type: 'pkcs8' }))
    .export({ format: 'der', type: 'spki' }).subarray(-SEED_BYTES);
  return { address: publicKey.toString('hex'), claim: `did:demos:agent:${publicKey.toString('hex')}`, privateKey: new Uint8Array(Buffer.concat([seedBytes, publicKey])) };
}

/** The three seams `runInit` takes. `generated` lists every mnemonic the double handed out. */
export function identityDouble(seed = 3) {
  const generated = [];
  return {
    generated,
    generateWalletMnemonic: async () => { generated.push(mnemonicFor(seed)); return mnemonicFor(seed); },
    validateMnemonic: value => typeof value === 'string' && MNEMONIC_PATTERN.test(value),
    deriveWalletIdentity: async mnemonic => {
      const match = MNEMONIC_PATTERN.exec(mnemonic);
      if (!match) throw Object.assign(new Error('wallet_mnemonic_invalid'), { code: 'wallet_mnemonic_invalid' });
      return identityFor(Number(match[1]));
    },
  };
}
