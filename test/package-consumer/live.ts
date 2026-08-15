import {
  createDacsX402BuyerEvmChallengeClient,
  createX402Rail,
  type X402RailConfig,
} from "@kynesyslabs/dacs";
import {
  DemosAdapter,
  type DemosRawClient,
} from "@kynesyslabs/dacs/substrate";

const demos = new DemosAdapter({ rpc: "https://example.invalid" });
const raw: DemosRawClient = demos.raw;
const railConfig: X402RailConfig = { evmPrivateKey: `0x${"00".repeat(32)}` };
const railFactory: typeof createX402Rail = createX402Rail;
const challengeFactory: typeof createDacsX402BuyerEvmChallengeClient =
  createDacsX402BuyerEvmChallengeClient;

void raw;
void railConfig;
void railFactory;
void challengeFactory;
