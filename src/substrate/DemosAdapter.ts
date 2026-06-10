import { Demos } from "@kynesyslabs/demosdk/websdk";

import { NotImplementedError } from "../errors.js";
import type {
  AnchorRef,
  ProxyFetchRequest,
  ProxyFetchResult,
  ResolvedIdentity,
  SubstrateAdapter,
} from "./SubstrateAdapter.js";

export interface DemosAdapterConfig {
  /** Demos node RPC URL (e.g. https://node2.demos.sh). */
  rpc: string;
  /** Wallet secret — mnemonic or private key. Optional for read-only use. */
  secret?: string;
}

/**
 * The one concrete SubstrateAdapter, wrapping `@kynesyslabs/demosdk`.
 *
 * T1 scaffold status: `connect` / `getAddress` are wired to the real SDK so the
 * package provably reaches a Demos RPC. The substrate operations (`anchor`,
 * `readAnchor`, `proxyFetch`, `resolveIdentity`, `sign`) are defined by the seam
 * but land in later tasks — see the per-method task refs.
 */
export class DemosAdapter implements SubstrateAdapter {
  private readonly demos: Demos;
  private readonly config: DemosAdapterConfig;
  private connected = false;

  constructor(config: DemosAdapterConfig) {
    if (!config?.rpc) {
      throw new Error("DemosAdapter requires an rpc URL");
    }
    this.config = config;
    this.demos = new Demos();
  }

  /** Underlying demosdk instance — escape hatch while the seam fills out. */
  get raw(): Demos {
    return this.demos;
  }

  async connect(): Promise<void> {
    await this.demos.connect(this.config.rpc);
    if (this.config.secret) {
      await this.demos.connectWallet(this.config.secret);
    }
    this.connected = true;
  }

  getAddress(): string {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    return this.demos.getAddress();
  }

  async sign(_bytes: Uint8Array): Promise<string> {
    throw new NotImplementedError("DemosAdapter.sign", "T2 — signing foundation");
  }

  async anchor(_address: string, _value: string): Promise<AnchorRef> {
    throw new NotImplementedError("DemosAdapter.anchor (SR-2)", "T2 — anchoring");
  }

  async readAnchor(_address: string): Promise<string | null> {
    throw new NotImplementedError("DemosAdapter.readAnchor (SR-2)", "T2 — anchoring");
  }

  async proxyFetch(_req: ProxyFetchRequest): Promise<ProxyFetchResult> {
    throw new NotImplementedError("DemosAdapter.proxyFetch (SR-3 / DAHR)", "T6 — vet");
  }

  async resolveIdentity(_ref: string): Promise<ResolvedIdentity> {
    throw new NotImplementedError(
      "DemosAdapter.resolveIdentity (SR-1 / CCI)",
      "T3 — identity",
    );
  }
}
