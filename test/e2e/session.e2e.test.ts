import { describe, expect, test } from "vitest";

import { buildSignedArtifact, verifySignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionDeps,
} from "../../src/agent/runSessionCore.js";
import {
  vetCore,
  type VetOperationStore,
} from "../../src/agent/vetCore.js";
import {
  verifyCompositeVerificationRecord,
  type CompositeBundleRequirement,
} from "../../src/agent/compositeVerification.js";
import {
  verifyBundleCore,
  type VerifyBundleDeps,
} from "../../src/agent/verifyBundleCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  signComponentArtifact,
  verifyComponentSignature,
} from "../../src/artifacts/signatures.js";
import { resolveRecipe } from "../../src/registry/resolve.js";
import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  x402SettleCore,
  type X402ClientLike,
  type X402PaymentRequired,
} from "../../src/rails/x402.js";

// ── Identities (CCI == ed25519 pubkey hex embedded in the DID) ──
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 11));
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 13));
const NETWORK = "eip155:84532";
const RECIPIENT_EVM = "0x1111111111111111111111111111111111111111";
const BUYER_EVM = "0x2222222222222222222222222222222222222222";

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
function didFor(seed: Uint8Array): string {
  return `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
}
const sellerDid = didFor(SELLER_SEED);
const buyerDid = didFor(BUYER_SEED);
const signSeller = signerFor(SELLER_SEED);
const signBuyer = signerFor(BUYER_SEED);
const sellerBundleHash = sha256Hex(`identity:${sellerDid}`);
const sellerRequirement: CompositeBundleRequirement = {
  requirementVersion: "1",
  required: [{ scheme: "did", verificationRequired: true, recipeVersion: 1 }],
};
const authorityBody = JSON.stringify({ ok: true });
const authorityLocator = "https://authority.example/e2e-evidence";
const RECIPE_ADDR = "stor:recipe:did:consensus-backed-proxy:v1";

const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
  ed25519Verify(b, s, publicKeyFromRaw(p));
function resolveFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

// ── In-memory substrate (anchor/read against a Map) ──
function memSubstrate() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    anchor: async (name: string, value: object) => {
      const address = `stor:${name}`;
      store.set(address, value as Record<string, unknown>);
      return address;
    },
    anchorAddress: async (name: string) => `stor:${name}`,
    read: async (ref: string) => store.get(ref) ?? null,
    resolveAnchor: async (name: string) => {
      const ref = `stor:${name}`;
      const value = store.get(ref);
      return value
        ? { status: "present" as const, ref, value }
        : { status: "absent" as const };
    },
  };
}

function memVetOperationStore(): VetOperationStore {
  const checkpoints = new Map<string, unknown>();
  const completed = new Map<
    string,
    { operationHash: string; inputHash: string; value: unknown }
  >();
  const inflight = new Map<string, Promise<unknown>>();
  return {
    load: async (operationKey) => {
      const value = checkpoints.get(operationKey);
      return value === undefined ? null : structuredClone(value);
    },
    compareAndSet: async ({ operationKey, expected, next }) => {
      const current = checkpoints.get(operationKey);
      const matches = expected === null
        ? current === undefined
        : current !== undefined && canonicalize(current) === canonicalize(expected);
      if (!matches) return false;
      checkpoints.set(operationKey, structuredClone(next));
      return true;
    },
    runOnce: async ({ operationKey, operationHash, step, inputHash, execute }) => {
      const key = `${operationKey}\u0000${step}`;
      const prior = completed.get(key);
      if (prior) {
        if (prior.operationHash !== operationHash || prior.inputHash !== inputHash) {
          throw new Error(`Vet step ${step} input changed`);
        }
        return structuredClone(prior.value);
      }
      let pending = inflight.get(key);
      if (!pending) {
        pending = (async () => {
          const value = structuredClone(await execute());
          completed.set(key, { operationHash, inputHash, value });
          return value;
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return structuredClone(await pending);
    },
  };
}

// ── Bundle-verification deps: resolve referenced artifacts via the substrate ──
function strictComposite(
  sub: ReturnType<typeof memSubstrate>,
  record: Parameters<typeof verifyCompositeVerificationRecord>[0],
  expected: { jobId: string; evaluatedParty: string; bundleHash: string },
) {
  if (!record || typeof record !== "object" || !("dealSpecific" in record)) {
    return Promise.resolve({
      status: "invalid" as const,
      code: "record-shape" as const,
    });
  }
  const current = record as import("../../src/artifacts/types.js").CompositeVerificationRecord;
  return verifyCompositeVerificationRecord(
    current,
    {
      ...expected,
      requirement: sellerRequirement,
      verifier: buyerDid,
      freshness: [],
      dealSpecific: current.dealSpecific.map((ref) => ({
        ref,
        scheme: "did",
        identifier: sellerDid.slice(sellerDid.indexOf(":") + 1),
        method: "consensus-backed-proxy",
        requirement: sellerRequirement.required[0]!,
      })),
    },
    {
      nowMs: () => 1780000000000,
      resolveRecipe: async () =>
        sub.read(RECIPE_ADDR) as Promise<never>,
      isRecipeSignerAuthorized: (_recipe, signature) =>
        signature.signer === buyerDid,
      resolve: async (ref) => {
        if (ref.anchor.locator === authorityLocator) {
          return {
            encoding: "bytes" as const,
            value: Uint8Array.from(Buffer.from(authorityBody)),
          };
        }
        const result = await sub.read(ref.anchor.locator);
        return result
          ? { encoding: "canonical-json" as const, value: result }
          : null;
      },
      isVerifyResultSignerAuthorized: (_result, signature) =>
        signature.signer === buyerDid,
      resolvePublicKey: async (signature) => resolveFromDid(signature.signer),
      verify: ({ signedBytes, signature, publicKey }) =>
        verify(
          signedBytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKey,
        ),
      verifyAuthorityAttestation: () => "valid",
    },
  );
}

function verifyDeps(sub: ReturnType<typeof memSubstrate>): VerifyBundleDeps {
  return {
    readArtifact: sub.read,
    resolveRef: async (kind, jobId, _parties, legacyRef) => {
      if (kind === "dacs-2-composite" && legacyRef) {
        return sub.read(legacyRef.id);
      }
      const name =
        kind === "dacs-3-agreement"
          ? sessionAnchorName.agreement(jobId)
          : kind === "dacs-4-evidence"
            ? sessionAnchorName.evidence(jobId)
            : kind === "dacs-2-verifyresult"
              ? sessionAnchorName.vet(jobId, sellerDid)
              : null;
      if (!name) return null;
      return sub.read(await sub.anchorAddress(name));
    },
    resolvePublicKey: async (did) => resolveFromDid(did),
    verify,
    verifyCompositeRecord: (record, bundle) => {
      const party = bundle.parties.find(
        (candidate) => candidate.primaryClaim === sellerDid,
      );
      return strictComposite(sub, record, {
        jobId: bundle.jobId,
        evaluatedParty: sellerDid,
        bundleHash: party?.bundleHash ?? "0".repeat(64),
      });
    },
  };
}

// ── Fake x402 seller: advertises exactly the agreed base-unit amount ──
function fakeClient(accepts: X402PaymentRequired["accepts"]): X402ClientLike {
  return {
    getPaymentRequiredResponse: () => ({ accepts }),
    createPaymentPayload: async (pr) => pr,
    encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "signed" }),
    getPaymentSettleResponse: () => ({
      success: true,
      transaction: "0xsettlement",
      network: NETWORK,
      payer: BUYER_EVM,
      amount: "1000000",
    }),
  };
}
function fakeFetch(): typeof fetch {
  let n = 0;
  return (async () => {
    n += 1;
    return n === 1
      ? new Response("{}", { status: 402 })
      : new Response(JSON.stringify({ data: "deliverable" }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("end-to-end session (publish → negotiate → x402 settle → verify)", () => {
  async function runFlow(sub = memSubstrate(), listingVersion?: number) {
    const vetOperationStore = memVetOperationStore();
    // 1. Seller publishes a signed, anchored fixed-price listing. When a
    // listingVersion is given, anchor at the versioned §6.3.4 address (#29).
    const listingSigned = await buildSignedArtifact(
      {
        agentId: sellerDid,
        serviceId: "market-data",
        name: "Market Data",
        description: "EOD prices",
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
        ...(listingVersion !== undefined ? { listingVersion } : {}),
      },
      ARTIFACT_SEPARATORS.Listing,
      signSeller,
    );
    const listingRef = await sub.anchor(
      listingVersion !== undefined
        ? listingAddress(sellerDid, "market-data", listingVersion)
        : `dacs1:listing:${sellerDid}:market-data`,
      listingSigned,
    );

    const signedRecipe = await signComponentArtifact(
      {
        recipeVersion: 1,
        scheme: "did",
        defaultMethod: {
          kind: "consensus-backed-proxy" as const,
          endpoint: {
            method: "GET" as const,
            urlTemplate: authorityLocator,
          },
        },
        defaultMaxAgeSec: 3600,
        parserRules: { format: "json" as const, successJsonPath: "$.ok" },
        retryClass: "permanent" as const,
        availability: "live" as const,
        governance: {
          proposedBy: buyerDid,
          acceptedAt: 1779999999000,
          anchoring: "single-signer" as const,
        },
      },
      "dacs-recipe:v1:",
      {
        algorithm: "ed25519",
        signer: buyerDid,
        sign: signBuyer,
      },
    );
    const authenticatedRecipe = await resolveRecipe(
      "recipe-registry",
      { scheme: "did", method: "consensus-backed-proxy", recipeVersion: 1 },
      {
        readRegistry: async () => ({ entries: [signedRecipe] }),
        stewardPublicKey: rawPublicKey(publicKeyFromSeed(BUYER_SEED)),
        stewardSigner: buyerDid,
        verify,
      },
    );
    sub.store.set(
      RECIPE_ADDR,
      structuredClone(authenticatedRecipe) as unknown as Record<string, unknown>,
    );

    // 2. Buyer runs the session: the x402 rail is the injected settle executor.
    const deps: SessionDeps = {
      buyerId: buyerDid,
      expectedSettlementPayee: RECIPIENT_EVM,
      readListing: sub.read,
      sign: (artifact, sep) =>
        buildSignedArtifact(artifact, sep as never, signBuyer),
      signBytes: async (bytes) => signBuyer(bytes),
      anchor: sub.anchor,
      resolveAnchor: sub.resolveAnchor,
      settle: (req) =>
        x402SettleCore(
          {
            paywallUrl: "https://seller.example/deliver",
            network: NETWORK,
            recipientEvm: RECIPIENT_EVM,
            amount: req.amount,
            asset: req.asset,
          },
          {
            client: fakeClient([
              { network: NETWORK, payTo: RECIPIENT_EVM, amount: req.amount, asset: req.asset },
            ]),
            fetchImpl: fakeFetch(),
            payerAddress: BUYER_EVM,
          },
        ),
      // Vet the seller through an anchored, signed current VerifyResult.
      vet: ({ jobId, evaluatedParty }) =>
        vetCore(
          {
            jobId,
            subject: evaluatedParty,
            bundleHash: sellerBundleHash,
            requirement: sellerRequirement,
            recipe: authenticatedRecipe,
          },
          {
            proxyFetch: async () => ({
              status: 200,
              body: authorityBody,
              fetchedAt: 1780000000000,
              attestation: {
                anchor: { kind: "https", locator: authorityLocator },
                contentHash: sha256Hex(authorityBody),
                signer: "substrate-validator-set:demos-testnet:1",
              },
            }),
            nowMs: () => 1780000000000,
            componentSigner: {
              algorithm: "ed25519",
              signer: buyerDid,
              sign: (bytes) => signBuyer(bytes),
            },
            anchorFinalizedArtifact: async ({ artifact, logicalAddress }) => {
              const locator = await sub.anchor(logicalAddress, artifact);
              const hash = contentHash(artifact as Record<string, unknown>);
              return {
                ref: {
                  anchor: { kind: "storage-program", locator },
                  contentHash: hash,
                },
                receipt: {
                  receiptVersion: "1",
                  substrate: "memory",
                  finalityProfile: "instant",
                  logicalAddress,
                  nativeAddress: locator,
                  contentHash: hash,
                  transactionRef: { kind: "memory", value: `tx:${logicalAddress}` },
                  writer: buyerDid,
                  state: "finalized",
                  observationDisposition: "established",
                  observedAt: 1780000000000,
                  blockRef: { id: `block:${logicalAddress}` },
                  evidence: { kind: "memory-proof", value: "authenticated" },
                },
              };
            },
            verifyFinalizedAnchor: () => true,
            readAnchoredJson: (ref) => sub.read(ref.anchor.locator),
            resolveFinalizedArtifact: async ({
              logicalAddress,
              contentHash: expectedContentHash,
            }) => {
              const locator = `stor:${logicalAddress}`;
              const artifact = await sub.read(locator);
              if (!artifact || contentHash(artifact) !== expectedContentHash) {
                return null;
              }
              return {
                ref: {
                  anchor: { kind: "storage-program", locator },
                  contentHash: expectedContentHash,
                },
                receipt: {
                  receiptVersion: "1",
                  substrate: "memory",
                  finalityProfile: "instant",
                  logicalAddress,
                  nativeAddress: locator,
                  contentHash: expectedContentHash,
                  transactionRef: { kind: "memory", value: `tx:${logicalAddress}` },
                  writer: buyerDid,
                  state: "finalized",
                  observationDisposition: "established",
                  observedAt: 1780000000000,
                  blockRef: { id: `block:${logicalAddress}` },
                  evidence: { kind: "memory-proof", value: "authenticated" },
                },
              };
            },
            operationStore: vetOperationStore,
          },
        ),
      verifyVetRecord: (record, request) =>
        strictComposite(sub, record, {
          jobId: request.jobId,
          evaluatedParty: request.evaluatedParty,
          bundleHash: sellerBundleHash,
        }),
      authenticateVetFinality: async (request) => {
        const persisted = await sub.read(request.nativeAddress);
        if (
          persisted === null ||
          contentHash(persisted) !== request.contentHash ||
          canonicalize(persisted) !== canonicalize(request.record)
        ) {
          return null;
        }
        return {
          ref: {
            anchor: {
              kind: "storage-program",
              locator: request.nativeAddress,
            },
            contentHash: request.contentHash,
          },
          receipt: {
            receiptVersion: "1",
            substrate: "memory",
            finalityProfile: "instant",
            logicalAddress: request.logicalAddress,
            nativeAddress: request.nativeAddress,
            contentHash: request.contentHash,
            transactionRef: {
              kind: "memory",
              value: `tx:${request.logicalAddress}`,
            },
            writer: buyerDid,
            state: "finalized",
            observationDisposition: "established",
            observedAt: 1780000000000,
            blockRef: { id: `block:${request.logicalAddress}` },
            evidence: { kind: "memory-proof", value: "authenticated" },
          },
        };
      },
      newJobId: () => "job-e2e",
      now: () => "2026-01-01T00:00:00Z",
      nowMs: () => 1780000000000,
      // #41 — REAL listing verification end to end: recompute the signature over
      // the stored artifact and check it against the key in the advertised seller
      // claim. Proves the happy path runs on a genuinely signed listing.
      verifyListing: (raw, sellerClaim) => {
        const key = resolveFromDid(sellerClaim);
        return key
          ? verifySignedArtifact(raw, ARTIFACT_SEPARATORS.Listing, key, verify)
          : false;
      },
    };
    const result = await runSessionCore(
      listingRef,
      {
        price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
        deliveryPhase: "deliver-attested-payload",
        deliveryFormat: "application/json",
      },
      deps,
    );
    return { sub, listingRef, result };
  }

  test("completes and strict verification fail-closes the legacy one-sided bundle", async () => {
    const { sub, listingRef, result } = await runFlow();

    expect(result.outcome).toBe("completed");
    expect(result.agreementRef).toBe("stor:dacs3:agreement:job-e2e");
    expect(result.settlementRef).toBe("stor:dacs4:evidence:job-e2e");

    // The verifier below did not participate in production. Artifacts whose
    // normative schema uses ComponentSignature must authenticate independently.
    // AgreementSignature[] migration is owned by #98.
    const lifecycleArtifacts = [
      [result.vetRef!, ARTIFACT_SEPARATORS.CompositeVerificationRecord],
      [result.settlementRef, ARTIFACT_SEPARATORS.SettlementEvidence],
    ] as const;
    for (const [ref, separator] of lifecycleArtifacts) {
      const artifact = sub.store.get(ref)!;
      await expect(
        verifyComponentSignature(artifact, separator, {
          isSignerAuthorized: (_record, signature) =>
            signature.signer === buyerDid,
          resolvePublicKey: (signature) => resolveFromDid(signature.signer),
          verify: ({ signedBytes, signature, publicKey }) =>
            verify(
              signedBytes,
              Uint8Array.from(Buffer.from(signature.value, "base64url")),
              publicKey,
            ),
        }),
      ).resolves.toMatchObject({ status: "valid" });
    }

    // runSessionCore still emits the legacy MVP buyer-only bundle. A strict
    // third-party verifier must reject it until the two-sided producer helper
    // is wired into this orchestration path.
    const v = await verifyBundleCore(result.bundleRef, verifyDeps(sub));

    expect(v.ok).toBe(false);
    expect(v.fullyVerified).toBe(false);
    expect(v.reason).toMatch(/missing required signature/);
    expect(v.reason).toContain(sellerDid);
    // The bundle's buyer signature verifies over the §10.4.1 signed scope.
    expect(v.signatures).toEqual([{ party: buyerDid, verdict: "valid" }]);
    // Full 5-stage spec bundle: content-addressed listing/agreement refs +
    // vet record + settlement evidence.
    expect(result.vetRef).toBeDefined();
    expect(v.bundle?.outcome).toBe("completed");
    expect(v.bundle?.vetRecords).toHaveLength(1);
    expect(v.bundle?.settlementEvidence).toHaveLength(1);
    expect(v.bundle?.listingRef.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.bundle?.agreementRef?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Settlement evidence carries the rail's reported tx hash.
    const evidence = sub.store.get(result.settlementRef);
    // DACS-4 spec shape: outcome + payment txRefs (was the flat txHash/ok).
    expect(evidence).toMatchObject({
      evidenceVersion: "1",
      outcome: "success",
      paymentTxRefs: [{ txHash: "0xsettlement", kind: "payment" }],
    });
  });

  test("versioned listing (#29): the bundle pins the version it was struck against, and a later version doesn't break it", async () => {
    const sub = memSubstrate();
    // Deal struck against listing v2, anchored at the versioned §6.3.4 address.
    const { result } = await runFlow(sub, 2);
    const v = await verifyBundleCore(result.bundleRef, verifyDeps(sub));
    // Strict two-sided verification fail-closes the legacy buyer-only bundle
    // (see the first test) — assert that the missing seller signature is the
    // ONLY failure: every referenced artifact, including the v2 listing at its
    // versioned §6.3.4 address, must still dereference and hash-match. That
    // ref integrity is what #29's version pinning is about.
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/missing required signature/);
    expect(v.refs.every((r) => r.verdict === "ok")).toBe(true);
    // The bundle records the exact version it pinned, not a hardcoded 1.
    expect(v.bundle?.listingRef.version).toBe(2);
    const pinnedHash = v.bundle?.listingRef.contentHash;

    // The seller publishes v3 (a new address); v2's anchor is untouched, so the
    // historical bundle still verifies against the version it pinned.
    const v3Signed = await buildSignedArtifact(
      {
        agentId: sellerDid,
        serviceId: "market-data",
        name: "Market Data",
        description: "EOD prices + intraday", // edited content
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
        listingVersion: 3,
      },
      ARTIFACT_SEPARATORS.Listing,
      signSeller,
    );
    await sub.anchor(listingAddress(sellerDid, "market-data", 3), v3Signed);

    const after = await verifyBundleCore(result.bundleRef, verifyDeps(sub));
    // Still only the one-sided gap — v3's publication changed nothing: the
    // pinned v2 ref still resolves and hash-matches at its own address.
    expect(after.reason).toMatch(/missing required signature/);
    expect(after.refs.every((r) => r.verdict === "ok")).toBe(true);
    expect(after.bundle?.listingRef.contentHash).toBe(pinnedHash);
  });

  test("tampering the anchored bundle breaks signature verification", async () => {
    const { sub, result } = await runFlow();
    // Mutate a supported signed-scope field of the bundle after it was signed.
    const bundle = { ...sub.store.get(result.bundleRef)! };
    bundle.finalisedAt = 1780000000001;
    sub.store.set(result.bundleRef, bundle);

    const v = await verifyBundleCore(result.bundleRef, verifyDeps(sub));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/signature/);
  });
});
