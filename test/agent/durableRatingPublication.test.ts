import { describe, expect, it, vi } from "vitest";

import {
  createBuyerRatingRecord,
  type CreateRatingRecordInput,
} from "../../src/agent/ratingRecord.js";
import {
  publishRatingRecordDurably,
  type RatingPublicationEffectLease,
  type RatingPublicationEffectRecord,
  type RatingPublicationEffectStore,
} from "../../src/agent/durableRatingPublication.js";
import {
  RATING_SEPARATOR,
  verifyComponentSignature,
  type RatingRecord,
} from "../../src/artifacts/index.js";
import {
  canonicalize,
  contentHash,
  ratingAddress,
  sha256Hex,
  stripSignature,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  createBoundArtifactRepository,
  createInMemoryBindingStore,
  type BoundArtifactAdapter,
  type BoundArtifactRepository,
} from "../../src/discovery/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 41));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const BUYER_PRIVATE = privateKeyFromSeed(BUYER_SEED);
const BUYER_PUBLIC = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER_PUBLIC = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const BUYER_OWNER = Buffer.from(BUYER_PUBLIC).toString("hex");
const BUYER = `did:demos:agent:${BUYER_OWNER}`;
const SELLER = `did:demos:agent:${Buffer.from(SELLER_PUBLIC).toString("hex")}`;

function ratingInput(
  overrides: Partial<CreateRatingRecordInput> = {},
): CreateRatingRecordInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    value: 5,
    freeText: "Would buy again.",
    ratedAt: 1_780_358_520_000,
    ...overrides,
  };
}

async function buyerRating(
  overrides: Partial<CreateRatingRecordInput> = {},
): Promise<RatingRecord> {
  return createBuyerRatingRecord(ratingInput(overrides), {
    algorithm: "ed25519",
    sign: (bytes) => ed25519Sign(bytes, BUYER_PRIVATE),
  });
}

class MemoryEffectStore implements RatingPublicationEffectStore {
  record?: RatingPublicationEffectRecord;
  inputJson?: string;

  putEffectIntent(input: Parameters<RatingPublicationEffectStore["putEffectIntent"]>[0]) {
    const inputJson = canonicalize(input.input);
    if (this.record) {
      return this.record.bindingHash === input.bindingHash && this.inputJson === inputJson
        ? { status: "existing" as const, record: structuredClone(this.record) }
        : { status: "conflict" as const };
    }
    this.inputJson = inputJson;
    this.record = {
      kind: input.kind,
      effectId: input.effectId,
      bindingHash: input.bindingHash,
      inputHash: sha256Hex(inputJson),
      idempotencyKey: input.idempotencyKey,
      state: "intent",
      generation: 0,
      attempts: 0,
    };
    return { status: "created" as const, record: structuredClone(this.record) };
  }

  claimEffect(input: Parameters<RatingPublicationEffectStore["claimEffect"]>[0]) {
    if (!this.record) return { status: "missing" as const };
    if (this.record.bindingHash !== input.bindingHash) return { status: "stale" as const };
    if (this.record.state === "completed") {
      return { status: "completed" as const, record: structuredClone(this.record) };
    }
    if (this.record.state === "operator-action") {
      return { status: "not-runnable" as const, record: structuredClone(this.record) };
    }
    if (this.record.state === "active") {
      return {
        status: "waiting" as const,
        record: structuredClone(this.record),
        lease: structuredClone(this.record.lease!),
      };
    }
    const mode = this.record.state === "intent" ? "perform" as const : "reconcile" as const;
    const lease: RatingPublicationEffectLease = {
      owner: input.owner,
      generation: this.record.generation + 1,
      expiresAt: Date.now() + input.leaseDurationMs,
      mode,
    };
    this.record = {
      ...this.record,
      state: "active",
      generation: lease.generation,
      attempts: this.record.attempts + 1,
      lease,
    };
    return {
      status: "acquired" as const,
      mode,
      record: structuredClone(this.record),
      lease: structuredClone(lease),
    };
  }

  isCurrentEffect(input: Parameters<RatingPublicationEffectStore["isCurrentEffect"]>[0]) {
    return this.record?.state === "active" &&
      this.record.bindingHash === input.bindingHash &&
      this.record.lease?.owner === input.lease.owner &&
      this.record.lease.generation === input.lease.generation;
  }

  recordEffectCompleted(
    input: Parameters<RatingPublicationEffectStore["recordEffectCompleted"]>[0],
  ) {
    if (!this.isCurrentEffect(input)) return { status: "stale" as const };
    this.record = {
      ...this.record!,
      state: "completed",
      result: structuredClone(input.result),
      lease: undefined,
    };
    delete this.record.lease;
    return { status: "recorded" as const, record: structuredClone(this.record) };
  }

  recordEffectAmbiguous(
    input: Parameters<RatingPublicationEffectStore["recordEffectAmbiguous"]>[0],
  ) {
    if (!this.isCurrentEffect(input)) return { status: "stale" as const };
    this.record = { ...this.record!, state: "reconciliation-required" };
    delete this.record.lease;
    return { status: "recorded" as const, record: structuredClone(this.record) };
  }

  requireEffectOperatorAction(
    input: Parameters<RatingPublicationEffectStore["requireEffectOperatorAction"]>[0],
  ) {
    if (!this.isCurrentEffect(input)) return { status: "stale" as const };
    this.record = { ...this.record!, state: "operator-action" };
    delete this.record.lease;
    return { status: "recorded" as const, record: structuredClone(this.record) };
  }
}

interface Backend {
  writes: number;
  records: Map<string, Record<string, unknown>>;
  names: Map<string, string>;
}

function backend(): Backend {
  return { writes: 0, records: new Map(), names: new Map() };
}

function adapter(owner: string, state: Backend): BoundArtifactAdapter {
  return {
    getAddress: () => owner,
    async anchorWriteOnce(name, value) {
      const existing = state.names.get(name);
      if (existing) {
        const prior = state.records.get(existing)!;
        if (canonicalize(prior) !== canonicalize(value)) {
          throw new Error("immutable anchor conflict");
        }
        return { address: existing, completion: "read-visible" };
      }
      const address = `stor-rating-${state.writes + 1}`;
      state.writes += 1;
      state.names.set(name, address);
      state.records.set(address, structuredClone(value as Record<string, unknown>));
      return { address, txRef: `tx-${address}`, completion: "read-visible" };
    },
    async readAnchor(address) {
      const value = state.records.get(address);
      return value ? structuredClone(value) : null;
    },
  };
}

function repository(state = backend()): {
  repository: BoundArtifactRepository;
  state: Backend;
} {
  const bindings = createInMemoryBindingStore();
  return {
    state,
    repository: createBoundArtifactRepository({
      adapter: adapter(BUYER_OWNER, state),
      index: bindings,
      publisher: bindings,
    }),
  };
}

async function authenticateRecord(input: {
  record: Readonly<RatingRecord>;
  expectedOwner: string;
}) {
  if (input.record.rater !== BUYER || input.expectedOwner !== BUYER_OWNER) {
    return { disposition: "invalid" as const, reason: "wrong rating authority" };
  }
  const verdict = await verifyComponentSignature(
    input.record as unknown as Record<string, unknown>,
    RATING_SEPARATOR,
    {
      isSignerAuthorized: (artifact, signature) =>
        artifact.rater === BUYER && signature.signer === BUYER,
      resolvePublicKey: () => BUYER_PUBLIC,
      verify: ({ signedBytes, signature, publicKey }) =>
        ed25519Verify(
          signedBytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
    },
  );
  return verdict.status === "valid"
    ? { disposition: "valid" as const }
    : { disposition: "invalid" as const, reason: verdict.status };
}

function deps(
  effectStore: MemoryEffectStore,
  boundRepository: BoundArtifactRepository,
) {
  return {
    effectStore,
    workerId: "rating-worker-1",
    leaseDurationMs: 30_000,
    repository: boundRepository,
    authenticateRatingRecord: authenticateRecord,
    authenticateAnchor: async ({ publication }: {
      publication: { anchor: { completion?: string } };
    }) => publication.anchor.completion === "read-visible"
      ? { disposition: "valid" as const }
      : { disposition: "invalid" as const, reason: "anchor is not final" },
  };
}

describe("durable DACS-5 RatingRecord publication", () => {
  it("publishes exact buyer-owned bytes and returns the terminal-bundle ref", async () => {
    const record = await buyerRating();
    const effects = new MemoryEffectStore();
    const bound = repository();

    const result = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, bound.repository),
    );

    expect(result).toMatchObject({
      disposition: "published",
      recovered: false,
      result: {
        logicalAddress: ratingAddress(JOB_ID, BUYER),
        expectedOwner: BUYER_OWNER,
        nativeAddress: "stor-rating-1",
        record,
        ref: {
          anchor: { kind: "storage-program", locator: "stor-rating-1" },
          contentHash: contentHash(stripSignature(
            record as unknown as Record<string, unknown>,
          )),
          signer: BUYER,
        },
      },
    });
    expect(bound.state.writes).toBe(1);
    expect(effects.record?.state).toBe("completed");
  });

  it("recovers a lost response by re-driving only the same write-once bytes", async () => {
    const record = await buyerRating();
    const effects = new MemoryEffectStore();
    const bound = repository();
    let loseResponse = true;
    const write = vi.fn(bound.repository.write.bind(bound.repository));
    const unreliable: BoundArtifactRepository = {
      ...bound.repository,
      async write(...args) {
        const result = await write(...args);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("response lost after publication");
        }
        return result;
      },
    };

    const first = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, unreliable),
    );
    expect(first).toMatchObject({
      disposition: "indeterminate",
      stage: "anchor-and-binding",
    });
    expect(effects.record?.state).toBe("reconciliation-required");

    const recovered = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, unreliable),
    );
    expect(recovered).toMatchObject({ disposition: "published", recovered: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[1]).toEqual(write.mock.calls[1]?.[1]);
    expect(bound.state.writes).toBe(1);
  });

  it("replays a durable completion without touching the repository", async () => {
    const record = await buyerRating();
    const effects = new MemoryEffectStore();
    const bound = repository();
    const first = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, bound.repository),
    );
    expect(first.disposition).toBe("published");

    const write = vi.fn(bound.repository.write.bind(bound.repository));
    const second = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, { ...bound.repository, write }),
    );
    expect(second).toMatchObject({ disposition: "published", recovered: true });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects a corrupt retained completion without re-driving publication", async () => {
    const record = await buyerRating();
    const effects = new MemoryEffectStore();
    const bound = repository();
    expect((await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, bound.repository),
    )).disposition).toBe("published");
    effects.record!.result = { publicationVersion: "1" };
    const write = vi.fn(bound.repository.write.bind(bound.repository));

    const replay = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, { ...bound.repository, write }),
    );
    expect(replay).toMatchObject({ disposition: "rejected", stage: "completion" });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects a conflicting replacement under the same logical address", async () => {
    const original = await buyerRating({ value: 5 });
    const replacement = await buyerRating({ value: 1 });
    const effects = new MemoryEffectStore();
    const bound = repository();
    expect((await publishRatingRecordDurably(
      { record: original, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, bound.repository),
    )).disposition).toBe("published");

    const conflict = await publishRatingRecordDurably(
      { record: replacement, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      deps(effects, bound.repository),
    );
    expect(conflict).toMatchObject({ disposition: "rejected", stage: "intent" });
    expect(bound.state.writes).toBe(1);
  });

  it("rejects role relabelling before creating a durable intent", async () => {
    const record = await buyerRating();
    const effects = new MemoryEffectStore();
    const bound = repository();

    await expect(publishRatingRecordDurably(
      {
        record: { ...record, targetRole: "buyer" },
        buyer: BUYER,
        seller: SELLER,
        expectedOwner: BUYER_OWNER,
      },
      deps(effects, bound.repository),
    )).rejects.toThrow(/direction/);
    expect(effects.record).toBeUndefined();
    expect(bound.state.writes).toBe(0);
  });

  it("fails closed and seals operator action on invalid anchor finality", async () => {
    const record = await buyerRating();
    const effects = new MemoryEffectStore();
    const bound = repository();
    const invalidDeps = {
      ...deps(effects, bound.repository),
      authenticateAnchor: async () => ({
        disposition: "invalid" as const,
        reason: "forged receipt",
      }),
    };

    const result = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      invalidDeps,
    );
    expect(result).toMatchObject({
      disposition: "rejected",
      stage: "anchor-authentication",
    });
    expect(effects.record?.state).toBe("operator-action");
  });

  it("keeps readback authentication errors in reconciliation", async () => {
    const record = await buyerRating();
    const effects = new MemoryEffectStore();
    const bound = repository();
    let calls = 0;
    const result = await publishRatingRecordDurably(
      { record, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      {
        ...deps(effects, bound.repository),
        authenticateRatingRecord: async (input) => {
          calls += 1;
          if (calls === 2) throw new Error("identity resolver unavailable");
          return authenticateRecord(input);
        },
      },
    );
    expect(result).toMatchObject({
      disposition: "indeterminate",
      stage: "exact-readback",
    });
    expect(effects.record?.state).toBe("reconciliation-required");
  });

  it("owns the exact record before asynchronous authentication", async () => {
    const record = await buyerRating();
    const mutable = structuredClone(record);
    const effects = new MemoryEffectStore();
    const bound = repository();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authentication = vi.fn(async (input: {
      record: Readonly<RatingRecord>;
      expectedOwner: string;
    }) => {
      await gate;
      return authenticateRecord(input);
    });
    const pending = publishRatingRecordDurably(
      { record: mutable, buyer: BUYER, seller: SELLER, expectedOwner: BUYER_OWNER },
      { ...deps(effects, bound.repository), authenticateRatingRecord: authentication },
    );
    mutable.value = 1;
    mutable.freeText = "mutated";
    release();

    const result = await pending;
    expect(result).toMatchObject({
      disposition: "published",
      result: { record: { value: 5, freeText: "Would buy again." } },
    });
    expect(authentication).toHaveBeenCalled();
  });
});
