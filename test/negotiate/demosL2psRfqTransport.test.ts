import { createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test, vi } from "vitest";

const snapshotLabels = vi.hoisted(() => [] as string[]);

// Pass-through spy: admission tests prove a peer-supplied value was refused
// before the deep canonical snapshot ever ran on it.
vi.mock("../../src/canonical/snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/canonical/snapshot.js")>();
  return {
    ...actual,
    snapshotCanonicalJsonRead<T>(value: T, label: string): T {
      snapshotLabels.push(label);
      return actual.snapshotCanonicalJsonRead(value, label);
    },
  };
});

import {
  canonicalize,
  contentHash,
  createDemosL2psRfqAesGcmCodec,
  createDemosL2psRfqTransport,
  createDurableRfqLifecycleClient,
  createInMemoryDurableRfqLifecycleStore,
  DacsError,
  DemosL2psRfqPeerChannelError,
  rfqLifecyclePacketId,
  TransientError,
  type AttestationRef,
  type DemosL2psRfqEncryptedMessage,
  type DemosL2psRfqHistoryPage,
  type DemosL2psRfqIncomingPayload,
  type DemosL2psRfqMessageHandler,
  type DemosL2psRfqPeerLike,
  type DemosL2psRfqStoredMessage,
  type DemosL2psRfqTransportOptions,
  type DemosL2psRfqWireCodec,
  type DurableRfqLifecycleRole,
  type DurableRfqLifecycleTransport,
  type IdentityBundle,
  type Listing,
  type RfqChannelReservationInput,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const CHANNEL_ID = "demos-l2ps-rfq-channel-01";
const L2PS_UID = "l2ps:rfq-test-subnet";
const BUYER = "did:demos:buyer-l2ps-rfq";
const SELLER = "did:demos:seller-l2ps-rfq";
const BUYER_PEER = "a".repeat(64);
const SELLER_PEER = "b".repeat(64);
const THIRD_PEER = "c".repeat(64);
// Node 61b8e75 refuses a ciphertext string over 128 * 1024 characters
// (L2PSMessagingServer.ts:27,247-249); the transport takes the same limit.
const MAX_CIPHERTEXT_CHARS = 128 * 1024;
const MAX_LIVE_BYTES = 16 * 1024 * 1024;
/** What the transport charges one live payload against its byte budget. */
function liveCharge(payload: DemosL2psRfqIncomingPayload): number {
  return 1024 + 2 * (payload.from.length + payload.messageHash.length +
    payload.encrypted.ciphertext.length + payload.encrypted.nonce.length);
}

/**
 * The outbox contract's compare. Generation 0 matches only when no entry
 * exists; a present entry matches only through its positive safe-integer
 * generation, so one that lost its generation never matches.
 */
function generationMatches(present: boolean, current: unknown, expectedGeneration: number): boolean {
  if (!present) return expectedGeneration === 0;
  const generation = (current as { generation?: unknown } | null)?.generation;
  return Number.isSafeInteger(generation) && (generation as number) >= 1 &&
    generation === expectedGeneration;
}

function memorySendOutbox(): DemosL2psRfqTransportOptions["outboxStore"] {
  const entries = new Map<string, unknown>();
  return {
    load: (packetId) => structuredClone(entries.get(packetId)),
    save: (packetId, entry, expectedGeneration) => {
      if (!generationMatches(entries.has(packetId), entries.get(packetId), expectedGeneration)) return false;
      entries.set(packetId, structuredClone(entry));
      return true;
    },
  };
}

function identity(claim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: claim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: claim, signature: "identity-proof" }],
    },
  };
}

function vetRef(locator: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: "a".repeat(64),
  };
}

const buyer = {
  identityBundle: identity(BUYER),
  vetRecordRef: vetRef("stor:buyer-l2ps-rfq-vet"),
};
const seller = {
  identityBundle: identity(SELLER),
  vetRecordRef: vetRef("stor:seller-l2ps-rfq-vet"),
};

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "demos-l2ps-rfq-listing",
    requiredCapabilities: ["SR-2", "SR-4"],
    seller: {
      identity: identity(SELLER),
      displayName: "Demos L2PS RFQ seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Private L2PS quote",
      description: "A two-peer encrypted RFQ fixture",
      category: "data.finance",
      tags: ["rfq"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-rfq", parameters: { maxTurns: 4, timeoutSec: 10 } },
      { kind: "commit-agreement" },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "negotiable",
      bandCenter: { amount: "10", currency: "USDC" },
      minPct: 20,
      maxPct: 20,
    },
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
}

function openInput() {
  const value = listing();
  return {
    jobId: JOB_ID,
    verifiedListing: {
      disposition: "verified" as const,
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    },
    buyer,
    seller,
    channelId: CHANNEL_ID,
  };
}

function durableReservation() {
  const reservations = new Map<string, string>();
  return (input: Readonly<RfqChannelReservationInput>) => {
    const exact = canonicalize(input as unknown as Record<string, unknown>);
    const prior = reservations.get(input.channelId);
    if (prior !== undefined && prior !== exact) return "fail" as const;
    reservations.set(input.channelId, exact);
    return "pass" as const;
  };
}

function peerForClaim(claim: string): string | undefined {
  if (claim === BUYER) return BUYER_PEER;
  if (claim === SELLER) return SELLER_PEER;
  return undefined;
}

function claimForPeer(peer: string): string | undefined {
  if (peer === BUYER_PEER) return BUYER;
  if (peer === SELLER_PEER) return SELLER;
  return undefined;
}

/**
 * An in-process stand-in for a node. Its peers expose no URL, so every
 * transport over them states peerChannel: "loopback".
 */
class FakeL2psHub {
  readonly messages: DemosL2psRfqStoredMessage[] = [];
  readonly handlers = new Map<string, Set<DemosL2psRfqMessageHandler>>();
  sends = 0;
  loseNextResponse = false;
  /**
   * Node 61b8e75: message_hash is globally unique, and a repeat is refused
   * with "Duplicate message" and not delivered (L2PSMessagingService.ts:50-51,
   * L2PSMessagingServer.ts:267-269).
   */
  nodeDedup = false;

  peer(localPeer: string): DemosL2psRfqPeerLike {
    return {
      isConnected: true,
      isRegistered: true,
      send: (to, encrypted, messageHash) =>
        this.send(localPeer, to, encrypted, messageHash),
      history: (peerKey, options) =>
        this.history(localPeer, peerKey, options),
      onMessage: (handler) => {
        const handlers = this.handlers.get(localPeer) ?? new Set();
        handlers.add(handler);
        this.handlers.set(localPeer, handlers);
      },
      removeMessageHandler: (handler) => {
        this.handlers.get(localPeer)?.delete(handler);
      },
    };
  }

  private async send(
    from: string,
    to: string,
    encrypted: DemosL2psRfqEncryptedMessage,
    messageHash: string,
  ) {
    this.sends += 1;
    // Node 61b8e75 refuses this before it stores anything (L2PSMessagingServer.ts:247-249).
    if (encrypted.ciphertext.length > MAX_CIPHERTEXT_CHARS) {
      throw new Error(`Ciphertext too large (max ${MAX_CIPHERTEXT_CHARS} bytes)`);
    }
    if (this.nodeDedup && this.messages.some((message) => message.messageHash === messageHash)) {
      throw new Error("Duplicate message");
    }
    let stored = this.messages.find(
      (message) =>
        message.from === from &&
        message.to === to &&
        message.messageHash === messageHash,
    );
    if (stored === undefined) {
      stored = {
        id: `message-${this.messages.length + 1}`,
        from,
        to,
        messageHash,
        encrypted: structuredClone(encrypted),
        l2psUid: L2PS_UID,
        l2psTxHash: null,
        timestamp: NOW + this.messages.length,
        status: "l2ps_pending",
      };
      this.messages.push(stored);
    }
    // Like the node, a live delivery says offline: false (L2PSMessagingServer.ts:276).
    const payload: DemosL2psRfqIncomingPayload = {
      from,
      encrypted: structuredClone(stored.encrypted),
      messageHash,
      offline: false,
    };
    for (const handler of this.handlers.get(to) ?? []) handler(payload);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("response lost after durable acceptance");
    }
    return { messageHash, l2psStatus: "submitted" as const };
  }

  private async history(
    localPeer: string,
    otherPeer: string,
    options?: { before?: number; limit?: number },
  ): Promise<DemosL2psRfqHistoryPage> {
    const limit = options?.limit ?? 100;
    const matching = this.messages
      .filter(
        (message) =>
          ((message.from === localPeer && message.to === otherPeer) ||
            (message.from === otherPeer && message.to === localPeer)) &&
          (options?.before === undefined || message.timestamp < options.before),
      )
      .sort((left, right) => right.timestamp - left.timestamp);
    return {
      messages: structuredClone(matching.slice(0, limit)),
      hasMore: matching.length > limit,
    };
  }
}

function clientOptions(
  role: DurableRfqLifecycleRole,
  transport: DurableRfqLifecycleTransport<string>,
  reservation: ReturnType<typeof durableReservation>,
) {
  const claim = role === "buyer" ? BUYER : SELLER;
  return {
    role,
    store: createInMemoryDurableRfqLifecycleStore<string>(),
    transport,
    reserveChannelId: reservation,
    signChannelMessage: (input: { envelopeHash: string }) =>
      `${role}:${input.envelopeHash}`,
    verifyChannelMessage: () => "pass" as const,
    agreementSigner: {
      party: claim,
      algorithm: "ed25519" as const,
      sign: () => new Uint8Array(64).fill(role === "buyer" ? 1 : 2),
    },
    verifyAgreementContribution: () => "valid" as const,
    nowMs: () => NOW,
  };
}

/** A buyer whose first offer reached Demos but whose send response was lost. */
async function buyerWithSentOffer(options: {
  codec?: (base: DemosL2psRfqWireCodec) => DemosL2psRfqWireCodec;
  history?: (base: DemosL2psRfqPeerLike["history"]) => DemosL2psRfqPeerLike["history"];
  operationTimeoutMs?: number;
  monotonicNowMs?: () => number;
  extra?: Partial<DemosL2psRfqTransportOptions>;
} = {}) {
  const hub = new FakeL2psHub();
  const sharedKey = randomBytes(32);
  const baseCodec = createDemosL2psRfqAesGcmCodec({ sharedKey });
  const basePeer = hub.peer(BUYER_PEER);
  const transport = createDemosL2psRfqTransport<string>({
    peer: options.history === undefined
      ? basePeer
      : { ...basePeer, history: options.history(basePeer.history) },
    codec: options.codec?.(baseCodec) ?? baseCodec,
    l2psUid: L2PS_UID,
    peerChannel: "loopback",
    outboxStore: memorySendOutbox(),
    localClaim: BUYER,
    localPeerKey: BUYER_PEER,
    peerForClaim,
    claimForPeer,
    onError: vi.fn(),
    ...(options.monotonicNowMs === undefined ? {} : { monotonicNowMs: options.monotonicNowMs }),
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
    ...options.extra,
  });
  const client = createDurableRfqLifecycleClient(
    clientOptions("buyer", transport, durableReservation()),
  );
  await client.open(openInput());
  hub.loseNextResponse = true;
  await expect(client.sendOffer(JOB_ID, {
    rfqProposalVersion: "1",
    price: { amount: "9", currency: "USDC" },
  })).resolves.toMatchObject({ status: "indeterminate" });
  const status = await client.getStatus(JOB_ID);
  if (status.status !== "ok") throw new Error("record did not load");
  const packet = status.record.outbox[0]?.packet;
  const own = hub.messages[0];
  if (packet === undefined || own === undefined) throw new Error("frame missing");
  return { hub, sharedKey, baseCodec, transport, client, packet, own };
}

async function inboundReceiver(options: {
  open?: (base: DemosL2psRfqWireCodec) => DemosL2psRfqWireCodec["open"];
  operationTimeoutMs?: number;
  consumerTimeoutMs?: number;
  inboundRecoveryMaxBytes?: number;
  history?: (base: DemosL2psRfqPeerLike["history"]) => DemosL2psRfqPeerLike["history"];
  extra?: Partial<DemosL2psRfqTransportOptions>;
} = {}) {
  const sent = await buyerWithSentOffer();
  const errors: Error[] = [];
  const sellerPeer = sent.hub.peer(SELLER_PEER);
  const transport = createDemosL2psRfqTransport<string>({
    peer: options.history === undefined
      ? sellerPeer
      : { ...sellerPeer, history: options.history(sellerPeer.history) },
    codec: {
      codecId: sent.baseCodec.codecId,
      seal: (plaintext, context) => sent.baseCodec.seal(plaintext, context),
      open: options.open?.(sent.baseCodec) ?? ((encrypted, context) => sent.baseCodec.open(encrypted, context)),
    },
    l2psUid: L2PS_UID,
    peerChannel: "loopback",
    outboxStore: memorySendOutbox(),
    localClaim: SELLER,
    localPeerKey: SELLER_PEER,
    peerForClaim,
    claimForPeer,
    onError: (error) => errors.push(error),
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.consumerTimeoutMs === undefined ? {} : { consumerTimeoutMs: options.consumerTimeoutMs }),
    ...(options.inboundRecoveryMaxBytes === undefined
      ? {}
      : { inboundRecoveryMaxBytes: options.inboundRecoveryMaxBytes }),
    ...options.extra,
  });
  const client = createDurableRfqLifecycleClient(clientOptions("seller", transport, durableReservation()));
  await client.open(openInput());
  const receive = vi.fn((packet: unknown) => client.receive(packet));
  transport.start(receive);
  const emit = (payload: DemosL2psRfqIncomingPayload) => {
    for (const handler of sent.hub.handlers.get(SELLER_PEER) ?? []) handler(payload);
  };
  const payload = { from: BUYER_PEER, encrypted: structuredClone(sent.own.encrypted), messageHash: sent.packet.packetId };
  return { ...sent, transport, client, receive, errors, emit, payload };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const OVERFLOW = "Demos L2PS RFQ live queue exceeds its count or byte budget; recover from history";
const CONSUMER_TIMEOUT = "Demos L2PS RFQ consumer timed out";

// Runs pending promise jobs on a macrotask that the fake timers below leave real.
async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Synchronous emits are all charged before any is ingested: exactly 100 fit. */
async function expectFullLiveCapacity(fixture: Awaited<ReturnType<typeof inboundReceiver>>) {
  const before = fixture.errors.length;
  for (let index = 0; index < 100; index += 1) fixture.emit(fixture.payload);
  expect(fixture.errors).toHaveLength(before);
  fixture.emit(fixture.payload);
  expect(fixture.errors.slice(before).map((error) => error.message)).toEqual([OVERFLOW]);
  expect(fixture.errors[before]).toBeInstanceOf(TransientError);
  await fixture.transport.drain();
}

const ABSENCE_GRACE_REASON = "Demos L2PS history cannot yet prove packet absence after a timed-out send";

async function delayedSendFixture(options: {
  refuseSeal?: boolean;
  failWrite?: boolean;
  /** Every save loses its compare-and-swap, as if another writer won. */
  conflictWrite?: boolean;
  /** The first save reaches the store only when releaseFirstSave() runs. */
  holdFirstSave?: boolean;
  /** The lifecycle's next record write after the first peer call is unavailable. */
  failLifecycleWriteAfterSend?: boolean;
  /** The first outbox save after the first peer call throws. */
  failSaveAfterSend?: boolean;
  ack?: Record<string, unknown>;
  /** The peer resolves exactly this value, without echoing the hash. */
  rawAck?: unknown;
  graceMs?: number;
  historyAdvanceMs?: number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sdk249-send-outbox-"));
  const integrityKey = randomBytes(32);
  const mac = (body: string) => createHmac("sha256", integrityKey).update(body).digest("hex");
  // Commits run one at a time, so each compare and write is atomic.
  let commits: Promise<unknown> = Promise.resolve();
  const firstSaveGate = gate();
  let heldSave = options.holdFirstSave ? firstSaveGate : undefined;
  let heldSaveResult: Promise<boolean> | undefined;
  let failRead = false;
  let failedAfterSend = false;
  const outboxStore: DemosL2psRfqTransportOptions["outboxStore"] = {
    async load(id) {
      if (failRead) throw new Error("durable outbox read unavailable");
      let text: string;
      try { text = await readFile(join(dir, id), "utf8"); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
      const stored = JSON.parse(text) as { body: string; mac: string };
      if (stored.mac !== mac(stored.body)) throw new Error("send outbox integrity failure");
      return JSON.parse(stored.body) as unknown;
    },
    save(id, entry, expectedGeneration) {
      const held = heldSave;
      heldSave = undefined;
      const failAfterSend = options.failSaveAfterSend === true && submissions.length > 0 && !failedAfterSend;
      if (failAfterSend) failedAfterSend = true;
      const result = (async () => {
        if (options.failWrite || failAfterSend) throw new Error("durable outbox unavailable");
        if (held !== undefined) await held.promise;
        const commit = commits.then(async () => {
          const current = await outboxStore.load(id);
          if (options.conflictWrite || !generationMatches(current !== undefined, current, expectedGeneration)) {
            return false;
          }
          const body = JSON.stringify(entry);
          await writeFile(join(dir, id + ".tmp"), JSON.stringify({ body, mac: mac(body) }), { mode: 0o600 });
          await rename(join(dir, id + ".tmp"), join(dir, id));
          return true;
        });
        commits = commit.catch(() => undefined);
        return commit;
      })();
      if (held !== undefined) heldSaveResult = result;
      return result;
    },
  };
  let ticks = 10_000;
  let calls = 0;
  let sealed = 0;
  let refused = false;
  let timedOut = false;
  const hub = new FakeL2psHub();
  const basePeer = hub.peer(BUYER_PEER);
  let codec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
  let openFault: "throw" | "hang" | undefined;
  let openAs: Uint8Array | undefined;
  const plaintexts: Uint8Array[] = [];
  const sendEntered = gate();
  const framesAtCall: unknown[] = [];
  const submissions: Array<{ to: string; encrypted: DemosL2psRfqEncryptedMessage; messageHash: string }> = [];
  let accept: (() => void) | undefined;
  let visible = false;
  let failLifecycleWrite = false;
  const peer: DemosL2psRfqPeerLike = {
    ...basePeer,
    async send(to, encrypted, messageHash) {
      // At the first peer call, the EXACT frame must already be durable.
      const stored = await outboxStore.load(messageHash) as Record<string, unknown> | undefined;
      framesAtCall.push(structuredClone(stored));
      submissions.push(structuredClone({ to, encrypted, messageHash }));
      if (options.failLifecycleWriteAfterSend && submissions.length === 1) failLifecycleWrite = true;
      sendEntered.release();
      if ("rawAck" in options) return options.rawAck as never;
      if (options.ack !== undefined) return { messageHash, ...options.ack } as never;
      if (options.refuseSeal || timedOut) return { messageHash, l2psStatus: "submitted" };
      return new Promise((resolve) => {
        accept = () => {
          void basePeer.send(to, encrypted, messageHash).then(resolve);
        };
      });
    },
    async history(peerKey, historyOptions) {
      calls += 1;
      ticks += options.historyAdvanceMs ?? 0;
      return visible ? basePeer.history(peerKey, historyOptions) : { messages: [], hasMore: false };
    },
  };
  function makeTransport() {
    const current = codec;
    return createDemosL2psRfqTransport<string>({
      peer,
      codec: { codecId: current.codecId, open(encrypted, context) {
        if (openFault === "throw") throw new Error("codec temporarily unavailable");
        if (openFault === "hang") return new Promise<Uint8Array>(() => {});
        if (openAs !== undefined) {
          const other = openAs;
          return Promise.resolve(current.open(encrypted, context)).then(() => other);
        }
        return current.open(encrypted, context);
      }, seal(bytes, context) {
        if (options.refuseSeal && !refused) { refused = true; throw new Error("seal refused before send"); }
        sealed += 1;
        plaintexts.push(Uint8Array.from(bytes));
        return codec.seal(bytes, context);
      } },
      l2psUid: L2PS_UID, localClaim: BUYER, localPeerKey: BUYER_PEER,
      peerChannel: "loopback",
      peerForClaim, claimForPeer, onError: vi.fn(), outboxStore,
      monotonicNowMs: () => ticks, operationTimeoutMs: 200,
      ...(options.graceMs === undefined ? {} : { sendAbsenceGraceMs: options.graceMs }),
    });
  }
  let transport = makeTransport();
  const baseLifecycleOptions = clientOptions("buyer", transport, durableReservation());
  const baseStore = baseLifecycleOptions.store;
  const lifecycleOptions = {
    ...baseLifecycleOptions,
    store: {
      ...baseStore,
      compareAndSwap(...args: Parameters<typeof baseStore.compareAndSwap>) {
        if (!failLifecycleWrite) return baseStore.compareAndSwap(...args);
        failLifecycleWrite = false;
        return { status: "unavailable" as const, reason: "lifecycle store unavailable" };
      },
    },
  };
  let client = createDurableRfqLifecycleClient(lifecycleOptions);
  await client.open(openInput());
  let packet: Awaited<ReturnType<typeof buyerWithSentOffer>>["packet"] | undefined;
  async function offer(amount = "9") {
    const result = await client.sendOffer(JOB_ID, { rfqProposalVersion: "1", price: { amount, currency: "USDC" } });
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("outbox missing");
    packet = status.record.outbox[0]!.packet;
    return result;
  }
  return {
    get client() { return client; }, get transport() { return transport; },
    submissions, framesAtCall, outboxStore, offer,
    packet: () => { if (packet === undefined) throw new Error("packet missing"); return packet; },
    setTicks: (now: number) => { ticks = now; },
    seals: () => sealed,
    historyCalls: () => calls,
    async timeout() {
      // Only operation timers are faked. The persisted monotonic clock has an
      // independent origin, which a new transport instance must honour.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = offer();
      await sendEntered.promise;
      ticks = 12_000;
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({ status: "indeterminate" });
      timedOut = true;
      vi.useRealTimers();
    },
    restart() {
      transport = makeTransport();
      client = createDurableRfqLifecycleClient({ ...lifecycleOptions, transport });
    },
    failReads(on: boolean) { failRead = on; },
    /** The next transport (after restart) uses a new key under the same codecId. */
    rotateKey() { codec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }); },
    /** Every codec open throws or never settles, until cleared with undefined. */
    failOpens(fault: "throw" | "hang" | undefined) { openFault = fault; },
    /** Every codec open authenticates, then yields these bytes instead. */
    openAs(bytes: Uint8Array | undefined) { openAs = bytes; },
    /** The packet bytes each seal received, in order. */
    plaintexts: () => plaintexts,
    /** Let the held first save reach the store; resolves to its CAS result. */
    releaseFirstSave() {
      if (heldSaveResult === undefined) throw new Error("no held save");
      firstSaveGate.release();
      return heldSaveResult;
    },
    acceptLate() { if (accept === undefined) throw new Error("no pending send"); accept(); },
    showHistory() { visible = true; },
    async cleanup() { vi.useRealTimers(); await rm(dir, { recursive: true }); },
  };
}

/**
 * demosdk's own L2PSMessagingPeer from the installed build, so a later 4.x
 * that moves config.serverUrl fails these tests. The pinned 4.0.16 has no
 * focused public export for it; 4.0.17 added ./instant-messaging
 * (kynesyslabs/sdks#125). The module has no imports, and constructing a peer
 * opens no socket.
 *
 * This path is demosdk's private build layout, not API. package-lock.json pins
 * @kynesyslabs/demosdk 4.0.16, which has it; package.json allows ^4.0.16, so a
 * 4.x that moves the file breaks this test helper only, never production code.
 * Recheck the path when the lockfile moves.
 */
async function demosPeer(config: object): Promise<DemosL2psRfqPeerLike> {
  const build = dirname(createRequire(import.meta.url).resolve("@kynesyslabs/demosdk"));
  const { L2PSMessagingPeer } = await import(
    pathToFileURL(join(build, "instant_messaging", "L2PSMessagingPeer.js")).href
  ) as { L2PSMessagingPeer: new (config: object) => DemosL2psRfqPeerLike };
  return new L2PSMessagingPeer(config);
}

function demosConfig(serverUrl: unknown) {
  return { serverUrl, publicKey: BUYER_PEER, l2psUid: L2PS_UID, signFn: () => "00" };
}

function channelOptions(peer: DemosL2psRfqPeerLike, peerChannel?: unknown): DemosL2psRfqTransportOptions {
  return {
    peer,
    codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
    l2psUid: L2PS_UID,
    outboxStore: memorySendOutbox(),
    localClaim: BUYER,
    localPeerKey: BUYER_PEER,
    peerForClaim,
    claimForPeer,
    onError: vi.fn(),
    ...(peerChannel === undefined ? {} : { peerChannel: peerChannel as "wss" }),
  };
}

/** The construction error, or undefined when the transport was built. */
function constructionError(options: DemosL2psRfqTransportOptions): unknown {
  try {
    createDemosL2psRfqTransport(options);
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectChannelRefusal(options: DemosL2psRfqTransportOptions, code: string): Error {
  const error = constructionError(options);
  expect(error).toMatchObject({ name: "DemosL2psRfqPeerChannelError", code });
  expect(error).toBeInstanceOf(DemosL2psRfqPeerChannelError);
  return error as Error;
}

describe("Demos L2PS durable RFQ transport", () => {
  test("round 5: late acceptance stays unsent while history lags, across a restart", async () => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      expect(fixture.submissions).toHaveLength(1);
      fixture.acceptLate();
      fixture.setTicks(12_001);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate", reason: ABSENCE_GRACE_REASON,
      });
      fixture.restart();
      fixture.setTicks(71_999); // 59,999 after the SEND ENDED, not its start.
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate", reason: ABSENCE_GRACE_REASON,
      });
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.framesAtCall[0]).toMatchObject({
        state: "sending", encrypted: fixture.submissions[0]!.encrypted,
      });
      fixture.showHistory();
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test("round 5: persisted end time expires once; empty history resends identical bytes", async () => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      const stored = await fixture.outboxStore.load(fixture.packet().packetId) as Record<string, unknown>;
      fixture.restart();
      fixture.setTicks(71_999);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "indeterminate" });
      expect(fixture.submissions).toHaveLength(1);
      fixture.setTicks(72_000);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      expect(fixture.submissions).toHaveLength(2);
      expect(fixture.submissions[1]).toEqual(fixture.submissions[0]);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      expect(fixture.submissions).toHaveLength(2);
      expect(fixture.seals()).toBe(1);
      expect(stored.attemptEndedAtMs).toBe(12_000);
      expect(stored.state).toBe("indeterminate");
    } finally { await fixture.cleanup(); }
  });

  test("round 5: configured grace holds a history read that crosses its boundary", async () => {
    const fixture = await delayedSendFixture({ graceMs: 5_000, historyAdvanceMs: 100 });
    try {
      await fixture.timeout();
      fixture.restart();
      fixture.setTicks(16_999);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate", reason: ABSENCE_GRACE_REASON,
      });
      expect(fixture.submissions).toHaveLength(1);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      expect(fixture.submissions).toHaveLength(2);
      expect(fixture.submissions[1]).toEqual(fixture.submissions[0]);
    } finally { await fixture.cleanup(); }
  });

  test("round 5: seal refusal has no send end marker and retries immediately", async () => {
    const fixture = await delayedSendFixture({ refuseSeal: true });
    try {
      await expect(fixture.offer()).resolves.toMatchObject({ status: "indeterminate" });
      expect(fixture.submissions).toHaveLength(0);
      expect(await fixture.outboxStore.load(fixture.packet().packetId)).toBeUndefined();
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test("round 5: crash marker and a backwards monotonic clock get a fresh persisted grace", async () => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      const id = fixture.packet().packetId;
      const entry = await fixture.outboxStore.load(id) as Parameters<typeof fixture.outboxStore.save>[1];
      const crash = { ...entry, state: "sending" as const, generation: entry.generation + 1 };
      delete crash.attemptEndedAtMs;
      await expect(fixture.outboxStore.save(id, crash, entry.generation)).resolves.toBe(true);
      fixture.restart();
      fixture.setTicks(50_000);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "indeterminate" });
      expect((await fixture.outboxStore.load(id) as typeof entry).attemptEndedAtMs).toBe(50_000);
      fixture.restart();
      fixture.setTicks(100);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "indeterminate" });
      expect((await fixture.outboxStore.load(id) as typeof entry).attemptEndedAtMs).toBe(100);
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test("round 5: failed durable write prevents the first peer call", async () => {
    const fixture = await delayedSendFixture({ failWrite: true });
    try {
      await expect(fixture.offer()).resolves.toMatchObject({ status: "indeterminate" });
      expect(fixture.submissions).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  test("round 6: a refused outbox compare-and-swap prevents the peer call", async () => {
    const fixture = await delayedSendFixture({ conflictWrite: true });
    try {
      await expect(fixture.offer()).resolves.toMatchObject({
        status: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable",
      });
      expect(fixture.submissions).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  test("round 7: neither test outbox overwrites a present entry that lost its generation", async () => {
    const fixture = await delayedSendFixture();
    try {
      for (const store of [memorySendOutbox(), fixture.outboxStore]) {
        for (const [index, generation] of [undefined, 0, -1, 1.5, "1"].entries()) {
          const id = String(index).repeat(64);
          // Expected generation 0 commits only where no entry exists.
          expect(await store.save(id, { packetId: id, generation } as never, 0)).toBe(true);
          const stored = await store.load(id);
          for (const expected of [0, 1]) {
            const next = { packetId: id, state: "sending", generation: expected + 1 };
            expect(await store.save(id, next as never, expected)).toBe(false);
          }
          expect(await store.load(id)).toEqual(stored);
        }
      }
    } finally { await fixture.cleanup(); }
  });

  test("round 6: a pre-send write that commits late cannot replace the frame recovery sent", async () => {
    // Every send is ambiguous (a failed acknowledgement), and history stays empty.
    const fixture = await delayedSendFixture({ holdFirstSave: true, ack: { l2psStatus: "failed" } });
    try {
      // Frame A's pre-send write outlives the 200 ms local timeout: no peer call.
      await expect(fixture.offer()).resolves.toMatchObject({ status: "indeterminate" });
      expect(fixture.submissions).toHaveLength(0);
      // Recovery finds no entry, seals frame B, commits it and sends it.
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "indeterminate" });
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.seals()).toBe(2);
      const id = fixture.packet().packetId;
      const sentB = await fixture.outboxStore.load(id);
      expect(sentB).toMatchObject({ encrypted: fixture.submissions[0]!.encrypted, state: "indeterminate" });
      // A's write reaches the store only now, and loses to B's newer generation.
      const lateA = await fixture.releaseFirstSave();
      expect(await fixture.outboxStore.load(id)).toEqual(sentB);
      expect(lateA).toBe(false);
      expect(sentB).toMatchObject({ generation: 2 });
      // After the grace, empty history resends B's exact bytes, never A's.
      fixture.setTicks(70_000);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "indeterminate" });
      expect(fixture.submissions).toHaveLength(2);
      expect(fixture.submissions[1]).toEqual(fixture.submissions[0]);
      expect(fixture.seals()).toBe(2);
    } finally { await fixture.cleanup(); }
  });

  test("round 6: an acknowledged outbox entry is final when the lifecycle write after the ack fails", async () => {
    // History lags (stays empty): only the stored acknowledgement settles the send.
    const fixture = await delayedSendFixture({
      ack: { l2psStatus: "submitted" }, failLifecycleWriteAfterSend: true,
    });
    try {
      await expect(fixture.offer()).resolves.toMatchObject({
        status: "indeterminate", reason: "lifecycle store unavailable",
      });
      const id = fixture.packet().packetId;
      const acknowledged = await fixture.outboxStore.load(id);
      expect(acknowledged).toMatchObject({ state: "acknowledged" });
      fixture.restart();
      fixture.setTicks(10_001);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.historyCalls()).toBe(0);
      expect(await fixture.outboxStore.load(id)).toEqual(acknowledged);
      // Publishing again neither sends nor rewrites the entry.
      await expect(fixture.transport.publish(fixture.packet())).resolves.toEqual({ disposition: "acknowledged" });
      expect(fixture.submissions).toHaveLength(1);
      expect(await fixture.outboxStore.load(id)).toEqual(acknowledged);
    } finally { await fixture.cleanup(); }
  });

  test("round 6: a stored frame that no longer opens to the packet is never resent", async () => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      fixture.rotateKey();
      fixture.restart();
      fixture.setTicks(72_000);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate", reason: "Demos L2PS RFQ stored send frame does not open to this packet",
      });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test.each([
    { field: "packetId", value: "f".repeat(64) },
    { field: "fromPeer", value: THIRD_PEER },
    { field: "toPeer", value: THIRD_PEER },
    { field: "l2psUid", value: "l2ps:another-subnet" },
    { field: "codecId", value: "another-codec:v1" },
  ])("round 6: an outbox entry bound to another $field is refused, never resent", async ({ field, value }) => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      const id = fixture.packet().packetId;
      const entry = await fixture.outboxStore.load(id) as Record<string, unknown> & { generation: number };
      const swapped = { ...entry, [field]: value, generation: entry.generation + 1 };
      await expect(fixture.outboxStore.save(id, swapped as never, entry.generation)).resolves.toBe(true);
      // Past the grace with empty history, a valid entry would authorize a resend.
      fixture.setTicks(72_000);
      await expect(fixture.transport.reconcile(fixture.packet())).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable",
      });
      await expect(fixture.transport.publish(fixture.packet())).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable",
      });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test("round 6: an outbox read failure in reconcile stays indeterminate", async () => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      fixture.setTicks(72_000);
      fixture.failReads(true);
      await expect(fixture.transport.reconcile(fixture.packet())).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable",
      });
      expect(fixture.historyCalls()).toBe(0);
      fixture.failReads(false);
      await expect(fixture.transport.reconcile(fixture.packet())).resolves.toEqual({ disposition: "absent" });
    } finally { await fixture.cleanup(); }
  });

  test("round 6: concurrent publishes of one packet seal and send once", async () => {
    const { hub, sharedKey, packet } = await buyerWithSentOffer();
    const base = createDemosL2psRfqAesGcmCodec({ sharedKey });
    let seals = 0;
    // A fresh outbox, so neither publish finds a stored frame.
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: {
        codecId: base.codecId,
        seal(plaintext, context) { seals += 1; return base.seal(plaintext, context); },
        open: (encrypted, context) => base.open(encrypted, context),
      },
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const sendsBefore = hub.sends;
    await expect(Promise.all([transport.publish(packet), transport.publish(packet)])).resolves.toEqual([
      { disposition: "acknowledged" },
      { disposition: "acknowledged" },
    ]);
    expect(seals).toBe(1);
    expect(hub.sends - sendsBefore).toBe(1);
  });

  test("round 6: a node duplicate refusal acknowledges when history shows our frame", async () => {
    let ticks = 0;
    let lagging = true;
    const { hub, transport, packet } = await buyerWithSentOffer({
      monotonicNowMs: () => ticks,
      history: (base) => async (peerKey, options) =>
        lagging ? { messages: [], hasMore: false } : base(peerKey, options),
    });
    hub.nodeDedup = true;
    ticks = 60_000;
    // Lagging history lets the grace authorize a resend of the same bytes.
    await expect(transport.reconcile(packet)).resolves.toEqual({ disposition: "absent" });
    lagging = false;
    await expect(transport.publish(packet)).resolves.toEqual({ disposition: "acknowledged" });
    expect(hub.sends).toBe(2);
    expect(hub.messages).toHaveLength(1);
    // The acknowledgement is stored: no further history read or send.
    lagging = true;
    await expect(transport.reconcile(packet)).resolves.toEqual({ disposition: "acknowledged" });
  });

  test("round 6: a node duplicate refusal missing from history never loops into resends", async () => {
    let ticks = 0;
    const { hub, transport, client, packet } = await buyerWithSentOffer({
      monotonicNowMs: () => ticks,
      history: () => async () => ({ messages: [], hasMore: false }),
    });
    hub.nodeDedup = true;
    ticks = 60_000;
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "indeterminate",
      reason: "Demos L2PS refused the packet hash as a duplicate that history does not show",
    });
    expect(hub.sends).toBe(2);
    for (const later of [120_000, 600_000]) {
      ticks = later;
      await expect(transport.reconcile(packet)).resolves.toEqual({
        disposition: "indeterminate",
        reason: "Demos L2PS refused the packet hash as a duplicate that history does not show",
      });
      await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "indeterminate" });
    }
    expect(hub.sends).toBe(2);
  });

  // Fixtures copied from demosdk 4.0.16 build/instant_messaging/l2ps_types.d.ts:
  // MessageSentResponse:104-109; MessageQueuedResponse:111-117.
  // L2PSMessagingPeer.js:116-126,319 returns frame.payload (no outer metadata).
  test.each([
    { l2psStatus: "submitted" },
    { status: "queued" },
  ])("round 5: source acknowledgement fixture %j is accepted", async (fields) => {
    const fixture = await delayedSendFixture({ ack: fields });
    try {
      await expect(fixture.offer()).resolves.toMatchObject({ status: "ready" });
      expect(fixture.historyCalls()).toBe(0);
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test.each([
    { l2psStatus: "submitted", unexpected: "extra" },
    { status: "queued", unexpected: "extra" },
    { l2psStatus: "submitted", error: "server error" },
    { status: "queued", error: "server error" },
  ])("round 5: extra acknowledgement fields %j remain indeterminate", async (fields) => {
    const fixture = await delayedSendFixture({ ack: fields });
    try {
      await expect(fixture.offer()).resolves.toMatchObject({ status: "indeterminate" });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test("round 6: a 0x mixed-case local key matches the node's canonical history rows", async () => {
    // Node 61b8e75 strips 0x and lower-cases keys before it stores, queries
    // or delivers them (features/l2ps-messaging/keys.ts:13-16).
    const nodeKey = (key: string) => key.replace(/^0x/i, "").toLowerCase();
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    let ticks = 0;
    const make = (localClaim: string, localPeerKey: string) => {
      const base = hub.peer(nodeKey(localPeerKey));
      return createDemosL2psRfqTransport<string>({
        peer: {
          ...base,
          send: (to, encrypted, messageHash) => base.send(nodeKey(to), encrypted, messageHash),
          history: (peerKey, options) => base.history(nodeKey(peerKey), options),
        },
        codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
        l2psUid: L2PS_UID,
        peerChannel: "loopback",
        outboxStore: memorySendOutbox(),
        monotonicNowMs: () => ticks,
        localClaim,
        localPeerKey,
        peerForClaim,
        claimForPeer,
        onError: vi.fn(),
      });
    };
    const buyerTransport = make(BUYER, `0x${"Aa".repeat(32)}`);
    const sellerTransport = make(SELLER, `0X${"bB".repeat(32)}`);
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(clientOptions("buyer", buyerTransport, reservation));
    const sellerClient = createDurableRfqLifecycleClient(clientOptions("seller", sellerTransport, reservation));
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    hub.loseNextResponse = true;
    await expect(buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    expect(hub.messages[0]).toMatchObject({ from: BUYER_PEER, to: SELLER_PEER });
    // Past the grace: only a history match keeps this from a resend.
    ticks = 60_000;
    await expect(buyerClient.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    expect(hub.sends).toBe(1);
    sellerTransport.start((packet) => sellerClient.receive(packet));
    await expect(sellerTransport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 1, ignored: 0,
      skipped: [],
    });
    sellerTransport.stop();
  });

  test("round 6: mapped 0x or mixed-case peer keys route and receive in canonical form", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const mixedPeerForClaim = (claim: string) =>
      claim === BUYER ? `0x${"AA".repeat(32)}` : claim === SELLER ? `0X${"Bb".repeat(32)}` : undefined;
    const errors: Error[] = [];
    const make = (localClaim: string, localPeerKey: string) => createDemosL2psRfqTransport<string>({
      peer: hub.peer(localPeerKey),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim,
      localPeerKey,
      peerForClaim: mixedPeerForClaim,
      // Accepts only the canonical form, as inbound `from` always is.
      claimForPeer,
      onError: (error) => errors.push(error),
    });
    const buyerTransport = make(BUYER, BUYER_PEER);
    const sellerTransport = make(SELLER, SELLER_PEER);
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(clientOptions("buyer", buyerTransport, reservation));
    const sellerClient = createDurableRfqLifecycleClient(clientOptions("seller", sellerTransport, reservation));
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    const received = vi.fn((packet: unknown) => sellerClient.receive(packet));
    sellerTransport.start(received);
    await expect(buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "ready" });
    await sellerTransport.drain();
    expect(hub.messages[0]).toMatchObject({ from: BUYER_PEER, to: SELLER_PEER });
    expect(received).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    sellerTransport.stop();
  });

  test.each(["sync", "async"] as const)("round 7: an outbox save that returns undefined (%s) is not a commit", async (mode) => {
    const { hub, sharedKey, packet } = await buyerWithSentOffer();
    // The old `save(): void` contract: the write lands but confirms nothing.
    const entries = new Map<string, unknown>();
    let saves = 0;
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: {
        load: (packetId) => structuredClone(entries.get(packetId)),
        save(packetId, entry) {
          saves += 1;
          entries.set(packetId, structuredClone(entry));
          return (mode === "sync" ? undefined : Promise.resolve(undefined)) as never;
        },
      },
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const sendsBefore = hub.sends;
    // The pre-send save, then the recovery-start save on the stored marker.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(transport.publish(packet)).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable",
      });
    }
    expect(saves).toBe(2);
    expect(hub.sends).toBe(sendsBefore);
  });

  test.each([
    { generation: 0 },
    { generation: -1 },
    { generation: 1.5 },
    { generation: "2" },
    { generation: undefined },
  ])("round 7: a stored outbox generation of $generation is refused, never resent", async ({ generation }) => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      const id = fixture.packet().packetId;
      const entry = await fixture.outboxStore.load(id) as Record<string, unknown> & { generation: number };
      const lost = { ...entry, generation };
      await expect(fixture.outboxStore.save(id, lost as never, entry.generation)).resolves.toBe(true);
      // Past the grace with empty history, a valid entry would authorize a resend.
      fixture.setTicks(72_000);
      await expect(fixture.transport.reconcile(fixture.packet())).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable",
      });
      await expect(fixture.transport.publish(fixture.packet())).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable",
      });
      expect(fixture.historyCalls()).toBe(0);
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test.each([
    { mapped: THIRD_PEER, delivered: true },
    { mapped: `0X${THIRD_PEER.toUpperCase()}`, delivered: true },
    { mapped: BUYER_PEER, delivered: false },
    { mapped: undefined, delivered: false },
    { mapped: "not-a-peer-key", delivered: false },
  ])("round 7: live receive needs peerForClaim(claimForPeer(from)) to be from (mapped $mapped)", async ({ mapped, delivered }) => {
    const { hub, baseCodec, packet } = await buyerWithSentOffer();
    // A valid frame from THIRD_PEER, which claimForPeer maps to the buyer.
    const encrypted = await baseCodec.seal(
      new TextEncoder().encode(canonicalize(packet as unknown as Record<string, unknown>)),
      { messageHash: packet.packetId, fromPeer: THIRD_PEER, toPeer: SELLER_PEER },
    );
    const errors: Error[] = [];
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(SELLER_PEER),
      codec: baseCodec,
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim: (claim) => (claim === BUYER ? mapped : peerForClaim(claim)),
      claimForPeer: (peerKey) => (peerKey === THIRD_PEER ? BUYER : claimForPeer(peerKey)),
      onError: (error) => errors.push(error),
    });
    const client = createDurableRfqLifecycleClient(clientOptions("seller", transport, durableReservation()));
    await client.open(openInput());
    const receive = vi.fn((candidate: unknown) => client.receive(candidate));
    transport.start(receive);
    for (const handler of hub.handlers.get(SELLER_PEER) ?? []) {
      handler({ from: THIRD_PEER, encrypted: structuredClone(encrypted), messageHash: packet.packetId });
    }
    await transport.drain();
    transport.stop();
    if (delivered) {
      expect(errors).toEqual([]);
      expect(receive).toHaveBeenCalledTimes(1);
    } else {
      expect(errors.map((error) => error.message)).toEqual([
        "Demos L2PS RFQ peer/claim mapping is not reciprocal",
      ]);
      expect(receive).not.toHaveBeenCalled();
    }
  });

  test("round 7: reconcile waits for an in-flight publish of the same packet", async () => {
    const { hub, sharedKey, packet } = await buyerWithSentOffer();
    const base = hub.peer(BUYER_PEER);
    const sendEntered = gate();
    const sendRelease = gate();
    let historyReads = 0;
    const expectedGenerations: number[] = [];
    const store = memorySendOutbox();
    const transport = createDemosL2psRfqTransport<string>({
      peer: {
        ...base,
        async send(to, encrypted, messageHash) {
          sendEntered.release();
          await sendRelease.promise;
          return base.send(to, encrypted, messageHash);
        },
        history(peerKey, options) {
          historyReads += 1;
          return base.history(peerKey, options);
        },
      },
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: {
        load: store.load,
        save(packetId, entry, expectedGeneration) {
          expectedGenerations.push(expectedGeneration);
          return store.save(packetId, entry, expectedGeneration);
        },
      },
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const publishing = transport.publish(packet);
    // The pre-send entry is committed as `sending`, with no end time yet.
    await sendEntered.promise;
    const reconciling = transport.reconcile(packet);
    await settle();
    sendRelease.release();
    await expect(publishing).resolves.toEqual({ disposition: "acknowledged" });
    await expect(reconciling).resolves.toEqual({ disposition: "acknowledged" });
    expect(expectedGenerations).toEqual([0, 1]);
    expect(historyReads).toBe(0);
    expect(await store.load(packet.packetId)).toMatchObject({ state: "acknowledged", generation: 2 });
  });

  test.each(["throw", "hang"] as const)("round 7: a stored frame whose open is unavailable (codec %s) is never resent", async (fault) => {
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      fixture.failOpens(fault);
      // Past the grace with empty history: only the open check holds the resend.
      fixture.setTicks(72_000);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate", reason: "Demos L2PS RFQ stored send frame does not open to this packet",
      });
      expect(fixture.submissions).toHaveLength(1);
      fixture.failOpens(undefined);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      expect(fixture.submissions).toHaveLength(2);
      expect(fixture.submissions[1]).toEqual(fixture.submissions[0]);
    } finally { await fixture.cleanup(); }
  });

  /** The bytes of another valid packet of the same job: a different offer. */
  async function otherOfferBytes(): Promise<Uint8Array> {
    const donor = await delayedSendFixture({ ack: { l2psStatus: "submitted" } });
    try {
      await expect(donor.offer("8")).resolves.toMatchObject({ status: "ready" });
      const bytes = donor.plaintexts()[0];
      if (bytes === undefined) throw new Error("donor packet missing");
      return bytes;
    } finally { await donor.cleanup(); }
  }

  test("round 8: a stored frame that opens to another valid packet of the job is never resent", async () => {
    const other = await otherOfferBytes();
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      expect(Buffer.from(other).equals(Buffer.from(fixture.plaintexts()[0]!))).toBe(false);
      fixture.openAs(other);
      // Past the grace with empty history: only the stored-frame compare holds the resend.
      fixture.setTicks(72_000);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate", reason: "Demos L2PS RFQ stored send frame does not open to this packet",
      });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test("round 8: our history frame that opens to another valid packet of the job is a conflict", async () => {
    const other = await otherOfferBytes();
    const fixture = await delayedSendFixture();
    try {
      await fixture.timeout();
      fixture.acceptLate();
      fixture.showHistory();
      fixture.openAs(other);
      await expect(fixture.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "rejected", reason: "Demos L2PS history binds packetId to different bytes or route",
      });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test("round 7: a peer key shorter than 64 hex digits is refused", async () => {
    const hub = new FakeL2psHub();
    const base = {
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback" as const,
      outboxStore: memorySendOutbox(),
      localClaim: SELLER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    };
    for (const localPeerKey of ["b".repeat(64), `0x${"B".repeat(64)}`]) {
      expect(() => createDemosL2psRfqTransport({ ...base, localPeerKey })).not.toThrow();
    }
    for (const localPeerKey of ["b".repeat(63), `0x${"b".repeat(63)}`, "b".repeat(40), "0x"]) {
      expect(() => createDemosL2psRfqTransport({ ...base, localPeerKey }))
        .toThrow("localPeerKey must be a hex public key");
    }
    // A mapped recipient key meets the same floor, before any seal or send.
    const sent = await buyerWithSentOffer();
    const short = "b".repeat(63);
    const transport = createDemosL2psRfqTransport<string>({
      peer: sent.hub.peer(BUYER_PEER),
      codec: sent.baseCodec,
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim: (claim) => (claim === SELLER ? short : peerForClaim(claim)),
      claimForPeer: (peerKey) => (peerKey === short ? SELLER : claimForPeer(peerKey)),
      onError: vi.fn(),
    });
    const sendsBefore = sent.hub.sends;
    await expect(transport.publish(sent.packet)).resolves.toEqual({
      disposition: "rejected", reason: "resolved peer key must be a hex public key",
    });
    expect(sent.hub.sends).toBe(sendsBefore);
  });

  test("round 8: a real demosdk peer on plain ws:// is accepted only for a loopback IP literal", async () => {
    for (const serverUrl of [
      "ws://127.0.0.1:3006", "ws://127.8.9.10", "ws://127.1:3006", "WS://127.0.0.1",
      "ws://[::1]:3006", "ws://[0:0:0:0:0:0:0:1]",
    ]) {
      expect(constructionError(channelOptions(await demosPeer(demosConfig(serverUrl))))).toBeUndefined();
    }
    for (const serverUrl of [
      // localhost is a name the resolver maps, so it never counts, in any form.
      "ws://localhost:3006", "ws://LOCALHOST", "ws://localhost.", "ws://rfq.localhost",
      "ws://notlocalhost", "ws://127.0.0.1.example", "ws://127.0.0.1@node.example",
      "ws://[::ffff:127.0.0.1]", "ws://128.0.0.1", "ws://0.0.0.0",
      "http://127.0.0.1", "https://node.example",
    ]) {
      expectChannelRefusal(channelOptions(await demosPeer(demosConfig(serverUrl))), "insecure");
    }
  });

  test("round 8: a real demosdk peer on remote ws:// is refused whatever peerChannel says, naming no secret", async () => {
    // demosdk's own JSDoc URL shape, pointed at a remote node.
    const url = "ws://rfq-user:s3cret-pass@node.example:3006/l2ps?token=hunter2";
    for (const peerChannel of [undefined, "wss", "loopback"]) {
      const error = expectChannelRefusal(channelOptions(await demosPeer(demosConfig(url)), peerChannel), "insecure");
      for (const secret of ["rfq-user", "s3cret-pass", "node.example", "hunter2"]) {
        expect(error.message).not.toContain(secret);
        expect(String(error.stack)).not.toContain(secret);
      }
      expect(error.cause).toBeUndefined();
    }
  });

  test("round 8: a real demosdk peer whose URL is not a string that parses is refused", async () => {
    for (const serverUrl of [
      "", "not a url", "ws://", "ws://[::1", "ws://127.0.0.256", "wss://exa mple.com",
      // Readable but not a string: the peer still dials it, so peerChannel cannot vouch.
      new URL("ws://node.example:3006"), new URL("wss://node.example:3006"), undefined, 3006,
    ]) {
      for (const peerChannel of [undefined, "wss", "loopback"]) {
        const error = expectChannelRefusal(
          channelOptions(await demosPeer(demosConfig(serverUrl)), peerChannel), "malformed");
        // Node's URL error carries the input, so it must not ride along.
        expect(error.cause).toBeUndefined();
      }
    }
  });

  test("round 8: a real demosdk peer on wss:// is accepted, and peerChannel must match a URL it can read", async () => {
    const wss = demosConfig("wss://node.example:3006");
    const loopback = demosConfig("ws://127.0.0.1:3006");
    expect(constructionError(channelOptions(await demosPeer(wss)))).toBeUndefined();
    expect(constructionError(channelOptions(await demosPeer(wss), "wss"))).toBeUndefined();
    expect(constructionError(channelOptions(await demosPeer(loopback), "loopback"))).toBeUndefined();
    expectChannelRefusal(channelOptions(await demosPeer(wss), "loopback"), "mismatch");
    expectChannelRefusal(channelOptions(await demosPeer(loopback), "wss"), "mismatch");
  });

  test("round 8: a peer that hides its URL is refused unless peerChannel states the channel", async () => {
    const hub = new FakeL2psHub();
    const hidden: DemosL2psRfqPeerLike[] = [
      hub.peer(BUYER_PEER),
      // A wrapper's own config without a string serverUrl tells nothing.
      Object.assign(hub.peer(BUYER_PEER), { config: { endpoint: "wss://node.example" } }),
      Object.assign(hub.peer(BUYER_PEER), { config: "wss://node.example" }),
    ];
    for (const peer of hidden) {
      expectChannelRefusal(channelOptions(peer), "unstated");
      for (const peerChannel of ["wss", "loopback"]) {
        expect(constructionError(channelOptions(peer, peerChannel))).toBeUndefined();
      }
      for (const peerChannel of ["ws", "WSS", "tls", "ws://127.0.0.1:3006", true, null]) {
        const error = constructionError(channelOptions(peer, peerChannel));
        expect(error).toBeInstanceOf(DacsError);
        expect((error as Error).message).toBe('Demos L2PS RFQ peerChannel must be "wss" or "loopback"');
      }
    }
  });

  test("round 8: a getter-backed, inherited or proxied config or serverUrl is never read and counts as hidden", async () => {
    const reads = vi.fn();
    const wssConfig = () => demosConfig("wss://node.example:3006");
    // demosdk keeps the caller's config object, so its getter sits on the real peer.
    const getterUrl = await demosPeer(Object.defineProperty(wssConfig(), "serverUrl", {
      enumerable: true, get: () => { reads(); return "wss://node.example:3006"; },
    }));
    const getterConfig = await demosPeer(wssConfig());
    Object.defineProperty(getterConfig, "config", {
      enumerable: true, get: () => { reads(); return wssConfig(); },
    });
    const proxiedConfig = await demosPeer(new Proxy(wssConfig(), {
      get: (target, key, receiver) => { reads(); return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor: (target, key) => { reads(); return Reflect.getOwnPropertyDescriptor(target, key); },
      has: (target, key) => { reads(); return Reflect.has(target, key); },
      ownKeys: (target) => { reads(); return Reflect.ownKeys(target); },
    }));
    const inherited = Object.assign(
      Object.create({ config: wssConfig() }) as object, new FakeL2psHub().peer(BUYER_PEER),
    ) as DemosL2psRfqPeerLike;
    for (const peer of [getterUrl, getterConfig, proxiedConfig, inherited]) {
      expectChannelRefusal(channelOptions(peer), "unstated");
      // Each would read as wss://, which a stated "loopback" contradicts.
      expect(constructionError(channelOptions(peer, "loopback"))).toBeUndefined();
    }
    expect(reads).not.toHaveBeenCalled();
  });

  test("round 4: a stuck consumer from a retired generation does not hold back the next one", async () => {
    const fixture = await inboundReceiver();
    // Never advanced: neither the consumer nor any operation timeout can fire.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      let retiredSignal: AbortSignal | undefined;
      const stuck = vi.fn((_packet: unknown, options: { signal: AbortSignal }) => {
        retiredSignal = options.signal;
        return new Promise<never>(() => {});
      });
      fixture.transport.start(stuck);
      fixture.emit(fixture.payload);
      await settle();
      expect(stuck).toHaveBeenCalledTimes(1);
      expect(retiredSignal?.aborted).toBe(false);

      fixture.transport.stop();
      expect(retiredSignal?.aborted).toBe(true);
      const current = vi.fn((packet: unknown) => fixture.client.receive(packet));
      fixture.transport.start(current);
      fixture.emit(fixture.payload);
      let drained = false;
      void fixture.transport.drain().then(() => { drained = true; });
      await settle();
      expect(current).toHaveBeenCalledTimes(1);
      await expect(current.mock.results[0]?.value).resolves.toMatchObject({ status: "ready" });
      expect(drained).toBe(true);
      expect(stuck).toHaveBeenCalledTimes(1);
      expect(fixture.errors).toHaveLength(0);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("round 4: times out a never-settling live consumer and releases its charge", async () => {
    const fixture = await inboundReceiver({ consumerTimeoutMs: 1_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      const signals: AbortSignal[] = [];
      const consumer = vi.fn((packet: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return signals.length === 1 ? new Promise<never>(() => {}) : fixture.client.receive(packet);
      });
      fixture.transport.start(consumer);
      fixture.emit(fixture.payload);
      await settle();
      expect(consumer).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(999);
      await settle();
      expect(fixture.errors).toHaveLength(0);
      expect(signals[0]?.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      await settle();
      expect(fixture.errors.map((error) => error.message)).toEqual([CONSUMER_TIMEOUT]);
      expect(fixture.errors[0]).toBeInstanceOf(TransientError);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[0]?.reason).toBe(fixture.errors[0]);
      await fixture.transport.drain();

      // The next event is delivered, and the lane's accounting is back to zero.
      fixture.emit(fixture.payload);
      await fixture.transport.drain();
      expect(consumer).toHaveBeenCalledTimes(2);
      await expect(consumer.mock.results[1]?.value).resolves.toMatchObject({ status: "ready" });
      expect(fixture.errors).toHaveLength(1);
      await expectFullLiveCapacity(fixture);
      expect(fixture.errors).toHaveLength(2);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["resolves", "rejects"] as const)("round 4: a live consumer that %s after its timeout has no further effect", async (outcome) => {
    const fixture = await inboundReceiver({ consumerTimeoutMs: 1_000 });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      const late = gate();
      let calls = 0;
      const consumer = vi.fn(async (packet: unknown) => {
        calls += 1;
        if (calls > 1) return fixture.client.receive(packet);
        await late.promise;
        if (outcome === "rejects") throw new Error("late consumer failure");
        return fixture.client.receive(packet);
      });
      fixture.transport.start(consumer);
      fixture.emit(fixture.payload);
      await settle();
      vi.advanceTimersByTime(1_000);
      await settle();
      expect(fixture.errors.map((error) => error.message)).toEqual([CONSUMER_TIMEOUT]);

      late.release();
      await settle();
      vi.advanceTimersByTime(60_000);
      await settle();
      await fixture.transport.drain();
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(fixture.errors).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
      // A second release of the timed-out charge would let a 101st event in.
      await expectFullLiveCapacity(fixture);
      expect(consumer).toHaveBeenCalledTimes(101);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", unhandled);
    }
  });

  test("round 4: resumeInbound returns indeterminate when its consumer never settles", async () => {
    const fixture = await inboundReceiver({ consumerTimeoutMs: 1_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      let signal: AbortSignal | undefined;
      const stuck = vi.fn((_packet: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise<never>(() => {});
      });
      fixture.transport.start(stuck);
      let result: unknown;
      void fixture.transport.resumeInbound(BUYER).then((value) => { result = value; });
      await settle();
      expect(stuck).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
      vi.advanceTimersByTime(1_000);
      await settle();
      expect(result).toEqual({ status: "indeterminate", delivered: 0, ignored: 0, skipped: [], reason: CONSUMER_TIMEOUT });
      expect(signal?.aborted).toBe(true);
      expect(fixture.errors).toHaveLength(0);
      expect(fixture.hub.sends).toBe(1);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["live", "recovery"] as const)("round 4: stop() aborts an in-flight %s consumer and drops its outcome", async (path) => {
    const fixture = await inboundReceiver();
    fixture.transport.stop();
    let signal: AbortSignal | undefined;
    // A cooperative consumer: it gives up as soon as its signal is aborted.
    const retired = vi.fn((_packet: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      });
    });
    fixture.transport.start(retired);
    const recovering = path === "recovery" ? fixture.transport.resumeInbound(BUYER) : undefined;
    if (path === "live") fixture.emit(fixture.payload);
    await settle();
    expect(retired).toHaveBeenCalledTimes(1);
    fixture.transport.stop();
    expect(signal?.aborted).toBe(true);
    const current = vi.fn((packet: unknown) => fixture.client.receive(packet));
    fixture.transport.start(current);
    await settle();
    if (recovering !== undefined) {
      await expect(recovering).resolves.toEqual({
        status: "indeterminate",
        delivered: 0, ignored: 0,
        skipped: [],
        reason: "Demos L2PS inbound recovery generation retired",
      });
    }
    expect(fixture.errors).toHaveLength(0);
    expect(current).not.toHaveBeenCalled();
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({ status: "complete", delivered: 1, ignored: 0, skipped: [] });
    fixture.transport.stop();
  });

  test("round 4: validates consumerTimeoutMs like operationTimeoutMs", () => {
    const hub = new FakeL2psHub();
    const base = {
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback" as const,
      outboxStore: memorySendOutbox(),
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    };
    for (const consumerTimeoutMs of [1, 30_000, 600_000]) {
      expect(() => createDemosL2psRfqTransport({ ...base, consumerTimeoutMs })).not.toThrow();
    }
    for (const consumerTimeoutMs of [0, -1, 1.5, 600_001, Number.NaN, "1000"]) {
      expect(() => createDemosL2psRfqTransport({ ...base, consumerTimeoutMs: consumerTimeoutMs as number }))
        .toThrow("consumerTimeoutMs must be a positive safe integer at most 600000");
    }
    const read = vi.fn(() => 1_000);
    const getter = { ...base } as DemosL2psRfqTransportOptions;
    Object.defineProperty(getter, "consumerTimeoutMs", { enumerable: true, get: read });
    expect(() => createDemosL2psRfqTransport(getter))
      .toThrow("Demos L2PS RFQ transport options must use enumerable data properties");
    expect(read).not.toHaveBeenCalled();
  });

  test("round 4: releases live capacity when ingest fails, across three full rounds", async () => {
    let fail = true;
    const fixture = await inboundReceiver({ open: (base) => (encrypted, context) => {
      if (fail) throw new Error("temporary codec outage");
      return base.open(encrypted, context);
    } });
    for (let round = 1; round <= 3; round += 1) {
      for (let index = 0; index < 100; index += 1) fixture.emit(fixture.payload);
      await fixture.transport.drain();
      expect(fixture.errors).toHaveLength(100 * round);
      expect(new Set(fixture.errors.map((error) => error.message))).toEqual(new Set(["temporary codec outage"]));
    }
    fail = false;
    fixture.emit(fixture.payload);
    await fixture.transport.drain();
    expect(fixture.receive).toHaveBeenCalledTimes(1);
    expect(fixture.errors).toHaveLength(300);
    fixture.transport.stop();
  });

  test("round 4: releases live bytes when ingest fails", async () => {
    let opens = 0;
    const fixture = await inboundReceiver({ open: () => () => {
      opens += 1;
      throw new Error("temporary codec outage");
    } });
    // Each round charges most of the byte budget; a leak would overflow the next.
    const large = {
      ...fixture.payload,
      encrypted: { ...fixture.payload.encrypted, ciphertext: "A".repeat(MAX_CIPHERTEXT_CHARS) },
    };
    const perRound = Math.floor(MAX_LIVE_BYTES / liveCharge(large));
    expect(perRound).toBeLessThan(100);
    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < perRound; index += 1) fixture.emit(large);
      await fixture.transport.drain();
    }
    expect(fixture.errors.map((error) => error.message)).toEqual(Array(3 * perRound).fill("temporary codec outage"));
    expect(opens).toBe(3 * perRound);
    fixture.transport.stop();
  }, 120_000);

  test("round 4: an early recovered-frame timer stops recovery while budget remains", async () => {
    let opens = 0;
    const fixture = await inboundReceiver({ operationTimeoutMs: 20, open: () => () => {
      opens += 1;
      return new Promise<Uint8Array>(() => {});
    } });
    for (let index = 1; index < 3; index += 1) {
      fixture.hub.messages.push({ ...structuredClone(fixture.own), id: `inbound-${index}`, timestamp: fixture.own.timestamp + index });
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The shared deadline never passes on this clock, so only the open's own
    // timeout can stop the scan.
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    try {
      let result: unknown;
      void fixture.transport.resumeInbound(BUYER).then((value) => { result = value; });
      await settle();
      expect(opens).toBe(1);
      vi.advanceTimersByTime(20);
      await settle();
      expect(opens).toBe(1);
      expect(result).toMatchObject({ status: "indeterminate", delivered: 0 });
      expect(fixture.receive).not.toHaveBeenCalled();
      fixture.transport.stop();
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test.each(["live", "recovery"] as const)("round 3: retires an in-flight %s decrypt across stop/start", async (path) => {
    const blocked = gate();
    const entered = gate();
    const opened = gate();
    const fixture = await inboundReceiver({ open: (base) => async (encrypted, context) => {
      entered.release();
      await blocked.promise;
      opened.release();
      return base.open(encrypted, context);
    } });
    const recovering = path === "recovery" ? fixture.transport.resumeInbound(BUYER) : undefined;
    if (path === "live") fixture.emit(fixture.payload);
    await entered.promise;
    fixture.transport.stop();
    const current = vi.fn((packet: unknown) => fixture.client.receive(packet));
    fixture.transport.start(current);
    blocked.release();
    // drain() covers only the new generation, so let the retired work finish.
    await opened.promise;
    await settle();
    await fixture.transport.drain();
    if (recovering !== undefined) {
      await expect(recovering).resolves.toMatchObject({ status: "indeterminate", delivered: 0 });
    }
    expect(fixture.receive).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    // The replacement generation can still recover the retired packet.
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({ status: "complete", delivered: 1, ignored: 0, skipped: [] });
    expect(current).toHaveBeenCalledTimes(1);
    fixture.transport.stop();
  });

  test("round 3: retires recovery between asynchronous packet deliveries", async () => {
    const fixture = await inboundReceiver();
    const { packetId: _packetId, ...material } = fixture.packet;
    const otherMaterial = { ...material, jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" };
    const otherPacket = { ...otherMaterial, packetId: rfqLifecyclePacketId(otherMaterial) };
    fixture.hub.messages.push({
      ...structuredClone(fixture.own), id: "other-packet", messageHash: otherPacket.packetId,
      timestamp: fixture.own.timestamp + 1,
      encrypted: await fixture.baseCodec.seal(new TextEncoder().encode(canonicalize(otherPacket as unknown as Record<string, unknown>)), {
        messageHash: otherPacket.packetId, fromPeer: BUYER_PEER, toPeer: SELLER_PEER,
      }),
    });
    fixture.transport.stop();
    const blocked = gate();
    const entered = gate();
    const oldHandler = vi.fn(async (_packet: unknown) => {
      entered.release();
      await blocked.promise;
      return fixture.client.receive(fixture.packet);
    });
    fixture.transport.start(oldHandler);
    const recovering = fixture.transport.resumeInbound(BUYER);
    await entered.promise;
    fixture.transport.stop();
    const current = vi.fn();
    fixture.transport.start(current);
    blocked.release();
    await expect(recovering).resolves.toMatchObject({ status: "indeterminate", delivered: 1 });
    expect(oldHandler).toHaveBeenCalledTimes(1);
    expect(current).not.toHaveBeenCalled();
    fixture.transport.stop();
  });

  test("round 3: resumeInbound shares a 20 ms decryption budget across three hanging frames", async () => {
    let hang = true;
    let opens = 0;
    const fixture = await inboundReceiver({
      operationTimeoutMs: 20,
      open: (base) => (encrypted, context) => {
        opens += 1;
        return hang ? new Promise<Uint8Array>(() => {}) : base.open(encrypted, context);
      },
    });
    for (let index = 1; index < 3; index += 1) {
      fixture.hub.messages.push({ ...structuredClone(fixture.own), id: `inbound-${index}`, timestamp: fixture.own.timestamp + index });
    }
    const result = await fixture.transport.resumeInbound(BUYER);
    expect(result).toMatchObject({ status: "indeterminate", delivered: 0 });
    expect(opens).toBe(1);
    expect(fixture.receive).not.toHaveBeenCalled();
    expect(fixture.hub.sends).toBe(1);
    hang = false;
    opens = 0;
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({ status: "complete", delivered: 1, ignored: 0, skipped: [] });
    expect(opens).toBe(3);
    fixture.transport.stop();
  });

  test("round 3: recovery deadline persists across pages after a fast codec failure", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      let opens = 0;
      const fixture = await inboundReceiver({ operationTimeoutMs: 20, open: () => () => {
        opens += 1;
        // First failure is quick enough to leave budget for the next page.
        vi.advanceTimersByTime(15);
        throw new Error("temporary codec outage");
      } });
      // A page boundary, rather than duplicate entries in one page.
      fixture.hub.messages.push({ ...structuredClone(fixture.own), id: "newer", timestamp: fixture.own.timestamp + 1 });
      const history = fixture.hub.peer(SELLER_PEER).history;
      // Simulate each page request costing 10 ms. The second request spends the
      // remaining budget, so its frame must never reach the codec.
      const transport = createDemosL2psRfqTransport<string>({
        peer: { ...fixture.hub.peer(SELLER_PEER), history: async (peer, options) => {
          vi.advanceTimersByTime(10);
          return history(peer, options);
        } },
        codec: { codecId: "deadline-probe", seal: (bytes, context) => fixture.baseCodec.seal(bytes, context), open: () => {
          opens += 1;
          vi.advanceTimersByTime(15);
          throw new Error("temporary codec outage");
        } },
        localClaim: SELLER, localPeerKey: SELLER_PEER, l2psUid: L2PS_UID,
        peerChannel: "loopback",
        outboxStore: memorySendOutbox(),
        peerForClaim, claimForPeer, onError: vi.fn(), operationTimeoutMs: 20, historyPageSize: 1,
      });
      transport.start(fixture.receive);
      await expect(transport.resumeInbound(BUYER)).resolves.toMatchObject({ status: "indeterminate", delivered: 0 });
      expect(opens).toBe(1);
      expect(fixture.hub.sends).toBe(1);
      transport.stop();
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("round 3: rejects an oversized live event immediately behind a blocked decrypt", async () => {
    const blocked = gate();
    const entered = gate();
    const fixture = await inboundReceiver({ open: (base) => async (encrypted, context) => {
      entered.release();
      await blocked.promise;
      return base.open(encrypted, context);
    } });
    try {
      fixture.emit(fixture.payload);
      await entered.promise;
      snapshotLabels.length = 0;
      fixture.emit({ ...fixture.payload, encrypted: { ...fixture.payload.encrypted, ciphertext: "A".repeat(MAX_CIPHERTEXT_CHARS + 4) } });
      expect(fixture.errors.map((error) => error.message)).toEqual(["ciphertext exceeds its size limit"]);
      expect(snapshotLabels).not.toContain("Demos L2PS incoming RFQ payload");
    } finally {
      blocked.release();
      await fixture.transport.drain();
      fixture.transport.stop();
    }
  });

  test.each(["count", "bytes"] as const)("round 3: bounds live queue %s and releases capacity after drain", async (limit) => {
    const blocked = gate();
    const entered = gate();
    let opens = 0;
    const fixture = await inboundReceiver({ open: (base) => async (_encrypted, context) => {
      opens += 1;
      entered.release();
      await blocked.promise;
      // Synthetic large live frames still decode to the valid history packet.
      return base.open(fixture.payload.encrypted, context);
    } });
    const payload = limit === "count" ? fixture.payload : {
      ...fixture.payload,
      encrypted: { ...fixture.payload.encrypted, ciphertext: "A".repeat(MAX_CIPHERTEXT_CHARS) },
    };
    // Maximum-size frames fill the byte budget before the count budget.
    const capacity = limit === "count" ? 100 : Math.floor(MAX_LIVE_BYTES / liveCharge(payload));
    if (limit === "bytes") expect(capacity).toBeLessThan(100);
    try {
      fixture.emit(payload);
      await entered.promise;
      for (let index = 1; index < capacity; index += 1) fixture.emit(payload);
      expect(fixture.errors).toHaveLength(0);
      snapshotLabels.length = 0;
      fixture.emit(payload);
      expect(fixture.errors).toHaveLength(1);
      expect(fixture.errors[0]?.message).toBe(OVERFLOW);
      expect(fixture.errors[0]).toBeInstanceOf(TransientError);
      expect(snapshotLabels).not.toContain("Demos L2PS incoming RFQ payload");
    } finally {
      blocked.release();
      await fixture.transport.drain();
    }
    expect(opens).toBe(capacity);
    fixture.emit(fixture.payload);
    await fixture.transport.drain();
    expect(opens).toBe(capacity + 1);
    expect(fixture.errors).toHaveLength(1);
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({ status: "complete", delivered: 1, ignored: 0, skipped: [] });
    expect(fixture.hub.sends).toBe(1);
    fixture.transport.stop();
  }, 60_000);

  test("round 3: owns queued live payloads before the peer can mutate them", async () => {
    const fixture = await inboundReceiver();
    fixture.emit(fixture.payload);
    fixture.payload.encrypted.ciphertext = "AAAA";
    fixture.payload.from = THIRD_PEER;
    await fixture.transport.drain();
    expect(fixture.receive).toHaveBeenCalledTimes(1);
    expect(fixture.errors).toHaveLength(0);
    fixture.transport.stop();
  });
  test("uses fresh AES-GCM nonces and authenticates the exact peer route", async () => {
    const codec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
    const plaintext = new TextEncoder().encode("private quote");
    const context = {
      messageHash: "c".repeat(64),
      fromPeer: BUYER_PEER,
      toPeer: SELLER_PEER,
    };
    const first = await codec.seal(plaintext, context);
    const second = await codec.seal(plaintext, context);
    expect(first.nonce).not.toBe(second.nonce);
    await expect(Promise.resolve(codec.open(first, context))).resolves.toEqual(
      plaintext,
    );
    await expect(
      Promise.resolve().then(() =>
        codec.open(first, { ...context, toPeer: "d".repeat(64) }),
      ),
    ).rejects.toThrow("authentication failed");

    const tampered: DemosL2psRfqEncryptedMessage = structuredClone(first);
    const bytes = Buffer.from(tampered.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 1;
    tampered.ciphertext = bytes.toString("base64");
    await expect(
      Promise.resolve().then(() => codec.open(tampered, context)),
    ).rejects.toThrow("authentication failed");
  });

  test("completes a two-peer RFQ and reconciles a lost send response without redrive", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const buyerErrors = vi.fn();
    const sellerErrors = vi.fn();
    const buyerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: buyerErrors,
    });
    const sellerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: sellerErrors,
    });
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, reservation),
    );
    const sellerClient = createDurableRfqLifecycleClient(
      clientOptions("seller", sellerTransport, reservation),
    );
    buyerTransport.start((packet) => buyerClient.receive(packet));
    sellerTransport.start((packet) => sellerClient.receive(packet));
    await expect(buyerClient.open(openInput())).resolves.toMatchObject({
      status: "ready",
    });
    await expect(sellerClient.open(openInput())).resolves.toMatchObject({
      status: "ready",
    });

    hub.loseNextResponse = true;
    await expect(
      buyerClient.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "indeterminate" });
    await sellerTransport.drain();
    expect(hub.sends).toBe(1);
    await expect(buyerClient.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);

    await expect(sellerClient.sendAccept(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    await buyerTransport.drain();
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    await sellerTransport.drain();
    await buyerTransport.drain();

    const buyerStatus = await buyerClient.getStatus(JOB_ID);
    const sellerStatus = await sellerClient.getStatus(JOB_ID);
    expect(buyerStatus.status).toBe("ok");
    expect(sellerStatus.status).toBe("ok");
    if (buyerStatus.status !== "ok" || sellerStatus.status !== "ok") return;
    expect(buyerStatus.record.transcript).toEqual(sellerStatus.record.transcript);
    expect(buyerStatus.record.agreement?.finalized).toEqual(
      sellerStatus.record.agreement?.finalized,
    );
    expect(buyerStatus.record.agreement?.finalized?.signatures).toHaveLength(2);
    expect(hub.messages).toHaveLength(4);
    expect(buyerErrors).not.toHaveBeenCalled();
    expect(sellerErrors).not.toHaveBeenCalled();
    buyerTransport.stop();
    sellerTransport.stop();
  });

  test("replays an inbound packet from Demos history after the receiver restarts", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const buyerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const sellerErrors = vi.fn();
    const sellerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: sellerErrors,
    });
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, reservation),
    );
    const sellerClient = createDurableRfqLifecycleClient(
      clientOptions("seller", sellerTransport, reservation),
    );
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());

    // No seller handler is registered when the server accepts the packet.
    await expect(
      buyerClient.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    let sellerStatus = await sellerClient.getStatus(JOB_ID);
    expect(
      sellerStatus.status === "ok" && sellerStatus.record.transcript.length,
    ).toBe(0);

    sellerTransport.start((packet) => sellerClient.receive(packet));
    await expect(sellerTransport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 1, ignored: 0,
      skipped: [],
    });
    sellerStatus = await sellerClient.getStatus(JOB_ID);
    expect(
      sellerStatus.status === "ok" && sellerStatus.record.transcript.length,
    ).toBe(1);
    await expect(sellerTransport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 1, ignored: 0,
      skipped: [],
    });
    expect(sellerErrors).not.toHaveBeenCalled();
    sellerTransport.stop();
  });

  test("never redrives when history binds the packet hash to unreadable ciphertext", async () => {
    const hub = new FakeL2psHub();
    const buyerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, durableReservation()),
    );
    await buyerClient.open(openInput());
    hub.loseNextResponse = true;
    await expect(
      buyerClient.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "indeterminate" });
    const stored = hub.messages[0];
    if (stored === undefined) throw new Error("accepted frame is missing");
    const ciphertext = Buffer.from(stored.encrypted.ciphertext, "base64");
    ciphertext[0] = ciphertext[0]! ^ 1;
    stored.encrypted.ciphertext = ciphertext.toString("base64");

    await expect(buyerClient.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "rejected",
      reason: "Demos L2PS history binds packetId to different bytes or route",
    });
    expect(hub.sends).toBe(1);
    const status = await buyerClient.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.failure).toMatchObject({ class: "transport" });
  });

  test("keeps a transient seal failure retryable until authenticated absence", async () => {
    const hub = new FakeL2psHub();
    const baseCodec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
    let failSeal = true;
    const codec: DemosL2psRfqWireCodec = {
      codecId: baseCodec.codecId,
      seal(plaintext, context) {
        if (failSeal) {
          failSeal = false;
          throw new Error("transient codec outage");
        }
        return baseCodec.seal(plaintext, context);
      },
      open(encrypted, context) {
        return baseCodec.open(encrypted, context);
      },
    };
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec,
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());

    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    expect(hub.sends).toBe(0);
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
  });

  test("keeps a transient peer-mapping failure retryable", async () => {
    const hub = new FakeL2psHub();
    let failMapping = true;
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim(claim) {
        if (failMapping) {
          failMapping = false;
          throw new Error("transient mapping outage");
        }
        return peerForClaim(claim);
      },
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());

    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    expect(hub.sends).toBe(0);
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
  });

  test("rejects a malformed encrypted frame before peer send", async () => {
    const hub = new FakeL2psHub();
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: {
        codecId: "malformed-frame-test",
        seal: () => ({} as never),
        open: () => new Uint8Array(),
      },
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());

    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "rejected" });
    expect(hub.sends).toBe(0);
  });

  test("captures receiver-bound peer, codec, mapping, and error capabilities once", async () => {
    const hub = new FakeL2psHub();
    const backingPeer = hub.peer(BUYER_PEER);
    let registered: DemosL2psRfqMessageHandler | undefined;
    let removed = false;
    const peer: DemosL2psRfqPeerLike = {
      send(to, encrypted, messageHash) {
        expect(this).toBe(peer);
        return backingPeer.send(to, encrypted, messageHash);
      },
      history(peerKey, historyOptions) {
        expect(this).toBe(peer);
        return backingPeer.history(peerKey, historyOptions);
      },
      onMessage(handler) {
        expect(this).toBe(peer);
        registered = handler;
      },
      removeMessageHandler(handler) {
        expect(this).toBe(peer);
        expect(handler).toBe(registered);
        removed = true;
      },
    };
    const backingCodec = createDemosL2psRfqAesGcmCodec({
      sharedKey: randomBytes(32),
    });
    const codec: DemosL2psRfqWireCodec = {
      codecId: backingCodec.codecId,
      seal(plaintext, context) {
        expect(this).toBe(codec);
        return backingCodec.seal(plaintext, context);
      },
      open(encrypted, context) {
        expect(this).toBe(codec);
        return backingCodec.open(encrypted, context);
      },
    };
    const errors: Error[] = [];
    let options!: DemosL2psRfqTransportOptions;
    options = {
      peer,
      codec,
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim(claim) {
        expect(this).toBe(options);
        return peerForClaim(claim);
      },
      claimForPeer(peerKey) {
        expect(this).toBe(options);
        return claimForPeer(peerKey);
      },
      onError(error) {
        expect(this).toBe(options);
        errors.push(error);
      },
    };
    const transport = createDemosL2psRfqTransport<string>(options);
    peer.send = async () => { throw new Error("swapped send"); };
    peer.history = async () => { throw new Error("swapped history"); };
    peer.onMessage = () => { throw new Error("swapped onMessage"); };
    peer.removeMessageHandler = () => { throw new Error("swapped remove handler"); };
    codec.seal = () => { throw new Error("swapped seal"); };
    codec.open = () => { throw new Error("swapped open"); };
    options.peerForClaim = () => { throw new Error("swapped peer mapping"); };
    options.claimForPeer = () => { throw new Error("swapped claim mapping"); };
    options.onError = () => { throw new Error("swapped error handler"); };

    transport.start(async () => ({ status: "duplicate", record: {} as never }));
    if (registered === undefined) throw new Error("message handler was not registered");
    registered({} as never);
    await transport.drain();
    expect(errors).toHaveLength(1);
    transport.stop();
    expect(removed).toBe(true);

    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "ready" });
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    const packet = status.record.outbox[0]?.packet;
    if (packet === undefined) throw new Error("outbox packet missing");
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
  });

  test("keeps a slow or failing history decryption retryable instead of terminal", async () => {
    const hub = new FakeL2psHub();
    const baseCodec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
    const openFaults: Array<"hang" | "throw"> = ["hang", "throw"];
    const codec: DemosL2psRfqWireCodec = {
      codecId: baseCodec.codecId,
      seal(plaintext, context) {
        return baseCodec.seal(plaintext, context);
      },
      open(encrypted, context) {
        const fault = openFaults.shift();
        if (fault === "hang") return new Promise<Uint8Array>(() => {});
        if (fault === "throw") throw new Error("transient KMS outage");
        return baseCodec.open(encrypted, context);
      },
    };
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec,
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
      operationTimeoutMs: 50,
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    hub.loseNextResponse = true;
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate",
      });
      const status = await client.getStatus(JOB_ID);
      if (status.status !== "ok") throw new Error("record did not load");
      expect(status.record.failure).toBeUndefined();
    }
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
  });

  test("ignores a counterparty-authored history entry that reuses the packet hash", async () => {
    let ticks = 0;
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      monotonicNowMs: () => ticks,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    hub.loseNextResponse = true;
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    const own = hub.messages[0];
    if (own === undefined) throw new Error("accepted frame is missing");
    const counterparty: DemosL2psRfqStoredMessage = {
      id: "counterparty-reuse",
      from: SELLER_PEER,
      to: BUYER_PEER,
      messageHash: own.messageHash,
      encrypted: await createDemosL2psRfqAesGcmCodec({ sharedKey }).seal(
        new TextEncoder().encode("{}"),
        { messageHash: own.messageHash, fromPeer: SELLER_PEER, toPeer: BUYER_PEER },
      ),
      l2psUid: L2PS_UID,
      l2psTxHash: null,
      timestamp: NOW + 100,
      status: "delivered",
    };
    hub.messages.push(counterparty);

    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    expect(status.record.failure).toBeUndefined();
    const packet = status.record.outbox[0]?.packet;
    if (packet === undefined) throw new Error("outbox packet missing");

    // Without our own entry the counterparty frame proves nothing either way.
    hub.messages.splice(hub.messages.indexOf(own), 1);
    ticks = 60_000;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
  });

  test("separates a subnet mismatch from a definite packet-hash conflict", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    // A lost response: a stored acknowledgement would settle without history.
    hub.loseNextResponse = true;
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    const packet = status.record.outbox[0]?.packet;
    const own = hub.messages[0];
    if (packet === undefined || own === undefined) throw new Error("frame missing");

    own.l2psUid = "l2ps:another-subnet";
    await expect(transport.reconcile(packet)).resolves.toMatchObject({
      disposition: "indeterminate",
    });

    own.l2psUid = L2PS_UID;
    own.encrypted = await createDemosL2psRfqAesGcmCodec({ sharedKey }).seal(
      new TextEncoder().encode(
        canonicalize({ ...packet, packetId: "f".repeat(64) } as unknown as Record<string, unknown>),
      ),
      { messageHash: packet.packetId, fromPeer: BUYER_PEER, toPeer: SELLER_PEER },
    );
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "rejected",
      reason: "Demos L2PS history binds packetId to different bytes or route",
    });
  });

  test("bounds an unresponsive Demos send and retains an indeterminate outbox", async () => {
    const peer: DemosL2psRfqPeerLike = {
      async send() {
        return new Promise(() => {});
      },
      async history() {
        return { messages: [], hasMore: false };
      },
      onMessage() {},
    };
    const transport = createDemosL2psRfqTransport<string>({
      peer,
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
      operationTimeoutMs: 10,
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    await expect(
      client.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: "Demos L2PS RFQ send outcome is unknown: Demos L2PS RFQ send timed out",
    });
    const status = await client.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.outbox[0]).toMatchObject({ state: "indeterminate" });
  });

  test("refuses an oversized live payload before the canonical snapshot", async () => {
    const hub = new FakeL2psHub();
    const errors: Error[] = [];
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: (error) => errors.push(error),
    });
    const received = vi.fn();
    transport.start(received);
    const deliver = async (ciphertext: string) => {
      const payload: DemosL2psRfqIncomingPayload = {
        from: BUYER_PEER,
        encrypted: { ciphertext, nonce: Buffer.alloc(12).toString("base64") },
        messageHash: "d".repeat(64),
      };
      snapshotLabels.length = 0;
      for (const handler of hub.handlers.get(SELLER_PEER) ?? []) handler(payload);
      await transport.drain();
    };

    await deliver("A".repeat(MAX_CIPHERTEXT_CHARS + 4));
    expect(errors.map((error) => error.message)).toEqual([
      "ciphertext exceeds its size limit",
    ]);
    expect(snapshotLabels).not.toContain("Demos L2PS incoming RFQ payload");
    expect(snapshotLabels).not.toContain("Demos L2PS encrypted RFQ frame");

    // Control: an in-limit frame reaches the snapshot and fails later on.
    await deliver("A".repeat(64));
    expect(snapshotLabels).toContain("Demos L2PS incoming RFQ payload");
    expect(errors).toHaveLength(2);
    expect(received).not.toHaveBeenCalled();
    transport.stop();
  }, 60_000);

  test("refuses an oversized history array before the canonical snapshot", async () => {
    let page: DemosL2psRfqHistoryPage | undefined;
    const { transport, packet, own } = await buyerWithSentOffer({
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    const duplicates = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(own),
      id: `duplicate-${index}`,
      timestamp: own.timestamp + index,
    }));

    page = { messages: duplicates, hasMore: false };
    snapshotLabels.length = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ history reconciliation failed",
    });
    expect(snapshotLabels).not.toContain("Demos L2PS RFQ history response");

    // Control: the same entries within the page limit are snapshotted and match.
    page = { messages: duplicates.slice(0, 100), hasMore: false };
    snapshotLabels.length = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
    expect(snapshotLabels).toContain("Demos L2PS RFQ history response");
  });

  test("refuses a history page over the aggregate budget before the canonical snapshot", async () => {
    let ticks = 0;
    let page: DemosL2psRfqHistoryPage | undefined;
    const { transport, packet, own } = await buyerWithSentOffer({
      monotonicNowMs: () => ticks,
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    // Every frame is within the per-frame limit, and a full page of them is
    // too; 9,000-character IDs push the page over its budget.
    const bulk = "A".repeat(MAX_CIPHERTEXT_CHARS);
    const counterparty = (
      index: number,
      id = `bulk-${index}`,
    ): DemosL2psRfqStoredMessage => ({
      id,
      from: SELLER_PEER,
      to: BUYER_PEER,
      messageHash: "d".repeat(64),
      encrypted: { ciphertext: bulk, nonce: own.encrypted.nonce },
      l2psUid: L2PS_UID,
      l2psTxHash: null,
      timestamp: own.timestamp + 10 + index,
      status: "delivered",
    });
    const full = (id?: (index: number) => string) =>
      Array.from({ length: 100 }, (_, index) => counterparty(index, id?.(index)));

    page = { messages: full((index) => `${index}`.padStart(9_000, "x")), hasMore: false };
    snapshotLabels.length = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ history reconciliation failed",
    });
    expect(snapshotLabels).not.toContain("Demos L2PS RFQ history response");

    // Control: an in-budget page is snapshotted; with our frame absent it is an
    // exhaustive absence proof.
    page = { messages: full(), hasMore: false };
    snapshotLabels.length = 0;
    ticks = 60_000;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
    expect(snapshotLabels).toContain("Demos L2PS RFQ history response");
  }, 60_000);

  test("refuses an oversized send acknowledgement before the canonical snapshot", async () => {
    const { hub, packet } = await buyerWithSentOffer();
    const send = hub.peer(BUYER_PEER).send;
    let ticks = 0;
    let bloated = true;
    const bloatedTransport = createDemosL2psRfqTransport<string>({
      peer: {
        ...hub.peer(BUYER_PEER),
        async send(to, encrypted, messageHash) {
          const result = await send(to, encrypted, messageHash);
          return bloated
            ? { ...result, l2psStatus: "s".repeat(1_000_000) as "submitted" }
            : result;
        },
      },
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      monotonicNowMs: () => ticks,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });

    snapshotLabels.length = 0;
    await expect(bloatedTransport.publish(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ send acknowledgement is missing or failed",
    });
    expect(snapshotLabels).not.toContain("Demos L2PS RFQ send acknowledgement");

    bloated = false;
    ticks = 60_000;
    snapshotLabels.length = 0;
    await expect(bloatedTransport.publish(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
    expect(snapshotLabels).toContain("Demos L2PS RFQ send acknowledgement");
  });

  test("shares one decryption budget across duplicate own frames", async () => {
    let opens = 0;
    let hang = true;
    const { hub, transport, packet, own } = await buyerWithSentOffer({
      operationTimeoutMs: 200,
      codec: (base) => ({
        codecId: base.codecId,
        seal: (plaintext, context) => base.seal(plaintext, context),
        open(encrypted, context) {
          opens += 1;
          return hang ? new Promise<Uint8Array>(() => {}) : base.open(encrypted, context);
        },
      }),
    });
    for (let index = 1; index < 5; index += 1) {
      hub.messages.push({
        ...structuredClone(own),
        id: `duplicate-${index}`,
        timestamp: own.timestamp + index,
      });
    }

    const startedAt = performance.now();
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ history decryption failed",
    });
    // Five serial per-frame timeouts would take at least 1,000 ms; the shared
    // 200 ms budget leaves 600 ms of headroom for a loaded runner.
    expect(performance.now() - startedAt).toBeLessThan(800);
    expect(opens).toBe(1);

    hang = false;
    opens = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
    expect(opens).toBe(5);
  });

  test("finds a definite conflict behind an unavailable own frame", async () => {
    let fault: "throw" | "hang" | "none" = "none";
    let faulty: string | undefined;
    const { hub, sharedKey, transport, packet, own } = await buyerWithSentOffer({
      operationTimeoutMs: 100,
      codec: (base) => ({
        codecId: base.codecId,
        seal: (plaintext, context) => base.seal(plaintext, context),
        open(encrypted, context) {
          if (fault === "hang") return new Promise<Uint8Array>(() => {});
          if (fault === "throw" && encrypted.ciphertext === faulty) {
            throw new Error("transient KMS outage");
          }
          return base.open(encrypted, context);
        },
      }),
    });
    // History is newest first: the unavailable frame is opened before the conflict.
    hub.messages.push({
      ...structuredClone(own),
      id: "conflict",
      timestamp: own.timestamp + 10,
      encrypted: await createDemosL2psRfqAesGcmCodec({ sharedKey }).seal(
        new TextEncoder().encode(
          canonicalize({ ...packet, packetId: "f".repeat(64) } as unknown as Record<string, unknown>),
        ),
        { messageHash: packet.packetId, fromPeer: BUYER_PEER, toPeer: SELLER_PEER },
      ),
    });
    hub.messages.push({
      ...structuredClone(own),
      id: "unavailable",
      timestamp: own.timestamp + 20,
    });
    faulty = own.encrypted.ciphertext;
    const conflict = {
      disposition: "rejected",
      reason: "Demos L2PS history binds packetId to different bytes or route",
    };

    // A fast codec failure leaves budget to reach the conflict in the same call.
    fault = "throw";
    await expect(transport.reconcile(packet)).resolves.toEqual(conflict);

    // A hanging codec spends the budget: retryable now, terminal once it answers.
    fault = "hang";
    await expect(transport.reconcile(packet)).resolves.toMatchObject({
      disposition: "indeterminate",
    });
    fault = "none";
    await expect(transport.reconcile(packet)).resolves.toEqual(conflict);
    expect(hub.sends).toBe(1);
  });

  test("keeps an own history entry with a failed submission status indeterminate", async () => {
    const { hub, transport, client, packet, own } = await buyerWithSentOffer();
    own.status = "failed";

    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS history records a failed submission with unknown delivery",
    });
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "indeterminate",
    });
    expect(hub.sends).toBe(1);
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    expect(status.record.failure).toBeUndefined();
    expect(status.record.outbox[0]).toMatchObject({ state: "indeterminate" });
  });

  test("ignores our own packet hash sent to a different recipient peer", async () => {
    let ticks = 0;
    let page: DemosL2psRfqHistoryPage | undefined;
    const { baseCodec, transport, packet, own } = await buyerWithSentOffer({
      monotonicNowMs: () => ticks,
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    const elsewhere = { messageHash: packet.packetId, fromPeer: BUYER_PEER, toPeer: THIRD_PEER };
    page = {
      messages: [{
        ...structuredClone(own),
        to: THIRD_PEER,
        encrypted: await baseCodec.seal(
          new TextEncoder().encode(canonicalize(packet as unknown as Record<string, unknown>)),
          elsewhere,
        ),
      }],
      hasMore: false,
    };
    ticks = 60_000;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
  });

  test("ignores another sender's frame to our recipient that reuses the packet hash", async () => {
    let ticks = 0;
    let page: DemosL2psRfqHistoryPage | undefined;
    const { baseCodec, transport, packet, own } = await buyerWithSentOffer({
      monotonicNowMs: () => ticks,
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    const otherSender = { messageHash: packet.packetId, fromPeer: THIRD_PEER, toPeer: SELLER_PEER };
    page = {
      messages: [{
        ...structuredClone(own),
        from: THIRD_PEER,
        encrypted: await baseCodec.seal(new TextEncoder().encode("{}"), otherSender),
      }],
      hasMore: false,
    };
    ticks = 60_000;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
  });

  test("retires the old handler on stop when the peer cannot remove it", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const sellerPeer: DemosL2psRfqPeerLike = { ...hub.peer(SELLER_PEER) };
    delete sellerPeer.removeMessageHandler;
    const options = (localClaim: string, localPeerKey: string, peer: DemosL2psRfqPeerLike) => ({
      peer,
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback" as const,
      outboxStore: memorySendOutbox(),
      localClaim,
      localPeerKey,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const buyerTransport = createDemosL2psRfqTransport<string>(
      options(BUYER, BUYER_PEER, hub.peer(BUYER_PEER)),
    );
    const sellerTransport = createDemosL2psRfqTransport<string>(
      options(SELLER, SELLER_PEER, sellerPeer),
    );
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, reservation),
    );
    const sellerClient = createDurableRfqLifecycleClient(
      clientOptions("seller", sellerTransport, reservation),
    );
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());

    const retired = vi.fn();
    sellerTransport.start(retired);
    sellerTransport.stop();
    const current = vi.fn((packet: unknown) => sellerClient.receive(packet));
    sellerTransport.start(current);
    expect(hub.handlers.get(SELLER_PEER)?.size).toBe(2);

    await expect(buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "ready" });
    await sellerTransport.drain();
    expect(retired).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    sellerTransport.stop();
  });
});

type InboundFixture = Awaited<ReturnType<typeof inboundReceiver>>;
type BuyerPacket = InboundFixture["packet"];

/** The buyer's offer, moved to another job, channel or turn sequence. */
function offerVariant(
  base: BuyerPacket,
  change: { jobId?: string; channelId?: string; sequence?: number },
): Omit<BuyerPacket, "packetId"> {
  if (base.kind !== "turn") throw new Error("expected a turn packet");
  const { packetId: _packetId, ...material } = structuredClone(base);
  const channelId = change.channelId ?? material.channelId;
  const variant = {
    ...material,
    jobId: change.jobId ?? material.jobId,
    channelId,
    message: {
      ...material.message,
      channelId,
      sequence: change.sequence ?? material.message.sequence,
    },
  };
  return variant as Omit<BuyerPacket, "packetId">;
}

/** Store a valid buyer-to-seller frame for `material` in the hub's history. */
async function storeBuyerPacket(
  fixture: InboundFixture,
  material: Omit<BuyerPacket, "packetId">,
  index: number,
): Promise<BuyerPacket> {
  const packet = { ...material, packetId: rfqLifecyclePacketId(material) } as BuyerPacket;
  fixture.hub.messages.push({
    ...structuredClone(fixture.own),
    id: `stored-${index}`,
    messageHash: packet.packetId,
    timestamp: fixture.own.timestamp + index,
    encrypted: await fixture.baseCodec.seal(
      new TextEncoder().encode(canonicalize(packet as unknown as Record<string, unknown>)),
      { messageHash: packet.packetId, fromPeer: BUYER_PEER, toPeer: SELLER_PEER },
    ),
  });
  return packet;
}

const OTHER_JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7A";

describe("Demos L2PS RFQ final review fixes", () => {
  test("final: a recovered packet for an unopened job no longer blocks a later job", async () => {
    const fixture = await inboundReceiver();
    // The seller never opened this job, and its ID sorts before JOB_ID.
    const early = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { jobId: OTHER_JOB_ID }), 1);
    const results = [
      await fixture.transport.resumeInbound(BUYER),
      await fixture.transport.resumeInbound(BUYER),
    ];
    const status = await fixture.client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    expect(status.record.inboxPacketIds).toContain(fixture.packet.packetId);
    // The second call sees the offer as a duplicate and the same refusal.
    for (const result of results) {
      expect(result).toEqual({
        status: "complete",
        delivered: 1, ignored: 0,
        skipped: [{
          jobId: OTHER_JOB_ID,
          channelId: CHANNEL_ID,
          packetId: early.packetId,
          packets: 1,
          reason: "RFQ lifecycle job does not exist",
        }],
      });
    }
    fixture.transport.stop();
  });

  test.each([
    { outcome: "rejected", status: "complete", reason: "test refusal" },
    { outcome: "indeterminate", status: "indeterminate", reason: "test refusal" },
    { outcome: "conflict", status: "indeterminate", reason: "test refusal" },
    { outcome: "throw", status: "indeterminate", reason: "Demos L2PS recovered packet handler failed" },
  ] as const)("final: a $outcome packet holds back only the rest of its own job", async ({ outcome, status, reason }) => {
    const fixture = await inboundReceiver();
    const sequence = fixture.packet.kind === "turn" ? fixture.packet.message.sequence : 0;
    // On CHANNEL_ID, the other job's first packet is refused and its next turn
    // is held back. The same job ID on another channel, and JOB_ID, still arrive.
    const refused = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { jobId: OTHER_JOB_ID }), 1);
    const later = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { jobId: OTHER_JOB_ID, sequence: sequence + 1 }), 2);
    const sibling = await storeBuyerPacket(fixture, offerVariant(fixture.packet, {
      jobId: OTHER_JOB_ID, channelId: "demos-l2ps-rfq-channel-02",
    }), 3);
    fixture.transport.stop();
    const calls: string[] = [];
    fixture.transport.start(async (packet) => {
      calls.push(packet.packetId);
      if (packet.packetId !== refused.packetId) return { status: "ready", record: {} as never };
      if (outcome === "throw") throw new Error("consumer failed");
      return { status: outcome, reason: "test refusal" };
    });
    const result = await fixture.transport.resumeInbound(BUYER);
    expect(calls).toEqual([refused.packetId, sibling.packetId, fixture.packet.packetId]);
    expect(calls).not.toContain(later.packetId);
    expect(result).toEqual({
      status,
      delivered: 2, ignored: 0,
      skipped: [{
        jobId: OTHER_JOB_ID, channelId: CHANNEL_ID, packetId: refused.packetId, packets: 2, reason,
      }],
      ...(status === "indeterminate"
        ? { reason: outcome === "throw" ? reason : `Demos L2PS recovered packet was not accepted: ${reason}` }
        : {}),
    });
    fixture.transport.stop();
  });

  test("final: a consumer timeout still stops recovery before later jobs", async () => {
    const fixture = await inboundReceiver({ consumerTimeoutMs: 20 });
    const early = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { jobId: OTHER_JOB_ID }), 1);
    fixture.transport.stop();
    const calls: string[] = [];
    fixture.transport.start((packet) => {
      calls.push(packet.packetId);
      return new Promise(() => {});
    });
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "indeterminate", delivered: 0, ignored: 0, skipped: [], reason: CONSUMER_TIMEOUT,
    });
    expect(calls).toEqual([early.packetId]);
    fixture.transport.stop();
  });

  /** Recover two more jobs and the offer under `cap`, accepting every packet. */
  async function recoverUnderCap(cap?: number, repeatOffer = false) {
    const fixture = await inboundReceiver(cap === undefined ? {} : { inboundRecoveryMaxBytes: cap });
    // History is newest first: second, first, then the offer.
    const first = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { jobId: OTHER_JOB_ID }), 1);
    const second = await storeBuyerPacket(fixture, offerVariant(fixture.packet, {
      jobId: OTHER_JOB_ID, channelId: "demos-l2ps-rfq-channel-02",
    }), 2);
    if (repeatOffer) {
      fixture.hub.messages.push({
        ...structuredClone(fixture.own), id: "offer-repeat", timestamp: fixture.own.timestamp + 3,
      });
    }
    fixture.transport.stop();
    const calls: string[] = [];
    fixture.transport.start(async (packet) => {
      calls.push(packet.packetId);
      return { status: "ready", record: {} as never };
    });
    const result = await fixture.transport.resumeInbound(BUYER);
    fixture.transport.stop();
    return { result, calls, first, second, offer: fixture.packet };
  }

  const decodedBytes = (packet: BuyerPacket) =>
    new TextEncoder().encode(canonicalize(packet as unknown as Record<string, unknown>)).byteLength;

  test("final: inbound recovery holds at most inboundRecoveryMaxBytes, then stays indeterminate", async () => {
    const all = await recoverUnderCap();
    const newestTwo = decodedBytes(all.first) + decodedBytes(all.second);
    const total = newestTwo + decodedBytes(all.offer);
    // Only the newest two fit, so the oldest packet (the offer) is never held.
    for (const cap of [newestTwo, total - 1]) {
      const capped = await recoverUnderCap(cap);
      expect(capped.calls).toEqual([capped.first.packetId, capped.second.packetId]);
      expect(capped.result).toEqual({
        status: "indeterminate",
        delivered: 2, ignored: 0,
        skipped: [],
        reason: "Demos L2PS inbound recovery reached inboundRecoveryMaxBytes before history ended",
      });
    }
    await expect(recoverUnderCap(total)).resolves.toMatchObject({
      result: { status: "complete", delivered: 3, ignored: 0, skipped: [] },
    });
    // A repeated frame of a packet already held is not charged twice.
    await expect(recoverUnderCap(total, true)).resolves.toMatchObject({
      result: { status: "complete", delivered: 3, ignored: 0, skipped: [] },
    });
    const none = await recoverUnderCap(decodedBytes(all.second) - 1);
    expect(none.calls).toEqual([]);
    expect(none.result).toMatchObject({ status: "indeterminate", delivered: 0 });
    // The default cap holds all three.
    expect(all.result).toEqual({ status: "complete", delivered: 3, ignored: 0, skipped: [] });
  });

  test("final: inboundRecoveryMaxBytes must be a positive safe integer of at most 1 GiB", () => {
    const base = channelOptions(new FakeL2psHub().peer(BUYER_PEER), "loopback");
    for (const inboundRecoveryMaxBytes of [1, 64 * 1024 * 1024, 1024 * 1024 * 1024]) {
      expect(constructionError({ ...base, inboundRecoveryMaxBytes })).toBeUndefined();
    }
    for (const inboundRecoveryMaxBytes of [0, -1, 1.5, 1024 * 1024 * 1024 + 1, Number.NaN, "64"]) {
      expect(constructionError({ ...base, inboundRecoveryMaxBytes: inboundRecoveryMaxBytes as number }))
        .toMatchObject({
          message: "inboundRecoveryMaxBytes must be a positive safe integer at most 1073741824",
        });
    }
  });

  /** A buyer transport over `hub` whose mapping options the caller supplies. */
  function mappedBuyerTransport(
    hub: FakeL2psHub,
    mapping: Pick<DemosL2psRfqTransportOptions, "peerForClaim" | "claimForPeer">,
    outboxStore = memorySendOutbox(),
  ) {
    return createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      ...mapping,
      onError: vi.fn(),
    });
  }

  test.each([
    { side: "peerForClaim", answer: undefined, reason: "Demos L2PS RFQ peer mapping has no key for the claim yet" },
    { side: "peerForClaim", answer: null, reason: "Demos L2PS RFQ peer mapping has no key for the claim yet" },
    { side: "claimForPeer", answer: undefined, reason: "Demos L2PS RFQ reciprocal claim mapping has no claim for the peer yet" },
    { side: "claimForPeer", answer: null, reason: "Demos L2PS RFQ reciprocal claim mapping has no claim for the peer yet" },
  ] as const)("final: $side answering $answer before it loads is retried, not a job failure", async ({ side, answer, reason }) => {
    const hub = new FakeL2psHub();
    let loaded = false;
    const transport = mappedBuyerTransport(hub, {
      peerForClaim: (claim) => (side === "peerForClaim" && !loaded ? answer as never : peerForClaim(claim)),
      claimForPeer: (peerKey) => (side === "claimForPeer" && !loaded ? answer as never : claimForPeer(peerKey)),
    });
    const client = createDurableRfqLifecycleClient(clientOptions("buyer", transport, durableReservation()));
    await client.open(openInput());
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate", reason });
    expect(hub.sends).toBe(0);
    loaded = true;
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    expect(hub.sends).toBe(1);
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    expect(status.record.failure).toBeUndefined();
    expect(status.record.outbox[0]).toMatchObject({ state: "acknowledged" });
  });

  test("final: a wrong mapping refuses only a packet this transport never sent", async () => {
    const hub = new FakeL2psHub();
    const outboxStore = memorySendOutbox();
    let wrong = false;
    const mapping = {
      peerForClaim,
      // Once wrong, the seller's key maps back to another claim.
      claimForPeer: (peerKey: string) =>
        (wrong && peerKey === SELLER_PEER ? "did:demos:someone-else" : claimForPeer(peerKey)),
    };
    const transport = mappedBuyerTransport(hub, mapping, outboxStore);
    const client = createDurableRfqLifecycleClient(clientOptions("buyer", transport, durableReservation()));
    await client.open(openInput());
    hub.loseNextResponse = true;
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    const sent = await client.getStatus(JOB_ID);
    if (sent.status !== "ok") throw new Error("record did not load");
    const packet = sent.record.outbox[0]!.packet;
    wrong = true;
    // The frame was sent and may have been delivered: never terminal.
    const reason = "Demos L2PS RFQ peer/claim mapping is not reciprocal";
    await expect(transport.publish(packet)).resolves.toEqual({ disposition: "indeterminate", reason });
    await expect(transport.reconcile(packet)).resolves.toEqual({ disposition: "indeterminate", reason });
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "indeterminate", reason });
    const after = await client.getStatus(JOB_ID);
    if (after.status !== "ok") throw new Error("record did not load");
    expect(after.record.failure).toBeUndefined();
    expect(hub.sends).toBe(1);
    // With no stored frame the same packet was never sent, so it is refused,
    // unless the store cannot say.
    await expect(mappedBuyerTransport(hub, mapping).publish(packet))
      .resolves.toEqual({ disposition: "rejected", reason });
    await expect(mappedBuyerTransport(hub, mapping, {
      load: () => { throw new Error("outbox unavailable"); },
      save: () => false,
    }).publish(packet)).resolves.toEqual({ disposition: "indeterminate", reason });
    expect(hub.sends).toBe(1);
  });

  test("final: a refused send keeps the peer's error text, bounded and without URLs", async () => {
    const { hub, packet } = await buyerWithSentOffer();
    const withGetter = new Error("hidden");
    Object.defineProperty(withGetter, "message", {
      get() { throw new Error("the getter ran"); },
    });
    const unknown = "Demos L2PS RFQ send outcome is unknown";
    for (const [refusal, reason] of [
      [
        new Error("Recipient not registered\n\tvia wss://user:secret@node.example:3006/l2ps?token=t1"),
        `${unknown}: Recipient not registered via <url>`,
      ],
      [new Error(`é\u0000${"x".repeat(300)}`), `${unknown}: ${"x".repeat(200)}...`],
      [new Error(" \n "), unknown],
      [withGetter, unknown],
      ["a bare string", unknown],
    ] as const) {
      const base = hub.peer(BUYER_PEER);
      const transport = createDemosL2psRfqTransport<string>({
        peer: { ...base, async send() { throw refusal; } },
        codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
        l2psUid: L2PS_UID,
        peerChannel: "loopback",
        outboxStore: memorySendOutbox(),
        localClaim: BUYER,
        localPeerKey: BUYER_PEER,
        peerForClaim,
        claimForPeer,
        onError: vi.fn(),
      });
      await expect(transport.publish(packet)).resolves.toEqual({ disposition: "indeterminate", reason });
    }
  });
});

describe("Demos L2PS RFQ final re-review fixes", () => {
  test.each([
    { fault: "clock", reason: "durable RFQ clock returned an invalid unix-ms value" },
    { fault: "channel verifier", reason: "channel signature verifier failed" },
  ] as const)("re-review: a failing lifecycle $fault keeps recovery indeterminate until it works", async ({ fault, reason }) => {
    const fixture = await inboundReceiver();
    fixture.transport.stop();
    let failing = false;
    const client = createDurableRfqLifecycleClient({
      ...clientOptions("seller", fixture.transport, durableReservation()),
      nowMs: () => (failing && fault === "clock" ? Number.NaN : NOW),
      verifyChannelMessage: () => {
        if (failing && fault === "channel verifier") throw new Error("verifier offline");
        return "pass" as const;
      },
    });
    await client.open(openInput());
    fixture.transport.start((packet) => client.receive(packet));
    failing = true;
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "indeterminate",
      delivered: 0, ignored: 0,
      skipped: [{
        jobId: JOB_ID, channelId: CHANNEL_ID, packetId: fixture.packet.packetId, packets: 1, reason,
      }],
      reason: `Demos L2PS recovered packet was not accepted: ${reason}`,
    });
    failing = false;
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete", delivered: 1, ignored: 0, skipped: [],
    });
    fixture.transport.stop();
  });

  /** Exact code-unit order of two packets' job, then channel. */
  const byBinding = (left: BuyerPacket, right: BuyerPacket) =>
    left.jobId !== right.jobId
      ? (left.jobId < right.jobId ? -1 : 1)
      : left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0;

  // localeCompare() calls the first two twins equal to their base ID; a
  // case-insensitive collation would call the last two equal.
  test.each([
    { field: "jobId", name: "a soft hyphen", twin: `${OTHER_JOB_ID}­` },
    { field: "channelId", name: "a zero-width space", twin: `${CHANNEL_ID}​` },
    { field: "jobId", name: "case", twin: OTHER_JOB_ID.toLowerCase() },
    { field: "channelId", name: "case", twin: CHANNEL_ID.toUpperCase() },
  ] as const)("re-review: a refused $field stays held when another differs only by $name", async ({ field, twin }) => {
    const fixture = await inboundReceiver();
    const sequence = fixture.packet.kind === "turn" ? fixture.packet.message.sequence : 0;
    const base = { jobId: OTHER_JOB_ID, channelId: CHANNEL_ID };
    const other = { ...base, [field]: twin };
    expect(other[field]).not.toBe(base[field]);
    // By turn rank alone the two groups would interleave: first, twin, later.
    const first = await storeBuyerPacket(fixture, offerVariant(fixture.packet, { ...base, sequence }), 1);
    const twinFirst = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { ...other, sequence: sequence + 1 }), 2);
    const later = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { ...base, sequence: sequence + 2 }), 3);
    fixture.transport.stop();
    const calls: string[] = [];
    fixture.transport.start(async (packet) => {
      calls.push(packet.packetId);
      return packet.packetId === first.packetId || packet.packetId === twinFirst.packetId
        ? { status: "rejected", reason: "test refusal" }
        : { status: "ready", record: {} as never };
    });
    const result = await fixture.transport.resumeInbound(BUYER);
    expect(calls).not.toContain(later.packetId);
    const delivered = [first, twinFirst, fixture.packet].sort(byBinding);
    expect(calls).toEqual(delivered.map((packet) => packet.packetId));
    expect(result).toEqual({
      status: "complete",
      delivered: 1, ignored: 0,
      skipped: delivered.filter((packet) => packet !== fixture.packet).map((packet) => ({
        jobId: packet.jobId,
        channelId: packet.channelId,
        packetId: packet.packetId,
        packets: packet === first ? 2 : 1,
        reason: "test refusal",
      })),
    });
    fixture.transport.stop();
  });

  test("re-review: a refused first packet holds back every later packet of its job", async () => {
    const fixture = await inboundReceiver();
    const sequence = fixture.packet.kind === "turn" ? fixture.packet.message.sequence : 0;
    const job = { jobId: OTHER_JOB_ID };
    const first = await storeBuyerPacket(fixture, offerVariant(fixture.packet, { ...job, sequence }), 1);
    const second = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { ...job, sequence: sequence + 1 }), 2);
    const third = await storeBuyerPacket(
      fixture, offerVariant(fixture.packet, { ...job, sequence: sequence + 2 }), 3);
    fixture.transport.stop();
    const calls: string[] = [];
    fixture.transport.start(async (packet) => {
      calls.push(packet.packetId);
      return packet.packetId === first.packetId
        ? { status: "rejected", reason: "test refusal" }
        : { status: "ready", record: {} as never };
    });
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 1, ignored: 0,
      skipped: [{
        jobId: OTHER_JOB_ID, channelId: CHANNEL_ID, packetId: first.packetId, packets: 3, reason: "test refusal",
      }],
    });
    expect(calls).toEqual([first.packetId, fixture.packet.packetId]);
    expect(calls).not.toContain(second.packetId);
    expect(calls).not.toContain(third.packetId);
    fixture.transport.stop();
  });

  test("re-review: at the cap, recovery stops instead of skipping a large packet", async () => {
    const probe = await inboundReceiver();
    probe.transport.stop();
    const offer = probe.packet;
    if (offer.kind !== "turn") throw new Error("expected a turn packet");
    const sequence = offer.message.sequence;
    const turn = (step: number) =>
      offerVariant(offer, { jobId: OTHER_JOB_ID, sequence: sequence + step });
    const small = turn(0);
    const large = offerVariant(
      { ...offer, message: { ...offer.message, signature: "s".repeat(4096) } },
      { jobId: OTHER_JOB_ID, sequence: sequence + 1 },
    );
    const bytes = (material: Omit<BuyerPacket, "packetId">) => new TextEncoder().encode(canonicalize(
      { ...material, packetId: rfqLifecyclePacketId(material) } as unknown as Record<string, unknown>,
    )).byteLength;
    // History is newest first: newest (small), large, oldest (small), the offer.
    // The cap fits both small packets but not the newest with the large one.
    const cap = bytes(turn(2)) + bytes(small);
    expect(bytes(large)).toBeGreaterThan(bytes(small));
    const fixture = await inboundReceiver({ inboundRecoveryMaxBytes: cap });
    const oldest = await storeBuyerPacket(fixture, small, 1);
    const middle = await storeBuyerPacket(fixture, large, 2);
    const newest = await storeBuyerPacket(fixture, turn(2), 3);
    fixture.transport.stop();
    const calls: string[] = [];
    fixture.transport.start(async (packet) => {
      calls.push(packet.packetId);
      return { status: "ready", record: {} as never };
    });
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "indeterminate",
      delivered: 1, ignored: 0,
      skipped: [],
      reason: "Demos L2PS inbound recovery reached inboundRecoveryMaxBytes before history ended",
    });
    // Recovery stops at the cut rather than skip the large packet: the newest
    // packet is delivered, the two older ones are not read, and the call is
    // indeterminate, so the job's earlier packets are still missing.
    expect(calls).toEqual([newest.packetId]);
    expect(calls).not.toContain(oldest.packetId);
    expect(calls).not.toContain(middle.packetId);
    fixture.transport.stop();
  });

  test("re-review 2: a seller signer using a stale key keeps recovery indeterminate until it signs right", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const transportFor = (localClaim: string, localPeerKey: string) =>
      createDemosL2psRfqTransport<string>({
        peer: hub.peer(localPeerKey),
        codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
        l2psUid: L2PS_UID,
        peerChannel: "loopback",
        outboxStore: memorySendOutbox(),
        localClaim,
        localPeerKey,
        peerForClaim,
        claimForPeer,
        onError: vi.fn(),
      });
    const buyerTransport = transportFor(BUYER, BUYER_PEER);
    const sellerTransport = transportFor(SELLER, SELLER_PEER);
    // The verifier knows each role's key: the buyer signs 1s and the seller 2s.
    // The seller's stale key signs 3s, a well-formed signature that does not verify.
    const signature = (fill: number) => Buffer.from(new Uint8Array(64).fill(fill)).toString("base64url");
    const verifyAgreementContribution = (input: { role: string; value: string }) =>
      input.value === signature(input.role === "buyer" ? 1 : 2) ? "valid" as const : "invalid" as const;
    let stale = false;
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient({
      ...clientOptions("buyer", buyerTransport, reservation),
      verifyAgreementContribution,
    });
    const sellerOptions = clientOptions("seller", sellerTransport, reservation);
    const sellerClient = createDurableRfqLifecycleClient({
      ...sellerOptions,
      agreementSigner: {
        ...sellerOptions.agreementSigner,
        sign: () => new Uint8Array(64).fill(stale ? 3 : 2),
      },
      verifyAgreementContribution,
    });
    buyerTransport.start((packet) => buyerClient.receive(packet));
    sellerTransport.start((packet) => sellerClient.receive(packet));
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    await sellerTransport.drain();
    await expect(sellerClient.sendAccept(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    await buyerTransport.drain();
    stale = true;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    await sellerTransport.drain();
    const proposed = await buyerClient.getStatus(JOB_ID);
    if (proposed.status !== "ok") throw new Error("record did not load");
    const proposalId = proposed.record.outbox.at(-1)!.packet.packetId;
    const reason = "seller agreement contribution is not cryptographically valid (invalid)";
    await expect(sellerTransport.resumeInbound(BUYER)).resolves.toEqual({
      status: "indeterminate",
      delivered: 1, ignored: 0,
      skipped: [{ jobId: JOB_ID, channelId: CHANNEL_ID, packetId: proposalId, packets: 1, reason }],
      reason: `Demos L2PS recovered packet was not accepted: ${reason}`,
    });
    const held = await sellerClient.getStatus(JOB_ID);
    expect(held.status === "ok" && held.record.agreement).toBeUndefined();
    stale = false;
    await expect(sellerTransport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete", delivered: 2, ignored: 0, skipped: [],
    });
    await buyerTransport.drain();
    const buyerStatus = await buyerClient.getStatus(JOB_ID);
    const sellerStatus = await sellerClient.getStatus(JOB_ID);
    if (buyerStatus.status !== "ok" || sellerStatus.status !== "ok") throw new Error("record did not load");
    expect(sellerStatus.record.agreement?.finalized?.signatures).toHaveLength(2);
    expect(buyerStatus.record.agreement?.finalized).toEqual(sellerStatus.record.agreement?.finalized);
    buyerTransport.stop();
    sellerTransport.stop();
  });
});

describe("Demos L2PS RFQ buyer retry after a stale agreement key", () => {
  test("stale buyer key: a refused packet does not hold back one of the same rank, and its job goes on", async () => {
    const fixture = await inboundReceiver();
    const offer = fixture.packet;
    if (offer.kind !== "turn") throw new Error("expected a turn packet");
    const sequence = offer.message.sequence;
    // Two packets of one rank in one job, as a stale and a re-signed proposal are.
    const sameRank = (signature: string) =>
      offerVariant({ ...offer, message: { ...offer.message, signature } }, { jobId: OTHER_JOB_ID });
    const one = await storeBuyerPacket(fixture, sameRank("one"), 1);
    const two = await storeBuyerPacket(fixture, sameRank("two"), 2);
    const next = await storeBuyerPacket(
      fixture, offerVariant(offer, { jobId: OTHER_JOB_ID, sequence: sequence + 1 }), 3);
    const [refused, accepted] = [one, two].sort((left, right) => (left.packetId < right.packetId ? -1 : 1));
    fixture.transport.stop();
    const calls: string[] = [];
    fixture.transport.start(async (packet) => {
      calls.push(packet.packetId);
      return packet.packetId === refused!.packetId
        ? { status: "rejected", reason: "test refusal" }
        : { status: "ready", record: {} as never };
    });
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 3, ignored: 0,
      skipped: [{
        jobId: OTHER_JOB_ID, channelId: CHANNEL_ID, packetId: refused!.packetId, packets: 1, reason: "test refusal",
      }],
    });
    expect(calls).toEqual([refused!.packetId, accepted!.packetId, next.packetId, fixture.packet.packetId]);
    fixture.transport.stop();
  });

  test("stale buyer key: the buyer re-signs, and recovery after both sides restart finalizes one agreement", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const outboxes = { buyer: memorySendOutbox(), seller: memorySendOutbox() };
    const stores = {
      buyer: createInMemoryDurableRfqLifecycleStore<string>(),
      seller: createInMemoryDurableRfqLifecycleStore<string>(),
    };
    const transportFor = (role: DurableRfqLifecycleRole) =>
      createDemosL2psRfqTransport<string>({
        peer: hub.peer(role === "buyer" ? BUYER_PEER : SELLER_PEER),
        codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
        l2psUid: L2PS_UID,
        peerChannel: "loopback",
        outboxStore: outboxes[role],
        localClaim: role === "buyer" ? BUYER : SELLER,
        localPeerKey: role === "buyer" ? BUYER_PEER : SELLER_PEER,
        peerForClaim,
        claimForPeer,
        onError: vi.fn(),
      });
    // The verifier knows each role's key: the buyer signs 1s and the seller 2s.
    // The buyer's stale key signs 7s, a well-formed signature that does not verify.
    const STALE = 7;
    const signature = (fill: number) => Buffer.from(new Uint8Array(64).fill(fill)).toString("base64url");
    const verifyAgreementContribution = (input: { role: string; value: string }) =>
      input.value === signature(input.role === "buyer" ? 1 : 2) ? "valid" as const : "invalid" as const;
    const reservation = durableReservation();
    /** A process for `role`: a fresh transport and client over that role's stores. */
    const processFor = (role: DurableRfqLifecycleRole, fill = role === "buyer" ? 1 : 2) => {
      const transport = transportFor(role);
      const options = clientOptions(role, transport, reservation);
      const client = createDurableRfqLifecycleClient({
        ...options,
        store: stores[role],
        agreementSigner: { ...options.agreementSigner, sign: () => new Uint8Array(64).fill(fill) },
        verifyAgreementContribution,
      });
      transport.start((packet) => client.receive(packet));
      return { transport, client };
    };
    let buyerSide = processFor("buyer", STALE);
    let sellerSide = processFor("seller");
    await buyerSide.client.open(openInput());
    await sellerSide.client.open(openInput());
    await buyerSide.client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    await sellerSide.transport.drain();
    await expect(sellerSide.client.sendAccept(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    await buyerSide.transport.drain();
    // The seller is down while the buyer proposes with its stale key.
    sellerSide.transport.stop();
    await expect(buyerSide.client.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    // The buyer restarts with its signer fixed and starts again.
    buyerSide.transport.stop();
    buyerSide = processFor("buyer");
    await expect(buyerSide.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    await expect(buyerSide.client.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    const proposed = await buyerSide.client.getStatus(JOB_ID);
    if (proposed.status !== "ok") throw new Error("record did not load");
    const [stale, fresh] = proposed.record.outbox.slice(-2).map((entry) => entry.packet);
    if (stale?.kind !== "agreement-proposal" || fresh?.kind !== "agreement-proposal") {
      throw new Error("expected two agreement proposals");
    }
    expect(fresh.plan).toEqual(stale.plan);
    // The stale fill is chosen so that recovery meets the refused proposal first.
    expect(stale.packetId < fresh.packetId).toBe(true);
    // The seller restarts and recovers the offer and both proposals from history.
    sellerSide = processFor("seller");
    const reason = "buyer agreement contribution is not cryptographically valid (invalid)";
    await expect(sellerSide.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 2, ignored: 0,
      skipped: [{ jobId: JOB_ID, channelId: CHANNEL_ID, packetId: stale.packetId, packets: 1, reason }],
    });
    await buyerSide.transport.drain();
    await expect(buyerSide.transport.resumeInbound(SELLER)).resolves.toEqual({
      status: "complete", delivered: 2, ignored: 0, skipped: [],
    });
    // Once the agreement is final, the old proposal is only a duplicate.
    await expect(sellerSide.transport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete", delivered: 3, ignored: 0, skipped: [],
    });
    const buyerStatus = await buyerSide.client.getStatus(JOB_ID);
    const sellerStatus = await sellerSide.client.getStatus(JOB_ID);
    if (buyerStatus.status !== "ok" || sellerStatus.status !== "ok") throw new Error("record did not load");
    expect(sellerStatus.record.agreement?.finalized?.signatures).toHaveLength(2);
    expect(buyerStatus.record.agreement?.finalized).toEqual(sellerStatus.record.agreement?.finalized);
    expect(sellerStatus.record.agreement?.contributions[0]).toEqual(fresh.buyerContribution);
    await expect(buyerSide.client.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "duplicate" });
    buyerSide.transport.stop();
    sellerSide.transport.stop();
  });
});

describe("Demos L2PS RFQ verdict paths and node limits", () => {
  /** A history row from the seller to the buyer, newer than the buyer's offer. */
  function counterpartyRow(
    own: DemosL2psRfqStoredMessage,
    index: number,
    fields: Record<string, unknown> = {},
  ): DemosL2psRfqStoredMessage {
    return {
      ...structuredClone(own),
      id: `counterparty-${index}`,
      from: SELLER_PEER,
      to: BUYER_PEER,
      messageHash: (0x1000 + index).toString(16).padStart(64, "0"),
      timestamp: own.timestamp + 1_000 - index,
      ...fields,
    } as DemosL2psRfqStoredMessage;
  }

  /** A buyer turn packet whose canonical JSON is exactly `bytes` long. */
  function buyerRejectPacket(bytes: number) {
    const build = (reason: string) => {
      const unsigned = {
        packetVersion: "1" as const,
        jobId: JOB_ID,
        channelId: CHANNEL_ID,
        sender: BUYER,
        recipient: SELLER,
        kind: "turn" as const,
        message: {
          channelId: CHANNEL_ID,
          sequence: 1,
          sender: BUYER,
          sentAt: NOW,
          type: "reject" as const,
          body: { rfqBodyVersion: "1" as const, reason },
          signature: "buyer-signature",
        },
      };
      return { ...unsigned, packetId: rfqLifecyclePacketId(unsigned as never) };
    };
    const probe = Buffer.byteLength(canonicalize(build("r") as never), "utf8");
    const packet = build("r".repeat(bytes - probe + 1));
    expect(Buffer.byteLength(canonicalize(packet as never), "utf8")).toBe(bytes);
    return packet;
  }

  function hubTransport(
    hub: FakeL2psHub,
    role: "buyer" | "seller",
    extra: Partial<DemosL2psRfqTransportOptions> = {},
  ) {
    const errors: Error[] = [];
    const outboxStore = memorySendOutbox();
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(role === "buyer" ? BUYER_PEER : SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore,
      localClaim: role === "buyer" ? BUYER : SELLER,
      localPeerKey: role === "buyer" ? BUYER_PEER : SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: (error) => errors.push(error),
      ...extra,
    });
    return { transport, errors, outboxStore };
  }

  /** A second buyer transport over the receiver fixture's hub and key. */
  function buyerReconcile(fixture: Awaited<ReturnType<typeof inboundReceiver>>) {
    return createDemosL2psRfqTransport<string>({
      peer: fixture.hub.peer(BUYER_PEER),
      codec: fixture.baseCodec,
      l2psUid: L2PS_UID,
      peerChannel: "loopback",
      outboxStore: memorySendOutbox(),
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    }).reconcile(fixture.packet);
  }

  describe("send acknowledgement verdicts", () => {
    test.each([
      { name: "another hash, queued", ack: { messageHash: "f".repeat(64), status: "queued" } },
      { name: "another hash, submitted", ack: { messageHash: "f".repeat(64), l2psStatus: "submitted" } },
      { name: "status sent", ack: { status: "sent" } },
      { name: "l2psStatus pending", ack: { l2psStatus: "pending" } },
      { name: "l2psStatus failed", ack: { l2psStatus: "failed" } },
      { name: "the hash alone", ack: {} },
      { name: "no hash", rawAck: { status: "queued" } },
      { name: "null", rawAck: null },
      { name: "a string", rawAck: "ok" },
    ])("an acknowledgement with $name is indeterminate and never stored as acknowledged", async (input) => {
      const { name: _name, ...options } = input;
      const fixture = await delayedSendFixture(options);
      try {
        await expect(fixture.offer()).resolves.toMatchObject({ status: "indeterminate" });
        expect(fixture.submissions).toHaveLength(1);
        await expect(fixture.outboxStore.load(fixture.packet().packetId))
          .resolves.toMatchObject({ state: "indeterminate" });
      } finally { await fixture.cleanup(); }
    });
  });

  describe("the node's offline flag", () => {
    test.each([false, true])("a live payload with offline: %s is delivered", async (offline) => {
      const fixture = await inboundReceiver();
      fixture.emit({ ...fixture.payload, offline });
      await fixture.transport.drain();
      expect(fixture.errors).toEqual([]);
      expect(fixture.receive).toHaveBeenCalledTimes(1);
      fixture.transport.stop();
    });

    test("a live payload whose offline flag is not a boolean is refused", async () => {
      const fixture = await inboundReceiver();
      fixture.emit({ ...fixture.payload, offline: "true" as never });
      await fixture.transport.drain();
      expect(fixture.errors.map((error) => error.message)).toEqual(["Demos L2PS incoming RFQ payload is malformed"]);
      expect(fixture.receive).not.toHaveBeenCalled();
      fixture.transport.stop();
    });

    test("the hub's live delivery carries offline: false, as the node's does", async () => {
      const hub = new FakeL2psHub();
      const seen: DemosL2psRfqIncomingPayload[] = [];
      hub.peer(SELLER_PEER).onMessage((payload) => seen.push(payload));
      const buyerSide = hubTransport(hub, "buyer");
      await expect(buyerSide.transport.publish(buyerRejectPacket(1_000))).resolves.toEqual({ disposition: "acknowledged" });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.offline).toBe(false);
    });
  });

  describe("history statuses and node-written fields", () => {
    test.each(["delivered", "queued", "sent", "l2ps_pending", "l2ps_batched", "l2ps_confirmed"] as const)(
      "our own history row with status %s acknowledges, and recovery completes",
      async (status) => {
        const fixture = await inboundReceiver();
        fixture.hub.messages[0]!.status = status;
        await expect(buyerReconcile(fixture)).resolves.toEqual({ disposition: "acknowledged" });
        await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
          status: "complete", delivered: 1, ignored: 0, skipped: [],
        });
        fixture.transport.stop();
      },
    );

    test("a failed row keeps both reconcile and recovery indeterminate", async () => {
      const fixture = await inboundReceiver();
      fixture.hub.messages[0]!.status = "failed";
      await expect(buyerReconcile(fixture)).resolves.toEqual({
        disposition: "indeterminate",
        reason: "Demos L2PS history records a failed submission with unknown delivery",
      });
      await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "indeterminate", delivered: 1, ignored: 0, skipped: [],
        reason: "Demos L2PS inbound history includes failed submission status",
      });
      fixture.transport.stop();
    });

    test.each([
      { name: "an unknown status", fields: { status: "archived" } },
      { name: "a negative timestamp", fields: { timestamp: -1 } },
      { name: "a fractional timestamp", fields: { timestamp: 1.5 } },
      { name: "a numeric l2psTxHash", fields: { l2psTxHash: 7 } },
      { name: "a sender that is not a hex key", fields: { from: "not-a-key" } },
      { name: "an empty id", fields: { id: "" } },
      { name: "an extra field", fields: { note: "x" } },
    ])("a row with $name, which only the node writes, refuses the page", async ({ fields }) => {
      let page: DemosL2psRfqHistoryPage | undefined;
      const { transport, packet, own } = await buyerWithSentOffer({
        history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
      });
      page = { messages: [counterpartyRow(own, 0), structuredClone(own)], hasMore: false };
      await expect(transport.reconcile(packet)).resolves.toEqual({ disposition: "acknowledged" });
      page = { messages: [counterpartyRow(own, 0, fields), structuredClone(own)], hasMore: false };
      await expect(transport.reconcile(packet)).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ history reconciliation failed",
      });
    });

    test("a row the node wrote with an unknown status refuses inbound recovery", async () => {
      const fixture = await inboundReceiver();
      fixture.hub.messages.push(counterpartyRow(fixture.own, 0, { from: BUYER_PEER, to: SELLER_PEER, status: "archived" }));
      await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "indeterminate", delivered: 0, ignored: 0, skipped: [],
        reason: "Demos L2PS inbound history recovery failed",
      });
      expect(fixture.receive).not.toHaveBeenCalled();
      fixture.transport.stop();
    });

    test.each([
      { name: "no hasMore", page: (own: DemosL2psRfqStoredMessage) => ({ messages: [own] }) },
      { name: "a string hasMore", page: (own: DemosL2psRfqStoredMessage) => ({ messages: [own], hasMore: "false" }) },
      { name: "an extra key", page: (own: DemosL2psRfqStoredMessage) => ({ messages: [own], hasMore: false, cursor: 1 }) },
      { name: "messages that are not an array", page: (own: DemosL2psRfqStoredMessage) => ({ messages: { 0: own }, hasMore: false }) },
    ])("a page with $name is refused", async ({ page }) => {
      const fixture = await buyerWithSentOffer();
      const transport = createDemosL2psRfqTransport<string>({
        peer: { ...fixture.hub.peer(BUYER_PEER), history: async () => page(fixture.own) as never },
        codec: fixture.baseCodec,
        l2psUid: L2PS_UID,
        peerChannel: "loopback",
        outboxStore: memorySendOutbox(),
        localClaim: BUYER,
        localPeerKey: BUYER_PEER,
        peerForClaim,
        claimForPeer,
        onError: vi.fn(),
      });
      await expect(transport.reconcile(fixture.packet)).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ history reconciliation failed",
      });
    });
  });

  describe("a foreign or malformed counterparty frame never blocks the pair", () => {
    test.each([
      { name: "a non-hex messageHash", fields: { messageHash: "x" } },
      { name: "a 128-hex messageHash, as demosdk's channel transport sends", fields: { messageHash: "ab".repeat(64) } },
      { name: "an upper-case messageHash", fields: { messageHash: "E".repeat(64) } },
      { name: "an oversized messageHash", fields: { messageHash: "f".repeat(20_000) } },
      { name: "a numeric ciphertext", fields: { encrypted: { ciphertext: 1, nonce: 1 } } },
      { name: "an extra encrypted key", fields: { encrypted: { ciphertext: "QUFB", nonce: "QUFB", tag: "x" } } },
      { name: "an encrypted string", fields: { encrypted: "QUFB" } },
      { name: "an oversized ciphertext", fields: { encrypted: { ciphertext: "A".repeat(MAX_CIPHERTEXT_CHARS + 4), nonce: "QUFB" } } },
    ])("a row with $name is ignored by reconcile and counted by recovery", async ({ fields }) => {
      const fixture = await inboundReceiver();
      fixture.hub.messages.push(counterpartyRow(fixture.own, 0, { from: BUYER_PEER, to: SELLER_PEER, ...fields }));
      await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "complete", delivered: 1, ignored: 1, skipped: [],
      });
      expect(fixture.receive).toHaveBeenCalledTimes(1);
      // The buyer's own frame is still found on the same page.
      await expect(buyerReconcile(fixture)).resolves.toEqual({ disposition: "acknowledged" });
      fixture.transport.stop();
      // Absence is still provable from a page that holds only such a row.
      let ticks = 0;
      const absent = await buyerWithSentOffer({
        monotonicNowMs: () => ticks,
        history: () => async () => ({ messages: [counterpartyRow(fixture.own, 0, fields)], hasMore: false }),
      });
      ticks = 60_000;
      await expect(absent.transport.reconcile(absent.packet)).resolves.toEqual({ disposition: "absent" });
    });

    test("a row under our packetId and route that is not a well-formed frame is a conflict", async () => {
      const { hub, transport, packet } = await buyerWithSentOffer();
      hub.messages[0]!.encrypted = { ciphertext: 1, nonce: 1 } as never;
      await expect(transport.reconcile(packet)).resolves.toEqual({
        disposition: "rejected",
        reason: "Demos L2PS history binds packetId to different bytes or route",
      });
    });
  });

  describe("multi-page reconcile", () => {
    async function paged(
      pages: (own: DemosL2psRfqStoredMessage, before: number | undefined) => DemosL2psRfqHistoryPage,
      extra: Partial<DemosL2psRfqTransportOptions> = {},
    ) {
      let ticks = 0;
      const requests: unknown[] = [];
      let own: DemosL2psRfqStoredMessage | undefined;
      const fixture = await buyerWithSentOffer({
        monotonicNowMs: () => ticks,
        history: (base) => async (peerKey, options) => {
          if (own === undefined) return base(peerKey, options);
          requests.push(structuredClone(options));
          return pages(own, options?.before);
        },
        extra,
      });
      own = fixture.own;
      // Past the grace, so one exhaustive page without our frame would prove absence.
      ticks = 60_000;
      return { ...fixture, requests };
    }

    test("absent from every page stays indeterminate, and the cursor is the oldest timestamp", async () => {
      const fixture = await paged((own, before) => before === undefined
        ? { messages: [counterpartyRow(own, 0)], hasMore: true }
        : before === counterpartyRow(own, 0).timestamp
          ? { messages: [counterpartyRow(own, 1)], hasMore: false }
          : { messages: [], hasMore: false });
      await expect(fixture.transport.reconcile(fixture.packet)).resolves.toEqual({
        disposition: "indeterminate",
        reason: "Demos L2PS timestamp pagination cannot prove packet absence",
      });
      expect(fixture.requests).toEqual([
        { limit: 100 },
        { before: counterpartyRow(fixture.own, 0).timestamp, limit: 100 },
      ]);
    });

    test("our frame on page 2 acknowledges", async () => {
      const fixture = await paged((own, before) => before === undefined
        ? { messages: [counterpartyRow(own, 0)], hasMore: true }
        : { messages: [structuredClone(own)], hasMore: false });
      await expect(fixture.transport.reconcile(fixture.packet)).resolves.toEqual({ disposition: "acknowledged" });
    });

    test.each([
      {
        name: "an empty page that has more",
        pages: (): DemosL2psRfqHistoryPage => ({ messages: [], hasMore: true }),
        reason: "Demos L2PS history pagination made no progress",
      },
      {
        name: "a page that repeats the last page's IDs",
        pages: (own: DemosL2psRfqStoredMessage, before: number | undefined): DemosL2psRfqHistoryPage => ({
          messages: [counterpartyRow(own, 0, before === undefined ? {} : { timestamp: own.timestamp })],
          hasMore: true,
        }),
        reason: "Demos L2PS history pagination cursor is ambiguous",
      },
      {
        name: "a page that does not move the cursor back",
        pages: (own: DemosL2psRfqStoredMessage, before: number | undefined): DemosL2psRfqHistoryPage => ({
          messages: [counterpartyRow(own, before === undefined ? 0 : 1, { timestamp: own.timestamp + 5_000 })],
          hasMore: true,
        }),
        reason: "Demos L2PS history pagination cursor is ambiguous",
      },
    ])("$name stays indeterminate", async ({ pages, reason }) => {
      const fixture = await paged(pages);
      await expect(fixture.transport.reconcile(fixture.packet)).resolves.toEqual({ disposition: "indeterminate", reason });
    });

    test("historyMaxPages ends the search indeterminate", async () => {
      let index = 0;
      const fixture = await paged((own) => ({ messages: [counterpartyRow(own, index++)], hasMore: true }), { historyMaxPages: 2 });
      await expect(fixture.transport.reconcile(fixture.packet)).resolves.toEqual({
        disposition: "indeterminate", reason: "Demos L2PS RFQ history reconciliation page limit reached",
      });
      expect(fixture.requests).toHaveLength(2);
    });
  });

  describe("inbound recovery completion", () => {
    test("a failed history read delivers nothing and is indeterminate", async () => {
      const fixture = await inboundReceiver({ history: () => async () => { throw new Error("node offline"); } });
      await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "indeterminate", delivered: 0, ignored: 0, skipped: [],
        reason: "Demos L2PS inbound history recovery failed",
      });
      expect(fixture.receive).not.toHaveBeenCalled();
      fixture.transport.stop();
    });

    test("the oldest packet on page 2 is delivered, and pagination keeps the call indeterminate", async () => {
      const fixture = await inboundReceiver({ extra: { historyPageSize: 1 } });
      // A newer foreign row fills page 1; the offer is only on page 2.
      fixture.hub.messages.push(counterpartyRow(fixture.own, 0, { from: BUYER_PEER, to: SELLER_PEER, messageHash: "x" }));
      await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "indeterminate", delivered: 1, ignored: 1, skipped: [],
        reason: "Demos L2PS timestamp pagination cannot prove inbound completeness",
      });
      expect(fixture.receive).toHaveBeenCalledTimes(1);
      fixture.transport.stop();
    });

    test("the shared decryption budget running out stops the scan with its reason", async () => {
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      try {
        const fixture = await inboundReceiver({
          operationTimeoutMs: 500,
          open: (base) => (encrypted, context) => {
            now += 1_000;
            return base.open(encrypted, context);
          },
        });
        fixture.hub.messages.push({ ...structuredClone(fixture.own), id: "newer-copy", timestamp: fixture.own.timestamp + 1 });
        await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
          status: "indeterminate", delivered: 1, ignored: 0, skipped: [],
          reason: "Demos L2PS inbound history decryption budget exhausted",
        });
        fixture.transport.stop();
      } finally {
        clock.mockRestore();
      }
    });

    test.each([
      {
        name: "an empty page that has more",
        page: (): DemosL2psRfqHistoryPage => ({ messages: [], hasMore: true }),
        reason: "Demos L2PS inbound history pagination made no progress",
      },
      {
        name: "a page that does not move the cursor back",
        page: (own: DemosL2psRfqStoredMessage): DemosL2psRfqHistoryPage => ({ messages: [structuredClone(own)], hasMore: true }),
        reason: "Demos L2PS inbound history cursor is ambiguous",
      },
    ])("$name stays indeterminate", async ({ page, reason }) => {
      let own: DemosL2psRfqStoredMessage | undefined;
      const fixture = await inboundReceiver({
        history: (base) => async (peerKey, options) => own === undefined ? base(peerKey, options) : page(own),
      });
      own = fixture.own;
      await expect(fixture.transport.resumeInbound(BUYER)).resolves.toMatchObject({ status: "indeterminate", reason });
      fixture.transport.stop();
    });

    test("historyMaxPages ends recovery indeterminate", async () => {
      const fixture = await inboundReceiver({ extra: { historyPageSize: 1, historyMaxPages: 1 } });
      fixture.hub.messages.push(counterpartyRow(fixture.own, 0, { from: BUYER_PEER, to: SELLER_PEER, messageHash: "x" }));
      await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "indeterminate", delivered: 0, ignored: 1, skipped: [],
        reason: "Demos L2PS inbound history recovery page limit reached",
      });
      fixture.transport.stop();
    });
  });

  describe("a custom codec relies on the transport's route checks", () => {
    const THIRD = "did:demos:third-l2ps-rfq";
    // No authentication at all: only the transport's own checks bind the route.
    const plainCodec: DemosL2psRfqWireCodec = {
      codecId: "plain-test-codec",
      seal: (plaintext) => ({ ciphertext: Buffer.from(plaintext).toString("base64"), nonce: "AAAAAAAAAAAAAAAA" }),
      open: (encrypted) => Uint8Array.from(Buffer.from(encrypted.ciphertext, "base64")),
    };

    function plainReceiver(localClaim: string, localPeerKey: string) {
      const hub = new FakeL2psHub();
      const errors: Error[] = [];
      const transport = createDemosL2psRfqTransport<string>({
        peer: hub.peer(localPeerKey),
        codec: plainCodec,
        l2psUid: L2PS_UID,
        peerChannel: "loopback",
        outboxStore: memorySendOutbox(),
        localClaim,
        localPeerKey,
        peerForClaim: (claim) => claim === THIRD ? THIRD_PEER : peerForClaim(claim),
        claimForPeer: (peer) => peer === THIRD_PEER ? THIRD : claimForPeer(peer),
        onError: (error) => errors.push(error),
      });
      const consumer = vi.fn(() => ({ status: "ready" as const, record: undefined as never }));
      transport.start(consumer);
      const emit = async (payload: DemosL2psRfqIncomingPayload) => {
        for (const handler of hub.handlers.get(localPeerKey) ?? []) handler(payload);
        await transport.drain();
      };
      return { hub, transport, errors, consumer, emit };
    }

    async function offerFrame() {
      const { packet } = await buyerWithSentOffer();
      const encrypted = {
        ciphertext: Buffer.from(canonicalize(packet as never), "utf8").toString("base64"),
        nonce: "AAAAAAAAAAAAAAAA",
      };
      return { packet, encrypted };
    }

    function row(from: string, to: string, messageHash: string, encrypted: DemosL2psRfqEncryptedMessage): DemosL2psRfqStoredMessage {
      return { id: "row-1", from, to, messageHash, encrypted, l2psUid: L2PS_UID, l2psTxHash: null, timestamp: NOW, status: "delivered" };
    }

    const ROUTE_ERROR = "Demos L2PS RFQ plaintext does not bind its peer route";

    test("live: the frame's hash, sender claim and recipient must all match its plaintext", async () => {
      const { packet, encrypted } = await offerFrame();
      const seller = plainReceiver(SELLER, SELLER_PEER);
      await seller.emit({ from: BUYER_PEER, encrypted, messageHash: "e".repeat(64) });
      await seller.emit({ from: THIRD_PEER, encrypted, messageHash: packet.packetId });
      const third = plainReceiver(THIRD, THIRD_PEER);
      await third.emit({ from: BUYER_PEER, encrypted, messageHash: packet.packetId });
      expect(seller.errors.map((error) => error.message)).toEqual([ROUTE_ERROR, ROUTE_ERROR]);
      expect(third.errors.map((error) => error.message)).toEqual([ROUTE_ERROR]);
      expect(seller.consumer).not.toHaveBeenCalled();
      expect(third.consumer).not.toHaveBeenCalled();
      // Control: the matching route is delivered.
      await seller.emit({ from: BUYER_PEER, encrypted, messageHash: packet.packetId });
      expect(seller.consumer).toHaveBeenCalledTimes(1);
      expect(seller.errors).toHaveLength(2);
    });

    test.each([
      { name: "another hash", local: "seller", from: BUYER_PEER, remote: BUYER, hash: "e".repeat(64) },
      { name: "another sender", local: "seller", from: THIRD_PEER, remote: THIRD, hash: undefined },
      { name: "another recipient", local: "third", from: BUYER_PEER, remote: BUYER, hash: undefined },
    ])("recovery: a frame with $name than its plaintext is unreadable", async ({ local, from, remote, hash }) => {
      const { packet, encrypted } = await offerFrame();
      const receiver = local === "seller" ? plainReceiver(SELLER, SELLER_PEER) : plainReceiver(THIRD, THIRD_PEER);
      const to = local === "seller" ? SELLER_PEER : THIRD_PEER;
      receiver.hub.messages.push(row(from, to, hash ?? packet.packetId, encrypted));
      await expect(receiver.transport.resumeInbound(remote)).resolves.toEqual({
        status: "indeterminate", delivered: 0, ignored: 0, skipped: [],
        reason: "Demos L2PS inbound history contains an unreadable RFQ frame",
      });
      expect(receiver.consumer).not.toHaveBeenCalled();
    });

    test("recovery control: the matching route is delivered", async () => {
      const { packet, encrypted } = await offerFrame();
      const seller = plainReceiver(SELLER, SELLER_PEER);
      seller.hub.messages.push(row(BUYER_PEER, SELLER_PEER, packet.packetId, encrypted));
      await expect(seller.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "complete", delivered: 1, ignored: 0, skipped: [],
      });
    });

    test("publish refuses a packet whose sender is not the local claim, before any send", async () => {
      const { packet } = await offerFrame();
      const seller = plainReceiver(SELLER, SELLER_PEER);
      await expect(seller.transport.publish(packet)).resolves.toEqual({
        disposition: "rejected", reason: "Demos L2PS RFQ packet sender is not the local claim",
      });
      expect(seller.hub.sends).toBe(0);
    });
  });

  test("a failed save after the peer call keeps the sending marker and a full grace", async () => {
    const fixture = await delayedSendFixture({ ack: { l2psStatus: "submitted" }, failSaveAfterSend: true });
    try {
      await expect(fixture.offer()).resolves.toMatchObject({ status: "indeterminate" });
      await expect(fixture.client.getStatus(JOB_ID)).resolves.toMatchObject({
        record: { outbox: [{ state: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable" }] },
      });
      const stored = await fixture.outboxStore.load(fixture.packet().packetId) as Record<string, unknown>;
      expect(stored).toMatchObject({ state: "sending", generation: 1 });
      expect(stored).not.toHaveProperty("attemptEndedAtMs");
      // Recovery starts the whole grace now; only then may history prove absence.
      await expect(fixture.transport.reconcile(fixture.packet())).resolves.toEqual({
        disposition: "indeterminate", reason: ABSENCE_GRACE_REASON,
      });
      fixture.setTicks(10_000 + 59_999);
      await expect(fixture.transport.reconcile(fixture.packet())).resolves.toEqual({
        disposition: "indeterminate", reason: ABSENCE_GRACE_REASON,
      });
      fixture.setTicks(10_000 + 60_000);
      await expect(fixture.transport.reconcile(fixture.packet())).resolves.toEqual({ disposition: "absent" });
      expect(fixture.submissions).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  describe("the node's ciphertext limit", () => {
    test("the codec seals 98,288 bytes into exactly 131,072 Base64 characters and refuses one more byte", () => {
      const codec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
      const context = { messageHash: "1".repeat(64), fromPeer: BUYER_PEER, toPeer: SELLER_PEER };
      const sealed = codec.seal(new Uint8Array(98_288), context) as DemosL2psRfqEncryptedMessage;
      expect(sealed.ciphertext).toHaveLength(MAX_CIPHERTEXT_CHARS);
      expect(codec.open(sealed, context)).toEqual(new Uint8Array(98_288));
      expect(() => codec.seal(new Uint8Array(98_289), context))
        .toThrow("Demos L2PS RFQ plaintext exceeds the wire size limit");
    });

    test("a 98,288-byte packet is sent; one byte more is rejected before any outbox write or send", async () => {
      const hub = new FakeL2psHub();
      const buyerSide = hubTransport(hub, "buyer");
      const largest = buyerRejectPacket(98_288);
      await expect(buyerSide.transport.publish(largest)).resolves.toEqual({ disposition: "acknowledged" });
      expect(hub.messages[0]?.encrypted.ciphertext).toHaveLength(MAX_CIPHERTEXT_CHARS);
      const over = buyerRejectPacket(98_289);
      await expect(buyerSide.transport.publish(over)).resolves.toEqual({
        disposition: "rejected", reason: "Demos L2PS RFQ packet exceeds the wire size limit",
      });
      expect(hub.sends).toBe(1);
      expect(await buyerSide.outboxStore.load(over.packetId)).toBeUndefined();
    });

    test("a custom codec's frame over the node limit is rejected before any outbox write or send", async () => {
      const hub = new FakeL2psHub();
      const buyerSide = hubTransport(hub, "buyer", {
        codec: {
          codecId: "inflating-test-codec",
          seal: () => ({ ciphertext: "A".repeat(MAX_CIPHERTEXT_CHARS + 4), nonce: "AAAAAAAAAAAAAAAA" }),
          open: () => new Uint8Array(),
        },
      });
      const packet = buyerRejectPacket(1_000);
      await expect(buyerSide.transport.publish(packet)).resolves.toEqual({
        disposition: "rejected", reason: "ciphertext exceeds its size limit",
      });
      expect(hub.sends).toBe(0);
      expect(await buyerSide.outboxStore.load(packet.packetId)).toBeUndefined();
    });
  });

  describe("the AES-GCM wire format", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const context = { messageHash: "1".repeat(64), fromPeer: BUYER_PEER, toPeer: SELLER_PEER };
    // The exact AAD: JCS of the route plus the wire domain.
    const AAD = `{"fromPeer":"${BUYER_PEER}","messageHash":"${"1".repeat(64)}","toPeer":"${SELLER_PEER}","wireDomain":"dacs-rfq-l2ps-wire:v1"}`;

    test("opens a known-answer frame: 12-byte nonce, 16-byte tag, route AAD under the v1 domain", () => {
      // Computed independently with node:crypto: key 00..1f, nonce a0..ab,
      // plaintext {"dacs":"rfq"}, AAD as above.
      const codec = createDemosL2psRfqAesGcmCodec({ sharedKey: key });
      const opened = codec.open(
        { ciphertext: "nToYTCa4IIVAF+GiJQfeGcWcREfxE37VyWHUogAH", nonce: "oKGio6Slpqeoqaqr" },
        context,
      ) as Uint8Array;
      expect(Buffer.from(opened).toString("utf8")).toBe('{"dacs":"rfq"}');
    });

    test("seals a frame that the same format opens outside the SDK", () => {
      const codec = createDemosL2psRfqAesGcmCodec({ sharedKey: key });
      const plaintext = Buffer.from('{"dacs":"rfq"}', "utf8");
      const sealed = codec.seal(plaintext, context) as DemosL2psRfqEncryptedMessage;
      expect(sealed).not.toHaveProperty("ephemeralKey");
      const nonce = Buffer.from(sealed.nonce, "base64");
      const combined = Buffer.from(sealed.ciphertext, "base64");
      expect(nonce).toHaveLength(12);
      expect(combined).toHaveLength(plaintext.length + 16);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(AAD, "utf8"));
      decipher.setAuthTag(combined.subarray(plaintext.length));
      expect(Buffer.concat([decipher.update(combined.subarray(0, plaintext.length)), decipher.final()]))
        .toEqual(plaintext);
      expect(() => codec.open({ ...sealed, ephemeralKey: "ek" }, context))
        .toThrow("AES-GCM RFQ frames cannot contain an ephemeralKey");
    });

    test.each([
      { name: "31 bytes", options: { sharedKey: new Uint8Array(31) } },
      { name: "33 bytes", options: { sharedKey: new Uint8Array(33) } },
      { name: "a 32-character string", options: { sharedKey: "k".repeat(32) } },
      { name: "an array of 32 numbers", options: { sharedKey: Array(32).fill(1) } },
      { name: "an extra option", options: { sharedKey: new Uint8Array(32), nonce: 1 } },
      { name: "no key", options: {} },
    ])("the codec factory refuses $name", ({ options }) => {
      expect(() => createDemosL2psRfqAesGcmCodec(options as never))
        .toThrow("Demos L2PS RFQ sharedKey must be exactly 32 bytes");
    });

    test("a custom codec's ephemeralKey is stored, delivered and recovered unchanged", async () => {
      const hub = new FakeL2psHub();
      const aes = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
      const seen: Array<string | undefined> = [];
      const codec: DemosL2psRfqWireCodec = {
        codecId: "ephemeral-test-codec",
        async seal(plaintext, sealContext) {
          return { ...(await aes.seal(plaintext, sealContext)), ephemeralKey: "ek-1" };
        },
        open(encrypted, openContext) {
          seen.push(encrypted.ephemeralKey);
          return aes.open({ ciphertext: encrypted.ciphertext, nonce: encrypted.nonce }, openContext);
        },
      };
      const buyerSide = hubTransport(hub, "buyer", { codec });
      const sellerSide = hubTransport(hub, "seller", { codec });
      const consumer = vi.fn(() => ({ status: "ready" as const, record: undefined as never }));
      sellerSide.transport.start(consumer);
      await expect(buyerSide.transport.publish(buyerRejectPacket(1_000))).resolves.toEqual({ disposition: "acknowledged" });
      await sellerSide.transport.drain();
      expect(hub.messages[0]?.encrypted.ephemeralKey).toBe("ek-1");
      await expect(sellerSide.transport.resumeInbound(BUYER)).resolves.toEqual({
        status: "complete", delivered: 1, ignored: 0, skipped: [],
      });
      expect(consumer).toHaveBeenCalledTimes(2);
      expect(seen).toEqual(["ek-1", "ek-1"]);
      expect(sellerSide.errors).toEqual([]);
      sellerSide.transport.stop();
    });
  });

  test.each(["rejected", "indeterminate", "conflict"] as const)(
    "a live packet the lifecycle answers %s is reported once to onError with its reason",
    async (status) => {
      const fixture = await inboundReceiver();
      fixture.receive.mockImplementationOnce(() => ({ status, reason: "lifecycle said no" }) as never);
      fixture.emit(fixture.payload);
      await fixture.transport.drain();
      expect(fixture.errors.map((error) => error.message))
        .toEqual(["Demos L2PS RFQ lifecycle receive failed: lifecycle said no"]);
      // The same packet, now accepted, reports nothing more.
      fixture.emit(fixture.payload);
      await fixture.transport.drain();
      expect(fixture.errors).toHaveLength(1);
      expect(fixture.receive).toHaveBeenCalledTimes(2);
      fixture.transport.stop();
    },
  );
});
