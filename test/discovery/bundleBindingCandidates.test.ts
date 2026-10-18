import { describe, expect, it } from "vitest";

import {
  BUNDLE_BINDING_FETCH_BUDGET,
  BUNDLE_BINDING_NON_OBSERVATION_REASONS,
  DacsError,
  SubstrateError,
  attestationBundleHash,
  bundleAddress,
  isBundleBindingNonObservation,
  resolveBundleBindingCandidates,
  type BundleBinding,
  type ResolveBundleBindingCandidatesInput,
} from "../../src/index.js";
import { isUnresolvedBundleBindingCandidateSet } from "../../src/discovery/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const SELLER = "did:demos:agent:" + "a".repeat(64);
const OUTSIDER = "did:demos:agent:" + "b".repeat(64);
const BUYER = "did:demos:agent:" + "c".repeat(64);
const GOOD = "AAAA";
const BAD = "BBBB";

type Copy = Record<string, unknown>;

function copy(note: string, options: { holder?: string; full?: boolean; jobId?: string } = {}): Copy {
  return {
    jobId: options.jobId ?? JOB_ID,
    note,
    parties: [
      { role: "buyer", primaryClaim: BUYER },
      { role: "seller", primaryClaim: options.holder ?? SELLER },
    ],
    full: options.full ?? true,
    anchoredByRole: "seller",
    signatures: [],
  };
}

function binding(
  nativeAddress: string,
  bundle: Copy,
  overrides: Partial<BundleBinding> = {},
): BundleBinding {
  const signer = overrides.signer ?? SELLER;
  return {
    bindingVersion: "1",
    jobId: JOB_ID,
    role: "seller",
    logicalAddress: bundleAddress(JOB_ID, "seller"),
    nativeAddress,
    bundleContentHash: attestationBundleHash(bundle as never),
    signer,
    signature: { algorithm: "ed25519", signer, value: GOOD },
    ...overrides,
  } as BundleBinding;
}

function input(
  candidates: unknown[],
  store: Record<string, Copy | null | Error>,
  extra: Partial<ResolveBundleBindingCandidatesInput> = {},
) {
  const fetched: string[] = [];
  const value: ResolveBundleBindingCandidatesInput = {
    jobId: JOB_ID,
    role: "seller",
    candidates,
    verifyBindingSignature: (entry) => entry.signature.value === GOOD,
    fetchCopy(address) {
      fetched.push(address);
      const entry = store[address];
      if (entry instanceof Error) throw entry;
      return entry ?? null;
    },
    verifyCopy(entry) {
      const holder = (entry.parties as Array<Record<string, string>>)
        .find((party) => party.role === "seller")!.primaryClaim!;
      return { valid: true as const, signers: [holder], fullySigned: entry.full === true,
        abortStanding: false };
    },
    ...extra,
  };
  return { value, fetched };
}

describe("resolveBundleBindingCandidates (DACS-5 BB-5..BB-7)", () => {
  it("resolves one authorized copy and never reports absent", async () => {
    const one = copy("one");
    const { value } = input([binding("stor-" + "1".repeat(40), one)],
      { ["stor-" + "1".repeat(40)]: one });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", copy: one, fullySigned: true,
      binding: { nativeAddress: "stor-" + "1".repeat(40) },
    });
    const none = input([], {}).value;
    await expect(resolveBundleBindingCandidates(none)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-undiscovered",
    });
  });

  it.each([
    ["a bad signature (BB-4)", { signature: { algorithm: "ed25519", signer: SELLER, value: BAD } }],
    ["an unsupported version", { bindingVersion: "2" }],
    ["another job", { jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F",
      logicalAddress: bundleAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7F", "seller") }],
    ["another role", { role: "buyer", logicalAddress: bundleAddress(JOB_ID, "buyer") }],
    ["a logical address not derived from its jobId and role",
      { logicalAddress: bundleAddress(JOB_ID, "buyer") }],
  ])("discards a binding with %s before any fetch", async (_label, overrides) => {
    const one = copy("one");
    const { value, fetched } = input(
      [binding("stor-" + "1".repeat(40), one, overrides as Partial<BundleBinding>)],
      { ["stor-" + "1".repeat(40)]: one },
    );
    await expect(resolveBundleBindingCandidates(value)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-undiscovered",
    });
    expect(fetched).toEqual([]);
  });

  it("treats a throwing signature check as a failed BB-4 check", async () => {
    const one = copy("one");
    const { value } = input([binding("stor-" + "1".repeat(40), one)],
      { ["stor-" + "1".repeat(40)]: one },
      { verifyBindingSignature: () => { throw new Error("no key"); } });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "indeterminate", reason: "bundle-binding-undiscovered",
    });
  });

  it.each([
    ["the copy's jobId differs (check 7)", copy("x", { jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" })],
    ["the role holder is another claim (check 9)", copy("x", { holder: OUTSIDER })],
  ])("keeps a copy inert when %s", async (_label, fetchedCopy) => {
    const address = "stor-" + "1".repeat(40);
    const { value } = input([binding(address, fetchedCopy)], { [address]: fetchedCopy });
    await expect(resolveBundleBindingCandidates(value)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-candidates-rejected",
    });
  });

  it("keeps a copy inert when the binding signer signed it under another role (check 9)", async () => {
    const address = "stor-" + "1".repeat(40);
    // The binding's signer co-signed, but as the buyer; the seller is someone else.
    const swapped = { ...copy("swapped", { holder: OUTSIDER }), parties: [
      { role: "buyer", primaryClaim: SELLER },
      { role: "seller", primaryClaim: OUTSIDER },
    ] };
    const { value } = input([binding(address, swapped)], { [address]: swapped }, {
      verifyCopy: () => ({ valid: true, signers: [SELLER, OUTSIDER], fullySigned: true,
        abortStanding: false }),
    });
    await expect(resolveBundleBindingCandidates(value)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-candidates-rejected",
    });
  });

  it("keeps a copy inert when its hash differs (check 8) or the copy is invalid", async () => {
    const address = "stor-" + "1".repeat(40);
    const one = copy("one");
    const hashed = input([binding(address, copy("other"))], { [address]: one }).value;
    await expect(resolveBundleBindingCandidates(hashed)).resolves.toMatchObject({
      reason: "bundle-binding-candidates-rejected" });
    const invalid = input([binding(address, one)], { [address]: one }, {
      verifyCopy: () => ({ valid: false, reason: "bad signature" }),
    }).value;
    await expect(resolveBundleBindingCandidates(invalid)).resolves.toMatchObject({
      reason: "bundle-binding-candidates-rejected" });
    const unsigned = input([binding(address, one)], { [address]: one }, {
      verifyCopy: () => ({ valid: true, signers: [BUYER], fullySigned: false,
        abortStanding: false }),
    }).value;
    await expect(resolveBundleBindingCandidates(unsigned)).resolves.toMatchObject({
      reason: "bundle-binding-candidates-rejected" });
    const rejected = input([binding(address, one)], {
      [address]: new DacsError("receipt invalid"),
    }).value;
    await expect(resolveBundleBindingCandidates(rejected)).resolves.toMatchObject({
      reason: "bundle-binding-candidates-rejected" });
  });

  it.each([
    ["nothing readable yet", null],
    ["a SubstrateError", new SubstrateError("node down")],
    ["a plain error", new Error("socket hang up")],
  ])("is indeterminate when a candidate is unfetched: %s", async (_label, entry) => {
    const address = "stor-" + "1".repeat(40);
    const other = "stor-" + "2".repeat(40);
    const one = copy("one");
    const { value } = input([binding(address, one), binding(other, copy("two"))],
      { [address]: one, [other]: entry as Copy | null | Error });
    await expect(resolveBundleBindingCandidates(value)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-candidates-unfetched",
    });
  });

  it("rejects a malformed requested job id before verification or fetch", async () => {
    let effects = 0;
    const { value } = input([], {}, {
      jobId: "legacy-job",
      verifyBindingSignature: () => { effects++; return true; },
      fetchCopy: () => { effects++; return null; },
    });
    await expect(resolveBundleBindingCandidates(value)).rejects.toThrow(/requested jobId.*canonical uppercase ULID/);
    expect(effects).toBe(0);
  });

  it.each(["legacy-job", "", null, 42])(
    "rejects an authenticated malformed signed job id (%s) before fetch", async (jobId) => {
      const one = copy("one");
      const candidate = { ...binding("stor-" + "1".repeat(40), one), jobId };
      let verified = 0;
      const { value, fetched } = input([candidate], {}, {
        verifyBindingSignature: () => { verified++; return true; },
      });
      await expect(resolveBundleBindingCandidates(value)).rejects.toThrow(/signed jobId.*canonical uppercase ULID/);
      expect(verified).toBe(1);
      expect(fetched).toEqual([]);
    },
  );

  it.each(["incomplete", "missing signature", "bad signature", "throwing verifier"])(
    "discards an unauthenticated malformed job id beside a valid binding (%s)", async (failure) => {
      const one = copy("one");
      const address = "stor-" + "1".repeat(40);
      const valid = binding(address, one);
      const malformed: Record<string, unknown> = failure === "incomplete"
        ? { jobId: "malformed" }
        : { ...valid, jobId: "malformed", signature: { ...valid.signature, value: BAD } };
      if (failure === "missing signature") delete malformed.signature;
      const { value, fetched } = input([malformed, valid], { [address]: one }, {
        verifyBindingSignature: (entry) => {
          if (entry.jobId === "malformed" && failure === "throwing verifier") throw new Error("invalid signature");
          return entry.signature.value === GOOD;
        },
      });
      await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
        disposition: "present", binding: valid, copy: one,
      });
      expect(fetched).toEqual([address]);
    },
  );

  it("resolves the authenticated snapshot when a candidate changes during signature verification", async () => {
    const one = copy("one");
    const address = "stor-" + "1".repeat(40);
    const candidate = binding(address, one);
    const expected = structuredClone(candidate);
    const { value, fetched } = input([candidate], { [address]: one }, {
      verifyBindingSignature: async (entry) => {
        candidate.nativeAddress = "stor-" + "2".repeat(40);
        (entry as BundleBinding).nativeAddress = "stor-" + "3".repeat(40);
        return true;
      },
    });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", binding: expected, copy: one,
    });
    expect(fetched).toEqual([address]);
  });

  it.each(["hash", "verification"])("discards invalid fetched %s content beside a valid candidate", async (failure) => {
    const badAddress = "stor-" + "1".repeat(40);
    const goodAddress = "stor-" + "2".repeat(40);
    const one = copy("one");
    const bad = copy("bad");
    const { value } = input([binding(badAddress, bad), binding(goodAddress, one)], {
      [badAddress]: failure === "hash" ? { ...bad, invalid: Number.NaN } : bad,
      [goodAddress]: one,
    });
    const verify = value.verifyCopy;
    value.verifyCopy = (entry, role) => {
      if (entry.note === "bad") throw new DacsError("definitively invalid content");
      return verify(entry, role);
    };
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", binding: { nativeAddress: goodAddress }, copy: one });
  });

  it("is indeterminate when copy verification throws", async () => {
    const address = "stor-" + "1".repeat(40);
    const one = copy("one");
    const { value } = input([binding(address, one)], { [address]: one },
      { verifyCopy: () => { throw new Error("key resolver down"); } });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      reason: "bundle-binding-candidates-unfetched" });
  });

  it("fetches in ascending (bundleContentHash, nativeAddress) order within an N = 8 budget per signer", async () => {
    const store: Record<string, Copy> = {};
    const candidates: BundleBinding[] = [];
    // Nine distinct copies from the role holder: one more than the budget.
    for (let index = 0; index < BUNDLE_BINDING_FETCH_BUDGET + 1; index += 1) {
      const address = `stor-${String(index).repeat(40)}`;
      store[address] = copy(`copy-${index}`, { full: index === 0 });
      candidates.push(binding(address, store[address]));
    }
    const { value, fetched } = input([...candidates].reverse(), store);
    await expect(resolveBundleBindingCandidates(value)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-budget-exhausted",
    });
    const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const expected = [...candidates].sort((a, b) =>
      order(a.bundleContentHash, b.bundleContentHash) ||
      order(a.nativeAddress, b.nativeAddress))
      .slice(0, BUNDLE_BINDING_FETCH_BUDGET).map((entry) => entry.nativeAddress);
    expect(fetched).toEqual(expected);

    // Exactly N candidates fit the budget.
    const fitting = input(candidates.slice(0, BUNDLE_BINDING_FETCH_BUDGET), store);
    await expect(resolveBundleBindingCandidates(fitting.value)).resolves.toMatchObject({
      disposition: "present", binding: { nativeAddress: candidates[0]!.nativeAddress },
    });
    expect(fitting.fetched).toHaveLength(BUNDLE_BINDING_FETCH_BUDGET);
  });

  it("breaks a bundleContentHash tie by nativeAddress and fetches each address once", async () => {
    const one = copy("one");
    const low = "stor-" + "1".repeat(40);
    const high = "stor-" + "9".repeat(40);
    const { value, fetched } = input(
      [binding(high, one), binding(low, one), binding(low, one, { anchorTx: "tx-1" })],
      { [low]: one, [high]: one },
    );
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", binding: { nativeAddress: low },
    });
    expect(fetched).toEqual([low, high]);
  });

  it("gives an outsider its own budget, so its flood never exhausts the role holder's", async () => {
    const store: Record<string, Copy> = {};
    const flood: BundleBinding[] = [];
    for (let index = 0; index < BUNDLE_BINDING_FETCH_BUDGET; index += 1) {
      const address = `stor-${"f".repeat(39)}${index}`;
      // An outsider can name itself seller, but cannot obtain the buyer's
      // co-signature, so its copies are lesser-signed.
      store[address] = copy(`outsider-${index}`, { holder: OUTSIDER, full: false });
      flood.push(binding(address, store[address], { signer: OUTSIDER,
        signature: { algorithm: "ed25519", signer: OUTSIDER, value: GOOD } }));
    }
    const honest = "stor-" + "1".repeat(40);
    store[honest] = copy("honest");
    const { value } = input([...flood, binding(honest, store[honest])], store);
    // The honest fully signed copy takes precedence over the lesser-signed flood.
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", binding: { nativeAddress: honest, signer: SELLER },
    });
  });

  it("prunes to the co-signed role holder before any fetch", async () => {
    const outsiderAddress = "stor-" + "f".repeat(40);
    const honest = "stor-" + "1".repeat(40);
    const outsiderCopy = copy("outsider", { holder: OUTSIDER });
    const honestCopy = copy("honest");
    const store = { [outsiderAddress]: outsiderCopy, [honest]: honestCopy };
    const { value, fetched } = input([
      binding(outsiderAddress, outsiderCopy, { signer: OUTSIDER,
        signature: { algorithm: "ed25519", signer: OUTSIDER, value: GOOD } }),
      binding(honest, honestCopy),
    ], store, { roleHolder: SELLER });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", binding: { nativeAddress: honest } });
    expect(fetched).toEqual([honest]);
    const pruned = input([binding(honest, honestCopy)], store, { roleHolder: OUTSIDER });
    await expect(resolveBundleBindingCandidates(pruned.value)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-undiscovered" });
    expect(pruned.fetched).toEqual([]);
  });

  it("collapses canonically equal copies and prefers the fully signed one", async () => {
    const lesser = { ...copy("same", { full: false }) };
    const full = { ...copy("same", { full: false }), signatures: [{ extra: true }] };
    // Equal signed scope (signatures are outside it), different signature standing.
    const lesserAddress = "stor-" + "1".repeat(40);
    const fullAddress = "stor-" + "2".repeat(40);
    const { value } = input([binding(lesserAddress, lesser), binding(fullAddress, full)],
      { [lesserAddress]: lesser, [fullAddress]: full }, {
        verifyCopy: (entry) => ({ valid: true, signers: [SELLER],
          fullySigned: Array.isArray(entry.signatures) && entry.signatures.length > 0,
          abortStanding: false }),
      });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", fullySigned: true, binding: { nativeAddress: fullAddress },
    });
  });

  it("lets a fully signed copy take precedence over a lesser-signed unequal copy", async () => {
    const full = copy("full", { full: true });
    const lesser = copy("lesser", { full: false });
    const a = "stor-" + "1".repeat(40);
    const b = "stor-" + "2".repeat(40);
    const { value } = input([binding(a, full), binding(b, lesser)], { [a]: full, [b]: lesser });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", copy: full, fullySigned: true });
  });

  it.each([
    ["fully signed", true],
    ["lesser-signed", false],
  ])("is indeterminate for unequal authorized copies that are both %s", async (_label, full) => {
    const one = copy("one", { full });
    const two = copy("two", { full });
    const a = "stor-" + "1".repeat(40);
    const b = "stor-" + "2".repeat(40);
    const { value } = input([binding(a, one), binding(b, two)], { [a]: one, [b]: two });
    await expect(resolveBundleBindingCandidates(value)).resolves.toEqual({
      disposition: "indeterminate", reason: "bundle-binding-equivocation" });
  });

  it("resolves a single lesser-signed authorized copy", async () => {
    const one = copy("one", { full: false });
    const a = "stor-" + "1".repeat(40);
    const { value } = input([binding(a, one)], { [a]: one });
    await expect(resolveBundleBindingCandidates(value)).resolves.toMatchObject({
      disposition: "present", fullySigned: false });
  });
});

// BB-7, BB-8: only non-observation is no evidence either way; every other
// indeterminate reason, whatever a resolver calls it, is an unresolved set.
describe("BundleBinding non-observation reasons", () => {
  it("names exactly the two non-observation reasons", () => {
    expect([...BUNDLE_BINDING_NON_OBSERVATION_REASONS])
      .toEqual(["bundle-binding-undiscovered", "bundle-binding-unanswered"]);
    expect(Object.isFrozen(BUNDLE_BINDING_NON_OBSERVATION_REASONS)).toBe(true);
  });

  it("classifies every other reason as an unresolved candidate set", () => {
    for (const reason of BUNDLE_BINDING_NON_OBSERVATION_REASONS) {
      expect(isBundleBindingNonObservation(reason), reason).toBe(true);
      expect(isUnresolvedBundleBindingCandidateSet(reason), reason).toBe(false);
    }
    for (const reason of ["bundle-binding-equivocation", "bundle-binding-budget-exhausted",
      "bundle-binding-candidates-unfetched", "bundle-binding-candidates-rejected",
      "equivocation", "candidate-set-unresolved", "unanswered", "", undefined, 7]) {
      expect(isBundleBindingNonObservation(reason), String(reason)).toBe(false);
      expect(isUnresolvedBundleBindingCandidateSet(reason), String(reason)).toBe(true);
    }
  });
});
