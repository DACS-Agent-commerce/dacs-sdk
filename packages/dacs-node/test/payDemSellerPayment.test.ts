import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IdentityBundle, Listing, PaymentRailRef } from
  "@kynesyslabs/dacs/artifacts";
import { isListing } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from
  "@kynesyslabs/dacs/canonical";
import {
  createFixedPricePayDemSellerCoordinator,
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemProtocolBinding,
  type FixedPricePayDemTrackOperation,
} from "@kynesyslabs/dacs/commerce";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import {
  createFsSellerReceiptStore,
  type SellerListingAtCommitResolution,
  type SellerReceiptStore,
} from "@kynesyslabs/dacs/seller";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { createDacsPayDemPaymentNoticeV1 } from "../src/payDemPayment.js";
import type { DacsRetainedPayDemPaymentNoticeV1 } from
  "../src/payDemPaymentNoticeRuntime.js";
import {
  createDacsPayDemSellerPaymentTrackV1,
  loadDacsPayDemSellerPaymentAuthorizationForOrderV1,
  loadDacsPayDemSellerPaymentResultForOrderV1,
} from
  "../src/payDemSellerPayment.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"aa".repeat(32)}`;
const SELLER = `did:demos:agent:${"bb".repeat(32)}`;
const PAYER = "aa".repeat(32);
const PAYEE = "bb".repeat(32);
const TX_HASH = "ab".repeat(32);
const PAYMENT_PHASE_INDEX = 2;
const AGREEMENT_SIGNATURE = Buffer.alloc(64, 7).toString("base64url");

const PROTOCOL: FixedPricePayDemProtocolBinding = {
  commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  phase: "pay-dem",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
    railDefinitionHash: "2".repeat(64),
    railId: "demos-native:DEM",
    railVersion: 1,
    railType: "demos-native",
    phaseHandler: "pay-dem",
    network: "demos",
    availability: "live",
  },
};

const ORDER: FixedPricePayDemOrderInput = {
  jobId: JOB_ID,
  buyer: BUYER,
  seller: SELLER,
  protocol: PROTOCOL,
  sdkJobs: {
    role: "seller",
    agreement: `seller:agreement:${JOB_ID}`,
    payment: `seller:payment:${JOB_ID}`,
    paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
    fulfilment: `seller:delivery:${JOB_ID}`,
    deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
    audit: `seller:audit:${JOB_ID}`,
  },
};

function identity(primary: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primary,
    presentedAt: 100,
    claims: [{ ref: primary }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primary, signature: "c2ln" }],
    },
  };
}

function fixture(receiptStore: SellerReceiptStore) {
  const buyerBundle = identity(BUYER);
  const sellerBundle = identity(SELLER);
  const railRef: PaymentRailRef = {
    railId: PROTOCOL.rail.railId,
    railVersion: PROTOCOL.rail.railVersion,
  };
  const listing: Listing = {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: "native-dem-seller-runtime",
    seller: {
      identity: sellerBundle,
      displayName: "Native seller",
      publicEndpoint: "https://seller.example/engage",
    },
    offering: {
      title: "Native deliverable",
      description: "One authenticated native payment",
      category: "software",
      tags: ["test"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: railRef.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "fixed",
      price: { amount: "1.25", currency: "DEM" },
    },
    acceptedRails: [railRef],
    terms: { deadlineSecAfterCommit: 9 },
    validity: { notBefore: 0, notAfter: 20_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
  if (!isListing(listing)) throw new Error("native Listing fixture is invalid");
  const listingRef = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  const deliverable = listing.offering.deliverable;
  if (deliverable.kind !== "attested-payload" || !deliverable.verificationMethod) {
    throw new Error("native Listing fixture requires DPA");
  }
  const listingAtCommit: SellerListingAtCommitResolution = {
    rawListing: listing as unknown as Record<string, unknown>,
    validation: {
      disposition: "verified",
      step: 9,
      reason: "verified",
      listing,
      listingContentHash: listingRef.contentHash,
      revocation: "absent",
      railResolution: { disposition: "verified", reason: "verified" },
      payloadVerificationCapability: {
        operation: "verify",
        disposition: "supported",
        reason: "supported",
        verificationMethodKind: deliverable.verificationMethod.kind,
        verificationMethodHash: sha256Hex(canonicalize(deliverable.verificationMethod)),
        deliverableSpecHash: sha256Hex(canonicalize(deliverable)),
      },
    },
    payloadVerificationProducerAdmission: {
      operation: "produce",
      disposition: "supported",
      listingRef,
      verificationMethodKind: deliverable.verificationMethod.kind,
      verificationMethodHash: sha256Hex(canonicalize(deliverable.verificationMethod)),
      deliverableSpecHash: sha256Hex(canonicalize(deliverable)),
      admittedAt: 900,
    },
  };
  const agreement: Record<string, unknown> = {
    payeeBoundAgreementVersion: "1",
    jobId: JOB_ID,
    listingRef,
    parties: [
      {
        role: "buyer",
        bundleHash: identityBundleHash(buyerBundle),
        primaryClaim: BUYER,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "buyer-vet" },
          contentHash: "3".repeat(64),
        },
      },
      {
        role: "seller",
        bundleHash: identityBundleHash(sellerBundle),
        primaryClaim: SELLER,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "seller-vet" },
          contentHash: "4".repeat(64),
        },
      },
    ],
    terms: {
      deliverable: {
        deliverableType: deliverable.kind,
        hash: sha256Hex(canonicalize(deliverable)),
      },
      price: { amount: "1.25", currency: "DEM" },
      rail: railRef,
      deadline: 10_000,
      payoutBindings: [{
        railId: railRef.railId,
        phaseIndex: PAYMENT_PHASE_INDEX,
        payeeAddress: PAYEE,
      }],
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 500,
    signatures: [
      { party: BUYER, algorithm: "ed25519", value: AGREEMENT_SIGNATURE },
      { party: SELLER, algorithm: "ed25519", value: AGREEMENT_SIGNATURE },
    ],
  };
  const agreementHash = contentHash(agreement);
  return {
    agreementHash,
    intakeDeps: {
      resolveCommittedAgreement: async () => ({
        disposition: "verified" as const,
        agreement,
        agreementHash,
        commitment: {
          finality: "finalized" as const,
          ref: `dacs3:commit:${JOB_ID}`,
          contentHash: "5".repeat(64),
          jobId: JOB_ID,
          agreementHash,
          listingRef,
          committedAt: 1_000,
          signer: SELLER,
        },
        railRegistryVersion: 7,
      }),
      resolveListingAtCommit: async () => listingAtCommit,
      resolveRail: async ({ railRegistryVersion }: { railRegistryVersion: number }) => ({
        disposition: "verified" as const,
        rail: {
          railVersion: 1,
          railId: railRef.railId,
          railType: "demos-native" as const,
          asset: {
            kind: "native-dem" as const,
            symbol: "DEM" as const,
            decimals: 9 as const,
          },
          network: { kind: "demos" as const },
          phaseHandler: "pay-dem" as const,
          parameters: {},
          availability: "live" as const,
        },
        railRegistryVersion,
      }),
      resolveIdentityBundle: async (hash: string) => ({
        disposition: "verified" as const,
        bundle: hash === identityBundleHash(buyerBundle) ? buyerBundle : sellerBundle,
      }),
      observeDemosTransfer: async () => ({
        status: "included" as const,
        txHash: TX_HASH,
        payer: PAYER,
        payee: PAYEE,
        amountOs: "1250000000",
        blockNumber: 88,
        includedAt: 5_000,
      }),
      receiptStore,
    },
  };
}

function success(): FixedPricePayDemTrackOperation {
  return async ({ fence }) => {
    await fence.assertCurrent();
    return { status: "final", outcome: "success", reference: fence.track };
  };
}

describe("native DEM seller payment track", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function open(path: string): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase({
      databasePath: path,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      authority: SELLER,
    });
    databases.push(database);
    return database;
  }

  it("recovers a committed permit after receipt acknowledgement is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-pay-dem-seller-"));
    roots.push(root);
    const databasePath = join(root, "seller.sqlite");
    const receiptPath = join(root, "receipts");
    const durableReceipts = await createFsSellerReceiptStore({ dir: receiptPath });
    let loseFirstAcknowledgement = true;
    const ambiguousReceipts: SellerReceiptStore = {
      async claim(claim) {
        const retained = await durableReceipts.claim(claim);
        if (loseFirstAcknowledgement) {
          loseFirstAcknowledgement = false;
          throw new Error("receipt acknowledgement lost");
        }
        return retained;
      },
      consumePermit: (permitId, handoff) =>
        durableReceipts.consumePermit(permitId, handoff),
      inspectPermit: (permitId) => durableReceipts.inspectPermit(permitId),
    };
    const first = await open(databasePath);
    putDacsLiveOrderInputV1({ database: first, order: ORDER, application: {} });
    const firstFixture = fixture(ambiguousReceipts);
    const store = first.createPayDemCoordinatorStore("seller");
    const created = await createFixedPricePayDemSellerCoordinator({
      store,
      workerId: "seller-coordinator-before-restart",
      operations: { agreement: success() },
    }).startOrder(ORDER);
    const loaded = await store.load("seller", JOB_ID);
    if (loaded.status !== "ok") throw new Error("seller order missing");
    const notice = createDacsPayDemPaymentNoticeV1({
      authorityVersion: "1",
      jobId: JOB_ID,
      phaseIndex: PAYMENT_PHASE_INDEX,
      railId: PROTOCOL.rail.railId,
      railVersion: PROTOCOL.rail.railVersion,
      railDescriptorHash: PROTOCOL.rail.railDefinitionHash,
      network: "demos",
      payer: PAYER,
      payee: PAYEE,
      amountOs: "1250000000",
      maxTotalDebitOs: "1300000000",
      agreementHash: firstFixture.agreementHash,
      termsHash: "6".repeat(64),
      payoutBindingHash: "7".repeat(64),
      paymentInputVersion: "1",
      orderBindingHash: loaded.record.bindingHash,
      orderLocalBindingHash: loaded.record.localBindingHash,
      settlementKey: `demos-native:DEM:${JOB_ID}:${PAYMENT_PHASE_INDEX}`,
    }, {
      ok: true,
      txHash: TX_HASH,
      chainId: "demos",
      payer: PAYER,
      payee: PAYEE,
      finality: { model: "bft-final" },
      blockNumber: 88,
      txRefKind: "demos",
    });
    const retainedNotice: DacsRetainedPayDemPaymentNoticeV1 = {
      bindingVersion: "1",
      noticeHash: sha256Hex(canonicalize(notice)),
      notice,
      transportAuthentication: {
        envelopeId: "8".repeat(64),
        authenticationHash: "9".repeat(64),
        identityEvidenceHash: "a".repeat(64),
        sender: BUYER,
        audience: SELLER,
        payloadHash: sha256Hex(canonicalize(notice)),
      },
    };
    const firstPayment = createDacsPayDemSellerPaymentTrackV1({
      database: first,
      workerId: "seller-payment-before-restart",
      noticeRuntime: { load: () => retainedNotice },
      resolvePayerPayingKey: () => BUYER,
      intakeDeps: firstFixture.intakeDeps,
      retryDelayMs: 1,
    });
    const beforeRestart = createFixedPricePayDemSellerCoordinator({
      store,
      workerId: "seller-coordinator-payment-before-restart",
      operations: { agreement: success(), payment: firstPayment },
    });
    await beforeRestart.resumePendingOrders({ limit: 2 });
    const beforeStatus = (await beforeRestart.getOrderStatus(JOB_ID))?.tracks.payment;
    expect(beforeStatus).toMatchObject({
      state: "indeterminate",
      reasonCode: "pay-dem-receipt-store-unavailable",
    });
    expect(created.jobId).toBe(JOB_ID);
    first.close();
    databases.splice(databases.indexOf(first), 1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const restarted = await open(databasePath);
    const restartedFixture = fixture(durableReceipts);
    const resumedPayment = createDacsPayDemSellerPaymentTrackV1({
      database: restarted,
      workerId: "seller-payment-after-restart",
      noticeRuntime: { load: () => retainedNotice },
      resolvePayerPayingKey: () => BUYER,
      intakeDeps: restartedFixture.intakeDeps,
      retryDelayMs: 1,
    });
    const resumed = createFixedPricePayDemSellerCoordinator({
      store: restarted.createPayDemCoordinatorStore("seller"),
      workerId: "seller-coordinator-after-restart",
      operations: { payment: resumedPayment },
    });
    await resumed.resumePendingOrders({ limit: 1 });

    expect((await resumed.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "final", outcome: "success" });
    const resumedOrder = await restarted.createPayDemCoordinatorStore("seller")
      .load("seller", JOB_ID);
    if (resumedOrder.status !== "ok") throw new Error("resumed order missing");
    const result = loadDacsPayDemSellerPaymentResultForOrderV1({
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: restarted,
    }, resumedOrder.record);
    expect(result).toMatchObject({
      jobId: JOB_ID,
      railId: PROTOCOL.rail.railId,
      txHash: TX_HASH,
      blockNumber: 88,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      permitId: expect.any(String),
    });
    const recovered = await loadDacsPayDemSellerPaymentAuthorizationForOrderV1({
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: restarted,
      commerceStores: {
        role: "seller",
        sellerReceipts: durableReceipts,
      },
    } as never, resumedOrder.record);
    expect(recovered.result).toEqual(result);
    expect(recovered.authorization).toMatchObject({
      jobId: JOB_ID,
      phaseIndex: PAYMENT_PHASE_INDEX,
      railId: PROTOCOL.rail.railId,
      settlementIdentity: {
        kind: "demos",
        txHash: TX_HASH,
        blockNumber: 88,
      },
      evidenceInput: {
        phase: "pay-dem",
        paymentAmount: { amount: "1.25", currency: "DEM" },
      },
    });
  });
});
