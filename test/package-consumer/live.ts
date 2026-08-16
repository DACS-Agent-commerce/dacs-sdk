import {
  type X402ClientLike,
  type X402SettlementResponse,
} from "@kynesyslabs/dacs";
import {
  DemosAdapter,
  type DemosRawClient,
} from "@kynesyslabs/dacs/substrate";
import type { SettleResponse } from "@x402/core/types";
import type { ExactEvmScheme } from "@x402/evm/exact/client";
import type { x402HTTPClient } from "@x402/fetch";
import type { Account } from "viem/accounts";

type IsAny<Value> = 0 extends (1 & Value) ? true : false;
type AssertFalse<Value extends false> = Value;
type _ClientDeclarationIsTyped = AssertFalse<IsAny<x402HTTPClient>>;
type _SettlementDeclarationIsTyped = AssertFalse<IsAny<SettleResponse>>;
type _SchemeDeclarationIsTyped = AssertFalse<IsAny<ExactEvmScheme>>;
type _AccountDeclarationIsTyped = AssertFalse<IsAny<Account>>;

const demos = new DemosAdapter({ rpc: "https://example.invalid" });
declare const peerClient: x402HTTPClient;
declare const peerSettlement: SettleResponse;
declare const evmAccount: Account;
declare const evmScheme: ExactEvmScheme;

const raw: DemosRawClient = demos.raw;

// Keep the peer-independent x402 port honest against the installed upstream
// declarations rather than merely proving that the DACS declarations exist.
const compatibleClient: X402ClientLike = peerClient;
const compatibleSettlement: X402SettlementResponse = peerSettlement;

void raw;
void compatibleClient;
void compatibleSettlement;
void evmAccount;
void evmScheme;
