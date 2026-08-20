import type {
  DacsHttpAcknowledgementV1,
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpEnvelopeV1,
} from "./envelope.js";

/** DACS One-Click Install Specification section 12.4. */
export const DACS_HTTP_MINIMUM_RETENTION_MS = 604_800_000 as const;
/** DACS One-Click Install Specification section 12.5. */
export const DACS_HTTP_INITIAL_RETRY_DELAY_MS = 1_000 as const;
/** DACS One-Click Install Specification section 12.5. */
export const DACS_HTTP_MAXIMUM_RETRY_DELAY_MS = 60_000 as const;

export interface DacsHttpStorePageV1<Item> {
  items: readonly Readonly<Item>[];
  nextCursor?: string;
}

/**
 * Authenticated input admitted atomically by the inbox. All replay facts are
 * derived again from `authenticated.envelope`; callers cannot substitute a
 * second set of envelope identifiers. The retained envelope is the complete
 * canonical signed transport record, not a DACS artifact.
 */
export interface DacsHttpInboxReservationV1 {
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
  retainUntil: number;
}

export interface DacsHttpInboxItemV1 {
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
  state: "pending" | "disposed";
  disposition?: DacsHttpAcknowledgementV1["disposition"];
  reasonCode?: string;
  retainUntil: number;
  revision: number;
  updatedAt: number;
  recordHash: string;
}

export type DacsHttpInboxReserveResultV1 = Readonly<
  | { status: "reserved"; record: Readonly<DacsHttpInboxItemV1> }
  | {
      /** Exact retained replay whose action has not yet reached disposition. */
      status: "pending";
      record: Readonly<DacsHttpInboxItemV1>;
    }
  | {
      /** Exact retained replay whose durable disposition can be acknowledged. */
      status: "existing";
      record: Readonly<DacsHttpInboxItemV1>;
      disposition: DacsHttpAcknowledgementV1["disposition"];
      reasonCode?: string;
    }
  | { status: "conflict" }
>;

export interface DacsHttpInboxStoreV1 {
  readTime(): Promise<number>;
  reserve(
    reservation: Readonly<DacsHttpInboxReservationV1>,
  ): Promise<DacsHttpInboxReserveResultV1>;
  load(input: Readonly<{
    sender: string;
    audience: string;
    envelopeId: string;
  }>): Promise<Readonly<DacsHttpInboxItemV1> | undefined>;
  list(input: Readonly<{
    cursor?: string;
    limit: number;
    state?: DacsHttpInboxItemV1["state"];
  }>): Promise<Readonly<DacsHttpStorePageV1<DacsHttpInboxItemV1>>>;
  recordDisposition(input: Readonly<{
    sender: string;
    audience: string;
    envelopeId: string;
    authenticationHash: string;
    disposition: DacsHttpAcknowledgementV1["disposition"];
    reasonCode?: string;
  }>): Promise<Readonly<{
    status: "recorded" | "existing" | "conflict" | "missing";
    record?: Readonly<DacsHttpInboxItemV1>;
  }>>;
  /** Extend retained evidence after the owning SDK session becomes terminal. */
  extendRetention(input: Readonly<{
    jobId: string;
    retainUntil: number;
  }>): Promise<Readonly<{ status: "extended" | "existing"; count: number }>>;
}

export interface DacsHttpOutboxLeaseV1 {
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface DacsHttpOutboxItemV1 {
  envelope: Readonly<DacsHttpEnvelopeV1>;
  envelopeHash: string;
  state: "pending" | "sending" | "acknowledged" | "operator-action";
  generation: number;
  attempts: number;
  nextAttemptAt: number;
  retainUntil: number;
  lease?: Readonly<DacsHttpOutboxLeaseV1>;
  acknowledgement?: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
  /**
   * Section 12.4 retention period applied when the acknowledgement was
   * admitted. It is persisted with the canonical record and can only increase,
   * so reopening a store with a shorter option cannot weaken prior evidence.
   */
  acknowledgementRetentionMs?: number;
  reasonCode?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  recordHash: string;
}

export type DacsHttpOutboxClaimResultV1 = Readonly<
  | {
      status: "acquired";
      record: Readonly<DacsHttpOutboxItemV1>;
      lease: Readonly<DacsHttpOutboxLeaseV1>;
    }
  | {
      status: "waiting";
      record: Readonly<DacsHttpOutboxItemV1>;
      lease: Readonly<DacsHttpOutboxLeaseV1>;
    }
  | {
      status: "acknowledged" | "operator-action" | "not-runnable";
      record: Readonly<DacsHttpOutboxItemV1>;
    }
  | { status: "missing" | "stale" }
>;

export interface DacsHttpOutboxStoreV1 {
  readTime(): Promise<number>;
  put(input: Readonly<{
    envelope: Readonly<DacsHttpEnvelopeV1>;
    retainUntil: number;
  }>): Promise<Readonly<{
    status: "created" | "existing" | "conflict";
    record?: Readonly<DacsHttpOutboxItemV1>;
  }>>;
  load(envelopeId: string): Promise<Readonly<DacsHttpOutboxItemV1> | undefined>;
  list(input: Readonly<{
    cursor?: string;
    limit: number;
    state?: DacsHttpOutboxItemV1["state"];
  }>): Promise<Readonly<DacsHttpStorePageV1<DacsHttpOutboxItemV1>>>;
  listRunnable(input: Readonly<{
    cursor?: string;
    limit: number;
  }>): Promise<Readonly<DacsHttpStorePageV1<DacsHttpOutboxItemV1>>>;
  claim(input: Readonly<{
    envelopeId: string;
    envelopeHash: string;
    owner: string;
    leaseDurationMs: number;
  }>): Promise<DacsHttpOutboxClaimResultV1>;
  isCurrent(input: Readonly<{
    envelopeId: string;
    envelopeHash: string;
    lease: Readonly<DacsHttpOutboxLeaseV1>;
  }>): Promise<boolean>;
  recordSendFailure(input: Readonly<{
    envelopeId: string;
    envelopeHash: string;
    lease: Readonly<DacsHttpOutboxLeaseV1>;
    reasonCode: string;
  }>): Promise<Readonly<{
    status: "recorded" | "existing" | "stale" | "conflict" | "missing";
    record?: Readonly<DacsHttpOutboxItemV1>;
  }>>;
  requireOperatorAction(input: Readonly<{
    envelopeId: string;
    envelopeHash: string;
    lease: Readonly<DacsHttpOutboxLeaseV1>;
    reasonCode: string;
  }>): Promise<Readonly<{
    status: "recorded" | "existing" | "stale" | "conflict" | "missing";
    record?: Readonly<DacsHttpOutboxItemV1>;
  }>>;
  /**
   * Records a fully authenticated, exact bound acknowledgement. This is
   * intentionally not lease-gated: a valid late ACK is monotonic evidence.
   */
  acknowledge(input: Readonly<{
    envelopeId: string;
    envelopeHash: string;
    acknowledgement: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
  }>): Promise<Readonly<{
    status: "recorded" | "existing" | "conflict" | "missing";
    record?: Readonly<DacsHttpOutboxItemV1>;
  }>>;
  /** Extend retained evidence after the owning SDK session becomes terminal. */
  extendRetention(input: Readonly<{
    jobId: string;
    retainUntil: number;
  }>): Promise<Readonly<{ status: "extended" | "existing"; count: number }>>;
}

export interface DacsHttpOutboxRetryJitterInputV1 {
  envelopeId: string;
  attempt: number;
  baseDelayMs: number;
}

/**
 * Return an integer millisecond delta in `[-baseDelayMs / 2, baseDelayMs / 2]`.
 * The adapter rejects out-of-range, non-integer or throwing jitter functions.
 */
export type DacsHttpOutboxRetryJitterV1 = (
  input: Readonly<DacsHttpOutboxRetryJitterInputV1>,
) => number;

export interface DacsHttpTransportStoreOptionsV1 {
  retentionMs?: number;
  /** Overrides the adapter's stable per-envelope default jitter. */
  retryJitter?: DacsHttpOutboxRetryJitterV1;
}
