import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBuyerRatingRecord,
  publishRatingRecordDurably,
  type RatingPublicationEffectStore,
} from "@kynesyslabs/dacs";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import type { BoundArtifactRepository } from "../../../src/discovery/index.js";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  createSqliteRatingPublicationEffectStore,
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 51));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 52));
const BUYER_PRIVATE = privateKeyFromSeed(BUYER_SEED);
const BUYER_OWNER = Buffer.from(rawPublicKey(publicKeyFromSeed(BUYER_SEED)))
  .toString("hex");
const BUYER = `did:demos:agent:${BUYER_OWNER}`;
const SELLER = `did:demos:agent:${Buffer.from(
  rawPublicKey(publicKeyFromSeed(SELLER_SEED)),
).toString("hex")}`;

describe("SQLite-backed durable RatingRecord publication", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function open(databasePath: string): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase({
      databasePath,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    return database;
  }

  it("recovers the exact signed record after closing and reopening SQLite", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-rating-sqlite-"));
    roots.push(root);
    const databasePath = join(root, "buyer.sqlite");
    const record = await createBuyerRatingRecord(
      {
        jobId: JOB_ID,
        buyer: BUYER,
        seller: SELLER,
        value: 5,
        ratedAt: 1_780_358_520_000,
      },
      {
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, BUYER_PRIVATE),
      },
    );
    let physicalWrites = 0;
    let loseResponse = true;
    const nativeAddress = "stor-sqlite-rating";
    const binding = {
      logicalAddress: `dacs5:rating:${JOB_ID}:did%3Ademos%3Aagent%3A${BUYER_OWNER}`,
      nativeAddress,
      owner: BUYER_OWNER,
      contentHash: contentHash(record as unknown as Record<string, unknown>),
    };
    const repository: BoundArtifactRepository = {
      async write(logicalAddress, artifact) {
        expect(logicalAddress).toBe(binding.logicalAddress);
        expect(artifact).toEqual(record);
        if (physicalWrites === 0) physicalWrites += 1;
        const publication = {
          status: physicalWrites === 1 && loseResponse
            ? "published" as const
            : "already-published" as const,
          anchor: {
            address: nativeAddress,
            txRef: "tx-sqlite-rating",
            completion: "read-visible" as const,
          },
          binding,
          storageName: "dacs5%3Arating%3Asqlite",
        };
        if (loseResponse) {
          loseResponse = false;
          throw new Error("simulated process loss after exact publication");
        }
        return publication;
      },
      async read(logicalAddress, expectedOwner, verifySignature) {
        if (
          logicalAddress !== binding.logicalAddress ||
          expectedOwner !== BUYER_OWNER ||
          !verifySignature ||
          !(await verifySignature(
            record as unknown as Record<string, unknown>,
            binding,
          ))
        ) {
          return {
            status: "signature-invalid",
            nativeAddress,
            record: record as unknown as Record<string, unknown>,
          };
        }
        return {
          status: "verified",
          nativeAddress,
          record: record as unknown as Record<string, unknown>,
        };
      },
    };
    const input = { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER };
    const dependencies = (effectStore: RatingPublicationEffectStore) => ({
      effectStore,
      workerId: "sqlite-rating-worker",
      leaseDurationMs: 30_000,
      repository,
      authenticateRatingRecord: async () => ({ disposition: "valid" as const }),
      authenticateAnchor: async () => ({ disposition: "valid" as const }),
    });

    const firstDatabase = await open(databasePath);
    const firstStore = createSqliteRatingPublicationEffectStore(firstDatabase);
    const first = await publishRatingRecordDurably(input, dependencies(firstStore));
    expect(first).toMatchObject({
      disposition: "indeterminate",
      stage: "anchor-and-binding",
    });
    firstDatabase.close();
    databases.splice(databases.indexOf(firstDatabase), 1);

    const recoveredDatabase = await open(databasePath);
    const recoveredStore = createSqliteRatingPublicationEffectStore(recoveredDatabase);
    const recovered = await publishRatingRecordDurably(
      input,
      dependencies(recoveredStore),
    );
    expect(recovered).toMatchObject({
      disposition: "published",
      recovered: true,
      result: { nativeAddress, record },
    });
    expect(physicalWrites).toBe(1);
    expect(recoveredDatabase.loadEffect(
      "artifact-publication",
      binding.logicalAddress,
    )).toMatchObject({ state: "completed", attempts: 2 });
  });
});
