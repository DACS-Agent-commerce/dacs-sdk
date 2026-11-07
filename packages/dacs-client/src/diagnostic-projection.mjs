// Public diagnostics are built from saved purchase state, which can hold signing
// requests, replayable signatures and arbitrarily large values. Nothing from
// saved state reaches a diagnostic except through these projections.

/** Size limits of one projection; the JSON text of a projected value never exceeds outputChars. */
export const DIAGNOSTIC_LIMITS = Object.freeze({ stringChars: 1024, collectionItems: 32, depth: 6, outputChars: 65536 });
/** Replaces any value, list tail or record that does not fit the limits; a cut record carries it as key and value. */
export const DIAGNOSTIC_OMITTED = '[omitted: over the diagnostic size limit]';
const MARKER = JSON.stringify(DIAGNOSTIC_OMITTED);
// The most a list or record can still write when it closes: a separator, its marker and its bracket.
const LIST_TAIL = `,${MARKER}]`;
const RECORD_TAIL = `,${MARKER}:${MARKER}}`;
const OPERATION_STATE_FIELDS = ['preparedVerification', 'protocol'];
const PROTOCOL_STATE_FIELDS = ['stage', 'revision', 'notSaved', 'listing', 'agreement', 'commitment', 'claim', 'paymentEvidence',
  'delivery', 'bundle', 'nativeEvidence', 'attempts', 'deliveryDeadline', 'storageGap', 'agreementContext'];
// Signatures are matched by name, whatever record holds them; rootBinding is the DACS-1 session-key
// presentation's root signature, the one Standard signature field not named as one.
const SIGNATURE_KEY = /signature/i;
const SIGNING_MATERIAL_KEYS = new Set(['payload', 'message', 'agreementMessage', 'anchorMessage', 'rootBinding', 'planned', 'buyerBundle', 'rawTransaction']);

const isSigningMaterial = key => SIGNATURE_KEY.test(key) || SIGNING_MATERIAL_KEYS.has(key);
const isPlainRecord = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isScalar = value => value === null || ['boolean', 'string'].includes(typeof value) || Number.isFinite(value);
const pick = (record, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
// Own data only: an accessor reads as undefined and is dropped, so no getter runs.
const ownValue = (container, key) => Object.getOwnPropertyDescriptor(container, key)?.value;

// The projection is written as JSON text. Every token passes through write(), which refuses any text that
// would leave too little room for the tails of the containers still open; closing spends that reserved room.
function write(writer, text, tail = '') {
  if (writer.out.length + writer.reserve + text.length + tail.length > DIAGNOSTIC_LIMITS.outputChars) return false;
  writer.out += text;
  writer.reserve += tail.length;
  return true;
}

function close(writer, tail, text) {
  writer.reserve -= tail.length;
  writer.out += text;
}

// A value reports 'skipped' (nothing written), 'written', 'refused' (did not fit, nothing written)
// or 'cut' (the output ran out inside it and it was closed with the marker).
const writeToken = (writer, text) => write(writer, text) ? 'written' : 'refused';

function writeList(writer, list, depth, prefix) {
  if (!write(writer, `${prefix}[`, LIST_TAIL)) return 'refused';
  let separator = '';
  let status = list.length > DIAGNOSTIC_LIMITS.collectionItems ? 'over' : 'written';
  for (let index = 0; index < Math.min(list.length, DIAGNOSTIC_LIMITS.collectionItems); index++) {
    const item = writeValue(writer, ownValue(list, index), depth + 1, separator);
    if (item === 'written' || item === 'cut') separator = ',';
    if (item === 'refused' || item === 'cut') { status = 'cut'; break; }
  }
  close(writer, LIST_TAIL, status === 'written' ? ']' : `${separator}${MARKER}]`);
  return status === 'cut' ? 'cut' : 'written';
}

function writeRecord(writer, record, depth, prefix) {
  const keys = Object.keys(record);
  if (keys.length > DIAGNOSTIC_LIMITS.collectionItems) return writeToken(writer, prefix + MARKER);
  if (!write(writer, `${prefix}{`, RECORD_TAIL)) return 'refused';
  let separator = '';
  let status = 'written';
  for (const key of keys) {
    const value = ownValue(record, key);
    // A marker field is never copied in place: it is carried to the close, so a projected diagnostic keeps
    // its one marker and no other value can take the marker's name.
    if (key === DIAGNOSTIC_OMITTED) { if (value === DIAGNOSTIC_OMITTED) status = 'over'; continue; }
    if (isSigningMaterial(key)) continue;
    if (key.length > DIAGNOSTIC_LIMITS.stringChars) { status = 'over'; break; }
    const field = writeValue(writer, value, depth + 1, `${separator}${JSON.stringify(key)}:`);
    if (field === 'written' || field === 'cut') separator = ',';
    if (field === 'refused' || field === 'cut') { status = 'cut'; break; }
  }
  close(writer, RECORD_TAIL, status === 'written' ? '}' : `${separator}${MARKER}:${MARKER}}`);
  return status === 'cut' ? 'cut' : 'written';
}

function writeValue(writer, value, depth, prefix) {
  if (Array.isArray(value) || isPlainRecord(value)) {
    if (depth >= DIAGNOSTIC_LIMITS.depth) return writeToken(writer, prefix + MARKER);
    return Array.isArray(value) ? writeList(writer, value, depth, prefix) : writeRecord(writer, value, depth, prefix);
  }
  if (!isScalar(value)) return 'skipped';
  if (typeof value === 'string' && value.length > DIAGNOSTIC_LIMITS.stringChars) return writeToken(writer, prefix + MARKER);
  return writeToken(writer, prefix + JSON.stringify(value));
}

/**
 * Copies plain JSON-like data within DIAGNOSTIC_LIMITS and without signing or replay material.
 * Host objects, functions, bigints, non-finite numbers and accessor properties are dropped without a marker.
 * An oversized string, a record over the field limit or a value too deep becomes DIAGNOSTIC_OMITTED; a list
 * cut short ends with it, and a record cut short carries it as a DIAGNOSTIC_OMITTED field.
 * Does not throw for plain data.
 * @returns {unknown} a fresh value whose JSON text is at most DIAGNOSTIC_LIMITS.outputChars long,
 *   or undefined when the value itself is dropped
 */
export function projectDiagnostic(value) {
  const writer = { out: '', reserve: 0 };
  const status = writeValue(writer, value, 0, '');
  if (status === 'skipped') return undefined;
  // Unreachable while every token passes write(); an accounting slip fails closed instead of overshooting.
  if (status === 'refused' || writer.out.length > DIAGNOSTIC_LIMITS.outputChars) return DIAGNOSTIC_OMITTED;
  return JSON.parse(writer.out);
}

/**
 * Projects a saved purchase operation: only the listed state fields are kept, then the limits apply.
 * A state or protocol state that is not a plain record projects as an empty record.
 * @throws {TypeError} when operation is not a plain record
 * @returns {object} a fresh operation without planned requests, bundles to sign, identities or delegations
 */
export function projectDiagnosticOperation(operation) {
  if (!isPlainRecord(operation)) throw new TypeError('a diagnostic operation must be a plain record');
  const { state, ...fields } = operation;
  const saved = pick(isPlainRecord(state) ? state : {}, OPERATION_STATE_FIELDS);
  if (Object.hasOwn(saved, 'protocol')) saved.protocol = pick(isPlainRecord(saved.protocol) ? saved.protocol : {}, PROTOCOL_STATE_FIELDS);
  return projectDiagnostic({ ...fields, state: saved });
}
