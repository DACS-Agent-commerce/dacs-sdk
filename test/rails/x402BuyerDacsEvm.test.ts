import { x402Client, x402HTTPClient } from "@x402/core/client";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { keccak256, recoverTypedDataAddress, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";

import {
  createDacsX402BuyerEvmChallengeClient,
  prepareX402BuyerSettlement,
  type PrepareX402BuyerSettlementInput,
  type X402BuyerPaymentRequirements,
} from "../../src/rails/index.js";
import { x402Eip3009Nonce } from "../../src/seller/paymentIntake.js";

// Derive deterministic, test-only accounts at runtime so the repository never
// contains text that can be mistaken for deployable wallet material.
const PRIVATE_KEY = keccak256(
  stringToHex("dacs-sdk:test:x402-buyer:primary"),
);
const OTHER_PRIVATE_KEY = keccak256(
  stringToHex("dacs-sdk:test:x402-buyer:other"),
);
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const JOB_ID = "job-real-x402-dacs-nonce";
const PHASE_INDEX = 4;
const NETWORK = "eip155:84532" as const;
const PAYEE = "0x1111111111111111111111111111111111111111";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RESOURCE = "https://seller.example/deliver/job-real-x402-dacs-nonce";
const AMOUNT = "1000";
const EXPECTED_NONCE = x402Eip3009Nonce(JOB_ID, PHASE_INDEX) as `0x${string}`;

function authority(): PrepareX402BuyerSettlementInput["authority"] {
  return {
    jobId: JOB_ID,
    phaseIndex: PHASE_INDEX,
    railId: "x402:base-sepolia",
    railVersion: "2",
    railDescriptorHash: "a".repeat(64),
    agreementHash: "b".repeat(64),
    termsHash: "c".repeat(64),
    sessionBindingHash: "d".repeat(64),
    network: NETWORK,
    payer: ACCOUNT.address,
    payee: PAYEE,
    asset: ASSET,
    amount: AMOUNT,
    httpResource: RESOURCE,
    method: "GET",
  };
}

function requirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements & X402BuyerPaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: AMOUNT,
    payTo: PAYEE,
    maxTimeoutSeconds: 120,
    extra: {
      name: "USD Coin",
      version: "2",
      assetTransferMethod: "eip3009",
    },
    ...overrides,
  } as PaymentRequirements & X402BuyerPaymentRequirements;
}

function challenge(
  accepts: PaymentRequirements[] = [requirements()],
  resource = RESOURCE,
): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: resource },
    accepts,
  };
}

function challengeFetch(paymentRequired: PaymentRequired) {
  let requests = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests += 1;
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("PAYMENT-SIGNATURE")).toBe(false);
    return new Response(null, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      },
    });
  };
  return { fetchImpl, requests: () => requests };
}

describe("createDacsX402BuyerEvmChallengeClient", () => {
  test("interoperates with real x402 v2 headers and signs the exact DACS nonce", async () => {
    const client = await createDacsX402BuyerEvmChallengeClient({
      evmPrivateKey: PRIVATE_KEY,
      authority: authority(),
      expectedRequirements: requirements(),
    });
    const transport = challengeFetch(challenge());

    const result = await prepareX402BuyerSettlement(
      { authority: authority() },
      { client, fetchImpl: transport.fetchImpl },
    );

    expect(result.disposition).toBe("prepared");
    expect(transport.requests()).toBe(1);
    expect(client.address).toBe(ACCOUNT.address);
    expect(client.authorizationNonce).toBe(EXPECTED_NONCE);
    if (result.disposition !== "prepared") return;
    expect(result.intent.authorizationNonce).toBe(EXPECTED_NONCE);

    const decoded = decodePaymentSignatureHeader(result.intent.paymentHeader.value);
    expect(decoded).toEqual(result.intent.signedPaymentPayload);
    const payload = decoded.payload as {
      authorization: {
        from: `0x${string}`;
        to: `0x${string}`;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: `0x${string}`;
      };
      signature: `0x${string}`;
    };
    expect(payload.authorization.nonce).toBe(EXPECTED_NONCE);
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 84532,
        verifyingContract: ASSET,
      },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payload.authorization.from,
        to: payload.authorization.to,
        value: BigInt(payload.authorization.value),
        validAfter: BigInt(payload.authorization.validAfter),
        validBefore: BigInt(payload.authorization.validBefore),
        nonce: payload.authorization.nonce,
      },
      signature: payload.signature,
    });
    expect(recovered.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
  });

  test("accepts the standard Exact EVM wire challenge without a private method marker", async () => {
    const wireRequirements = requirements({
      extra: { name: "USD Coin", version: "2" },
    });
    const client = await createDacsX402BuyerEvmChallengeClient({
      evmPrivateKey: PRIVATE_KEY,
      authority: authority(),
      expectedRequirements: wireRequirements,
    });
    const result = await prepareX402BuyerSettlement(
      { authority: authority() },
      { client, fetchImpl: challengeFetch(challenge([wireRequirements])).fetchImpl },
    );
    expect(result.disposition).toBe("prepared");
    if (result.disposition === "prepared") {
      expect(result.intent.chosenRequirements.extra).toEqual({
        name: "USD Coin",
        version: "2",
      });
      expect(result.intent.signedPaymentPayload.accepted).toEqual(wireRequirements);
    }
  });

  test("rejects the stock ExactEvmScheme random nonce at durable preparation", async () => {
    const core = new x402Client().register(
      NETWORK,
      new ExactEvmScheme(ACCOUNT),
    );
    const stockClient = new x402HTTPClient(core);
    const paymentRequired = challenge();
    const stockPayload = await stockClient.createPaymentPayload(paymentRequired);
    const stockAuthorization = stockPayload.payload.authorization as { nonce: string };
    expect(stockAuthorization.nonce).not.toBe(EXPECTED_NONCE);
    const stockChallengeClient = {
      getPaymentRequiredResponse: stockClient.getPaymentRequiredResponse.bind(stockClient),
      async createPaymentPayload(value: unknown) {
        const payload = await stockClient.createPaymentPayload(value as PaymentRequired);
        const { extensions: _extensions, ...wirePayload } = payload;
        return wirePayload;
      },
      encodePaymentSignatureHeader:
        stockClient.encodePaymentSignatureHeader.bind(stockClient),
    };

    const result = await prepareX402BuyerSettlement(
      { authority: authority() },
      {
        client: stockChallengeClient,
        fetchImpl: challengeFetch(paymentRequired).fetchImpl,
      },
    );
    expect(result).toEqual({
      disposition: "rejected",
      reason: "x402-payment-signature-scope-mismatch",
    });
  });

  test("rejects network, payee, asset, amount, resource and domain substitution", async () => {
    const client = await createDacsX402BuyerEvmChallengeClient({
      evmPrivateKey: PRIVATE_KEY,
      authority: authority(),
      expectedRequirements: requirements(),
    });
    const cases: Array<[string, PaymentRequired]> = [
      ["network", challenge([requirements({ network: "eip155:8453" })])],
      ["payee", challenge([requirements({
        payTo: "0x2222222222222222222222222222222222222222",
      })])],
      ["asset", challenge([requirements({
        asset: "0x3333333333333333333333333333333333333333",
      })])],
      ["amount", challenge([requirements({ amount: "1001" })])],
      ["resource", challenge([requirements()], `${RESOURCE}/substituted`)],
      ["domain", challenge([requirements({
        extra: {
          name: "Substituted Coin",
          version: "2",
          assetTransferMethod: "eip3009",
        },
      })])],
    ];

    for (const [label, paymentRequired] of cases) {
      const result = await prepareX402BuyerSettlement(
        { authority: authority() },
        {
          client,
          fetchImpl: challengeFetch(paymentRequired).fetchImpl,
        },
      );
      expect(result, label).toEqual({
        disposition: "rejected",
        reason: "x402-payment-requirements-mismatch",
      });
    }

    await expect(client.createPaymentPayload(challenge([requirements({
      extra: {
        name: "Substituted Coin",
        version: "2",
        assetTransferMethod: "eip3009",
      },
    })]))).rejects.toThrow(/do not match DACS signing authority/);
  });

  test("skips a substituted domain and signs a later exactly authorized option", async () => {
    const expected = requirements();
    const client = await createDacsX402BuyerEvmChallengeClient({
      evmPrivateKey: PRIVATE_KEY,
      authority: authority(),
      expectedRequirements: expected,
    });
    const substituted = requirements({
      extra: { name: "USD Coin", version: "1", assetTransferMethod: "eip3009" },
    });
    const paymentRequired = challenge([substituted, expected]);

    const result = await prepareX402BuyerSettlement(
      { authority: authority() },
      {
        client,
        fetchImpl: challengeFetch(paymentRequired).fetchImpl,
      },
    );
    expect(result.disposition).toBe("prepared");
    if (result.disposition === "prepared") {
      expect(result.intent.chosenRequirements.extra).toEqual(expected.extra);
    }
  });

  test("refuses a key that does not control the authenticated payer", async () => {
    await expect(createDacsX402BuyerEvmChallengeClient({
      evmPrivateKey: OTHER_PRIVATE_KEY,
      authority: authority(),
      expectedRequirements: requirements(),
    })).rejects.toThrow(/does not control/);
  });

  test("snapshots the private key before optional-peer initialization", async () => {
    const config = {
      evmPrivateKey: PRIVATE_KEY,
      authority: authority(),
      expectedRequirements: requirements(),
    };
    const creating = createDacsX402BuyerEvmChallengeClient(config);
    config.evmPrivateKey = OTHER_PRIVATE_KEY;

    await expect(creating).resolves.toMatchObject({ address: ACCOUNT.address });
  });

  test("rejects accessor and proxy configs without invoking user code", async () => {
    let accessorReads = 0;
    const accessorConfig = {
      get evmPrivateKey() {
        accessorReads += 1;
        return PRIVATE_KEY;
      },
      authority: authority(),
      expectedRequirements: requirements(),
    };
    await expect(createDacsX402BuyerEvmChallengeClient(accessorConfig))
      .rejects.toThrow(/own data properties/);
    expect(accessorReads).toBe(0);

    let proxyTraps = 0;
    const proxyConfig = new Proxy({
      evmPrivateKey: PRIVATE_KEY,
      authority: authority(),
      expectedRequirements: requirements(),
    }, {
      get(target, key, receiver) {
        proxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf(target) {
        proxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    await expect(createDacsX402BuyerEvmChallengeClient(proxyConfig))
      .rejects.toThrow(/plain data record/);
    expect(proxyTraps).toBe(0);
  });
});
