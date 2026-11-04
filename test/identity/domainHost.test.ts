import { domainToASCII } from "node:url";
import { describe, expect, test } from "vitest";

import {
  canonicalizeNativeDomainHostname,
  domainClaimReferenceFromNativeHostname,
  isCanonicalDomainHostname,
} from "../../src/identity/domainHost.js";
import { parseCciRecord } from "../../src/identity/cci.js";

const PRIMARY = `did:demos:agent:${"11".repeat(32)}`;

// RFC 5891 section 4.2.3 and RFC 5892 Appendix A: these are not
// IDNA2008 hostnames even when Node's UTS #46 conversion accepts them.
const invalidHosts = [
  "😀.example",
  "xn--e28h.example",
  "a·b.example",
  domainToASCII("a·b.example"),
  "ab--cd.example",
  "sub.ab--cd.example",
  "a---b.example",
  "ab--é.example",
  domainToASCII("ab--é.example"),
  "a・b.example",
  domainToASCII("a・b.example"),
  "͵a.example",
  domainToASCII("͵a.example"),
  "a׳.example",
  domainToASCII("a׳.example"),
  "-é.example",
  domainToASCII("-é.example"),
  "\u{10428}a--b.example",
  domainToASCII("\u{10428}a--b.example"),
];

describe("IDNA2008 domain hosts (#592)", () => {
  test.each(invalidHosts)("rejects %s at the native producer boundary", (host) => {
    expect(canonicalizeNativeDomainHostname(host)).toBeNull();
    expect(domainClaimReferenceFromNativeHostname(host)).toBeNull();
    expect(isCanonicalDomainHostname(host)).toBe(false);
  });

  test.each(invalidHosts)("does not emit a CCI domain claim for %s", (host) => {
    for (const source of [
      { result: 200, response: { xm: {}, ud: [], pqc: {}, web2: { domain: [{ username: host }] } } },
      { linkedSocials: { domain: host } },
    ]) {
      const record = parseCciRecord(PRIMARY, source);
      expect(record.web2.some((claim) => claim.platform === "domain")).toBe(false);
    }
  });

  test.each([
    ["Alice.Example", "alice.example"],
    ["Bücher.example", "xn--bcher-kva.example"],
    ["bu\u0308cher.example", "xn--bcher-kva.example"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["l·l.example", "xn--ll-0ea.example"],
    ["faß.example", "xn--fa-hia.example"],
    ["alice。example", "alice.example"],
    ["123.456.789", "123.456.789"],
    ["a-b.example", "a-b.example"],
    ["例え.example", domainToASCII("例え.example")],
    ["͵α.example", domainToASCII("͵α.example")],
    ["ア・イ.example", domainToASCII("ア・イ.example")],
    ["a-b--c.example", "a-b--c.example"],
    ["\u{10428}--ab.example", domainToASCII("\u{10428}--ab.example")],
  ])("preserves valid native hostname %s", (native, canonical) => {
    expect(canonicalizeNativeDomainHostname(native)).toBe(canonical);
    expect(domainClaimReferenceFromNativeHostname(native)).toBe(`domain:${canonical}`);
    expect(isCanonicalDomainHostname(canonical)).toBe(true);
  });

  test.each([
    "example.com/path", "user@example.com", "example.com:443",
    "127.0.0.1", "[::1]", "bad_host.example", "example.com.",
    "Ａgent.example", " example.com", "a\u200db.example", "a\u200cb.example",
  ])("keeps the existing rejection of %s", (host) => {
    expect(canonicalizeNativeDomainHostname(host)).toBeNull();
  });

  test("requires exact canonical spelling for signed domain references", () => {
    expect(isCanonicalDomainHostname("Alice.Example")).toBe(false);
    expect(isCanonicalDomainHostname("bücher.example")).toBe(false);
    expect(isCanonicalDomainHostname("alice.example")).toBe(true);
  });
});
