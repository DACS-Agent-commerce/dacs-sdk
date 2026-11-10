import { isAbsolute, join, normalize } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { admitRawJson, canonicalize } from '@kynesyslabs/dacs';
import { isPublicEndpoint } from '@kynesyslabs/dacs/wire';
import { buildListingDraft, normalizeDemAmount } from '../dacs/listing.mjs';
import { DEFAULT_SELLER_MAX_JOBS } from '../dacs/seller-durable-state.mjs';
import { sellerApprovalSettings, SELLER_POLICY_DEFAULTS } from '../devnet-demo/operator-approval.mjs';

const CONFIG_MAX_BYTES = 65_536;
const SERVICE_TEXT_MAX_BYTES = 16_384;
const MAX_TAGS = 16, MAX_TAG_LENGTH = 32, MAX_SHORT_TEXT = 200, MAX_DESCRIPTION = 2000;
const MAX_PRICE_SIGNIFICANT_DIGITS = 15, MAX_PORT = 65535;
const LISTING_KEYS = ['listingId', 'displayName', 'title', 'description', 'category', 'tags', 'priceDem', 'deadlineSecAfterCommit'];
const CONFIG_KEYS = ['format', 'dataDirectory', 'keyPath', 'rpcUrl', 'publicOrigin', 'listener', 'directoryOrigin', 'listing', 'service', 'sellerApproval', 'maxRecords', 'maxJobs'];

/**
 * A refused seller.json or Listing: `code` says why, `field` is the key path at
 * fault ('$' for the whole document), `cause` keeps the underlying error and
 * `canonical` (origins only) gives the spelling that would have been accepted.
 */
export class SellerConfigError extends TypeError {
  constructor(code, field, cause, canonical) {
    super(`${code}{${field}}`, cause === undefined ? undefined : { cause });
    this.name = 'SellerConfigError';
    this.code = code;
    this.field = field;
    if (canonical !== undefined) this.canonical = canonical;
  }
}
const fail = (field, cause, code = 'seller_config_invalid', canonical) => {
  throw new SellerConfigError(code, field, cause, canonical);
};
const requireValue = (valid, field) => { if (!valid) fail(field); };
const pathOf = (prefix, key) => prefix ? prefix + '.' + key : key;
function closed(value, keys, prefix, required = keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), prefix || '$');
  for (const key of Object.keys(value)) requireValue(keys.includes(key), pathOf(prefix, key));
  for (const key of required) requireValue(Object.hasOwn(value, key), pathOf(prefix, key));
}
function absolutePath(value, field) {
  requireValue(typeof value === 'string' && isAbsolute(value) && normalize(value) === value && !value.includes('\0'), field);
}
function httpsUrl(value, field) {
  requireValue(typeof value === 'string' && /^https:\/\/[^/\\]/.test(value) && !/[\\\s?#]/.test(value), field);
  let url;
  try { url = new URL(value); } catch (cause) { fail(field, cause); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, field);
  return url;
}
function origin(value, field) {
  const url = httpsUrl(value, field);
  if (!isPublicEndpoint(value) || value !== url.origin) fail(field, undefined, 'seller_config_invalid', url.origin);
}
function positiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value > 0 && value <= maximum, field);
}
function price(value) {
  try {
    if (typeof value === 'number') {
      value = String(value);
      const [coefficient, exponent] = value.split('e-');
      if (exponent !== undefined) value = '0.' + '0'.repeat(Number(exponent) - 1) + coefficient.replace('.', '');
    }
    const result = normalizeDemAmount(value);
    requireValue(BigInt(result.amountOs) <= BigInt(Number.MAX_SAFE_INTEGER), 'listing.priceDem');
    return result.amount;
  } catch (cause) { fail('listing.priceDem', cause); }
}
// Only inspect grammar already checked by raw admission, including when its
// numeric profile refused. Keep exact price digits and attach numeric failures
// to their fields without parsing an inadmissible config into an object.
function checkRawValues(bytes, numericCause) {
  const tokens = new TextDecoder().decode(bytes).match(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[:{},\[\]]/g);
  let index = 0;
  const text = token => {
    const decoded = JSON.parse(token);
    if (decoded.normalize('NFC') !== decoded) fail('$', new TypeError('non-NFC JSON text'));
    return decoded;
  };
  function value(field) {
    const token = tokens[index++];
    if (token === '{' || token === '[') {
      const end = token === '{' ? '}' : ']'; let child = 0;
      while (tokens[index] !== end) {
        const key = token === '{' ? text(tokens[index++]) : String(child++);
        if (token === '{') index += 1; // colon
        value(pathOf(field, key));
        if (tokens[index] === ',') index += 1;
      }
      index += 1; return;
    }
    if (token.startsWith('"')) { text(token); return; }
    if (!/^-?\d/.test(token)) return;
    if (numericCause) assertNumberAdmitted(token, field, numericCause);
    if (field === 'listing.priceDem') requireValue(significantDigits(token) <= MAX_PRICE_SIGNIFICANT_DIGITS, field);
  }
  value('');
}
// A number the profile refused fails at its own field, not at the document.
function assertNumberAdmitted(token, field, numericCause) {
  try { admitRawJson(Buffer.from(token)); } catch { fail(field || '$', numericCause); }
}
const significantDigits = token => token.split(/[eE]/)[0].replace(/[-.]/g, '').replace(/^0+/, '').length;
function listingConfig(value) {
  closed(value, LISTING_KEYS, 'listing');
  for (const [key, maximum] of [['displayName', MAX_SHORT_TEXT], ['title', MAX_SHORT_TEXT], ['description', MAX_DESCRIPTION]]) {
    if (value[key] !== null) requireValue(typeof value[key] === 'string' && value[key].length <= maximum, 'listing.' + key);
  }
  if (value.listingId !== null) requireValue(typeof value.listingId === 'string' && /^(?!\.+$)[A-Za-z0-9._~-]{1,128}$/.test(value.listingId), 'listing.listingId');
  if (value.category !== null) requireValue(typeof value.category === 'string' && value.category.split('.').every(part => part.length > 0), 'listing.category');
  if (value.tags !== null) requireValue(Array.isArray(value.tags) && value.tags.length <= MAX_TAGS && value.tags.every(tag => typeof tag === 'string' && tag.length <= MAX_TAG_LENGTH), 'listing.tags');
  if (value.priceDem !== null) price(value.priceDem);
  if (value.deadlineSecAfterCommit !== null) positiveInteger(value.deadlineSecAfterCommit, 'listing.deadlineSecAfterCommit');
}
function listenerConfig(value) {
  requireValue(value !== null && typeof value === 'object' && ['proxy', 'tls'].includes(value.mode), 'listener.mode');
  closed(value, value.mode === 'proxy' ? ['mode', 'host', 'port'] : ['mode', 'host', 'port', 'certificatePath', 'privateKeyPath'], 'listener');
  if (value.host !== null) requireValue(typeof value.host === 'string' && value.host.length > 0 && !/[\s\0]/.test(value.host)
    && (value.mode === 'tls' || ['127.0.0.1', '::1'].includes(value.host)), 'listener.host');
  if (value.port !== null) positiveInteger(value.port, 'listener.port', MAX_PORT);
  if (value.mode === 'tls') for (const key of ['certificatePath', 'privateKeyPath']) if (value[key] !== null) absolutePath(value[key], 'listener.' + key);
}
function serviceConfig(value) {
  requireValue(value !== null && typeof value === 'object' && ['fixed-text', 'text-module'].includes(value.kind), 'service.kind');
  closed(value, value.kind === 'fixed-text' ? ['kind', 'text'] : ['kind', 'modulePath'], 'service');
  if (value.kind === 'text-module') { if (value.modulePath !== null) absolutePath(value.modulePath, 'service.modulePath'); return; }
  if (value.text !== null) requireValue(typeof value.text === 'string' && value.text.length > 0 && Buffer.byteLength(value.text, 'utf8') <= SERVICE_TEXT_MAX_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value.text), 'service.text');
}
function approvalConfig(value) {
  closed(value, value?.mode === 'manual' ? ['mode'] : ['mode', ...Object.keys(SELLER_POLICY_DEFAULTS)], 'sellerApproval', ['mode']);
  let settings;
  // The kit's settings check names the failing key in its message; that name becomes the refused field.
  try { settings = sellerApprovalSettings(value); }
  catch (cause) { fail(cause.message.match(/sellerApproval(?:\.[A-Za-z]+)?/)?.[0] ?? 'sellerApproval', cause); }
  if (settings.mode === 'policy') requireValue(BigInt(settings.maxWriteTotalOs) <= BigInt(SELLER_POLICY_DEFAULTS.maxWriteTotalOs), 'sellerApproval.maxWriteTotalOs');
  return settings;
}

/** Parses bounded closed seller.json bytes, returning validated settings and capacity defaults; throws field refusals with causes. */
export function parseSellerConfig(bytes) {
  if (nodeTypes.isUint8Array(bytes)) bytes = Buffer.copyBytesFrom(bytes, 0, CONFIG_MAX_BYTES + 1);
  let config;
  try { config = admitRawJson(bytes, { maxBytes: CONFIG_MAX_BYTES }); }
  catch (cause) {
    if (cause.code?.startsWith('NUMBER-')) checkRawValues(bytes, cause);
    fail('$', cause);
  }
  checkRawValues(bytes);
  closed(config, CONFIG_KEYS, '', CONFIG_KEYS.filter(key => key !== 'maxRecords' && key !== 'maxJobs'));
  requireValue(config.format === 'dacs-seller-config/v1', 'format');
  absolutePath(config.dataDirectory, 'dataDirectory');
  absolutePath(config.keyPath, 'keyPath');
  requireValue(config.keyPath === join(config.dataDirectory, 'seller-key.json'), 'keyPath');
  if (config.rpcUrl !== null) httpsUrl(config.rpcUrl, 'rpcUrl');
  for (const key of ['publicOrigin', 'directoryOrigin']) if (config[key] !== null) origin(config[key], key);
  if (config.listener !== null) listenerConfig(config.listener);
  if (config.listing !== null) listingConfig(config.listing);
  if (config.service !== null) serviceConfig(config.service);
  const sellerApproval = config.sellerApproval === null ? null : approvalConfig(config.sellerApproval);
  const capacity = {};
  for (const key of ['maxRecords', 'maxJobs']) {
    capacity[key] = config[key] === undefined ? DEFAULT_SELLER_MAX_JOBS : config[key];
    positiveInteger(capacity[key], key);
  }
  return { ...config, sellerApproval, ...capacity };
}

/** Checks a config against canonical --data-dir before stores or locks open; throws seller_config_directory_mismatch naming the field. */
export function assertConfigBindsDirectory(config, dataDirectory) {
  for (const [field, expected] of [['dataDirectory', dataDirectory], ['keyPath', join(dataDirectory, 'seller-key.json')]]) {
    if (config[field] !== expected) fail(field, undefined, 'seller_config_directory_mismatch');
  }
}

/** Returns canonical-comparable Listing terms from a complete config and seller claim; throws on an invalid price. */
export function listingTermsFromConfig(config, seller) {
  return { seller, ...config.listing, publicEndpoint: config.publicOrigin, priceDem: price(config.listing.priceDem) };
}

/** Returns represented terms, ignoring version/times/signatures; throws listing_terms_unrecognized for non-produced Listing bytes. */
export function listingTermsFromListing(listing) {
  try {
    const terms = { seller: listing.seller.identity.presentedBy, listingId: listing.listingId, publicEndpoint: listing.seller.publicEndpoint,
      displayName: listing.seller.displayName, title: listing.offering.title, description: listing.offering.description,
      category: listing.offering.category, tags: listing.offering.tags, priceDem: price(listing.pricing.price.amount),
      deadlineSecAfterCommit: listing.terms.deadlineSecAfterCommit };
    const rebuilt = buildListingDraft({ ...terms, identityBundle: listing.seller.identity, listingVersion: listing.listingVersion,
      notBefore: listing.validity.notBefore, notAfter: listing.validity.notAfter, expectedSizeBytes: listing.offering.deliverable.expectedSizeBytes });
    const unsigned = { ...listing }; delete unsigned.signature;
    if (canonicalize(rebuilt) !== canonicalize(unsigned)) fail('$', undefined, 'listing_terms_unrecognized');
    return terms;
  } catch (cause) { fail('$', cause, 'listing_terms_unrecognized'); }
}
