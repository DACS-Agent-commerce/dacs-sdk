import { expect, test } from "vitest";
import { listingAddress } from "../../src/canonical/addressing.js";
import { DacsError } from "../../src/errors.js";
// CORE §B.1 CF-4: version is a fixed structural segment, not arbitrary text.
// CORE §B.2: numeric values must remain within the safe magnitude.
test.each([0, 3, Number.MAX_SAFE_INTEGER, "0", "3", "v0", "v3", "9007199254740991"])("preserves supported version %j", (version) => {
 const digits = String(version).replace(/^v/, "");
 expect(listingAddress("seller:one", "listing?one", version)).toBe(`dacs1:seller%3Aone:listing%3Fone:v${digits}`);
});
test.each(["", "v", "v1:extra", "1:extra", "v-1", "-1", "1.5", "1e2", " 1", "1\n", "v1\r", "01", "v01", "١", "9007199254740992", -1, 1.5, Infinity, NaN, 9007199254740992])("rejects malformed or unsafe version %j", (version) => {
 expect(() => listingAddress("seller", "listing", version)).toThrow(DacsError);
});
