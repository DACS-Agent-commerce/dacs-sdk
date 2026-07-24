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
  /** Node-estimated inclusion block returned when the transaction is accepted. */
  expectedConfirmationBlock?: number;
  /** Local unix-ms timestamp immediately after the node accepted broadcast. */
  broadcastAt?: number;
  /** Sequential sender nonce carried by the signed transaction. */
  nonce?: number;
  /**
   * Exact public transaction content used to derive `txRef`. Consumers may
   * hash this JSON and combine it with an authoritative `included` status to
   * verify the write before eventually-consistent transaction indexes hydrate.
   */
  transactionContent?: Record<string, unknown>;
}

export interface AnchorOptions {
  /** Explicit sender nonce reserved by a wallet-local transaction queue. */
  nonce?: number;
  /**
   * Skip the eventually-consistent storage projection when the caller owns a
   * deterministic slot guaranteed to be new for this operation. A create
   * collision must fail closed unless the existing value is canonically equal.
   */
  writeMode?: "auto" | "known-new";
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
  /** Sign raw bytes with the connected wallet key; returns the raw signature. */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** The connected wallet's ed25519 public key (the agent's signing identity). */
  getPublicKey(): Promise<Uint8Array>;

  /**
   * SR-2 — anchor a JSON value under a logical name. Returns the content
   * address it was written to (deterministic from the writer + name) and the
   * tx ref. Consumers re-canonicalise the value to verify its content hash.
   */
  anchor(name: string, value: object, options?: AnchorOptions): Promise<AnchorRef>;
  /** SR-2 — the deterministic storage address a name anchors to, without writing. */
  anchorAddress(name: string): string;
  /** SR-2 — read a previously anchored value by its storage address, or null if absent. */
  readAnchor(address: string): Promise<Record<string, unknown> | null>;

  /** SR-3 — consensus-backed proxy fetch of a public HTTPS endpoint (DAHR). */
  proxyFetch(req: ProxyFetchRequest): Promise<ProxyFetchResult>;

  /** SR-1 — resolve a claim reference through cross-substrate identity (CCI). */
  resolveIdentity(ref: string): Promise<ResolvedIdentity>;
  /**
   * SR-1 (reverse) — find the subject primary claims (Demos pubkeys) that have a
   * given linked claim bound to them. `claimRef` is a canonical linked-claim ref
   * (`web2:<platform>:<handle>` or `xm:<chainType>:<address>`); returns the
   * matching subjects (usually one), or [] if none.
   */
  findSubjectsByClaim(claimRef: string): Promise<string[]>;
}
