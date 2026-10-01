import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_SEPARATORS,
  type CompositeVerificationRecord,
  type IdentityBundle,
} from "@kynesyslabs/dacs/artifacts";
import { compositeVerificationAddress, type ProtocolAnchorReceipt } from
  "@kynesyslabs/dacs";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  type FixedPricePayDemTrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsFixedPricePayDemOrderPairV1 } from "../src/liveOrder.js";
import {
  authenticateDacsSessionVetProductionV1,
  createDacsLiveSessionIdentityV1,
} from "../src/sessionIdentityVetRuntime.js";
import { authenticateDacsLiveSessionIdentityV1 } from
  "../src/sessionBootstrapTransportRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const roots: string[] = [];
const databases: DacsNodeSqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rail-bound live session identity", () => {
  it("uses the buyer Demos identity directly for native DEM", async () => {
    const buyerKeys = generateKeyPairSync("ed25519");
    const sellerKeys = generateKeyPairSync("ed25519");
    const buyer = demosAgentClaimRef(rawPublicKey(buyerKeys.publicKey));
    const seller = demosAgentClaimRef(rawPublicKey(sellerKeys.publicKey));
    const pair = createDacsFixedPricePayDemOrderPairV1({
      jobId: JOB_ID,
      buyer,
      seller,
      protocol: {
        commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
        standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
        phase: "pay-dem",
        orchestratorTopology: "seller-as-phase-orchestrator-v1",
        orchestrator: seller,
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
      },
    });
    const root = mkdtempSync(join(tmpdir(), "dacs-native-session-identity-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: buyer,
    });
    databases.push(database);
    const store = database.createPayDemCoordinatorStore("buyer");
    await store.create({
      role: "buyer",
      order: pair.buyer,
      bindingHash: pair.bindingHash,
      localBindingHash: pair.buyerLocalBindingHash,
    });
    const loaded = await store.load("buyer", JOB_ID);
    if (loaded.status !== "ok") throw new Error("native order missing");
    const operation = Object.freeze({
      order: loaded.record,
      fence: Object.freeze({
        role: "buyer" as const,
        track: "agreement" as const,
        jobId: JOB_ID,
        bindingHash: pair.bindingHash,
        localBindingHash: pair.buyerLocalBindingHash,
        assertCurrent: vi.fn(async () => undefined),
      }),
    }) as unknown as Readonly<FixedPricePayDemTrackOperationInput>;
    const challenge = "a".repeat(64);
    const identity = await createDacsLiveSessionIdentityV1({
      context: {
        role: "buyer",
        authority: buyer,
        database,
        demos: {
          signComponent: (bytes: Uint8Array) => sign(null, bytes, buyerKeys.privateKey),
        },
      } as never,
      operation,
      challenge,
    });

    expect(identity.claims).toEqual([{ ref: buyer }]);
    expect(identity.presentation).toMatchObject({
      kind: "per-claim",
      signatures: [{ ref: buyer, signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) }],
    });
    await expect(authenticateDacsLiveSessionIdentityV1(
      identity,
      buyer,
      challenge,
      "buyer",
      "pay-dem",
      "demos",
    )).resolves.toBe(true);
    await expect(authenticateDacsLiveSessionIdentityV1(
      identity,
      buyer,
      challenge,
      "buyer",
      "pay-x402",
      "eip155:84532",
    )).resolves.toBe(false);
  });

  it("binds a Vet reference to finalized native readback, not the logical name", async () => {
    const verifierKeys = generateKeyPairSync("ed25519");
    const evaluatedKeys = generateKeyPairSync("ed25519");
    const verifier = demosAgentClaimRef(rawPublicKey(verifierKeys.publicKey));
    const evaluated = demosAgentClaimRef(rawPublicKey(evaluatedKeys.publicKey));
    const evaluatedIdentity: IdentityBundle = {
      bundleVersion: "1",
      presentedBy: evaluated,
      presentedAt: 1_800_000_000_000,
      sessionNonce: "native-vet-reference",
      claims: [{ ref: evaluated }],
      presentation: {
        kind: "session-key",
        key: "native-vet-session-key",
        signature: "native-vet-presentation",
      },
    };
    const requirement = Object.freeze({ requirementVersion: "1" as const, required: [] });
    const unsigned = {
      recordVersion: "1" as const,
      jobId: JOB_ID,
      evaluatedParty: evaluated,
      bundleHash: identityBundleHash(evaluatedIdentity),
      requirementHash: sha256Hex(canonicalize(requirement)),
      freshness: [],
      supplementary: [],
      dealSpecific: [],
      overallDecision: "pass" as const,
      generatedAt: 1_800_000_000_100,
    };
    const record: CompositeVerificationRecord = {
      ...unsigned,
      signature: {
        algorithm: "ed25519",
        signer: verifier,
        value: sign(
          null,
          signedBytes(
            ARTIFACT_SEPARATORS.CompositeVerificationRecord,
            contentHash(unsigned),
          ),
          verifierKeys.privateKey,
        ).toString("base64url"),
      },
    };
    const logicalAddress = compositeVerificationAddress(JOB_ID, evaluated);
    const nativeAddress = `stor-${"4".repeat(64)}`;
    const recordHash = contentHash(record as unknown as Record<string, unknown>);
    const receipt: ProtocolAnchorReceipt = {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress,
      nativeAddress,
      contentHash: recordHash,
      transactionRef: { kind: "demos", value: "5".repeat(64) },
      writer: verifier,
      state: "finalized",
      observationDisposition: "established",
      observedAt: 1_800_000_000_500,
      blockRef: { id: "6".repeat(64), height: "42" },
      evidence: { kind: "demos-bft", value: "7".repeat(64) },
    };
    const context = {
      demos: { adapter: {
        verifyDemosAnchorReceipt: async () => true,
        readAnchor: async (address: string) => address === nativeAddress ? record : null,
      } },
    } as never;
    const exact = {
      record,
      recordRef: {
        anchor: { kind: "storage-program" as const, locator: nativeAddress },
        contentHash: recordHash,
        signer: verifier,
      },
      anchorReceipt: receipt,
    };

    await expect(authenticateDacsSessionVetProductionV1({
      context,
      jobId: JOB_ID,
      evaluatedIdentity,
      requirement,
      verifier,
      production: exact,
    })).resolves.toBe("valid");
    await expect(authenticateDacsSessionVetProductionV1({
      context,
      jobId: JOB_ID,
      evaluatedIdentity,
      requirement,
      verifier,
      production: {
        ...exact,
        recordRef: {
          ...exact.recordRef,
          anchor: { kind: "storage-program", locator: logicalAddress },
        },
      },
    })).resolves.toBe("invalid");
  });
});
