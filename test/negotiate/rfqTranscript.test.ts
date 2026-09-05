import { describe, expect, test, vi } from "vitest";

import {
  advanceRfqSession,
  contentHash,
  deriveRfqAgreement,
  openRfqSession,
  planRfqTranscriptDisclosure,
  prepareRfqTranscript,
  signRfqAgreement,
  type AttestationRef,
  type ChannelMessage,
  type IdentityBundle,
  type Listing,
  type RfqSessionState,
  type RfqTurnBody,
  type VerificationDecision,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER = "did:demos:buyer-transcript";
const SELLER = "did:demos:seller-transcript";

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

function vetRef(locator: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: "a".repeat(64),
  };
}

const buyer = {
  identityBundle: identity(BUYER),
  vetRecordRef: vetRef("stor:buyer-transcript-vet"),
};
const seller = {
  identityBundle: identity(SELLER),
  vetRecordRef: vetRef("stor:seller-transcript-vet"),
};

function listing(
  policy?: Listing["terms"]["transcriptDisclosurePolicy"],
): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "rfq-transcript-listing",
    requiredCapabilities: ["SR-2", "SR-4"],
    seller: {
      identity: identity(SELLER),
      displayName: "Transcript seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Private RFQ",
      description: "Private negotiated delivery",
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
      {
        kind: "negotiate-rfq",
        parameters: { maxTurns: 4, timeoutSec: 10 },
      },
      { kind: "commit-agreement" },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "negotiable",
      bandCenter: { amount: "10", currency: "USDC" },
      minPct: 20,
      maxPct: 20,
    },
    terms: {
      deadlineSecAfterCommit: 600,
      ...(policy === undefined ? {} : { transcriptDisclosurePolicy: policy }),
    },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
}

function verified(value: Listing) {
  return {
    disposition: "verified" as const,
    listing: value,
    pin: {
      listingId: value.listingId,
      version: value.listingVersion,
      contentHash: contentHash(value as unknown as Record<string, unknown>),
    },
  };
}

async function fixture(policy?: Listing["terms"]["transcriptDisclosurePolicy"]) {
  const value = listing(policy);
  const opened = await openRfqSession(
    {
      jobId: JOB_ID,
      verifiedListing: verified(value),
      buyer,
      seller,
      channelId: "rfq-private-channel-01",
      startedAt: NOW,
    },
    () => "pass",
  );
  if (opened.decision !== "pass") throw new Error(opened.reason);
  const offer: ChannelMessage<RfqTurnBody, string> = {
    channelId: opened.state.channelId,
    sequence: 1,
    sender: BUYER,
    sentAt: NOW + 1,
    type: "offer",
    body: {
      rfqBodyVersion: "1",
      proposal: {
        rfqProposalVersion: "1",
        price: { amount: "9.5", currency: "USDC" },
      },
    },
    signature: "buyer-channel-signature",
  };
  const offered = await advanceRfqSession(
    opened.state as RfqSessionState,
    offer,
    NOW + 1,
    () => "pass",
  );
  if (offered.decision !== "pass") throw new Error(offered.reason);
  const accept: ChannelMessage<RfqTurnBody, string> = {
    channelId: opened.state.channelId,
    sequence: 2,
    sender: SELLER,
    sentAt: NOW + 2,
    type: "accept",
    body: { rfqBodyVersion: "1", acceptedSequence: 1 },
    refs: { repliesTo: 1 },
    signature: "seller-channel-signature",
  };
  const accepted = await advanceRfqSession(
    offered.state as RfqSessionState,
    accept,
    NOW + 2,
    () => "pass",
  );
  if (accepted.decision !== "pass") throw new Error(accepted.reason);
  const session = accepted.state as RfqSessionState;
  const agreement = await signRfqAgreement(
    deriveRfqAgreement({
      session,
      verifiedListing: verified(value),
      buyer,
      seller,
      generatedAt: NOW + 3,
    }),
    { party: BUYER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
    {
      party: SELLER,
      algorithm: "ed25519",
      sign: () => new Uint8Array(64),
    },
  );
  return { value, session, agreement, messages: [offer, accept] };
}

describe("RFQ private transcript verification", () => {
  test("re-verifies the complete ordered transcript and exact agreement hook", async () => {
    const value = await fixture();
    const result = await prepareRfqTranscript(
      {
        session: value.session,
        agreement: value.agreement,
        messages: value.messages,
        generatedAt: NOW + 4,
      },
      () => "pass",
    );
    expect(result.decision).toBe("pass");
    if (result.decision !== "pass") return;
    expect(result.transcript).toMatchObject({
      transcriptVersion: "1",
      channelId: value.session.channelId,
      members: [BUYER, SELLER],
      messages: [{ sequence: 1 }, { sequence: 2 }],
    });
    expect(Object.isFrozen(result.transcript)).toBe(true);
    expect(Object.isFrozen(result.transcript.messages[0])).toBe(true);
  });

  test("fails closed on omitted, reordered, tampered, or uncertain messages", async () => {
    const value = await fixture();
    const candidates = [
      value.messages.slice(1),
      [...value.messages].reverse(),
      [
        {
          ...value.messages[0]!,
          body: {
            rfqBodyVersion: "1" as const,
            proposal: {
              rfqProposalVersion: "1" as const,
              price: { amount: "50", currency: "USDC" },
            },
          },
        },
        value.messages[1]!,
      ],
      [
        {
          ...value.messages[0]!,
          body: {
            rfqBodyVersion: "1" as const,
            proposal: {
              rfqProposalVersion: "1" as const,
              price: { amount: "9.6", currency: "USDC" },
            },
          },
        },
        value.messages[1]!,
      ],
    ];
    for (const messages of candidates) {
      await expect(
        prepareRfqTranscript(
          {
            session: value.session,
            agreement: value.agreement,
            messages,
            generatedAt: NOW + 4,
          },
          () => "pass",
        ),
      ).resolves.not.toMatchObject({ decision: "pass" });
    }
    await expect(
      prepareRfqTranscript(
        {
          session: value.session,
          agreement: value.agreement,
          messages: value.messages,
          generatedAt: NOW + 4,
        },
        () => "indeterminate",
      ),
    ).resolves.toMatchObject({ decision: "indeterminate" });
  });
});

describe("RFQ transcript disclosure policy", () => {
  async function disclosureFixture(
    policy?: Listing["terms"]["transcriptDisclosurePolicy"],
  ) {
    const value = await fixture(policy);
    const prepared = await prepareRfqTranscript(
      {
        session: value.session,
        agreement: value.agreement,
        messages: value.messages,
        generatedAt: NOW + 4,
      },
      () => "pass",
    );
    if (prepared.decision !== "pass") throw new Error(prepared.reason);
    return { ...value, transcript: prepared.transcript };
  }

  const consents = [
    { member: BUYER, evidence: { signature: "buyer-consent" } },
    { member: SELLER, evidence: { signature: "seller-consent" } },
  ];

  test("defaults to private and never consults a consent verifier", async () => {
    const value = await disclosureFixture();
    const verifyConsent = vi.fn(() => "pass" as const);
    await expect(
      planRfqTranscriptDisclosure(
        {
          verifiedListing: verified(value.value),
          session: value.session,
          agreement: value.agreement,
          transcript: value.transcript,
          consents,
        },
        {
          verifyMessageSignature: () => "pass",
          verifyConsent,
        },
      ),
    ).resolves.toMatchObject({
      decision: "pass",
      action: "retain-private",
      policy: "none",
    });
    expect(verifyConsent).not.toHaveBeenCalled();
  });

  test("publishes a recommended transcript only after unanimous authenticated consent", async () => {
    const value = await disclosureFixture("encrypted-anchored-recommended");
    await expect(
      planRfqTranscriptDisclosure(
        {
          verifiedListing: verified(value.value),
          session: value.session,
          agreement: value.agreement,
          transcript: value.transcript,
          consents,
        },
        {
          verifyMessageSignature: () => "pass",
          verifyConsent: () => "pass",
        },
      ),
    ).resolves.toMatchObject({
      decision: "pass",
      action: "publish-encrypted",
    });
    await expect(
      planRfqTranscriptDisclosure(
        {
          verifiedListing: verified(value.value),
          session: value.session,
          agreement: value.agreement,
          transcript: value.transcript,
          consents: consents.slice(0, 1),
        },
        {
          verifyMessageSignature: () => "pass",
          verifyConsent: () => "pass",
        },
      ),
    ).resolves.toMatchObject({
      decision: "pass",
      action: "retain-private",
    });
  });

  test.each([
    ["fail", "fail"],
    ["indeterminate", "indeterminate"],
    ["error", "error"],
  ] as const)(
    "preserves %s when required publication consent cannot pass",
    async (verification, expected) => {
      const value = await disclosureFixture("encrypted-anchored-required");
      const decision = vi
        .fn<() => VerificationDecision>()
        .mockReturnValueOnce("pass")
        .mockReturnValueOnce(verification);
      await expect(
        planRfqTranscriptDisclosure(
          {
            verifiedListing: verified(value.value),
            session: value.session,
            agreement: value.agreement,
            transcript: value.transcript,
            consents,
          },
          {
            verifyMessageSignature: () => "pass",
            verifyConsent: decision,
          },
        ),
      ).resolves.toMatchObject({ decision: expected });
    },
  );

  test("fails required publication before verification when consent is incomplete", async () => {
    const value = await disclosureFixture("encrypted-anchored-required");
    const verifier = vi.fn(() => "pass" as const);
    await expect(
      planRfqTranscriptDisclosure(
        {
          verifiedListing: verified(value.value),
          session: value.session,
          agreement: value.agreement,
          transcript: value.transcript,
          consents: [],
        },
        {
          verifyMessageSignature: () => "pass",
          verifyConsent: verifier,
        },
      ),
    ).resolves.toMatchObject({ decision: "fail" });
    expect(verifier).not.toHaveBeenCalled();
  });

  test("re-authenticates a supplied transcript before permitting disclosure", async () => {
    const value = await disclosureFixture("encrypted-anchored-required");
    const verifyConsent = vi.fn(() => "pass" as const);
    await expect(
      planRfqTranscriptDisclosure(
        {
          verifiedListing: verified(value.value),
          session: value.session,
          agreement: value.agreement,
          transcript: value.transcript,
          consents,
        },
        {
          verifyMessageSignature: ({ message }) =>
            message.signature === "buyer-channel-signature" ? "pass" : "fail",
          verifyConsent,
        },
      ),
    ).resolves.toMatchObject({ decision: "fail" });
    expect(verifyConsent).not.toHaveBeenCalled();
  });
});
