import { describe, expect, test } from "vitest";

import { RawJsonAdmissionError } from "../src/canonical/rawJson.js";
import {
  CounterpartyError,
  DacsError,
  faultCategory,
  isDacsErrorCode,
  SubstrateError,
  TransientError,
  UnsupportedCapabilityError,
  type DacsErrorCode,
} from "../src/errors.js";
import { AnchorWaitError } from "../src/substrate/AnchorWaitError.js";
import type { AnchorAttemptReceipt } from "../src/substrate/SubstrateAdapter.js";
import { WireError } from "../src/wire/validate.js";

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

const failedReceipt: AnchorAttemptReceipt = {
  name: "test",
  state: "failed",
  attempts: { inclusionPolls: 0, visibilityReads: 0 },
  timings: { startedAt: 0, finishedAt: 1, elapsedMs: 1 },
};

describe("error codes", () => {
  test("an uncoded error has no own code property", () => {
    const error = new DacsError("x");
    expect(Object.hasOwn(error, "code")).toBe(false);
    expect("code" in error).toBe(false);
    expect(error.code).toBeUndefined();
  });

  test("a coded error keeps its catalog code and its category comes from the table", () => {
    const error = new DacsError("x", { code: "schema.invalid_field" });
    expect(error.code).toBe("schema.invalid_field");
    expect(error.category).toBe("permanent");
    expect(error.message).toBe("x");
  });

  test("a catalog code on a category class keeps the class category", () => {
    const options = { code: "schema.invalid_field" } as const;
    expect(new TransientError("x", options).category).toBe("transient");
    expect(new CounterpartyError("x", options).category).toBe("counterparty");
    expect(new SubstrateError("x", options).category).toBe("substrate");
    expect(new SubstrateError("x", options).code).toBe("schema.invalid_field");
  });

  test("a code and a cause are both kept", () => {
    const cause = new Error("underlying");
    const error = new SubstrateError("x", { code: "schema.invalid_field", cause });
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("schema.invalid_field");
  });

  test("an uncoded error keeps its cause and its explicit category", () => {
    const cause = new Error("underlying");
    const error = new DacsError("x", { cause, category: "substrate" });
    expect(error.cause).toBe(cause);
    expect(error.category).toBe("substrate");
    expect(error.code).toBeUndefined();
  });

  test("isDacsErrorCode refuses typos and inherited names", () => {
    expect(isDacsErrorCode("schema.invalid_field")).toBe(true);
    expect(isDacsErrorCode("schema.invalid_feild")).toBe(false);
    expect(isDacsErrorCode("toString")).toBe(false);
    expect(isDacsErrorCode("sdk.unclassified")).toBe(false);
    expect(isDacsErrorCode("")).toBe(false);
  });

  test("the constructors refuse a catalog typo at compile time", () => {
    // `npm run typecheck` is the check: an unused `@ts-expect-error` fails it.
    const construct = () => [
      // @ts-expect-error a typo in a catalog code is refused by the base constructor
      new DacsError("x", { code: "schema.invalid_feild" }),
      // @ts-expect-error and by the category classes
      new SubstrateError("x", { code: "schema.invalid_feild" }),
    ];
    expect(construct).toBeTypeOf("function");
  });

  test("a code narrows to a catalog code only through the guard", () => {
    const withoutGuard = (error: DacsError): DacsErrorCode | undefined =>
      // @ts-expect-error a subclass string is not a catalog code until the guard accepts it
      error.code;
    const withGuard = (error: DacsError): DacsErrorCode | undefined =>
      error.code !== undefined && isDacsErrorCode(error.code) ? error.code : undefined;
    expect(withGuard(new DacsError("x", { code: "schema.invalid_field" }))).toBe("schema.invalid_field");
    expect(withGuard(new WireError("bad_sig"))).toBeUndefined();
    expect(withGuard(new DacsError("x"))).toBeUndefined();
    expect(withoutGuard(new DacsError("x"))).toBeUndefined();
  });

  test("subclass-owned codes keep their names, values and categories", () => {
    const wire = new WireError("bad_sig", 401, "detail");
    expect(Object.hasOwn(wire, "code")).toBe(true);
    expect([wire.code, wire.status, wire.message, wire.category]).toEqual(["bad_sig", 401, "bad_sig: detail", "counterparty"]);
    expect(new WireError("seller_down", 503).category).toBe("transient");
    expect(new WireError("config_invalid", 500).category).toBe("permanent");

    const rawJson = new RawJsonAdmissionError("parse", "INVALID-JSON");
    expect([rawJson.code, rawJson.stage, rawJson.message, rawJson.category]).toEqual(["INVALID-JSON", "parse", "raw JSON parse: INVALID-JSON", "permanent"]);

    const anchor = new AnchorWaitError("timeout", "no inclusion", failedReceipt);
    expect([anchor.code, anchor.message, anchor.category]).toEqual(["timeout", "no inclusion", "substrate"]);
    expect(anchor.receipt).toBe(failedReceipt);
  });
});
