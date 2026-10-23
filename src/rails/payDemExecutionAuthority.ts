import { DacsError } from "../errors.js";

/**
 * Create an isolated authority for one native rail implementation. Capabilities
 * and record verdicts belong only to this instance; copies carry no authority.
 */
export function createPayDemExecutionAuthority() {
  const capabilities = new WeakSet<object>();
  const verdicts = new WeakSet<object>();
  return Object.freeze({
    register<T extends object>(value: T): T {
      capabilities.add(value);
      return Object.freeze(value);
    },
    assertCapability(value: object): void {
      if (!capabilities.has(value)) {
        throw new DacsError("pay-dem requires an SDK-owned record-verifying capability");
      }
    },
    attest<T extends object>(value: T): T {
      verdicts.add(value);
      return Object.freeze(value);
    },
    hasVerdict(value: unknown): boolean {
      return value !== null && typeof value === "object" && verdicts.has(value);
    },
  });
}
