import { describe, expect, it } from "vitest";

// #14: the injectable buyer-session core must be reachable from the PUBLIC
// barrel — not only via a deep `src/agent/runSessionCore.js` import past the
// package `exports` map. These imports resolving is itself the assertion.
import {
  runSessionCore,
  sessionAnchorName,
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

  it("F2: sessionAnchorName lets a verifier rebuild the anchor-address scheme", () => {
    expect(sessionAnchorName.vet("j1")).toBe("dacs2:verifyrecord:j1");
    expect(sessionAnchorName.agreement("j1")).toBe("dacs3:agreement:j1");
    expect(sessionAnchorName.evidence("j1")).toBe("dacs4:evidence:j1");
    expect(sessionAnchorName.bundle("j1")).toBe("dacs5:bundle:j1");
  });
});
