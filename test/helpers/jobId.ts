import { createHash } from "node:crypto";
/** Deterministic JID-1 identity for synthetic test jobs. */
export function testJobId(label: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = BigInt(`0x${createHash("sha256").update(label).digest("hex").slice(0, 32)}`);
  let result = "";
  for (let i = 0; i < 26; i++) {
    result = alphabet[Number(n & 31n)] + result;
    n >>= 5n;
  }
  return result;
}
