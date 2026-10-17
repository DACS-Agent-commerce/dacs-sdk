import { snapshotWireJsonRead } from "../../src/canonical/snapshot.js";
import { admitArtifactJson } from "../../src/canonical/index.js";

/** Encode locally constructed test transport data at its synthetic ingress. */
export function admittedFixture<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return admitArtifactJson(Buffer.from(JSON.stringify(snapshotWireJsonRead(value, "synthetic transport")))) as T;
  } catch {
    // Hostile-object tests must still reach the production rejection boundary.
    return value;
  }
}
