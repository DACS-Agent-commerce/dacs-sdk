import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { canonicalize } from "../../src/canonical/index.js";
import { DacsError } from "../../src/errors.js";

const STANDARD_REVISION = "4df6294b8d1cfc047af456d3d5ce84cd9b3b9983";
const VECTOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/standard-next/canonical-json-v0.1.json",
);
const VECTOR_FILE_SHA256 =
  "1e355678b6feddc5dc54611eb0f61e12b9707a1506a3da9e4f679ab9f796c941";

interface CanonicalJsonVector {
  name: string;
  operation: "canonicalize";
  input: unknown;
  expected: "pass" | "fail";
  canonicalUtf8Hex?: string;
  expectedErrorCode?: string;
  rule: string;
  note: string;
}

const vectorBytes = readFileSync(VECTOR_PATH);
const vectorSet = JSON.parse(vectorBytes.toString("utf8")) as {
  set: string;
  tier: string;
  count: number;
  hash: string;
  vectors: CanonicalJsonVector[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeTaggedInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTaggedInput);
  if (!isRecord(value)) return value;
  if (value["$dacsType"] === "binary64" && typeof value["hex"] === "string") {
    const bytes = Buffer.from(value["hex"], "hex");
    if (bytes.length !== 8) throw new Error("invalid binary64 vector encoding");
    return bytes.readDoubleBE(0);
  }
  if (value["$dacsType"] === "bigint" && typeof value["decimal"] === "string") {
    return BigInt(value["decimal"]);
  }
  if (
    value["$dacsType"] === "unicode-code-units" &&
    typeof value["hex"] === "string"
  ) {
    const encoded = value["hex"];
    if (encoded.length % 4 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
      throw new Error("invalid Unicode code-unit vector encoding");
    }
    const units = Array.from(
      { length: encoded.length / 4 },
      (_, index) => Number.parseInt(encoded.slice(index * 4, index * 4 + 4), 16),
    );
    return String.fromCharCode(...units);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, decodeTaggedInput(child)]),
  );
}

function errorCode(error: unknown): string {
  if (!(error instanceof DacsError)) return "UNTYPED-ERROR";
  if (/non-finite number/.test(error.message)) return "NON-FINITE-NUMBER";
  if (/outside IEEE-754 safe-integer range/.test(error.message)) {
    return "NUMBER-OUTSIDE-DACS-MAGNITUDE";
  }
  if (/bigint not allowed/.test(error.message)) return "UNSUPPORTED-NATIVE-TYPE";
  if (/unpaired UTF-16 surrogate/.test(error.message)) return "INVALID-UNICODE";
  return "UNCLASSIFIED-DACS-ERROR";
}

describe(`DACS canonical-json-v0.1 @ ${STANDARD_REVISION}`, () => {
  test("pins the exact merged candidate corpus", () => {
    expect(createHash("sha256").update(vectorBytes).digest("hex"))
      .toBe(VECTOR_FILE_SHA256);
    expect(vectorSet).toMatchObject({
      set: "canonical-json-v0.1",
      tier: "candidate",
      count: 25,
      hash: "ee91bf9e9f3d7915b528c0fe3edeac86d27962fc53af90dbaa25b1620d26c5a5",
    });
    expect(vectorSet.vectors).toHaveLength(vectorSet.count);
  });

  test.each(vectorSet.vectors)("$name", (vector) => {
    expect(vector.operation).toBe("canonicalize");
    const input = decodeTaggedInput(vector.input);
    if (vector.expected === "pass") {
      expect(Buffer.from(canonicalize(input), "utf8").toString("hex"))
        .toBe(vector.canonicalUtf8Hex);
      return;
    }
    let thrown: unknown;
    try {
      canonicalize(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DacsError);
    expect(errorCode(thrown)).toBe(vector.expectedErrorCode);
  });
});
