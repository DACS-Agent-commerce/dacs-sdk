import { describe, expect, test } from "vitest";

import {
  buildCommitMessage,
  buildRevealMessage,
  buildSealedAgreement,
  runSealedEnvelopeCore,
  type SealedEnvelopeDeps,
  type SealedEnvelopeInput,
} from "../../src/negotiate/sealedEnvelope.js";
import { isLegacyMvpAgreementDocument as isAgreementDocument } from "../../src/artifacts/legacyMvp.js";
import {
  makeCommitment,
  compareDecimal,
  type AnchoredCommit,
  type AnchoredReveal,
  type SealedBid,
} from "../../src/negotiate/sealedBid.js";
import { canonicalize } from "../../src/canonical/jcs.js";
import { sha256Hex } from "../../src/canonical/hash.js";

const NOW = 1_000_000_000_000;
const DEADLINE = NOW + 120_000;
const REVEAL_WINDOW = 120; // seconds
const bid = (amount: string, currency = "USDC"): SealedBid => ({
  price: { amount, currency },
});

/** A committed+revealed bidder, anchored at chosen commit/reveal timestamps. */
function bidder(claim: string, amount: string, commitTs: number, revealTs: number, currency = "USDC") {
  const c = makeCommitment(bid(amount, currency));
  const commit: AnchoredCommit = { bidderClaim: claim, bidHash: c.bidHash, anchorTs: commitTs };
  const reveal: AnchoredReveal = {
    bidderClaim: claim,
    bid: c.bid,
    salt: c.salt,
    anchorTs: revealTs,
  };
  return { commit, reveal };
}

function deps(
  commits: AnchoredCommit[],
  reveals: AnchoredReveal[],
  over: Partial<SealedEnvelopeDeps> = {},
): SealedEnvelopeDeps {
  return {
    readAnchoredCommits: async () => commits,
    readAnchoredReveals: async () => reveals,
    commitAgreement: async (ctx) => ({
      agreementRef: `stor-agreement-${ctx.jobId}`,
      agreementHash: `hash-${ctx.winningBidderClaim}`,
    }),
    ...over,
  };
}

const input = (over: Partial<SealedEnvelopeInput> = {}): SealedEnvelopeInput => ({
  jobId: "job-1",
  seller: "did:demos:agent:seller",
  currency: "USDC",
  params: { commitDeadline: DEADLINE, revealWindow: REVEAL_WINDOW, selectionRule: "lowest-price" },
  ...over,
});

describe("channel message envelopes (§8.3.3)", () => {
  test("commit message body carries bidHash + bidderClaim == sender", () => {
    const m = buildCommitMessage("job-1", "did:demos:agent:bob", "abc123", NOW);
    expect(m.type).toBe("sealed-envelope-commit");
    expect(m.sender).toBe("did:demos:agent:bob");
    expect(m.body).toMatchObject({ bidHash: "abc123", bidderClaim: "did:demos:agent:bob" });
  });

  test("reveal message body carries the openable {bid, salt}", () => {
    const c = makeCommitment(bid("100"));
    const m = buildRevealMessage("job-1", "did:demos:agent:bob", c.bid, c.salt, NOW);
    expect(m.type).toBe("sealed-envelope-reveal");
    expect(m.body).toEqual({ bid: c.bid, salt: c.salt });
  });
});

describe("runSealedEnvelopeCore", () => {
  test("happy path: lowest-price winner gets an agreement committed", async () => {
    const a = bidder("a", "100", DEADLINE - 100, DEADLINE + 1000);
    const b = bidder("b", "80", DEADLINE - 50, DEADLINE + 1000);
    const res = await runSealedEnvelopeCore(
      input(),
      deps([a.commit, b.commit], [a.reveal, b.reveal]),
    );
    expect(res.ok).toBe(true);
    expect(res.winningBidderClaim).toBe("b");
    expect(res.losingBidderClaims).toEqual(["a"]);
    expect(res.agreementRef).toBe("stor-agreement-job-1");
    expect(res.agreementHash).toBe("hash-b");
  });

  test("SE-2: a late-anchored commit is excluded (its reveal can't win)", async () => {
    const a = bidder("a", "100", DEADLINE - 100, DEADLINE + 1000);
    const late = bidder("b", "10", DEADLINE + 1, DEADLINE + 1000); // commit after deadline
    const res = await runSealedEnvelopeCore(
      input(),
      deps([a.commit, late.commit], [a.reveal, late.reveal]),
    );
    expect(res.ok).toBe(true);
    expect(res.winningBidderClaim).toBe("a"); // the cheap late bid doesn't count
  });

  test("SE-3: a reveal anchored after the window is excluded", async () => {
    const expiry = DEADLINE + REVEAL_WINDOW * 1000;
    const a = bidder("a", "100", DEADLINE - 100, DEADLINE + 1000);
    const b = bidder("b", "10", DEADLINE - 50, expiry + 1); // reveal too late
    const res = await runSealedEnvelopeCore(
      input(),
      deps([a.commit, b.commit], [a.reveal, b.reveal]),
    );
    expect(res.winningBidderClaim).toBe("a");
  });

  test("SE-3: a reveal anchored before the commit deadline is excluded", async () => {
    const a = bidder("a", "100", DEADLINE - 100, DEADLINE + 1);
    const early = bidder("b", "10", DEADLINE - 50, DEADLINE - 1);
    const res = await runSealedEnvelopeCore(
      input(),
      deps([a.commit, early.commit], [a.reveal, early.reveal]),
    );
    expect(res.winningBidderClaim).toBe("a");
  });

  test("SE-3: a reveal anchored exactly at the commit deadline is included", async () => {
    const atDeadline = bidder("a", "10", DEADLINE - 100, DEADLINE);
    const later = bidder("b", "100", DEADLINE - 50, DEADLINE + 1);
    const res = await runSealedEnvelopeCore(
      input(),
      deps([atDeadline.commit, later.commit], [atDeadline.reveal, later.reveal]),
    );
    expect(res.winningBidderClaim).toBe("a");
  });

  test("SE-9: commit/reveal input permutations produce the same authority and winner", async () => {
    const aOne = makeCommitment(bid("10"));
    const aTwo = makeCommitment(bid("20"));
    const authoritative = aOne.bidHash < aTwo.bidHash ? aOne : aTwo;
    const inert = authoritative === aOne ? aTwo : aOne;
    const aCommit = (value: typeof aOne): AnchoredCommit => ({
      bidderClaim: "a",
      bidHash: value.bidHash,
      anchorTs: DEADLINE - 100,
    });
    const aReveal = (value: typeof aOne): AnchoredReveal => ({
      bidderClaim: "a",
      bid: value.bid,
      salt: value.salt,
      anchorTs: DEADLINE + 100,
    });
    const b = bidder("b", "1000", DEADLINE - 50, DEADLINE + 100);
    const commits = [aCommit(inert), aCommit(authoritative), b.commit];
    const reveals = [aReveal(inert), aReveal(authoritative), b.reveal];

    for (const orderedCommits of permutations(commits)) {
      for (const orderedReveals of permutations(reveals)) {
        const res = await runSealedEnvelopeCore(
          input(),
          deps(orderedCommits, orderedReveals),
        );
        expect(res.ok).toBe(true);
        expect(res.winningBidderClaim).toBe("a");
        expect(res.losingBidderClaims).toEqual(["b"]);
      }
    }
  });

  test("SE-9: unresolved authoritative anchor time pauses instead of selecting another commit", async () => {
    const uncertain = makeCommitment(bid("10"));
    const resolved = makeCommitment(bid("20"));
    const b = bidder("b", "100", DEADLINE - 50, DEADLINE + 100);
    let committed = false;
    const res = await runSealedEnvelopeCore(
      input(),
      deps(
        [
          { bidderClaim: "a", bidHash: uncertain.bidHash, anchorTs: null },
          { bidderClaim: "a", bidHash: resolved.bidHash, anchorTs: DEADLINE - 100 },
          b.commit,
        ],
        [b.reveal],
        {
          commitAgreement: async () => {
            committed = true;
            return { agreementRef: "unexpected", agreementHash: "unexpected" };
          },
        },
      ),
    );
    expect(res).toMatchObject({ ok: false, errorClass: "substrate" });
    expect(res.reason).toMatch(/timestamp unresolved.*a/);
    expect(committed).toBe(false);
  });

  describe("SE-6 verified rule execution", () => {
    const ruleContent = { kind: "max-price", maxPrice: "60" };
    const ruleRef = `rule-ref:${sha256Hex(canonicalize(ruleContent))}:https://rules.example/max-60` as const;
    const evaluator: NonNullable<SealedEnvelopeDeps["evaluateVerifiedRule"]> = ({
      rule,
      bid: candidate,
    }) => {
      const content = rule.content as typeof ruleContent;
      return (
        content.kind === "max-price" &&
        compareDecimal(candidate.price.amount, content.maxPrice) <= 0
      );
    };

    test("rule-ref is resolved, canonical-hash-verified, and evaluated by a typed capability", async () => {
      const early = bidder("early", "100", DEADLINE - 100, DEADLINE + 100);
      const acceptable = bidder("acceptable", "50", DEADLINE - 50, DEADLINE + 100);
      const res = await runSealedEnvelopeCore(
        input({
          params: {
            commitDeadline: DEADLINE,
            revealWindow: REVEAL_WINDOW,
            selectionRule: ruleRef,
          },
        }),
        deps(
          [early.commit, acceptable.commit],
          [early.reveal, acceptable.reveal],
          {
            resolveRuleContent: async (ref) => {
              expect(ref).toEqual({
                contentHash: sha256Hex(canonicalize(ruleContent)),
                uri: "https://rules.example/max-60",
              });
              return ruleContent;
            },
            evaluateVerifiedRule: evaluator,
          },
        ),
      );
      expect(res.ok).toBe(true);
      expect(res.winningBidderClaim).toBe("acceptable");
    });

    test("first-acceptable requires and enforces listing-bound acceptance criteria", async () => {
      const early = bidder("early", "100", DEADLINE - 100, DEADLINE + 100);
      const acceptable = bidder("acceptable", "50", DEADLINE - 50, DEADLINE + 100);
      const params = {
        commitDeadline: DEADLINE,
        revealWindow: REVEAL_WINDOW,
        selectionRule: "first-acceptable" as const,
      };

      const missing = await runSealedEnvelopeCore(
        input({ params }),
        deps([early.commit], [early.reveal]),
      );
      expect(missing).toMatchObject({ ok: false, errorClass: "permanent" });
      expect(missing.reason).toMatch(/listing-bound acceptance rule/);

      const bound = await runSealedEnvelopeCore(
        input({ params: { ...params, acceptanceRule: ruleRef } }),
        deps(
          [early.commit, acceptable.commit],
          [early.reveal, acceptable.reveal],
          {
            resolveRuleContent: async () => ruleContent,
            evaluateVerifiedRule: evaluator,
          },
        ),
      );
      expect(bound.ok).toBe(true);
      expect(bound.winningBidderClaim).toBe("acceptable");
    });

    test("missing, unresolvable, malformed, or hash-mismatched rules fail permanent", async () => {
      const a = bidder("a", "50", DEADLINE - 100, DEADLINE + 100);
      const ruleInput = input({
        params: {
          commitDeadline: DEADLINE,
          revealWindow: REVEAL_WINDOW,
          selectionRule: ruleRef,
        },
      });

      const missingCapability = await runSealedEnvelopeCore(
        ruleInput,
        deps([a.commit], [a.reveal]),
      );
      expect(missingCapability).toMatchObject({ ok: false, errorClass: "permanent" });

      const unresolvable = await runSealedEnvelopeCore(
        ruleInput,
        deps([a.commit], [a.reveal], {
          resolveRuleContent: async () => {
            throw new Error("not found");
          },
          evaluateVerifiedRule: evaluator,
        }),
      );
      expect(unresolvable).toMatchObject({ ok: false, errorClass: "permanent" });

      const mismatch = await runSealedEnvelopeCore(
        ruleInput,
        deps([a.commit], [a.reveal], {
          resolveRuleContent: async () => ({ ...ruleContent, maxPrice: "999" }),
          evaluateVerifiedRule: evaluator,
        }),
      );
      expect(mismatch).toMatchObject({ ok: false, errorClass: "permanent" });
      expect(mismatch.reason).toMatch(/hash mismatch/);

      const malformedRef = await runSealedEnvelopeCore(
        input({
          params: {
            commitDeadline: DEADLINE,
            revealWindow: REVEAL_WINDOW,
            selectionRule: "rule-ref:not-a-hash:https://rules.example",
          },
        }),
        deps([a.commit], [a.reveal], {
          resolveRuleContent: async () => ruleContent,
          evaluateVerifiedRule: evaluator,
        }),
      );
      expect(malformedRef).toMatchObject({ ok: false, errorClass: "permanent" });
    });

    test("throwing or observably non-deterministic evaluators fail permanent", async () => {
      const a = bidder("a", "50", DEADLINE - 100, DEADLINE + 100);
      const ruleInput = input({
        params: {
          commitDeadline: DEADLINE,
          revealWindow: REVEAL_WINDOW,
          selectionRule: ruleRef,
        },
      });
      const throwing = await runSealedEnvelopeCore(
        ruleInput,
        deps([a.commit], [a.reveal], {
          resolveRuleContent: async () => ruleContent,
          evaluateVerifiedRule: () => {
            throw new Error("bad interpreter");
          },
        }),
      );
      expect(throwing).toMatchObject({ ok: false, errorClass: "permanent" });

      let flip = false;
      const nonDeterministic = await runSealedEnvelopeCore(
        ruleInput,
        deps([a.commit], [a.reveal], {
          resolveRuleContent: async () => ruleContent,
          evaluateVerifiedRule: () => {
            flip = !flip;
            return flip;
          },
        }),
      );
      expect(nonDeterministic).toMatchObject({
        ok: false,
        errorClass: "permanent",
      });
      expect(nonDeterministic.reason).toMatch(/non-deterministic/);
    });
  });

  test("no winner: all bids wrong currency → failed phase, counterparty fault", async () => {
    const a = bidder("a", "100", DEADLINE - 100, DEADLINE + 1000, "DAI");
    const res = await runSealedEnvelopeCore(input(), deps([a.commit], [a.reveal]));
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("counterparty");
    expect(res.losingBidderClaims).toEqual(["a"]);
    expect(res.agreementRef).toBeUndefined();
  });

  test("no winner: reserve-currency mismatch is a permanent (structural) fault", async () => {
    const a = bidder("a", "100", DEADLINE - 100, DEADLINE + 1000);
    const res = await runSealedEnvelopeCore(
      input({ reservePrice: { amount: "10", currency: "DAI" } }),
      deps([a.commit], [a.reveal]),
    );
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("permanent");
  });

  test("commitAgreement is NOT called when there's no winner", async () => {
    let called = 0;
    const a = bidder("a", "0", DEADLINE - 100, DEADLINE + 1000); // non-positive → excluded
    const res = await runSealedEnvelopeCore(
      input(),
      deps([a.commit], [a.reveal], {
        commitAgreement: async (ctx) => {
          called += 1;
          return { agreementRef: "x", agreementHash: `hash-${ctx.winningBidderClaim}` };
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(called).toBe(0);
  });

  test("buildSealedAgreement turns the winning bid into a valid AgreementDocument", () => {
    const agreement = buildSealedAgreement(
      {
        jobId: "job-1",
        seller: "did:demos:agent:seller",
        winningBidderClaim: "did:demos:agent:bob",
        winningBid: { price: { amount: "1.5", currency: "USDC" } },
        losingBidderClaims: ["did:demos:agent:carol"],
      },
      {
        seller: "did:demos:agent:seller",
        listingRef: "stor-listing",
        decimals: 6,
        rail: "pay-x402",
        deliveryPhase: "deliver-attested-payload",
        deliveryFormat: "application/json",
        expiresAt: "2026-01-01T00:00:00Z",
      },
    );
    expect(isAgreementDocument(agreement)).toBe(true);
    expect(agreement.pattern).toBe("negotiate-sealed-envelope");
    expect(agreement.buyer).toBe("did:demos:agent:bob");
    // 1.5 USDC @ 6 decimals → 1500000 base units.
    expect(agreement.price).toEqual({
      amount: "1500000",
      asset: "USDC",
      decimals: 6,
      rail: "pay-x402",
    });
  });

  test("buildSealedAgreement rejects a bid that resolves to zero base units", () => {
    expect(() =>
      buildSealedAgreement(
        {
          jobId: "j",
          seller: "s",
          winningBidderClaim: "b",
          winningBid: { price: { amount: "0.000000", currency: "USDC" } },
          losingBidderClaims: [],
        },
        {
          seller: "s",
          listingRef: "r",
          decimals: 6,
          rail: "pay-x402",
          deliveryPhase: "p",
          deliveryFormat: "f",
          expiresAt: "t",
        },
      ),
    ).toThrow();
  });

  test("SE-1 is re-validated only against an explicit sessionStartMs, never now()", async () => {
    const a = bidder("a", "100", DEADLINE - 100, DEADLINE + 1000);
    // With a session-start clock supplied, a too-soon commitDeadline throws SE-1.
    await expect(
      runSealedEnvelopeCore(
        input({
          sessionStartMs: NOW,
          params: { commitDeadline: NOW + 1000, revealWindow: 120, selectionRule: "lowest-price" },
        }),
        deps([a.commit], [a.reveal]),
      ),
    ).rejects.toThrow(/SE-1/);

    // Post-close default (no sessionStartMs): the core does NOT re-check SE-1
    // against a live clock, so a normal invocation never spuriously throws.
    const res = await runSealedEnvelopeCore(input(), deps([a.commit], [a.reveal]));
    expect(res.ok).toBe(true);
  });
});

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map(
      (rest) => [value, ...rest],
    ),
  );
}
