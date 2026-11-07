// The kit's data-directory format marker (SA-6). A directory that holds no kit
// state gets the marker first, durably; any other directory must already carry
// the current one, so state from an older kit format is refused and never migrated.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DURABLE_SYNC, publishFileExclusive } from '../devnet-demo/durable-file.mjs';

/** The data-directory format this kit reads and writes. */
export const KIT_DATA_FORMAT = 'dacs-kit-data/tp1-1';
const MARKER_FILE = 'kit-format.json';
const MARKER_TEXT = `${JSON.stringify({ format: KIT_DATA_FORMAT })}\n`;
const MAX_MARKER_BYTES = 256;
const STATE_ENTRIES = Object.freeze(['seller', 'transport', 'wire-journal']);
const FORMAT_REFUSED = 'kit_store_format_unsupported';

const refuse = (reason, detail, cause) => Object.assign(
  new Error(`${FORMAT_REFUSED}: ${detail}`, cause === undefined ? undefined : { cause }), { code: FORMAT_REFUSED, reason });

// The entry's stat, or null when it is absent; any other failure refuses with its cause.
async function statOrNull(directory, name) {
  try { return await lstat(join(directory, name)); }
  catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw refuse('unreadable', `${name} cannot be inspected`, cause);
  }
}

async function readMarker(directory) {
  const stat = await statOrNull(directory, MARKER_FILE);
  if (stat === null) return null;
  if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) throw refuse('unknown-format', `${MARKER_FILE} is not a small regular file`);
  try { return await readFile(join(directory, MARKER_FILE), 'utf8'); }
  catch (cause) { throw refuse('unreadable', `${MARKER_FILE} cannot be read`, cause); }
}

function isCurrentMarker(text) {
  try {
    const marker = JSON.parse(text);
    return marker !== null && typeof marker === 'object' && !Array.isArray(marker) && Object.keys(marker).length === 1 && marker.format === KIT_DATA_FORMAT;
  } catch { return false; }
}

/**
 * Checks the format of the kit's data directory, writing the marker first when the directory holds
 * no `seller/`, `transport/` or `wire-journal/`. The marker is published whole (synced file, link,
 * synced directory), through `sync` (DURABLE_SYNC by default), and is never rewritten.
 * Throws an Error with code `kit_store_format_unsupported` and a `reason`: `missing-marker` (state
 * without a marker), `unknown-format` (another, malformed or non-regular marker) or `unreadable`
 * (an entry that cannot be inspected or read; the error is its `cause`). Nothing is migrated.
 */
export async function assertKitDataFormat(dataDirectory, sync = DURABLE_SYNC) {
  const marker = await readMarker(dataDirectory);
  if (marker !== null) {
    if (!isCurrentMarker(marker)) throw refuse('unknown-format', `${MARKER_FILE} names another format than ${KIT_DATA_FORMAT}`);
    return;
  }
  for (const entry of STATE_ENTRIES) {
    if (await statOrNull(dataDirectory, entry) !== null) throw refuse('missing-marker', `${entry}/ exists without ${MARKER_FILE}: this directory is from an older kit format`);
  }
  if (!await publishFileExclusive(join(dataDirectory, MARKER_FILE), MARKER_TEXT, sync)) throw refuse('unknown-format', `${MARKER_FILE} appeared while it was being written`);
}
