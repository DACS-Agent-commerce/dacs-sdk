import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  type ArtifactKind,
  contentHash,
  isAgreementDocument,
  isAttestationBundle,
  isCompositeVerificationRecord,
  isListing,
  isSettlementEvidence,
} from "../../src/index.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const VECTOR = join(CONF, "vectors/dacs-v0.1-happy-path.json");
// SettlementEvidence migrated to the rich/normative §14 shape; the happy-path
// vector still carries the stale simple shape, so validate the rich fixture.
const EV_FIXTURE = join(CONF, "fixtures/settlement-evidence-payment-success.json");
const BUNDLE_FIXTURE = join(CONF, "fixtures/attestation-bundle-0004.json");
const have = existsSync(VECTOR);

const VALIDATORS: Record<ArtifactKind, (v: unknown) => boolean> = {
  Listing: isListing,
  CompositeVerificationRecord: isCompositeVerificationRecord,
  AgreementDocument: isAgreementDocument,
  SettlementEvidence: isSettlementEvidence,
  AttestationBundle: isAttestationBundle,
};

describe("spine artifacts vs the §14 happy-path vector (T3)", () => {
  if (!have) {
    it.skip("vectors not synced — run `npm run conformance:sync`", () => {});
    return;
  }

  const vector = JSON.parse(readFileSync(VECTOR, "utf8")) as {
    artifacts: Array<{
      kind: string;
      domainSeparator: string;
      artifact: Record<string, unknown>;
    }>;
  };

  for (const a of vector.artifacts) {
    const kind = a.kind as ArtifactKind;
    const validator = VALIDATORS[kind];
    if (!validator) continue;

    it(`${kind}: validator accepts the fixture`, () => {
      // SettlementEvidence + AttestationBundle migrated to the rich/normative
      // §14 shapes; the happy-path vector still carries the stale simple shape,
      // so validate the rich fixtures for those.
      let fixture = a.artifact;
      if (kind === "SettlementEvidence") {
        fixture = JSON.parse(readFileSync(EV_FIXTURE, "utf8")).evidence;
      } else if (kind === "AttestationBundle") {
        fixture = JSON.parse(readFileSync(BUNDLE_FIXTURE, "utf8"));
      }
      expect(validator(fixture)).toBe(true);
    });

    it(`${kind}: registry separator matches the spec`, () => {
      expect(ARTIFACT_SEPARATORS[kind]).toBe(a.domainSeparator);
    });

    it(`${kind}: content hash is a stable sha256 hex`, () => {
      const h = contentHash(a.artifact);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(contentHash(a.artifact)).toBe(h);
    });
  }

  it("validators reject malformed artifacts", () => {
    expect(isListing({ agentId: 1 })).toBe(false);
    expect(isAgreementDocument({ jobId: "x" })).toBe(false);
    expect(isAttestationBundle({ jobId: "x", ratings: [{ from: 1 }] })).toBe(
      false,
    );
  });
});
