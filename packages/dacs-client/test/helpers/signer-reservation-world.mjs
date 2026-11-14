import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';

const { network, chainIdentity, pinVersion } = TP1_APPROVED_IDENTITY_RECORD;
export const pins = { network, chainIdentity, pinVersion };
const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';
const keyOf = fill => createPrivateKey({ key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, 'hex'), Buffer.alloc(32, fill)]), format: 'der', type: 'pkcs8' });
const addressOf = key => '0x' + Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('hex');
const seed = keyOf(2), otherSeed = keyOf(3);
export const signer = addressOf(seed);
export const otherSigner = addressOf(otherSeed);
export const digest = text => createHash('sha256').update(text).digest('hex');
export const recordKey = (address = signer) => `devnet/signer-reservation/${JSON.stringify([pins.network, pins.chainIdentity, address])}`;
export const args = (operationKey = 'TEST-evidence-a', address = signer) => ({ signer: address, operation: 'payment-evidence', operationKey, readChainNonce: async () => 0 });
export const options = journal => ({ journal, pins });
export const open = (path, mode = 'open', limits = {}) => openDurableWalletJournal({ path, mode, lockTimeoutMs: 0, ...limits });
/**
 * A signed projection whose hash, signer, nonce and signature satisfy the reservation's validation. `signature` replaces
 * the signature data, `signWith: 'other'` signs with another key, `program` pads the content to grow the projection.
 */
export function signed({ nonce = 1, address = signer, program = 'TEST-public-evidence', signature, signWith } = {}) {
  const content = { type: 'storageProgram', from: address, nonce, timestamp: 1793102400000, data: ['CREATE', { program }] };
  const hash = digest(JSON.stringify(content));
  const key = signWith === 'other' || address === otherSigner ? otherSeed : seed;
  const data = signature ?? sign(null, Buffer.from(hash), key).toString('hex');
  return { txHash: hash, inputDigest: digest('TEST-public-input'), projectionText: JSON.stringify({ content, hash, signature: { type: 'ed25519', data } }) };
}
