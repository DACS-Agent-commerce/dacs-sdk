import {
  type X402ClientLike,
  type X402SettlementResponse,
} from "@kynesyslabs/dacs";
import { DemosAdapter } from "@kynesyslabs/dacs/substrate";
import type { Demos } from "@kynesyslabs/demosdk/websdk";
import type { SettleResponse } from "@x402/core/types";
import type { ExactEvmScheme } from "@x402/evm/exact/client";
import type { x402HTTPClient } from "@x402/fetch";
import type { Account } from "viem/accounts";

const demos = new DemosAdapter({ rpc: "https://example.invalid" });
declare const peerDemos: Demos;
declare const peerClient: x402HTTPClient;
declare const peerSettlement: SettleResponse;
declare const evmAccount: Account;
declare const evmScheme: ExactEvmScheme;

// Preserve the pre-#104 escape-hatch contract on the explicitly live subpath:
// callers that opted into demosdk continue to receive its complete Demos type.
const raw: Demos = demos.raw;
const compatibleRaw: typeof demos.raw = peerDemos;

// Keep the peer-independent x402 port honest against the installed upstream
// declarations rather than merely proving that the DACS declarations exist.
const compatibleClient: X402ClientLike = peerClient;
const compatibleSettlement: X402SettlementResponse = peerSettlement;

void raw;
void compatibleRaw;
void compatibleClient;
void compatibleSettlement;
void evmAccount;
void evmScheme;
