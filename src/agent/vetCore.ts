import { DacsError } from "../errors.js";
import type {
  ClaimProofRef,
  CompositeVerificationRecord,
  VerificationDecision,
  VerifyResultEntry,
} from "../artifacts/types.js";
import type { RecipeDescriptor } from "../registry/types.js";
import { cciHasClaim, cciClaimProof, type CciRecord } from "../identity/index.js";

/**
 * Composite decision over per-method results (DACS-2 §7.7) — worst result
 * wins: error > indeterminate > fail > pass. Empty/inconclusive is
 * `indeterminate`, never `pass` (indeterminate is not pass).
 */
function compositeDecision(
  statuses: VerificationDecision[],
): VerificationDecision {
  if (statuses.length === 0) return "indeterminate";
  if (statuses.includes("error")) return "error";
  if (statuses.includes("indeterminate")) return "indeterminate";
  if (statuses.includes("fail")) return "fail";
  return "pass";
}

/**
 * Classify a CCI claim proof honestly (#31): a 64-char sha256 hex is a `hash`;
 * anything else (a `/.well-known` URL, a signature, …) is a `raw` reference. The
 * proof is NOT a DAHR attestation, so it never belongs in `responseHash`.
 */
function classifyClaimProof(value: string): ClaimProofRef {
  return { kind: /^[0-9a-f]{64}$/i.test(value) ? "hash" : "raw", value };
}

/**
 * Read a boolean "is this address sanctioned" indicator out of a screening
 * response body. Returns null when the body can't be parsed / the field is
 * missing — the caller treats null as `indeterminate` (fail-closed), never pass.
 */
function readSanctioned(
  body: string | undefined,
  field: string,
): boolean | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const v = parsed[field];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "listed") return true;
      if (s === "false" || s === "0" || s === "clear") return false;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The Vet stage (DACS-2). Runs a resolved, steward-signed verification recipe
 * against a subject claim and produces a CompositeVerificationRecord. Dispatch
 * is by recipe.method so adding a method later is a new case + a registry
 * entry, not a rewrite (mirrors the rail dispatch). The recipe is passed in
 * already-resolved — the caller pins it via resolveRecipe with the steward key,
 * the same way settlement is injected into runSession.
 *
 * MVP methods:
 *  - self-signed: the subject self-asserts; recorded as a pass with the subject
 *    as its own authority.
 *  - consensus-backed-proxy: a DAHR proxy fetch of the recipe's authority URL;
 *    a 2xx is a pass, attested by the proxy's response hash. An optional injected
 *    `checkBody` policy (#16a) can refine a 2xx from the attested body, so
 *    content-based rules ("the binding matches the claimed login") are
 *    expressible instead of status-code-only.
 *  - cci-claim: the subject must hold a specific linked claim in its CCI record
 *    (DACS-1) — e.g. a verified X handle or a bound wallet. Resolves the record
 *    and passes iff `params.requiredClaim` is present.
 *  - ofac-screen: sanctions screening. Enumerates the subject's cross-chain
 *    wallets (from the CCI record) and DAHR-proxies each against the recipe's
 *    screening endpoint (`params.screeningUrlTemplate`, `{address}` substituted).
 *    A listed wallet is a `fail`; an unscreenable one is `indeterminate` (never a
 *    silent pass) — so the composite is `pass` only when every wallet is clean.
 *    NOTE: this screens the linked cross-chain WALLETS only, not the subject's
 *    primary Demos address — sanctions endpoints are chain-specific and screen
 *    on-chain (EVM/etc.) addresses. A subject with no linked wallets is
 *    `indeterminate` (nothing to clear), never `pass`.
 */

export interface VetProxyResult {
  status: number;
  /** DAHR attestation of the proxied response body. */
  responseHash: string;
  /** The proxied response body, when the method needs to inspect it (e.g. ofac-screen). */
  body?: string;
}

export interface VetDeps {
  /** Consensus-backed proxy fetch (DAHR). */
  proxyFetch: (req: { url: string; method?: string }) => Promise<VetProxyResult>;
  /** Current ISO-8601 timestamp. */
  now: () => string;
  /**
   * Resolve a subject's cross-context identity record (DACS-1). Required by the
   * `cci-claim` and `ofac-screen` methods — e.g. wire `(s) => agent.resolveIdentity(s)`.
   */
  resolveCci?: (subject: string) => Promise<CciRecord>;
  /**
   * OPTIONAL content policy for `consensus-backed-proxy` (#16a). Status-only
   * `2xx ⇒ pass` can't express body-dependent policies ("the CCI binding matches
   * the claimed login", "account older than a year", …). When supplied, it runs
   * on a 2xx response and its verdict REFINES the result — a definite `fail`/
   * `indeterminate` overrides the bare pass; `pass` confirms it; `null` defers to
   * the status-only verdict. The DAHR `responseHash` still records the exact body
   * the decision rested on. The `recipe.params` carry the policy criteria; this
   * hook is the executor, mirroring how `proxyFetch`/`resolveCci` are injected.
   */
  checkBody?: (
    body: string | undefined,
    recipe: RecipeDescriptor,
    subject: string,
  ) => VerificationDecision | null;
}

export interface VetRequest {
  /** The claim being vetted (e.g. a DID or a domain claim). */
  subject: string;
  /** The resolved, steward-signed recipe to run. */
  recipe: RecipeDescriptor;
  /** Registry version recorded on the record (defaults to "0.1"). */
  recipeVersion?: string;
}

export async function vetCore(
  req: VetRequest,
  deps: VetDeps,
): Promise<CompositeVerificationRecord> {
  const { subject, recipe } = req;
  const results: VerifyResultEntry[] = [];

  switch (recipe.method) {
    case "self-signed": {
      results.push({
        claimRef: subject,
        method: "self-signed",
        status: "pass",
        authority: subject,
      });
      break;
    }
    case "consensus-backed-proxy": {
      const url = recipe.params["authorityUrl"];
      if (typeof url !== "string" || !url) {
        throw new DacsError(
          `recipe "${recipe.id}" (consensus-backed-proxy) missing params.authorityUrl`,
        );
      }
      const res = await deps.proxyFetch({ url });
      const ok = res.status >= 200 && res.status < 300;
      // Status first: a non-2xx is a definite fail regardless of body. On a 2xx,
      // an optional content policy (#16a) can refine the verdict from the DAHR-
      // attested body — e.g. downgrade to `fail`/`indeterminate` when the body
      // doesn't satisfy the recipe's criteria. Absent the hook, status-only.
      let status: VerificationDecision = ok ? "pass" : "fail";
      if (ok && deps.checkBody) {
        const refined = deps.checkBody(res.body, recipe, subject);
        if (refined) status = refined;
      }
      results.push({
        claimRef: subject,
        method: "consensus-backed-proxy",
        status,
        authority: url,
        // Record the DAHR attestation so the vet record carries the evidence.
        ...(res.responseHash ? { responseHash: res.responseHash } : {}),
      });
      break;
    }
    case "cci-claim": {
      const requiredClaim = recipe.params["requiredClaim"];
      if (typeof requiredClaim !== "string" || !requiredClaim) {
        throw new DacsError(
          `recipe "${recipe.id}" (cci-claim) missing params.requiredClaim`,
        );
      }
      if (!deps.resolveCci) {
        throw new DacsError(
          "cci-claim recipe requires deps.resolveCci to resolve the subject's identity",
        );
      }
      const record = await deps.resolveCci(subject);
      const held = cciHasClaim(record, requiredClaim);
      // Optional stricter gate: the claim must not only be asserted but carry
      // an attested proof (a verified /.well-known URL or signature the node
      // stored). Only proof-bearing families (web2 / ud) can satisfy it.
      const requireProof = recipe.params["requireProof"] === true;
      const proof = held ? cciClaimProof(record, requiredClaim) : undefined;
      const pass = held && (!requireProof || proof !== undefined);
      results.push({
        claimRef: requiredClaim,
        method: "cci-claim",
        status: pass ? "pass" : "fail",
        // The CCI (the subject's primary key) is the authority that binds the claim.
        authority: record.primaryClaim,
        // A cci-claim proof is the GCR-stored /.well-known URL / hash / signature,
        // NOT a DAHR attestation — record it in the honestly-typed `proof` field,
        // never in `responseHash` (#31).
        ...(proof ? { proof: classifyClaimProof(proof) } : {}),
      });
      break;
    }
    case "ofac-screen": {
      const template = recipe.params["screeningUrlTemplate"];
      if (typeof template !== "string" || !template.includes("{address}")) {
        throw new DacsError(
          `recipe "${recipe.id}" (ofac-screen) needs params.screeningUrlTemplate containing {address}`,
        );
      }
      if (!deps.resolveCci) {
        throw new DacsError(
          "ofac-screen recipe requires deps.resolveCci to enumerate the subject's wallets",
        );
      }
      const matchField =
        typeof recipe.params["matchField"] === "string"
          ? (recipe.params["matchField"] as string)
          : "listed";
      const record = await deps.resolveCci(subject);
      if (record.wallets.length === 0) {
        // No wallets to screen — can't clear the subject; indeterminate (not pass).
        results.push({
          claimRef: subject,
          method: "ofac-screen",
          status: "indeterminate",
          authority: template,
        });
        break;
      }
      for (const wallet of record.wallets) {
        const url = template.replace("{address}", encodeURIComponent(wallet.address));
        const res = await deps.proxyFetch({ url });
        const ok2xx = res.status >= 200 && res.status < 300;
        let status: VerificationDecision;
        if (!ok2xx) {
          status = "indeterminate"; // couldn't screen → fail-closed
        } else {
          const sanctioned = readSanctioned(res.body, matchField);
          status =
            sanctioned === null ? "indeterminate" : sanctioned ? "fail" : "pass";
        }
        results.push({
          claimRef: wallet.ref,
          method: "ofac-screen",
          status,
          authority: url,
          ...(res.responseHash ? { responseHash: res.responseHash } : {}),
        });
      }
      break;
    }
    default:
      throw new DacsError(`unsupported verification method: ${recipe.method}`);
  }

  return {
    subject,
    recipeId: recipe.id,
    recipeVersion: req.recipeVersion ?? "0.1",
    results,
    // Composite decision — worst result wins; the session proceeds only on pass.
    decision: compositeDecision(results.map((r) => r.status)),
    verifiedAt: deps.now(),
  };
}
