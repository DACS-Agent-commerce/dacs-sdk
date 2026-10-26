// Public diagnostics are built from saved purchase state, which can hold signing
// requests, replayable signatures and arbitrarily large values. Nothing from
// saved state reaches a diagnostic except through these projections.

/** Size limits of one projection; the JSON text of a projected value never exceeds outputChars. */
export const DIAGNOSTIC_LIMITS = Object.freeze({ stringChars: 1024, collectionItems: 32, depth: 6, outputChars: 65536 });
/** Replaces any value, list tail or record that does not fit the limits. */
export const DIAGNOSTIC_OMITTED = '[omitted: over the diagnostic size limit]';
// Room kept back for the markers written once the content budget is spent.
const MARKER_RESERVE = 1024;
const OPERATION_STATE_FIELDS = ['preparedVerification', 'protocol'];
const PROTOCOL_STATE_FIELDS = ['stage', 'revision', 'notSaved', 'listing', 'agreement', 'commitment', 'claim', 'paymentEvidence',
  'delivery', 'bundle', 'nativeEvidence', 'attempts', 'deliveryDeadline', 'storageGap', 'agreementContext'];
const SIGNING_MATERIAL_KEYS = new Set(['payload', 'message', 'agreementMessage', 'anchorMessage', 'signature', 'signatures',
  'buyerSignature', 'sellerSignature', 'planned', 'buyerBundle', 'rawTransaction']);

const isPlainRecord = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const pick = (record, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
const exhausted = budget => budget.chars <= 0;
function omit(budget) {
  budget.chars -= DIAGNOSTIC_OMITTED.length + 3;
  return DIAGNOSTIC_OMITTED;
}

function copyScalar(value, budget) {
  if (value === null || typeof value === 'boolean') { budget.chars -= 5; return value; }
  if (typeof value === 'number') { budget.chars -= String(value).length + 1; return Number.isFinite(value) ? value : undefined; }
  if (typeof value !== 'string') return undefined;
  const cost = value.length > DIAGNOSTIC_LIMITS.stringChars ? Infinity : JSON.stringify(value).length + 1;
  if (cost > budget.chars) return omit(budget);
  budget.chars -= cost;
  return value;
}

function copyList(list, budget, depth) {
  const copy = [];
  for (const item of list.slice(0, DIAGNOSTIC_LIMITS.collectionItems)) {
    if (exhausted(budget)) break;
    const value = copyValue(item, budget, depth + 1);
    if (value !== undefined) copy.push(value);
  }
  if (copy.length < list.length) copy.push(omit(budget));
  return copy;
}

function copyRecord(record, budget, depth) {
  const keys = Object.keys(record);
  if (keys.length > DIAGNOSTIC_LIMITS.collectionItems) return omit(budget);
  const entries = [];
  for (const key of keys) {
    if (SIGNING_MATERIAL_KEYS.has(key)) continue;
    const cost = key.length > DIAGNOSTIC_LIMITS.stringChars ? Infinity : JSON.stringify(key).length + 1;
    if (exhausted(budget) || cost > budget.chars) { entries.push(['omitted', omit(budget)]); break; }
    budget.chars -= cost;
    const value = copyValue(record[key], budget, depth + 1);
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function copyValue(value, budget, depth) {
  if (!Array.isArray(value) && !isPlainRecord(value)) return copyScalar(value, budget);
  if (depth >= DIAGNOSTIC_LIMITS.depth || exhausted(budget)) return omit(budget);
  return Array.isArray(value) ? copyList(value, budget, depth) : copyRecord(value, budget, depth);
}

/**
 * Copies plain JSON-like data within DIAGNOSTIC_LIMITS and without signing or replay material.
 * Host objects, functions, bigints and non-finite numbers are dropped; oversized values become DIAGNOSTIC_OMITTED.
 * Does not throw for plain data.
 * @returns {unknown} a fresh value whose JSON text is at most DIAGNOSTIC_LIMITS.outputChars long
 */
export function projectDiagnostic(value) {
  return copyValue(value, { chars: DIAGNOSTIC_LIMITS.outputChars - MARKER_RESERVE }, 0);
}

/**
 * Projects a saved purchase operation: only the listed state fields are kept, then the limits apply.
 * @throws {TypeError} when operation is null or undefined
 * @returns {object} a fresh operation without planned requests, bundles to sign, identities or delegations
 */
export function projectDiagnosticOperation(operation) {
  const { state, ...fields } = operation;
  const saved = pick(isPlainRecord(state) ? state : {}, OPERATION_STATE_FIELDS);
  if (isPlainRecord(saved.protocol)) saved.protocol = pick(saved.protocol, PROTOCOL_STATE_FIELDS);
  return projectDiagnostic({ ...fields, state: saved });
}
