import type {
  RatingPublicationEffectClaim,
  RatingPublicationEffectRecord,
  RatingPublicationEffectStore,
  RatingPublicationEffectWrite,
} from "@kynesyslabs/dacs";

import type { DacsNodeSqliteDatabase } from "./sqlite.js";

function ratingRecord(
  record: { kind: string } | undefined,
): Readonly<RatingPublicationEffectRecord> | undefined {
  if (record !== undefined && record.kind !== "artifact-publication") {
    throw new Error(
      "SQLite returned a non-publication effect for a RatingRecord operation",
    );
  }
  return record as Readonly<RatingPublicationEffectRecord> | undefined;
}

function ratingClaim(
  claim: ReturnType<DacsNodeSqliteDatabase["claimEffect"]>,
): RatingPublicationEffectClaim {
  if ("record" in claim) ratingRecord(claim.record);
  return claim as unknown as RatingPublicationEffectClaim;
}

function ratingWrite(
  write: ReturnType<DacsNodeSqliteDatabase["recordEffectCompleted"]>,
): RatingPublicationEffectWrite {
  if ("record" in write) ratingRecord(write.record);
  return write as unknown as RatingPublicationEffectWrite;
}

/**
 * Narrow the generic SQLite `artifact-publication` effect to the core SDK's
 * RatingRecord publication store. The wrapper preserves the database's
 * generation fencing and validates that no different effect kind crosses the
 * structural boundary.
 */
export function createSqliteRatingPublicationEffectStore(
  database: DacsNodeSqliteDatabase,
): RatingPublicationEffectStore {
  const store: RatingPublicationEffectStore = {
    putEffectIntent(input) {
      const result = database.putEffectIntent(input);
      ratingRecord(result.record);
      return result as unknown as Awaited<
        ReturnType<RatingPublicationEffectStore["putEffectIntent"]>
      >;
    },
    claimEffect(input) {
      return ratingClaim(database.claimEffect(input));
    },
    isCurrentEffect(input) {
      return database.isCurrentEffect(input);
    },
    recordEffectCompleted(input) {
      return ratingWrite(database.recordEffectCompleted(input));
    },
    recordEffectAmbiguous(input) {
      return ratingWrite(database.recordEffectAmbiguous(input));
    },
    requireEffectOperatorAction(input) {
      return ratingWrite(database.requireEffectOperatorAction(input));
    },
  };
  return Object.freeze(store);
}
