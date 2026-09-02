import { describe, expect, test } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  advanceRfqSession,
  commitRfqAgreement,
  contentHash,
  deriveRfqAgreement,
  ed25519Sign,
  ed25519Verify,
  isAgreementDocument,
  isPayeeBoundAgreementDocument,
  openRfqSession,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  signRfqAgreement,
  signedBytes,
  type AttestationRef,
  type CommitmentSignatureVerifier,
  type FinalityCommitmentProvider,
  type FinalityCommitmentRecord,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
  type RfqSessionState,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 41));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const ORCHESTRATOR_SEED = Uint8Array.from(Buffer.alloc(32, 43));
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const ORCHESTRATOR = claim(ORCHESTRATOR_SEED);
const HASH = "a".repeat(64);
const COMMITTED_AT = NOW + 5_000;

const rail: PaymentRailRef = {
  railId: "x402:base-sepolia",
  railVersion: 1,
  parameters: { network: "eip155:84532" },
};

function identity(primaryClaim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "identity-proof" }],
    },
  };
}

function vetRef(locator: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: HASH,
  };
}

const buyer = {
  identityBundle: identity(BUYER),
  vetRecordRef: vetRef("stor:buyer-rfq-vet"),
};
const seller = {
  identityBundle: identity(SELLER),
  vetRecordRef: vetRef("stor:seller-rfq-vet"),
};

function listing(
  commitment: "commit-agreement" | "commit-payee-bound-agreement" =
    "commit-agreement",
  pricing: Listing["pricing"] = {
    kind: "negotiable",
    bandCenter: { amount: "10", currency: "USDC" },
    minPct: 20,
    maxPct: 20,
  },
): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "institutional-rfq",
    requiredCapabilities: ["SR-2", "SR-4"],
    seller: {
      identity: identity(SELLER),
      displayName: "RFQ seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Private data RFQ",
      description: "Negotiated data delivery",
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
      { kind: commitment },
      { kind: "pay-x402", parameters: { rail: rail.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing,
    acceptedRails: [rail],
    terms: { deadlineSecAfterCommit: 600 },
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

async function acceptedSession(
  value: Listing,
  amount = "9.5",
  meteredQuantity?: { quantity: string; unit: string },
): Promise<RfqSessionState> {
  const opened = await openRfqSession(
    {
      jobId: JOB_ID,
      verifiedListing: verified(value),
      buyer,
      seller,
      channelId: "l2ps-rfq-channel-01",
      startedAt: NOW,
    },
    () => "pass",
  );
  if (opened.decision !== "pass") throw new Error(opened.reason);
  const offer = {
    channelId: opened.state.channelId,
    sequence: 1,
    sender: BUYER,
    sentAt: NOW + 1,
    type: "offer" as const,
    body: {
      rfqBodyVersion: "1" as const,
      proposal: {
        rfqProposalVersion: "1" as const,
        price: {
          amount,
          currency:
            value.pricing.kind === "metered"
              ? value.pricing.unitPrice.currency
              : "USDC",
        },
        ...(meteredQuantity === undefined ? {} : { meteredQuantity }),
      },
    },
    signature: "adapter-signature",
  };
  const offered = await advanceRfqSession(
    opened.state as RfqSessionState,
    offer,
    NOW + 1,
    () => "pass",
  );
  if (offered.decision !== "pass") throw new Error(offered.reason);
  const accepted = await advanceRfqSession(
    offered.state as RfqSessionState,
    {
      channelId: offered.state.channelId,
      sequence: 2,
      sender: SELLER,
      sentAt: NOW + 2,
      type: "accept",
      body: { rfqBodyVersion: "1", acceptedSequence: 1 },
      refs: { repliesTo: 1 },
      signature: "adapter-signature",
    },
    NOW + 2,
    () => "pass",
  );
  if (accepted.decision !== "pass") throw new Error(accepted.reason);
  return accepted.state as RfqSessionState;
}

function agreementInput(value: Listing, session: RfqSessionState) {
  return {
    session,
    verifiedListing: verified(value),
    buyer,
    seller,
    selectedRail: rail,
    generatedAt: NOW + 3,
  };
}

const signatureKeys = new Map([
  [BUYER, publicKeyFromSeed(BUYER_SEED)],
  [SELLER, publicKeyFromSeed(SELLER_SEED)],
  [ORCHESTRATOR, publicKeyFromSeed(ORCHESTRATOR_SEED)],
]);

const verifyCommitmentSignature: CommitmentSignatureVerifier = (input) => {
  const key = signatureKeys.get(input.signer);
  if (key === undefined || input.algorithm !== "ed25519") {
    return "indeterminate";
  }
  return ed25519Verify(
    input.signedBytes,
    Uint8Array.from(Buffer.from(input.value, "base64url")),
    key,
  )
    ? "valid"
    : "invalid";
};

function commitmentProvider(
  onSubmit?: (record: FinalityCommitmentRecord) => void,
): FinalityCommitmentProvider {
  return {
    resolve: async () => ({ disposition: "absent" }),
    submit: async (logicalAddress, record) => {
      onSubmit?.(record);
      const nativeAddress = "stor-rfq-finality";
      return {
        record,
        nativeAddress,
        anchorTxRef: {
          kind: "storage-program",
          address: nativeAddress,
          writeTxHash: "c".repeat(64),
        },
        anchorReceipt: {
          receiptVersion: "1",
          substrate: "demos:testnet",
          finalityProfile: "demos-bft-final",
          logicalAddress,
          nativeAddress,
          contentHash: contentHash(record as unknown as Record<string, unknown>),
          transactionRef: { kind: "demos", value: "rfq-commitment-write" },
          writer: "demos-writer",
          nonce: "17",
          state: "finalized",
          observationDisposition: "established",
          observedAt: COMMITTED_AT + 1_000,
          blockRef: {
            id: "rfq-block-100",
            height: "100",
            timestamp: COMMITTED_AT,
          },
          evidence: { kind: "demos-finality-proof", value: "proof-100" },
        },
      };
    },
    verifyAnchorReceipt: async () => "valid" as const,
  };
}

function rfqCommitmentInput(
  value: Listing,
  rfqSession: RfqSessionState,
  agreement: Awaited<ReturnType<typeof signRfqAgreement>>,
) {
  const buyerParty = agreement.parties.find((party) => party.role === "buyer")!;
  const sellerParty = agreement.parties.find((party) => party.role === "seller")!;
  return {
    agreement,
    verifiedListing: verified(value),
    rfqSession,
    session: {
      jobId: agreement.jobId,
      listingRef: { ...agreement.listingRef },
      phaseKind: "commit-agreement" as const,
      orchestrator: ORCHESTRATOR,
      buyer: {
        primaryClaim: buyerParty.primaryClaim,
        bundleHash: buyerParty.bundleHash,
        vetRecordRef: structuredClone(buyerParty.vetRecordRef),
      },
      seller: {
        primaryClaim: sellerParty.primaryClaim,
        bundleHash: sellerParty.bundleHash,
        vetRecordRef: structuredClone(sellerParty.vetRecordRef),
      },
    },
    createdAt: NOW + 4_000,
    commitmentSigner: {
      algorithm: "ed25519" as const,
      signer: ORCHESTRATOR,
      sign: (bytes: Uint8Array) =>
        ed25519Sign(bytes, privateKeyFromSeed(ORCHESTRATOR_SEED)),
    },
  };
}

describe("RFQ Agreement finalization (DACS-3 §8.4.2/§8.5)", () => {
  test("derives signed terms only from the exact accepted proposal and transcript", async () => {
    const value = listing();
    const session = await acceptedSession(value);
    const draft = deriveRfqAgreement(agreementInput(value, session));

    expect(draft).toMatchObject({
      agreementVersion: "1",
      jobId: JOB_ID,
      derivedFromPattern: "rfq",
      derivedFromChannel: {
        subnet: "l2ps-rfq-channel-01",
        lastMessageHash: session.lastMessageHash,
      },
      terms: {
        price: { amount: "9.5", currency: "USDC" },
        rail,
        deadline: NOW + 3 + 600_000,
      },
      parties: [
        { role: "buyer", primaryClaim: BUYER },
        { role: "seller", primaryClaim: SELLER },
      ],
    });
    expect(Object.prototype.hasOwnProperty.call(draft, "signatures")).toBe(
      false,
    );
  });

  test("rejects non-accepted, corrupted, rebound, or substituted authority", async () => {
    const value = listing();
    const session = await acceptedSession(value);

    const openState = structuredClone(session);
    openState.status = "open";
    expect(() => deriveRfqAgreement(agreementInput(value, openState))).toThrow();

    const noTranscript = structuredClone(session);
    delete noTranscript.lastMessageHash;
    expect(() =>
      deriveRfqAgreement(agreementInput(value, noTranscript)),
    ).toThrow();

    const changedListing = structuredClone(value);
    changedListing.pricing = {
      kind: "negotiable",
      bandCenter: { amount: "100", currency: "USDC" },
      minPct: 5,
      maxPct: 5,
    };
    expect(() =>
      deriveRfqAgreement(agreementInput(changedListing, session)),
    ).toThrow(/Listing authority/);

    expect(() =>
      deriveRfqAgreement({
        ...agreementInput(value, session),
        buyer: {
          ...buyer,
          identityBundle: identity("did:demos:agent:substitute"),
        },
      }),
    ).toThrow(/parties differ/);
  });

  test("derives the exact metered quantity and total accepted in-channel", async () => {
    const value = listing("commit-agreement", {
      kind: "metered",
      unitPrice: { amount: "1.25", currency: "USDC" },
      unit: "record",
      minTotal: { amount: "5", currency: "USDC" },
    });
    const session = await acceptedSession(value, "5", {
      quantity: "3",
      unit: "record",
    });
    const draft = deriveRfqAgreement(agreementInput(value, session));
    expect(draft.terms).toMatchObject({
      price: { amount: "5", currency: "USDC" },
      meteredQuantity: { quantity: "3", unit: "record" },
    });
  });

  test("enforces exact payee-bound payment-phase coverage", async () => {
    const value = listing("commit-payee-bound-agreement");
    const session = await acceptedSession(value);
    const input = agreementInput(value, session);
    expect(() => deriveRfqAgreement(input)).toThrow(/cover every pay phase/);

    const payoutBindings = [
      { railId: rail.railId, phaseIndex: 2, payeeAddress: "0xseller" },
    ];
    const draft = deriveRfqAgreement({ ...input, payoutBindings });
    expect(
      isPayeeBoundAgreementDocument({
        ...draft,
        signatures: [
          {
            party: BUYER,
            algorithm: "ed25519",
            value: Buffer.alloc(64).toString("base64url"),
          },
          {
            party: SELLER,
            algorithm: "ed25519",
            value: Buffer.alloc(64, 1).toString("base64url"),
          },
        ],
      }),
    ).toBe(true);

    expect(() =>
      deriveRfqAgreement({
        ...input,
        payoutBindings: [{ ...payoutBindings[0]!, phaseIndex: 3 }],
      }),
    ).toThrow(/missing, duplicate, or extra/);
  });

  test("collects and verifies both RFQ agreement signatures", async () => {
    const value = listing();
    const draft = deriveRfqAgreement(
      agreementInput(value, await acceptedSession(value)),
    );
    const signed = await signRfqAgreement(
      draft,
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      },
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    expect(isAgreementDocument(signed)).toBe(true);
    const bytes = signedBytes(
      ARTIFACT_SEPARATORS.AgreementDocument,
      contentHash(signed as unknown as Record<string, unknown>),
    );
    expect(
      ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signed.signatures[0]!.value, "base64url")),
        publicKeyFromSeed(BUYER_SEED),
      ),
    ).toBe(true);
    expect(
      ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signed.signatures[1]!.value, "base64url")),
        publicKeyFromSeed(SELLER_SEED),
      ),
    ).toBe(true);
  });

  test("refuses to use the RFQ signer for an unbound or different-pattern draft", async () => {
    const value = listing();
    const draft = deriveRfqAgreement(
      agreementInput(value, await acceptedSession(value)),
    );
    const signer = (party: string) => ({
      party,
      algorithm: "ed25519" as const,
      sign: () => new Uint8Array(64),
    });
    await expect(
      signRfqAgreement(
        { ...draft, derivedFromPattern: "fixed-price" },
        signer(BUYER),
        signer(SELLER),
      ),
    ).rejects.toThrow(/bind its authenticated channel transcript/);
    const unbound = structuredClone(draft);
    delete unbound.derivedFromChannel;
    await expect(
      signRfqAgreement(unbound, signer(BUYER), signer(SELLER)),
    ).rejects.toThrow(/bind its authenticated channel transcript/);
  });

  test("anchors an authenticated RFQ commitment and derives time only from finality", async () => {
    const value = listing();
    const rfqSession = await acceptedSession(value);
    const agreement = await signRfqAgreement(
      deriveRfqAgreement(agreementInput(value, rfqSession)),
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      },
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    let submitted: FinalityCommitmentRecord | undefined;
    const result = await commitRfqAgreement(
      rfqCommitmentInput(value, rfqSession, agreement),
      commitmentProvider((record) => (submitted = record)),
      verifyCommitmentSignature,
    );
    expect(submitted).toMatchObject({
      finalityCommitmentVersion: "1",
      pattern: "rfq",
      jobId: JOB_ID,
      parties: [BUYER, SELLER],
      signature: { signer: ORCHESTRATOR },
    });
    expect(result).toMatchObject({
      recordKind: "finality",
      committedAt: COMMITTED_AT,
      resumed: false,
    });
  });

  test("has zero SR-2 writes when the RFQ transcript or accepted price is rebound", async () => {
    const value = listing();
    const rfqSession = await acceptedSession(value);
    const agreement = await signRfqAgreement(
      deriveRfqAgreement(agreementInput(value, rfqSession)),
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      },
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    for (const mutate of [
      (candidate: RfqSessionState) => {
        candidate.lastMessageHash = "f".repeat(64);
      },
      (candidate: RfqSessionState) => {
        candidate.standingProposal!.price.amount = "10";
      },
    ]) {
      const changed = structuredClone(rfqSession);
      mutate(changed);
      let submits = 0;
      await expect(
        commitRfqAgreement(
          rfqCommitmentInput(value, changed, agreement),
          commitmentProvider(() => {
            submits += 1;
          }),
          verifyCommitmentSignature,
        ),
      ).rejects.toBeDefined();
      expect(submits).toBe(0);
    }
  });
});
