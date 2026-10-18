// Route table, limits, signing domains and the TP-1 record of @kynesyslabs/dacs/wire.
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

import { COMPOSITE_DOMAIN_SEPARATORS, SIGNATURE_DOMAIN_SEPARATORS } from "../../src/crypto/index.js";
import {
  DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_ROUTES,
  findDacsSellerHttpRoute, isReadRoute, TESTNET_PROFILE_TP1, TP1_CAPABILITIES, TP1_DECLARATION, TP1_APPROVED_IDENTITY_RECORD,
  TP1_PROFILE_REVISIONS, TP1_WIRE_PROFILE_KEYS,
} from "../../src/wire/index.js";
import * as wireExports from "../../src/wire/index.js";
import * as approvalModule from "../../src/wire/approval.js";
import * as profileModule from "../../src/wire/profile.js";

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
    expect(DACS_SELLER_HTTP_LIMITS).toMatchObject({ maxRequestBodyBytes: 65536, maxResponseBodyBytes: 524288, maxMessageLifetimeMs: 60000, maxDelegationLifetimeMs: 86400000 });
  });
});

describe("signing domains", () => {
  it("are new SDK wire domains, distinct from the Standard's artifact domains and from each other", () => {
    const wire = Object.values(DACS_SELLER_HTTP_DOMAINS);
    expect(wire).toEqual(["dacs-seller-http:v1:request:", "dacs-seller-http:v1:response:", "dacs-seller-http:v1:delegation:", "dacs-seller-http:v1:discovery:"]);
    expect(new Set(wire).size).toBe(4);
    for (const domain of wire) {
      expect([...SIGNATURE_DOMAIN_SEPARATORS, ...COMPOSITE_DOMAIN_SEPARATORS]).not.toContain(domain);
      for (const standard of [...SIGNATURE_DOMAIN_SEPARATORS, ...COMPOSITE_DOMAIN_SEPARATORS]) expect(domain.startsWith(standard)).toBe(false);
      expect(domain.startsWith("dacs-chatgpt-plugin:")).toBe(false);
    }
  });
});

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

  it("records the approved identity binding: the tuple (identifier, revision, base) in every signed message", () => {
    expect(TESTNET_PROFILE_TP1.revision).toBe("TP-1");
    expect(TP1_PROFILE_REVISIONS).toEqual(["TP-1"]);
    expect(Object.isFrozen(TP1_PROFILE_REVISIONS)).toBe(true);
    expect(TP1_WIRE_PROFILE_KEYS).toEqual(["id", "revision", "base", "chainIdentity", "pinVersion"]);
    expect(TESTNET_PROFILE_TP1.identityBinding.tuple).toEqual(["id", "revision", "base"]);
    expect(TESTNET_PROFILE_TP1.identityBinding.status).toBe("approved on 2026-10-15 at 21:23Z, as proposed");
    expect(TESTNET_PROFILE_TP1.identityBinding.rule).toMatch(/no fallback to identifier and base alone\.$/);
    const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const declaration = text("docs/testnet-profile-tp1.md"), wireDoc = text("docs/dacs-seller-http-v1.md"), page = text("docs/about-the-testnet-release.md");
    expect(declaration).toContain("| Revision | `TP-1`");
    expect(declaration).toContain("This binding was approved on 2026-10-15 at 21:23Z, as proposed");
    expect(wireDoc).toContain('`profile: {id: "dacs-testnet-tp1", revision: "TP-1", base: "d45c0a29…0f20", chainIdentity, pinVersion}`');
    expect(wireDoc).toContain("identity binding is approved, on 2026-10-15 at 21:23Z, as proposed");
    expect(page).toContain("This rule was approved on 2026-10-15.");
    // The pre-revision profile member appears only where it is named as refused.
    for (const doc of [declaration, wireDoc]) expect(doc).not.toMatch(/`profile: \{id, base, chainIdentity, pinVersion\}`/);
  });

  it("pins the approved record and limits current guarantees to the wire", () => {
    expect(TESTNET_PROFILE_TP1.network.identityRecord).toBe(TP1_APPROVED_IDENTITY_RECORD);
    expect(TESTNET_PROFILE_TP1.network.approvedIdentityRecordDigests).toEqual(["c4e63ad6a75207c57c9342ed2c4fe38619c2b7cba17610753fbad2d5b4cc3cbd"]);
    expect(TESTNET_PROFILE_TP1.network.refusedChainIdentities).toEqual([]);
    expect(TESTNET_PROFILE_TP1.network.status).toMatch(/record approved on 2026-10-15 at 16:41Z pinned/);
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

describe("conformance/tp1-register.json", () => {
  it("is the proposed TP-1 seed: L1-L4 and G1-G11, the declaration and base of TESTNET_PROFILE_TP1", () => {
    const register = JSON.parse(readFileSync(new URL("../../conformance/tp1-register.json", import.meta.url), "utf8"));
    expect(register.profile).toBe(TESTNET_PROFILE_TP1.id);
    expect(register.revision).toBe(TESTNET_PROFILE_TP1.revision);
    expect(register.identityBinding.tuple).toEqual({ id: TESTNET_PROFILE_TP1.id, revision: TESTNET_PROFILE_TP1.revision, base: TESTNET_PROFILE_TP1.base.commit });
    expect(register.identityBinding.rule).toBe(TESTNET_PROFILE_TP1.identityBinding.rule);
    expect(register.identityBinding.status).toBe(TESTNET_PROFILE_TP1.identityBinding.status);
    expect(register.status).toBe("proposed; composition qualification pending");
    expect(register.declaration).toBe(TESTNET_PROFILE_TP1.declaration);
    expect(register.relationToStandard).toBe(TESTNET_PROFILE_TP1.relationToStandard);
    expect(register).not.toHaveProperty("adoption");
    expect(TESTNET_PROFILE_TP1).not.toHaveProperty("adoption");
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[] };
    for (const f of ["docs/testnet-profile-tp1.md", "docs/about-the-testnet-release.md", "conformance/tp1-register.json"]) {
      expect(manifest.files).toContain(f);
    }
    // Installed readers get only what `files` ships, so every relative link in these documents must resolve to it.
    const shipped = new Set(manifest.files);
    for (const doc of ["docs/testnet-profile-tp1.md", "docs/about-the-testnet-release.md", "docs/dacs-seller-http-v1.md", "README.md"]) {
      expect(manifest.files).toContain(doc);
      const text = readFileSync(new URL(`../../${doc}`, import.meta.url), "utf8");
      const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!.split("#")[0]!).filter((t) => t !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(t));
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(shipped.has(posix.normalize(posix.join(posix.dirname(doc), target))), `${doc} links ${target}`).toBe(true);
      }
    }
    expect(register.network.record).toEqual(TP1_APPROVED_IDENTITY_RECORD);
    expect(register.network.canonicalDigest).toBe(TESTNET_PROFILE_TP1.network.approvedIdentityRecordDigests[0]);
    expect(register.network.composition).toContain("broadcast refusal is not checked");
    expect(register.base).toEqual({ repo: "DACS-Standard", commit: TESTNET_PROFILE_TP1.base.commit, status: "proposed reference revision; composition qualification pending" });
    expect(register.rows.map((row: { id: string }) => row.id)).toEqual(["L1", "L2", "L3", "L4", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11"]);
    // Evidence is public ({repo, commit, path, lines} in a public repository) or
    // a private {source, provenance} reference; pinnedBy names files in this repository.
    const evidenceOk = (e: Record<string, unknown>) => {
      if ("provenance" in e) {
        expect(Object.keys(e).sort()).toEqual(["provenance", "source"]);
        expect(e.provenance).toMatch(/^prov-\d{2}$/);
        expect(e.source).toBe("plugin implementation (not public)");
      } else {
        expect(Object.keys(e).sort()).toEqual(["commit", "lines", "path", "repo"]);
        expect(["dacs-sdk", "DACS-Standard"]).toContain(e.repo);
      }
    };
    const pinnedOk = (paths: unknown) => {
      for (const path of (paths ?? []) as string[]) expect(() => readFileSync(new URL(`../../${path}`, import.meta.url)), path).not.toThrow();
    };
    for (const row of register.rows) {
      expect(Object.keys(row)).toEqual(expect.arrayContaining(["id", "kind", "summary", "evidence", "tp1", "classification", "label", "closedBy", "blocksPublication", "status"]));
      for (const e of row.evidence) evidenceOk(e);
      pinnedOk(row.pinnedBy);
      // closedBy describes the closing work itself: no reference into a plan outside this repository.
      expect(row.closedBy).not.toMatch(/\b(?:[STUHOIW]|DEC|SB|WS|WF|WT)-\d+\b/);
    }
    for (const q of register.qualification) { for (const e of q.evidence) evidenceOk(e); pinnedOk(q.pinnedBy); }
    for (const e of register.network.neverUsedAsPinEvidence.evidence) evidenceOk(e);
    pinnedOk(register.network.neverUsedAsPinEvidence.pinnedBy);
    expect(register.identityBinding.pinnedBy.length).toBeGreaterThan(0);
    pinnedOk(register.identityBinding.pinnedBy);
    for (const s of register.sources) {
      if ("provenance" in s) evidenceOk(s);
      else expect(["dacs-sdk", "DACS-Standard"]).toContain(s.repo);
    }
    expect(register.nature).not.toMatch(/\bplan\b/);
    expect(register.qualification.every((q: { result: string }) => q.result === "not checked")).toBe(true);
  });

  it("L2 and G10 state the included-status false-success risk and give the executed-payment check and the hold as intended only", () => {
    const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const register = JSON.parse(text("conformance/tp1-register.json"));
    const row = (id: string) => register.rows.find((r: { id: string }) => r.id === id) as Record<string, string>;
    const declaration = text("docs/testnet-profile-tp1.md");
    const page = text("docs/about-the-testnet-release.md");
    for (const id of ["L2", "G10"]) {
      expect(row(id).label, id).toMatch(/^Intended, pending the SDK's executed-payment check and composition qualification: "/);
      expect(row(id).tp1, id).toMatch(/^Intended behaviour, pending /);
      expect(row(id).tp1, id).toMatch(/Current behaviour[^.]* returned as success/);
      expect(declaration, `declaration ${id} label`).toContain(`| ${row(id).label} |`);
      expect(page, `page ${id} label`).toContain(`| ${row(id).label} |`);
    }
    expect(row("L2").tp1).toContain("This statement covers only the buyer rail");
    expect(register.qualification.some((q: { subject: string; result: string }) => q.subject.includes("seller pay-dem observer") && q.result === "not checked")).toBe(true);
    expect(declaration).toContain("This statement covers only the buyer rail");
    expect(page).toContain("The seller observer is separately not checked");
    expect(row("G10").summary).toMatch(/^A failed pay-dem transfer reported as `included` would be returned as success/);
    expect(row("G10").tp1).toMatch(/does not present it as an implemented protection until an effect-path test proves it/);
    expect(page.slice(0, page.indexOf("\n## "))).toMatch(/\*\*Known problem: a failed payment can be reported as paid\.\*\*/);
  });
});

describe("import closure", () => {
  it("loads no optional peer, substrate, rail, storage or network module", () => {
    const seen = new Set<string>(), external = new Set<string>();
    const visit = (url: URL) => {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      for (const [, spec] of readFileSync(url, "utf8").matchAll(/(?:^|\n)(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)) {
        if (spec!.startsWith(".")) visit(new URL(spec!.replace(/\.js$/, ".ts"), url));
        else external.add(spec!);
      }
    };
    visit(new URL("../../src/wire/index.ts", import.meta.url));
    expect([...external].sort()).toEqual(["node:crypto", "node:util"]);
    expect([...seen].map((href) => href.replace(/^.*\/src\//, "")).sort()).toEqual([
      "canonical/hash.ts", "canonical/jcs.ts", "canonical/rawJson.ts", "canonical/snapshot.ts", "crypto/ed25519.ts", "errors.ts",
      "negotiate/jobId.ts", "wire/approval.ts", "wire/delegation.ts", "wire/discovery.ts", "wire/envelope.ts", "wire/index.ts", "wire/profile.ts",
      "wire/response.ts", "wire/routes.ts", "wire/validate.ts",
    ]);
  });
});

describe("package export", () => {
  it("adds ./wire and leaves every existing export as it was", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./wire"]).toEqual({ types: "./dist/wire/index.d.ts", import: "./dist/wire/index.js" });
    expect(Object.keys(pkg.exports)).toEqual([".", "./canonical", "./crypto", "./artifacts", "./identity", "./discovery", "./negotiate", "./rails", "./seller", "./commerce", "./registry", "./cli", "./substrate", "./wire"]);
  });

  it("ships no approval injection: approval.ts holds only the frozen approval list, and only profile.ts reads it", () => {
    expect(Object.keys(approvalModule)).toEqual(["TP1_APPROVED_IDENTITY_RECORD_DIGESTS"]);
    expect(approvalModule.TP1_APPROVED_IDENTITY_RECORD_DIGESTS).toEqual(TESTNET_PROFILE_TP1.network.approvedIdentityRecordDigests);
    expect(Object.isFrozen(approvalModule.TP1_APPROVED_IDENTITY_RECORD_DIGESTS)).toBe(true);
    expect(wireExports.TP1_APPROVED_IDENTITY_RECORD_DIGESTS).toBe(approvalModule.TP1_APPROVED_IDENTITY_RECORD_DIGESTS);
    // Every function profile.ts exports is public through ./wire: none takes an approval list.
    for (const [name, value] of Object.entries(profileModule)) {
      if (typeof value === "function") expect((wireExports as Record<string, unknown>)[name], name).toBe(value);
    }
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    for (const [key, target] of Object.entries(pkg.exports)) {
      expect(key).not.toContain("*");
      expect(JSON.stringify(target)).not.toMatch(/dist\/wire\/(?!index\.)/);
    }
    // Shipped code and the packages that will consume ./wire (src/, packages/)
    // and the scripts: only profile.ts imports the approval module, and nothing
    // names a test approval. Tests replace the module (test/wire/testApproval.ts).
    const files = (dir: URL): URL[] => (readdirSync(dir, { withFileTypes: true }) as Dirent[])
      .filter((entry) => !["node_modules", "dist", ".git"].includes(entry.name))
      .flatMap((entry) => (entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : /\.(ts|mts|mjs|js)$/.test(entry.name) ? [new URL(entry.name, dir)] : []));
    const root = new URL("../../", import.meta.url);
    const scanned = ["src/", "packages/", "scripts/"].flatMap((dir) => files(new URL(dir, root)));
    expect(scanned.length).toBeGreaterThan(100);
    const rel = (url: URL) => url.href.slice(root.href.length);
    expect(scanned.filter((url) => /(?:from\s*|import\(\s*)["'][^"']*\bapproval(?:\.[jt]s)?["']/.test(readFileSync(url, "utf8"))).map(rel)).toEqual(["src/wire/profile.ts"]);
    expect(scanned.filter((url) => /UnderTestApproval|withTestApproval/.test(readFileSync(url, "utf8"))).map(rel)).toEqual([]);
  });
});
