import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import {
  advanceRfqSession,
  type AgreementArtifact,
  contentHash,
  deriveRfqAgreement,
  openRfqSession,
  planRfqTranscriptDisclosure,
  prepareRfqTranscript,
  signRfqAgreement,
  type AttestationRef,
  type ChannelMessage,
  type ChannelMessageSignatureV1,
  type IdentityBundle,
  type Listing,
  type RfqSessionState,
  type RfqTurnBody,
  type VerificationDecision,
} from "../../src/index.js";

import { rfqProfileAdmission } from "./correctiveProfile.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER = "did:demos:buyer-transcript";
const SELLER = "did:demos:seller-transcript";
/** Verifier-owned CORE §11.1.2(3) profile admission for the session. */
const PROFILE = rfqProfileAdmission("rfq-private-channel-01", [BUYER, SELLER]);

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

async function fixture(
  policy?: Listing["terms"]["transcriptDisclosurePolicy"],
  options: { qualifiedSenders?: boolean } = {},
) {
  // CH-7: a parameter-qualified spelling names the same member.
  const spell = (claim: string, role: string) =>
    options.qualifiedSenders ? `${claim}?role=${role}` : claim;
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
    PROFILE,
  );
  if (opened.decision !== "pass") throw new Error(opened.reason);
  const offer: ChannelMessage<RfqTurnBody, ChannelMessageSignatureV1> = {
    canonicalChannelMessageVersion: "1" as const,
    channelId: opened.state.channelId,
    sequence: 1,
    sender: spell(BUYER, "buyer"),
    sentAt: NOW + 1,
    type: "offer",
    body: {
      rfqBodyVersion: "1",
      proposal: {
        rfqProposalVersion: "1",
        price: { amount: "9.5", currency: "USDC" },
      },
    },
    signature: { signatureVersion: "1" as const, signer: spell(BUYER, "buyer"), algorithm: "ed25519" as const, value: Buffer.alloc(64, 1).toString("base64url") },
  };
  const offered = await advanceRfqSession(
    opened.state as RfqSessionState,
    offer,
    NOW + 1,
    () => "pass",
    PROFILE,
  );
  if (offered.decision !== "pass") throw new Error(offered.reason);
  const accept: ChannelMessage<RfqTurnBody, ChannelMessageSignatureV1> = {
    canonicalChannelMessageVersion: "1" as const,
    channelId: opened.state.channelId,
    sequence: 2,
    sender: spell(SELLER, "seller"),
    sentAt: NOW + 2,
    type: "accept",
    body: { rfqBodyVersion: "1", acceptedSequence: 1 },
    refs: { repliesTo: 1 },
    signature: { signatureVersion: "1" as const, signer: spell(SELLER, "seller"), algorithm: "ed25519" as const, value: Buffer.alloc(64, 2).toString("base64url") },
  };
  const accepted = await advanceRfqSession(
    offered.state as RfqSessionState,
    accept,
    NOW + 2,
    () => "pass",
    PROFILE,
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
      PROFILE,
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

  test("re-verifies a transcript whose wire senders are parameter-qualified spellings of the members (CH-7)", async () => {
    const value = await fixture(undefined, { qualifiedSenders: true });
    expect(value.session.standingProposal?.proposer).toBe(BUYER);
    const result = await prepareRfqTranscript(
      { session: value.session, agreement: value.agreement, messages: value.messages, generatedAt: NOW + 4 },
      () => "pass",
      PROFILE,
    );
    expect(result.decision, result.decision === "pass" ? "" : result.reason).toBe("pass");
    if (result.decision !== "pass") return;
    expect(result.transcript.members).toEqual([BUYER, SELLER]);
    expect(result.transcript.messages[0]?.sender).toBe(`${BUYER}?role=buyer`);
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
          PROFILE,
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
        PROFILE,
      ),
    ).resolves.toMatchObject({ decision: "indeterminate" });
  });

  test("refuses a transcript written before the v0.6 channel wire as archival input", async () => {
    // Store-version-1 records written by SDK main before this change.
    const { buyerFinalized } = JSON.parse(
      readFileSync(new URL("../fixtures/durable-rfq-store-v1.json", import.meta.url), "utf8"),
    ) as { buyerFinalized: { session: RfqSessionState; agreement: { finalized: AgreementArtifact }; transcript: ChannelMessage<RfqTurnBody>[] } };
    const verifier = vi.fn(() => "pass" as const);
    await expect(
      prepareRfqTranscript(
        {
          session: buyerFinalized.session,
          agreement: buyerFinalized.agreement.finalized,
          messages: buyerFinalized.transcript,
          generatedAt: buyerFinalized.agreement.finalized.generatedAt,
        },
        verifier,
        rfqProfileAdmission(buyerFinalized.session.channelId, [
          buyerFinalized.session.buyer.primaryClaim,
          buyerFinalized.session.seller.primaryClaim,
        ]),
      ),
    ).resolves.toEqual({
      decision: "error",
      reason: "RFQ transcript predates the DACS-3 v0.6 channel wire; it is archival only",
    });
    expect(verifier).not.toHaveBeenCalled();
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
      PROFILE,
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
          profileAdmission: PROFILE,
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
          profileAdmission: PROFILE,
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
          profileAdmission: PROFILE,
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
            profileAdmission: PROFILE,
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
          profileAdmission: PROFILE,
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
            message.signature.signer === BUYER ? "pass" : "fail",
          verifyConsent,
          profileAdmission: PROFILE,
        },
      ),
    ).resolves.toMatchObject({ decision: "fail" });
    expect(verifyConsent).not.toHaveBeenCalled();
  });

  test.each(["undefined", "throwing"] as const)(
    "captures verifiers through the intrinsic bind with %s own bind properties",
    async (bindKind) => {
      const value = await disclosureFixture("encrypted-anchored-required");
      const ownBind =
        bindKind === "undefined"
          ? undefined
          : () => {
              throw new Error("hostile own bind");
            };
      const verifyMessageSignature = Object.assign(
        () => "pass" as const,
        { bind: ownBind },
      );
      const verifyConsent = Object.assign(
        () => "pass" as const,
        { bind: ownBind },
      );
      await expect(
        planRfqTranscriptDisclosure(
          {
            verifiedListing: verified(value.value),
            session: value.session,
            agreement: value.agreement,
            transcript: value.transcript,
            consents,
          },
          { verifyMessageSignature, verifyConsent, profileAdmission: PROFILE },
        ),
      ).resolves.toMatchObject({
        decision: "pass",
        action: "publish-encrypted",
      });
    },
  );

  test("reads profileAdmission only as an own member of the verifiers", async () => {
    const value = await disclosureFixture();
    const input = {
      verifiedListing: verified(value.value),
      session: value.session,
      agreement: value.agreement,
      transcript: value.transcript,
      consents,
    };
    const verifiers = { verifyMessageSignature: () => "pass" as const, verifyConsent: () => "pass" as const };
    Object.defineProperty(Object.prototype, "profileAdmission", {
      value: PROFILE,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    let result: unknown;
    try {
      result = await planRfqTranscriptDisclosure(input, verifiers as never);
    } finally {
      delete (Object.prototype as Record<string, unknown>).profileAdmission;
    }
    expect(result).toMatchObject({ decision: "indeterminate" });
  });
});
