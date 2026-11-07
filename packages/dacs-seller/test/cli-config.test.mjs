import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { buildListingDraft } from '../src/dacs/listing.mjs';
import { SELLER_POLICY_DEFAULTS } from '../src/devnet-demo/operator-approval.mjs';

const load = () => import('../src/cli/config.mjs');
const bytes = value => Buffer.from(JSON.stringify(value));
const config = () => ({
  format: 'dacs-seller-config/v1', dataDirectory: '/TEST-seller', keyPath: '/TEST-seller/seller-key.json',
  rpcUrl: 'https://rpc.example.invalid/rpc', publicOrigin: 'https://seller.example.invalid',
  listener: { mode: 'proxy', host: '127.0.0.1', port: 8080 }, directoryOrigin: null,
  listing: { listingId: 'TEST-listing', displayName: 'TEST seller', title: 'TEST text', description: 'TEST description',
    category: 'test.text', tags: ['test'], priceDem: '1.00', deadlineSecAfterCommit: 3600 },
  service: { kind: 'fixed-text', text: 'TEST response' }, sellerApproval: { mode: 'policy' },
});
function set(value, path, replacement) {
  const parts = path.split('.'), key = parts.pop();
  parts.reduce((at, part) => at[part], value)[key] = replacement;
  return value;
}
const fieldError = (field, code = 'seller_config_invalid') => error => {
  assert.equal(error.code, code);
  assert.equal(error.field, field);
  assert.ok(error.message.includes(field));
  return true;
};

test('seller.json refuses unknown keys at every level and names the key path', async () => {
  const { parseSellerConfig } = await load();
  for (const field of ['unknown', 'listener.unknown', 'listing.unknown', 'service.unknown', 'sellerApproval.unknown', '__proto__']) {
    const value = config();
    const parent = field.includes('.') ? value[field.split('.')[0]] : value;
    Object.defineProperty(parent, field.split('.').at(-1), { value: true, enumerable: true });
    assert.throws(() => parseSellerConfig(bytes(value)), fieldError(field));
  }
  for (const [field, replacement] of [['listener', { mode: 'tls', host: '::', port: 443, certificatePath: '/TEST-cert', privateKeyPath: '/TEST-key', extra: true }],
    ['service', { kind: 'text-module', modulePath: '/TEST-service.mjs', extra: true }]]) {
    assert.throws(() => parseSellerConfig(bytes(set(config(), field, replacement))), fieldError(field + '.extra'));
  }
  assert.throws(() => parseSellerConfig(bytes(set(config(), 'sellerApproval', { mode: 'manual', maxWriteTotalOs: '1' }))), fieldError('sellerApproval.maxWriteTotalOs'));
  for (const field of Object.keys(config())) {
    const value = config(); delete value[field];
    assert.throws(() => parseSellerConfig(bytes(value)), fieldError(field));
  }
});

test('seller.json refuses relative paths and a keyPath other than <dataDirectory>/seller-key.json', async () => {
  const { parseSellerConfig } = await load();
  for (const [field, value] of [['dataDirectory', 'TEST-relative'], ['dataDirectory', '/TEST/../TEST-seller'],
    ['keyPath', 'seller-key.json'], ['keyPath', '/TEST-seller/other.json'], ['keyPath', '/TEST-other/seller-key.json']]) {
    assert.throws(() => parseSellerConfig(bytes(set(config(), field, value))), fieldError(field));
  }
  for (const field of ['certificatePath', 'privateKeyPath']) {
    const value = config(); value.listener = { mode: 'tls', host: '::', port: 443, certificatePath: '/TEST-cert', privateKeyPath: '/TEST-key', [field]: 'relative' };
    assert.throws(() => parseSellerConfig(bytes(value)), fieldError('listener.' + field));
  }
  assert.throws(() => parseSellerConfig(bytes(set(config(), 'service', { kind: 'text-module', modulePath: './TEST.mjs' }))), fieldError('service.modulePath'));
});

test('publicOrigin must be the canonical https origin the wire accepts', async () => {
  const { parseSellerConfig } = await load();
  const origin = config().publicOrigin;
  assert.equal(parseSellerConfig(bytes(config())).publicOrigin, origin); // K13-E1
  const refused = [origin + '/', 'https://SELLER.example.invalid', origin + ':443', origin + '/path', origin + '?a=1', origin + '#f',
    'https://user@ seller.example.invalid'.replace(' ', ''), 'http://seller.example.invalid', 'https:seller.example.invalid', origin + ' ', origin + '\\', origin + '//'];
  for (const value of refused) {
    for (const field of ['publicOrigin', 'directoryOrigin']) {
      assert.throws(() => parseSellerConfig(bytes(set(config(), field, value))), fieldError(field));
    }
  }
  assert.equal(parseSellerConfig(bytes(set(config(), 'directoryOrigin', origin))).directoryOrigin, origin);
  assert.throws(() => parseSellerConfig(bytes(set(config(), 'publicOrigin', origin + '/'))), error => {
    assert.equal(error.canonical, origin); return true;
  });
});

test("Listing terms outside the TP-1 limits are refused: price, tags, text sizes, deadline and service kind; a `priceDem` JSON number with more than 15 significant digits is refused, and '9007199.254740991' is accepted (as 9007199254740991 OS) while '9007199.254740992' is refused, each refusal naming the field", async () => {
  const { parseSellerConfig, listingTermsFromConfig } = await load();
  const cases = [
    ['listing.priceDem', '0'], ['listing.priceDem', '-1'], ['listing.priceDem', '0.0000000001'], ['listing.priceDem', '9007199.254740992'],
    ['listing.priceDem', 9007199254740992], ['listing.priceDem', true],
    ['listing.tags', Array(17).fill('tag')], ['listing.tags', ['a'.repeat(33)]], ['listing.tags', [1]],
    ['listing.displayName', 'a'.repeat(201)], ['listing.title', 'a'.repeat(201)], ['listing.description', 'a'.repeat(2001)],
    ['listing.category', 'a..b'], ['listing.listingId', '..'], ['listing.listingId', '../path'], ['listing.listingId', 'a'.repeat(129)],
    ['listing.deadlineSecAfterCommit', 0], ['listing.deadlineSecAfterCommit', -1], ['listing.deadlineSecAfterCommit', 1.5],
    ['listing.deadlineSecAfterCommit', Number.MAX_SAFE_INTEGER + 1], ['service.kind', 'shell'], ['service.text', 'é'.repeat(8193)],
    ['service.text', ''], ['service.text', 'TEST\u0000'],
  ];
  for (const [field, replacement] of cases) assert.throws(() => parseSellerConfig(bytes(set(config(), field, replacement))), fieldError(field));
  for (const literal of ['1.0000000000000001', '1.1234567890123456', '1e999']) {
    const raw = JSON.stringify(config()).replace('"priceDem":"1.00"', '"priceDem":' + literal);
    assert.throws(() => parseSellerConfig(Buffer.from(raw)), fieldError('listing.priceDem'));
    assert.throws(() => parseSellerConfig(Buffer.from(raw.replace('priceDem', 'price\\u0044em'))), fieldError('listing.priceDem'));
  }
  const valid = set(config(), 'listing.priceDem', '9007199.254740991');
  assert.equal(listingTermsFromConfig(parseSellerConfig(bytes(valid)), 'TEST-seller').priceDem, '9007199.254740991');
  for (const replacement of [1, 0.000000001, '0.000000001']) assert.doesNotThrow(() => parseSellerConfig(bytes(set(config(), 'listing.priceDem', replacement))));
  const boundary = config(); Object.assign(boundary.listing, { displayName: 'a'.repeat(200), title: 'a'.repeat(200), description: 'a'.repeat(2000), tags: Array(16).fill('a'.repeat(32)) });
  boundary.service.text = 'é'.repeat(8192);
  assert.doesNotThrow(() => parseSellerConfig(bytes(boundary)));
});

test('sellerApproval.maxWriteTotalOs above the kit default is refused; equal and lower values are accepted', async () => {
  const { parseSellerConfig } = await load();
  const cap = BigInt(SELLER_POLICY_DEFAULTS.maxWriteTotalOs);
  for (const maxWriteTotalOs of [String(cap), String(cap - 1n), '1']) {
    assert.equal(parseSellerConfig(bytes(set(config(), 'sellerApproval.maxWriteTotalOs', maxWriteTotalOs))).sellerApproval.maxWriteTotalOs, maxWriteTotalOs);
  }
  assert.throws(() => parseSellerConfig(bytes(set(config(), 'sellerApproval.maxWriteTotalOs', String(cap + 1n)))), fieldError('sellerApproval.maxWriteTotalOs'));
  for (const [field, value] of [['maxWriteTotalOs', 1], ['maxWriteTotalOs', '01'], ['maxWritesPerHour', 1001], ['maxTotalOsPerHour', '1']]) {
    assert.throws(() => parseSellerConfig(bytes(set(config(), 'sellerApproval.' + field, value))), fieldError('sellerApproval.' + field));
  }
  assert.deepEqual(parseSellerConfig(bytes(set(config(), 'sellerApproval', { mode: 'manual' }))).sellerApproval, { mode: 'manual' });
});

test('seller.json larger than 64 KiB, with duplicate members, lone surrogates or non-NFC text is refused before parsing', async () => {
  const { parseSellerConfig } = await load();
  const exact = Buffer.from(JSON.stringify(config()).padEnd(65536, ' '));
  assert.doesNotThrow(() => parseSellerConfig(exact));
  for (const value of [Buffer.concat([exact, Buffer.from(' ')]), Buffer.from('{"x":1,"x":2}'), Buffer.from('{"x":"\\ud800"}'),
    Buffer.from('{"x":"e\\u0301"}'), Buffer.from([0xff]), Buffer.from('{')]) {
    assert.throws(() => parseSellerConfig(value), error => {
      assert.equal(error.code, 'seller_config_invalid'); assert.equal(error.field, '$'); assert.ok(error.cause); return true;
    });
  }
});

test('assertConfigBindsDirectory refuses a seller.json naming another data directory or another key path', async () => {
  const { assertConfigBindsDirectory } = await load();
  assert.doesNotThrow(() => assertConfigBindsDirectory(config(), '/TEST-seller'));
  for (const field of ['dataDirectory', 'keyPath']) {
    const value = set(config(), field, field === 'keyPath' ? '/TEST-other/seller-key.json' : '/TEST-other');
    assert.throws(() => assertConfigBindsDirectory(value, '/TEST-seller'), fieldError(field, 'seller_config_directory_mismatch'));
  }
});

test('the terms projection is equal for a draft built from the config, differs when any represented term changes, ignores times, version and signatures, and refuses an unrecognized Listing member', async () => {
  const { listingTermsFromConfig, listingTermsFromListing } = await load();
  const value = config(), seller = 'did:demos:agent:' + '12'.repeat(32);
  const identityBundle = { bundleVersion: '1', presentedBy: seller, presentedAt: 1000, claims: [{ ref: seller }], presentation: { kind: 'per-claim', signatures: [{ ref: seller, signature: 'TEST-signature' }] } };
  const draft = buildListingDraft({ ...value.listing, identityBundle, publicEndpoint: value.publicOrigin, listingVersion: 1, notBefore: 1000, notAfter: 2000 });
  const expected = listingTermsFromConfig(value, seller);
  assert.equal(canonicalize(listingTermsFromListing(draft)), canonicalize(expected));
  const changes = { 'seller.identity.presentedBy': 'did:demos:agent:' + '34'.repeat(32), listingId: 'TEST-another',
    'seller.publicEndpoint': 'https://other.example.invalid', 'seller.displayName': 'Another', 'offering.title': 'Another',
    'offering.description': 'Another', 'offering.category': 'test.other', 'offering.tags': ['other'], 'pricing.price.amount': '2', 'terms.deadlineSecAfterCommit': 42 };
  for (const [field, replacement] of Object.entries(changes)) {
    const changed = set(structuredClone(draft), field, replacement);
    if (field.endsWith('presentedBy')) changed.seller.identity.claims = [{ ref: replacement }];
    assert.notEqual(canonicalize(listingTermsFromListing(changed)), canonicalize(expected), field);
  }
  const changed = structuredClone(draft);
  changed.listingVersion = 2; changed.validity = { notBefore: 2000 }; changed.seller.identity.presentedAt = 2000;
  changed.seller.identity.presentation.signatures[0].signature = 'TEST-another'; changed.signature = { value: 'TEST-listing-signature' };
  assert.deepEqual(listingTermsFromListing(changed), expected);
  for (const [field, replacement] of [['extra', true], ['seller.extra', true], ['offering.extra', true], ['pricing.price.extra', true],
    ['terms.extra', true], ['validity.extra', true], ['pipeline.0.extra', true], ['offering.deliverable.kind', 'other']]) {
    assert.throws(() => listingTermsFromListing(set(structuredClone(draft), field, replacement)), error => error.code === 'listing_terms_unrecognized', field);
  }
  const sized = buildListingDraft({ ...value.listing, identityBundle, publicEndpoint: value.publicOrigin, listingVersion: 1, notBefore: 1000, expectedSizeBytes: 12 });
  assert.deepEqual(listingTermsFromListing(sized), expected);
});

test('seller.json validates RPC URLs, listeners and capacity defaults', async () => {
  const { parseSellerConfig } = await load();
  const parsed = parseSellerConfig(bytes(config()));
  assert.equal(parsed.maxRecords, 10000); assert.equal(parsed.maxJobs, 10000);
  for (const url of ['http://rpc.invalid', 'https://user@rpc.invalid', 'https://rpc.invalid/?x', 'https://rpc.invalid/#', 'https:rpc.invalid']) {
    assert.throws(() => parseSellerConfig(bytes(set(config(), 'rpcUrl', url))), fieldError('rpcUrl'));
  }
  for (const [field, replacement] of [['listener.host', '0.0.0.0'], ['listener.port', 0], ['listener.port', 65536],
    ['listener.port', 1.5], ['listener.mode', 'http'], ['maxRecords', 0], ['maxJobs', 1.5], ['maxRecords', Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => parseSellerConfig(bytes(set(config(), field, replacement))), fieldError(field));
  }
  const tls = config(); tls.listener = { mode: 'tls', host: '::', port: 443, certificatePath: '/TEST-cert', privateKeyPath: '/TEST-key' };
  tls.service = { kind: 'text-module', modulePath: '/TEST-service.mjs' };
  assert.doesNotThrow(() => parseSellerConfig(bytes(tls)));
  assert.doesNotThrow(() => parseSellerConfig(bytes(set(config(), 'listener.host', '::1'))));
});

test('seller.json accepts unset operator fields for init', async () => {
  const { parseSellerConfig } = await load();
  const value = config();
  for (const field of ['rpcUrl', 'publicOrigin', 'listener', 'listing', 'service', 'sellerApproval']) value[field] = null;
  assert.deepEqual(parseSellerConfig(bytes(value)), { ...value, maxJobs: 10000, maxRecords: 10000 });
  const partial = config(); for (const field of Object.keys(partial.listing)) partial.listing[field] = null;
  assert.doesNotThrow(() => parseSellerConfig(bytes(partial)));
});

test('init\'s output parses, and every use refuses it with seller_config_incomplete naming each unset field', async t => {
  const { parseSellerConfig, assertSellerConfigComplete } = await load();
  const { runInit } = await import('../src/cli/init.mjs');
  const { identityDouble } = await import('./helpers/init-identity-fixture.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDirectory = join(root, 'seller');
  await runInit({ dataDirectory, identity: identityDouble(), stdout: { write() {} } });
  const initial = parseSellerConfig(readFileSync(join(dataDirectory, 'seller.json')));
  const unset = ['rpcUrl', 'publicOrigin', 'listener', 'listing', 'service', 'sellerApproval'];
  assert.throws(() => assertSellerConfigComplete(initial), fieldError(unset.join(','), 'seller_config_incomplete'));
  const complete = parseSellerConfig(bytes(config()));
  assert.equal(complete.directoryOrigin, null);
  assert.doesNotThrow(() => assertSellerConfigComplete(complete));
  assert.throws(() => assertSellerConfigComplete(parseSellerConfig(bytes(set(config(), 'listing.title', null)))), fieldError('listing.title', 'seller_config_incomplete'));
});
