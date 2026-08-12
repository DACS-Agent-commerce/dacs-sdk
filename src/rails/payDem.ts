import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { baseUnits } from "../canonical/index.js";
import { DacsError, TransientError } from "../errors.js";
import {
  createIdempotencyStore,
  settlementKey,
  type SettlementIdempotencyStore,
  type SettlementReconcile,
} from "./idempotency.js";

/** §9.5.9: the native asset this rail settles. */
export const DEM_CURRENCY = "DEM";
/** §9.5.9: 1 DEM = 10^9 OS base units. The chain moves integer OS. */
export const DEM_DECIMALS = 9;

/**
 * The Demos address a DACS primary claim settles to. In the Demos model a CCI
 * *is* the ed25519 public-key hex, so a Demos claim resolves INTRINSICALLY to its
 * address — no external mapping is trusted. Accepts only the DEMOS forms: a bare
 * `<64-hex>`, `0x<64-hex>`, or a `did:demos:…:<64-hex>` DID.
 *
 * STRICT (#32): a non-Demos scheme that merely *ends* in 64 hex — `did:ethr:…`,
 * `cci-xm:evm:mainnet:0x…`, `web2:…:…` — is NOT Demos-bound and returns null, so
 * pay-dem refuses to transfer rather than treating a foreign-scheme claim as an
 * intrinsic Demos destination. A claim that embeds no Demos key returns null too.
 */
export function demosAddressFromClaim(claim: string): string | null {
  const c = claim.trim();
  const bare = c.match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  if (bare) return bare[1]!.toLowerCase();
  const did = c.match(/^did:demos:(?:[^:]+:)*(?:0x)?([0-9a-fA-F]{64})$/);
  if (did) return did[1]!.toLowerCase();
  return null;
}

/**
 * pay-dem settlement rail — native DEM transfer (DACS-4 §9.5.9, SR-4).
 *
 * The plain native path: the buyer submits a `demos.transfer` of the agreed DEM
 * amount straight to the seller's address; the cosigned agreement + the on-chain
 * transfer ARE the settlement (no HTTP 402 flow — that's the separate,
 * experimental pay-d402). This is the live-settleable native rail: for Demos,
 * BFT *inclusion IS finality*, so the evidence carries `settlementFinality.model:
 * "bft-final"` and a `demos` txRef (hash + block height).
 *
 * INCLUSION-GATED (§9.5.9): `bft-final` is emitted ONLY on observed inclusion —
 * a terminal `included`/`confirmed`/`finalized` state AND the finality-witness
 * block height. Broadcast *acceptance* (the node took the tx for submission) is
 * NOT finality: a merely-accepted tx can still be rejected in consensus, dropped,
 * or never included, so minting evidence on acceptance would attest an unobserved
 * payment. A transfer that doesn't reach observed inclusion settles `ok: false`
 * and no finality is stamped — evidence is never minted for a payment we didn't
 * see land.
 *
 * Amount units (§9.5.9 step 2): the agreement's DACS `Price.amount` is a canonical
 * DECIMAL DEM string; the chain moves integer OS base units (1 DEM = 10^9 OS). The
 * `payDemSettle` seam is the converter — it asserts the currency is DEM and turns
 * decimal DEM → OS. `payDemSettleCore` then works purely in integer OS base units
 * (never floats). The core is pure over an injected native client, so it's tested
 * without a Demos node; createPayDemRail is the thin demosdk wiring
 * (transfer → confirm → broadcastAndWait, gated on the terminal inclusion state).
 */

export interface PayDemSettleParams {
  /** Recipient Demos address (payee). */
  recipient: string;
  /** Amount in integer OS base units (string). */
  amount: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
}

/** The result of submitting a native transfer (sign → confirm → broadcastAndWait). */
export interface DemosTransferResult {
  ok: boolean;
  hash: string;
  /**
   * The terminal transaction state the client observed. `bft-final` is emitted
   * only for an inclusion state ({@link TERMINAL_INCLUDED}); any other state
   * (`failed`, `timeout`, a nonterminal poll, …) is not observed finality.
   */
  state?: string;
  /** The block height the tx landed at — the §9.5.9 finality witness. */
  blockNumber?: number;
  message?: string;
}

/**
 * Terminal states that count as observed inclusion for `bft-final`. The Demos
 * node reports `included`; `confirmed`/`finalized` are accepted for forward
 * compatibility with substrates that name the terminal inclusion state differently.
 */
export const TERMINAL_INCLUDED = new Set(["included", "confirmed", "finalized"]);

/** Minimal structural view of the native-transfer client this rail depends on. */
export interface DemosNativeClient {
  /** The payer's Demos address. */
  address: string;
  /** Sign, confirm, and broadcast a native DEM transfer; resolve its receipt. */
  transfer(args: { to: string; amountOs: bigint }): Promise<DemosTransferResult>;
}

export async function payDemSettleCore(
  params: PayDemSettleParams,
  client: DemosNativeClient,
): Promise<SettleResult> {
  let amountOs: bigint;
  try {
    amountOs = BigInt(params.amount);
  } catch {
    throw new DacsError(`pay-dem: invalid OS base-unit amount ${params.amount}`);
  }
  if (amountOs <= 0n) {
    throw new DacsError(`pay-dem: amount must be > 0 (got ${params.amount})`);
  }

  const res = await client.transfer({ to: params.recipient, amountOs });
  const txHash = (res?.hash ?? "").trim();
  const chainId = params.network ?? "demos";

  // Observed inclusion (§9.5.9): a verifiable tx id AND a terminal inclusion
  // state AND the finality-witness block height. Broadcast acceptance alone is
  // NOT finality — without these three, we do not stamp bft-final, because the
  // tx may never have landed.
  const observedFinal =
    res?.ok === true &&
    txHash.length > 0 &&
    res?.state !== undefined &&
    TERMINAL_INCLUDED.has(res.state) &&
    typeof res?.blockNumber === "number";

  if (!observedFinal) {
    return {
      ok: false,
      txHash,
      chainId,
      payer: client.address,
      payee: params.recipient,
      // No finality / blockNumber: inclusion was not observed, so no bft-final
      // evidence is minted for a possibly-unincluded payment.
    };
  }

  return {
    ok: true,
    txHash,
    chainId,
    payer: client.address,
    payee: params.recipient,
    // §9.5.9: inclusion IS finality on Demos; the tx is a `demos` ref carrying
    // the block height that witnesses it.
    finality: { model: "bft-final" },
    blockNumber: res.blockNumber,
    txRefKind: "demos",
  };
}

export interface PayDemRailConfig {
  /** Demos node RPC URL. */
  rpc: string;
  /** Buyer wallet secret — mnemonic or private key — used to sign the transfer. */
  secret: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
}

export interface PayDemRail {
  /** The buyer's Demos address. */
  readonly address: string;
  /** Settle one session's payment via a native DEM transfer. */
  settle(params: PayDemSettleParams): Promise<SettleResult>;
}

/**
 * Construct a pay-dem rail from a Demos RPC + wallet secret. Lazily imports
 * demosdk so the SDK core stays importable without the chain deps installed.
 * Submits via the proven sign → confirm → broadcastAndWait flow.
 *
 * The low-level rail signs a fresh transaction on every call. The exported
 * runSession bridge, {@link payDemSettle}, therefore wraps it in the shared
 * session/phase-keyed settlement idempotency store (#43/#52).
 */
export async function createPayDemRail(config: PayDemRailConfig): Promise<PayDemRail> {
  if (!config?.rpc) throw new DacsError("pay-dem rail requires an rpc URL");
  if (!config?.secret) throw new DacsError("pay-dem rail requires a wallet secret to sign transfers");

  const { Demos } = await import("@kynesyslabs/demosdk/websdk");
  const demos = new Demos();
  await demos.connect(config.rpc);
  await demos.connectWallet(config.secret);

  const client: DemosNativeClient = {
    address: demos.getAddress(),
    transfer: async ({ to, amountOs }) => {
      const signed = await demos.transfer(to, amountOs);
      const signedNonceValue = (signed as { content?: { nonce?: unknown } })
        .content?.nonce;
      if (
        !Number.isSafeInteger(signedNonceValue) ||
        (signedNonceValue as number) < 0
      ) {
        throw new DacsError(
          "pay-dem: signed transfer has no valid transaction nonce",
        );
      }
      const signedNonce = signedNonceValue as number;
      const validity = await demos.tx.confirm(signed, demos);
      const signedHash = (signed as { hash?: string }).hash;
      const confirmedHash = (
        validity as {
          response?: { data?: { transaction?: { hash?: string } } };
        }
      ).response?.data?.transaction?.hash;
      // broadcastAndWait polls the confirmed transaction hash. Keep that same
      // identity authoritative for timeout and success receipts; a broadcast
      // response is transport metadata and must not substitute another hash.
      const txHash = confirmedHash ?? signedHash ?? "";
      if (!txHash) {
        throw new DacsError(
          "pay-dem: confirmed transfer has no transaction hash",
        );
      }
      let broadcast: { response?: { hash?: string; message?: string } };
      let status: { state: "included" | "failed"; blockNumber?: number };
      try {
        // broadcastAndWait POLLS to a terminal state (included|failed) instead
        // of returning on broadcast acceptance — so `ok`/`bft-final` reflect
        // observed inclusion, and `status.blockNumber` gives the finality witness.
        ({ broadcast, status } = (await demos.broadcastAndWait(validity)) as {
          broadcast: { response?: { hash?: string; message?: string } };
          status: { state: "included" | "failed"; blockNumber?: number };
        });
      } catch (err) {
        // Timeout / broadcast failure → no terminal inclusion observed. Report a
        // non-final result (ok:false) rather than throwing, so the settle seam
        // records a failed payment and never mints bft-final for an unseen tx.
        return {
          ok: false,
          state: "timeout",
          hash: txHash,
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (status.state === "included") {
        try {
          // Inclusion can precede the account read reflecting the consumed
          // nonce. Do not let runSession sign its follow-on evidence anchor
          // from a stale value (DEMOS-MAPPING A.1/A.2).
          await demos.waitForNonce(demos.getAddress(), signedNonce);
        } catch (error) {
          throw new TransientError(
            `pay-dem: transfer ${txHash} was included, but account nonce ${signedNonce} did not become readable; refusing a follow-on anchor`,
            { cause: error },
          );
        }
      }

      return {
        ok: status.state === "included",
        state: status.state,
        hash: txHash,
        blockNumber: status.blockNumber,
        message: broadcast?.response?.message,
      };
    },
  };

  return {
    address: client.address,
    settle: (params) =>
      payDemSettleCore({ ...params, network: params.network ?? config.network ?? "demos" }, client),
  };
}

/**
 * Bridge a PayDemRail to the runSession `settle` seam.
 *
 * DESTINATION (legacy safety guard, not PB-2 conformance): the transfer
 * destination is derived from the AGREEMENT's `req.payee` — the seller's primary
 * claim — never from separate config. A Demos primary claim intrinsically IS the
 * address, so the money can only go where the fixed-price agreement says.
 * `cfg.recipient` is therefore an optional CROSS-CHECK: if it disagrees with the
 * agreement's payee the settle ABORTS **before** any transfer, rather than paying
 * a third address while returning evidence for the session price.
 *
 * This is a guard on the current §9.5.1-legacy `AgreementDocument` path — NOT
 * PB-1..PB-3 conformance, which apply to a `PayeeBoundAgreementDocument` whose
 * destination is selected from a signed `terms.payoutBindings`. The
 * payee-bound-artifact path is separate follow-up work; here `req.payee` is the
 * listing seller carried through the fixed-price agreement.
 *
 * SAFE BY DEFAULT (#43/#52): settlement is submitted at most once per
 * `(railId, jobId, phaseIndex)`. The default store protects concurrent and
 * same-process retries; inject a durable store and reconcile capability for
 * restart/crash recovery.
 *
 * The seam is also the DEM converter (§9.5.9 step 2): the agreement's
 * `Price.amount` is a canonical DECIMAL DEM string (e.g. "5" or "5.1"), but the
 * chain moves integer OS base units (1 DEM = 10^9 OS). This asserts the currency
 * is DEM and converts decimal → OS before handing off to the rail — WITHOUT this,
 * "5" DEM was submitted as 5 OS (a billionth of the agreed amount), settled silently.
 */
export function payDemSettle(
  rail: PayDemRail,
  cfg: { recipient?: string; network?: string } = {},
  opts: { store?: SettlementIdempotencyStore; reconcile?: SettlementReconcile } = {},
): (req: SettleRequest) => Promise<SettleResult> {
  const store = opts.store ?? createIdempotencyStore();
  const configuredRecipient = cfg.recipient;
  const network = cfg.network ?? "demos";
  const reconcile = opts.reconcile;
  return async (req) => {
    const { amount, asset, expectedPayee, jobId, payee, rail: railId } = req;
    const phaseIndex = req.phaseIndex ?? 0;
    if (asset !== DEM_CURRENCY) {
      throw new DacsError(
        `pay-dem settles ${DEM_CURRENCY} only, got asset "${asset}" (§9.5.9)`,
      );
    }
    // Destination guard: resolve the address from the agreement's payee claim.
    const payeeAddress = demosAddressFromClaim(payee);
    if (!payeeAddress) {
      throw new DacsError(
        `pay-dem: payee "${payee}" does not intrinsically resolve to a Demos ` +
          `address; refusing to transfer`,
      );
    }
    if (expectedPayee !== payeeAddress) {
      throw new DacsError(
        `pay-dem destination mismatch: request binds ${expectedPayee}, agreement claim resolves to ${payeeAddress}`,
      );
    }
    // A configured recipient may only CONFIRM the agreement's payee, never replace it.
    if (configuredRecipient) {
      const configured =
        demosAddressFromClaim(configuredRecipient) ??
        configuredRecipient.trim().toLowerCase();
      if (configured !== payeeAddress) {
        throw new DacsError(
          `pay-dem destination mismatch: configured recipient "${configuredRecipient}" is not the ` +
            `agreement payee "${payee}"; refusing to transfer`,
        );
      }
    }
    // Decimal DEM → integer OS base units (string/integer math, no float).
    // baseUnits also rejects sub-OS precision (> 9 fractional digits).
    const amountOs = baseUnits(amount, DEM_DECIMALS);
    const submit = () =>
      rail.settle({
        recipient: payeeAddress,
        amount: amountOs,
        network,
      });
    return store.once(
      settlementKey(railId, jobId, phaseIndex),
      submit,
      reconcile,
    );
  };
}
