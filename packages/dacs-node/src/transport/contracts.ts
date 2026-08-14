import type {
  DacsHttpAcknowledgementV1,
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpEnvelopeV1,
} from "./envelope.js";

export const DACS_HTTP_MINIMUM_RETENTION_MS = 604_800_000 as const;

export interface DacsHttpInboxReservationV1 {
  sender: string;
  audience: string;
  envelopeId: string;
  nonce: string;
  payloadHash: string;
  authenticationHash: string;
  identityEvidenceHash: string;
  receivedAt: number;
  retainUntil: number;
}

export type DacsHttpInboxReserveResultV1 =
  | Readonly<{ status: "reserved" }>
  | Readonly<{
      status: "existing";
      disposition: DacsHttpAcknowledgementV1["disposition"];
      reasonCode?: string;
    }>
  | Readonly<{ status: "conflict" }>;

export interface DacsHttpInboxStoreV1 {
  readTime(): Promise<number>;
  reserve(
    reservation: Readonly<DacsHttpInboxReservationV1>,
  ): Promise<DacsHttpInboxReserveResultV1>;
  recordDisposition(input: Readonly<{
    sender: string;
    audience: string;
    envelopeId: string;
    authenticationHash: string;
    disposition: DacsHttpAcknowledgementV1["disposition"];
    reasonCode?: string;
  }>): Promise<Readonly<{ status: "recorded" | "existing" | "conflict" | "missing" }>>;
}

export interface DacsHttpOutboxItemV1 {
  envelope: Readonly<DacsHttpEnvelopeV1>;
  state: "pending" | "sending" | "acknowledged" | "operator-action";
  attempts: number;
  nextAttemptAt: number;
  retainUntil: number;
  acknowledgement?: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
  reasonCode?: string;
}

export interface DacsHttpOutboxStoreV1 {
  put(envelope: Readonly<DacsHttpEnvelopeV1>): Promise<
    Readonly<{ status: "created" | "existing" | "conflict" }>
  >;
  listRunnable(input: Readonly<{
    cursor?: string;
    limit: number;
  }>): Promise<Readonly<{
    items: readonly Readonly<DacsHttpOutboxItemV1>[];
    nextCursor?: string;
  }>>;
  acknowledge(input: Readonly<{
    envelopeId: string;
    authenticationHash: string;
    acknowledgement: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
  }>): Promise<Readonly<{ status: "recorded" | "existing" | "conflict" | "missing" }>>;
}
