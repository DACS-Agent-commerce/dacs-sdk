import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { advanceAp2Settlement, deriveAp2TransactionId, type Ap2ProviderAdapter } from "../../src/rails/ap2.js";
import { createFsAp2BindingStore } from "../../src/rails/ap2SettlementFs.js";
import { createStripeAp2Integration } from "../../src/rails/ap2Stripe.js";
import { sha256Hex } from "../../src/canonical/index.js";
import { ap2ProfileScope } from "./ap2Profile.js";

// An optional fifth argument presents a different checkout for the same job and phase.
const [root, rawTime, behavior = "lost", rawDelay = "0", JWS = "e30.e30.c2ln"] = process.argv.slice(2);
if (!root || !rawTime) throw new Error("Stripe recovery worker arguments missing");
let now = Number(rawTime);
const DAY = 24 * 60 * 60 * 1000;
const path = join(root, "provider.json");
interface ProviderState {
  effects: number;
  posts: Array<{ key: string; body: string }>;
  createdAt?: number;
  reference?: string;
}
const state: ProviderState = await readFile(path, "utf8").then(
  (text) => JSON.parse(text) as ProviderState,
  (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return { effects: 0, posts: [] }; },
);
let reads = 0;
const { provider } = createStripeAp2Integration({
  createCredential: ["rk", "test", "RecoveryCreate123"].join("_"),
  statusCredential: ["rk", "test", "RecoveryStatus456"].join("_"),
  payeeId: "merchant-recovery", currencyMinorUnits: 2,
  fetchImpl: async (_url, init) => {
    const key = new Headers(init?.headers).get("Idempotency-Key")!;
    state.posts.push({ key, body: String(init?.body) });
    // Provider state is independent of the binding store and survives workers.
    if (state.createdAt === undefined || now - state.createdAt >= DAY) {
      state.effects += 1;
      state.createdAt = now;
      state.reference = `pi_recovery${state.effects}`;
    }
    await writeFile(path, JSON.stringify(state));
    if (behavior === "kill") process.kill(process.pid, "SIGKILL");
    if (behavior === "lost" || behavior === "delay" || behavior === "phase-loss") throw new Error("response lost after charge committed");
    return new Response(JSON.stringify({ id: state.reference }), { status: 200 });
  },
  substrate: { async proxyFetch() {
    reads += 1;
    const body = JSON.stringify({ id: state.reference, status: "succeeded", amount_received: 1000, currency: "usd",
      metadata: { dacs_job_id: scope.jobId, dacs_agreement_hash: "a".repeat(64) } });
    if (behavior === "pending") return { status: 404, body: "{}", responseHash: sha256Hex("{}"), anchorTxRef: "a".repeat(64), fetchedAt: now };
    return { status: 200, body, responseHash: sha256Hex(body), anchorTxRef: "a".repeat(64), fetchedAt: now };
  } },
});
const scope = await ap2ProfileScope();
// Keep the production dead-owner grace mechanism, with a short test-only
// duration so publication-kill recovery does not wait 30 seconds per child.
const store = await createFsAp2BindingStore({ dir: join(root, "binding"), lockStaleMs: 5, lockPollMs: 1 });
// Simulate async pre-dispatch delay after the engine has checked the deadline,
// or a process killed after the binding is reserved and before any provider request.
const wrappedProvider = behavior === "delay" ? { ...provider, async submit(input: Parameters<typeof provider.submit>[0]) {
  now += Number(rawDelay);
  return provider.submit(input);
} } : behavior === "kill-before-submit" ? { ...provider, async submit(): Promise<never> {
  process.kill(process.pid, "SIGKILL");
  return new Promise<never>(() => {});
} } : provider;
// Recreate a wrapper in a fresh process without carrying the replay declaration,
// or with a changed declaration. The provider operation and callbacks stay exact.
const restartedProvider = behavior === "omit-window" ? {
  operation: provider.operation, capabilities: provider.capabilities,
  submit: provider.submit, readAttestedStatus: provider.readAttestedStatus,
} as Ap2ProviderAdapter : behavior === "change-window" ? {
  ...provider, noReferenceReplayWindowMs: Number(rawDelay),
} : wrappedProvider;
const settlementInput = {
  ...scope, agreementHash: "a".repeat(64), protocolVersion: "0.2",
  expected: { payee: "merchant-recovery", amount: "10", currency: "USD" },
  checkoutMandate: { checkout_jwt: JWS }, paymentMandate: { transaction_id: deriveAp2TransactionId(JWS) },
  verifier: {
    async verifyCheckoutMandate() { return { disposition: "verified" as const, mandate: { checkoutJws: JWS, algorithm: "ES256", signatureGeneration: "non-deterministic" as const } }; },
    async verifyPaymentMandate() { return { disposition: "verified" as const, mandate: { transactionId: deriveAp2TransactionId(JWS), mandateId: "mandate-recovery", payee: "merchant-recovery", amount: "10", currency: "USD", paymentInstrumentId: "pm_recovery" } }; },
  },
  store, provider: restartedProvider, owner: `worker-${process.pid}`, now: () => now,
  // A delayed invocation remains leased while its provider replay window expires.
  leaseDurationMs: behavior === "delay" ? DAY * 2 : 100,
};
let progress = await advanceAp2Settlement(settlementInput);
if (behavior === "phase-loss") {
  if (state.effects !== 1 || progress.status !== "indeterminate") throw new Error("phase-loss control did not charge once");
  now += DAY + 1;
  for (const name of await readdir(join(root, "binding", "phases"))) await rm(join(root, "binding", "phases", name));
  const other = "e31.e30.c2ln";
  progress = await advanceAp2Settlement({ ...settlementInput,
    checkoutMandate: { checkout_jwt: other }, paymentMandate: { transaction_id: deriveAp2TransactionId(other) },
    verifier: {
      async verifyCheckoutMandate() { return { disposition: "verified" as const, mandate: { checkoutJws: other, algorithm: "ES256", signatureGeneration: "non-deterministic" as const } }; },
      async verifyPaymentMandate() { return { disposition: "verified" as const, mandate: { transactionId: deriveAp2TransactionId(other), mandateId: "mandate-recovery", payee: "merchant-recovery", amount: "10", currency: "USD", paymentInstrumentId: "pm_recovery" } }; },
    },
  });
}
process.stdout.write(JSON.stringify({ pid: process.pid, progress, state, reads }));
