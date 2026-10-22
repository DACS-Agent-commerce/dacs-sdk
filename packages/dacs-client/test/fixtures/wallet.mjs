// Ephemeral Ed25519 test wallet (fresh key per instance, never persisted).
// SIMULATED: stands in for a Demos wallet extension in tests only.
import { generateKeyPairSync, sign } from 'node:crypto';

export function createEphemeralWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const address = `0x${raw.toString('hex')}`;
  return {
    address,
    claim: `did:demos:agent:${raw.toString('hex')}`,
    publicKeyRaw: Buffer.from(raw),
    // Signs the raw UTF-8 message, like provider.request({method:"sign"}).
    signHex: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')}`,
    signBytes: (bytes) => sign(null, Buffer.from(bytes), privateKey),
  };
}
