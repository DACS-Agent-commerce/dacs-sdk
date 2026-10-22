// Pure payload identity and confirmation-shape helpers. No provider, key,
// transport or portal dependency. Algorithms retained from the wallet provider.
export class EmbeddedWalletError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function sha256HexOfText(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function anchorJson(value, depth = 0, ancestors = new Set()) {
  const invalid = () => { throw new EmbeddedWalletError('invalid_params', 'the anchor must be bounded plain canonical JSON'); };
  const string = (v, normalize) => {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) invalid();
    return JSON.stringify(normalize ? v.normalize('NFC') : v);
  };
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return string(value, true);
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || depth >= 64 || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) && !(Object.getPrototypeOf(value) === null && !array)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== 'string' || (!(array && k === 'length') && (!Object.getOwnPropertyDescriptor(value, k)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, k)))))) invalid();
  ancestors.add(value);
  let result;
  if (array) {
    if (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)) invalid();
    result = `[${value.map((v) => anchorJson(v, depth + 1, ancestors)).join(',')}]`;
  } else {
    result = `{${keys.sort().map((k) => `${string(k, false)}:${anchorJson(value[k], depth + 1, ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The identity of one prepared native transfer, shared with the operator's
// source (devnet-native-transport.mjs): the SHA-256 of the canonical JSON of
// every field Demos.sign keeps when the prepared amount encoding matches
// the connected node fork (type, from, to, amount, data,
// nonce, timestamp; it fills the fee, balance edits, hash and signature), so
// the signed transaction carries the same digest as its payload.
export async function nativePayloadDigest(content) {
  const address = (v) => (typeof v === 'string' ? `0x${v.toLowerCase().replace(/^0x/, '')}` : null);
  return sha256HexOfText(anchorJson({ type: content?.type ?? null, from: address(content?.from), to: address(content?.to), amount: content?.amount ?? null,
    data: content?.data ?? null, nonce: content?.nonce ?? null, timestamp: content?.timestamp ?? null }));
}

const hasKeys = (value, keys) => isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

// Shared by the original wallet approval and server-side identical recovery.
export function storageConfirmationShapeMatches(data) {
  return hasKeys(data?.transaction, ['content', 'signature', 'hash', 'status', 'blockNumber'])
    && Object.keys(data).every((k) => ['valid', 'reference_block', 'message', 'gas_operation', 'transaction', 'custom_charges'].includes(k))
    && data.custom_charges == null
    && (data.gas_operation == null || (hasKeys(data.gas_operation, ['fees'])
      && hasKeys(data.gas_operation.fees, ['network_fee', 'rpc_fee', 'additional_fee'])));
}
