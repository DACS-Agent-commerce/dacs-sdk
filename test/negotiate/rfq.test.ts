import { describe, expect, test, vi } from "vitest";

import {
  advanceRfqSession,
  contentHash,
  deriveRfqPriceBand,
  openRfqSession,
  rfqSessionCheckpointHash,
  validateRfqProposal,
  type AttestationRef,
  type ChannelMessageSignatureVerifier,
  type FixedPricePartyInput,
  type IdentityBundle,
  type Listing,
  type RfqChannelReservation,
  type RfqSessionState,
  type RfqTurnBody,
  type VerifiedListingInput,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER = "did:demos:buyer-rfq";
const SELLER = "did:demos:seller-rfq";

function identity(claim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: claim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: claim, signature: "identity-proof" }],
    },
  };
}

function vetRef(suffix: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator: `stor://${suffix}` },
    contentHash: "a".repeat(64),
  };
}

const buyer: FixedPricePartyInput = {
  identityBundle: identity(BUYER),
  vetRecordRef: vetRef("buyer-vet"),
};
const seller: FixedPricePartyInput = {
  identityBundle: identity(SELLER),
  vetRecordRef: vetRef("seller-vet"),
};

function listing(
  options: {
    maxTurns?: number;
    timeoutSec?: number;
    initiator?: "buyer" | "seller";
    channelSubnet?: string;
    pricing?: Listing["pricing"];
  } = {},
): Listing {
  const parameters: Record<string, unknown> = {
    maxTurns: options.maxTurns ?? 4,
    timeoutSec: options.timeoutSec ?? 10,
    ...(options.initiator === undefined
      ? {}
      : { rfqInitiator: options.initiator }),
    ...(options.channelSubnet === undefined
      ? {}
      : { channelSubnet: options.channelSubnet }),
  };
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "private-market-data-rfq",
    requiredCapabilities: ["SR-2", "SR-4"],
    seller: {
      identity: identity(SELLER),
      displayName: "RFQ seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Private market data",
      description: "Negotiated data service",
      category: "data.finance",
      tags: ["rfq"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-rfq", parameters },
      { kind: "commit-agreement" },
      { kind: "deliver-attested-payload" },
    ],
    pricing: options.pricing ?? {
      kind: "negotiable",
      bandCenter: { amount: "10.05", currency: "USDC" },
      minPct: 10,
      maxPct: 10,
    },
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 100_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
}

function verified(value = listing()): VerifiedListingInput {
  return {
    disposition: "verified",
    listing: value,
    pin: {
      listingId: value.listingId,
      version: value.listingVersion,
      contentHash: contentHash(value as unknown as Record<string, unknown>),
    },
  };
}

function openInput(value = listing()) {
  return {
    jobId: JOB_ID,
    verifiedListing: verified(value),
    buyer,
    seller,
    channelId: "private-channel-01",
    startedAt: NOW,
  };
}

const reserve: RfqChannelReservation = () => "pass";
const verify: ChannelMessageSignatureVerifier<RfqTurnBody, string> = () =>
  "pass";

function turn(
  state: RfqSessionState,
  type: "offer" | "counter" | "accept" | "reject" | "abort",
  body: RfqTurnBody,
  options: {
    sender?: string;
    sequence?: number;
    repliesTo?: number;
    sentAt?: number;
  } = {},
) {
  return {
    channelId: state.channelId,
    sequence: options.sequence ?? state.lastSequence + 1,
    sender: options.sender ?? state.expectedSender,
    sentAt: options.sentAt ?? NOW,
    type,
    body,
    ...(options.repliesTo === undefined
      ? {}
      : { refs: { repliesTo: options.repliesTo } }),
    signature: "adapter-owned-signature",
  };
}

const proposal = (amount: string) => ({
  rfqBodyVersion: "1" as const,
  proposal: {
    rfqProposalVersion: "1" as const,
    price: { amount, currency: "USDC" },
  },
});

async function opened(value = listing()): Promise<RfqSessionState> {
  const result = await openRfqSession(openInput(value), reserve);
  if (result.decision !== "pass") throw new Error(result.reason);
  return result.state as RfqSessionState;
}

describe("RFQ pricing hard guards", () => {
  test("derives inclusive centre-precision bounds with half-up rounding", () => {
    expect(
      deriveRfqPriceBand({
        kind: "negotiable",
        bandCenter: { amount: "10.05", currency: "USDC" },
        minPct: 10,
        maxPct: 10,
      }),
    ).toEqual({
      minimum: { amount: "9.05", currency: "USDC" },
      maximum: { amount: "11.06", currency: "USDC" },
    });

    expect(
      deriveRfqPriceBand({
        kind: "negotiable",
        bandCenter: { amount: "100", currency: "DEM" },
        minPct: 0.1,
        maxPct: 0.1,
      }),
    ).toEqual({
      minimum: { amount: "100", currency: "DEM" },
      maximum: { amount: "100", currency: "DEM" },
    });
  });

  test("accepts both band boundaries and rejects price, currency, unit, and shape drift", () => {
    const pricing = listing().pricing as Extract<
      Listing["pricing"],
      { kind: "negotiable" }
    >;
    expect(
      validateRfqProposal(proposal("9.05").proposal, pricing).price.amount,
    ).toBe("9.05");
    expect(
      validateRfqProposal(proposal("11.06").proposal, pricing).price.amount,
    ).toBe("11.06");
    expect(() =>
      validateRfqProposal(proposal("9.049").proposal, pricing),
    ).toThrow(/outside/);
    expect(() =>
      validateRfqProposal(proposal("11.061").proposal, pricing),
    ).toThrow(/outside/);
    expect(() =>
      validateRfqProposal(
        {
          ...proposal("10").proposal,
          price: { amount: "10", currency: "DEM" },
        },
        pricing,
      ),
    ).toThrow(/outside/);
    expect(() =>
      validateRfqProposal(
        {
          ...proposal("10").proposal,
          extra: true,
        },
        pricing,
      ),
    ).toThrow(/malformed/);
  });

  test("derives metered total from exact quantity and rejects caller-selected totals", () => {
    const pricing = {
      kind: "metered" as const,
      unitPrice: { amount: "1.25", currency: "USDC" },
      unit: "record",
      minTotal: { amount: "5", currency: "USDC" },
    };
    const valid = {
      rfqProposalVersion: "1",
      price: { amount: "5", currency: "USDC" },
      meteredQuantity: { quantity: "3", unit: "record" },
    };
    expect(validateRfqProposal(valid, pricing)).toEqual(valid);
    expect(() =>
      validateRfqProposal(
        {
          ...valid,
          price: { amount: "4", currency: "USDC" },
        },
        pricing,
      ),
    ).toThrow(/does not match/);
    expect(() =>
      validateRfqProposal(
        {
          ...valid,
          meteredQuantity: { quantity: "03", unit: "record" },
        },
        pricing,
      ),
    ).toThrow(/canonical|quantity/);
  });
});

describe("RFQ session opening", () => {
  test("derives session authority from the exact Listing and durably reserves CH-6", async () => {
    const reservation = vi.fn<RfqChannelReservation>((input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.listingPin)).toBe(true);
      expect(input).toMatchObject({
        reservationVersion: "1",
        jobId: JOB_ID,
        channelId: "private-channel-01",
        members: [BUYER, SELLER],
      });
      return "pass";
    });
    const result = await openRfqSession(openInput(), reservation);
    expect(result.decision).toBe("pass");
    if (result.decision === "pass") {
      expect(result.state).toMatchObject({
        status: "open",
        initiator: "buyer",
        expectedSender: BUYER,
        maxTurns: 4,
        timeoutMs: 10_000,
        lastSequence: 0,
        turnCount: 0,
      });
      expect(Object.isFrozen(result.state)).toBe(true);
      expect(Object.isFrozen(result.state.pricing)).toBe(true);
    }
    expect(reservation).toHaveBeenCalledOnce();
  });

  test.each(["fail", "indeterminate", "error"] as const)(
    "preserves a %s durable reservation result",
    async (decision) => {
      const result = await openRfqSession(openInput(), () => decision);
      expect(result.decision).toBe(decision);
    },
  );

  test("honours seller initiation and a Listing-pinned channel subnet", async () => {
    const value = listing({
      initiator: "seller",
      channelSubnet: "private-channel-01",
    });
    const result = await openRfqSession(openInput(value), reserve);
    expect(result.decision).toBe("pass");
    if (result.decision === "pass")
      expect(result.state.expectedSender).toBe(SELLER);

    await expect(
      openRfqSession(
        {
          ...openInput(value),
          channelId: "caller-overrode-channel",
        },
        reserve,
      ),
    ).resolves.toMatchObject({ decision: "error" });
  });

  test("fails before reservation for a forged pin, invalid pattern, or party mismatch", async () => {
    const reservation = vi.fn<RfqChannelReservation>(() => "pass");
    const forged = openInput();
    forged.verifiedListing.pin.contentHash = "b".repeat(64);
    await expect(openRfqSession(forged, reservation)).resolves.toMatchObject({
      decision: "error",
    });

    const wrongPattern = listing();
    wrongPattern.pipeline[0] = { kind: "negotiate-fixed-price" };
    await expect(
      openRfqSession(openInput(wrongPattern), reservation),
    ).resolves.toMatchObject({ decision: "error" });

    await expect(
      openRfqSession(
        {
          ...openInput(),
          seller: { ...seller, identityBundle: identity("did:demos:impostor") },
        },
        reservation,
      ),
    ).resolves.toMatchObject({ decision: "error" });

    await expect(
      openRfqSession(
        {
          ...openInput(),
          buyer: {
            ...buyer,
            identityBundle: identity(`${SELLER}?scope=buyer`),
          },
        },
        reservation,
      ),
    ).resolves.toMatchObject({ decision: "error" });
    expect(reservation).not.toHaveBeenCalled();
  });
});

describe("bounded RFQ turn reducer", () => {
  test("runs offer → counter → exact acceptance and produces immutable recovery state", async () => {
    const state0 = await opened();
    const first = await advanceRfqSession(
      state0,
      turn(state0, "offer", proposal("10"), { sentAt: NOW + 999_999 }),
      NOW + 1_000,
      verify,
    );
    expect(first.decision).toBe("pass");
    if (first.decision !== "pass") return;
    expect(first.state).toMatchObject({
      status: "open",
      turnCount: 1,
      lastSequence: 1,
      lastMessageHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      expectedSender: SELLER,
      awaitingSince: NOW + 1_000,
      standingProposal: { price: { amount: "10", currency: "USDC" } },
    });

    const second = await advanceRfqSession(
      first.state as RfqSessionState,
      turn(first.state as RfqSessionState, "counter", proposal("9.5"), {
        repliesTo: 1,
      }),
      NOW + 2_000,
      verify,
    );
    expect(second.decision).toBe("pass");
    if (second.decision !== "pass") return;

    const accepted = await advanceRfqSession(
      second.state as RfqSessionState,
      turn(
        second.state as RfqSessionState,
        "accept",
        {
          rfqBodyVersion: "1",
          acceptedSequence: 2,
        },
        { repliesTo: 2 },
      ),
      NOW + 3_000,
      verify,
    );
    expect(accepted.decision).toBe("pass");
    if (accepted.decision === "pass") {
      expect(accepted.state).toMatchObject({
        status: "accepted",
        turnCount: 3,
        lastSequence: 3,
        lastMessageHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        standingProposal: {
          sequence: 2,
          proposer: SELLER,
          price: { amount: "9.5", currency: "USDC" },
        },
      });
      expect(Object.isFrozen(accepted.state.standingProposal?.price)).toBe(
        true,
      );
      expect(accepted.state.lastMessageHash).not.toBe(
        first.state.lastMessageHash,
      );
      expect(
        rfqSessionCheckpointHash(accepted.state as RfqSessionState),
      ).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("rejects signed out-of-band counters before changing accepted state", async () => {
    const state0 = await opened();
    const first = await advanceRfqSession(
      state0,
      turn(state0, "offer", proposal("10")),
      NOW + 1,
      verify,
    );
    if (first.decision !== "pass") throw new Error(first.reason);
    const result = await advanceRfqSession(
      first.state as RfqSessionState,
      turn(first.state as RfqSessionState, "counter", proposal("50")),
      NOW + 2,
      verify,
    );
    expect(result).toMatchObject({ decision: "fail" });
    expect(first.state).toMatchObject({
      lastSequence: 1,
      turnCount: 1,
      status: "open",
    });
  });

  test("enforces Listing maxTurns and makes the terminal state replay-safe", async () => {
    const state0 = await opened(listing({ maxTurns: 2 }));
    const first = await advanceRfqSession(
      state0,
      turn(state0, "offer", proposal("10")),
      NOW + 1,
      verify,
    );
    if (first.decision !== "pass") throw new Error(first.reason);
    const second = await advanceRfqSession(
      first.state as RfqSessionState,
      turn(first.state as RfqSessionState, "counter", proposal("9.5")),
      NOW + 2,
      verify,
    );
    expect(second.decision).toBe("pass");
    if (second.decision !== "pass") return;
    expect(second.state).toMatchObject({ status: "max-turns", turnCount: 2 });

    const verifier = vi.fn<
      ChannelMessageSignatureVerifier<RfqTurnBody, string>
    >(() => "pass");
    const replay = await advanceRfqSession(
      second.state as RfqSessionState,
      turn(second.state as RfqSessionState, "accept", {
        rfqBodyVersion: "1",
        acceptedSequence: 2,
      }),
      NOW + 3,
      verifier,
    );
    expect(replay.decision).toBe("fail");
    expect(verifier).not.toHaveBeenCalled();
  });

  test("uses trusted receipt time, not sender sentAt, and times out without verification", async () => {
    const state = await opened(listing({ timeoutSec: 2 }));
    const verifier = vi.fn<
      ChannelMessageSignatureVerifier<RfqTurnBody, string>
    >(() => "pass");
    const result = await advanceRfqSession(
      state,
      turn(state, "offer", proposal("10"), { sentAt: NOW + 1_000_000 }),
      NOW + 2_001,
      verifier,
    );
    expect(result).toMatchObject({
      decision: "pass",
      state: { status: "timed-out", lastSequence: 0, turnCount: 0 },
    });
    expect(verifier).not.toHaveBeenCalled();
    if (result.decision === "pass") {
      expect(rfqSessionCheckpointHash(result.state as RfqSessionState)).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });

  test("rejects corrupted rehydrated checkpoints before signature verification", async () => {
    const original = await opened();
    const cases: RfqSessionState[] = [];

    const wrongBundle = structuredClone(original);
    wrongBundle.buyer.bundleHash = "not-a-hash";
    cases.push(wrongBundle);

    const impossibleTurn = structuredClone(original);
    impossibleTurn.turnCount = 1;
    cases.push(impossibleTurn);

    const duplicateQualifiedParty = structuredClone(original);
    duplicateQualifiedParty.buyer.primaryClaim = `${SELLER}?scope=buyer`;
    cases.push(duplicateQualifiedParty);

    const extraField = structuredClone(original) as RfqSessionState & {
      callerAuthority?: boolean;
    };
    extraField.callerAuthority = true;
    cases.push(extraField);

    const admitted = await advanceRfqSession(
      original,
      turn(original, "offer", proposal("10")),
      NOW + 1,
      verify,
    );
    if (admitted.decision !== "pass") throw new Error(admitted.reason);
    const missingAdmittedHash = structuredClone(
      admitted.state,
    ) as RfqSessionState;
    delete missingAdmittedHash.lastMessageHash;
    cases.push(missingAdmittedHash);

    const verifier = vi.fn<
      ChannelMessageSignatureVerifier<RfqTurnBody, string>
    >(() => "pass");
    for (const corrupted of cases) {
      await expect(
        advanceRfqSession(
          corrupted,
          turn(original, "offer", proposal("10")),
          NOW + 1,
          verifier,
        ),
      ).resolves.toMatchObject({ decision: "error" });
      expect(() => rfqSessionCheckpointHash(corrupted)).toThrow(/malformed/);
    }
    expect(verifier).not.toHaveBeenCalled();
  });

  test("rejects wrong member, wrong first type, stale reply, and ambiguous acceptance", async () => {
    const state0 = await opened();
    await expect(
      advanceRfqSession(
        state0,
        turn(state0, "offer", proposal("10"), { sender: SELLER }),
        NOW + 1,
        verify,
      ),
    ).resolves.toMatchObject({ decision: "fail" });
    await expect(
      advanceRfqSession(
        state0,
        turn(state0, "accept", { rfqBodyVersion: "1", acceptedSequence: 1 }),
        NOW + 1,
        verify,
      ),
    ).resolves.toMatchObject({ decision: "fail" });

    const first = await advanceRfqSession(
      state0,
      turn(state0, "offer", proposal("10")),
      NOW + 1,
      verify,
    );
    if (first.decision !== "pass") throw new Error(first.reason);
    await expect(
      advanceRfqSession(
        first.state as RfqSessionState,
        turn(first.state as RfqSessionState, "counter", proposal("9.5"), {
          sequence: 3,
          repliesTo: 2,
        }),
        NOW + 2,
        verify,
      ),
    ).resolves.toMatchObject({ decision: "fail" });
    await expect(
      advanceRfqSession(
        first.state as RfqSessionState,
        turn(first.state as RfqSessionState, "accept", {
          rfqBodyVersion: "1",
          acceptedSequence: 999,
        }),
        NOW + 2,
        verify,
      ),
    ).resolves.toMatchObject({ decision: "fail" });
  });

  test.each(["reject", "abort"] as const)(
    "records signed %s as terminal",
    async (kind) => {
      const state0 = await opened();
      const first = await advanceRfqSession(
        state0,
        turn(state0, "offer", proposal("10")),
        NOW + 1,
        verify,
      );
      if (first.decision !== "pass") throw new Error(first.reason);
      const result = await advanceRfqSession(
        first.state as RfqSessionState,
        turn(first.state as RfqSessionState, kind, {
          rfqBodyVersion: "1",
          reason: "terms unavailable",
        }),
        NOW + 2,
        verify,
      );
      expect(result).toMatchObject({
        decision: "pass",
        state: {
          status: kind === "reject" ? "rejected" : "aborted",
          terminalReason: "terms unavailable",
        },
      });
    },
  );
});
