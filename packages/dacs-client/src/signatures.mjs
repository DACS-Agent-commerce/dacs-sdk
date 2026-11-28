// Demos wallet address and Ed25519 signature handling.
//
// Provenance: adapted from the Community DACS Directory wallet contract
// (community@074f040, reference-implementations/dacs-directory/src/components/useDemosWallet.ts,
// src/catalog/claimRef.ts, src/catalog/listingVerification.ts decodeSignature):
//  - a Demos address is "0x" + 64 lowercase hex, and those hex digits are the raw
//    Ed25519 public key; the DACS claim is "did:demos:agent:<64 hex>";
//  - provider.request({method:"sign", params:[{message, publicKey}]}) signs the raw
//    UTF-8 bytes of message (no prefix, no pre-hash) and returns hex (optionally
//    0x-prefixed, sometimes doubled "0x0x") or base64url of the 64-byte signature.
import { publicKeyFromRaw, ed25519Verify } from '@kynesyslabs/dacs';
import { WalletFormatError, normalizeDemosAddress } from './dacs/read-only-address.mjs';

export { WalletFormatError, normalizeDemosAddress, addressForClaim } from './dacs/read-only-address.mjs';

export function claimForAddress(address) {
  return `did:demos:agent:${normalizeDemosAddress(address).slice(2)}`;
}

export function decodeSignature(value) {
  if (typeof value !== 'string') throw new WalletFormatError('signature must be a string');
  const trimmed = value.trim();
  // Canonical base64url first: "0x"/"0X" are valid base64url characters, so a
  // genuine 86-character signature can start with them.
  if (/^[A-Za-z0-9_-]{86}$/.test(trimmed)) {
    const bytes = Buffer.from(trimmed, 'base64url');
    if (bytes.length === 64 && bytes.toString('base64url') === trimmed) return bytes;
  }
  const stripped = trimmed.replace(/^(0x)+/i, '');
  if (/^[0-9a-fA-F]{128}$/.test(stripped)) return Buffer.from(stripped, 'hex');
  if (/^[A-Za-z0-9_-]{86}$/.test(stripped)) {
    const bytes = Buffer.from(stripped, 'base64url');
    if (bytes.length === 64) return bytes;
  }
  throw new WalletFormatError('signature must be 64 bytes encoded as hex or base64url');
}

function publicKeyObject(address) {
  const raw = Buffer.from(normalizeDemosAddress(address).slice(2), 'hex');
  return publicKeyFromRaw(raw);
}

// Returns true only for a valid Ed25519 signature by `address` over the exact
// UTF-8 bytes of `message`. Malformed input returns false, never throws.
export function verifyDemosSignature({ address, message, signature }) {
  try {
    const sig = decodeSignature(signature);
    return ed25519Verify(Buffer.from(message, 'utf8'), sig, publicKeyObject(address));
  } catch {
    return false;
  }
}

export const canonicalSignature = value => decodeSignature(value).toString('base64url');
