import { describe, expect, it } from "vitest";

import { isCanonicalSettlementIdentity } from "../../src/agent/settlementIdentity.js";

describe("isCanonicalSettlementIdentity", () => {
  it.each([
    `demos:${"a".repeat(64)}`,
    `evm:1:${"b".repeat(64)}:0`,
    `evm:8453:${"c".repeat(64)}:27`,
    `solana:mainnet:${"1".repeat(64)}:0`,
    `solana:devnet:${"1".repeat(64)}:7`,
    `solana:testnet:${"1".repeat(64)}:9007199254740991`,
  ])("accepts canonical SB-1 identity %s", (value) => {
    expect(isCanonicalSettlementIdentity(value)).toBe(true);
  });

  it.each([
    `demos:${"A".repeat(64)}`,
    `demos:${"a".repeat(63)}`,
    `evm:0:${"b".repeat(64)}:0`,
    `evm:01:${"b".repeat(64)}:0`,
    `evm:1:0x${"b".repeat(64)}:0`,
    `evm:1:${"B".repeat(64)}:0`,
    `evm:1:${"b".repeat(64)}:01`,
    `evm:9007199254740992:${"b".repeat(64)}:0`,
    `solana:localnet:${"1".repeat(64)}:0`,
    `solana:mainnet:${"1".repeat(63)}:0`,
    `solana:mainnet:${"1".repeat(65)}:0`,
    `solana:mainnet:${"0".repeat(64)}:0`,
    `solana:mainnet:${"1".repeat(64)}:01`,
    `solana:mainnet:${"1".repeat(64)}:9007199254740992`,
  ])("rejects non-canonical SB-1 identity %s", (value) => {
    expect(isCanonicalSettlementIdentity(value)).toBe(false);
  });
});
