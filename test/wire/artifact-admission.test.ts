import { expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
  it("public raw JSON byte bounds, null artifacts and primitive shape predicates", () => {
    expect(wire.admitWireArtifact(Buffer.from("null"))).toBeNull();
  expect(() => wire.admitWireArtifact(Buffer.alloc(wire.DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes + 1))).toThrowError(expect.objectContaining({ code: "wire_artifact_rejected" }));
});
