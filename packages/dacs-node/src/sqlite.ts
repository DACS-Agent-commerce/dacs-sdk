import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statfsSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  preparePrivateStoreDirectory,
  sameCanonicalClaimIdentity,
  VERSION,
} from "@kynesyslabs/dacs";
import {
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceOfflineOrderBindingHash,
  fixedPriceOfflineOrderLocalBindingHash,
  fixedPriceOfflineOrderViolation,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  fixedPriceX402OrderViolation,
  isPaymentEvidenceAnchorCompletion,
  isPaymentEvidenceAnchorRequest,
  PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION,
  paymentEvidenceHandshakeScopeHash,
  paymentEvidenceHandshakeViolation,
  type FixedPriceOfflineCoordinatorStore,
  type FixedPriceOfflineOrderRecord,
  type FixedPriceOfflineSimulationErrorClass,
  type FixedPriceOfflineSimulationOutcome,
  type FixedPriceOfflineTrackOperationResult,
  type FixedPriceOfflineTrackRecord,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402CoordinatorStore,
  type FixedPriceX402ErrorClass,
  type FixedPriceX402FaultedParty,
  type FixedPriceX402NormativeOutcome,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402Track,
  type FixedPriceX402TrackLease,
  type FixedPriceX402TrackOperationResult,
  type FixedPriceX402TrackRecord,
  type PaymentEvidenceAnchorCompletion,
  type PaymentEvidenceAnchorRequest,
  type PaymentEvidenceBuyerWork,
  type PaymentEvidenceHandshakeLease,
  type PaymentEvidenceHandshakeLoad,
  type PaymentEvidenceHandshakeRecord,
  type PaymentEvidenceHandshakeRole,
  type PaymentEvidenceHandshakeStore,
  type PaymentEvidenceHandshakeWrite,
  type PaymentEvidenceOutboundCompletionClaim,
  type PaymentEvidenceOutboundRequestClaim,
  type PaymentEvidenceOutbox,
  type PaymentEvidencePage,
} from "@kynesyslabs/dacs/commerce";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";
import BetterSqlite3 from "better-sqlite3";

import {
  DACS_NODE_LIVE_PROFILE,
  DACS_NODE_OFFLINE_PROFILE,
} from "./config.js";
import type {
  DacsHttpInboxStoreV1,
  DacsHttpOutboxStoreV1,
  DacsHttpTransportStoreOptionsV1,
} from "./transport/contracts.js";
import {
  createDacsHttpInboxSqliteStore,
  createDacsHttpOutboxSqliteStore,
  migrateDacsHttpSqliteV7Rows,
  verifyDacsHttpSqliteRows,
  type DacsHttpSqliteContext,
} from "./sqliteTransport.js";

export { createSqliteRatingPublicationEffectStore } from "./sqliteRatingPublication.js";

export const DACS_NODE_SQLITE_SCHEMA_VERSION = 7 as const;
