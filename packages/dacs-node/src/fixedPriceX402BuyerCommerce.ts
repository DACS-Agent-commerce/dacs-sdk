import {
  baseUnits,
  verifySettlementEvidence,
  x402BuyerSettlementKey,
  type AuthenticatedRailDefinition,
} from "@kynesyslabs/dacs";
import { isSettlementEvidence } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";

import type { DacsBuyerReceivedRuntimeOptionsV1 } from "./buyerReceivedRuntime.js";
import {
  loadDacsFixedPriceX402BuyerAgreementPublicationV1,
} from "./fixedPriceX402Profile.js";
import type { DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1 } from
  "./paymentEvidenceRuntime.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const DID_PREFIX = "did:demos:agent:";

export interface DacsFixedPriceX402BuyerCommerceOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  retryDelayMs?: number;
}

export interface DacsFixedPriceX402BuyerCommerceV1 {
  paymentEvidence: Omit<
    DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >;
  buyerReceived: Omit<DacsBuyerReceivedRuntimeOptionsV1, "context">;
}

export class DacsFixedPriceX402BuyerCommerceError extends Error {
  override readonly name = "DacsFixedPriceX402BuyerCommerceError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function verifier() {
  return Object.freeze({
    async resolvePublicKey(signer: string) {
      const raw = canonicalDemosAgentPublicKey(signer);
      return raw === null ? null : Uint8Array.from(raw);
    },
    verify(bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) {
      try {
        return ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));
      } catch {
        return false;
      }
    },
  });
}

function owner(claim: string): string {
  if (!claim.startsWith(DID_PREFIX) || claim.length !== DID_PREFIX.length + 64) {
    throw new DacsFixedPriceX402BuyerCommerceError("buyer-commerce-peer-invalid");
  }
  return claim.slice(DID_PREFIX.length);
}

function paymentRailContext(rail: Readonly<AuthenticatedRailDefinition>) {
  if (rail.railType !== "x402" || rail.phaseHandler !== "pay-x402" ||
      rail.asset.kind !== "erc20") {
    throw new TypeError("fixed-price buyer commerce requires an x402 ERC-20 rail");
  }
  return Object.freeze({
    railId: rail.railId,
    railType: rail.railType,
    asset: rail.asset.symbol,
    network: `eip155:${rail.asset.chainId}`,
    handler: rail.phaseHandler,
  });
}

function agreementPrice(value: unknown): Readonly<{ amount: string; currency: string }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const terms = (value as Record<string, unknown>).terms;
  if (terms === null || typeof terms !== "object" || Array.isArray(terms)) return null;
  const price = (terms as Record<string, unknown>).price;
  if (price === null || typeof price !== "object" || Array.isArray(price)) return null;
  const amount = (price as Record<string, unknown>).amount;
  const currency = (price as Record<string, unknown>).currency;
  return typeof amount === "string" && typeof currency === "string"
    ? Object.freeze({ amount, currency }) : null;
}

async function verifyPeerAnchor(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  logicalAddress: string,
  expectedHash: string | undefined,
): Promise<Readonly<Record<string, unknown>> | null> {
  const resolved = await context.demos.adapter.resolveAnchorByName(
    logicalAddress,
    owner(context.peerAuthority),
  );
  if (resolved.status !== "present") return null;
  const artifact = await context.demos.adapter.readAnchor(resolved.address);
  if (artifact === null) return null;
  const hash = contentHash(artifact);
  if (expectedHash !== undefined && hash !== expectedHash) return null;
  const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
    logicalAddress,
    nativeAddress: resolved.address,
    contentHash: hash,
    writer: context.peerAuthority,
  });
  return receipt !== null && receipt.writer === context.peerAuthority &&
      receipt.logicalAddress === logicalAddress &&
      receipt.nativeAddress === resolved.address && receipt.contentHash === hash &&
      receipt.observationDisposition === "established" &&
      (receipt.state === "included" || receipt.state === "finalized") &&
      await context.demos.adapter.verifyDemosAnchorReceipt(receipt) === true
    ? artifact : null;
}

/**
 * Bind the buyer's PC-7 verifier and response-receipt gate to its exact
 * retained x402 settlement and the seller's independently readable delivery
 * evidence. The HTTP body alone never authorizes commerce completion.
 */
export function createDacsFixedPriceX402BuyerCommerceV1(
  options: Readonly<DacsFixedPriceX402BuyerCommerceOptionsV1>,
): Readonly<DacsFixedPriceX402BuyerCommerceV1> {
  if (options.context.role !== "buyer" || options.context.evm.role !== "buyer" ||
      options.context.commerceStores.role !== "buyer") {
    throw new TypeError("fixed-price buyer commerce options are invalid");
  }
  const context = options.context;
  const railContext = paymentRailContext(options.rail);
  const asset = options.rail.asset;
  if (asset.kind !== "erc20") {
    throw new TypeError("fixed-price buyer commerce requires an ERC-20 rail");
  }

  const paymentEvidence: DacsFixedPriceX402BuyerCommerceV1["paymentEvidence"] = {
    async verifyEvidence(request) {
      try {
        const loaded = await context.database.createLiveCoordinatorStore("buyer")
          .load("buyer", request.jobId);
        if (loaded.status !== "ok" || loaded.record.buyer !== context.authority ||
            loaded.record.seller !== context.peerAuthority ||
            request.evidence.signature.signer !== context.peerAuthority) {
          return { disposition: "invalid" as const,
            reason: "payment evidence actor binding invalid" };
        }
        const agreement = await loadDacsFixedPriceX402BuyerAgreementPublicationV1(
          context,
          loaded.record,
        );
        const settlementKey = x402BuyerSettlementKey({
          railId: loaded.record.protocol.rail.railId,
          jobId: loaded.record.jobId,
          phaseIndex: 2,
        });
        const stored = await context.commerceStores.x402Settlement.load(settlementKey);
        if (stored.status !== "captured" || stored.outcome.status !== "captured") {
          return { disposition: "indeterminate" as const,
            reason: "buyer settlement finality is unavailable" };
        }
        const event = request.evidence.paymentTxRefs?.[0];
        const captured = stored.outcome.settlement.signedEvent;
        const price = agreementPrice(agreement.artifact);
        if (request.evidence.phase !== "pay-x402" ||
            request.evidence.outcome !== "success" || event?.kind !== "x402-event" ||
            event.httpResource !== captured.httpResource ||
            event.paymentReceiptHash !== captured.paymentReceiptHash ||
            event.settlementTxHash.replace(/^0x/, "") !== captured.settlementTxHash ||
            event.chainId !== captured.chainId || event.logIndex !== captured.logIndex ||
            event.protocolVersion !== captured.protocolVersion ||
            price === null || request.evidence.paymentAmount.amount !== price.amount ||
            request.evidence.paymentAmount.currency !== price.currency ||
            baseUnits(
              request.evidence.paymentAmount.amount,
              asset.decimals,
            ) !== stored.intent.amount) {
          return { disposition: "invalid" as const,
            reason: "payment evidence settlement binding invalid" };
        }
        const verified = await verifySettlementEvidence(request.evidence, {
          orchestrator: context.peerAuthority,
          agreement: {
            amount: price.amount,
            currency: price.currency,
          },
          rail: railContext,
        }, verifier());
        return verified.decision === "pass"
          ? { disposition: "valid" as const }
          : {
              disposition: verified.decision === "indeterminate"
                ? "indeterminate" as const : "invalid" as const,
              reason: "payment evidence cryptographic verification failed",
            };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "payment evidence verification unavailable" };
      }
    },
  };

  const buyerReceived: DacsFixedPriceX402BuyerCommerceV1["buyerReceived"] = {
    resolvePaymentScope: () => Object.freeze({ paymentPhaseIndex: 2 }),
    async authorizeReceived({ operation, intent, settlement, response, body }) {
      try {
        if (intent.jobId !== operation.order.jobId || intent.phaseIndex !== 2 ||
            settlement.signedEvent.httpResource !== intent.httpResource ||
            response.contentType.split(";", 1)[0]?.trim().toLowerCase() !==
              "application/json") return false;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        const payload = JSON.parse(text) as unknown;
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          return false;
        }
        const evidenceRaw = await verifyPeerAnchor(
          context,
          `dacs4:delivery-evidence:${operation.order.jobId}`,
          undefined,
        );
        if (evidenceRaw === null) return "indeterminate" as const;
        if (!isSettlementEvidence(evidenceRaw) ||
            evidenceRaw.jobId !== operation.order.jobId ||
            evidenceRaw.phase !== "deliver-storage-program" ||
            evidenceRaw.outcome !== "success" ||
            evidenceRaw.signature.signer !== context.peerAuthority ||
            contentHash(payload as Record<string, unknown>) !==
              evidenceRaw.deliverableContentHash) return false;
        const verification = await verifySettlementEvidence(evidenceRaw, {
          orchestrator: context.peerAuthority,
        }, verifier());
        if (verification.decision === "indeterminate") return "indeterminate" as const;
        if (verification.decision !== "pass") return false;
        const delivered = await verifyPeerAnchor(
          context,
          evidenceRaw.deliverableAnchor.locator,
          evidenceRaw.deliverableContentHash,
        );
        return delivered === null ? "indeterminate" as const
          : canonicalize(delivered) === canonicalize(payload);
      } catch {
        return "indeterminate" as const;
      }
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  };

  return Object.freeze({
    paymentEvidence: Object.freeze(paymentEvidence),
    buyerReceived: Object.freeze(buyerReceived),
  });
}
