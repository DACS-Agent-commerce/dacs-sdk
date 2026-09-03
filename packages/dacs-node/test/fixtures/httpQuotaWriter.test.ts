import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { test } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../../src/config.js";
import { openDacsNodeSqliteDatabase } from "../../src/sqlite.js";
import { DACS_HTTP_MINIMUM_RETENTION_MS } from "../../src/transport/contracts.js";
import {
  authenticateDacsHttpEnvelopeV1,
  createDacsHttpEnvelopeV1,
} from "../../src/transport/envelope.js";

const databasePath = process.env["DACS_HTTP_QUOTA_DATABASE"];
const readyPath = process.env["DACS_HTTP_QUOTA_READY"];
const goPath = process.env["DACS_HTTP_QUOTA_GO"];
const resultPath = process.env["DACS_HTTP_QUOTA_RESULT"];
const nonceByte = Number(process.env["DACS_HTTP_QUOTA_NONCE"]);
const label = process.env["DACS_HTTP_QUOTA_LABEL"];
const configured = databasePath !== undefined && readyPath !== undefined &&
  goPath !== undefined && resultPath !== undefined && label !== undefined &&
  Number.isSafeInteger(nonceByte) && nonceByte >= 0 && nonceByte <= 255;

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BUYER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SELLER_SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const BUYER_KEY = privateKeyFromSeed(BUYER_SEED);
const BUYER_PUBLIC = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER_PUBLIC = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const BUYER = `did:demos:agent:${Buffer.from(BUYER_PUBLIC).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(SELLER_PUBLIC).toString("hex")}`;

test.skipIf(!configured)("contends for one HTTP quota slot", async () => {
  const database = await openDacsNodeSqliteDatabase({
    databasePath: databasePath!,
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role: "seller",
    authority: SELLER,
  });
  try {
    const store = database.createHttpInboxStore();
    const now = await store.readTime();
    const signed = await createDacsHttpEnvelopeV1({
      type: "agreement-proposal",
      jobId: JOB_ID,
      sender: BUYER,
      audience: SELLER,
      issuedAt: now - 1_000,
      expiresAt: now + 299_000,
      nonce: Buffer.alloc(32, nonceByte).toString("base64url"),
      payload: {
        proposal: { jobId: JOB_ID, label },
        transportIdentity: { sender: BUYER, audience: SELLER },
      } as never,
    }, (bytes) => ed25519Sign(bytes, BUYER_KEY));
    const authenticated = await authenticateDacsHttpEnvelopeV1(signed, {
      storeTime: now,
      expectedAudience: SELLER,
      resolveIdentity: async () => ({
        status: "authenticated",
        principal: BUYER,
        jobId: JOB_ID,
        role: "buyer",
        publicKey: BUYER_PUBLIC,
        evidenceHash: "a".repeat(64),
      }),
      validatePayload: async () => ({ status: "valid" }),
    });
    if (authenticated.status !== "authenticated") throw new Error(authenticated.reasonCode);
    await writeFile(readyPath!, "ready", { encoding: "utf8", flag: "wx" });
    while (!existsSync(goPath!)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let result: Record<string, unknown>;
    try {
      const reserved = await store.reserve({
        authenticated,
        retainUntil: now + DACS_HTTP_MINIMUM_RETENTION_MS + 10_000,
      });
      result = { status: "fulfilled", result: reserved.status };
    } catch (error) {
      result = {
        status: "rejected",
        reasonCode: error !== null && typeof error === "object" && "reasonCode" in error
          ? (error as { reasonCode: unknown }).reasonCode
          : "unknown",
      };
    }
    await writeFile(resultPath!, JSON.stringify(result), { encoding: "utf8", flag: "wx" });
  } finally {
    database.close();
  }
}, 20_000);
