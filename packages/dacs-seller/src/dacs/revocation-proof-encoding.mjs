// The two JSON encodings a Demos node hashes in storage and finality proofs. Storage records are hashed over the
// node's canonical JSON (sorted keys, no Unicode normalization, any finite number); validator sets are hashed over
// its JCS form (RFC 8785 with string values NFC-normalized and only safe integers). Both throw a fixed short message
// for a value the node refuses.

const CANONICAL_JSON_UNSUPPORTED = 'canonical_json_unsupported';
const JCS_UNSUPPORTED = 'jcs_unsupported';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedKeys = (object) => Object.keys(object).sort(byCodeUnits);

/** Canonical JSON text of `value`, or undefined for a member value JSON leaves out. */
function canonicalText(value, ancestors) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
      return JSON.stringify(value);
    case 'object':
      break;
    case 'bigint':
      throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
    default:
      return undefined;
  }
  if (ancestors.includes(value)) throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
  ancestors.push(value);
  let text;
  if (Array.isArray(value)) {
    text = `[${Array.from(value, (item) => canonicalText(item, ancestors) ?? 'null').join(',')}]`;
  } else {
    const members = [];
    for (const key of sortedKeys(value)) {
      const member = canonicalText(value[key], ancestors);
      if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
    }
    text = `{${members.join(',')}}`;
  }
  ancestors.pop();
  return text;
}

/**
 * The node's canonical JSON of a storage record or other JSON value: object keys sorted by UTF-16 code units, arrays
 * in order, strings and numbers as `JSON.stringify` spells them, with no Unicode normalization.
 * @returns {string}
 * @throws {TypeError} `canonical_json_unsupported` for a non-finite number, a bigint, a cycle, or a top-level value
 * with no JSON form (undefined, a function, a symbol).
 */
export function nodeCanonicalJson(value) {
  const text = canonicalText(value, []);
  if (text === undefined) throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
  return text;
}

function jcsText(value, ancestors) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(JCS_UNSUPPORTED);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(JCS_UNSUPPORTED);
  }
  const prototype = Object.getPrototypeOf(value);
  const plain = Array.isArray(value) || prototype === Object.prototype || prototype === null;
  if (!plain || ancestors.includes(value)) throw new TypeError(JCS_UNSUPPORTED);
  ancestors.push(value);
  const text = Array.isArray(value)
    ? `[${value.map((item) => jcsText(item, ancestors)).join(',')}]`
    : `{${sortedKeys(value).map((key) => `${JSON.stringify(key)}:${jcsText(value[key], ancestors)}`).join(',')}}`;
  ancestors.pop();
  return text;
}

/**
 * The node's JCS text of a JSON value: RFC 8785 key order (UTF-16 code units, keys as received), string values
 * NFC-normalized, and only safe integers as numbers.
 * @returns {string}
 * @throws {TypeError} `jcs_unsupported` for a fraction, an integer outside the safe range, a non-finite number, a
 * bigint, undefined, a function, a symbol, a non-plain object or a cycle.
 */
export function nodeJcs(value) {
  return jcsText(value, []);
}
