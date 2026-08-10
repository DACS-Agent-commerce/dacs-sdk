import { describe, expect, test } from "vitest";

import {
  selfSignedAssertionAddress,
  selfSignedAssertionBytes,
  vetCore,
  type VetDeps,
  type VetRequest,
} from "../../src/agent/vetCore.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import { parseCciRecord } from "../../src/identity/cci.js";
import type { RecipeDescriptor } from "../../src/registry/types.js";

function recipe(over: Partial<RecipeDescriptor>): RecipeDescriptor {
  return { id: "r", method: "self-signed", availability: "live", params: {}, ...over };
}

const deps = (proxyStatus = 200): VetDeps => ({
  proxyFetch: async () => ({ status: proxyStatus, responseHash: "0xhash", body: "" }),
  now: () => "2026-01-01T00:00:00Z",
});

const SELF_SEED = Uint8Array.from(Buffer.alloc(32, 7));
const OTHER_SEED = Uint8Array.from(Buffer.alloc(32, 8));
const SELF_SUBJECT = `key:${Buffer.from(rawPublicKey(publicKeyFromSeed(SELF_SEED))).toString("hex")}`;
const OTHER_SUBJECT = `key:${Buffer.from(rawPublicKey(publicKeyFromSeed(OTHER_SEED))).toString("hex")}`;
const PROOF_HASH = "a".repeat(64);
const ATTESTATION = {
  kind: "storage-program",
  id: "stor-self-signed-assertion",
  contentHash: PROOF_HASH,
} as const;

function signatureFor(assertion: string, seed = SELF_SEED): string {
  return Buffer.from(
    ed25519Sign(selfSignedAssertionBytes(assertion), privateKeyFromSeed(seed)),
  ).toString("hex");
}

function selfSignedRequest(
  over: Partial<VetRequest> = {},
): VetRequest {
  return {
    subject: SELF_SUBJECT,
    recipe: recipe({ id: "self-signed", method: "self-signed" }),
    recipeVersion: "1",
    jobId: "job-vet-1",
    selfSigned: {
      assertion: SELF_SUBJECT,
      signature: signatureFor(SELF_SUBJECT),
    },
    ...over,
  };
}

function selfSignedDeps(
  anchor: NonNullable<VetDeps["anchorSelfSignedAssertion"]> = async () => ({
    ...ATTESTATION,
  }),
): VetDeps {
  return { ...deps(), anchorSelfSignedAssertion: anchor };
}

describe("vetCore (DACS-2 Vet stage)", () => {
  test("self-signed verifies key possession and records anchored evidence", async () => {
    let anchored: Parameters<NonNullable<VetDeps["anchorSelfSignedAssertion"]>>[0] | undefined;
    const cvr = await vetCore(
      selfSignedRequest(),
      selfSignedDeps(async (input) => {
        anchored = input;
        return ATTESTATION;
      }),
    );

    expect(cvr).toMatchObject({
      subject: SELF_SUBJECT,
      recipeId: "self-signed",
      decision: "pass",
    });
    expect(cvr.results).toEqual([
      {
        claimRef: SELF_SUBJECT,
        method: "self-signed",
        status: "pass",
        authority: SELF_SUBJECT,
        attestation: ATTESTATION,
      },
    ]);
    expect(anchored).toEqual({
      logicalAddress: selfSignedAssertionAddress("job-vet-1", SELF_SUBJECT, "1"),
      subject: SELF_SUBJECT,
      assertion: SELF_SUBJECT,
      signature: signatureFor(SELF_SUBJECT),
    });
  });

  test("self-signed missing proof input is error, never pass", async () => {
    const cvr = await vetCore(
      selfSignedRequest({ selfSigned: undefined }),
      selfSignedDeps(),
    );
    expect(cvr.decision).toBe("error");
  });

  test("self-signed rejects malformed and non-canonical key ClaimReferences", async () => {
    for (const subject of [
      "did:demos:agent:" + "a".repeat(64),
      "key:0x" + "a".repeat(64),
      "key:" + "A".repeat(64),
      "key:abcd",
    ]) {
      const cvr = await vetCore(
        selfSignedRequest({ subject }),
        selfSignedDeps(),
      );
      expect(cvr.decision).toBe("error");
    }
    expect(() =>
      selfSignedAssertionBytes(`${SELF_SUBJECT}?z=last&a=first`),
    ).toThrow(/canonical key/);
    expect(() =>
      selfSignedAssertionBytes(`${SELF_SUBJECT}?purpose=bad%3avalue`),
    ).toThrow(/canonical key/);
  });

  test("self-signed malformed signature input is error", async () => {
    const cvr = await vetCore(
      selfSignedRequest({
        selfSigned: { assertion: SELF_SUBJECT, signature: "not-a-signature" },
      }),
      selfSignedDeps(),
    );
    expect(cvr.decision).toBe("error");
  });

  test("self-signed signature from the wrong key is fail", async () => {
    const cvr = await vetCore(
      selfSignedRequest({
        selfSigned: {
          assertion: SELF_SUBJECT,
          signature: signatureFor(SELF_SUBJECT, OTHER_SEED),
        },
      }),
      selfSignedDeps(),
    );
    expect(cvr.decision).toBe("fail");
    expect(cvr.results[0]!.attestation).toEqual(ATTESTATION);
  });

  test("self-signed assertion replayed for another claim is fail", async () => {
    const cvr = await vetCore(
      selfSignedRequest({
        subject: OTHER_SUBJECT,
        selfSigned: {
          assertion: SELF_SUBJECT,
          signature: signatureFor(SELF_SUBJECT),
        },
      }),
      selfSignedDeps(),
    );
    expect(cvr.decision).toBe("fail");
  });

  test("self-signed compares CF-3 identity without dropping signed parameters", async () => {
    const assertion = `${SELF_SUBJECT}?purpose=vet&region=GB`;
    const cvr = await vetCore(
      selfSignedRequest({
        selfSigned: { assertion, signature: signatureFor(assertion) },
      }),
      selfSignedDeps(),
    );
    expect(cvr.decision).toBe("pass");
  });

  test("self-signed raw or cross-domain signatures do not verify", async () => {
    const rawSignature = Buffer.from(
      ed25519Sign(Buffer.from(SELF_SUBJECT), privateKeyFromSeed(SELF_SEED)),
    ).toString("hex");
    const cvr = await vetCore(
      selfSignedRequest({
        selfSigned: { assertion: SELF_SUBJECT, signature: rawSignature },
      }),
      selfSignedDeps(),
    );
    expect(cvr.decision).toBe("fail");
  });

  test("self-signed SR-2 failure or malformed proof is error", async () => {
    const unavailable = await vetCore(
      selfSignedRequest(),
      selfSignedDeps(async () => {
        throw new Error("substrate unavailable");
      }),
    );
    expect(unavailable.decision).toBe("error");

    const malformed = await vetCore(
      selfSignedRequest(),
      selfSignedDeps(async () => ({
        kind: "storage-program",
        id: "stor-self-signed-assertion",
        contentHash: "not-a-hash",
      })),
    );
    expect(malformed.decision).toBe("error");
  });

  test("consensus-backed-proxy passes on a 2xx body matching its signed rules", async () => {
    const cvr = await vetCore(
      {
        subject: "domain:alice.example",
        recipe: recipe({
          id: "domain-acme",
          method: "consensus-backed-proxy",
          params: { authorityUrl: "https://alice.example/.well-known/dacs" },
          parserRules: { format: "raw", matcher: "^$" },
        }),
      },
      deps(200),
    );
    expect(cvr.decision).toBe("pass");
    expect(cvr.results[0]).toMatchObject({
      method: "consensus-backed-proxy",
      status: "pass",
      authority: "https://alice.example/.well-known/dacs",
      // R5: the DAHR attestation is recorded on the entry as evidence.
      responseHash: "0xhash",
    });
  });

  test("consensus-backed-proxy fails on a non-2xx", async () => {
    const cvr = await vetCore(
      {
        subject: "domain:alice.example",
        recipe: recipe({ method: "consensus-backed-proxy", params: { authorityUrl: "https://x/y" } }),
      },
      deps(404),
    );
    expect(cvr.decision).toBe("fail");
    expect(cvr.results[0]!.status).toBe("fail");
  });

  // #16/#49 — a signed ParserSpec drives a DETERMINISTIC content verdict from the
  // DAHR-attested body (PSP-1..5), evaluated by the default json/raw engine.
  const bodyDeps = (body: string, complete?: boolean): VetDeps => ({
    proxyFetch: async () => ({ status: 200, responseHash: "0xhash", body, ...(complete !== undefined ? { complete } : {}) }),
    now: () => "2026-01-01T00:00:00Z",
  });
  const proxyRecipe = (over: Partial<RecipeDescriptor>) =>
    recipe({ method: "consensus-backed-proxy", params: { authorityUrl: "https://x/y" }, ...over });
  const req = (over: Partial<RecipeDescriptor>) => ({
    subject: "did:demos:agent:alice",
    recipe: proxyRecipe(over),
  });

  test("ParserSpec positive-match: JSONPath match ⇒ pass, no match ⇒ fail (PSP-1/2)", async () => {
    const rules: RecipeDescriptor["parserRules"] = { format: "json", successJsonPath: "$.login" };
    expect(
      (await vetCore(req({ parserRules: rules }), bodyDeps(JSON.stringify({ login: "alice" })))).decision,
    ).toBe("pass");
    expect(
      (await vetCore(req({ parserRules: rules }), bodyDeps(JSON.stringify({ other: 1 })))).decision,
    ).toBe("fail");
    // Evidence is still recorded.
    const r = await vetCore(req({ parserRules: rules }), bodyDeps(JSON.stringify({ login: "alice" })));
    expect(r.results[0]!.responseHash).toBe("0xhash");
  });

  test("ParserSpec negative-match: a match ⇒ fail (listed), no match ⇒ pass (PSP-2)", async () => {
    const rules: RecipeDescriptor["parserRules"] = { format: "json", successJsonPath: "$.listed" };
    const opts = { parserRules: rules, negativeMatch: true };
    expect(
      (await vetCore(req(opts), bodyDeps(JSON.stringify({ listed: true })))).decision,
    ).toBe("fail");
    expect(
      (await vetCore(req(opts), bodyDeps(JSON.stringify({ clean: true })))).decision,
    ).toBe("pass");
  });

  test("ParserSpec indeterminateOn is evaluated BEFORE the match ⇒ indeterminate (PSP-2)", async () => {
    const rules: RecipeDescriptor["parserRules"] = {
      format: "json",
      successJsonPath: "$.login",
      indeterminateOn: [{ jsonPath: "$.pending" }],
      dataMap: { status: "$.status" },
    };
    const cvr = await vetCore(
      req({ parserRules: rules }),
      bodyDeps(JSON.stringify({ login: "alice", pending: true, status: "LAPSED" })),
    );
    expect(cvr.decision).toBe("indeterminate");
    expect(cvr.results[0]!.data).toEqual({ status: "LAPSED" });
  });

  test("ParserSpec on a malformed body ⇒ error, never fail (PSP-2)", async () => {
    const rules: RecipeDescriptor["parserRules"] = { format: "json", successJsonPath: "$.login" };
    const cvr = await vetCore(req({ parserRules: rules }), bodyDeps("{not json"));
    expect(cvr.decision).toBe("error");
  });

  test("PSP-5: a negative-match pass on an unconfirmed-complete list ⇒ indeterminate", async () => {
    const rules: RecipeDescriptor["parserRules"] = { format: "json", successJsonPath: "$.hit" };
    const opts = { parserRules: rules, negativeMatch: true, requiresListCompleteness: true };
    // No hit (would be "not listed" = pass) but completeness unconfirmed → indeterminate.
    expect(
      (await vetCore(req(opts), bodyDeps(JSON.stringify({ records: [] }), false))).decision,
    ).toBe("indeterminate");
    // …confirmed complete → the pass stands.
    expect(
      (await vetCore(req(opts), bodyDeps(JSON.stringify({ records: [] }), true))).decision,
    ).toBe("pass");
  });

  test("a non-2xx fails first — parserRules are not consulted", async () => {
    const rules: RecipeDescriptor["parserRules"] = { format: "json", successJsonPath: "$.login" };
    const cvr = await vetCore(req({ parserRules: rules }), {
      proxyFetch: async () => ({ status: 404, responseHash: "0xhash", body: '{"login":"alice"}' }),
      now: () => "2026-01-01T00:00:00Z",
    });
    expect(cvr.decision).toBe("fail");
  });

  test("HTTP status mapping: 404 (no record) differs from 5xx (reachable error)", async () => {
    const at = (status: number, over: Partial<RecipeDescriptor> = {}) =>
      vetCore(req(over), {
        proxyFetch: async () => ({ status, responseHash: "0xhash", body: "{}" }),
        now: () => "2026-01-01T00:00:00Z",
      });
    // 404 = the authority has no record → a positive-match check FAILS…
    expect((await at(404)).decision).toBe("fail");
    // …but for a negative-match recipe a bare 404 is not a confirmed-complete
    // "not listed", so it is indeterminate (fail-closed), never a silent pass.
    expect((await at(404, { negativeMatch: true })).decision).toBe("indeterminate");
    // 5xx / other reachable errors are ERROR, not fail — the verifier couldn't
    // obtain a trustworthy determination.
    expect((await at(500)).decision).toBe("error");
    expect((await at(429)).decision).toBe("error");
  });

  test("PSP-3: the parsed dataMap is persisted on the VerifyResult", async () => {
    const rules: RecipeDescriptor["parserRules"] = {
      format: "json",
      successJsonPath: "$.status",
      dataMap: { status: "$.status", id: "$.id" },
    };
    const cvr = await vetCore(
      req({ parserRules: rules }),
      bodyDeps(JSON.stringify({ status: "ISSUED", id: "abc" })),
    );
    expect(cvr.results[0]!.data).toEqual({ status: "ISSUED", id: "abc" });
  });

  test("PSP-3 preserves structured dataMap values on the VerifyResult", async () => {
    const rules: RecipeDescriptor["parserRules"] = {
      format: "json",
      successJsonPath: "$.status",
      dataMap: { active: "$.active", count: "$.count", details: "$.details" },
    };
    const cvr = await vetCore(
      req({ parserRules: rules }),
      bodyDeps(
        JSON.stringify({
          status: "ISSUED",
          active: true,
          count: 3,
          details: { jurisdiction: "GB" },
        }),
      ),
    );
    expect(cvr.results[0]!.data).toEqual({
      active: true,
      count: 3,
      details: { jurisdiction: "GB" },
    });
  });

  test("missing body with parserRules is error; a present empty body may match", async () => {
    const rules: RecipeDescriptor["parserRules"] = {
      format: "raw",
      matcher: "^$",
    };
    const missing = await vetCore(req({ parserRules: rules }), {
      proxyFetch: async () => ({ status: 200, responseHash: "0xhash" }),
      now: () => "2026-01-01T00:00:00Z",
    });
    expect(missing.decision).toBe("error");
    expect(
      (await vetCore(req({ parserRules: rules }), bodyDeps(""))).decision,
    ).toBe("pass");
  });

  test("no parserRules ⇒ fail-closed error, never a status-only 2xx pass", async () => {
    const cvr = await vetCore(req({}), bodyDeps("anything"));
    expect(cvr.decision).toBe("error");
  });

  test("malformed runtime parserRules fail closed as error", async () => {
    const malformed = {
      format: "json",
      successJsonPath: "$.ok",
      indeterminateOn: "not-an-array",
    } as unknown as NonNullable<RecipeDescriptor["parserRules"]>;
    await expect(
      vetCore(
        req({ parserRules: malformed }),
        bodyDeps(JSON.stringify({ ok: true })),
      ),
    ).resolves.toMatchObject({ decision: "error" });
  });

  test("consensus-backed-proxy without an authorityUrl is rejected", async () => {
    await expect(
      vetCore(
        { subject: "s", recipe: recipe({ method: "consensus-backed-proxy", params: {} }) },
        deps(),
      ),
    ).rejects.toThrow(/authorityUrl/);
  });

  test("an unsupported method is rejected", async () => {
    await expect(
      vetCore({ subject: "s", recipe: recipe({ method: "telepathy" }) }, deps()),
    ).rejects.toThrow(/unsupported verification method/);
  });

  describe("cci-claim method (DACS-1 linked-claim vetting)", () => {
    const SUBJECT = "did:demos:agent:alice";
    const record = parseCciRecord(SUBJECT, {
      linkedSocials: { twitter: "alice" },
      linkedWallets: ["evm:0xAbC0000000000000000000000000000000000001"],
    });
    const cciDeps = (): VetDeps => ({ ...deps(), resolveCci: async () => record });

    test("passes when the subject holds the required linked claim", async () => {
      const cvr = await vetCore(
        {
          subject: SUBJECT,
          recipe: recipe({
            id: "has-x",
            method: "cci-claim",
            params: { requiredClaim: "web2:twitter:alice" },
          }),
        },
        cciDeps(),
      );
      expect(cvr.decision).toBe("pass");
      expect(cvr.results[0]).toMatchObject({
        claimRef: "web2:twitter:alice",
        method: "cci-claim",
        status: "pass",
        authority: SUBJECT,
      });
    });

    test("fails when the required claim is not in the record", async () => {
      const cvr = await vetCore(
        {
          subject: SUBJECT,
          recipe: recipe({
            method: "cci-claim",
            params: { requiredClaim: "web2:github:someone-else" },
          }),
        },
        cciDeps(),
      );
      expect(cvr.decision).toBe("fail");
      expect(cvr.results[0]!.status).toBe("fail");
    });

    test("requireProof passes when the linked claim carries an attested proof (honest `proof`, not responseHash — #31)", async () => {
      const proven = parseCciRecord(SUBJECT, {
        web2: { twitter: [{ username: "alice", proof: "https://x.com/alice/status/1" }] },
      });
      const cvr = await vetCore(
        {
          subject: SUBJECT,
          recipe: recipe({
            method: "cci-claim",
            params: { requiredClaim: "web2:twitter:alice", requireProof: true },
          }),
        },
        { ...deps(), resolveCci: async () => proven },
      );
      expect(cvr.decision).toBe("pass");
      // A raw /.well-known URL is `raw`, and it does NOT masquerade as a DAHR hash.
      expect(cvr.results[0]!.proof).toEqual({ kind: "raw", value: "https://x.com/alice/status/1" });
      expect(cvr.results[0]!.responseHash).toBeUndefined();
    });

    test("a 64-hex claim proof is classified `hash` (#31)", async () => {
      const h = "a".repeat(64);
      const proven = parseCciRecord(SUBJECT, {
        web2: { twitter: [{ username: "alice", proof: h }] },
      });
      const cvr = await vetCore(
        {
          subject: SUBJECT,
          recipe: recipe({
            method: "cci-claim",
            params: { requiredClaim: "web2:twitter:alice", requireProof: true },
          }),
        },
        { ...deps(), resolveCci: async () => proven },
      );
      expect(cvr.results[0]!.proof).toEqual({ kind: "hash", value: h });
      expect(cvr.results[0]!.responseHash).toBeUndefined();
    });

    test("requireProof fails a claim that is asserted but carries no proof", async () => {
      // `record` (flat linkedSocials) has the claim but no attached proof.
      const cvr = await vetCore(
        {
          subject: SUBJECT,
          recipe: recipe({
            method: "cci-claim",
            params: { requiredClaim: "web2:twitter:alice", requireProof: true },
          }),
        },
        cciDeps(),
      );
      expect(cvr.decision).toBe("fail");
    });

    test("rejects a cci-claim recipe with no requiredClaim", async () => {
      await expect(
        vetCore(
          { subject: SUBJECT, recipe: recipe({ method: "cci-claim", params: {} }) },
          cciDeps(),
        ),
      ).rejects.toThrow(/requiredClaim/);
    });

    test("rejects when resolveCci isn't wired", async () => {
      await expect(
        vetCore(
          {
            subject: SUBJECT,
            recipe: recipe({
              method: "cci-claim",
              params: { requiredClaim: "web2:twitter:alice" },
            }),
          },
          deps(), // no resolveCci
        ),
      ).rejects.toThrow(/resolveCci/);
    });
  });

  describe("ofac-screen method (DAHR sanctions screening of linked wallets)", () => {
    const SUBJECT = "did:demos:agent:alice";
    const EVM = "0xAbC0000000000000000000000000000000000001";
    const SOL = "So1anaAddr11111111111111111111111111111";
    const record = parseCciRecord(SUBJECT, {
      linkedWallets: [`evm:${EVM}`, `solana:${SOL}`],
    });
    const ofacRecipe = recipe({
      id: "ofac",
      method: "ofac-screen",
      params: { screeningUrlTemplate: "https://screen.example/ofac?a={address}" },
    });
    // proxyFetch that returns { listed } per address; `listedAddrs` are sanctioned.
    const ofacDeps = (opts: { listedAddrs?: string[]; status?: number } = {}): VetDeps => ({
      now: () => "2026-01-01T00:00:00Z",
      resolveCci: async () => record,
      proxyFetch: async ({ url }) => {
        const listed = (opts.listedAddrs ?? []).some((a) => url.includes(encodeURIComponent(a)));
        return {
          status: opts.status ?? 200,
          responseHash: "0xhash",
          body: JSON.stringify({ listed }),
        };
      },
    });

    test("passes when every linked wallet screens clean", async () => {
      const cvr = await vetCore({ subject: SUBJECT, recipe: ofacRecipe }, ofacDeps());
      expect(cvr.decision).toBe("pass");
      expect(cvr.results).toHaveLength(2);
      expect(cvr.results.every((r) => r.status === "pass")).toBe(true);
      // R5: each screened result records the DAHR attestation.
      expect(cvr.results.every((r) => r.responseHash === "0xhash")).toBe(true);
    });

    test("fails when any linked wallet is sanctioned", async () => {
      const cvr = await vetCore(
        { subject: SUBJECT, recipe: ofacRecipe },
        ofacDeps({ listedAddrs: [EVM] }),
      );
      expect(cvr.decision).toBe("fail");
      const evmResult = cvr.results.find((r) => r.claimRef === `xm:evm:${EVM}`);
      expect(evmResult!.status).toBe("fail");
    });

    test("indeterminate (never a silent pass) when a wallet can't be screened", async () => {
      const cvr = await vetCore(
        { subject: SUBJECT, recipe: ofacRecipe },
        ofacDeps({ status: 503 }),
      );
      expect(cvr.decision).toBe("indeterminate");
    });

    test("indeterminate when the subject has no linked wallets", async () => {
      const cvr = await vetCore(
        { subject: SUBJECT, recipe: ofacRecipe },
        { ...ofacDeps(), resolveCci: async () => parseCciRecord(SUBJECT, {}) },
      );
      expect(cvr.decision).toBe("indeterminate");
      expect(cvr.results[0]!.method).toBe("ofac-screen");
    });

    test("rejects a recipe without a valid screeningUrlTemplate", async () => {
      await expect(
        vetCore(
          { subject: SUBJECT, recipe: recipe({ method: "ofac-screen", params: {} }) },
          ofacDeps(),
        ),
      ).rejects.toThrow(/screeningUrlTemplate/);
    });

    test("rejects when resolveCci isn't wired", async () => {
      await expect(
        vetCore({ subject: SUBJECT, recipe: ofacRecipe }, deps()),
      ).rejects.toThrow(/resolveCci/);
    });
  });
});
