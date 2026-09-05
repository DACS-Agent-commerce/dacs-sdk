import { describe, expect, test } from "vitest";

import { isDacsPublicAddressV1 } from "../../src/agent/publicAddress.js";

describe("DACS public address policy", () => {
  test.each([
    "8.8.8.8",
    "2001:200::1",
    "2001:3ff:ffff::1",
    "2001:800::1",
    "2001:bff:ffff::1",
    "2001:2000::1",
    "2001:3fff:ffff::1",
    "2003:3fff:ffff::1",
    "241f:ffff::1",
    "2610::1",
    "2620::1",
    "263f:ffff::1",
    "2a1f:ffff::1",
    "2c0f:ffff::1",
  ])("allows allocated public address %s", (address) => {
    expect(isDacsPublicAddressV1(address)).toBe(true);
  });

  test.each([
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "2001:1000::1",
    "2001:6000::1",
    "2001:db8::1",
    "2002::1",
    "2003:4000::1",
    "2420::1",
    "2620:4f:8000::1",
    "2640::1",
    "2a20::1",
    "2c10::1",
    "3fff::1",
    "4000::1",
  ])("refuses private, special-purpose, or unallocated address %s", (address) => {
    expect(isDacsPublicAddressV1(address)).toBe(false);
  });
});
