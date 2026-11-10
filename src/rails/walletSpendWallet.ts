const HEX_WALLET = /^(?:0[xX])?([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * The one spelling the wallet-spend authorities use for a wallet: `0x` and the
 * lowercase hex of an EVM (20-byte) or Demos (32-byte) address. The `0x` prefix
 * is optional on input and letter case does not matter.
 *
 * Returns `null` when the value is not such an address, including when it has
 * surrounding space. It never throws.
 */
export function canonicalWalletSpendWalletV1(wallet: unknown): string | null {
  if (typeof wallet !== "string") return null;
  const digits = HEX_WALLET.exec(wallet)?.[1];
  return digits === undefined ? null : `0x${digits.toLowerCase()}`;
}
