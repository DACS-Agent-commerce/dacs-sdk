import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/jcs.js";
import { RawJsonAdmissionError } from "../../src/canonical/rawJson.js";
import { DacsError, faultCategory } from "../../src/errors.js";
import * as wire from "../../src/wire/index.js";

interface RawVector {
  name: string;
  rawUtf8Text?: string;
  rawHex?: string;
  expected: "accept" | "reject";
  expectedErrorCode?: string;
  canonicalUtf8Hex?: string;
}
const { vectors } = JSON.parse(readFileSync(new URL(
  "../fixtures/standard-next/raw-json-profile-v0.1.json", import.meta.url,
), "utf8")) as { vectors: RawVector[] };
const admit = (bytes: Uint8Array, maxBytes = 65_536) => wire.admitWireJson(bytes, maxBytes, "bad_json");

function refusal(action: () => unknown): wire.WireError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(wire.WireError);
    return error as wire.WireError;
  }
  throw new Error("expected a wire refusal");
}

describe("wire CF-5 admission", () => {
  // Byte-exact Standard corpus; wire additionally refuses non-NFC string values.
  for (const vector of vectors) {
    it(vector.name, () => {
      const bytes = vector.rawHex === undefined
        ? Buffer.from(vector.rawUtf8Text ?? "", "utf8") : Buffer.from(vector.rawHex, "hex");
      if (vector.expected === "reject") {
        expect(refusal(() => admit(bytes))).toMatchObject({
          code: "bad_json", status: 400, detail: vector.expectedErrorCode,
          cause: { name: "RawJsonAdmissionError", code: vector.expectedErrorCode },
        });
      } else {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (JSON.stringify(parsed) !== JSON.stringify(JSON.parse(canonicalize(parsed)))) {
          // Member order is allowed; only normalized string values change meaning.
          const containsNfd = (value: unknown): boolean => typeof value === "string"
            ? value !== value.normalize("NFC")
            : value !== null && typeof value === "object" && Object.values(value).some(containsNfd);
          if (containsNfd(parsed)) {
            expect(refusal(() => admit(bytes))).toMatchObject({ detail: "WIRE-NON-NFC-STRING" });
            return;
          }
        }
        expect(Buffer.from(canonicalize(admit(bytes))).toString("hex")).toBe(vector.canonicalUtf8Hex);
      }
    });
  }

  it("enforces the byte budget on the exact received view", () => {
    const wrapped = Buffer.from("xnullx");
    expect(admit(wrapped.subarray(1, 5), 4)).toBeNull();
    expect(refusal(() => admit(wrapped.subarray(1, 5), 3))).toMatchObject({ detail: "BYTE-LIMIT-EXCEEDED" });
  });

  it("preserves the admission stage and original error", () => {
    const error = refusal(() => admit(Buffer.from('{"x":1,"x":2}')));
    expect(error.cause).toBeInstanceOf(RawJsonAdmissionError);
    expect(error.cause).toMatchObject({ stage: "profile", code: "DUPLICATE-MEMBER" });
  });

  it("only byte admission can grant the recursively frozen admission marker", () => {
    const value = admit(Buffer.from('{"child":[{"x":1}]}')) as { child: { x: number }[] };
    for (const item of [value, value.child, value.child[0]]) {
      expect(wire.isAdmittedValue(item)).toBe(true);
      expect(Object.isFrozen(item)).toBe(true);
    }
    expect(wire.isAdmittedValue({ child: [{ x: 1 }] })).toBe(false);
    expect(wire.isAdmittedValue(JSON.parse(JSON.stringify(value)))).toBe(false);
    expect(wire.isAdmittedValue(Object.freeze({ x: 1 }))).toBe(false);
    expect(wire.isAdmittedValue(null)).toBe(false);
    expect("sealAdmitted" in wire).toBe(false);
  });
});

it("deepFreeze traverses a shallow-frozen parent and arrays", () => {
  const child = { list: [{ value: 1 }] };
  const parent = Object.freeze({ child });
  expect(wire.deepFreeze(parent)).toBe(parent);
  expect(Object.isFrozen(child)).toBe(true);
  expect(Object.isFrozen(child.list)).toBe(true);
  expect(Object.isFrozen(child.list[0])).toBe(true);
});

it("ownership takes an independent normalized snapshot", () => {
  const input = { child: { text: "e\u0301" }, absent: undefined };
  const copy = wire.ownedConfig(input, "invalid");
  input.child.text = "changed";
  expect(copy).toEqual({ child: { text: "é" } });
  expect(wire.ownedArtifact(Object.freeze({ value: 1 }), "invalid")).toEqual({ value: 1 });
});

it.each([
  [() => wire.ownedConfig({ value: () => 0 }, "invalid"), 500],
  [() => wire.ownedArtifact({ value: undefined }, "invalid"), 401],
] as const)("ownership refusals preserve their snapshot cause (%#)", (action, status) => {
  const error = refusal(action);
  expect(error).toMatchObject({ code: "invalid", status });
  expect(error.cause).toBeInstanceOf(DacsError);
  expect((error.cause as Error).cause).toBeInstanceOf(TypeError);
});

it("refuses revoked Proxies as permanent local input faults", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const error = refusal(() => wire.ownedFields(proxy, ["field"]));
  expect(error).toMatchObject({ code: "wire_input_invalid", status: 500 });
  expect(faultCategory(error)).toBe("permanent");
});

it("rejects hostile options without invoking getters or Proxy traps", () => {
  const trap = () => { throw new Error("must not execute"); };
  for (const input of [new Proxy({}, { getPrototypeOf: trap }), { get field() { return trap(); } }, new Date(), []]) {
    expect(refusal(() => wire.ownedFields(input, ["field"]))).toMatchObject({ code: "wire_input_invalid" });
    if (!Array.isArray(input)) expect(wire.ownedOrNothing(input)).toBeUndefined();
  }
  expect(wire.ownedFields({ field: 1 }, ["field", "absent"])).toEqual({ field: 1, absent: undefined });
});

it("copies the intrinsic byte view and charges before copying", () => {
  class HostileBytes extends Uint8Array {
    override [Symbol.iterator](): ArrayIterator<number> { throw new Error("must not iterate"); }
  }
  const bytes = new HostileBytes([1, 2, 3]);
  Object.defineProperty(bytes, "byteLength", { value: 0 });
  const copy = wire.ownedBytes(bytes);
  bytes[0] = 9;
  expect([...copy]).toEqual([1, 2, 3]);
  expect(refusal(() => wire.ownedBytes(bytes, "invalid", 500, { maxBytes: 2, code: "too_large", status: 413 })))
    .toMatchObject({ code: "too_large", status: 413, detail: "BYTE-LIMIT-EXCEEDED" });
  expect([...wire.ownedBytes(runInNewContext("new Uint8Array([4])"))]).toEqual([4]);
  for (const value of [new Uint16Array([1]), new Proxy(bytes, {}), {}]) {
    expect(refusal(() => wire.ownedBytes(value))).toMatchObject({ code: "wire_input_invalid" });
  }
});

it("decodes only exact canonical envelope signatures and wallet encodings", () => {
  const bytes = Buffer.alloc(64, 7);
  for (const value of [bytes, bytes.toString("base64url"), bytes.toString("hex"), `0x${bytes.toString("hex")}`]) {
    expect(wire.envelopeSignatureBytes(value)).toEqual(bytes);
  }
  const encoded = bytes.toString("base64url");
  for (const value of [bytes.subarray(1), `${encoded}=`, `${encoded.slice(0, -1)}x`, "a".repeat(127), {}]) {
    expect(refusal(() => wire.envelopeSignatureBytes(value))).toMatchObject({ code: "peer_signature_invalid" });
  }
  expect(wire.walletSignatureBytes(` 0x0x${bytes.toString("hex")} `)).toEqual(bytes);
  expect(wire.walletSignatureBytes(encoded)).toEqual(bytes);
  expect(refusal(() => wire.walletSignatureBytes(bytes))).toMatchObject({ code: "peer_delegation_signature_invalid" });
});
