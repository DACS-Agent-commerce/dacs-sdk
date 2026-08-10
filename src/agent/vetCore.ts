import { DacsError } from "../errors.js";
import type {
  AttestationRef,
  ClaimProofRef,
  CompositeVerificationRecord,
  VerificationDecision,
  VerifyResultEntry,
} from "../artifacts/types.js";
import {
  encodeAddressSegment,
  sha256Hex,
} from "../canonical/index.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  signedBytes,
} from "../crypto/index.js";
import type { RecipeDescriptor } from "../registry/types.js";
import { cciHasClaim, cciClaimProof, type CciRecord } from "../identity/index.js";
import {
  evaluateParserSpec,
  defaultParserEngine,
  type ParserEngine,
} from "./parserSpec.js";

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
 * The self-signed assertion is not a standalone artifact in the closed §B.7
 * registry, so SIG-4 gives it an experimental, collision-resistant domain.
 */
export const SELF_SIGNED_ASSERTION_SEPARATOR =
  "dacs-x-self-signed-assertion:v1:" as const;

const KEY_CLAIM = /^key:([0-9a-f]{64})(?:\?(.+))?$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const PARAMETER_ESCAPE = /%(?:3A|3F|26|3D|25)/g;

interface ParsedKeyClaim {
  identifier: string;
}

function decodeParameterPart(value: string): string | null {
  // CF-2 permits the five reserved delimiters only in their uppercase escaped
  // forms. A stray %, raw reserved delimiter, or non-NFC string is non-canonical.
  if (/[:?&=]/.test(value)) return null;
  const withoutEscapes = value.replace(PARAMETER_ESCAPE, "");
  if (withoutEscapes.includes("%")) return null;
  const decoded = value
    .replace(/%3A/g, ":")
    .replace(/%3F/g, "?")
    .replace(/%26/g, "&")
    .replace(/%3D/g, "=")
    .replace(/%25/g, "%");
  return decoded.normalize("NFC") === decoded ? decoded : null;
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0)!);
  const right = Array.from(b, (char) => char.codePointAt(0)!);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function parseCanonicalKeyClaim(value: string): ParsedKeyClaim | null {
  const match = KEY_CLAIM.exec(value);
  if (!match) return null;
  const rawParameters = match[2];
  if (rawParameters === undefined) return { identifier: match[1]! };

  const keys: string[] = [];
  for (const parameter of rawParameters.split("&")) {
    const equalsAt = parameter.indexOf("=");
    if (equalsAt <= 0 || equalsAt !== parameter.lastIndexOf("=")) return null;
    const key = decodeParameterPart(parameter.slice(0, equalsAt));
    const valuePart = decodeParameterPart(parameter.slice(equalsAt + 1));
    if (key === null || valuePart === null || keys.includes(key)) return null;
    keys.push(key);
  }
  for (let index = 1; index < keys.length; index += 1) {
    if (compareCodePoints(keys[index - 1]!, keys[index]!) >= 0) return null;
  }
  return { identifier: match[1]! };
}

/** The explicit DACS-2 §7.3.9 proof supplied to the self-signed method. */
export interface SelfSignedMethodInput {
  /** Canonical assertion bytes. For the v0.1 `key` recipe this is the ClaimReference itself. */
  assertion: string;
  /** Ed25519 signature encoded as 128 lowercase hex characters. */
  signature: string;
}

/** Evidence passed to the SR-2 anchoring seam after input-shape validation. */
export interface SelfSignedAnchorInput {
  /** CM-2 logical address for the anchored assertion evidence. */
  logicalAddress: string;
  subject: string;
  assertion: string;
  signature: string;
}

/**
 * Bytes a `key:` claim holder signs for a self-signed assertion.
 *
 * The assertion is already the canonical ClaimReference byte string. SIG-4 is
 * then applied using the universal single-hash recipe:
 * `domain || sha256(assertion)`.
 */
export function selfSignedAssertionBytes(assertion: string): Uint8Array {
  if (!parseCanonicalKeyClaim(assertion)) {
    throw new DacsError(
      "self-signed assertion must be a canonical key:<64-lowercase-hex> ClaimReference",
    );
  }
  return signedBytes(SELF_SIGNED_ASSERTION_SEPARATOR, sha256Hex(assertion));
}

/** DACS-2 CM-2 logical evidence address for the v0.1 `key` recipe. */
export function selfSignedAssertionAddress(
  jobId: string,
  subject: string,
  recipeVersion: string,
): string {
  const claim = parseCanonicalKeyClaim(subject);
  if (!claim) {
    throw new DacsError(
      "self-signed subject must be a canonical key:<64-lowercase-hex> ClaimReference",
    );
  }
  if (!jobId || !/^[0-9]+(?:\.[0-9]+)*$/.test(recipeVersion)) {
    throw new DacsError("self-signed assertion address requires jobId and recipeVersion");
  }
  return (
    `dacs2:${encodeAddressSegment(jobId)}:key:` +
    `${encodeAddressSegment(claim.identifier)}:v${recipeVersion}`
  );
}

function isAttestationRef(value: unknown): value is AttestationRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const ref = value as Partial<AttestationRef>;
  return (
    typeof ref.kind === "string" &&
    ref.kind.length > 0 &&
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    typeof ref.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(ref.contentHash)
  );
}

/**
 * Map a proxied HTTP status that is NOT 2xx to a verification decision (DACS-2).
 * A 2xx returns null → the caller proceeds to the ParserSpec / status-only pass.
 * The normative behavior distinguishes a definite "no record" (404) from a
 * reachable error (5xx / other) the verifier can't turn into a clean result:
 *  - 404 → the authority has no record of the subject. For a positive-match
 *    recipe that is a `fail` (the asserted credential is absent); for a
 *    negative-match recipe a bare 404 is NOT a completeness-confirmed "not listed",
 *    so it is `indeterminate` (fail-closed, PSP-5 spirit) rather than a silent pass.
 *  - any other non-2xx (3xx / other 4xx / 5xx) → `error`: reachable but with no
 *    trustworthy determination — never a silent `fail` or `pass`.
 */
function mapProxyStatus(
  httpStatus: number,
  negativeMatch: boolean,
): { decision: VerificationDecision } | null {
  if (httpStatus >= 200 && httpStatus < 300) return null;
  if (httpStatus === 404) return { decision: negativeMatch ? "indeterminate" : "fail" };
  return { decision: "error" };
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
 *  - self-signed: verifies an explicit, domain-separated Ed25519 assertion
 *    against a canonical `key:` ClaimReference and anchors the proof via SR-2.
 *  - consensus-backed-proxy: a DAHR proxy fetch of the recipe's authority URL.
 *    A 2xx is evaluated through the signed §7.4.1 `parserRules` ParserSpec;
 *    missing rules or body fail closed as `error`. The attested body is
 *    evaluated (PSP-1..5) for a content-based, DETERMINISTIC verdict —
 *    polarity (negativeMatch), indeterminateOn precedence, parse-error → error,
 *    and the PSP-5 completeness floor — via an injected parser engine that only
 *    reports predicate matches, never the decision.
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
  /**
   * PSP-5 completeness signal: whether the proxy confirmed the response was
   * COMPLETE (declared record-count / end-of-list sentinel / Content-Length ==
   * received bytes). Only consulted for a `requiresListCompleteness` negative-
   * match recipe — a `pass` on an unconfirmed/partial response is downgraded to
   * `indeterminate`.
   */
  complete?: boolean;
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
   * Parser-engine seam (DACS-2 §7.4.1 / #16). When a `consensus-backed-proxy`
   * recipe carries `parserRules`, the signed ParserSpec is evaluated against the
   * attested body per PSP-1..5 — the engine only reports low-level predicate
   * matches (JSONPath/selector/XPath/regex), while the deterministic decision
   * (polarity, indeterminateOn, error/completeness mapping) is fixed by the
   * recipe, NOT this dep. Defaults to {@link defaultParserEngine} (json + raw).
   */
  parserEngine?: ParserEngine;
  /**
   * SR-2 evidence seam for the self-signed method. The callback MUST anchor the
   * assertion + signature at `logicalAddress` and return an integrity-bearing
   * proof reference. Missing/failed anchoring makes the method `error`, never
   * `pass` or `fail`, because CM-2 was not completed.
   */
  anchorSelfSignedAssertion?: (
    input: SelfSignedAnchorInput,
  ) => Promise<AttestationRef>;
}

export interface VetRequest {
  /** The claim being vetted (e.g. a DID or a domain claim). */
  subject: string;
  /** The resolved, steward-signed recipe to run. */
  recipe: RecipeDescriptor;
  /** Registry version recorded on the record (defaults to "0.1"). */
  recipeVersion?: string;
  /** Session id used in the CM-2 evidence address; required for self-signed. */
  jobId?: string;
  /** Explicit §7.3.9 signed proof; required for the self-signed method. */
  selfSigned?: SelfSignedMethodInput;
}

export async function vetCore(
  req: VetRequest,
  deps: VetDeps,
): Promise<CompositeVerificationRecord> {
  const { subject, recipe } = req;
  const results: VerifyResultEntry[] = [];

  switch (recipe.method) {
    case "self-signed": {
      const input = req.selfSigned;
      const recipeVersion = req.recipeVersion ?? "0.1";
      const subjectClaim = parseCanonicalKeyClaim(subject);
      let status: VerificationDecision = "error";
      let attestation: AttestationRef | undefined;

      // Missing/malformed method input or an unresolvable ClaimReference is a
      // verifier input error. It is never evidence that the claimed key failed.
      const shapeIsValid =
        subjectClaim !== null &&
        typeof req.jobId === "string" &&
        req.jobId.length > 0 &&
        input !== undefined &&
        typeof input.assertion === "string" &&
        parseCanonicalKeyClaim(input.assertion) !== null &&
        typeof input.signature === "string" &&
        SIGNATURE_HEX.test(input.signature);

      if (shapeIsValid && input) {
        const assertionClaim = parseCanonicalKeyClaim(input.assertion)!;
        // CF-3: advisory parameters do not contribute to claim identity. The
        // signature still binds the exact CF-2 assertion bytes as supplied.
        const assertionMatches =
          assertionClaim.identifier === subjectClaim.identifier;
        if (!assertionMatches) {
          // A validly-shaped assertion replayed for another claim is a
          // conclusive proof mismatch, not a parser/transport failure.
          status = "fail";
        } else {
          try {
            const signature = Uint8Array.from(Buffer.from(input.signature, "hex"));
            const publicKey = Uint8Array.from(Buffer.from(subjectClaim.identifier, "hex"));
            status = ed25519Verify(
              selfSignedAssertionBytes(input.assertion),
              signature,
              publicKeyFromRaw(publicKey),
            )
              ? "pass"
              : "fail";
          } catch {
            status = "error";
          }
        }

        // CM-2 is part of method completion even when the well-formed signature
        // is invalid: retain the exact evidence that produced pass/fail.
        if (deps.anchorSelfSignedAssertion) {
          try {
            const anchored = await deps.anchorSelfSignedAssertion({
              logicalAddress: selfSignedAssertionAddress(
                req.jobId!,
                subject,
                recipeVersion,
              ),
              subject,
              assertion: input.assertion,
              signature: input.signature,
            });
            if (isAttestationRef(anchored)) {
              attestation = anchored;
            } else {
              status = "error";
            }
          } catch {
            status = "error";
          }
        } else {
          status = "error";
        }
      }

      results.push({
        claimRef: subject,
        method: "self-signed",
        status,
        authority: subject,
        ...(attestation ? { attestation } : {}),
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
      const negativeMatch = recipe.negativeMatch === true;
      // HTTP status first: a 2xx proceeds; a non-2xx is mapped so that a definite
      // "no record" (404) is distinguished from a reachable error (5xx / other →
      // `error`) rather than collapsing every non-2xx to `fail`. On a 2xx, if the
      // signed recipe MUST carry a ParserSpec (§7.4.1), evaluated against the
      // DAHR-attested body. Missing rules or body are `error`, never the old
      // status-only `2xx ⇒ pass` trust path.
      let status: VerificationDecision;
      let data: Record<string, unknown> | undefined;
      const httpMap = mapProxyStatus(res.status, negativeMatch);
      if (httpMap) {
        status = httpMap.decision;
      } else if (recipe.parserRules) {
        if (typeof res.body !== "string") {
          status = "error";
        } else {
          const engine: ParserEngine = deps.parserEngine ?? defaultParserEngine;
          try {
            const evaluation = evaluateParserSpec(recipe.parserRules, res.body, engine, {
              negativeMatch,
              requiresCompleteness: recipe.requiresListCompleteness === true,
              listComplete: res.complete === true,
            });
            status = evaluation.decision;
            data = evaluation.data; // PSP-3: record the parsed data map on the result
          } catch {
            // JS callers can bypass the TS ParserSpec shape. A malformed signed
            // rule is a verification error, never an exception or status-only pass.
            status = "error";
          }
        }
      } else {
        status = "error";
      }
      results.push({
        claimRef: subject,
        method: "consensus-backed-proxy",
        status,
        authority: url,
        // Record the DAHR attestation so the vet record carries the evidence.
        ...(res.responseHash ? { responseHash: res.responseHash } : {}),
        ...(data ? { data } : {}),
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
