import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  legacyMvpSessionAnchorName, runSessionCore, type SessionDeps, type SettleRequest, type SettleResult,
} from "../../src/agent/runSessionCore.js";
import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { IdentityBundle } from "../../src/artifacts/types.js";
import { sha256Hex } from "../../src/canonical/index.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { RESTART_JOB_ID, type WorkerOptions } from "./settlementProcess.js";

export async function runRestartSession(input: {
  root: string; id: string; options: WorkerOptions;
  settle: (req: SettleRequest) => Promise<SettleResult>;
  result: SettleResult; stopAt: (name: string) => Promise<void>;
}) {
  // Fixed local signing fixture, matching settleResume.test.ts; no wallet/RPC.
  const seed = Uint8Array.from(Buffer.alloc(32, 5));
  const signer: Signer = (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seed));
  const sellerDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
  const buyerDid = "did:demos:buyer";
  const identity: IdentityBundle = {
    bundleVersion: "1", presentedBy: buyerDid, presentedAt: 1_780_000_000_000,
    claims: [{ ref: buyerDid }],
    presentation: { kind: "per-claim", signatures: [{ ref: buyerDid, signature: "test-presentation" }] },
  };
  // The session negotiates the rail the worker settles on.
  const rail = input.options.mode === "evm" ? "pay-evm-erc20" : "pay-x402";
  const listing = await buildSignedArtifact({
    agentId: sellerDid, serviceId: "svc", name: "n", description: "d", claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: [rail],
    supportedDelivery: ["deliver-attested-payload"],
  }, ARTIFACT_SEPARATORS.Listing, signer);
  const anchors = join(input.root, "anchors");
  await mkdir(anchors, { recursive: true });
  const path = (name: string) => join(anchors, `${sha256Hex(name)}.json`);
  const sessionStore = await createFsSessionStore({ dir: join(input.root, "sessions") });
  const deps: SessionDeps = {
    buyerId: buyerDid, buyerIdentityBundle: identity,
    authenticateBuyerIdentityBundle: () => true,
    readListing: async () => listing,
    sign: (artifact, separator) => buildSignedArtifact(artifact, separator as never, signer),
    signBytes: async (bytes) => signer(bytes),
    resolveAnchor: async (name) => {
      try {
        const value = JSON.parse(await readFile(path(name), "utf8")) as Record<string, unknown>;
        return { status: "present", ref: `stor:${name}`, value };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
        throw error;
      }
    },
    anchor: async (name, value) => {
      if (name === legacyMvpSessionAnchorName.evidence(RESTART_JOB_ID) && input.options.crash === "before-anchor") {
        await input.stopAt(`before-anchor-${input.id}`);
      }
      await writeFile(path(name), JSON.stringify(value));
      return `stor:${name}`;
    },
    settle: async (req) => {
      await appendFile(join(input.root, "session-settle"), `${input.id}\n`);
      return input.settle(req);
    },
    resumeSettlement: async (req) => {
      await appendFile(join(input.root, "session-resume"), `${input.id}\n`);
      return input.settle(req);
    },
    expectedSettlementPayee: input.result.payee,
    // Only the first process mints the job id; a restart that silently took the
    // new-session path instead of resuming must fail rather than reuse it.
    newJobId: () => {
      if (input.id !== "first") throw new Error("resume must not mint a job id");
      return RESTART_JOB_ID;
    },
    now: () => "2026-01-01T00:00:00Z", nowMs: () => 1_780_000_000_000,
    // These tests focus on settlement recovery, as settleResume.test.ts does.
    trustListing: true, authenticateRecoveredArtifact: () => true, sessionStore,
  };
  return runSessionCore("stor:listing", {
    price: { amount: "1000000", asset: "USDC", decimals: 6, rail },
    deliveryPhase: "deliver-attested-payload", deliveryFormat: "application/json",
  }, deps, input.id === "first" ? undefined : RESTART_JOB_ID);
}
