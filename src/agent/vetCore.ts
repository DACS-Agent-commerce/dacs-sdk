import { DacsError } from "../errors.js";
import type {
  CompositeVerificationRecord,
  VerifyResultEntry,
} from "../artifacts/types.js";
import type { RecipeDescriptor } from "../registry/types.js";

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
 *    a 2xx is a pass, attested by the proxy's response hash.
 */

export interface VetProxyResult {
  status: number;
  /** DAHR attestation of the proxied response body. */
  responseHash: string;
}

export interface VetDeps {
  /** Consensus-backed proxy fetch (DAHR). */
  proxyFetch: (req: { url: string; method?: string }) => Promise<VetProxyResult>;
  /** Current ISO-8601 timestamp. */
  now: () => string;
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
      results.push({
        claimRef: subject,
        method: "consensus-backed-proxy",
        status: ok ? "pass" : "fail",
        authority: url,
      });
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
    // Single-result recipes for the MVP; requiredPassed is the conjunction.
    requiredPassed: results.every((r) => r.status === "pass"),
    verifiedAt: deps.now(),
  };
}
