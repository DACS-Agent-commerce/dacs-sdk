import { describe, expect, it } from "vitest";

import { DacsError } from "../../src/errors.js";
import { generateCanonicalJobId, requireCanonicalJobId } from "../../src/negotiate/jobId.js";

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("job id errors carry catalog codes", () => {
  it.each([
    [
      "a malformed id with the default label",
      () => requireCanonicalJobId("x"),
      "job.id_noncanonical",
      "jobId must be a canonical uppercase ULID",
    ],
    [
      "a malformed id with a given label",
      () => requireCanonicalJobId("x", "session id"),
      "job.id_noncanonical",
      "session id must be a canonical uppercase ULID",
    ],
    [
      "a negative timestamp",
      () => generateCanonicalJobId({ timestamp: -1 }),
      "job.id_timestamp_invalid",
      "ULID timestamp must be a 48-bit unix-ms integer",
    ],
    [
      "entropy of the wrong length",
      () => generateCanonicalJobId({ entropy: new Uint8Array(9) }),
      "job.id_entropy_invalid",
      "ULID entropy must contain exactly 10 bytes",
    ],
  ])("%s is refused with its code", (_name, call, code, message) => {
    const thrown = thrownBy(call);
    expect(thrown).toBeInstanceOf(DacsError);
    expect(thrown).toMatchObject({ code, category: "permanent", message, name: "DacsError" });
    expect(Object.keys(thrown as object).sort()).toEqual(["category", "code", "name"]);
  });
});
