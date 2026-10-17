import { admitArtifactJson } from "@kynesyslabs/dacs";

/** Locally constructed mock response bytes at the synthetic adapter boundary. */
export function admittedFixture<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return admitArtifactJson(Buffer.from(JSON.stringify(value))) as T;
  } catch {
    return value;
  }
}
