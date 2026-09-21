import { randomUUID } from "node:crypto";

import {
  resumeWalletSpendAuthorityOperationV1,
  type WalletSpendAuthorityReplayV1,
  type WalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationClaimV1,
  type WalletSpendReservationV1,
  type WalletSpendSettlementObservationV1,
  type WalletSpendStatusV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import { loadDacsSecretV1 } from "./secrets.js";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const HASH_RE = /^[0-9a-f]{64}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]*)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DENIAL_REASONS = new Set([
  "balance-unavailable", "insufficient-reserve", "per-order-limit",
  "network-fee-limit", "rolling-limit", "cumulative-limit",
  "counterparty-limit", "concurrency-limit", "retention-limit",
  "operator-approval-required", "operator-approval-invalid",
]);

type RemoteOperation = "reserve" | "current" | "begin" | "settle" |
  "reconcile" | "inspect";

interface RemoteRequestV1 {
  protocolVersion: "1";
  operationId: string;
  policyHash: string;
  wallet: string;
  chainId: string;
  operation: RemoteOperation;
  payload: unknown;
}

interface RemoteResponseV1 {
  protocolVersion: "1";
  operationId: string;
  requestHash: string;
  revision: number;
  status: "ok";
  result: unknown;
}

export interface DacsWalletSpendRemoteOperationStoreV1 {
  load(input: Readonly<{
    roleId: string;
    operationId: string;
  }>): Promise<Readonly<{
    requestHash: string;
    request: Readonly<RemoteRequestV1>;
    response?: Readonly<RemoteResponseV1>;
  }> | undefined>;
  claim(input: Readonly<{
    roleId: string;
    operationId: string;
    requestHash: string;
    request: Readonly<RemoteRequestV1>;
  }>): Promise<"new" | "existing">;
  complete(input: Readonly<{
    roleId: string;
    operationId: string;
    requestHash: string;
    response: Readonly<RemoteResponseV1>;
  }>): Promise<void>;
}

export class DacsWalletSpendRemoteError extends Error {
  override readonly name = "DacsWalletSpendRemoteError";

  constructor(
    readonly reasonCode: string,
    readonly operationId?: string,
    readonly requestHash?: string,
  ) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function loopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return value === "localhost" || value.endsWith(".localhost") || value === "[::1]" ||
    value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function endpointUrl(value: string, allowInsecureLoopback: boolean): URL {
  const endpoint = new URL(value);
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" ||
      endpoint.hash !== "" || endpoint.pathname !== "/") {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-endpoint-invalid");
  }
  if (endpoint.protocol !== "https:" &&
      !(allowInsecureLoopback && endpoint.protocol === "http:" && loopback(endpoint.hostname))) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-tls-required");
  }
  return endpoint;
}

function responseShape(value: unknown): value is RemoteResponseV1 {
  return plainObject(value) && exact(value, [
    "protocolVersion", "operationId", "requestHash", "revision", "status", "result",
  ]) && value.protocolVersion === "1" && typeof value.operationId === "string" &&
    UUID_RE.test(value.operationId) && typeof value.requestHash === "string" &&
    HASH_RE.test(value.requestHash) && Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 && value.status === "ok";
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_BODY_BYTES)) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-response-too-large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-response-size-invalid");
  }
  if (declared !== null && Number(declared) !== bytes.byteLength) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-response-size-invalid");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-response-invalid");
  }
}

function serializeClaim(claim: WalletSpendReservationClaimV1): unknown {
  if (claim.status !== "reserved") return claim;
  return {
    status: "reserved",
    permit: {
      reservationId: claim.permit.reservationId,
      bindingHash: claim.permit.bindingHash,
      settlementBindingHash: claim.permit.settlementBindingHash,
      owner: claim.permit.owner,
      generation: claim.permit.generation,
      reservation: claim.permit.reservation,
    },
  };
}

interface RemotePermitDataV1 {
  reservationId: string;
  bindingHash: string;
  settlementBindingHash: string;
  owner: string;
  generation: number;
  reservation: Readonly<WalletSpendReservationV1>;
}

function permitData(value: unknown): RemotePermitDataV1 {
  if (!plainObject(value) || !exact(value, [
    "reservationId", "bindingHash", "settlementBindingHash", "owner", "generation",
    "reservation",
  ]) || typeof value.reservationId !== "string" ||
      typeof value.bindingHash !== "string" || !HASH_RE.test(value.bindingHash) ||
      typeof value.settlementBindingHash !== "string" ||
      !HASH_RE.test(value.settlementBindingHash) || typeof value.owner !== "string" ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) <= 0 ||
      !plainObject(value.reservation)) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-permit-invalid");
  }
  return value as unknown as RemotePermitDataV1;
}

function remoteClaim(
  value: unknown,
  expectedReservation: Readonly<WalletSpendReservationV1>,
): WalletSpendReservationClaimV1 {
  if (!plainObject(value) || typeof value.status !== "string") {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
  }
  if (value.status === "reserved") {
    if (!exact(value, ["status", "permit"])) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
    }
    const retained = permitData(value.permit);
    if (canonicalize(retained.reservation) !== canonicalize(expectedReservation)) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
    }
    return value as unknown as WalletSpendReservationClaimV1;
  }
  if (value.status === "held") {
    if (!exact(value, ["status", "bindingHash", "stage"]) ||
        typeof value.bindingHash !== "string" || !HASH_RE.test(value.bindingHash) ||
        (value.stage !== "reserved" && value.stage !== "effect-pending")) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
    }
  } else if (value.status === "settled" || value.status === "released") {
    if (!exact(value, ["status", "bindingHash", "evidenceHash"]) ||
        typeof value.bindingHash !== "string" || !HASH_RE.test(value.bindingHash) ||
        typeof value.evidenceHash !== "string" || !HASH_RE.test(value.evidenceHash)) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
    }
  } else if (value.status === "conflict") {
    if (!exact(value, ["status", "bindingHash"]) ||
        typeof value.bindingHash !== "string" || !HASH_RE.test(value.bindingHash)) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
    }
  } else if (value.status === "denied") {
    if (!exact(value, ["status", "reason"]) || typeof value.reason !== "string" ||
        !DENIAL_REASONS.has(value.reason)) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
    }
  } else {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-claim-invalid");
  }
  return value as unknown as WalletSpendReservationClaimV1;
}

function remoteStatus(value: unknown): Readonly<WalletSpendStatusV1> {
  if (!plainObject(value) || !exact(value, [
    "revision", "policyId", "policyHash", "wallet", "chainId",
    "maximumConcurrentEffects", "activeEffects", "retainedReservations",
    "maximumRetainedReservations", "operatorActionReservations", "assets",
  ]) || !nonnegativeInteger(value.revision) ||
      typeof value.policyId !== "string" || typeof value.policyHash !== "string" ||
      !HASH_RE.test(value.policyHash) || typeof value.wallet !== "string" ||
      typeof value.chainId !== "string" ||
      !nonnegativeInteger(value.maximumConcurrentEffects) ||
      !nonnegativeInteger(value.activeEffects) ||
      !nonnegativeInteger(value.retainedReservations) ||
      !nonnegativeInteger(value.maximumRetainedReservations) ||
      !Array.isArray(value.operatorActionReservations) ||
      !value.operatorActionReservations.every((entry) => typeof entry === "string") ||
      !Array.isArray(value.assets)) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-status-invalid");
  }
  const requiredAssetFields = [
    "asset", "maximumPerOrderDebit", "maximumNetworkFeeDebit", "minimumReserve",
    "rollingWindowMs", "maximumRollingEffects", "maximumRollingDebit",
    "maximumCumulativeDebit", "maximumCounterpartyDebit", "balance",
    "reservedWorstCaseDebit", "rollingSettledDebit", "cumulativeSettledDebit",
    "availableHeadroom",
  ] as const;
  for (const asset of value.assets) {
    if (!plainObject(asset) || ![
      requiredAssetFields.length, requiredAssetFields.length + 1,
    ].includes(Object.keys(asset).length) ||
        !requiredAssetFields.every((field) => Object.hasOwn(asset, field)) ||
        (Object.keys(asset).some((field) =>
          !requiredAssetFields.includes(field as typeof requiredAssetFields[number]) &&
          field !== "operatorApprovalThreshold")) ||
        typeof asset.asset !== "string" ||
        !["maximumPerOrderDebit", "maximumNetworkFeeDebit", "minimumReserve",
          "maximumRollingDebit", "maximumCumulativeDebit", "maximumCounterpartyDebit",
          "reservedWorstCaseDebit", "rollingSettledDebit", "cumulativeSettledDebit"]
          .every((field) => typeof asset[field] === "string" &&
            AMOUNT_RE.test(asset[field] as string)) ||
        !nonnegativeInteger(asset.rollingWindowMs) ||
        !nonnegativeInteger(asset.maximumRollingEffects) ||
        (asset.balance !== null && (typeof asset.balance !== "string" ||
          !AMOUNT_RE.test(asset.balance))) ||
        (asset.availableHeadroom !== null &&
          (typeof asset.availableHeadroom !== "string" ||
            !AMOUNT_RE.test(asset.availableHeadroom))) ||
        (asset.operatorApprovalThreshold !== undefined &&
          (typeof asset.operatorApprovalThreshold !== "string" ||
            !AMOUNT_RE.test(asset.operatorApprovalThreshold)))) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-status-invalid");
    }
  }
  return value as unknown as Readonly<WalletSpendStatusV1>;
}

/** Funded-agent client. It exposes only the existing narrow authority surface. */
export async function createDacsRemoteWalletSpendAuthorityV1(input: Readonly<{
  policy: Readonly<WalletSpendPolicyV1>;
  endpoint: string;
  tokenFilePath: string;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}>): Promise<Readonly<WalletSpendAuthorityV1>> {
  const endpoint = endpointUrl(input.endpoint, input.allowInsecureLoopback === true);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-timeout-invalid");
  }
  const requestFetch = input.fetch ?? globalThis.fetch;
  const secret = await loadDacsSecretV1({
    name: "wallet-spend-authority-token",
    mode: "live-demos",
    filePath: input.tokenFilePath,
  });
  const token = secret.text().trim();
  secret.destroy();
  if (token.length < 32 || token.length > 4_096 || /[\0\r\n]/.test(token)) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-token-invalid");
  }
  const policy = Object.freeze(JSON.parse(canonicalize(input.policy)) as WalletSpendPolicyV1);
  const policyHash = sha256Hex(`dacs-wallet-spend-policy:v1:${canonicalize(policy)}`);
  let latestRevision = -1;

  const send = async (operation: RemoteOperation, payload: unknown): Promise<unknown> => {
    const operationId = randomUUID();
    const request: RemoteRequestV1 = {
      protocolVersion: "1",
      operationId,
      policyHash,
      wallet: policy.wallet,
      chainId: policy.chainId,
      operation,
      payload,
    };
    const requestHash = sha256Hex(canonicalize(request));
    const resolveExactOperation = async (): Promise<unknown> => {
      const query = new URL(`v1/wallet-spend/operations/${operationId}`, endpoint);
      query.searchParams.set("requestHash", requestHash);
      const resolved = await requestFetch(query, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const resolvedBody = await boundedJson(resolved);
      if (!resolved.ok || !responseShape(resolvedBody) ||
          resolvedBody.operationId !== operationId ||
          resolvedBody.requestHash !== requestHash ||
          resolvedBody.revision < latestRevision) {
        throw new DacsWalletSpendRemoteError(
          "wallet-spend-authority-operation-unresolved",
          operationId,
          requestHash,
        );
      }
      latestRevision = resolvedBody.revision;
      return resolvedBody.result;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await requestFetch(new URL("v1/wallet-spend/operations", endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(canonicalize(request), "utf8")),
        },
        body: canonicalize(request),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      try {
        if (operation !== "inspect") return await resolveExactOperation();
      } catch { /* preserve the exact unknown operation identity below */ }
      throw new DacsWalletSpendRemoteError(
        "wallet-spend-authority-outcome-unknown",
        operationId,
        requestHash,
      );
    }
    clearTimeout(timer);
    let body: unknown;
    try {
      body = await boundedJson(response);
    } catch (error) {
      if (operation !== "inspect") {
        try { return await resolveExactOperation(); } catch {
          throw new DacsWalletSpendRemoteError(
            "wallet-spend-authority-outcome-unknown",
            operationId,
            requestHash,
          );
        }
      }
      throw error;
    }
    if (!response.ok || !responseShape(body) || body.operationId !== operationId ||
        body.requestHash !== requestHash || body.revision < latestRevision) {
      if (operation !== "inspect") {
        try { return await resolveExactOperation(); } catch { /* report the initial refusal */ }
      }
      throw new DacsWalletSpendRemoteError(
        body && plainObject(body) && exact(body, ["reasonCode"]) &&
            typeof body.reasonCode === "string"
          ? body.reasonCode : "wallet-spend-authority-response-invalid",
        operationId,
      );
    }
    latestRevision = body.revision;
    return body.result;
  };

  const remotePermit = (raw: unknown) => {
    const retained = permitData(raw);
    const invoke = async (
      operation: "current" | "begin" | "settle",
      observation?: unknown,
    ): Promise<void> => {
      const result = await send(operation, {
        permit: retained,
        ...(observation === undefined ? {} : { observation }),
      });
      if (result !== null) {
        throw new DacsWalletSpendRemoteError("wallet-spend-authority-response-invalid");
      }
    };
    return Object.freeze({
      ...retained,
      assertCurrent: async () => { await invoke("current"); },
      beginEffect: async () => { await invoke("begin"); },
      settle: async (observation: Readonly<WalletSpendSettlementObservationV1>) => {
        await invoke("settle", observation);
      },
    });
  };

  const authority: WalletSpendAuthorityV1 = {
    policy,
    policyHash,
    async reserve(reservation, options = {}) {
      const result = await send("reserve", { reservation, options });
      const claim = remoteClaim(result, reservation);
      return claim.status === "reserved"
        ? { status: "reserved" as const, permit: remotePermit(
            (result as Record<string, unknown>).permit,
          ) }
        : claim;
    },
    async reconcile(reservation, observation) {
      const result = await send("reconcile", { reservation, observation });
      if (result !== "settled" && result !== "released" && result !== "existing") {
        throw new DacsWalletSpendRemoteError("wallet-spend-authority-reconcile-invalid");
      }
      return result;
    },
    async inspect() {
      const result = await send("inspect", {});
      const status = remoteStatus(result);
      if (status.revision !== latestRevision || status.policyHash !== policyHash ||
          status.wallet !== policy.wallet || status.chainId !== policy.chainId ||
          status.policyId !== policy.policyId) {
        throw new DacsWalletSpendRemoteError("wallet-spend-authority-status-invalid");
      }
      return status;
    },
  };
  return Object.freeze(authority);
}

function bearer(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer ([^\s]{32,4096})$/.exec(authorization ?? "");
  return match?.[1] ?? null;
}

async function requestJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_BODY_BYTES)) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-request-too-large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES ||
      (declared !== null && Number(declared) !== bytes.byteLength)) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-request-size-invalid");
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-request-invalid");
  }
}

function captureRequest(value: unknown): RemoteRequestV1 {
  if (!plainObject(value) || !exact(value, [
    "protocolVersion", "operationId", "policyHash", "wallet", "chainId",
    "operation", "payload",
  ]) || value.protocolVersion !== "1" || typeof value.operationId !== "string" ||
      !UUID_RE.test(value.operationId) || typeof value.policyHash !== "string" ||
      !HASH_RE.test(value.policyHash) || typeof value.wallet !== "string" ||
      value.wallet.length === 0 || typeof value.chainId !== "string" ||
      value.chainId.length === 0 || ![
        "reserve", "current", "begin", "settle", "reconcile", "inspect",
      ].includes(value.operation as string) || !plainObject(value.payload)) {
    throw new DacsWalletSpendRemoteError("wallet-spend-authority-request-invalid");
  }
  return value as unknown as RemoteRequestV1;
}

function jsonResponse(value: unknown, status = 200): Response {
  let body = canonicalize(value);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    body = canonicalize({ reasonCode: "wallet-spend-authority-response-too-large" });
    status = 500;
  }
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "content-length": String(
      Buffer.byteLength(body, "utf8"),
    ) },
  });
}

/** Repository-native operator service boundary; it exposes no admin operation. */
export function createDacsWalletSpendAuthorityServiceV1(input: Readonly<{
  authenticate(token: string): Promise<string | null> | string | null;
  /**
   * A PostgreSQL authority resolver must bind roleId/operationId/requestHash
   * to the state store operation callback and use one stable service owner
   * identity. The resolver is called again before any retained response is
   * disclosed.
   */
  resolveAuthority(scope: Readonly<{
    roleId: string;
    operationId: string;
    requestHash: string;
    wallet: string;
    chainId: string;
    policyHash: string;
  }>): Promise<Readonly<WalletSpendAuthorityV1> | null> |
    Readonly<WalletSpendAuthorityV1> | null;
  operations: DacsWalletSpendRemoteOperationStoreV1;
}>): (request: Request) => Promise<Response> {
  const resolveAvailableAuthority = async (
    roleId: string,
    body: Readonly<RemoteRequestV1>,
    requestHash: string,
  ): Promise<Readonly<WalletSpendAuthorityV1>> => {
    const authority = await input.resolveAuthority({
      roleId,
      operationId: body.operationId,
      requestHash,
      wallet: body.wallet,
      chainId: body.chainId,
      policyHash: body.policyHash,
    });
    if (authority === null || authority.policyHash !== body.policyHash ||
        authority.policy.wallet !== body.wallet || authority.policy.chainId !== body.chainId) {
      throw new DacsWalletSpendRemoteError("wallet-spend-authority-lineage-unavailable");
    }
    return authority;
  };

  const executeOperation = async (
    roleId: string,
    body: Readonly<RemoteRequestV1>,
    requestHash: string,
  ): Promise<RemoteResponseV1> => {
    const authority = await resolveAvailableAuthority(roleId, body, requestHash);
    const payload = body.payload as Record<string, unknown>;
    let result: unknown;
    if (body.operation === "inspect") {
      if (!exact(payload, [])) throw new Error("request-shape");
      result = await authority.inspect();
    } else if (body.operation === "reserve") {
      if (!exact(payload, ["reservation", "options"])) throw new Error("request-shape");
      result = serializeClaim(await authority.reserve(
        payload.reservation as Readonly<WalletSpendReservationV1>,
        payload.options as Readonly<{ operatorApproval?: string }>,
      ));
    } else if (body.operation === "reconcile") {
      if (!exact(payload, ["reservation", "observation"])) throw new Error("request-shape");
      result = await authority.reconcile(
        payload.reservation as Readonly<WalletSpendReservationV1>,
        payload.observation as Readonly<WalletSpendRecoveryObservationV1>,
      );
    } else {
      const expected = body.operation === "settle" ? ["permit", "observation"] : ["permit"];
      if (!exact(payload, expected)) throw new Error("request-shape");
      const retained = permitData(payload.permit);
      await resumeWalletSpendAuthorityOperationV1(authority, {
        operation: body.operation,
        permit: retained,
        ...(body.operation === "settle"
          ? { observation: payload.observation as WalletSpendAuthorityReplayV1["observation"] }
          : {}),
      });
      result = null;
    }
    const status = body.operation === "inspect"
      ? result as Readonly<WalletSpendStatusV1>
      : await authority.inspect();
    return {
      protocolVersion: "1",
      operationId: body.operationId,
      requestHash,
      revision: status.revision,
      status: "ok",
      result,
    };
  };

  return async (request) => {
    try {
      const url = new URL(request.url);
      const token = bearer(request);
      if (token === null) {
        return jsonResponse({ reasonCode: "wallet-spend-authority-authentication-required" }, 401);
      }
      const roleId = await input.authenticate(token);
      if (roleId === null || roleId.length === 0 || roleId.trim() !== roleId ||
          roleId.normalize("NFC") !== roleId) {
        return jsonResponse({ reasonCode: "wallet-spend-authority-authentication-invalid" }, 403);
      }
      const queryMatch = /^\/v1\/wallet-spend\/operations\/([0-9a-f-]+)$/i.exec(
        url.pathname,
      );
      if (request.method === "GET" && queryMatch !== null) {
        const operationId = queryMatch[1]!;
        const requestHash = url.searchParams.get("requestHash");
        if (!UUID_RE.test(operationId) || requestHash === null ||
            !HASH_RE.test(requestHash) || [...url.searchParams.keys()].some((key) =>
              key !== "requestHash")) {
          return jsonResponse({ reasonCode: "wallet-spend-authority-query-invalid" }, 400);
        }
        const retained = await input.operations.load({ roleId, operationId });
        if (retained === undefined) {
          return jsonResponse({ reasonCode: "wallet-spend-authority-operation-missing" }, 404);
        }
        if (retained.requestHash !== requestHash) {
          return jsonResponse({ reasonCode: "wallet-spend-authority-operation-conflict" }, 409);
        }
        const retainedRequest = captureRequest(retained.request);
        if (retainedRequest.operationId !== operationId ||
            sha256Hex(canonicalize(retainedRequest)) !== requestHash) {
          throw new Error("stored-request-invalid");
        }
        if (retained.response !== undefined) {
          if (!responseShape(retained.response) ||
              retained.response.operationId !== operationId ||
              retained.response.requestHash !== requestHash) {
            throw new Error("stored-response-invalid");
          }
          await resolveAvailableAuthority(roleId, retainedRequest, requestHash);
          return jsonResponse(retained.response);
        }
        if (retainedRequest.operation === "inspect") {
          throw new Error("stored-request-invalid");
        }
        const resumed = await executeOperation(roleId, retainedRequest, requestHash);
        await input.operations.complete({
          roleId, operationId, requestHash, response: resumed,
        });
        return jsonResponse(resumed);
      }
      if (request.method !== "POST" ||
          url.pathname !== "/v1/wallet-spend/operations" || url.search !== "") {
        return jsonResponse({ reasonCode: "wallet-spend-authority-route-not-found" }, 404);
      }
      const body = captureRequest(await requestJson(request));
      const requestHash = sha256Hex(canonicalize(body));
      const prior = await input.operations.load({ roleId, operationId: body.operationId });
      if (prior !== undefined && (prior.requestHash !== requestHash ||
          canonicalize(prior.request) !== canonicalize(body))) {
        return jsonResponse({ reasonCode: "wallet-spend-authority-operation-conflict" }, 409);
      }
      if (prior?.response !== undefined) {
        if (!responseShape(prior.response) ||
            prior.response.operationId !== body.operationId ||
            prior.response.requestHash !== requestHash) {
          throw new Error("stored-response-invalid");
        }
        await resolveAvailableAuthority(roleId, body, requestHash);
        return jsonResponse(prior.response);
      }
      if (body.operation === "inspect") {
        return jsonResponse(await executeOperation(roleId, body, requestHash));
      }
      await input.operations.claim({
        roleId, operationId: body.operationId, requestHash, request: body,
      });
      const response = await executeOperation(roleId, body, requestHash);
      await input.operations.complete({
        roleId, operationId: body.operationId, requestHash, response,
      });
      return jsonResponse(response);
    } catch (error) {
      const reasonCode = error instanceof DacsWalletSpendRemoteError
        ? error.reasonCode : "wallet-spend-authority-request-rejected";
      return jsonResponse({ reasonCode }, 400);
    }
  };
}

/** Deterministic test/reference operation log; production services use PostgreSQL. */
export function createInMemoryDacsWalletSpendRemoteOperationStoreV1():
  DacsWalletSpendRemoteOperationStoreV1 {
  const values = new Map<string, {
    requestHash: string;
    request: RemoteRequestV1;
    response?: RemoteResponseV1;
  }>();
  const key = (roleId: string, operationId: string) => `${roleId}\0${operationId}`;
  const store: DacsWalletSpendRemoteOperationStoreV1 = {
    async load(input) { return values.get(key(input.roleId, input.operationId)); },
    async claim(input) {
      const identity = key(input.roleId, input.operationId);
      const prior = values.get(identity);
      if (prior !== undefined) {
        if (prior.requestHash !== input.requestHash ||
            canonicalize(prior.request) !== canonicalize(input.request)) {
          throw new DacsWalletSpendRemoteError("wallet-spend-authority-operation-conflict");
        }
        return "existing";
      }
      values.set(identity, {
        requestHash: input.requestHash,
        request: structuredClone(input.request),
      });
      return "new";
    },
    async complete(input) {
      const identity = key(input.roleId, input.operationId);
      const prior = values.get(identity);
      if (prior === undefined || prior.requestHash !== input.requestHash) {
        throw new DacsWalletSpendRemoteError("wallet-spend-authority-operation-conflict");
      }
      if (prior.response !== undefined &&
          canonicalize(prior.response) !== canonicalize(input.response)) {
        throw new DacsWalletSpendRemoteError("wallet-spend-authority-operation-conflict");
      }
      values.set(identity, {
        requestHash: input.requestHash,
        request: prior.request,
        response: input.response,
      });
    },
  };
  return Object.freeze(store);
}
