import { describe, expect, test } from "vitest";

import {
  buildCommitMessage,
  buildRevealMessage,
  buildSealedAgreement,
  runSealedEnvelopeCore,
  type SealedEnvelopeDeps,
  type SealedEnvelopeInput,
} from "../../src/negotiate/sealedEnvelope.js";
import { isAgreementDocument } from "../../src/artifacts/validators.js";
import {
  makeCommitment,
  type AnchoredCommit,
  type AnchoredReveal,
  type SealedBid,
} from "../../src/negotiate/sealedBid.js";

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
