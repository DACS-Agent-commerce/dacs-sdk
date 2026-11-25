#!/usr/bin/env node
// Registers the package's Demos SDK resolver before anything can load the SDK, as the generated
// commands do with `--import @kynesyslabs/dacs-node/demos-loader`, so the bare bin needs no flag.
import "./demosLoader.js";
import { startDacsWalletSpendTestnetAuthorityV1 } from "./walletSpendTestnetService.js";
import {
  DacsWalletSpendTestnetAuthorityError,
  dacsWalletSpendTestnetWitnessPublicKeyV1,
} from "./walletSpendTestnetSettings.js";

const PRINT_KEY_FLAG = "--print-witness-public-key";
const SEED_SETTING = "DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE";
const USAGE = `usage: dacs-wallet-spend-testnet-authority [${PRINT_KEY_FLAG}]`;

function printLine(stream: NodeJS.WriteStream, line: Readonly<Record<string, string>>): void {
  stream.write(`${JSON.stringify(line)}\n`);
}

function refused(error: unknown): void {
  const named = error instanceof DacsWalletSpendTestnetAuthorityError;
  const line = {
    status: "refused",
    reasonCode: named ? error.reasonCode : "wallet-spend-testnet-authority-start-failed",
    ...(named && error.setting !== undefined ? { setting: error.setting } : {}),
  };
  // Exits explicitly once the line is written: the Demos SDK's WebAssembly modules set
  // process.exitCode to 0 when they finish loading, which can happen after a fast refusal.
  process.stderr.write(`${JSON.stringify(line)}\n`, () => process.exit(1));
}

async function printWitnessPublicKey(): Promise<void> {
  const seedFile = process.env[SEED_SETTING];
  if (seedFile === undefined || seedFile.trim() === "") {
    throw new DacsWalletSpendTestnetAuthorityError("wallet-spend-testnet-authority-setting-missing", SEED_SETTING);
  }
  process.stdout.write(`${await dacsWalletSpendTestnetWitnessPublicKeyV1(seedFile)}\n`);
}

async function serve(): Promise<void> {
  const authority = await startDacsWalletSpendTestnetAuthorityV1();
  // Registered before the listening line is printed: whoever reads that line may stop the service at once.
  const shutDown = () => {
    authority.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGTERM", shutDown);
  process.once("SIGINT", shutDown);
  printLine(process.stdout, {
    status: "listening",
    url: authority.url,
    authorityId: authority.authorityId,
    epoch: authority.epoch,
    witnessVerificationKey: authority.witnessVerificationKey,
    ...(authority.lineageKey === undefined || authority.policyHash === undefined ? {} : {
      lineageKey: authority.lineageKey, policyHash: authority.policyHash,
    }),
    ...(authority.payDem === undefined ? {} : {
      payDemLineageKey: authority.payDem.lineageKey, payDemPolicyHash: authority.payDem.policyHash,
    }),
  });
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length === 0) return serve();
  if (args.length === 1 && args[0] === PRINT_KEY_FLAG) return printWitnessPublicKey();
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch(refused);
