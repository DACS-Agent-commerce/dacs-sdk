import { expect, test } from "vitest";
import { fixedPriceAgreementLogicalAddress } from "../../src/negotiate/durableFixedPriceExchange.js";
import { DacsError } from "../../src/errors.js";
const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// CORE §B.1 JID-1 / JID-3: reject alternate spellings before address assembly.
test("derives from exact canonical job bytes", () => {
 expect(fixedPriceAgreementLogicalAddress(JOB)).toBe(`dacs3:agreement:${JOB}`);
});
test.each(["", "job-abc", JOB.toLowerCase(), JOB + "\n", JOB + "\r", JOB + "\t",
 "8" + "0".repeat(25), "0" + "O".repeat(25), "0" + "I".repeat(25), "0" + "L".repeat(25),
 "0" + "U".repeat(25), "0".repeat(25), "0".repeat(27), " " + JOB, JOB.replace("0", "%30"),
 "0" + "１".repeat(25)])("rejects non-JID-1 operand %j", (value) => {
 expect(() => fixedPriceAgreementLogicalAddress(value)).toThrow(DacsError);
 expect(() => fixedPriceAgreementLogicalAddress(value)).toThrow(/jobId/);
});

// Type guards are controls: the previous nonempty-string guard already refused these.
test.each([null, undefined, 123, {}, []])("refuses a non-string operand %j", (value) => {
 expect(() => fixedPriceAgreementLogicalAddress(value as unknown as string)).toThrow(DacsError);
});
