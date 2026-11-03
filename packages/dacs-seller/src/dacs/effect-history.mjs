// The kit's append-only effect history (K0's dispatch history, DS-4): one record per
// effect-boundary step, in order and never overwritten, at
// <dataDirectory>/effects/<lane>/<seq>.json. A history that cannot be read whole is
// unavailable, never an empty or "never dispatched" one. Records carry no clock, so a
// record written again by the same step is byte-identical.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { WireError } from '@kynesyslabs/dacs/wire';
import { DURABLE_SYNC, publishFileExclusive } from '../devnet-demo/durable-file.mjs';

const EFFECTS_DIRECTORY = 'effects';
/** Most records one lane keeps; a lane at the bound refuses further appends. */
export const MAX_RECORDS_PER_LANE = 1024;
/** Largest record file read or written, in bytes (a signed artifact of 256 KiB in base64 fits). */
export const MAX_RECORD_BYTES = 524288;
const PRIVATE_DIRECTORY_MODE = 0o700;
const SEQUENCE_DIGITS = 8;
const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECORD_STATE = /^(?:signed|signed-held|observed|(?:dispatch|confirm|broadcast)-(?:started|withheld|acknowledged|unknown))$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UNPUBLISHED_TEMPORARY = /^\d{8}\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

const unavailable = (detail, cause) => new WireError('eb_history_unavailable', 500, detail, cause);
const persistFailed = (detail, cause) => new WireError('eb_persist_failed', 500, detail, cause);
const recordName = (seq) => `${String(seq).padStart(SEQUENCE_DIGITS, '0')}.json`;
const laneNameOf = (lane) => {
  if (typeof lane !== 'string' || !LANE_NAME.test(lane)) throw unavailable('the lane is not a valid lane name');
  return lane;
};

// Reads a regular file of at most MAX_RECORD_BYTES; one byte more than its size is read so growth is seen.
async function readBounded(path) {
  if (!(await lstat(path)).isFile()) throw unavailable(`${path} is not a regular file`);
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size > MAX_RECORD_BYTES) throw unavailable(`${path} is over ${MAX_RECORD_BYTES} bytes`);
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    for (let bytesRead = 1; bytesRead > 0; length += bytesRead) ({ bytesRead } = await handle.read(buffer, length, buffer.length - length, length));
    if (length > size) throw unavailable(`${path} changed while it was read`);
    return buffer.toString('utf8', 0, length);
  } finally { await handle.close(); }
}

/** The filesystem steps the history takes; a test passes its own to observe or fail them. */
export const DEFAULT_HISTORY_IO = Object.freeze({
  mkdir: (path) => mkdir(path, { mode: PRIVATE_DIRECTORY_MODE }), lstat, list: readdir, read: readBounded, sync: DURABLE_SYNC, publish: publishFileExclusive,
});

/**
 * Creates the private directory `path` when missing, then syncs it and its parent, every time, so a
 * sync that failed on an earlier call is retried even though the directory exists. Every directory the
 * kit creates under dataDirectory goes through this helper; the parent must exist. Returns after both
 * syncs. Throws the filesystem's error, or the existing entry's EEXIST when it is not a real directory.
 */
export async function initHistory(path, io = DEFAULT_HISTORY_IO) {
  try { await io.mkdir(path); } catch (error) {
    if (error?.code !== 'EEXIST' || !(await io.lstat(path)).isDirectory()) throw error;
  }
  await io.sync.directory(path);
  await io.sync.directory(dirname(path));
}

function parseRecord(text, seq, lane) {
  let record;
  try { record = JSON.parse(text); } catch (cause) { throw unavailable(`record ${seq} of lane ${lane} is not valid JSON`, cause); }
  const hasText = (field) => typeof record?.[field] === 'string' && record[field].length > 0;
  if (record === null || typeof record !== 'object' || record.seq !== seq || record.lane !== lane || !RECORD_STATE.test(record.state) ||
      !hasText('operationId') || !hasText('pinVersion') || !SHA256_HEX.test(record.artifactHash)) throw unavailable(`record ${seq} of lane ${lane} is not a valid record`);
  if (record.state === 'signed') {
    const bytes = hasText('bytes') ? Buffer.from(record.bytes, 'base64') : Buffer.alloc(0);
    if (bytes.length === 0 || bytes.toString('base64') !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.artifactHash)
      throw unavailable(`record ${seq} of lane ${lane} does not retain its exact signed bytes`);
  }
  return Object.freeze(record);
}

/**
 * The history under `<dataDirectory>/effects/`: `read(lane)` returns the lane's records in order
 * (empty for a lane never written); `append(lane, fields)` stores `{ seq, lane, ...fields }` under the
 * next sequence number and returns `{ record, created }`, `created` false when an identical record was
 * already there (nothing new was written, so it grants no new send). `fields` carry `state`,
 * `operationId`, `pinVersion` and `artifactHash`, and the exact `bytes` (base64) for `signed`. Appends
 * run under the effect boundary's fence. Both throw `eb_history_unavailable` for an invalid lane or a
 * history that is unreadable, truncated, oversized, gapped or foreign, and `eb_persist_failed` (cause
 * kept) when the lane's directories cannot be synced; `append` also throws it for a record it refuses
 * or could not make durable.
 */
export function createEffectHistory({ dataDirectory, io = DEFAULT_HISTORY_IO }) {
  const effects = join(dataDirectory, EFFECTS_DIRECTORY);

  async function listRecords(lane, directory) {
    let names;
    try { names = (await io.list(directory)).filter((name) => !UNPUBLISHED_TEMPORARY.test(name)).sort(); } catch (cause) {
      throw unavailable(`lane ${lane} cannot be listed`, cause);
    }
    if (names.length > MAX_RECORDS_PER_LANE) throw unavailable(`lane ${lane} holds more than ${MAX_RECORDS_PER_LANE} entries`);
    const records = [];
    for (const [index, name] of names.entries()) {
      if (name !== recordName(index + 1)) throw unavailable(`lane ${lane} has ${name} where ${recordName(index + 1)} is next`);
      let text;
      try { text = await io.read(join(directory, name)); } catch (cause) { throw cause instanceof WireError ? cause : unavailable(`${name} cannot be read`, cause); }
      records.push(parseRecord(text, index + 1, lane));
    }
    return records;
  }

  // What a caller relies on is synced first: the history root and the lane directory are made or re-synced.
  async function loadSynced(lane, { create }) {
    const directory = join(effects, laneNameOf(lane));
    if (!create) {
      try { await io.lstat(directory); } catch (cause) {
        if (cause?.code === 'ENOENT') return [];
        throw unavailable(`lane ${lane} cannot be inspected`, cause);
      }
    }
    try { await initHistory(effects, io); await initHistory(directory, io); } catch (cause) { throw persistFailed(`lane ${lane}'s directories cannot be made durable`, cause); }
    return listRecords(lane, directory);
  }

  async function appendRecord(lane, fields) {
    if (!fields || Object.hasOwn(fields, 'seq') || Object.hasOwn(fields, 'lane')) throw persistFailed('record fields cannot set the allocated sequence or lane');
    const records = await loadSynced(lane, { create: true });
    if (records.length >= MAX_RECORDS_PER_LANE) throw persistFailed(`lane ${lane} is full`);
    const record = { seq: records.length + 1, lane, ...fields };
    const text = `${canonicalize(record)}\n`;
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw persistFailed(`a record for lane ${lane} is over ${MAX_RECORD_BYTES} bytes`);
    try { parseRecord(text, record.seq, lane); } catch (cause) { throw persistFailed(`a new record for lane ${lane} is invalid`, cause); }
    const directory = join(effects, lane);
    const path = join(directory, recordName(record.seq));
    if (await io.publish(path, text, io.sync)) return { record, created: true };
    const existing = parseRecord(await io.read(path), record.seq, lane);
    if (canonicalize(existing) !== canonicalize(record)) throw persistFailed(`${recordName(record.seq)} of lane ${lane} holds a different record`);
    await io.sync.directory(directory);
    await io.sync.directory(effects);
    return { record: existing, created: false };
  }

  return Object.freeze({
    read: (lane) => loadSynced(lane, { create: false }),
    async append(lane, fields) {
      try { return await appendRecord(lane, fields); } catch (error) {
        throw error instanceof WireError ? error : persistFailed(`a record for lane ${lane} could not be made durable`, error);
      }
    },
  });
}
