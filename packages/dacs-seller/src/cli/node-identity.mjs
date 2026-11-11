// The wallet identity seam `init` takes, backed by demosdk's own wallet in plain Node: it generates a 256-bit BIP-39
// mnemonic and derives the address and claim from one. It signs nothing, opens no network connection and loads no SQLite.
// demosdk loads on first use, so `--help` and usage errors do not pay for it; its one extensionless directory import
// needs `@kynesyslabs/dacs-node/demos-loader` registered before it loads.
import { validateMnemonic as isBip39Mnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { claimForAddress } from '../dacs/demos-claims.mjs';

const MNEMONIC_STRENGTH_BITS = 256;
const ED25519 = Object.freeze({ algorithm: 'ed25519' });

let loading = null;

async function loadDemos() {
  await import('@kynesyslabs/dacs-node/demos-loader');
  return (await import('@kynesyslabs/demosdk/websdk')).Demos;
}

const demosClass = () => (loading ??= loadDemos());

/** Returns true only for a string that is a BIP-39 mnemonic on the English wordlist with a valid checksum. */
export const validateMnemonic = value => typeof value === 'string' && isBip39Mnemonic(value, wordlist);

/** Returns a new 256-bit (24-word) BIP-39 mnemonic through demosdk's `newMnemonic`. Rejects if demosdk cannot be loaded. */
export async function generateWalletMnemonic() {
  const Demos = await demosClass();
  return new Demos().newMnemonic(MNEMONIC_STRENGTH_BITS);
}

/**
 * Derives `{ address, claim, privateKey }` from a mnemonic: the address is the Ed25519 public key demosdk reports (`0x` and
 * 64 lowercase hex), the claim is `did:demos:agent:<hex>`. Only a string that passes `validateMnemonic` reaches `connectWallet`,
 * which would otherwise take any other string as a passphrase and return another identity. The caller owns `privateKey`, a
 * fresh `Uint8Array`, and zero-fills it. Rejects `wallet_mnemonic_invalid` for any other input.
 */
export async function deriveWalletIdentity(mnemonic) {
  if (!validateMnemonic(mnemonic)) throw Object.assign(new Error('wallet_mnemonic_invalid'), { code: 'wallet_mnemonic_invalid' });
  const Demos = await demosClass();
  const wallet = new Demos();
  await wallet.connectWallet(mnemonic, ED25519);
  const address = String(wallet.getAddress()).toLowerCase();
  return { address, claim: claimForAddress(address), privateKey: Uint8Array.from(wallet.keypair.privateKey) };
}
