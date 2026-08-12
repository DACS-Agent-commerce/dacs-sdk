import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Signer } from "../../src/agent/signedArtifact.js";
import { verifyBundleCore, type VerifyBundleDeps } from "../../src/agent/verifyBundleCore.js";
import { attestationBundleHash, buildTwoSidedBundle } from "../../src/agent/twoSidedBundle.js";
import type {
  AttestationRef,
  CompositeVerificationRecord,
  IdentityBundle,
  ListingDraft,
  PaymentRailRef,
} from "../../src/artifacts/types.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import { contentHash, sha256Hex, stripSignature } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import { identityBundleHash } from "../../src/identity/bundle.js";
import {
  deriveFixedPriceAgreement,
  signFixedPriceAgreement,
} from "../../src/negotiate/fixedPrice.js";
import { x402SettleCore, type X402ClientLike } from "../../src/rails/x402.js";

const RUN = process.env.DACS_LOCAL_CHAIN_E2E === "1";
const PROOF_OUTDIR = process.env.DACS_LOCAL_CHAIN_E2E_OUTDIR?.trim();
const CHAIN_ID = 31337;
const NETWORK = `eip155:${CHAIN_ID}`;
const AMOUNT = "1000000";
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER_EVM_KEY = `0x${"1".padStart(64, "0")}` as const;
const SELLER_EVM_KEY = `0x${"2".padStart(64, "0")}` as const;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Minimal ERC20-shaped test token. `transfer(address,uint256)` emits the
// standard Transfer(from,to,amount) log and returns true. It is intentionally
// tiny; the e2e asserts the emitted log, not merely receipt success.
const TEST_TOKEN_BYTECODE =
  "0x603a600c600039603a6000f3602435600052600435337fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef60206000a3600160005260206000f3" as const;
const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 21));
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 23));

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}

function didFor(seed: Uint8Array): string {
  return `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
}

function identityFor(primaryClaim: string, presentedAt: number): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "local-identity-proof" }],
    },
  };
}

function publicKeyHex(seed: Uint8Array): string {
  return Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
}

function resolveFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

async function writeProofArtifact(name: string, value: unknown): Promise<void> {
  if (!PROOF_OUTDIR) return;
  await mkdir(PROOF_OUTDIR, { recursive: true });
  await writeFile(`${PROOF_OUTDIR}/${name}`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function memStore() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    anchor: async (name: string, value: object) => {
      const address = `stor:${name}`;
      store.set(address, value as Record<string, unknown>);
      return address;
    },
    read: async (ref: string) => store.get(ref) ?? null,
  };
}

function refTo(kind: string, id: string, value: Record<string, unknown>): AttestationRef {
  void kind;
  return {
    anchor: { kind: "storage-program", locator: id },
    contentHash: contentHash(stripSignature(value)),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function addressTopic(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function uint256Data(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

async function waitForRpc(url: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // retry until ganache is listening
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Ganache did not start at ${url}`);
}

async function startGanache(): Promise<{
  rpcUrl: string;
  child: ChildProcess;
}> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    "node_modules/.bin/ganache",
    [
      "--server.host",
      "127.0.0.1",
      "--server.port",
      String(port),
      "--chain.chainId",
      String(CHAIN_ID),
      "--wallet.accounts",
      `${BUYER_EVM_KEY},100000000000000000000`,
      "--wallet.accounts",
      `${SELLER_EVM_KEY},100000000000000000000`,
      "--logging.quiet",
      "true",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("exit", (code) => {
    if (code !== null && code !== 0 && stderr.trim()) {
      process.stderr.write(stderr);
    }
  });
  try {
    await waitForRpc(rpcUrl);
  } catch (err) {
    await stopProcess(child);
    throw err;
  }
  return { rpcUrl, child };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/deliver`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

function x402Client(): X402ClientLike {
  return {
    getPaymentRequiredResponse: (_getHeader, body) => body as { accepts: never[] },
    createPaymentPayload: async (paymentRequired) => paymentRequired,
    encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "signed-local-payment" }),
    getPaymentSettleResponse: (getHeader) => {
      const raw = getHeader("X-PAYMENT-RESPONSE");
      return raw
        ? (JSON.parse(raw) as ReturnType<
            X402ClientLike["getPaymentSettleResponse"]
          >)
        : undefined;
    },
  };
}

describe.skipIf(!RUN)("local-chain DACS lifecycle with two-sided bundles", () => {
  test(
    "runs vet -> negotiate -> x402 settle -> DACS-5 bundle verify with a local tx hash",
    async () => {
      const ganache = await startGanache();
      let paywall: Server | undefined;
      try {
        const buyerAccount = privateKeyToAccount(BUYER_EVM_KEY);
        const sellerAccount = privateKeyToAccount(SELLER_EVM_KEY);
        const chain = defineChain({
          id: CHAIN_ID,
          name: "DACS local e2e",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [ganache.rpcUrl] } },
        });
        const publicClient = createPublicClient({ chain, transport: http(ganache.rpcUrl) });
        const wallet = createWalletClient({
          account: buyerAccount,
          chain,
          transport: http(ganache.rpcUrl),
        });
        const deployHash = await wallet.deployContract({
          abi: [],
          bytecode: TEST_TOKEN_BYTECODE,
        });
        const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
        const tokenAddress = deployReceipt.contractAddress!;

        paywall = createServer(async (req, res) => {
          try {
            if (!req.headers["x-payment"]) {
              res.writeHead(402, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  accepts: [
                    {
                      network: NETWORK,
                      payTo: sellerAccount.address,
                      amount: AMOUNT,
                      asset: tokenAddress,
                    },
                  ],
                }),
              );
              return;
            }
            const txHash = await wallet.writeContract({
              address: tokenAddress,
              abi: TRANSFER_ABI,
              functionName: "transfer",
              args: [sellerAccount.address, BigInt(AMOUNT)],
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            res.writeHead(receipt.status === "success" ? 200 : 500, {
              "content-type": "application/json",
              "X-PAYMENT-RESPONSE": JSON.stringify({
                success: receipt.status === "success",
                transaction: txHash,
                network: NETWORK,
                payer: buyerAccount.address,
                amount: AMOUNT,
              }),
            });
            res.end(JSON.stringify({ ok: receipt.status === "success" }));
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        const paywallUrl = await listen(paywall);

        const sellerDid = didFor(SELLER_SEED);
        const buyerDid = didFor(BUYER_SEED);
        const signSeller = signerFor(SELLER_SEED);
        const signBuyer = signerFor(BUYER_SEED);
        const sub = memStore();
        const observedAt = 1780000000000;
        const buyerIdentity = identityFor(buyerDid, observedAt - 1_000);
        const sellerIdentity = identityFor(sellerDid, observedAt - 1_000);
        const rail: PaymentRailRef = {
          railId: "x402:local",
          railVersion: 1,
          parameters: { network: NETWORK, asset: tokenAddress },
        };

        const listingDraft: ListingDraft = {
          dacsVersion: "1",
          listingVersion: 1,
          listingId: "local-chain-x402",
          seller: {
            identity: sellerIdentity,
            displayName: "Local Chain x402 Desk",
            publicEndpoint: "https://seller.example/dacs",
          },
          offering: {
            title: "Local Chain x402 Desk",
            description: "DACS local two-sided bundle proof",
            category: "data.testing",
            tags: ["local-chain", "x402"],
            deliverable: {
              kind: "attested-payload",
              payloadFormat: "application/json",
              verificationMethod: { kind: "self-signed" },
            },
          },
          buyerRequirement: { requirementVersion: "1", required: [] },
          pipeline: [
            { kind: "negotiate-fixed-price" },
            { kind: "commit-agreement" },
            { kind: "pay-x402", parameters: { rail: rail.railId } },
            { kind: "deliver-attested-payload" },
          ],
          pricing: {
            kind: "fixed",
            price: { amount: AMOUNT, currency: "USDC" },
          },
          acceptedRails: [rail],
          terms: { deadlineSecAfterCommit: 600 },
          validity: {
            notBefore: observedAt - 1_000,
            notAfter: observedAt + 1_000_000,
          },
        };
        const listingSigned = await signComponentArtifact(
          listingDraft,
          ARTIFACT_SEPARATORS.Listing,
          {
            algorithm: "ed25519",
            signer: sellerDid,
            sign: (bytes) => signSeller(bytes),
          },
        );
        const listingRef = await sub.anchor(`dacs1:listing:${sellerDid}:local-chain-x402`, listingSigned);

        const sellerVet: CompositeVerificationRecord = {
          subject: sellerDid,
          recipeId: "local-self-signed",
          recipeVersion: "0.1",
          results: [{ claimRef: sellerDid, method: "self-signed", status: "pass" }],
          decision: "pass",
          verifiedAt: "2026-07-13T00:00:00Z",
        };
        const sellerVetSigned = await signComponentArtifact(
          sellerVet,
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          {
            algorithm: "ed25519",
            signer: buyerDid,
            sign: (bytes) => signBuyer(bytes),
          },
        );
        const sellerVetRef = await sub.anchor(`dacs2:verifyrecord:${JOB_ID}:seller`, sellerVetSigned);
        const buyerVet: CompositeVerificationRecord = {
          ...sellerVet,
          subject: buyerDid,
          results: [{ claimRef: buyerDid, method: "self-signed", status: "pass" }],
        };
        const buyerVetSigned = await signComponentArtifact(
          buyerVet,
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          {
            algorithm: "ed25519",
            signer: buyerDid,
            sign: (bytes) => signBuyer(bytes),
          },
        );
        const buyerVetRef = await sub.anchor(`dacs2:verifyrecord:${JOB_ID}:buyer`, buyerVetSigned);
        const sellerVetAttRef = refTo(
          "dacs-2-verifyresult",
          `seller-vet-${JOB_ID}`,
          record(sellerVetSigned),
        );
        const buyerVetAttRef = refTo(
          "dacs-2-verifyresult",
          `buyer-vet-${JOB_ID}`,
          record(buyerVetSigned),
        );

        const agreementDraft = deriveFixedPriceAgreement({
          jobId: JOB_ID,
          verifiedListing: {
            disposition: "verified",
            listing: listingSigned,
            pin: {
              listingId: listingSigned.listingId,
              version: listingSigned.listingVersion,
              contentHash: contentHash(record(listingSigned)),
            },
          },
          buyer: {
            identityBundle: buyerIdentity,
            vetRecordRef: buyerVetAttRef,
          },
          seller: {
            identityBundle: sellerIdentity,
            vetRecordRef: sellerVetAttRef,
          },
          selectedRail: rail,
          generatedAt: observedAt,
        });
        const agreementSigned = await signFixedPriceAgreement(
          agreementDraft,
          {
            party: buyerDid,
            algorithm: "ed25519",
            sign: (bytes) => signBuyer(bytes),
          },
          {
            party: sellerDid,
            algorithm: "ed25519",
            sign: (bytes) => signSeller(bytes),
          },
        );
        const agreementRef = await sub.anchor(`dacs3:agreement:${JOB_ID}`, agreementSigned);

        const settlement = await x402SettleCore(
          {
            paywallUrl,
            network: NETWORK,
            recipientEvm: sellerAccount.address,
            amount: AMOUNT,
            asset: tokenAddress,
          },
          { client: x402Client(), fetchImpl: fetch, payerAddress: buyerAccount.address },
        );
        expect(settlement.ok).toBe(true);
        expect(settlement.txHash).toMatch(/^0x[0-9a-f]{64}$/);
        const paymentTx = await publicClient.getTransaction({ hash: settlement.txHash as `0x${string}` });
        const paymentReceipt = await publicClient.getTransactionReceipt({
          hash: settlement.txHash as `0x${string}`,
        });
        expect(paymentTx.to?.toLowerCase()).toBe(tokenAddress.toLowerCase());
        expect(paymentTx.from.toLowerCase()).toBe(buyerAccount.address.toLowerCase());
        expect(paymentReceipt.logs).toContainEqual(
          expect.objectContaining({
            address: tokenAddress,
            topics: [
              TRANSFER_TOPIC,
              addressTopic(buyerAccount.address),
              addressTopic(sellerAccount.address),
            ],
            data: uint256Data(BigInt(AMOUNT)),
          }),
        );

        const evidence = {
          evidenceVersion: "1",
          jobId: JOB_ID,
          phase: "pay-x402",
          outcome: "success",
          paymentTxRefs: [
            {
              kind: "x402" as const,
              httpResource: paywallUrl,
              paymentReceiptHash: sha256Hex(settlement.txHash),
              settlementTxHash: settlement.txHash,
              chainId: CHAIN_ID,
              protocolVersion: "1",
            },
          ],
          paymentAmount: { amount: AMOUNT, currency: "USDC" },
          settlementFinality: {
            // finalityBlocks is block-depth-only (§9.7, enforced since #32) —
            // a provider-receipt finality carries no block depth.
            model: "provider-receipt",
            finalityObservedAt: observedAt,
          },
          observedAt,
        };
        const evidenceSigned = await signComponentArtifact(
          evidence,
          ARTIFACT_SEPARATORS.SettlementEvidence,
          {
            algorithm: "ed25519",
            signer: buyerDid,
            sign: (bytes) => signBuyer(bytes),
          },
        );
        const evidenceRef = await sub.anchor(`dacs4:evidence:${JOB_ID}`, evidenceSigned);

        const settlementAttRef = refTo(
          "dacs-4-evidence",
          `settlement-${JOB_ID}`,
          record(evidenceSigned),
        );
        const { buyerCopy, sellerCopy } = await buildTwoSidedBundle({
          jobId: JOB_ID,
          outcome: "completed",
          listingRef: {
            listingId: listingSigned.listingId,
            version: 1,
            contentHash: contentHash(record(listingSigned)),
          },
          agreementRef: refTo("dacs-3-agreement", `agreement-${JOB_ID}`, record(agreementSigned)),
          phaseSummary: [
            { index: 0, kind: "vet-credentials", outcome: "ok", attestationRef: sellerVetAttRef },
            { index: 1, kind: "commit-agreement", outcome: "ok" },
            {
              index: 2,
              kind: "pay-x402",
              outcome: "ok",
              txRefs: evidence.paymentTxRefs,
              attestationRef: settlementAttRef,
            },
          ],
          vetRecords: [buyerVetAttRef, sellerVetAttRef],
          settlementEvidence: [settlementAttRef],
          recipeRegistryVersion: 1,
          railRegistryVersion: 1,
          finalisedAt: observedAt,
          buyer: {
            primaryClaim: buyerDid,
            bundleHash: identityBundleHash(buyerIdentity),
            signer: BUYER_SEED,
          },
          seller: {
            primaryClaim: sellerDid,
            bundleHash: identityBundleHash(sellerIdentity),
            signer: SELLER_SEED,
          },
        });
        expect(buyerCopy).toBeDefined();
        expect(sellerCopy).toBeDefined();
        const buyerBundle = buyerCopy!;
        const sellerBundle = sellerCopy!;
        await writeProofArtifact("buyer.bundle.json", buyerBundle);
        await writeProofArtifact("seller.bundle.json", sellerCopy);
        await writeProofArtifact("public-keys.json", {
          [buyerDid]: publicKeyHex(BUYER_SEED),
          [sellerDid]: publicKeyHex(SELLER_SEED),
        });
        await writeProofArtifact("proof-metadata.json", {
          jobId: JOB_ID,
          chainId: CHAIN_ID,
          network: NETWORK,
          tokenAddress,
          txHash: settlement.txHash,
          buyerBundleHash: attestationBundleHash(buyerBundle),
          sellerBundleHash: attestationBundleHash(sellerBundle),
        });
        const buyerBundleRef = await sub.anchor(`dacs5:bundle:${JOB_ID}:buyer`, buyerBundle);
        const sellerBundleRef = await sub.anchor(`dacs5:bundle:${JOB_ID}:seller`, sellerBundle);

        const deps: VerifyBundleDeps = {
          readArtifact: sub.read,
          resolveAttestationRef: async (ref) => {
            if (ref.anchor.locator === `agreement-${JOB_ID}`) return sub.read(agreementRef);
            if (ref.anchor.locator === `settlement-${JOB_ID}`) return sub.read(evidenceRef);
            if (ref.anchor.locator === `buyer-vet-${JOB_ID}`) return sub.read(buyerVetRef);
            if (ref.anchor.locator === `seller-vet-${JOB_ID}`) return sub.read(sellerVetRef);
            return null;
          },
          resolveListingRef: async (pin) =>
            pin.listingId === listingSigned.listingId &&
            pin.version === listingSigned.listingVersion &&
            pin.contentHash === contentHash(record(listingSigned))
              ? sub.read(listingRef)
              : null,
          resolvePublicKey: async (did) => resolveFromDid(did),
          verify: (bytes, sig, pub) => ed25519Verify(bytes, sig, publicKeyFromRaw(pub)),
        };

        const buyerVerdict = await verifyBundleCore(buyerBundleRef, deps);
        const sellerVerdict = await verifyBundleCore(sellerBundleRef, deps);
        expect(buyerVerdict.ok).toBe(true);
        expect(sellerVerdict.ok).toBe(true);
        expect(buyerVerdict.fullyVerified).toBe(true);
        expect(sellerVerdict.fullyVerified).toBe(true);
        expect(buyerVerdict.signatures.map((s) => s.verdict)).toEqual(["valid", "valid"]);
        expect(sellerVerdict.signatures.map((s) => s.verdict)).toEqual(["valid", "valid"]);
        expect(buyerVerdict.bundle?.settlementEvidence[0]?.contentHash).toBe(
          settlementAttRef.contentHash,
        );
        expect(sellerVerdict.bundle?.settlementEvidence[0]?.contentHash).toBe(
          settlementAttRef.contentHash,
        );
      } finally {
        if (paywall) await closeServer(paywall);
        await stopProcess(ganache.child);
      }
    },
    120_000,
  );
});
