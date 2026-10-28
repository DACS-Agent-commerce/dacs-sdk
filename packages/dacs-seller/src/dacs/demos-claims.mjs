// Demos claims, addresses and wallet signatures for the seller package. SDK
// code on the core's Ed25519 primitives; it keeps the contract the plugin's
// wallet helper gave the seller kit, so ported callers behave the same:
//  - a Demos address is "0x" + 64 hex digits, the raw Ed25519 public key
//    (read case-insensitively, written lower-case); the claim is
//    "did:demos:agent:" + those 64 lower-case digits;
//  - a wallet signs the raw UTF-8 bytes of a message and answers the 64-byte
//    signature as canonical base64url, or as hex behind any number of "0x"
//    prefixes, or as base64url behind them.
import { ed25519Verify, publicKeyFromRaw, isCanonicalBase64Url } from '@kynesyslabs/dacs';

// Only the `did` scheme is read without case; `demos:agent:` is case-sensitive
// (DACS-1 §6.3.1).
const CLAIM_PREFIX = /^[dD][iI][dD]:demos:agent:/;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export class DemosClaimFormatError extends Error {}

export function normalizeDemosAddress(value) {
  if (typeof value !== 'string') throw new DemosClaimFormatError('wallet address must be a string');
  const hex = value.trim().replace(/^0x/i, '').toLowerCase();
  if (!HEX64.test(hex)) throw new DemosClaimFormatError('wallet address must be 0x followed by 64 hex characters (an Ed25519 public key)');
  return `0x${hex}`;
}

export function claimForAddress(address) {
  return `did:demos:agent:${normalizeDemosAddress(address).slice(2)}`;
}

// The prefix is matched without case; the key digits must already be lower-case.
export function addressForClaim(claim) {
  const text = String(claim);
  const key = CLAIM_PREFIX.test(text) ? text.slice('did:demos:agent:'.length) : '';
  if (!HEX64.test(key)) throw new DemosClaimFormatError('claim must be did:demos:agent:<64 lowercase hex>');
  return `0x${key}`;
}

// CORE §B.7 SIG-6: conforming DACS verification never normalizes legacy
// wallet spellings. Both proposal admission and context Vet writes use this.
export function isCanonicalEd25519Signature(value) {
  return typeof value === 'string' && value.length === 86 && isCanonicalBase64Url(value);
}

export function decodeSignature(value) {
  if (typeof value !== 'string') throw new DemosClaimFormatError('signature must be a string');
  const text = value.trim();
  // Canonical base64url first: "0x" is valid base64url, so a genuine
  // signature may begin with it and must not lose those characters.
  if (BASE64URL_SIGNATURE.test(text)) {
    const bytes = Buffer.from(text, 'base64url');
    if (bytes.length === 64 && bytes.toString('base64url') === text) return bytes;
  }
  const unprefixed = text.replace(/^(?:0x)+/i, '');
  if (/^[0-9a-fA-F]{128}$/.test(unprefixed)) return Buffer.from(unprefixed, 'hex');
  if (BASE64URL_SIGNATURE.test(unprefixed)) {
    const bytes = Buffer.from(unprefixed, 'base64url');
    if (bytes.length === 64) return bytes;
  }
  throw new DemosClaimFormatError('signature must be 64 bytes encoded as hex or base64url');
}

// True only for a valid Ed25519 signature by `address` over the exact UTF-8
// bytes of `message`. Malformed input is false; this never throws.
export function verifyDemosSignature({ address, message, signature }) {
  try {
    const key = publicKeyFromRaw(Buffer.from(normalizeDemosAddress(address).slice(2), 'hex'));
    return ed25519Verify(Buffer.from(message, 'utf8'), decodeSignature(signature), key);
  } catch {
    return false;
  }
}
