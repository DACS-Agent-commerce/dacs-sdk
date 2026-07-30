import { describe, expect, test } from "vitest";

import { classifyAnchorResolution } from "../../src/substrate/anchorResolution.js";

const OWNER = "0xWriter";

describe("classifyAnchorResolution (#70 — lookup failure is not absence)", () => {
  test("present: a candidate owned by the writer", () => {
    const r = classifyAnchorResolution(
      [{ address: "stor-1", owner: OWNER, error: false }],
      OWNER,
    );
    expect(r).toEqual({ status: "present", address: "stor-1" });
  });

  test("owner match is case/space-insensitive and returns that address", () => {
    const r = classifyAnchorResolution(
      [{ address: "stor-x", owner: "  0XWRITER ", error: false }],
      OWNER,
    );
    expect(r).toEqual({ status: "present", address: "stor-x" });
  });

  test("absent: candidates were readable but none is the writer's (name squatted)", () => {
    const r = classifyAnchorResolution(
      [{ address: "stor-2", owner: "0xSomeoneElse", error: false }],
      OWNER,
    );
    expect(r).toEqual({ status: "absent" });
  });

  test("absent: no candidates at all", () => {
    expect(classifyAnchorResolution([], OWNER)).toEqual({ status: "absent" });
  });

  test("INDETERMINATE: a candidate could not be read → never claim absence", () => {
    // The writer's own program could be the unreadable one — treating this as
    // absent would create a DUPLICATE on the write path (the #70 bug).
    const r = classifyAnchorResolution(
      [{ address: "stor-3", owner: null, error: true }],
      OWNER,
    );
    expect(r.status).toBe("indeterminate");
  });

  test("INDETERMINATE: duplicate writer-owned programs cannot be selected safely", () => {
    const r = classifyAnchorResolution(
      [
        { address: "stor-mine-1", owner: OWNER, error: false },
        { address: "stor-mine-2", owner: OWNER, error: false },
      ],
      OWNER,
    );
    expect(r.status).toBe("indeterminate");
  });

  test("INDETERMINATE: an owner match cannot hide another unreadable candidate", () => {
    const r = classifyAnchorResolution(
      [
        { address: "stor-err", owner: null, error: true },
        { address: "stor-mine", owner: OWNER, error: false },
      ],
      OWNER,
    );
    expect(r.status).toBe("indeterminate");
  });
});
