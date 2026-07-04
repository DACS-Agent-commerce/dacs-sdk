import { describe, expect, test } from "vitest";

import {
  parseCciRecord,
  parseClaimRef,
  cciClaimRefs,
  cciHasClaim,
} from "../../src/identity/cci.js";

const PRIMARY =
  "did:demos:agent:1111111111111111111111111111111111111111111111111111111111111111";

// The confirmed Demos identity-graph shape: linkedSocials + linkedWallets.
const GRAPH = {
  userId: "u1",
  linkedSocials: {
    twitter: "alice",
    github: "alice-dev",
    discord: "",
    telegram: "alice_tg",
  },
  linkedWallets: [
    "evm:0xAbC0000000000000000000000000000000000001",
    "solana:So1anaAddr11111111111111111111111111111",
  ],
};

describe("parseCciRecord (DACS-1 CCI resolution)", () => {
  test("parses web2 socials into claims, skipping empty handles", () => {
    const rec = parseCciRecord(PRIMARY, GRAPH);
    expect(rec.web2.map((c) => c.ref)).toEqual([
      "web2:twitter:alice",
      "web2:github:alice-dev",
      "web2:telegram:alice_tg",
    ]);
    // discord was empty → dropped.
    expect(rec.web2.some((c) => c.platform === "discord")).toBe(false);
  });

  test("parses linkedWallets into cross-chain wallet claims", () => {
    const rec = parseCciRecord(PRIMARY, GRAPH);
    expect(rec.wallets).toEqual([
      {
        kind: "wallet",
        chainType: "evm",
        address: "0xAbC0000000000000000000000000000000000001",
        ref: "xm:evm:0xAbC0000000000000000000000000000000000001",
      },
      {
        kind: "wallet",
        chainType: "solana",
        address: "So1anaAddr11111111111111111111111111111",
        ref: "xm:solana:So1anaAddr11111111111111111111111111111",
      },
    ]);
  });

  test("keeps the primary claim and raw payload", () => {
    const rec = parseCciRecord(PRIMARY, GRAPH);
    expect(rec.primaryClaim).toBe(PRIMARY);
    expect(rec.raw).toBe(GRAPH);
    expect(rec.claims).toHaveLength(5); // 3 web2 + 2 wallets
  });

  test("unwraps the nested RPC envelope { response: { response } }", () => {
    const rec = parseCciRecord(PRIMARY, { response: { response: GRAPH } });
    expect(rec.web2).toHaveLength(3);
    expect(rec.wallets).toHaveLength(2);
  });

  test("unwraps a { data } envelope", () => {
    const rec = parseCciRecord(PRIMARY, { data: GRAPH });
    expect(rec.wallets).toHaveLength(2);
  });

  test("empty / unrecognised payload yields no claims (still valid record)", () => {
    const rec = parseCciRecord(PRIMARY, { something: "else" });
    expect(rec.claims).toEqual([]);
    expect(rec.primaryClaim).toBe(PRIMARY);
  });
});

describe("cciClaimRefs / cciHasClaim", () => {
  const rec = parseCciRecord(PRIMARY, GRAPH);

  test("cciClaimRefs lists the primary first, then linked refs", () => {
    const refs = cciClaimRefs(rec);
    expect(refs[0]).toBe(PRIMARY);
    expect(refs).toContain("web2:twitter:alice");
    expect(refs).toContain("xm:evm:0xAbC0000000000000000000000000000000000001");
    expect(refs).toHaveLength(6);
  });

  test("matches the primary claim", () => {
    expect(cciHasClaim(rec, PRIMARY)).toBe(true);
  });

  test("matches a web2 claim case-insensitively", () => {
    expect(cciHasClaim(rec, "web2:twitter:alice")).toBe(true);
    expect(cciHasClaim(rec, "WEB2:TWITTER:ALICE")).toBe(true);
  });

  test("matches a wallet claim exactly (address casing preserved)", () => {
    expect(
      cciHasClaim(rec, "xm:evm:0xAbC0000000000000000000000000000000000001"),
    ).toBe(true);
    // A different-cased address is a different claim (no silent normalisation).
    expect(
      cciHasClaim(rec, "xm:evm:0xabc0000000000000000000000000000000000001"),
    ).toBe(false);
  });

  test("rejects an unknown claim", () => {
    expect(cciHasClaim(rec, "web2:github:someone-else")).toBe(false);
  });
});

describe("parseCciRecord — live GCR shape (R1: xm/web2 nested)", () => {
  // The deployed testnet shape: gcr_routine getIdentities → { result, response:
  // { xm: {<chain>:{<network>:[{address}]}}, web2: {<platform>:[{username}]}, ud, pqc } }.
  const LIVE = {
    result: 200,
    response: {
      ud: [],
      pqc: {},
      xm: {
        evm: {
          mainnet: [
            { address: "0xAbC0000000000000000000000000000000000001", publicKey: "pk1" },
          ],
        },
        solana: {
          mainnet: [{ address: "So1anaAddr11111111111111111111111111111" }],
        },
      },
      web2: {
        twitter: [{ username: "alice", userId: "1", proofHash: "h" }],
        github: [{ username: "alice-dev" }],
      },
    },
  };

  test("reads cross-chain wallets from xm.<chain>.<network>[].address", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(rec.wallets.map((w) => w.ref)).toEqual([
      "xm:evm:0xAbC0000000000000000000000000000000000001",
      "xm:solana:So1anaAddr11111111111111111111111111111",
    ]);
  });

  test("reads web2 handles from web2.<platform>[].username", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(rec.web2.map((c) => c.ref)).toEqual([
      "web2:twitter:alice",
      "web2:github:alice-dev",
    ]);
  });

  test("an empty live graph yields a valid empty record (fail-closed, not a throw)", () => {
    const rec = parseCciRecord(PRIMARY, {
      result: 200,
      response: { ud: [], xm: {}, pqc: {}, web2: {} },
    });
    expect(rec.claims).toEqual([]);
    expect(rec.primaryClaim).toBe(PRIMARY);
  });

  test("still handles the legacy linkedSocials/linkedWallets shape (fallback)", () => {
    const rec = parseCciRecord(PRIMARY, GRAPH);
    expect(rec.claims).toHaveLength(5);
  });
});

describe("parseClaimRef (reverse-lookup decomposition)", () => {
  test("parses a web2 ref", () => {
    expect(parseClaimRef("web2:twitter:alice")).toEqual({
      kind: "web2",
      platform: "twitter",
      handle: "alice",
    });
  });

  test("parses a wallet ref (address may contain no extra colons)", () => {
    expect(parseClaimRef("xm:evm:0xAbC0000000000000000000000000000000000001")).toEqual({
      kind: "wallet",
      chainType: "evm",
      address: "0xAbC0000000000000000000000000000000000001",
    });
  });

  test("round-trips the refs parseCciRecord produced", () => {
    const rec = parseCciRecord(PRIMARY, GRAPH);
    for (const c of rec.claims) {
      const parsed = parseClaimRef(c.ref);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe(c.kind);
    }
  });

  test("returns null for the primary claim / non-linked refs", () => {
    expect(parseClaimRef(PRIMARY)).toBeNull();
    expect(parseClaimRef("not-a-ref")).toBeNull();
  });
});
