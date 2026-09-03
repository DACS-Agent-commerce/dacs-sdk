import { describe, expect, test } from "vitest";

import {
  parseCciRecord,
  parseClaimRef,
  cciClaimRefs,
  cciHasClaim,
  cciClaimProof,
  cciClaimHasProof,
  type CciRecord,
  type CciWeb2Claim,
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
    "evm:mainnet:0xAbC0000000000000000000000000000000000001",
    "solana:mainnet:So1anaAddr11111111111111111111111111111",
  ],
};

describe("parseCciRecord (DACS-1 CCI resolution)", () => {
  test("parses web2 socials into claims, skipping empty handles", () => {
    const rec = parseCciRecord(PRIMARY, GRAPH);
    expect(rec.web2.map((c) => c.ref)).toEqual([
      "cci-web2:github:alice-dev",
      "cci-web2:telegram:alice_tg",
      "cci-web2:twitter:alice",
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
        subchain: "mainnet",
        address: "0xAbC0000000000000000000000000000000000001",
        ref: "cci-xm:evm:mainnet:0xAbC0000000000000000000000000000000000001",
      },
      {
        kind: "wallet",
        chainType: "solana",
        subchain: "mainnet",
        address: "So1anaAddr11111111111111111111111111111",
        ref: "cci-xm:solana:mainnet:So1anaAddr11111111111111111111111111111",
      },
    ]);
  });

  test("keeps the primary claim and raw payload", () => {
    const rec = parseCciRecord(PRIMARY, GRAPH);
    expect(rec.primaryClaim).toBe(PRIMARY);
    expect(rec.raw).toEqual(GRAPH);
    expect(rec.raw).not.toBe(GRAPH);
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
    expect(refs).toContain("cci-web2:twitter:alice");
    expect(refs).toContain("cci-xm:evm:mainnet:0xAbC0000000000000000000000000000000000001");
    expect(refs).toHaveLength(6);
  });

  test("matches the primary claim", () => {
    expect(cciHasClaim(rec, PRIMARY)).toBe(true);
  });

  test("matches a web2 claim case-insensitively", () => {
    expect(cciHasClaim(rec, "cci-web2:twitter:alice")).toBe(true);
    expect(cciHasClaim(rec, "CCI-WEB2:TWITTER:ALICE")).toBe(true);
  });

  test("matches a wallet claim exactly (address casing preserved)", () => {
    expect(
      cciHasClaim(rec, "cci-xm:evm:mainnet:0xAbC0000000000000000000000000000000000001"),
    ).toBe(true);
    // A different-cased address is a different claim (no silent normalisation).
    expect(
      cciHasClaim(rec, "cci-xm:evm:mainnet:0xabc0000000000000000000000000000000000001"),
    ).toBe(false);
  });

  test("rejects an unknown claim", () => {
    expect(cciHasClaim(rec, "cci-web2:github:someone-else")).toBe(false);
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
      "cci-xm:evm:mainnet:0xAbC0000000000000000000000000000000000001",
      "cci-xm:solana:mainnet:So1anaAddr11111111111111111111111111111",
    ]);
  });

  test("reads web2 handles from web2.<platform>[].username", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(rec.web2.map((c) => c.ref)).toEqual([
      "cci-web2:github:alice-dev",
      "cci-web2:twitter:alice",
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

  test("does not invent a subchain for ambiguous two-coordinate legacy wallets", () => {
    const rec = parseCciRecord(PRIMARY, {
      linkedWallets: ["evm:0xAbC0000000000000000000000000000000000001"],
    });
    expect(rec.wallets).toEqual([]);
    expect(rec.raw).toEqual({
      linkedWallets: ["evm:0xAbC0000000000000000000000000000000000001"],
    });
  });
});

describe("parseCciRecord — ud + pqc claim families", () => {
  const LIVE = {
    result: 200,
    response: {
      xm: {},
      web2: {
        domain: [{ username: "alice.example", proof: "https://alice.example/.well-known/demos-cci.txt" }],
      },
      ud: [
        { domain: "alice.crypto", network: "polygon", signature: "0xsig" },
        { domain: "alice.nft" }, // no network / proof — still a valid claim
      ],
      pqc: [
        { algorithm: "falcon", address: "falconpk1", signature: "s" },
        { algorithm: "ml-dsa", address: "mldsapk1" },
      ],
    },
  };

  test("a DNS domain identity emits the canonical domain: ref without unauthenticated alias folding", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    const dom = rec.web2.find((c) => c.platform === "domain");
    expect(dom?.ref).toBe("domain:alice.example");
    expect(dom?.proof).toBe("https://alice.example/.well-known/demos-cci.txt");
    expect(cciClaimHasProof(rec, "domain:alice.example")).toBe(true);
    expect(cciClaimHasProof(rec, "web2:domain:alice.example")).toBe(false);
  });

  test("unstoppable domains parse into registered cci-ud claims (network + proof surfaced)", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(rec.ud.map((c) => c.ref)).toEqual(["cci-ud:alice.crypto", "cci-ud:alice.nft"]);
    expect(rec.ud[0]).toMatchObject({ domain: "alice.crypto", network: "polygon", proof: "0xsig" });
    expect(rec.ud[1]!.network).toBeUndefined();
    expect(rec.ud[1]!.proof).toBeUndefined();
  });

  test("pqc keys parse into registered cci-pqc claims keyed by algorithm+address", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(rec.pqc.map((c) => c.ref)).toEqual([
      "cci-pqc:falcon:falconpk1",
      "cci-pqc:ml-dsa:mldsapk1",
    ]);
  });

  test("cciHasClaim matches cci-ud case-insensitively, cci-pqc exactly", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(cciHasClaim(rec, "cci-ud:ALICE.CRYPTO")).toBe(true);
    expect(cciHasClaim(rec, "cci-pqc:falcon:falconpk1")).toBe(true);
    // CF-2: the public key is case-significant — only the exact form matches.
    expect(cciHasClaim(rec, "cci-pqc:falcon:FALCONPK1")).toBe(false);
  });

  test("cciClaimProof returns the proof only for proof-bearing claims", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(cciClaimProof(rec, "cci-ud:alice.crypto")).toBe("0xsig");
    expect(cciClaimProof(rec, "cci-ud:alice.nft")).toBeUndefined();
    // pqc / wallet families never carry a web-style proof.
    expect(cciClaimHasProof(rec, "cci-pqc:falcon:falconpk1")).toBe(false);
  });

  test("all four families flow into claims and claim refs", () => {
    const rec = parseCciRecord(PRIMARY, LIVE);
    expect(rec.claims).toHaveLength(1 + 2 + 2); // 1 web2 + 2 ud + 2 pqc (no xm)
    const refs = cciClaimRefs(rec);
    expect(refs[0]).toBe(PRIMARY);
    expect(refs).toContain("cci-ud:alice.crypto");
    expect(refs).toContain("cci-pqc:ml-dsa:mldsapk1");
  });
});

describe("parseClaimRef (reverse-lookup decomposition)", () => {
  test("parses a web2 ref", () => {
    expect(parseClaimRef("cci-web2:twitter:alice")).toEqual({
      kind: "web2",
      platform: "twitter",
      handle: "alice",
    });
  });

  test("parses a wallet ref (address may contain no extra colons)", () => {
    expect(parseClaimRef("cci-xm:evm:mainnet:0xAbC0000000000000000000000000000000000001")).toEqual({
      kind: "wallet",
      chainType: "evm",
      subchain: "mainnet",
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

describe("canonical domain: claim ref (strict unauthenticated CCI boundary)", () => {
  // A live GCR web2 payload keyed by platform, wrapped in the deployed envelope.
  const gcr = (web2: Record<string, unknown>) => ({
    result: 200,
    response: { xm: {}, ud: [], pqc: {}, web2 },
  });

  // Hand-built CciRecord holding a single web2 claim — simulates a HISTORICAL
  // artifact whose stored ref predates canonicalisation. Deliberately NOT built
  // via parseCciRecord (that would canonicalise the ref away).
  const recordWithWeb2Ref = (handle: string, ref: string): CciRecord => {
    const claim: CciWeb2Claim = { kind: "web2", platform: "domain", handle, ref };
    return {
      primaryClaim: PRIMARY,
      web2: [claim],
      wallets: [],
      ud: [],
      pqc: [],
      nomis: [],
      humanPassport: [],
      ethos: [],
      tlsn: [],
      claims: [claim],
      raw: {},
    };
  };

  test("T1: domain emits domain:<host>; non-domain platforms keep web2:<platform>:<handle>", () => {
    const rec = parseCciRecord(
      PRIMARY,
      gcr({
        domain: [{ username: "alice.example" }],
        twitter: [{ username: "alice" }],
        github: [{ username: "alice-dev" }],
      }),
    );
    const byPlatform = Object.fromEntries(rec.web2.map((c) => [c.platform, c.ref]));
    expect(byPlatform["domain"]).toBe("domain:alice.example");
    expect(byPlatform["twitter"]).toBe("cci-web2:twitter:alice");
    expect(byPlatform["github"]).toBe("cci-web2:github:alice-dev");
  });

  test("T2: bare CCI lookup does not fold a historical alias", () => {
    const rec = parseCciRecord(
      PRIMARY,
      gcr({
        domain: [
          { username: "alice.example", proof: "https://alice.example/.well-known/demos-cci.txt" },
        ],
      }),
    );
    expect(cciHasClaim(rec, "web2:domain:alice.example")).toBe(false);
    expect(cciClaimProof(rec, "web2:domain:alice.example")).toBeUndefined();
  });

  test("T3: a historical record cannot cross the bare lookup boundary", () => {
    const rec = recordWithWeb2Ref("alice.example", "web2:domain:alice.example");
    expect(cciHasClaim(rec, "domain:alice.example")).toBe(false);
  });

  test("T4: parseClaimRef accepts only the current canonical domain form", () => {
    const shape = { kind: "web2", platform: "domain", handle: "alice.example" };
    expect(parseClaimRef("domain:alice.example")).toEqual(shape);
    expect(parseClaimRef("web2:domain:alice.example")).toBeNull();
  });

  test("T5: case-variant domain handles collapse to one canonical claim", () => {
    const rec = parseCciRecord(
      PRIMARY,
      gcr({ domain: [{ username: "Alice.example" }, { username: "alice.example" }] }),
    );
    const domains = rec.web2.filter((c) => c.platform === "domain");
    expect(domains).toHaveLength(1);
    expect(domains[0]!.ref).toBe("domain:alice.example");
  });

  test("T6: a unicode domain emits a punycode ref; handle keeps its original encoding", () => {
    const rec = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "Bücher.example" }] }));
    const dom = rec.web2.find((c) => c.platform === "domain");
    expect(dom?.ref).toBe("domain:xn--bcher-kva.example");
    expect(dom?.handle).toBe("Bücher.example");
  });

  test("T7: signed-style queries must already use exact punycode spelling", () => {
    const rec = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "Bücher.example" }] }));
    expect(cciHasClaim(rec, "domain:xn--bcher-kva.example")).toBe(true);
    expect(cciHasClaim(rec, "web2:domain:Bücher.example")).toBe(false);
    expect(cciHasClaim(rec, "domain:Bücher.example")).toBe(false);
  });

  test("T8: unresolvable domain hosts never collide or false-match", () => {
    const rec = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "alice.example" }] }));
    expect(cciHasClaim(rec, "web2:domain:not a host")).toBe(false);

    // Two DIFFERENT unresolvable refs must not collapse to the same string.
    const bad = recordWithWeb2Ref("not a host", "web2:domain:not a host");
    expect(cciHasClaim(bad, "web2:domain:also not a host")).toBe(false);
  });

  test("T9: a domain entry whose host cannot canonicalise is dropped (no legacy fallback)", () => {
    const rec = parseCciRecord(
      PRIMARY,
      gcr({ domain: [{ username: "not a host" }], twitter: [{ username: "alice" }] }),
    );
    expect(rec.web2.some((c) => c.platform === "domain")).toBe(false);
    expect(rec.claims.some((c) => c.ref.startsWith("domain:"))).toBe(false);
    expect(rec.claims.some((c) => c.ref.startsWith("web2:domain:"))).toBe(false);
    // The sibling twitter claim is unaffected.
    expect(rec.web2.map((c) => c.ref)).toEqual(["cci-web2:twitter:alice"]);
  });

  test("T10: parseCciRecord never emits a web2:domain: ref (canonical + legacy shapes)", () => {
    const payloads: unknown[] = [
      gcr({ domain: [{ username: "Alice.example" }], twitter: [{ username: "a" }] }),
      gcr({ domain: [{ username: "Bücher.example" }] }),
      // Legacy flat linkedSocials fallback carrying a domain.
      { linkedSocials: { domain: "Alice.example", twitter: "alice" } },
    ];
    for (const p of payloads) {
      const rec = parseCciRecord(PRIMARY, p);
      for (const c of rec.claims) {
        expect(c.ref.startsWith("web2:domain:")).toBe(false);
      }
    }
  });

  test("T11: wallet and pqc refs still match exactly (no alias folding)", () => {
    const rec = parseCciRecord(PRIMARY, {
      result: 200,
      response: {
        xm: { evm: { mainnet: [{ address: "0xAbC0000000000000000000000000000000000001" }] } },
        web2: {},
        ud: [],
        pqc: [{ algorithm: "falcon", address: "falconpk1", signature: "s" }],
      },
    });
    // wallet: a different-cased address is a different claim.
    expect(cciHasClaim(rec, "cci-xm:evm:mainnet:0xabc0000000000000000000000000000000000001")).toBe(false);
    expect(cciHasClaim(rec, "cci-xm:evm:mainnet:0xAbC0000000000000000000000000000000000001")).toBe(true);
    // pqc: the public key is case-significant.
    expect(cciHasClaim(rec, "cci-pqc:falcon:FALCONPK1")).toBe(false);
    expect(cciHasClaim(rec, "cci-pqc:falcon:falconpk1")).toBe(true);
  });
});

describe("domain host validation / reject-list (canonicalDomainHost)", () => {
  const gcr = (web2: Record<string, unknown>) => ({
    result: 200,
    response: { xm: {}, ud: [], pqc: {}, web2 },
  });
  const domRef = (username: string): string | null => {
    const rec = parseCciRecord(PRIMARY, gcr({ domain: [{ username }] }));
    const d = rec.web2.find((c) => c.platform === "domain");
    return d ? d.ref : null;
  };

  test("R1: path/query/fragment/credential/port inputs emit NO domain claim", () => {
    for (const bad of [
      "alice.example/path",
      "alice.example?q=1",
      "alice.example#frag",
      "user:pass@alice.example",
      "alice.example:8080",
    ]) {
      expect(domRef(bad)).toBeNull();
    }
  });

  test("R2: those inputs do NOT false-match a record holding 'alice.example'", () => {
    const recA = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "alice.example" }] }));
    // sanity: the legitimate host does resolve
    expect(cciHasClaim(recA, "domain:alice.example")).toBe(true);
    for (const bad of ["alice.example/path", "alice.example?q=1", "alice.example#frag"]) {
      expect(cciHasClaim(recA, "domain:" + bad)).toBe(false);
      expect(cciHasClaim(recA, "web2:domain:" + bad)).toBe(false);
    }
  });

  test("R3: IPv4 literals rejected in all forms and never match each other", () => {
    const ipv4 = ["192.0.2.1", "0xc0.0x00.0x02.0x01", "3221225985"];
    for (const x of ipv4) expect(domRef(x)).toBeNull();
    // none matches a record built from another IPv4 spelling
    for (const store of ipv4) {
      const rec = parseCciRecord(PRIMARY, gcr({ domain: [{ username: store }] }));
      expect(rec.web2.some((c) => c.platform === "domain")).toBe(false);
      for (const q of ipv4) {
        expect(cciHasClaim(rec, "domain:" + q)).toBe(false);
      }
    }
  });

  test("R4: IPv6 literals (bracketed and bare) emit no domain claim", () => {
    expect(domRef("[2001:db8::1]")).toBeNull();
    expect(domRef("2001:db8::1")).toBeNull();
  });

  test("R5: legitimate hosts still emit (reject-list did not over-reject)", () => {
    expect(domRef("alice.example")).toBe("domain:alice.example");
    expect(domRef("Alice.Example")).toBe("domain:alice.example");
    expect(domRef("Bücher.example")).toBe("domain:xn--bcher-kva.example");
    expect(domRef("alice。example")).toBe("domain:alice.example");
    expect(domRef("Ａgent.example")).toBeNull();
  });

  test("R6: parseClaimRef rejects non-canonical domain scheme spelling", () => {
    const shape = { kind: "web2", platform: "domain", handle: "alice.example" };
    expect(parseClaimRef("Domain:alice.example")).toBeNull();
    expect(parseClaimRef("DOMAIN:alice.example")).toBeNull();
    expect(parseClaimRef("domain:alice.example")).toEqual(shape);
    const rec = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "alice.example" }] }));
    expect(cciHasClaim(rec, "Domain:alice.example")).toBe(false);
    expect(cciHasClaim(rec, "DOMAIN:alice.example")).toBe(false);
  });

  test("R7: trailing-dot forms emit no claim and never false-match the bare host", () => {
    // ASCII trailing dots, and a terminal ideographic full stop that
    // domainToASCII MAPS to "." (verified: "alice.example。" -> "alice.example.").
    for (const bad of ["alice.example.", "alice.example..", "alice.example。"]) {
      expect(domRef(bad)).toBeNull();
    }
    const recA = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "alice.example" }] }));
    for (const bad of ["alice.example.", "alice.example.."]) {
      expect(cciHasClaim(recA, "domain:" + bad)).toBe(false);
      expect(cciHasClaim(recA, "web2:domain:" + bad)).toBe(false);
    }
    // Universal invariant: no emitted domain ref may end in a dot.
    const emittedRefs = [
      "alice.example",
      "Bücher.example",
      "a..b",
      "alice.example.",
      "alice.example．",
    ]
      .map(domRef)
      .filter((r): r is string => r !== null);
    for (const r of emittedRefs) expect(r.endsWith(".")).toBe(false);
  });

  test("R8: percent-encoded forms emit no claim and do not false-match", () => {
    // "alice%2eexample" decodes to "alice.example" (live bypass); "%2Fpath" is
    // additionally stripped by domainToASCII (defence-in-depth).
    for (const bad of ["alice%2eexample", "alice.example%2Fpath"]) {
      expect(domRef(bad)).toBeNull();
    }
    const recA = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "alice.example" }] }));
    for (const bad of ["alice%2eexample", "alice.example%2Fpath"]) {
      expect(cciHasClaim(recA, "domain:" + bad)).toBe(false);
      expect(cciHasClaim(recA, "web2:domain:" + bad)).toBe(false);
    }
  });

  test("R9: a mixed-case 'Domain'/'DOMAIN' platform key still emits canonical domain:", () => {
    for (const key of ["Domain", "DOMAIN"]) {
      const rec = parseCciRecord(PRIMARY, gcr({ [key]: [{ username: "alice.example" }] }));
      const claim = rec.web2.find((c) => c.ref.startsWith("domain:"));
      expect(claim?.ref).toBe("domain:alice.example");
      // No legacy web2:<Key>:… form leaks for a domain-keyed entry.
      expect(rec.claims.some((c) => c.ref.toLowerCase().startsWith("web2:domain:"))).toBe(false);
      // Native ingestion normalises the platform enum for canonical emission.
      expect(claim?.platform).toBe("domain");
    }
  });

  test("R10: a whitespace-padded query is rejected rather than repaired", () => {
    const recA = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "alice.example" }] }));
    expect(cciHasClaim(recA, "domain: alice.example ")).toBe(false);
    expect(cciHasClaim(recA, "web2:domain: alice.example ")).toBe(false);
  });

  test("R11: a mapped terminal ideographic dot is rejected at MATCH time, not just emit", () => {
    const recA = parseCciRecord(PRIMARY, gcr({ domain: [{ username: "alice.example" }] }));
    expect(cciHasClaim(recA, "domain:alice.example。")).toBe(false);
    expect(cciHasClaim(recA, "web2:domain:alice.example。")).toBe(false);
  });
});
