export const TELEMETRY_SOURCE = `import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

import type { DacsNodeEvent, DacsNodeEventSink } from "@kynesyslabs/dacs-node";

import { loadRoleConfig } from "./config.js";

const TELEMETRY_SCHEMA = "dacs-generated-commerce-timing/v1" as const;
const MAX_EVENT_BYTES = 65_536;
const MAX_LOG_BYTES = 67_108_864;
type Role = "buyer" | "seller";

function telemetryPath(role: Role): string {
  return resolve(loadRoleConfig(role).dataDirectory, "telemetry", "events.jsonl");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const observed = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!observed.isDirectory() ||
        (process.platform !== "win32" && (observed.mode & 0o077) !== 0) ||
        (uid !== undefined && observed.uid !== uid)) {
      throw new Error("telemetry-directory-unsafe");
    }
  } finally {
    await handle.close();
  }
}

async function appendEvent(role: Role, event: Readonly<DacsNodeEvent>): Promise<void> {
  if (event.role !== role) throw new Error("telemetry-role-mismatch");
  const path = telemetryPath(role);
  await privateDirectory(resolve(path, ".."));
  const encoded = Buffer.from(JSON.stringify(event) + "\\n", "utf8");
  if (encoded.byteLength > MAX_EVENT_BYTES) throw new Error("telemetry-event-too-large");
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const before = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!before.isFile() ||
        (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) ||
        (uid !== undefined && before.uid !== uid)) {
      throw new Error("telemetry-file-unsafe");
    }
    if (before.size + encoded.byteLength > MAX_LOG_BYTES) {
      throw new Error("telemetry-capacity-reached");
    }
    await handle.writeFile(encoded);
    await handle.sync();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size + encoded.byteLength) {
      throw new Error("telemetry-file-changed");
    }
  } finally {
    await handle.close();
  }
}

export function createGeneratedTelemetrySinkV1(role: Role): Readonly<DacsNodeEventSink> {
  let tail = Promise.resolve();
  return Object.freeze({
    emit(event: Readonly<DacsNodeEvent>): Promise<void> {
      if (event.level === "debug" && event.code === "service-worker-cycle-complete") {
        return tail;
      }
      const operation = tail.then(async () => {
        await appendEvent(role, event);
        process.stderr.write(JSON.stringify({ event: "dacs.live-service.event", ...event }) + "\\n");
      });
      tail = operation.catch(() => undefined);
      return operation;
    },
  });
}

interface RetainedEvent {
  occurredAt: number;
  role: Role;
  code: string;
  jobId?: string;
  details?: Readonly<Record<string, unknown>>;
}

function retainedEvent(value: unknown): RetainedEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("telemetry-event-invalid");
  }
  const event = value as Record<string, unknown>;
  const detailsValid = event.details === undefined ||
    event.details !== null && typeof event.details === "object" &&
    !Array.isArray(event.details) &&
    Object.values(event.details).every((item) =>
      item === null || typeof item === "string" || typeof item === "number" ||
      typeof item === "boolean");
  if (event.version !== 1 || !Number.isSafeInteger(event.occurredAt) ||
      Number(event.occurredAt) <= 0 ||
      (event.role !== "buyer" && event.role !== "seller") ||
      typeof event.code !== "string" || event.code.length === 0 || event.code.length > 256 ||
      (event.jobId !== undefined && (typeof event.jobId !== "string" ||
        event.jobId.length === 0 || event.jobId.length > 512)) ||
      !detailsValid) {
    throw new Error("telemetry-event-invalid");
  }
  return Object.freeze({
    occurredAt: Number(event.occurredAt),
    role: event.role,
    code: event.code,
    ...(event.jobId === undefined ? {} : { jobId: event.jobId }),
    ...(event.details === undefined ? {} : {
      details: Object.freeze({ ...(event.details as Record<string, unknown>) }),
    }),
  });
}

async function readEvents(role: Role): Promise<Readonly<{
  events: readonly RetainedEvent[];
  incompleteTail: boolean;
}>> {
  const path = telemetryPath(role);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ events: Object.freeze([]), incompleteTail: false });
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!before.isFile() || before.size > MAX_LOG_BYTES ||
        (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) ||
        (uid !== undefined && before.uid !== uid)) throw new Error("telemetry-file-unsafe");
    const encoded = await handle.readFile("utf8");
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("telemetry-file-changed");
    }
    const incompleteTail = encoded.length > 0 && !encoded.endsWith("\\n");
    const lines = encoded.split("\\n");
    if (incompleteTail) lines.pop();
    else if (lines.at(-1) === "") lines.pop();
    return Object.freeze({
      events: Object.freeze(lines.map((line) => retainedEvent(JSON.parse(line)))),
      incompleteTail,
    });
  } finally {
    await handle.close();
  }
}

function first(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values);
}

function successfulTrack(
  events: readonly RetainedEvent[],
  role: Role,
  track: string,
): number | undefined {
  return first(events.flatMap((event) =>
    event.role === role && event.code === "order-track-processed" &&
      event.details?.track === track && event.details.state === "final" &&
      event.details.outcome === "success" ? [event.occurredAt] : []));
}

export async function readGeneratedCommerceTimingV1(jobId: string) {
  if (jobId.length === 0 || jobId.length > 512 || jobId.trim() !== jobId) {
    throw new Error("telemetry-job-id-invalid");
  }
  const [buyer, seller] = await Promise.all([readEvents("buyer"), readEvents("seller")]);
  const events = [...buyer.events, ...seller.events]
    .filter((event) => event.jobId === jobId);
  const explicitStarts = events.flatMap((event) =>
    event.code === "order-started" ? [event.occurredAt] : []);
  const startAt = first(explicitStarts) ?? first(events.map((event) => event.occurredAt));
  const sellerReadyAt = successfulTrack(events, "seller", "delivery");
  const buyerReceivedAt = successfulTrack(events, "buyer", "buyer-received");
  const commerceCompleteAt = successfulTrack(events, "seller", "delivery-evidence");
  const buyerAuditAt = successfulTrack(events, "buyer", "audit");
  const sellerAuditAt = successfulTrack(events, "seller", "audit");
  const auditCompleteAt = buyerAuditAt === undefined || sellerAuditAt === undefined
    ? undefined : Math.max(buyerAuditAt, sellerAuditAt);
  const milestone = (at: number | undefined) => at === undefined ? null : Object.freeze({
    occurredAt: at,
    elapsedMs: startAt === undefined ? null : Math.max(0, at - startAt),
  });
  return Object.freeze({
    schema: TELEMETRY_SCHEMA,
    evidenceClass: "operational-telemetry-not-normative-proof" as const,
    jobId,
    start: startAt === undefined ? null : Object.freeze({
      occurredAt: startAt,
      source: explicitStarts.length === 0 ? "first-retained-event" : "order-started",
    }),
    milestones: Object.freeze({
      sellerReady: milestone(sellerReadyAt),
      buyerReceived: milestone(buyerReceivedAt),
      commerceComplete: milestone(commerceCompleteAt),
      auditComplete: milestone(auditCompleteAt),
    }),
    roleAudit: Object.freeze({
      buyer: milestone(buyerAuditAt),
      seller: milestone(sellerAuditAt),
    }),
    log: Object.freeze({
      matchingEvents: events.length,
      incompleteTail: buyer.incompleteTail || seller.incompleteTail,
    }),
  });
}
`;
