import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test } from "vitest";

import {
  bundleConsistency,
  bundlesDiverge,
} from "../../src/agent/bundleConsistency.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const read = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));

// The fixtures below are constructed valid copies, so the classification tests
// opt out of the validation gate explicitly (mirrors a caller that validated
// upstream). The gate itself is exercised in its own block further down.
const TRUST = { trustBundles: true } as const;
const present = (bundle: Record<string, unknown>) =>
  ({ disposition: "present", bundle }) as const;
const absent = { disposition: "absent" } as const;
const indeterminate = { disposition: "indeterminate" } as const;

describe("bundleConsistency (§10.4.3 two-sided verdict)", () => {
  test("requires an explicit validation gate — neither dep rejects (no fail-open)", async () => {
    const b = { outcome: "completed", phaseSummary: [] };
    await expect(
      bundleConsistency({ buyer: present(b), seller: absent }),
    ).rejects.toThrow(/isValid|trustBundles/);
  });

  test("absent — no copy anchored", async () => {
    expect(await bundleConsistency({ buyer: absent, seller: absent }, TRUST)).toBe("absent");
  });

  test("indeterminate — an unavailable address is not treated as absent", async () => {
    const b = { outcome: "completed", phaseSummary: [] };
    expect(
      await bundleConsistency({ buyer: present(b), seller: indeterminate }, TRUST),
    ).toBe("indeterminate");
    expect(
      await bundleConsistency({ buyer: absent, seller: indeterminate }, TRUST),
    ).toBe("indeterminate");
    expect(
      await bundleConsistency({ buyer: indeterminate, seller: indeterminate }, TRUST),
    ).toBe("indeterminate");
  });

  test("oneSided — exactly one valid copy", async () => {
    const b = { outcome: "completed", phaseSummary: [] };
    expect(await bundleConsistency({ buyer: present(b), seller: absent }, TRUST)).toBe("oneSided");
    expect(await bundleConsistency({ buyer: absent, seller: present(b) }, TRUST)).toBe("oneSided");
  });

  test("unified — both present, differing only in advisory fields", async () => {
    const buyer = {
      outcome: "completed",
      anchoredByRole: "buyer",
      finalisedAt: 1000,
      phaseSummary: [{ index: 0, kind: "settle", outcome: "ok" }],
    };
    const seller = {
      outcome: "completed",
      anchoredByRole: "seller", // per-copy, excluded from divergence
      finalisedAt: 1002, // advisory skew
      ratingRefs: ["stor-r"], // one-sided advisory
      phaseSummary: [{ index: 0, kind: "settle", outcome: "ok" }],
    };
    expect(bundlesDiverge(buyer, seller)).toBe(false);
    expect(
      await bundleConsistency({ buyer: present(buyer), seller: present(seller) }, TRUST),
    ).toBe("unified");
  });

  test("divergent — copies contradict on outcome", async () => {
    const buyer = { outcome: "completed", phaseSummary: [] };
    const seller = { outcome: "failed-counterparty", phaseSummary: [] };
    expect(
      await bundleConsistency({ buyer: present(buyer), seller: present(seller) }, TRUST),
    ).toBe("divergent");
  });

  test("divergent — copies contradict on a phase outcome/errorClass", async () => {
    const buyer = { outcome: "completed", phaseSummary: [{ index: 1, outcome: "ok" }] };
    const seller = {
      outcome: "completed",
      phaseSummary: [{ index: 1, outcome: "fail", errorClass: "counterparty" }],
    };
    expect(bundlesDiverge(buyer, seller)).toBe(true);
    expect(
      await bundleConsistency({ buyer: present(buyer), seller: present(seller) }, TRUST),
    ).toBe("divergent");
  });

  test("a phase present in only one copy IS a divergence (#224 — presence-mismatch)", async () => {
    // DACS-Standard#224 dropped the presence carve-out: a copy asserting a phase
    // the other denies is a contradiction about what happened.
    const buyer = { outcome: "completed", phaseSummary: [{ index: 0, outcome: "ok" }] };
    const seller = {
      outcome: "completed",
      phaseSummary: [
        { index: 0, outcome: "ok" },
        { index: 1, outcome: "ok" }, // phase 1 present only on the seller copy
      ],
    };
    expect(bundlesDiverge(buyer, seller)).toBe(true);
    expect(
      await bundleConsistency({ buyer: present(buyer), seller: present(seller) }, TRUST),
    ).toBe("divergent");
    // …and symmetric (the extra phase on the other side is equally a divergence).
    expect(
      await bundleConsistency({ buyer: present(seller), seller: present(buyer) }, TRUST),
    ).toBe("divergent");
  });

  test("duplicate phase indices fail closed as divergence", () => {
    const buyer = {
      outcome: "completed",
      phaseSummary: [
        { index: 0, kind: "settle", outcome: "ok" },
        { index: 0, kind: "settle", outcome: "fail" },
      ],
    };
    const seller = {
      outcome: "completed",
      phaseSummary: [{ index: 0, kind: "settle", outcome: "fail" }],
    };
    expect(bundlesDiverge(buyer, seller)).toBe(true);
  });

  test("identical phase sets (by index) are unified — reordering is not divergence", async () => {
    const buyer = {
      outcome: "completed",
      phaseSummary: [{ index: 0, outcome: "ok" }, { index: 1, outcome: "ok" }],
    };
    const seller = {
      outcome: "completed",
      phaseSummary: [{ index: 1, outcome: "ok" }, { index: 0, outcome: "ok" }],
    };
    expect(
      await bundleConsistency({ buyer: present(buyer), seller: present(seller) }, TRUST),
    ).toBe("unified");
  });

  test("invalid returned content is rejected rather than treated as absent", async () => {
    const buyer = { outcome: "completed", phaseSummary: [] };
    const seller = { outcome: "failed-counterparty", phaseSummary: [] };
    await expect(
      bundleConsistency(
        { buyer: present(buyer), seller: present(seller) },
        { isValid: (_b, role) => role === "buyer" },
      ),
    ).rejects.toThrow(/invalid content.*seller/);
  });

  test("§10.4.3(b) third arm: a lone single-signed NON-abort copy the isValid gate rejects → absent", async () => {
    // A single-signed `completed` copy is rejected per §10.4.1 — no valid bundle
    // for the session. The isValid gate carries that rule; here it drops the copy.
    const loneNonAbort = { outcome: "completed", phaseSummary: [] };
    await expect(
      bundleConsistency(
        { buyer: present(loneNonAbort), seller: absent },
        { isValid: () => false },
      ),
    ).rejects.toThrow(/invalid content/);
    // …whereas a single-signed abort copy stands (§10.11 suppression): the gate accepts it.
    const loneAbort = { outcome: "aborted-by-other", phaseSummary: [] };
    expect(
      await bundleConsistency(
        { buyer: present(loneAbort), seller: absent },
        { isValid: () => true },
      ),
    ).toBe("oneSided");
  });

  test("different phase kinds at the same index diverge", async () => {
    const buyer = {
      outcome: "completed",
      phaseSummary: [{ index: 0, kind: "vet", outcome: "ok" }],
    };
    const seller = {
      outcome: "completed",
      phaseSummary: [{ index: 0, kind: "settle", outcome: "ok" }],
    };
    expect(bundlesDiverge(buyer, seller)).toBe(true);
  });

  test("v0.3 perspective copies reconcile on absolute fault and outcome class", () => {
    const parties = [{ role: "buyer" }, { role: "seller" }];
    const buyer = {
      faultBundleVersion: "1",
      outcome: "failed-counterparty",
      faultedParty: "seller",
      anchoredByRole: "buyer",
      parties,
      phaseSummary: [],
    };
    const seller = {
      ...buyer,
      outcome: "failed-perm",
      anchoredByRole: "seller",
    };
    expect(bundlesDiverge(buyer, seller)).toBe(false);
    expect(bundlesDiverge(buyer, { ...seller, faultedParty: "buyer" })).toBe(true);
  });

  test("legacy perspective partners and compatible mixed pairs reconcile", () => {
    const parties = [{ role: "buyer" }, { role: "seller" }];
    const legacyBuyer = {
      bundleVersion: "1",
      outcome: "aborted-by-other",
      anchoredByRole: "buyer",
      parties,
      phaseSummary: [],
    };
    const legacySeller = {
      ...legacyBuyer,
      outcome: "aborted-by-self",
      anchoredByRole: "seller",
    };
    const faultBuyer = {
      faultBundleVersion: "1",
      outcome: "aborted-by-other",
      faultedParty: "seller",
      anchoredByRole: "buyer",
      parties,
      phaseSummary: [],
    };
    expect(bundlesDiverge(legacyBuyer, legacySeller)).toBe(false);
    expect(bundlesDiverge(faultBuyer, legacySeller)).toBe(false);
    expect(bundlesDiverge({ ...faultBuyer, faultedParty: "buyer" }, legacySeller)).toBe(true);
  });
});

describe.skipIf(!haveVectors)("§14 verify golden — two-sided verdicts over reference bundles", () => {
  it("the buyer/seller copies of session 0004 canonically diverge", async () => {
    const buyer = read("fixtures/attestation-bundle-0004.json");
    const seller = read("fixtures/attestation-bundle-0004-seller.json");
    // buyer says completed; seller says failed-counterparty (settle phase fail) → dispute.
    expect(
      await bundleConsistency({ buyer: present(buyer), seller: present(seller) }, TRUST),
    ).toBe("divergent");
  });

  it("a lone anchored copy is oneSided (here the §10.11 abort-suppression arm)", async () => {
    // This fixture is single-signed with outcome aborted-by-other — the §10.4.3(b)
    // arm that stands via §10.11 suppression, NOT a mere anchoring omission.
    const buyer = read("fixtures/session-bundle-one-sided.json");
    expect(
      await bundleConsistency({ buyer: present(buyer), seller: absent }, TRUST),
    ).toBe("oneSided");
  });
});
