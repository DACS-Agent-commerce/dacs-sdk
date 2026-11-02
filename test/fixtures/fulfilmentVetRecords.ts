import type {
  SellerFulfilmentAgreement,
  SellerFulfilmentSessionRecord,
} from "../../src/agent/runFulfilmentCore.js";
import type { SellerFulfilmentAuditSourceV1 } from "../../src/seller/fulfilmentAuditSource.js";

interface VetRecordFixture {
  agreement: SellerFulfilmentAgreement;
  session: SellerFulfilmentSessionRecord;
  auditSource: SellerFulfilmentAuditSourceV1;
}

/**
 * Sign the buyer's Vet record as the seller, and the seller's own Vet record
 * as `sellerRecordVerifier`, in every place the fulfilment fixtures carry the
 * references: audit-source inventory and invocations, session roster and Agreement.
 */
export function signFulfilmentVetRecords(
  fixture: VetRecordFixture,
  sellerClaim: string,
  sellerRecordVerifier: string,
): void {
  const { vetRecords, vetRequirements } = fixture.auditSource.artifacts;
  const roster = [
    fixture.session.parties.find((party) => party.role === "buyer")!,
    fixture.session.parties.find((party) => party.role === "seller")!,
  ];
  const agreementParties = [fixture.agreement.buyer, fixture.agreement.seller];
  [sellerClaim, sellerRecordVerifier].forEach((signer, index) => {
    vetRecords[index]!.signer = signer;
    vetRequirements[index]!.vetRecordRef = structuredClone(vetRecords[index]!);
    roster[index]!.vetRecordRef = structuredClone(vetRecords[index]!);
    agreementParties[index]!.vetRecordRef = structuredClone(vetRecords[index]!);
  });
  vetRequirements[1]!.verifier = sellerRecordVerifier;
}
