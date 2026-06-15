import { Demos } from "@kynesyslabs/demosdk/websdk";
import { StorageProgram } from "@kynesyslabs/demosdk/storage";

import { DacsError, NotImplementedError } from "../errors.js";
import type {
  AnchorRef,
  ProxyFetchRequest,
  ProxyFetchResult,
  ResolvedIdentity,
  SubstrateAdapter,
} from "./SubstrateAdapter.js";

// Fixed address-derivation inputs so a logical name always resolves to the same
// storage address (any reader can re-derive it from the writer address + name).
const ANCHOR_NONCE = 0;
const ANCHOR_SALT = "dacs:v1";

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

  /**
   * SR-2 anchoring via Demos Storage Programs. A logical name maps to one
   * storage program at a deterministic address (`deriveStorageAddress` of the
   * writer + name + fixed nonce/salt), so the same name re-resolves to the same
   * address and re-anchoring updates it in place. First write creates the
   * program (public-read ACL); later writes update it. (Mirrors the
   * agent-commerce-demo's proven create-or-write + sign→confirm→broadcast flow.)
   */
  async anchor(name: string, value: Record<string, unknown>): Promise<AnchorRef> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const deployer = this.demos.getAddress();
    const address = StorageProgram.deriveStorageAddress(
      deployer,
      name,
      ANCHOR_NONCE,
      ANCHOR_SALT,
    );

    // Create on first write, update thereafter (idempotent).
    let exists = false;
    try {
      const probe = (await this.demos.storagePrograms.read(address)) as {
        success?: boolean;
        data?: unknown;
      };
      exists = probe?.success === true && probe.data != null;
    } catch {
      exists = false;
    }

    const payload = exists
      ? StorageProgram.writeStorage(address, value, "json")
      : StorageProgram.createStorageProgram(
          deployer,
          name,
          value,
          "json",
          StorageProgram.publicACL(),
          { nonce: ANCHOR_NONCE, salt: ANCHOR_SALT },
        );

    const signed = await this.demos.storagePrograms.sign(payload);
    const validity = await this.demos.tx.confirm(signed, this.demos);
    const broadcast = (await this.demos.tx.broadcast(validity, this.demos)) as {
      result?: number;
      response?: { hash?: string; message?: string };
      extra?: unknown;
    };
    if (broadcast?.result !== 200) {
      throw new DacsError(
        `anchor failed for ${address}: ${
          typeof broadcast?.extra === "string"
            ? broadcast.extra
            : JSON.stringify(broadcast?.extra ?? broadcast?.response)
        }`,
      );
    }

    return {
      address,
      txRef: broadcast.response?.hash ?? (signed as { hash?: string }).hash,
    };
  }

  async readAnchor(address: string): Promise<Record<string, unknown> | null> {
    try {
      const res = (await this.demos.storagePrograms.read(address)) as {
        success?: boolean;
        data?: Record<string, unknown> | null;
      };
      return res?.success && res.data != null ? res.data : null;
    } catch {
      // Storage Programs read throws on 404 (not yet anchored).
      return null;
    }
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
