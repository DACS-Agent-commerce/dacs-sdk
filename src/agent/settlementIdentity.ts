/** DACS-4 §9.5.8 SB-1 canonical event/instruction-level settlement identity. */

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_SOLANA_SIGNATURE_BASE58_LENGTH = 88;
const MAX_CANONICAL_SETTLEMENT_ID_LENGTH = 128;

/** True only when canonical Base58 decodes to exactly one 64-byte signature. */
function isCanonicalSolanaSignature(value: string): boolean {
  // A 64-byte value needs at most 88 Base58 digits. Bound attacker-controlled
  // input before the BigInt accumulation below so a persisted/provider-supplied
  // pseudo-signature cannot turn validation into unbounded CPU/memory work.
  if (
    value.length === 0 ||
    value.length > MAX_SOLANA_SIGNATURE_BASE58_LENGTH
  ) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let nonZeroBytes = 0;
  for (let cursor = decoded; cursor > 0n; cursor >>= 8n) nonZeroBytes += 1;
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === "1") {
    leadingZeroBytes += 1;
  }
  return leadingZeroBytes + nonZeroBytes === 64;
}

export function isCanonicalSettlementIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > MAX_CANONICAL_SETTLEMENT_ID_LENGTH) return false;
  if (/^demos:[0-9a-f]{64}$/.test(value)) return true;

  const evm = /^evm:([1-9][0-9]*):([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(
    value,
  );
  if (evm) {
    const chainId = Number(evm[1]);
    const logIndex = Number(evm[3]);
    return Number.isSafeInteger(chainId) && chainId > 0 &&
      Number.isSafeInteger(logIndex) && logIndex >= 0;
  }

  const solana = /^solana:(mainnet|devnet|testnet):([1-9A-HJ-NP-Za-km-z]+):(0|[1-9][0-9]*)$/.exec(
    value,
  );
  if (!solana || !isCanonicalSolanaSignature(solana[2]!)) return false;
  const instructionIndex = Number(solana[3]);
  return Number.isSafeInteger(instructionIndex) && instructionIndex >= 0;
}
