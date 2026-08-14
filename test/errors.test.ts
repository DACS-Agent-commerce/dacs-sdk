import { describe, expect, test } from "vitest";

import {
  CounterpartyError,
  DacsError,
  faultCategory,
  SubstrateError,
  TransientError,
  UnsupportedCapabilityError,
} from "../src/errors.js";

describe("fault classification (T9)", () => {
  test("each error class carries its category", () => {
    expect(new DacsError("x").category).toBe("permanent");
    expect(new TransientError("x").category).toBe("transient");
    expect(new CounterpartyError("x").category).toBe("counterparty");
    expect(new SubstrateError("x").category).toBe("substrate");
    expect(new UnsupportedCapabilityError("x").category).toBe("permanent");
  });

  test("category override on the base error", () => {
    expect(new DacsError("x", { category: "substrate" }).category).toBe("substrate");
  });

  test("faultCategory reads DacsError categories", () => {
    expect(faultCategory(new SubstrateError("down"))).toBe("substrate");
    expect(faultCategory(new CounterpartyError("bad"))).toBe("counterparty");
  });

  test("foreign errors default to transient (never blame a party)", () => {
    expect(faultCategory(new Error("ECONNRESET"))).toBe("transient");
    expect(faultCategory("oops")).toBe("transient");
  });

  test("subclasses remain instanceof DacsError", () => {
    expect(new SubstrateError("x") instanceof DacsError).toBe(true);
    expect(new UnsupportedCapabilityError("x") instanceof DacsError).toBe(true);
  });
});
