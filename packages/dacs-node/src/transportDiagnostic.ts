import { randomBytes } from "node:crypto";

import { generateCanonicalJobId } from "@kynesyslabs/dacs/negotiate";

import {
  createDacsDemosIdentityResolverV1,
  type DacsDemosActorRuntimeV1,
} from "./demosRuntime.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";
import {
  DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS,
  createDacsHttpEnvelopeV1,
  generateDacsHttpNonceV1,
} from "./transport/envelope.js";
import { createDacsHttpMessageClientV1 } from "./transport/http.js";

export interface DacsTransportDiagnosticResultV1 {
  authenticated: boolean;
  durable: boolean;
  acknowledged: boolean;
  noAction: boolean;
}

export class DacsTransportDiagnosticError extends Error {
  override readonly name = "DacsTransportDiagnosticError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    value.trim() === value && !value.includes("\0");
}

/**
 * Exercise one authenticated role-to-role transport direction without
 * invoking a commerce callback. The reserved diagnostic is retained in the
 * normal durable outbox, and success requires a Demos-resolved signed ACK plus
 * the acknowledged record's durable readback.
 */
export async function runDacsRoleTransportDiagnosticV1(options: Readonly<{
  role: "buyer" | "seller";
  database: DacsNodeSqliteDatabase;
  demos: Readonly<DacsDemosActorRuntimeV1>;
  peerAuthority: string;
  peerEndpoint: string;
  workerId: string;
  fetch?: typeof fetch;
}>): Promise<Readonly<DacsTransportDiagnosticResultV1>> {
  if (options === null || typeof options !== "object" ||
      (options.role !== "buyer" && options.role !== "seller") ||
      options.database === null || typeof options.database !== "object" ||
      options.database.metadata?.role !== options.role ||
      options.demos === null || typeof options.demos !== "object" ||
      options.demos.role !== options.role ||
      options.demos.authority !== options.database.metadata.authority ||
      !nonEmpty(options.peerAuthority) || !nonEmpty(options.peerEndpoint) ||
      !nonEmpty(options.workerId) ||
      typeof options.demos.signTransportEnvelope !== "function" ||
      (options.fetch !== undefined && typeof options.fetch !== "function")) {
    throw new TypeError("transport diagnostic options are invalid");
  }
  const outbox = options.database.createHttpOutboxStore();
  const resolveIdentity = createDacsDemosIdentityResolverV1({
    runtime: options.demos,
    peerAuthority: options.peerAuthority,
    peerRole: options.role === "buyer" ? "seller" : "buyer",
  });
  const client = createDacsHttpMessageClientV1({
    endpoint: options.peerEndpoint,
    authority: options.demos.authority,
    outbox,
    resolveIdentity,
    workerId: options.workerId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  try {
    const issuedAt = await outbox.readTime();
    const expiresAt = issuedAt + DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
      throw new DacsTransportDiagnosticError("transport-diagnostic-clock-invalid");
    }
    const envelope = await createDacsHttpEnvelopeV1({
      type: options.role === "buyer"
        ? "diagnostic-probe-buyer" as const
        : "diagnostic-probe-seller" as const,
      jobId: generateCanonicalJobId({ timestamp: issuedAt }),
      sender: options.demos.authority,
      audience: options.peerAuthority,
      issuedAt,
      expiresAt,
      nonce: generateDacsHttpNonceV1(),
      payload: Object.freeze({
        purpose: "transport-readiness" as const,
        challenge: randomBytes(32).toString("base64url"),
      }),
    }, options.demos.signTransportEnvelope);
    const acknowledgement = await client.send(envelope);
    const retained = await outbox.load(envelope.envelopeId);
    const acknowledged = acknowledgement.envelope.type === "acknowledgement" &&
      (acknowledgement.envelope.payload.disposition === "accepted" ||
        acknowledgement.envelope.payload.disposition === "existing");
    const durable = retained?.state === "acknowledged" &&
      retained.acknowledgement?.authenticationHash === acknowledgement.authenticationHash;
    if (!acknowledged || !durable) {
      throw new DacsTransportDiagnosticError("transport-diagnostic-not-retained");
    }
    return Object.freeze({
      authenticated: true,
      durable: true,
      acknowledged: true,
      noAction: true,
    });
  } catch (error) {
    if (error instanceof DacsTransportDiagnosticError) throw error;
    throw new DacsTransportDiagnosticError("transport-diagnostic-unavailable");
  }
}
