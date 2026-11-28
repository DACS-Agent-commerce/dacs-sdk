// Demos address ("0x" + 64 hex: the raw Ed25519 public key) and
// did:demos:agent claim parsing. Parsing needs no key and no signing.

const HEX64 = /^[0-9a-f]{64}$/;

/** Error for a malformed wallet address, claim or signature. */
export class WalletFormatError extends Error {}

/** Returns `value` as "0x" + 64 lowercase hex. Throws WalletFormatError for anything else. */
export function normalizeDemosAddress(value) {
  if (typeof value !== 'string') throw new WalletFormatError('wallet address must be a string');
  const trimmed = value.trim();
  const hex = trimmed.replace(/^0x/i, '');
  if (!HEX64.test(hex.toLowerCase()) || hex.length !== 64) {
    throw new WalletFormatError('wallet address must be 0x followed by 64 hex characters (an Ed25519 public key)');
  }
  return `0x${hex.toLowerCase()}`;
}

/** Returns the Demos address of a did:demos:agent claim. Throws WalletFormatError for any other claim. */
export function addressForClaim(claim) {
  // Only the leading "did" scheme is read case-insensitively; the method, "agent" and the key stay case-sensitive.
  const match = /^[dD][iI][dD]:demos:agent:([0-9a-f]{64})$/.exec(String(claim));
  if (!match) throw new WalletFormatError('claim must be did:demos:agent:<64 lowercase hex>');
  return `0x${match[1]}`;
}
