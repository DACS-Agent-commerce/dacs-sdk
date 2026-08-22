import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProtocolAnchorReceipt } from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402EffectFence,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsDemosPublicationTrackV1,
  type DacsDemosActorRuntimeV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const BINDING_HASH = "a".repeat(64);
const LOCAL_BINDING_HASH = "b".repeat(64);
const LOGICAL_ADDRESS = `dacs4:payment-evidence:${JOB_ID}`;
const ARTIFACT = Object.freeze({ schema: "test-payment-evidence/v1", jobId: JOB_ID });
const CONTENT_HASH = sha256Hex(canonicalize(ARTIFACT));

function receipt(): ProtocolAnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-confirmed-native-read",
    logicalAddress: LOGICAL_ADDRESS,
    nativeAddress: "stor-test-payment-evidence",
    contentHash: CONTENT_HASH,
    transactionRef: { kind: "demos-storage-program", value: "tx-test-payment" },
    writer: BUYER,
    nonce: "7",
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_780_000_000_000,
    blockRef: {
      id: "block-test-payment",
      height: "42",
      timestamp: 1_780_000_000_000,
    },
    evidence: { kind: "demos-bft-write-proof-v1", value: "test-proof" },
  };
}

function order(): FixedPriceX402OrderRecord {
  return {
    storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    revision: 0,
    role: "buyer",
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: {
      commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      phase: "pay-x402",
      orchestratorTopology: "seller-as-phase-orchestrator-v1",
      orchestrator: SELLER,
      rail: {
        registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
        registryIndexHash: "1".repeat(64),
        railDefinitionRef: "dacs4:rail:x402%3Adefault:1",
        railDefinitionHash: "c".repeat(64),
        railId: "x402:default",
        railVersion: 1,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:84532",
        availability: "live",
      },
    },
    bindingHash: BINDING_HASH,
    localBindingHash: LOCAL_BINDING_HASH,
    sdkJobs: {
      role: "buyer",
      agreement: `buyer:agreement:${JOB_ID}`,
      payment: `buyer:payment:${JOB_ID}`,
      paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
      buyerReceived: `buyer:received:${JOB_ID}`,
      audit: `buyer:audit:${JOB_ID}`,
    },
    tracks: {},
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_000_000,
  };
}

function operationInput(): FixedPriceX402TrackOperationInput {
  const fence: FixedPriceX402EffectFence = {
    role: "buyer",
    jobId: JOB_ID,
    bindingHash: BINDING_HASH,
    localBindingHash: LOCAL_BINDING_HASH,
    track: "payment-evidence",
    owner: "coordinator-worker",
    generation: 1,
    idempotencyKey: "dacs-fixed-price-x402:v1:buyer:payment-evidence:test",
    assertCurrent: async () => undefined,
  };
  return { order: order(), fence };
}

describe("Demos immutable publication coordinator track", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  async function database() {
    const directory = mkdtempSync(join(tmpdir(), "dacs-demos-publication-"));
    roots.push(directory);
    const opened = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(opened);
    return opened;
  }

  function runtime(anchorWriteOnce: DacsDemosActorRuntimeV1["adapter"]["anchorWriteOnce"]):
    Readonly<DacsDemosActorRuntimeV1> {
    return {
      role: "buyer",
      authority: BUYER,
      walletAddress: "0xbuyer",
      publicKey: Uint8Array.from({ length: 32 }, () => 0x11),
      adapter: {
        raw: {
          getNetworkInfo: async () => ({}),
          getAddressNonce: async () => 0,
          getAddressInfo: async () => ({}),
        },
        connect: async () => undefined,
        getAddress: () => "0xbuyer",
        getPublicKey: async () => Uint8Array.from({ length: 32 }, () => 0x11),
        sign: async () => new Uint8Array(64),
        resolveIdentity: async (ref) => ({ ref, raw: {} }),
        readAnchor: async () => ARTIFACT,
        resolveAnchorByName: async () => ({
          status: "present" as const,
          address: "stor-test-payment-evidence",
        }),
        scanOwnAnchorsByNamePrefix: async () => ({ status: "ok" as const, anchors: [] }),
        anchorWriteOnce,
        verifyDemosAnchorReceipt: vi.fn(async () => true),
        resolveDemosAnchorReceipt: vi.fn(async () => receipt()),
      },
      signTransportEnvelope: async () => new Uint8Array(64),
      signComponent: async () => new Uint8Array(64),
      networkInfo: async () => ({}),
      addressNonce: async () => 0,
      addressInfo: async () => ({}),
    };
  }

  afterEach(() => {
    for (const opened of databases.splice(0).reverse()) opened.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("publishes once and replays the authenticated outer SQLite result", async () => {
    const opened = await database();
    const anchorWriteOnce = vi.fn(async (
      _logicalAddress: string,
      _artifact: Readonly<Record<string, unknown>>,
      _options?: Readonly<{ metadata?: Readonly<Record<string, string>> }>,
    ) => ({
      address: "stor-test-payment-evidence",
      txRef: "tx-test-payment",
    }));
    const track = createDacsDemosPublicationTrackV1({
      database: opened,
      runtime: runtime(anchorWriteOnce),
      role: "buyer",
      track: "payment-evidence",
      workerId: "buyer-publication-worker",
      buildPublication: async () => ({
        logicalAddress: LOGICAL_ADDRESS,
        artifact: ARTIFACT,
      }),
      authorizePublication: async ({ contentHash }) => contentHash === CONTENT_HASH,
      retryDelayMs: 1,
    });

    await expect(track(operationInput())).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      reference: LOGICAL_ADDRESS,
    });
    await expect(track(operationInput())).resolves.toMatchObject({ status: "final" });
    expect(anchorWriteOnce).toHaveBeenCalledTimes(1);
    expect(anchorWriteOnce.mock.calls[0]?.[2]).toEqual({ metadata: {
      logicalAddress: LOGICAL_ADDRESS,
      contentHash: CONTENT_HASH,
      envelopeHash: sha256Hex(canonicalize(ARTIFACT)),
    } });
  });

  it("recovers an ambiguous process result through the same journalled write identity", async () => {
    const opened = await database();
    let observableWrites = 0;
    let retained = false;
    const anchorWriteOnce = vi.fn(async () => {
      if (!retained) {
        retained = true;
        observableWrites += 1;
        throw new Error("process lost the completed return value");
      }
      return {
        address: "stor-test-payment-evidence",
        txRef: "tx-test-payment",
      };
    });
    const track = createDacsDemosPublicationTrackV1({
      database: opened,
      runtime: runtime(anchorWriteOnce),
      role: "buyer",
      track: "payment-evidence",
      workerId: "buyer-publication-worker",
      buildPublication: () => ({ logicalAddress: LOGICAL_ADDRESS, artifact: ARTIFACT }),
      authorizePublication: () => true,
      retryDelayMs: 1,
    });

    await expect(track(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
      reasonCode: "demos-publication-reconciliation-required",
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await expect(track(operationInput())).resolves.toMatchObject({
      status: "final",
      reference: LOGICAL_ADDRESS,
    });
    expect(anchorWriteOnce).toHaveBeenCalledTimes(2);
    expect(observableWrites).toBe(1);
  });
});
