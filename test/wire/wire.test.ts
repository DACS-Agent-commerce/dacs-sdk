import { describe, expect, it } from "vitest";
import { COMPOSITE_DOMAIN_SEPARATORS, SIGNATURE_DOMAIN_SEPARATORS } from "../../src/crypto/index.js";
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_ROUTES, findDacsSellerHttpRoute, isReadRoute, WireError } from "../../src/wire/index.js";
import { faultCategory } from "../../src/errors.js";
it("a wire refusal blames the counterparty, with its stable code and status", () => {
  const refusal = new WireError("peer_expired", 408, "detail");
  expect(refusal.category).toBe("counterparty");
  expect(faultCategory(refusal)).toBe("counterparty");
  expect([refusal.name, refusal.code, refusal.status, refusal.message]).toEqual(["WireError", "peer_expired", 408, "peer_expired: detail"]);
  expect(new WireError("peer_signature_invalid").message).toBe("peer_signature_invalid");
});

// A host's own setup fault (500) or a state that may clear (503) never blames the peer.
it.each([
  ["seller_replay_guard_required", 500, "permanent"], ["seller_retained_agreement_required", 500, "permanent"],
  ["tp1_binding_required", 500, "permanent"], ["seller_not_ready", 503, "transient"], ["peer_response_too_large", 500, "permanent"], ["body_too_large", 500, "permanent"],
  ["peer_signature_invalid", 401, "counterparty"], ["bad_json", 400, "counterparty"], ["peer_expired", 408, "counterparty"],
  ["peer_request_replayed", 409, "counterparty"], ["peer_agreement_party_mismatch", 409, "counterparty"], ["discovery_invalid", 502, "counterparty"],
] as const)("%s (%i) is blamed as %s", (code, status, category) => {
  const refusal = new WireError(code, status);
  expect(refusal.category).toBe(category);
  expect(faultCategory(refusal)).toBe(category);
});

describe("dacs-seller-http/v1 routes and limits", () => {
  it("keeps the plugin's seven routes and adds commit-on-signature, the context route and discovery", () => {
    expect(DACS_SELLER_HTTP_ROUTES.map((r) => `${r.method} ${r.path}${r.option ? ` [${r.option}]` : ""}`)).toEqual([
      "POST /dacs/v1/agreements/proposals",
      "POST /dacs/v1/agreements/state",
      "POST /dacs/v1/commitments",
      "POST /dacs/v1/payments",
      "POST /dacs/v1/bundles/request",
      "POST /dacs/v1/bundles/countersignature",
      "POST /dacs/v1/bundles/buyer-copy",
      "POST /dacs/v1/commitments/signature [commit-on-signature]",
      "POST /dacs/v1/agreements/context [context-route]",
      `GET ${DACS_SELLER_DISCOVERY_PATH}`,
    ]);
    expect(Object.isFrozen(DACS_SELLER_HTTP_ROUTES)).toBe(true);
    expect(DACS_SELLER_HTTP_ROUTES.filter((r) => isReadRoute(r.path)).map((r) => r.path)).toEqual(["/dacs/v1/agreements/state", "/dacs/v1/bundles/buyer-copy"]);
  });

  it("matches only the exact method and raw target", () => {
    expect(findDacsSellerHttpRoute("POST", "/dacs/v1/payments")?.effect).toBe("effect");
    for (const target of ["/dacs/v1/payments?x=1", "/dacs/v1/payments/", "/dacs/v1/%70ayments", "/DACS/v1/payments"]) {
      expect(findDacsSellerHttpRoute("POST", target)).toBeNull();
    }
    expect(findDacsSellerHttpRoute("GET", "/dacs/v1/payments")).toBeNull();
    expect(findDacsSellerHttpRoute("POST", DACS_SELLER_DISCOVERY_PATH)).toBeNull();
  });

  it("keeps today's limits: 64 KiB request, 512 KiB response, 60 s messages, 24 h delegations", () => {
    expect(DACS_SELLER_HTTP_LIMITS).toMatchObject({ maxRequestBodyBytes: 65536, maxResponseBodyBytes: 524288, maxMessageLifetimeMs: 60000, maxClockSkewMs: 30000, maxSignedLifetimeMs: 30000, maxDelegationLifetimeMs: 86400000 });
    // A signer's longest lifetime plus the skew allowance is exactly the receiver's window.
    expect(DACS_SELLER_HTTP_LIMITS.maxSignedLifetimeMs + DACS_SELLER_HTTP_LIMITS.maxClockSkewMs).toBe(DACS_SELLER_HTTP_LIMITS.maxMessageLifetimeMs);
  });
});

describe("signing domains", () => {
  it("are new SDK wire domains, distinct from the Standard's artifact domains and from each other", () => {
    const wire = Object.values(DACS_SELLER_HTTP_DOMAINS);
    expect(wire).toEqual(["dacs-seller-http:v1:request:", "dacs-seller-http:v1:response:", "dacs-seller-http:v1:delegation:", "dacs-seller-http:v1:discovery:"]);
    expect(new Set(wire).size).toBe(4);
    // The Standard's signature domains and its hash-domain tags (CORE §B.7; the tags are not signature domains).
    const standardDomains = [...SIGNATURE_DOMAIN_SEPARATORS, ...COMPOSITE_DOMAIN_SEPARATORS, "dacs-sealed-bid:v1:", "dacs-sb3:v1:", "dacs-ap2-idem:v1:"];
    expect(SIGNATURE_DOMAIN_SEPARATORS).toHaveLength(30);
    for (const domain of wire) {
      expect(standardDomains).not.toContain(domain);
      for (const standard of standardDomains) {
        expect(domain.startsWith(standard), `${standard} prefixes ${domain}`).toBe(false);
        expect(standard.startsWith(domain), `${domain} prefixes ${standard}`).toBe(false);
      }
      expect(domain.startsWith("dacs-chatgpt-plugin:")).toBe(false);
    }
  });
});
import { TESTNET_PROFILE_TP1, TP1_CAPABILITIES, TP1_DECLARATION, TP1_APPROVED_IDENTITY_RECORD } from "../../src/wire/profile.js";
describe("TESTNET_PROFILE_TP1", () => {
  it("names TP-1, its proposed base, tuple and declaration, and is frozen", () => {
    expect(TESTNET_PROFILE_TP1).toMatchObject({
      id: "dacs-testnet-tp1",
      status: "proposed; composition qualification pending",
      declaration: "experimental testnet implementation; not a conformant live DACS profile",
      relationToStandard: "SDK declaration of the SDK's testnet release; it does not change or extend the DACS Standard",
      base: { repo: "DACS-Standard", commit: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20" },
      tuple: { CORE: "0.3", "DACS-1": "0.7", "DACS-2": "0.6", "DACS-3": "0.5", "DACS-4": "0.8", "DACS-5": "0.5" },
    });
    expect(TP1_DECLARATION).toBe(TESTNET_PROFILE_TP1.declaration);
    expect(Object.isFrozen(TESTNET_PROFILE_TP1)).toBe(true);
    expect(Object.isFrozen(TESTNET_PROFILE_TP1.tuple)).toBe(true);
  });

  it("pins the approved record and limits current guarantees to the wire", () => {
    expect(TESTNET_PROFILE_TP1.network.identityRecord).toBe(TP1_APPROVED_IDENTITY_RECORD);
    expect(TESTNET_PROFILE_TP1.network.approvedIdentityRecordDigests).toEqual(["5c234f784b8fbbb77a53886594dbdf3689fbbc336f04c2c930edfd57f225e330"]);
    expect(TESTNET_PROFILE_TP1.network.refusedChainIdentities).toEqual([]);
    expect(TESTNET_PROFILE_TP1.network.status).toMatch(/record approved on 2026-10-20 pinned/);
    expect(TESTNET_PROFILE_TP1.network.composition).toContain("broadcast refusal is not checked");
    expect(JSON.stringify(TESTNET_PROFILE_TP1)).not.toContain("834375ad6381d9eedbaea18bfe841416fe680e00fa74b09ab711fde45d08e8e2");
  });

  it("states the TP-1 restrictions as capabilities", () => {
    expect(TP1_CAPABILITIES).toMatchObject({
      capability: "FP-DEM", negotiation: ["negotiate-fixed-price"], rails: ["pay-dem"],
      delivery: { channel: "demos-storage", address: "dacs4:deliverable:{jobId}" },
      services: ["fixed-text", "pure-synchronous-text-module"], output: { maxCharacters: 16384, synchronous: true }, buyerRequestInput: false,
    });
  });
});
