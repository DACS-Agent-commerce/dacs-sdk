// Route table, limits, signing domains and the TP-1 record of @kynesyslabs/dacs/wire.
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

import { COMPOSITE_DOMAIN_SEPARATORS, SIGNATURE_DOMAIN_SEPARATORS } from "../../src/crypto/index.js";
import {
  DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_ROUTES,
  findDacsSellerHttpRoute, isReadRoute, TESTNET_PROFILE_TP1, TP1_CAPABILITIES, TP1_DECLARATION, TP1_APPROVED_IDENTITY_RECORD,
  TP1_PROFILE_REVISIONS, TP1_WIRE_PROFILE_KEYS, WireError,
} from "../../src/wire/index.js";
import * as wireExports from "../../src/wire/index.js";
import * as approvalModule from "../../src/wire/approval.js";
import * as profileModule from "../../src/wire/profile.js";
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
  it("are declared as a SIG-4 question for the Standard (G12), not as registered or dacs-x- domains", () => {
    const register = JSON.parse(readFileSync(new URL("../../conformance/tp1-register.json", import.meta.url), "utf8"));
    const g12 = register.rows.find((row: { id: string }) => row.id === "G12");
    expect(g12.evidence).toEqual([
      { repo: "DACS-Standard", commit: "d45c0a2", path: "spec/CORE.md", lines: "487" },
      { repo: "DACS-Standard", commit: "d45c0a2", path: "spec/CORE.md", lines: "590" },
      { repo: "DACS-Standard", commit: "d45c0a2", path: "spec/CORE.md", lines: "598" },
    ]);
    expect(g12.summary).toContain("SIG-4");
    // B.7 signs separator ‖ artifact_hash and forbids signing the canonical form; the wire signs domain ‖ canonical(payload).
    expect(g12.summary).toContain("domain ‖ canonical(payload)");
    expect(g12.closedBy).toContain("sha256hex(canonical(payload))");
    const vendored = new URL("../../vendor/DACS-Standard/spec/CORE.md", import.meta.url);
    if (existsSync(vendored)) {
      expect(readFileSync(vendored, "utf8").split("\n")[597]).toContain("MUST NOT compute a signature over the canonical form directly");
    }
    expect(g12.status).toBe("open");
    for (const domain of Object.values(DACS_SELLER_HTTP_DOMAINS)) {
      expect(domain.startsWith("dacs-x-")).toBe(false);
      expect(g12.summary).toContain("dacs-seller-http:v1:{request,response,delegation,discovery}:");
    }
    expect(readFileSync(new URL("../../docs/dacs-seller-http-v1.md", import.meta.url), "utf8")).toContain("records it as G12");
    expect(readFileSync(new URL("../../docs/testnet-profile-tp1.md", import.meta.url), "utf8")).toContain("| G12 |");
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

describe("conformance/tp1-register.json", () => {
  it("is the proposed TP-1 seed: L1-L4 and G1-G12, the declaration and base of TESTNET_PROFILE_TP1", () => {
    const register = JSON.parse(readFileSync(new URL("../../conformance/tp1-register.json", import.meta.url), "utf8"));
    expect(register.profile).toBe(TESTNET_PROFILE_TP1.id);
    expect(register.revision).toBe(TESTNET_PROFILE_TP1.revision);
    expect(register.identityBinding.tuple).toEqual({ id: TESTNET_PROFILE_TP1.id, revision: TESTNET_PROFILE_TP1.revision, base: TESTNET_PROFILE_TP1.base.commit });
    expect(register.tuple).toEqual(TESTNET_PROFILE_TP1.tuple);
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
      const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!.split("#")[0]!).filter((t) => t !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(t)).filter((t) => doc !== "README.md" || ["./docs/about-the-testnet-release.md", "./docs/testnet-profile-tp1.md", "docs/testnet-profile-tp1.md"].includes(t));
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        const resolved = posix.normalize(posix.join(posix.dirname(doc), target));
        expect([...shipped].some(file => resolved === file || resolved.startsWith(file + "/")), `${doc} links ${target}`).toBe(true);
      }
    }
    expect(register.network.record).toEqual(TP1_APPROVED_IDENTITY_RECORD);
    expect(register.network.canonicalDigest).toBe(TESTNET_PROFILE_TP1.network.approvedIdentityRecordDigests[0]);
    expect(register.network.composition).toContain("broadcast refusal is not checked");
    expect(register.base).toEqual({ repo: "DACS-Standard", commit: TESTNET_PROFILE_TP1.base.commit, status: "proposed reference revision; composition qualification pending" });
    expect(register.rows.map((row: { id: string }) => row.id)).toEqual(["L1", "L2", "L3", "L4", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12"]);
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
    // Node built-ins only. node:child_process qualifies journal restart publication; node:fs and node:path
    // access the local journal and its restart probe (journal.ts, journalRestart.ts). node:net
    // and node:url only parse claim hosts (identity/domainHost.ts: isIP, domainToASCII) for the Agreement validator (CA-7).
    expect([...external].sort()).toEqual(["node:child_process", "node:crypto", "node:fs", "node:net", "node:path", "node:url", "node:util"]);
    // The boundary, not an exact file list: a pure module main adds under these directories (as #357's
    // canonical/jid1Addressing.ts) stays inside it; a rail, substrate, storage or negotiation module does not.
    // The one exception is the SDK's own DACS-3 §8.5.2 verifier (validateFixedPriceAgreementBinding) a continuation
    // runs, and the pure modules it loads: its pricing, RFQ and pay-alternative (APR-3) checks. None does I/O; the
    // built-in list above is unchanged.
    const modules = [...seen].map((href) => href.replace(/^.*\/src\//, ""));
    const allowed = /^(?:artifacts|canonical|crypto|identity|wire)\/[A-Za-z0-9]+\.ts$|^negotiate\/(?:jobId|commitment|fixedPrice|rfq|channel)\.ts$|^rails\/payAlternative\.ts$|^errors\.ts$/;
    expect(modules.filter((module) => !allowed.test(module))).toEqual([]);
    for (const module of ["wire/index.ts", "wire/journal.ts", "wire/commitment.ts", "canonical/rawJson.ts", "artifacts/validators.ts", "negotiate/jobId.ts", "negotiate/commitment.ts"]) {
      expect(modules, module).toContain(module);
    }
    const fileUsers = [...seen].filter((href) => /from\s+["']node:(fs|path)["']/.test(readFileSync(new URL(href), "utf8")));
    expect(fileUsers.map((href) => href.replace(/^.*\/src\//, ""))).toEqual(["wire/journal.ts", "wire/journalRestart.ts"]);
  });
});

describe("package export", () => {
  it("adds ./wire and leaves every existing export as it was", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./wire"]).toEqual({ types: "./dist/wire/index.d.ts", import: "./dist/wire/index.js" });
    expect(Object.keys(pkg.exports)).toEqual([".", "./canonical", "./crypto", "./artifacts", "./identity", "./discovery", "./negotiate", "./rails", "./seller", "./commerce", "./registry", "./cli", "./substrate", "./wire"]);
  });

  it("ships no approval injection: approval.ts holds only the frozen approval list, and only profile.ts reads it", () => {
    expect(Object.keys(approvalModule)).toEqual(["TP1_APPROVED_IDENTITY_RECORD_DIGESTS", "TP1_REFUSED_CHAIN_IDENTITIES"]);
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
