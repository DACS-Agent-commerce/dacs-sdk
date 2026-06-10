/**
 * SubstrateAdapter — the single seam between dacs-sdk and the underlying
 * substrate. DACS is substrate-agnostic by design; the SDK speaks only to this
 * interface, and one concrete implementation (DemosAdapter) wraps
 * `@kynesyslabs/demosdk`. Do not add speculative multi-substrate machinery —
 * the interface is the abstraction; the second adapter is YAGNI
 * (IMPLEMENTATION.md §1.3).
 *
 * Capability groups map to the spec's substrate requirements (SR-*):
 *   - anchor / readAnchor → SR-2  Anchored storage (Storage Programs)
 *   - proxyFetch          → SR-3  Consensus-backed proxy (DAHR)
 *   - resolveIdentity     → SR-1  Cross-substrate identity (CCI)
 *   - channel (deferred)  → SR-4  Private channels (L2PS)
 *   - settle  (deferred)  → SR-5  Atomic cross-chain settlement (Liquidity Tanks)
 *
 * The MVP path (fixed-price + x402 + domain verification + storage delivery)
 * exercises connect / getAddress / sign / anchor / readAnchor / proxyFetch /
 * resolveIdentity. channel + settle are out of MVP scope (IMPLEMENTATION.md §2).
 */

export interface AnchorRef {
  /** Content-addressed storage address the value was written to. */
  address: string;
  /** Substrate transaction reference for the write, if available. */
  txRef?: string;
}

export interface ProxyFetchRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
}

export interface ProxyFetchResult {
  /** Raw response body, returned inline to the caller. */
  body: string;
  status: number;
  /** sha256 of the body, asserted by the validator set. */
  responseHash: string;
  /** Anchoring tx the validators co-signed over (url, time, bodyHash). */
  anchorTxRef?: string;
  /** Epoch-millis the fetch was performed. */
  fetchedAt: number;
}

export interface ResolvedIdentity {
  /** The claim reference that was resolved (echoed back). */
  ref: string;
  /** The primary/root claim this identity is bound to, if any. */
  boundTo?: string;
  /** Raw resolution payload from the substrate. */
  raw: unknown;
}

export interface SubstrateAdapter {
  /** Connect to the substrate RPC (and wallet, if a secret was configured). */
  connect(): Promise<void>;
  /** Address of the connected wallet. Throws if not connected. */
  getAddress(): string;
  /** Sign raw bytes. Domain-separated signing is composed above this (T2). */
  sign(bytes: Uint8Array): Promise<string>;

  /** SR-2 — write a value to anchored storage; returns its address + tx ref. */
  anchor(address: string, value: string): Promise<AnchorRef>;
  /** SR-2 — read a previously anchored value, or null if absent. */
  readAnchor(address: string): Promise<string | null>;

  /** SR-3 — consensus-backed proxy fetch of a public HTTPS endpoint (DAHR). */
  proxyFetch(req: ProxyFetchRequest): Promise<ProxyFetchResult>;

  /** SR-1 — resolve a claim reference through cross-substrate identity (CCI). */
  resolveIdentity(ref: string): Promise<ResolvedIdentity>;
}
