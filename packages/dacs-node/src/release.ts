import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";

import { DACS_NODE_SQLITE_SCHEMA_VERSION } from "./sqlite.js";

export const DACS_NODE_RELEASE_METADATA_VERSION = 1 as const;
export const DACS_NODE_CONFIG_SCHEMA_VERSION = 1 as const;
export const DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES =
  Object.freeze([1, 2, 3, 4, 5, 6] as const);

/**
 * Public compatibility metadata mirrored into the npm manifests. Registry
 * consumers fail closed when a candidate release omits or changes this shape.
 */
export const DACS_NODE_RELEASE_METADATA_V1 = Object.freeze({
  releaseMetadataVersion: DACS_NODE_RELEASE_METADATA_VERSION,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  configSchemaVersion: DACS_NODE_CONFIG_SCHEMA_VERSION,
  sqliteSchemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
  supportedSqliteMigrationFrom: DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES,
  breakingConfigurationChanges: Object.freeze([] as readonly string[]),
});
