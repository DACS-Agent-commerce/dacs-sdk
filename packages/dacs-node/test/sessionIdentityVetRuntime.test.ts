import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  type FixedPricePayDemTrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsFixedPricePayDemOrderPairV1 } from "../src/liveOrder.js";
import { createDacsLiveSessionIdentityV1 } from "../src/sessionIdentityVetRuntime.js";
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
});
