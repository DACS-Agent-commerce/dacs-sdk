import { admitRawJson } from '@kynesyslabs/dacs';

/** Resolve a provider within fixed read limits; throws its error or resolver-timeout.
 * The provider receives a cancellation signal, aborted on every exit. */
export async function resolveWithDeadline(provider, limits) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('resolver-timeout'));
      controller.abort();
    }, limits.timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('resolver-timeout');
        return provider({ ...limits, signal: controller.signal });
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Copy a JSON reply under byte, value, depth and list limits before canonicalization.
 * Raw replies are capped before decoding. Throws on oversized or non-JSON data. */
export function boundedResolutionValue(reply, limits) {
  if (reply instanceof Uint8Array) {
    if (reply.byteLength > limits.maxBytes) throw new RangeError('resolver reply exceeds byte limit');
    reply = admitRawJson(reply, { maxBytes: limits.maxBytes });
  }
  let bytes = 0, values = 0;
  const ancestors = new Set();
  const charge = count => {
    bytes += count;
    if (bytes > limits.maxBytes) throw new RangeError('resolver reply exceeds byte limit');
  };
  const textBytes = text => {
    if (text.length > limits.maxBytes - bytes) throw new RangeError('resolver reply exceeds byte limit');
    charge(Buffer.byteLength(JSON.stringify(text)));
  };
  const copy = (value, depth) => {
    if (++values > limits.maxValues) throw new RangeError('resolver reply exceeds value limit');
    if (depth > limits.maxDepth) throw new RangeError('resolver reply exceeds depth limit');
    if (typeof value === 'string') { textBytes(value); return value; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      charge(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (value === null || typeof value !== 'object' || ancestors.has(value)) throw new TypeError('resolver reply must be acyclic JSON data');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError('resolver reply must contain plain JSON data');
    if (array && value.length > limits.maxListEntries) throw new RangeError('resolver reply exceeds list limit');
    const keys = Reflect.ownKeys(value).filter(key => !array || key !== 'length');
    if (keys.length > limits.maxValues - values) throw new RangeError('resolver reply exceeds value limit');
    if (array && keys.length !== value.length) throw new TypeError('resolver reply must contain dense JSON data');
    const result = array ? [] : Object.create(null);
    ancestors.add(value);
    charge(2);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index], descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor) || (array && key !== String(index))) throw new TypeError('resolver reply must contain enumerable JSON data');
      if (index) charge(1);
      if (!array) { textBytes(key); charge(1); }
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return result;
  };
  return copy(reply, 1);
}
