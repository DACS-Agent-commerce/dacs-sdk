import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
  evaluateClaimRequirementQualification,
  evaluateRailAvailabilitySelection,
  verifyEvidenceBoundFaultBundle,
  evaluateEvidenceBoundSettlementSet,
  verifyFaultBundleExtendedPointer,
  buildEvidenceBoundTwoSidedBundle,
  type EvidenceBoundBundleAuthority,
  type EvidenceBoundBundleVerifierDeps,
  type ClaimQualificationDeps,
  type ClaimQualificationInput,
  type RailAvailabilityAuthority,
  type SubstrateAdapter,
  verifyBundleCore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;
const qualify: typeof evaluateClaimRequirementQualification =
  evaluateClaimRequirementQualification;
const selectRail: typeof evaluateRailAvailabilitySelection =
  evaluateRailAvailabilitySelection;
const verifyEvidenceBound: typeof verifyEvidenceBoundFaultBundle =
  verifyEvidenceBoundFaultBundle;
const evaluateExactSet: typeof evaluateEvidenceBoundSettlementSet =
  evaluateEvidenceBoundSettlementSet;
const verifyBundlePointer: typeof verifyFaultBundleExtendedPointer =
  verifyFaultBundleExtendedPointer;
const buildEvidenceBound: typeof buildEvidenceBoundTwoSidedBundle =
  buildEvidenceBoundTwoSidedBundle;

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const qualificationInput: ClaimQualificationInput;
declare const qualificationDeps: ClaimQualificationDeps;
declare const railAuthority: RailAvailabilityAuthority;
declare const ebfabAuthority: EvidenceBoundBundleAuthority;
declare const ebfabDeps: EvidenceBoundBundleVerifierDeps;

void config;
void verifier;
void canonical;
void fulfilment;
void qualify(qualificationInput, qualificationDeps);
void selectRail({}, railAuthority);
void verifyEvidenceBound(ebfabAuthority, ebfabDeps);
void evaluateExactSet;
void verifyBundlePointer;
void buildEvidenceBound;
void adapter;
void journal;
void result;
