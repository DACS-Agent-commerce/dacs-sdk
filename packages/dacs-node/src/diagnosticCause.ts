const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** Capture a bounded code only; never publish an exception's free-form text. */
export function diagnosticCauseCode(error: unknown): string {
  if (error === null || typeof error !== "object") return "unknown";
  try {
    for (const key of ["causeCode", "reasonCode"]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) return "unknown";
      const code: unknown = descriptor.value;
      if (code === undefined) continue;
      return typeof code === "string" && code.trim() === code && REASON_CODE_RE.test(code)
        ? code : "unknown";
    }
  } catch {
    // An uninspectable exception must not replace the original failure.
  }
  return "unknown";
}
