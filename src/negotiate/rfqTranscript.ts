import { types as nodeTypes } from "node:util";

import type {
  AgreementArtifact,
  VerificationDecision,
} from "../artifacts/types.js";
import { isAgreementArtifact } from "../artifacts/validators.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import {
  admitChannelMessage,
  prepareChannelMessageSigningInput,
  type ChannelMessage,
  type ChannelMessageAdmissionFailure,
  type ChannelMessageSignatureVerifier,
} from "./channel.js";
import {
  rfqSessionCheckpointHash,
  validateRfqProposal,
  type RfqAcceptBody,
  type RfqSessionState,
  type RfqTurnBody,
} from "./rfq.js";
import type { VerifiedListingInput } from "./fixedPrice.js";

export interface VerifiedRfqTranscript<TSignature = unknown> {
  transcriptVersion: "1";
  channelId: string;
  members: [string, string];
  messages: Array<ChannelMessage<RfqTurnBody, TSignature>>;
  generatedAt: number;
}

export interface PrepareRfqTranscriptInput<TSignature = unknown> {
  session: RfqSessionState;
  agreement: AgreementArtifact;
  messages: Array<ChannelMessage<RfqTurnBody, TSignature>>;
  generatedAt: number;
}

export interface RfqTranscriptConsentInput {
  member: string;
  evidence: unknown;
}

export interface RfqTranscriptConsentVerificationInput {
  member: string;
  channelId: string;
  transcriptHash: string;
  evidence: unknown;
}

export type RfqTranscriptConsentVerifier = (
  input: Readonly<RfqTranscriptConsentVerificationInput>,
) => Promise<VerificationDecision> | VerificationDecision;

export type RfqTranscriptDisclosureAction =
  | "retain-private"
  | "publish-encrypted";

export type RfqTranscriptDisclosureResult =
  | {
      decision: "pass";
      action: RfqTranscriptDisclosureAction;
      policy:
        | "none"
        | "encrypted-anchored-recommended"
        | "encrypted-anchored-required";
      transcriptHash: string;
      reason: string;
    }
  | ChannelMessageAdmissionFailure;

export interface PlanRfqTranscriptDisclosureInput<TSignature = unknown> {
  verifiedListing: VerifiedListingInput;
  session: RfqSessionState;
  agreement: AgreementArtifact;
  transcript: VerifiedRfqTranscript<TSignature>;
  consents?: RfqTranscriptConsentInput[];
}

type DataRecord = Record<string, unknown>;

const DECISIONS: ReadonlySet<string> = new Set<VerificationDecision>([
  "pass",
  "fail",
  "indeterminate",
  "error",
]);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    value === null ||
    typeof value !== "object" ||
    seen.has(value as object) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as DataRecord)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function sameOptional(left: unknown, right: unknown): boolean {
  if ((left === undefined) !== (right === undefined)) return false;
  return left === undefined || exact(left, right);
}

function agreementBindsSession(
  agreement: AgreementArtifact,
  session: RfqSessionState,
): boolean {
  const buyer = agreement.parties.find((party) => party.role === "buyer");
  const seller = agreement.parties.find((party) => party.role === "seller");
  const accepted = session.standingProposal;
  const channel = agreement.derivedFromChannel;
  if (buyer === undefined || seller === undefined || accepted === undefined) {
    return false;
  }
  return (
    agreement.derivedFromPattern === "rfq" &&
    agreement.jobId === session.jobId &&
    exact(agreement.listingRef, session.listingPin) &&
    channel !== undefined &&
    channel.subnet === session.channelId &&
    channel.lastMessageHash === session.lastMessageHash &&
    buyer.primaryClaim === session.buyer.primaryClaim &&
    buyer.bundleHash === session.buyer.bundleHash &&
    exact(buyer.vetRecordRef, session.buyer.vetRecordRef) &&
    seller.primaryClaim === session.seller.primaryClaim &&
    seller.bundleHash === session.seller.bundleHash &&
    exact(seller.vetRecordRef, session.seller.vetRecordRef) &&
    exact(agreement.terms.price, accepted.price) &&
    sameOptional(
      agreement.terms.meteredQuantity,
      accepted.meteredQuantity,
    )
  );
}

function acceptSequence(body: unknown): number | undefined {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    nodeTypes.isProxy(body)
  ) {
    return undefined;
  }
  const candidate = body as Partial<RfqAcceptBody> & DataRecord;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.rfqBodyVersion !== "1" ||
    !Number.isSafeInteger(candidate.acceptedSequence) ||
    (candidate.acceptedSequence ?? 0) < 1
  ) {
    return undefined;
  }
  return candidate.acceptedSequence;
}

function transcriptBindsSession<TSignature>(
  transcript: VerifiedRfqTranscript<TSignature>,
  session: RfqSessionState,
): boolean {
  const last = transcript.messages.at(-1);
  if (last === undefined) return false;
  let lastHash: string;
  try {
    const { signature: _signature, ...unsigned } = last;
    lastHash = prepareChannelMessageSigningInput(unsigned).envelopeHash;
  } catch {
    return false;
  }
  return (
    transcript.transcriptVersion === "1" &&
    transcript.channelId === session.channelId &&
    transcript.members.length === 2 &&
    transcript.members[0] === session.buyer.primaryClaim &&
    transcript.members[1] === session.seller.primaryClaim &&
    transcript.messages.length === session.turnCount &&
    last.sequence === session.lastSequence &&
    lastHash === session.lastMessageHash
  );
}

/**
 * Verify and own the complete private transcript behind an accepted RFQ.
 * This is deliberately a `VerifiedRfqTranscript`, not the underspecified
 * normative `ChannelTranscript` signature/encryption wire from #351.
 */
export async function prepareRfqTranscript<TSignature = unknown>(
  callerInput: PrepareRfqTranscriptInput<TSignature>,
  verifySignature: ChannelMessageSignatureVerifier<
    RfqTurnBody,
    TSignature
  >,
): Promise<
  | { decision: "pass"; transcript: Readonly<VerifiedRfqTranscript<TSignature>> }
  | ChannelMessageAdmissionFailure
> {
  if (typeof verifySignature !== "function" || nodeTypes.isProxy(verifySignature)) {
    return { decision: "error", reason: "RFQ transcript verifier is unsafe" };
  }
  let input: PrepareRfqTranscriptInput<TSignature>;
  try {
    input = snapshotCanonicalJsonRead(
      callerInput,
      "RFQ transcript input",
    );
    rfqSessionCheckpointHash(input.session);
  } catch {
    return { decision: "error", reason: "RFQ transcript input is malformed" };
  }
  const { session, agreement } = input;
  if (
    session.status !== "accepted" ||
    session.lastMessageHash === undefined ||
    !isAgreementArtifact(agreement) ||
    !agreementBindsSession(agreement, session) ||
    !Number.isSafeInteger(input.generatedAt) ||
    input.generatedAt < agreement.generatedAt ||
    input.messages.length !== session.turnCount ||
    input.messages.length < 2
  ) {
    return {
      decision: "fail",
      reason: "RFQ transcript does not bind the accepted agreement/session",
    };
  }

  let priorSequence = 0;
  let expectedSender =
    session.initiator === "buyer"
      ? session.buyer.primaryClaim
      : session.seller.primaryClaim;
  let standingSequence: number | undefined;
  let lastHash: string | undefined;
  for (let index = 0; index < input.messages.length; index += 1) {
    const admitted = await admitChannelMessage<RfqTurnBody, TSignature>(
      input.messages[index],
      {
        sessionChannelId: session.channelId,
        lastSequence: priorSequence,
        priorChannelIds: [],
      },
      verifySignature,
    );
    if (admitted.decision !== "pass") return admitted;
    const message = admitted.message;
    if (message.sender !== expectedSender) {
      return {
        decision: "fail",
        reason: "RFQ transcript member turn order is invalid",
      };
    }
    const final = index === input.messages.length - 1;
    try {
      if (!final) {
        const expectedType = index === 0 ? "offer" : "counter";
        if (message.type !== expectedType) {
          throw new DacsError("RFQ transcript proposal type is invalid");
        }
        const body = message.body as unknown as DataRecord;
        if (
          body === null ||
          typeof body !== "object" ||
          body.rfqBodyVersion !== "1" ||
          Object.keys(body).length !== 2
        ) {
          throw new DacsError("RFQ transcript proposal body is malformed");
        }
        validateRfqProposal(body.proposal, session.pricing);
        standingSequence = message.sequence;
      } else if (
        message.type !== "accept" ||
        standingSequence === undefined ||
        acceptSequence(message.body) !== standingSequence
      ) {
        throw new DacsError("RFQ transcript acceptance is not exact");
      }
    } catch (cause) {
      return {
        decision: "fail",
        reason:
          cause instanceof DacsError
            ? cause.message
            : "RFQ transcript turn is malformed",
      };
    }
    priorSequence = message.sequence;
    lastHash = admitted.envelopeHash;
    expectedSender =
      message.sender === session.buyer.primaryClaim
        ? session.seller.primaryClaim
        : session.buyer.primaryClaim;
  }
  if (
    priorSequence !== session.lastSequence ||
    standingSequence !== session.standingProposal?.sequence ||
    lastHash !== session.lastMessageHash
  ) {
    return {
      decision: "fail",
      reason: "RFQ transcript endpoint differs from the accepted checkpoint",
    };
  }
  return {
    decision: "pass",
    transcript: deepFreeze({
      transcriptVersion: "1",
      channelId: session.channelId,
      members: [session.buyer.primaryClaim, session.seller.primaryClaim],
      messages: input.messages,
      generatedAt: input.generatedAt,
    }),
  };
}

/**
 * Enforce the Listing's disclosure policy before any injected encrypted
 * publisher is invoked. Consent evidence stays opaque until #351 defines its
 * wire format, but every member's evidence must authenticate as `pass`.
 */
export async function planRfqTranscriptDisclosure<TSignature = unknown>(
  callerInput: PlanRfqTranscriptDisclosureInput<TSignature>,
  verifyConsent: RfqTranscriptConsentVerifier,
): Promise<RfqTranscriptDisclosureResult> {
  let input: PlanRfqTranscriptDisclosureInput<TSignature>;
  try {
    input = snapshotCanonicalJsonRead(
      callerInput,
      "RFQ transcript disclosure input",
    );
  } catch {
    return { decision: "error", reason: "RFQ disclosure input is malformed" };
  }
  const { listing, pin } = input.verifiedListing;
  try {
    rfqSessionCheckpointHash(input.session);
  } catch {
    return { decision: "error", reason: "RFQ disclosure session is malformed" };
  }
  if (
    input.verifiedListing.disposition !== "verified" ||
    pin.listingId !== listing.listingId ||
    pin.version !== listing.listingVersion ||
    pin.contentHash !== contentHash(listing as unknown as DataRecord) ||
    input.session.status !== "accepted" ||
    !isAgreementArtifact(input.agreement) ||
    !agreementBindsSession(input.agreement, input.session) ||
    !transcriptBindsSession(input.transcript, input.session)
  ) {
    return { decision: "error", reason: "RFQ disclosure authority is invalid" };
  }
  const policy = listing.terms.transcriptDisclosurePolicy ?? "none";
  const transcriptHash = sha256Hex(canonicalize(input.transcript));
  if (policy === "none") {
    return {
      decision: "pass",
      action: "retain-private",
      policy,
      transcriptHash,
      reason: "Listing policy keeps the transcript private",
    };
  }
  if (typeof verifyConsent !== "function" || nodeTypes.isProxy(verifyConsent)) {
    return { decision: "error", reason: "RFQ consent verifier is unsafe" };
  }
  const consents = input.consents ?? [];
  const members = input.transcript.members;
  if (
    consents.some(
      (consent) =>
        consent === null ||
        typeof consent !== "object" ||
        Object.keys(consent).length !== 2 ||
        typeof consent.member !== "string" ||
        consent.member.length === 0,
    )
  ) {
    return { decision: "error", reason: "RFQ consent evidence is malformed" };
  }
  const byMember = new Map(consents.map((consent) => [consent.member, consent]));
  if (
    consents.length !== members.length ||
    byMember.size !== members.length ||
    members.some((member) => !byMember.has(member))
  ) {
    if (policy === "encrypted-anchored-required") {
      return { decision: "fail", reason: "required transcript consent is incomplete" };
    }
    return {
      decision: "pass",
      action: "retain-private",
      policy,
      transcriptHash,
      reason: "recommended transcript publication lacks unanimous consent",
    };
  }

  const decisions: VerificationDecision[] = [];
  for (const member of members) {
    const consent = byMember.get(member)!;
    let decision: unknown;
    try {
      decision = await verifyConsent(
        deepFreeze({
          member,
          channelId: input.transcript.channelId,
          transcriptHash,
          evidence: consent.evidence,
        }),
      );
    } catch {
      decision = "error";
    }
    if (typeof decision !== "string" || !DECISIONS.has(decision)) {
      decision = "error";
    }
    decisions.push(decision as VerificationDecision);
  }
  if (decisions.every((decision) => decision === "pass")) {
    return {
      decision: "pass",
      action: "publish-encrypted",
      policy,
      transcriptHash,
      reason: "every channel member authenticated publication consent",
    };
  }
  if (policy === "encrypted-anchored-recommended") {
    return {
      decision: "pass",
      action: "retain-private",
      policy,
      transcriptHash,
      reason: "recommended transcript publication lacks unanimous consent",
    };
  }
  if (decisions.includes("fail")) {
    return { decision: "fail", reason: "a channel member refused transcript publication" };
  }
  if (decisions.includes("indeterminate")) {
    return {
      decision: "indeterminate",
      reason: "required transcript consent is not currently verifiable",
    };
  }
  return { decision: "error", reason: "required transcript consent verification errored" };
}
