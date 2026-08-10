import { describe, expect, it } from "vitest";

// #14: the injectable buyer-session core must be reachable from the PUBLIC
// barrel — not only via a deep `src/agent/runSessionCore.js` import past the
// package `exports` map. These imports resolving is itself the assertion.
import {
  runSessionCore,
  standardsParserEngine,
  standardsParserEngineCapabilities,
  type CompletenessCheck,
  type CompleteParserSpec,
  type SessionDeps,
} from "../../src/index.js";

describe("public core surface (#14)", () => {
  it("F1: runSessionCore is exported from the barrel", () => {
    expect(typeof runSessionCore).toBe("function");
  });

  it("F1: SessionDeps is exported (compile-time) so a custom substrate can be wired", () => {
    // Type-only use — if SessionDeps weren't exported this file wouldn't compile.
    const partial: Partial<SessionDeps> = { buyerId: "did:demos:buyer" };
    expect(partial.buyerId).toBe("did:demos:buyer");
  });

  it("#84: the standards ParserSpec engine and completeness model are public", () => {
    const completeness: CompletenessCheck = { kind: "content-length" };
    const spec: CompleteParserSpec = {
      format: "raw",
      matcher: "BLOCKED",
      completeness,
    };
    expect(typeof standardsParserEngine.evalPredicate).toBe("function");
    expect(standardsParserEngineCapabilities.regex).toBe("re2-wasm");
    expect(spec.completeness).toBe(completeness);
  });

  // NOTE (#48): `sessionAnchorName` is intentionally NOT part of the public
  // surface yet — its MVP address strings are not the normative §6.3.x schemes,
  // so exporting them as "the scheme a verifier reproduces" would mislead. It
  // stays internal until canonical addressing lands; no public-API test asserts
  // those strings as normative.
});
