import {
  createDacsFixedPriceX402SellerAgreementPolicyV1,
  createDacsFixedPriceX402SellerSessionPolicyV1,
} from "./fixedPriceX402Profile.js";
import { createDacsFixedPriceX402SellerAuditV1 } from
  "./fixedPriceX402SellerAudit.js";
import {
  createDacsFixedPriceX402SellerPaymentEvidenceV1,
} from "./fixedPriceX402SellerPaymentEvidence.js";
import {
  createDacsFixedPriceX402SellerX402CompositionV1,
  type DacsFixedPriceX402SellerRuntimeOptionsV1,
} from "./fixedPriceX402SellerRuntime.js";
import {
  createDacsSellerLiveCommerceAssemblyV1,
} from "./liveCommerceAssembly.js";
import type { DacsSellerLiveCommerceGraphV1 } from "./liveCommerceGraph.js";
import type { DacsVetTerminalBundleTransportOptionsV1 } from
  "./terminalBundleTransportRuntime.js";

export interface DacsFixedPriceX402SellerLiveOptionsV1
  extends DacsFixedPriceX402SellerRuntimeOptionsV1 {
  sellerPublicEndpoint: string;
  sellerPayee: string;
  maximumServiceAmount: string;
  maximumClockSkewMs?: number;
  terminalBundle?: Readonly<Omit<
    DacsVetTerminalBundleTransportOptionsV1,
    "context"
  >>;
}

/**
 * Close the complete seller graph around one authenticated fixed-price Listing
 * profile. The caller supplies only deployment policy, bounded application
 * work; all session, agreement, x402, PC-7, delivery and DACS-5 wiring is
 * fixed by the host package.
 */
export async function createDacsFixedPriceX402SellerLiveV1(
  options: Readonly<DacsFixedPriceX402SellerLiveOptionsV1>,
): Promise<Readonly<DacsSellerLiveCommerceGraphV1>> {
  const session = createDacsFixedPriceX402SellerSessionPolicyV1({
    context: options.context,
    rail: options.rail,
    sellerPublicEndpoint: options.sellerPublicEndpoint,
    sellerPayee: options.sellerPayee,
    maximumServiceAmount: options.maximumServiceAmount,
  });
  const agreement = createDacsFixedPriceX402SellerAgreementPolicyV1({
    context: options.context,
    ...(options.maximumClockSkewMs === undefined
      ? {} : { maximumClockSkewMs: options.maximumClockSkewMs }),
  });
  const x402 = createDacsFixedPriceX402SellerX402CompositionV1(options);
  const paymentEvidence = createDacsFixedPriceX402SellerPaymentEvidenceV1({
    context: options.context,
    settlement: x402.settlement,
  });
  const audit = createDacsFixedPriceX402SellerAuditV1({
    context: options.context,
    fulfilment: x402.fulfilment,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });

  return createDacsSellerLiveCommerceAssemblyV1({
    context: options.context,
    workerId: options.workerId,
    sessionBootstrap: {
      admitInit: session.admitInit,
      resolveBuyerRequirement: session.resolveBuyerRequirement,
      resolveSellerRequirement: session.resolveSellerRequirement,
    },
    agreementTransport: { admitProposal: session.admitProposal },
    agreement,
    x402: x402.x402,
    paymentEvidence: paymentEvidence.paymentEvidence,
    settlement: paymentEvidence.settlement,
    audit,
    ...(options.terminalBundle === undefined
      ? {} : { terminalBundle: options.terminalBundle }),
  });
}
