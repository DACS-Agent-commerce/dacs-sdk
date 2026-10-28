/**
 * Message for a caught value in a fail-closed diagnostic. Formatting must never
 * throw from a catch block: `instanceof` can hit a throwing Proxy trap, `message`
 * can be a throwing getter and string coercion can fail (a null-prototype
 * object), so any of those falls back to a fixed message.
 */
export function describeError(e: unknown): string {
  try {
    return String(e instanceof Error ? e.message : e);
  } catch {
    return "unknown error";
  }
}
