import { describe, expect, test } from "vitest";

import { canonicalize } from "../../src/canonical/jcs.js";
import { sha256Hex } from "../../src/canonical/hash.js";
import {
  computeBidHash,
  generateSalt,
  saltHasEnoughEntropy,
  makeCommitment,
  verifyReveal,
  validateSealedParams,
  commitsInWindow,
  revealsInWindow,
  matchRevealsToCommits,
  parseRuleRef,
  verifyRuleRefContent,
  compareDecimal,
  selectSealedWinner,
  type AnchoredCommit,
  type AnchoredReveal,
  type SealedBid,
  type SealedEnvelopeParams,
} from "../../src/negotiate/sealedBid.js";

// A fixed 32-byte salt (base64url) so hashes are deterministic in tests.
const SALT_A = Buffer.alloc(32, 1).toString("base64url");
const SALT_B = Buffer.alloc(32, 2).toString("base64url");
const bid = (amount: string, currency = "USDC"): SealedBid => ({
  price: { amount, currency },
});

describe("commitment + reveal", () => {
  test("bidHash is a lowercase 64-hex string and deterministic", () => {
    const h = computeBidHash(bid("100"), SALT_A);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeBidHash(bid("100"), SALT_A)).toBe(h);
  });

  test("different bid or salt → different hash (binding + hiding)", () => {
    const base = computeBidHash(bid("100"), SALT_A);
    expect(computeBidHash(bid("101"), SALT_A)).not.toBe(base); // binding
    expect(computeBidHash(bid("100"), SALT_B)).not.toBe(base); // hiding
  });

  test("makeCommitment produces an openable commitment", () => {
    const c = makeCommitment(bid("100"), SALT_A);
    expect(c.bidHash).toBe(computeBidHash(bid("100"), SALT_A));
    expect(verifyReveal(c.bidHash, c.bid, c.salt)).toBe(true);
  });

  test("verifyReveal rejects a tampered bid or salt", () => {
    const c = makeCommitment(bid("100"), SALT_A);
    expect(verifyReveal(c.bidHash, bid("999"), c.salt)).toBe(false);
    expect(verifyReveal(c.bidHash, c.bid, SALT_B)).toBe(false);
  });

  test("SE-7: generated salt has ≥256 bits; low-entropy salt is rejected", () => {
    expect(saltHasEnoughEntropy(generateSalt())).toBe(true);
    const weak = Buffer.alloc(16, 7).toString("base64url");
    expect(saltHasEnoughEntropy(weak)).toBe(false);
    expect(() => makeCommitment(bid("100"), weak)).toThrow(/SE-7/);
  });
});

describe("parameter validation + deadline gating", () => {
  const NOW = 1_000_000_000_000;
  const params = (over: Partial<SealedEnvelopeParams> = {}): SealedEnvelopeParams => ({
    commitDeadline: NOW + 120_000,
    revealWindow: 120,
    selectionRule: "lowest-price",
    ...over,
  });

  test("SE-1: commitDeadline must be ≥ 60s out", () => {
    expect(() => validateSealedParams(params(), NOW)).not.toThrow();
    expect(() =>
      validateSealedParams(params({ commitDeadline: NOW + 30_000 }), NOW),
    ).toThrow(/SE-1/);
  });

  test("revealWindow floor of 60s", () => {
    expect(() => validateSealedParams(params({ revealWindow: 30 }), NOW)).toThrow(
      /revealWindow/,
    );
  });

  test("SE-2: commits after commitDeadline are dropped", () => {
    const deadline = NOW + 120_000;
    const commits: AnchoredCommit[] = [
      { bidderClaim: "a", bidHash: "h1", anchorTs: deadline - 1 },
      { bidderClaim: "b", bidHash: "h2", anchorTs: deadline },
      { bidderClaim: "c", bidHash: "h3", anchorTs: deadline + 1 },
    ];
    expect(commitsInWindow(commits, deadline).map((c) => c.bidderClaim)).toEqual([
      "a",
      "b",
    ]);
  });

  test("SE-3: reveals after (commitDeadline + revealWindow) are dropped", () => {
    const p = params();
    const expiry = p.commitDeadline + p.revealWindow * 1000;
    const reveals: AnchoredReveal[] = [
      { bidderClaim: "a", bid: bid("1"), salt: SALT_A, anchorTs: expiry },
      { bidderClaim: "b", bid: bid("1"), salt: SALT_A, anchorTs: expiry + 1 },
    ];
    expect(revealsInWindow(reveals, p).map((r) => r.bidderClaim)).toEqual(["a"]);
  });
});

describe("matchRevealsToCommits (authoritative candidate set)", () => {
  test("keeps only reveals with a matching in-window commit that opens", () => {
    const cA = makeCommitment(bid("100"), SALT_A);
    const cB = makeCommitment(bid("200"), SALT_B);
    const commits: AnchoredCommit[] = [
      { bidderClaim: "a", bidHash: cA.bidHash, anchorTs: 10 },
      { bidderClaim: "b", bidHash: cB.bidHash, anchorTs: 20 },
    ];
    const reveals: AnchoredReveal[] = [
      { bidderClaim: "a", bid: cA.bid, salt: cA.salt, anchorTs: 100 }, // ok
      { bidderClaim: "b", bid: bid("999"), salt: cB.salt, anchorTs: 100 }, // opens nothing
      { bidderClaim: "c", bid: bid("50"), salt: SALT_A, anchorTs: 100 }, // no commit
    ];
    const matched = matchRevealsToCommits(commits, reveals);
    expect(matched.map((m) => m.reveal.bidderClaim)).toEqual(["a"]);
  });
});

describe("compareDecimal", () => {
  test("full-precision decimal ordering", () => {
    expect(compareDecimal("1.5", "1.50")).toBe(0);
    expect(compareDecimal("2", "10")).toBe(-1);
    expect(compareDecimal("0.1", "0.09")).toBe(1);
    expect(compareDecimal("100", "99.999")).toBe(1);
  });
});

describe("rule-ref binding (SE-6)", () => {
  const rule = { kind: "acceptance", maxPrice: "100" };
  // The authoritative contentHash is sha256 of the rule's canonical (JCS) form.
  const hashOf = (obj: unknown) => sha256Hex(canonicalize(obj));

  test("parseRuleRef splits hash + uri (uri may contain colons)", () => {
    const h = "a".repeat(64);
    const parsed = parseRuleRef(`rule-ref:${h}:https://rules.example/r/1`);
    expect(parsed).toEqual({ contentHash: h, uri: "https://rules.example/r/1" });
  });

  test("parseRuleRef returns null for non-rule-ref or malformed rules", () => {
    expect(parseRuleRef("lowest-price")).toBeNull();
    expect(parseRuleRef("rule-ref:short:https://x")).toBeNull();
  });

  test("verifyRuleRefContent passes for matching content, fails on tamper", () => {
    const h = hashOf(rule);
    const ref = `rule-ref:${h}:https://rules.example/r/1`;
    expect(verifyRuleRefContent(ref, rule)).toBe(true);
    expect(verifyRuleRefContent(ref, { ...rule, maxPrice: "999" })).toBe(false);
  });
});

describe("selectSealedWinner (§8.4.3 step 5)", () => {
  // Helper: build a matched candidate with a chosen commit anchor timestamp.
  const cand = (bidderClaim: string, amount: string, anchorTs: number, currency = "USDC") => {
    const c = makeCommitment(bid(amount, currency), Buffer.alloc(32, anchorTs % 251).toString("base64url"));
    return {
      reveal: { bidderClaim, bid: c.bid, salt: c.salt, anchorTs: anchorTs + 1000 },
      commit: { bidderClaim, bidHash: c.bidHash, anchorTs },
    };
  };

  test("lowest-price picks the smallest amount", () => {
    const res = selectSealedWinner(
      [cand("a", "100", 10), cand("b", "80", 20), cand("c", "120", 30)],
      { selectionRule: "lowest-price", currency: "USDC" },
    );
    expect(res.winner?.bidderClaim).toBe("b");
  });

  test("highest-price picks the largest amount", () => {
    const res = selectSealedWinner(
      [cand("a", "100", 10), cand("b", "80", 20), cand("c", "120", 30)],
      { selectionRule: "highest-price", currency: "USDC" },
    );
    expect(res.winner?.bidderClaim).toBe("c");
  });

  test("excludes wrong-currency and non-positive bids", () => {
    const res = selectSealedWinner(
      [cand("a", "50", 10, "DAI"), cand("b", "0", 20), cand("c", "70", 30)],
      { selectionRule: "lowest-price", currency: "USDC" },
    );
    expect(res.winner?.bidderClaim).toBe("c");
    expect(res.excluded.map((e) => e.bidderClaim).sort()).toEqual(["a", "b"]);
  });

  test("reserve is a ceiling for lowest-price (inclusive)", () => {
    const res = selectSealedWinner(
      [cand("a", "50", 10), cand("b", "120", 20)],
      { selectionRule: "lowest-price", currency: "USDC", reservePrice: { amount: "100", currency: "USDC" } },
    );
    // b (120) exceeds the ceiling → excluded; a wins.
    expect(res.winner?.bidderClaim).toBe("a");
    expect(res.excluded.some((e) => e.bidderClaim === "b")).toBe(true);
  });

  test("reserve is a floor for highest-price (inclusive at the bound)", () => {
    const res = selectSealedWinner(
      [cand("a", "100", 10), cand("b", "90", 20)],
      { selectionRule: "highest-price", currency: "USDC", reservePrice: { amount: "100", currency: "USDC" } },
    );
    // b (90) below the floor → excluded; a (==100) admitted and wins.
    expect(res.winner?.bidderClaim).toBe("a");
  });

  test("SE-5 tie-break: equal amount → earliest commit anchor timestamp wins", () => {
    const res = selectSealedWinner(
      [cand("late", "100", 50), cand("early", "100", 10)],
      { selectionRule: "lowest-price", currency: "USDC" },
    );
    expect(res.winner?.bidderClaim).toBe("early");
  });

  test("first-acceptable takes the earliest-committed bid that passes the predicate", () => {
    const res = selectSealedWinner(
      [cand("a", "200", 10), cand("b", "50", 20), cand("c", "40", 30)],
      {
        selectionRule: "first-acceptable",
        currency: "USDC",
        acceptancePredicate: (b) => compareDecimalLte(b.price.amount, "60"),
      },
    );
    // a fails (200 > 60); b is the earliest-committed that passes.
    expect(res.winner?.bidderClaim).toBe("b");
  });

  test("first-acceptable without a predicate yields no winner", () => {
    const res = selectSealedWinner([cand("a", "50", 10)], {
      selectionRule: "first-acceptable",
      currency: "USDC",
    });
    expect(res.winner).toBeNull();
    expect(res.reason).toMatch(/acceptancePredicate/);
  });

  test("empty candidate set → no winner", () => {
    const res = selectSealedWinner([], { selectionRule: "lowest-price", currency: "USDC" });
    expect(res.winner).toBeNull();
    expect(res.reason).toMatch(/no candidate/);
  });

  test("reserve currency ≠ listing currency is a non-conformant listing", () => {
    const res = selectSealedWinner([cand("a", "50", 10)], {
      selectionRule: "lowest-price",
      currency: "USDC",
      reservePrice: { amount: "10", currency: "DAI" },
    });
    expect(res.winner).toBeNull();
    expect(res.reason).toMatch(/reserve currency/);
  });
});

// Small helper mirroring compareDecimal for the acceptance-predicate test.
function compareDecimalLte(a: string, b: string): boolean {
  return compareDecimal(a, b) <= 0;
}
