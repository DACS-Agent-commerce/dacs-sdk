import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertPositiveAmount,
  attestationAddress,
  bundleAddress,
  canonicalSignedScope,
  canonicalize,
  canonicalizeDecimal,
  contentHash,
  decodeAddressSegment,
  encodeAddressSegment,
  listingAddress,
  paymentEvidenceAddress,
  ratingAddress,
  sha256Hex,
} from "../../src/canonical/index.js";
import {
  SIGNATURE_DOMAIN_SEPARATORS,
  dacsXSeparator,
  ed25519Verify,
  isRegisteredSeparator,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signArtifact,
  verifyArtifact,
  type DomainSeparator,
} from "../../src/crypto/index.js";
import { verifyBundleCore } from "../../src/agent/verifyBundleCore.js";
import {
  bundleConsistency,
  type BundleCopies,
} from "../../src/agent/bundleConsistency.js";
import { attestationBundleHash } from "../../src/agent/twoSidedBundle.js";
import { deriveReputation } from "../../src/agent/reputationDerivation.js";
import { verifySettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";
import { BUNDLE_OUTCOMES, perspectiveFlip } from "../../src/agent/bundleSemantics.js";
import { compositeVerificationAddress } from "../../src/agent/index.js";
import {
  assignSealedEnvelopeRoles,
  buildSealedAgreement,
  makeCommitment,
  resolveSealedEnvelopeMode,
  runSealedEnvelopeCore,
  validateSealedAgreementForCommit,
  validateSealedAgreementRoleAssignment,
  type AnchoredCommit,
  type AnchoredReveal,
  type SealedBid,
  type SelectionRule,
} from "../../src/negotiate/index.js";
import {
  deriveIdentityTier,
  type BundleClaimLike,
} from "../../src/identity/tier.js";
import type {
  AnyAttestationBundle,
  AttestationBundle,
} from "../../src/artifacts/types.js";
import {
  isAttestationRef,
  isChainTxRef,
} from "../../src/artifacts/index.js";
import type { LegacyMvpAgreementDocument as AgreementDocument } from "../../src/artifacts/legacyMvp.js";

/**
 * DACS-Standard §14 conformance — the manifest-driven harness (#6).
 *
 * Every GOLDEN MANIFEST.json case whose data maps onto an exported SDK surface
 * is REPLAYED here: the case's pinned `want` is asserted against the SDK's
 * actual output (inputs come from the vendored fixtures / vectors/golden.json,
 * or — for primitive cases — from the exact inputs used by the reference
 * generator). Candidate cases are never promoted locally: they stay visible as
 * `it.todo` with the upstream reason until the Standard regenerates and promotes
 * them. Golden cases whose inputs are not shipped, or whose subject surface the
 * SDK does not export yet, likewise stay visible as reasoned todos — never as
 * vacuous assertions.
 *
 * Known divergences are pinned with `it.fails` (the vector expectation is
 * asserted and expected to fail against today's SDK) so a fix flips them loudly.
 */

const VENDOR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard",
);
const MANIFEST = join(VENDOR, "conformance/MANIFEST.json");
const haveVectors = existsSync(MANIFEST);

interface ManifestCase {
  id: string;
  area: string;
  spec: string;
  summary: string;
  status: string;
  reason: string;
  want: unknown;
}

type Runner = (want: never) => void | Promise<void>;

const read = (rel: string) =>
  JSON.parse(readFileSync(join(VENDOR, rel), "utf8")) as Record<string, unknown>;
const b64u = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

describe("DACS-Standard §14 conformance vectors (manifest-driven)", () => {
  if (!haveVectors) {
    it.skip("vectors not synced — run `npm run conformance:sync`", () => {});
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    dacsVersion: string;
    cases: ManifestCase[];
  };
  const golden = read("conformance/vectors/golden.json") as {
    signing: {
      seed: string;
      separator: string;
      doc: Record<string, unknown>;
      signature: string;
      publicKeyHex: string;
    };
    identityTier: {
      cases: Array<{ id: string; fixture?: string; expected: string }>;
    };
    addressing: {
      cf4: { input: string; encoded: string; decoded: string };
    };
    bundle: {
      fixture: string;
      bundleHash: string;
      seeds: Record<string, string>;
      divergentSellerFixture: string;
      divergentSeller: { bundleHash: string; decision: string; outcome: string };
      htlc9Fixture: string;
      htlc9: {
        bundleHash: string;
        decision: string;
        settlementPhase: { kind: string; outcome: string; errorClass: string; revealTxRef: string };
      };
    };
    settlement: { seeds: Record<string, string>; publicKeys: Record<string, string> };
    verify: { seeds: Record<string, string> };
  } & Record<string, unknown>;
  const referenceShapes = read(
    "conformance/vectors/security/artifact-reference-shapes-v0.1.json",
  ) as unknown as {
    count: number;
    vectors: Array<{
      name: string;
      type: "AttestationRef" | "ChainTxRef";
      expected: "pass" | "fail";
      value: unknown;
    }>;
  };

  it("loads the pinned manifest", () => {
    expect(manifest.dacsVersion).toBe("0.1");
    expect(manifest.cases.length).toBeGreaterThan(0);
  });

  // ── Shared helpers ────────────────────────────────────────────────────────

  const verifySig = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
    ed25519Verify(b, s, publicKeyFromRaw(p));

  /** did:demos:<who> → raw pubkey, from a golden seed map. */
  const keysFromSeeds = (seeds: Record<string, string>) => {
    const byDid: Record<string, Uint8Array> = {};
    for (const [who, seedHex] of Object.entries(seeds)) {
      byDid[`did:demos:${who}`] = rawPublicKey(publicKeyFromSeed(hex(seedHex)));
    }
    return byDid;
  };

  /** Run verifyBundleCore over an in-memory bundle with golden-seed keys. */
  const runBundle = (
    bundle: Record<string, unknown>,
    seeds: Record<string, string>,
  ) => {
    const keys = keysFromSeeds(seeds);
    return verifyBundleCore("ref", {
      readArtifact: async () => bundle,
      resolvePublicKey: async (did) => keys[did] ?? null,
      verify: verifySig,
    });
  };

  /**
   * Map a BundleVerification to the §10.4.1 golden decision token. The golden
   * decision is the SIGNATURE-layer verdict (validity of every signature +
   * required-signer coverage); referenced-artifact resolution is out of scope
   * here because the harness reads bundles from memory, not a substrate.
   */
  const bundleDecision = (res: {
    reason?: string;
    signatures: Array<{ verdict: string }>;
  }): string => {
    if (res.signatures.some((s) => s.verdict === "error")) return "error";
    if (res.signatures.some((s) => s.verdict === "invalid")) return "fail";
    if (res.reason?.startsWith("missing required signature")) return "fail";
    return res.signatures.length > 0 &&
      res.signatures.every((s) => s.verdict === "valid")
      ? "pass"
      : "fail";
  };

  /** §14.5 consume verdict, mapped to the golden's kebab-case token. */
  const consume = async (copies: BundleCopies): Promise<string> => {
    const verdict = await bundleConsistency(copies, { trustBundles: true });
    return verdict === "oneSided" ? "one-sided" : verdict;
  };

  const present = (bundle: Record<string, unknown>) =>
    ({ disposition: "present", bundle }) as const;
  const absent = { disposition: "absent" } as const;

  /** The reputation fixture set + the window golden.json pins for it. */
  const repFixture = () =>
    read("conformance/fixtures/session-bundles-reputation.json") as unknown as {
      windowStart: number;
      windowEnd: number;
      windowingBasis: "finalisedAt" | "sr2-anchor-timestamp";
      computedAt: number;
      partyPrimaryClaim: string;
      bundles: AttestationBundle[];
    };
  const deriveCurrentRep = (bundles: AnyAttestationBundle[]) => {
    const fx = repFixture();
    return deriveReputation(
      fx.partyPrimaryClaim,
      bundles,
      {
        windowStart: fx.windowStart,
        windowEnd: fx.windowEnd,
        computedAt: fx.computedAt,
        windowingBasis: fx.windowingBasis,
      },
      {
        trustBundles: true,
        // §10.5.1 guard (iv): a one-copy attribution needs authoritative
        // absence of the other role's copy. The current golden models NO
        // retained absence context, so every missing copy is indeterminate.
        copyAbsence: () => "indeterminate",
      },
    );
  };

  const settlementDeps = (publicKeys: Record<string, string>) => ({
    resolvePublicKey: async (signer: string) =>
      publicKeys[signer] ? b64u(publicKeys[signer]!) : null,
    verify: verifySig,
  });

  const paymentEvidence = () =>
    structuredClone(
      read("conformance/fixtures/settlement-evidence-payment-success.json").evidence,
    ) as any;
  const deliveryEvidence = () =>
    structuredClone(
      read("conformance/fixtures/settlement-evidence-delivery-success.json").evidence,
    ) as any;
  const verifyEvidence = (
    evidence: unknown,
    context: Parameters<typeof verifySettlementEvidence>[1] = {},
  ) => verifySettlementEvidence(evidence, context, {});
  const htlcEvidence = () => {
    const evidence = paymentEvidence();
    evidence.phase = "pay-cross-chain-htlc";
    evidence.paymentTxRefs = [
      {
        kind: "htlc-claim",
        chainId: 80002,
        contractAddress: "0x0000000000000000000000000000000000000001",
        claimTxHash: "0xclaim",
      },
    ];
    evidence.settlementFinality = {
      model: "htlc-reveal",
      finalityObservedAt: 1,
    };
    return evidence;
  };

  // Mirrors the pinned generator's deterministic VerifyResult resolver and
  // wrapper freshness gate. A structurally-complete verifiedBy is not enough:
  // its hash must bind (claim ref, locator, pass), and the claim must be fresh.
  const IDENTITY_NOW = 1_900_000_000_000;
  const resolvedAndFreshClaim = (claim: BundleClaimLike): boolean => {
    const verifiedBy = claim.verifiedBy;
    const locator = verifiedBy?.anchor?.locator;
    if (
      !verifiedBy ||
      verifiedBy.anchor?.kind !== "storage-program" ||
      typeof locator !== "string" ||
      !Number.isSafeInteger(verifiedBy.recipeVersion) ||
      verifiedBy.contentHash !==
        sha256Hex(`verify-result:${claim.ref}:${locator}:pass`)
    ) {
      return false;
    }

    const expiresAt = (claim as BundleClaimLike & { expiresAt?: unknown })
      .expiresAt;
    if (claim.issuedAt === undefined && expiresAt === undefined) return false;
    if (
      claim.issuedAt !== undefined &&
      (!Number.isSafeInteger(claim.issuedAt) ||
        claim.issuedAt > IDENTITY_NOW)
    ) {
      return false;
    }
    if (
      expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) ||
        IDENTITY_NOW > (expiresAt as number))
    ) {
      return false;
    }
    return true;
  };

  const tierClaim = (ref: string, verified = false): BundleClaimLike => {
    if (!verified) return { ref };
    const locator = `stor-verify-${ref.replaceAll(":", "-")}`;
    return {
      ref,
      issuedAt: IDENTITY_NOW - 1_000,
      verifiedBy: {
        anchor: { kind: "storage-program", locator },
        contentHash: sha256Hex(`verify-result:${ref}:${locator}:pass`),
        recipeVersion: 1,
      },
    };
  };

  const SEALED_DEADLINE = 1_000_000_120_000;
  const LISTING_PUBLISHER = "did:demos:agent:listing-publisher";
  const WINNING_BIDDER = "did:demos:agent:winning-bidder";
  const LOSING_BIDDER = "did:demos:agent:losing-bidder";
  const sealedBidder = (claim: string, amount: string, offset: number) => {
    const sealed = makeCommitment({ price: { amount, currency: "DEM" } });
    const commit: AnchoredCommit = {
      bidderClaim: claim,
      bidHash: sealed.bidHash,
      anchorTs: SEALED_DEADLINE - 1_000 + offset,
    };
    const reveal: AnchoredReveal = {
      bidderClaim: claim,
      bid: sealed.bid,
      salt: sealed.salt,
      anchorTs: SEALED_DEADLINE + 1_000 + offset,
    };
    return { commit, reveal };
  };
  const sealedAgreement = (ctx: Parameters<typeof buildSealedAgreement>[0]) =>
    buildSealedAgreement(ctx, {
      seller: LISTING_PUBLISHER,
      listingRef: "stor-sealed-listing",
      decimals: 0,
      rail: "pay-dem",
      deliveryPhase: "deliver-attested-payload",
      deliveryFormat: "application/json",
      expiresAt: "2026-12-31T00:00:00Z",
    });
  const runProcurement = async (selectionRule: SelectionRule) => {
    const winner = sealedBidder(WINNING_BIDDER, "3", 0);
    const loser = sealedBidder(LOSING_BIDDER, "4", 1);
    const ruleContent = { decision: "accept" };
    const resolvedSelectionRule = selectionRule.startsWith("rule-ref:")
      ? `rule-ref:${sha256Hex(canonicalize(ruleContent))}:${selectionRule.slice(selectionRule.lastIndexOf(":") + 1)}` as SelectionRule
      : selectionRule;
    let agreement: AgreementDocument | undefined;
    const result = await runSealedEnvelopeCore(
      {
        jobId: "job-procurement",
        seller: LISTING_PUBLISHER,
        currency: "DEM",
        phaseKind: "negotiate-sealed-envelope-procurement",
        params: {
          commitDeadline: SEALED_DEADLINE,
          revealWindow: 120,
          selectionRule: resolvedSelectionRule,
          auctionMode: "procurement",
        },
      },
      {
        readAnchoredCommits: async () => [winner.commit, loser.commit],
        readAnchoredReveals: async () => [winner.reveal, loser.reveal],
        ...(selectionRule.startsWith("rule-ref:")
          ? {
              resolveRuleContent: async () => ruleContent,
              evaluateVerifiedRule: () => true,
            }
          : {}),
        commitAgreement: async (ctx) => {
          agreement = sealedAgreement(ctx);
          return {
            agreement,
            verifiedSignerClaims: [LISTING_PUBLISHER, WINNING_BIDDER],
            agreementRef: "stor-agreement",
            agreementHash: "agreement-hash",
          };
        },
      },
    );
    return { result, agreement: agreement! };
  };

  // ── Per-case runners ──────────────────────────────────────────────────────
  // Inputs for the primitive canonicalize/decimal cases follow each case's
  // summary verbatim (dacs-verify constructs them in run.ts and pins only the
  // output); everything else reads the vendored fixtures / golden.json.

  const RUNNERS: Record<string, (want: any) => void | Promise<void>> = {
    // canonicalize — §7.1 / §7.2, via src/canonical/jcs.ts + hash.ts
    "canon-key-order": (want) => {
      expect(canonicalize({ b: 1, a: 2, A: 3 })).toBe(want);
    },
    "canon-nested": (want) => {
      expect(canonicalize({ z: [3, 1, 2], a: { y: 1, x: 2 } })).toBe(want);
    },
    "canon-escaping": (want) => {
      expect(canonicalize('a"b\\c\n\t')).toBe(want);
    },
    "canon-no-escape-slash": (want) => {
      expect(canonicalize("a/bé")).toBe(want);
    },
    "canon-int": (want) => {
      expect(canonicalize(9007199254740991)).toBe(want);
    },
    "canon-noninteger-throws": (want) => {
      expect(want).toBe("throws");
      expect(() => canonicalize(1.5)).toThrow();
    },
    "canon-without-signature": (want) => {
      expect(canonicalSignedScope({ a: 1, signature: "sig" })).toBe(want);
    },

    // decimal — §14.4 CD-1 / §9.3, via src/canonical/decimal.ts
    "cd1-trailing-zeros": (want) => {
      expect(
        ["1.50", "01.5", "1.500"].map((s) => canonicalizeDecimal(s)),
      ).toEqual(want);
    },
    "cd1-normal-forms": (want) => {
      expect(
        ["0.0", ".5", "0.50"].map((s) => canonicalizeDecimal(s)),
      ).toEqual(want);
    },
    "cd1-reject-exponent": (want) => {
      expect(want).toEqual(["throws", "throws", "throws"]);
      for (const bad of ["1e3", "+1", "abc"]) {
        expect(() => canonicalizeDecimal(bad)).toThrow();
      }
    },
    "cd1-economic-equality": (want) => {
      const canonicalEqual =
        contentHash({
          amount: canonicalizeDecimal("1.50"),
          currency: "USDC",
        }) ===
        contentHash({
          amount: canonicalizeDecimal("1.500"),
          currency: "USDC",
        });
      const rawDiffers =
        contentHash({ amount: "1.50", currency: "USDC" }) !==
        contentHash({ amount: "1.500", currency: "USDC" });
      expect({ canonicalEqual, rawDiffers }).toEqual(want);
    },
    "cd1-positivity": (want) => {
      expect(want).toBe("throws");
      expect(() => assertPositiveAmount("0")).toThrow();
      expect(() => assertPositiveAmount("0.0")).toThrow();
    },

    // signing — §7.7, via src/crypto (golden.signing pins seed/doc/signature)
    "sig-roundtrip": (want) => {
      const sep = golden.signing.separator as DomainSeparator;
      const sig = signArtifact(sep, golden.signing.doc, hex(golden.signing.seed));
      expect(Buffer.from(sig).toString("base64url")).toBe(golden.signing.signature);
      const pub = rawPublicKey(publicKeyFromSeed(hex(golden.signing.seed)));
      expect(Buffer.from(pub).toString("hex")).toBe(golden.signing.publicKeyHex);
      expect(verifyArtifact(sep, golden.signing.doc, sig, pub)).toBe(want.ok);
      expect(sep).toBe(want.separator);
    },
    "sig-tamper": (want) => {
      const sep = golden.signing.separator as DomainSeparator;
      const sig = b64u(golden.signing.signature);
      const pub = hex(golden.signing.publicKeyHex);
      const tampered = { ...golden.signing.doc, listingVersion: 2 };
      expect(verifyArtifact(sep, tampered, sig, pub)).toBe(want);
    },
    "sig-sig2-cross-domain": (want) => {
      const sig = b64u(golden.signing.signature);
      const pub = hex(golden.signing.publicKeyHex);
      expect(verifyArtifact("dacs-bundle:v1:", golden.signing.doc, sig, pub)).toBe(want);
    },
    // DIVERGENCE (it.fails below): the golden pins a closed registry of
    // exactly 24 separators (§B.7); the SDK's SIGNATURE_DOMAIN_SEPARATORS
    // carries 18 — it deliberately excludes the composite-payload separators
    // (session-binding, auto-accept-*) and lacks bundle-binding,
    // fault-bundle-pointer and finality-commitment. Tracked in #86.
    "sig-registry-closed": (want) => {
      expect(SIGNATURE_DOMAIN_SEPARATORS.length).toBe(want.count);
      expect([...SIGNATURE_DOMAIN_SEPARATORS].sort()).toEqual(want.separators);
    },
    "sig-sig4-dacsx-disjoint": (want) => {
      const x = dacsXSeparator("dispute");
      const disjoint =
        x.startsWith("dacs-x-") &&
        !isRegisteredSeparator(x) &&
        SIGNATURE_DOMAIN_SEPARATORS.every((s) => !s.startsWith("dacs-x-"));
      expect(disjoint).toBe(want);
    },

    // addressing — §6.3.4 CF-4, via src/canonical/addressing.ts
    "cf4-encode-delimiters": (want) => {
      expect(encodeAddressSegment(golden.addressing.cf4.input)).toBe(want.encoded);
      expect(decodeAddressSegment(want.encoded)).toBe(want.decoded);
    },
    "cf4-dacs1-listing-address": (want) => {
      expect(listingAddress("cci-xm:evm:mainnet:0x1234", "rfq-lot-x-1", 3)).toBe(want);
    },
    "cf4-dacs2-composite-address": (want) => {
      expect(
        compositeVerificationAddress(
          "job-abc",
          "cci-xm:evm:mainnet:0x1234",
        ),
      ).toBe(want);
    },
    "cf4-dacs2-attestation-address": (want) => {
      expect(
        attestationAddress("job-abc", "cci-xm", "evm:mainnet:0x1234", 3),
      ).toBe(want);
    },
    "vet-cm2-address": (want) => {
      expect(attestationAddress("job-abc", "lei", "984500ABCDEF12345678", 3)).toBe(
        want,
      );
    },
    "cf4-dacs4-payment-address": (want) => {
      expect({
        address: paymentEvidenceAddress(
          "DACS-VERIFY-SETTLE-0001",
          "evm-erc20:1:USDC",
          0,
        ),
        decision: "pass",
      }).toEqual(want);
    },
    "cf4-dacs5-rating-address": (want) => {
      expect(ratingAddress("job-abc", "cci-xm:evm:mainnet:0x1234")).toBe(want);
    },

    // Exact normative artifact-reference shapes — DACS-2 §7.5.2 / DACS-4 §9.3.
    "artifact-shape-attestationref": (want) => {
      expect(referenceShapes.vectors).toHaveLength(referenceShapes.count);
      expect(referenceShapes.count).toBe(23);
      const accepted = referenceShapes.vectors.filter(
        (testCase) =>
          testCase.type === "AttestationRef" && testCase.expected === "pass",
      );
      expect(
        accepted.map(
          (testCase) =>
            (testCase.value as { anchor: { kind: string } }).anchor.kind,
        ).sort(),
      ).toEqual([...want.acceptedAnchorKinds].sort());
      expect(accepted.every((testCase) => isAttestationRef(testCase.value))).toBe(true);
      const legacy = referenceShapes.vectors.find(
        (testCase) => testCase.name === "attestation-legacy-kind-id-rejected",
      );
      expect(isAttestationRef(legacy?.value) ? "pass" : "fail").toBe(want.legacyKindId);
    },
    "artifact-shape-chaintxref": (want) => {
      const acceptedKinds = new Set<string>(want.acceptedKinds);
      const accepted = referenceShapes.vectors.filter((testCase) => {
        if (testCase.type !== "ChainTxRef" || testCase.expected !== "pass") return false;
        const kind = (testCase.value as { kind?: unknown }).kind;
        return typeof kind === "string" && acceptedKinds.has(kind);
      });
      expect(
        accepted.map((testCase) => (testCase.value as { kind: string }).kind).sort(),
      ).toEqual([...want.acceptedKinds].sort());
      expect(accepted.every((testCase) => isChainTxRef(testCase.value))).toBe(true);
      const legacy = referenceShapes.vectors.find(
        (testCase) => testCase.name === "txref-legacy-rail-kind-rejected",
      );
      expect(isChainTxRef(legacy?.value) ? "pass" : "fail").toBe(
        want.legacyRailTxHashKind,
      );
    },

    // negotiate — DACS-3 SE-8 role assignment and commit teeth.
    "neg-sealed-envelope-default-demand-winner-is-buyer": (want) => {
      const roles = assignSealedEnvelopeRoles({
        listingPublisher: LISTING_PUBLISHER,
        winningBidderClaim: WINNING_BIDDER,
      });
      expect(roles.auctionMode).toBe("demand");
      expect(roles.buyer).toBe(
        want.buyer === "winningBidder" ? WINNING_BIDDER : LISTING_PUBLISHER,
      );
      expect(roles.seller).toBe(
        want.seller === "listingPublisher" ? LISTING_PUBLISHER : WINNING_BIDDER,
      );
    },
    "neg-sealed-envelope-demand-highest-price-winner-is-buyer": (want) => {
      const roles = assignSealedEnvelopeRoles({
        phaseKind: "negotiate-sealed-envelope",
        auctionMode: want.auctionMode,
        listingPublisher: LISTING_PUBLISHER,
        winningBidderClaim: WINNING_BIDDER,
      });
      expect(roles.buyer).toBe(WINNING_BIDDER);
      expect(roles.seller).toBe(LISTING_PUBLISHER);
    },
    "neg-sealed-envelope-procurement-lowest-price-winner-is-seller": async (want) => {
      const { result, agreement } = await runProcurement(want.selectionRule);
      expect(result).toMatchObject({
        ok: true,
        phaseKind: want.phaseKind,
        contextDeltaKey: want.contextDeltaKey,
        auctionMode: want.auctionMode,
        winningBidderClaim: WINNING_BIDDER,
      });
      expect(agreement.buyer).toBe(LISTING_PUBLISHER);
      expect(agreement.seller).toBe(WINNING_BIDDER);
      expect(agreement.price.amount).toBe("3");
    },
    "neg-sealed-envelope-procurement-rule-ref-winner-is-seller": async (want) => {
      const { result, agreement } = await runProcurement(want.selectionRule);
      expect(result.contextDeltaKey).toBe(want.contextDeltaKey);
      expect(agreement.buyer).toBe(LISTING_PUBLISHER);
      expect(agreement.seller).toBe(WINNING_BIDDER);
    },
    "neg-sealed-envelope-procurement-role-inverted-reject": (want) => {
      const correct = sealedAgreement({
        jobId: "job-inverted",
        seller: LISTING_PUBLISHER,
        listingPublisher: LISTING_PUBLISHER,
        winningBidderClaim: WINNING_BIDDER,
        winningBid: { price: { amount: "3", currency: "DEM" } },
        losingBidderClaims: [],
        phaseKind: "negotiate-sealed-envelope-procurement",
        auctionMode: "procurement",
      });
      const inverted = {
        ...correct,
        buyer: WINNING_BIDDER,
        seller: LISTING_PUBLISHER,
      };
      expect(
        validateSealedAgreementRoleAssignment(inverted, {
          phaseKind: want.phaseKind,
          auctionMode: want.listingAuctionMode,
          listingPublisher: LISTING_PUBLISHER,
          winningBidderClaim: WINNING_BIDDER,
        }),
      ).toMatchObject({ ok: want.ok, failedAt: want.failedAt });
    },
    "neg-sealed-envelope-procurement-missing-publisher-signature-reject": (want) => {
      const agreement = sealedAgreement({
        jobId: "job-missing-signature",
        seller: LISTING_PUBLISHER,
        listingPublisher: LISTING_PUBLISHER,
        winningBidderClaim: WINNING_BIDDER,
        winningBid: { price: { amount: "3", currency: "DEM" } },
        losingBidderClaims: [],
        phaseKind: want.phaseKind,
        auctionMode: want.auctionMode,
      });
      expect(
        validateSealedAgreementForCommit(agreement, {
          phaseKind: want.phaseKind,
          auctionMode: want.auctionMode,
          listingPublisher: LISTING_PUBLISHER,
          winningBidderClaim: WINNING_BIDDER,
          verifiedSignerClaims: [WINNING_BIDDER],
        }),
      ).toMatchObject({
        ok: want.ok,
        failedAt: want.failedAt,
        missingSigner: LISTING_PUBLISHER,
      });
    },
    "neg-sealed-envelope-procurement-phase-missing-mode-reject": (want) => {
      expect(resolveSealedEnvelopeMode(want.phaseKind, undefined)).toMatchObject({
        ok: want.ok,
        failedAt: want.failedAt,
        reason: want.reason,
      });
    },
    "neg-sealed-envelope-unresolvable-auctionmode-reject": (want) => {
      expect(resolveSealedEnvelopeMode("negotiate-sealed-envelope", "unresolvable")).toEqual({
        ok: want.ok,
        failedAt: want.failedAt,
        reason: want.reason,
      });
    },

    // dacs1 — identityTier derivation (§6.3.2.1 IT-1..IT-3), via
    // src/identity/tier.ts. Fixture-backed where golden.identityTier ships a
    // fixture; the fixture-less IT-3 cases construct the bundle the summary
    // describes and model stale/unresolved verification via the REQUIRED
    // isClaimVerified predicate (there is no shipped resolution context).
    "identity-tier-institutional": (want) => {
      const fx = read("conformance/fixtures/identity/identity-tier-institutional.json");
      expect(
        deriveIdentityTier(fx.identityBundle as never, resolvedAndFreshClaim),
      ).toBe(want);
    },
    "identity-tier-verified": (want) => {
      const fx = read("conformance/fixtures/identity/identity-tier-verified.json");
      expect(
        deriveIdentityTier(fx.identityBundle as never, resolvedAndFreshClaim),
      ).toBe(want);
    },
    "identity-tier-raw-key": (want) => {
      expect(
        deriveIdentityTier(
          { claims: [tierClaim("key:aaaaaaaa")] },
          resolvedAndFreshClaim,
        ),
      ).toBe(want);
    },
    "identity-tier-self-asserted-ignored": (want) => {
      const fx = read("conformance/fixtures/identity/identity-tier-self-declared.json");
      // The fixture bundle self-asserts a higher identityTier; derivation must
      // ignore it and recompute from the (unverified) claims.
      expect(
        deriveIdentityTier(fx.identityBundle as never, resolvedAndFreshClaim),
      ).toBe(want);
    },
    "identity-tier-highest-wins": (want) => {
      expect(
        deriveIdentityTier(
          { claims: [tierClaim("domain:example.com", true), tierClaim("lei:529900T8BM49AURSDO55", true)] },
          resolvedAndFreshClaim,
        ),
      ).toBe(want);
    },
    "identity-tier-stale-not-elevated": (want) => {
      const staleClaim = {
        ...tierClaim("lei:529900T8BM49AURSDO55", true),
        expiresAt: IDENTITY_NOW - 1,
      };
      expect(
        deriveIdentityTier(
          { claims: [staleClaim] },
          resolvedAndFreshClaim,
        ),
      ).toBe(want);
    },
    "identity-tier-forged-unresolved": (want) => {
      // Malformed verifiedBy (no contentHash / anchor) cannot resolve.
      expect(
        deriveIdentityTier(
          {
            claims: [
              { ref: "lei:529900T8BM49AURSDO55", verifiedBy: { recipeVersion: 1 } },
            ],
          },
          resolvedAndFreshClaim,
        ),
      ).toBe(want);
    },

    // bundle — §10.4/§10.4.1, via verifyBundleCore over the shipped fixtures
    "bundle-0004-pass": async (want) => {
      const res = await runBundle(read(golden.bundle.fixture), golden.bundle.seeds);
      expect(bundleDecision(res)).toBe(want);
    },
    "bundle-htlc9-pass": async (want) => {
      const res = await runBundle(read(golden.bundle.htlc9Fixture), golden.bundle.seeds);
      expect(bundleDecision(res)).toBe(want.decision);
      expect(res.bundle?.outcome).toBe(want.outcome);
      const phase = (res.bundle?.phaseSummary ?? []).find(
        (p) => p.kind === golden.bundle.htlc9.settlementPhase.kind,
      ) as (Record<string, unknown> & {
        txRefs?: Array<Record<string, unknown>>;
      }) | undefined;
      expect(phase?.outcome).toBe(want.phaseOutcome);
      expect(phase?.errorClass).toBe(want.errorClass);
      const reveal = phase?.txRefs?.some(
        (t) =>
          t.kind === "htlc-reveal" &&
          t.revealTxHash === golden.bundle.htlc9.settlementPhase.revealTxRef,
      );
      expect(reveal ?? false).toBe(want.revealRecorded);
    },
    "bundle-required-signer-fail": async (want) => {
      // The manifest case: a COMPLETED bundle with the seller signature
      // ABSENT (not merely wrong) MUST fail (#39 regression class).
      const fixture = read(golden.bundle.fixture);
      const sigs = fixture.signatures as Array<{ party: string }>;
      const mutated = {
        ...fixture,
        signatures: sigs.filter((s) => s.party !== "did:demos:seller"),
      };
      const res = await runBundle(mutated, golden.bundle.seeds);
      expect(bundleDecision(res)).toBe(want);
    },
    "bundle-malformed-key-error": async (want) => {
      const keys = keysFromSeeds(golden.bundle.seeds);
      const res = await verifyBundleCore("ref", {
        readArtifact: async () => read(golden.bundle.fixture),
        resolvePublicKey: async (did) =>
          did === "did:demos:seller" ? new Uint8Array(16) : (keys[did] ?? null),
        verify: verifySig,
      });
      expect(bundleDecision(res)).toBe(want);
    },

    // settlement — §14.4 / §9.7, via verifySettlementEvidence over the two
    // shipped success fixtures (context assembled from each fixture's own
    // result envelope + the golden orchestrator key).
    "settlement-payment-pass": async (want) => {
      const fx = read("conformance/fixtures/settlement-evidence-payment-success.json") as any;
      const price = fx.paymentInput.agreement.terms.price;
      const rail = fx.paymentInput.rail;
      const r = await verifySettlementEvidence(
        fx.evidence,
        {
          orchestrator: "did:demos:orchestrator",
          attestationRef: fx.result.attestationRef,
          result: { ok: fx.result.ok, errorClass: fx.result.errorClass },
          agreement: { amount: price.amount, currency: price.currency },
          rail: {
            railId: rail.railId,
            railType: rail.railType,
            asset: rail.asset.symbol,
            handler: rail.phaseHandler,
          },
        },
        settlementDeps(golden.settlement.publicKeys),
      );
      expect(r.reasons).toEqual([]);
      expect(r.decision).toBe(want);
    },
    "settlement-delivery-pass": async (want) => {
      const fx = read("conformance/fixtures/settlement-evidence-delivery-success.json") as any;
      const r = await verifySettlementEvidence(
        fx.evidence,
        {
          orchestrator: "did:demos:orchestrator",
          attestationRef: fx.result.attestationRef,
          result: { ok: fx.result.ok, errorClass: fx.result.errorClass },
          expectedAnchorLocator: fx.evidence.deliverableAnchor.locator,
        },
        settlementDeps(golden.settlement.publicKeys),
      );
      expect(r.reasons).toEqual([]);
      expect(r.decision).toBe(want);
    },
    "settlement-currency-mismatch-not-rejected-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.paymentAmount.currency = "DAI";
      expect(
        (await verifyEvidence(evidence, { rail: { asset: "USDC" } })).decision,
      ).toBe(want);
    },
    "settlement-success-payment-missing-finality-fail": async (want) => {
      const evidence = paymentEvidence();
      delete evidence.settlementFinality;
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-delivery-with-finality-fail": async (want) => {
      const evidence = deliveryEvidence();
      evidence.settlementFinality = {
        model: "block-depth",
        finalityBlocks: 1,
        finalityObservedAt: 1,
      };
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-ok-true-errorclass-fail": async (want) => {
      expect(
        (
          await verifyEvidence(paymentEvidence(), {
            result: { ok: true, errorClass: "counterparty" },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-ok-false-no-errorclass-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.outcome = "failure";
      evidence.reason = "rail rejected";
      delete evidence.settlementFinality;
      expect(
        (
          await verifyEvidence(evidence, {
            result: { ok: false },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-attestationref-hash-mismatch-fail": async (want) => {
      expect(
        (
          await verifyEvidence(paymentEvidence(), {
            attestationRef: {
              anchor: { kind: "storage-program", locator: "evidence" },
              contentHash: "0".repeat(64),
            },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-failure-no-reason-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.outcome = "failure";
      delete evidence.settlementFinality;
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-wrong-signer-key-fail": async (want) => {
      const result = await verifySettlementEvidence(paymentEvidence(), {}, {
        resolvePublicKey: async () => new Uint8Array(32),
        verify: () => false,
      });
      expect(result.decision).toBe(want);
    },
    "settlement-malformed-key-error": async (want) => {
      const result = await verifySettlementEvidence(paymentEvidence(), {}, {
        resolvePublicKey: async () => new Uint8Array(10),
        verify: () => true,
      });
      expect(result.decision).toBe(want);
    },
    "settlement-unresolvable-key-indeterminate": async (want) => {
      const result = await verifySettlementEvidence(paymentEvidence(), {}, {
        resolvePublicKey: async () => null,
        verify: () => true,
      });
      expect(result.decision).toBe(want);
    },
    "settlement-phase-rail-mismatch-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.phase = "pay-solana-spl";
      expect(
        (
          await verifyEvidence(evidence, {
            rail: {
              railType: "evm-erc20",
              handler: "pay-evm-erc20",
            },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-noncanonical-amount-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.paymentAmount.amount = "1.50";
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-nonpositive-amount-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.paymentAmount.amount = "0";
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-wrong-attestation-kind-fail": async (want) => {
      expect(
        (
          await verifyEvidence(paymentEvidence(), {
            attestationRef: {
              anchor: { kind: "unsupported", locator: "bundle" },
              contentHash: "0".repeat(64),
            },
          } as unknown as Parameters<typeof verifySettlementEvidence>[1])
        ).decision,
      ).toBe(want);
    },
    "settlement-non-orchestrator-signer-fail": async (want) => {
      expect(
        (
          await verifyEvidence(paymentEvidence(), {
            orchestrator: "did:demos:someone-else",
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-success-missing-paymenttxrefs-fail": async (want) => {
      const evidence = paymentEvidence();
      delete evidence.paymentTxRefs;
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-success-missing-paymentamount-fail": async (want) => {
      const evidence = paymentEvidence();
      delete evidence.paymentAmount;
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-delivery-missing-deliverable-fail": async (want) => {
      const evidence = deliveryEvidence();
      delete evidence.deliverableContentHash;
      delete evidence.deliverableAnchor;
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-delivery-malformed-contenthash-fail": async (want) => {
      const evidence = deliveryEvidence();
      evidence.deliverableContentHash = "not-a-hash";
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-negative-fee-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.paymentFee = { amount: "-1", currency: "USDC" };
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },
    "settlement-underpayment-vs-agreement-fail": async (want) => {
      const evidence = paymentEvidence();
      evidence.paymentAmount.amount = "1";
      expect(
        (
          await verifyEvidence(evidence, {
            agreement: { amount: "5", currency: "USDC" },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-incoherent-rail-type-handler-fail": async (want) => {
      expect(
        (
          await verifyEvidence(paymentEvidence(), {
            rail: {
              railType: "evm-erc20",
              handler: "pay-solana-spl",
            },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-htlc-finality-params-pass": async (want) => {
      expect(
        (
          await verifyEvidence(htlcEvidence(), {
            rail: {
              railType: "cross-chain-htlc",
              sourceFinalitySec: 120,
              safetyWindowSec: 600,
            },
            htlcExpiry: { source: 10_000, dest: 5_000 },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-htlc-missing-source-finality-fail": async (want) => {
      expect(
        (
          await verifyEvidence(htlcEvidence(), {
            rail: {
              railType: "cross-chain-htlc",
              safetyWindowSec: 600,
            },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-htlc-missing-safety-window-fail": async (want) => {
      expect(
        (
          await verifyEvidence(htlcEvidence(), {
            rail: {
              railType: "cross-chain-htlc",
              sourceFinalitySec: 120,
            },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-htlc-insufficient-margin-fail": async (want) => {
      expect(
        (
          await verifyEvidence(htlcEvidence(), {
            rail: {
              railType: "cross-chain-htlc",
              sourceFinalitySec: 120,
              safetyWindowSec: 600,
            },
            htlcExpiry: { source: 5_100, dest: 5_000 },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-cross-chain-anchor-pending-pass": async (want) => {
      const evidence = paymentEvidence();
      evidence.phase = "pay-cross-chain-liquidity-tank";
      evidence.settlementFinality = {
        model: "liquidity-tank",
        finalityObservedAt: 1,
      };
      evidence.paymentTxRefs = [
        {
          kind: "liquidity-tank",
          bridgeId: "bridge-1",
          sourceChainId: 8453,
          destChainId: 80002,
          lockTxHash: "0xlock",
          releaseTxHash: "0xrelease",
        },
      ];
      expect(
        (
          await verifyEvidence(evidence, {
            rail: { railType: "cross-chain-liquidity-tank" },
          })
        ).decision,
      ).toBe(want);
    },
    "settlement-delivery-extra-payment-field-pass": async (want) => {
      const evidence = deliveryEvidence();
      evidence.paymentAmount = { amount: "5", currency: "USDC" };
      expect((await verifyEvidence(evidence)).decision).toBe(want);
    },

    // verify — §10.4.2 addressing, §10.4.3 consume verdicts, §10.5.1
    // reputation; via bundleAddress, bundleConsistency (+ verifyBundleCore for
    // the per-copy decisions) and deriveReputation.
    "verify-address-buyer": (want) => {
      expect(bundleAddress("job-1", "buyer")).toBe(want);
    },
    "verify-address-role-specific": (want) => {
      const [b, s, o] = [
        bundleAddress("job-1", "buyer"),
        bundleAddress("job-1", "seller"),
        bundleAddress("job-1", "orchestrator"),
      ];
      expect([b !== s, s !== o]).toEqual(want);
    },
    "verify-consume-absent": async (want) => {
      expect(await consume({ buyer: absent, seller: absent })).toBe(want.verdict);
    },
    "verify-consume-unified": async (want) => {
      const bundle = read(golden.bundle.fixture);
      expect(await consume({ buyer: present(bundle), seller: present(bundle) })).toBe(
        want.verdict,
      );
      const buyerHash = attestationBundleHash(bundle as never);
      const sellerHash = attestationBundleHash(structuredClone(bundle) as never);
      expect(buyerHash).toBe(golden.bundle.bundleHash);
      expect(buyerHash === sellerHash).toBe(want.equalHashes);
      const res = await runBundle(bundle, golden.bundle.seeds);
      expect(bundleDecision(res)).toBe(want.buyerDecision);
      expect(bundleDecision(res)).toBe(want.sellerDecision);
    },
    "verify-consume-one-sided": async (want) => {
      const bundle = read("conformance/fixtures/session-bundle-one-sided.json");
      expect(await consume({ buyer: present(bundle), seller: absent })).toBe(want.verdict);
      const res = await runBundle(bundle, golden.verify.seeds);
      expect(bundleDecision(res)).toBe(want.buyerDecision);
      expect(res.bundle?.outcome).toBe(want.buyerOutcome);
      expect(attestationBundleHash(bundle as never)).toBe(want.buyerHash);
      expect(bundle.anchoredByRole).toBe(want.abortedByOtherRole);
      expect(perspectiveFlip(bundle.outcome)).toBe("aborted-by-self");
      const missingRole = bundle.anchoredByRole === "buyer" ? "seller" : "buyer";
      expect(missingRole).toBe(want.abortedBySelfRole);
    },
    "verify-consume-divergent": async (want) => {
      const buyer = read(golden.bundle.fixture);
      const seller = read(golden.bundle.divergentSellerFixture);
      expect(await consume({ buyer: present(buyer), seller: present(seller) })).toBe(
        want.verdict,
      );
      expect(attestationBundleHash(buyer as never) !== attestationBundleHash(seller as never)).toBe(
        want.distinctHashes,
      );
      expect(bundleDecision(await runBundle(buyer, golden.bundle.seeds))).toBe(
        want.buyerDecision,
      );
      expect(bundleDecision(await runBundle(seller, golden.bundle.seeds))).toBe(
        want.sellerDecision,
      );
      expect(BUNDLE_OUTCOMES.includes(want.verdict)).toBe(!want.notOutcomeEnum);
    },
    "verify-consume-phase-index-mismatch-divergent": async (want) => {
      const fx = read("conformance/fixtures/session-bundles-presence.json") as any;
      const { buyer, seller } = fx.phaseIndexMismatch;
      expect(await consume({ buyer: present(buyer), seller: present(seller) })).toBe(
        want.verdict,
      );
      expect(buyer.phaseSummary.map((p: any) => p.index)).toEqual(want.buyerPhaseIndexes);
      expect(seller.phaseSummary.map((p: any) => p.index)).toEqual(want.sellerPhaseIndexes);
      expect(buyer.phaseSummary.map((p: any) => p.kind)).toEqual(want.buyerPhaseKinds);
      expect(seller.phaseSummary.map((p: any) => p.kind)).toEqual(want.sellerPhaseKinds);
      expect(attestationBundleHash(buyer) !== attestationBundleHash(seller)).toBe(
        want.distinctHashes,
      );
      expect(bundleDecision(await runBundle(buyer, fx.seeds))).toBe(want.buyerDecision);
      expect(bundleDecision(await runBundle(seller, fx.seeds))).toBe(want.sellerDecision);
    },
    "verify-consume-advisory-skew-unified": async (want) => {
      const fx = read("conformance/fixtures/session-bundles-presence.json") as any;
      const { buyer, seller } = fx.advisorySkew;
      expect(await consume({ buyer: present(buyer), seller: present(seller) })).toBe(
        want.verdict,
      );
      expect(attestationBundleHash(buyer) !== attestationBundleHash(seller)).toBe(
        want.distinctHashes,
      );
      expect((buyer.ratingRefs ?? []).length).toBe(want.buyerRatingRefs);
      expect((seller.ratingRefs ?? []).length).toBe(want.sellerRatingRefs);
      expect(buyer.phaseSummary.map((p: any) => p.kind)).toEqual(want.buyerPhaseKinds);
      expect(seller.phaseSummary.map((p: any) => p.kind)).toEqual(want.sellerPhaseKinds);
      expect(bundleDecision(await runBundle(buyer, fx.seeds))).toBe(want.buyerDecision);
      expect(bundleDecision(await runBundle(seller, fx.seeds))).toBe(want.sellerDecision);
    },
    "verify-reputation-unqualified-one-copy-excluded": (want) => {
      // Guard (iv): the same one-copy fixture with NO retained
      // authoritative-absence context is excluded from every metric.
      const d = deriveCurrentRep(repFixture().bundles);
      expect(d.bundleCount).toBe(want.bundleCount);
      expect(d.metrics.completionRate).toBe(want.completionRate);
      expect(d.metrics.counterpartyAdjustedCompletionRate).toBe(
        want.counterpartyAdjustedCompletionRate,
      );
      expect(d.metrics.counterpartyFaultRate).toBe(want.counterpartyFaultRate);
      expect(d.metrics.transactionCountByCurrency).toEqual(want.transactionCountByCurrency);
      expect(d.bundleRefs).toEqual(want.bundleRefs);
    },
  };

  // Divergences: assert the vector expectation but expect the test to FAIL
  // against today's SDK (it.fails flips loudly when the divergence is fixed).
  const DIVERGENT = new Set<string>([
    // The pinned oracle still rejects fractional JSON numbers even though
    // RFC 8785 and CORE B.2 admit finite values within the magnitude bound.
    "canon-noninteger-throws",
  ]);

  it("preserves fractional canonicalization independently of the stale oracle", () => {
    expect(canonicalize(1.5)).toBe("1.5");
  });

  // Why un-runnable cases are todo, per area (with per-case overrides).
  const TODO_AREA_REASON: Record<string, string> = {
    dacs1:
      "no exported §6.3.2/§6.3.3 requirement-matching, freshness-gate, control-gate (#170) or §6.3.4 listing-conformance surface",
    vet: "§7.5.1/§7.6.1/§7.7.1 classification, retry and aggregation predicates are internal to the exported vetCore/runSessionCore orchestration, not independently exported",
    negotiate:
      "remaining §8.5.1/§8.5.2 price, fee, listing, and commitment checks need richer constructed inputs or focused SDK surfaces",
    governance: "no GOV-1..3 governance surface in the SDK",
    dispute:
      "no DACS-X §11.2.1 dispute verifier in the SDK; vector inputs are constructed in dacs-verify run.ts, not shipped",
    disclosure:
      "no §8.7 disclosure-grant verifier in the SDK; vector inputs are constructed in dacs-verify run.ts, not shipped",
    settlement:
      "mutation/candidate inputs are constructed in dacs-verify run.ts, not shipped (only the two success fixtures are); PayeeBound (PB-1..3) has no SDK surface",
    verify:
      "needs surfaces the SDK does not export (ST-1 transition legality, phase-error→outcome mapping, two-sided address lookup) or inputs not shipped",
  };
  const TODO_CASE_REASON: Record<string, string> = {
    "settlement-wrong-anchor-fail":
      "EvidenceContext cannot validate the result.attestationRef payment-address id (PC-2)",
    "settlement-txrefs-mismatch-fail":
      "EvidenceContext does not carry handler-result txRefs for comparison with signed evidence.paymentTxRefs",
    "settlement-storage-anchored-as-entitlement-fail":
      "EvidenceContext does not carry attestationRef.id for dacs4 namespace validation",
    "settlement-rail-network-mismatch-fail":
      "EvidenceRailContext carries only opaque asset/network strings, not the categorical or chainId structure needed for RD-5 coherence",
    "settlement-cross-chainid-matching-kind-pass":
      "EvidenceRailContext does not represent asset.chainId/network.chainId",
  };

  // ── Drive the manifest ────────────────────────────────────────────────────
  const byArea = new Map<string, ManifestCase[]>();
  for (const c of manifest.cases) {
    const list = byArea.get(c.area) ?? [];
    list.push(c);
    byArea.set(c.area, list);
  }

  for (const area of [...byArea.keys()].sort()) {
    describe(`area: ${area}`, () => {
      for (const c of byArea.get(area)!) {
        if (c.status !== "golden") {
          it.todo(`${c.id} (${c.spec}, ${c.status}) — ${c.reason}`);
          continue;
        }
        const runner = RUNNERS[c.id] as Runner | undefined;
        if (!runner) {
          const reason =
            TODO_CASE_REASON[c.id] ?? TODO_AREA_REASON[area] ?? "no runner";
          it.todo(`${c.id} (${c.spec}) — ${reason}`);
          continue;
        }
        const test = DIVERGENT.has(c.id) ? it.fails : it;
        test(`${c.id} (${c.spec}, ${c.status})`, async () => {
          await runner(c.want as never);
        });
      }
    });
  }

  it("every runner id exists in the manifest (no orphaned runners)", () => {
    const casesById = new Map(manifest.cases.map((c) => [c.id, c]));
    for (const id of Object.keys(RUNNERS)) {
      const manifestCase = casesById.get(id);
      expect(manifestCase, `runner for unknown case id: ${id}`).toBeDefined();
      expect(
        manifestCase?.status,
        `runner for non-golden case id: ${id}`,
      ).toBe("golden");
    }
  });

  it("does not silently demote replayed cases back to todo", () => {
    // This pin has 236 cases. The parent has 80 non-vacuous SDK runners; four
    // additional canonical address vectors raise that coverage to 84.
    // deleting a runner must fail loudly instead of quietly
    // converting the case back into an `it.todo`.
    expect(Object.keys(RUNNERS)).toHaveLength(84);
    expect(manifest.cases).toHaveLength(236);
  });

  it("#86 plus payload attestation: the SDK exposes all 25 separators", () => {
    // Was pinned at 18 with sig-registry-closed as an it.fails divergence; #86
    // reconciled the SDK to the closed §B.7 set, so it is now a passing case.
    expect(SIGNATURE_DOMAIN_SEPARATORS).toHaveLength(25);
  });
});
