import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
// The claim, address and wallet-signature contract the ported seller kit relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import { privateKeyFromSeed, publicKeyFromSeed } from '@kynesyslabs/dacs';
import { addressForClaim, claimForAddress, decodeSignature, normalizeDemosAddress, verifyDemosSignature, isCanonicalEd25519Signature, DemosClaimFormatError } from '../src/dacs/demos-claims.mjs';

const keyHex = () => 'ab'.repeat(32);
const testKeyPair = () => {
  const seed = new Uint8Array(32).fill(7);
  return { privateKey: privateKeyFromSeed(seed), publicKey: publicKeyFromSeed(seed) };
};

test('addresses read case-insensitively with one 0x prefix and are written lower-case', () => {
  const hex = keyHex();
  for (const value of [`0x${hex}`, `0X${hex.toUpperCase()}`, hex, `  0x${hex}\n`]) assert.equal(normalizeDemosAddress(value), `0x${hex}`);
  for (const value of [`0x0x${hex}`, `0x${hex.slice(1)}`, `0x${hex}0`, `0x${hex.slice(1)}g`, '', 42, null]) assert.throws(() => normalizeDemosAddress(value), DemosClaimFormatError);
});

test('claims and addresses convert both ways; claim key digits must be lower-case', () => {
  const hex = keyHex(), claim = `did:demos:agent:${hex}`;
  assert.equal(claimForAddress(`0X${hex.toUpperCase()}`), claim);
  assert.equal(addressForClaim(claim), `0x${hex}`);
  assert.equal(addressForClaim(`DID:demos:agent:${hex}`), `0x${hex}`, 'the did scheme is matched without case');
  for (const value of [`DID:Demos:Agent:${hex}`, `did:DEMOS:AGENT:${hex}`, `did:demos:Agent:${hex}`, `did:demos:agent:${hex.toUpperCase()}`, `did:demos:agent:0x${hex}`, `did:demos:agent:${hex}0`, `did:demos:other:${hex}`, `${claim}\n`, undefined, {}]) {
    assert.throws(() => addressForClaim(value), DemosClaimFormatError);
  }
});

test('signatures decode from canonical base64url first, then from hex or base64url behind 0x prefixes', () => {
  const bytes = Buffer.alloc(64, 0x5a), base64url = bytes.toString('base64url'), hex = bytes.toString('hex');
  for (const value of [base64url, ` ${base64url} `, hex, `0x${hex}`, `0x0x${hex}`, `0X${hex.toUpperCase()}`, `0x${base64url}`]) assert.deepEqual(decodeSignature(value), bytes);
  // A genuine base64url signature may begin with "0x"; it is not stripped.
  const leading = Buffer.from(bytes); leading[0] = 0xd3; leading[1] = (leading[1] & 0x0f) | 0x10;
  assert.ok(leading.toString('base64url').startsWith('0x'));
  assert.deepEqual(decodeSignature(leading.toString('base64url')), leading);
  // A non-canonical final base64url character still names the same 64 bytes.
  const last = base64url.at(-1), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const loose = base64url.slice(0, -1) + alphabet[alphabet.indexOf(last) | 1];
  if (loose !== base64url) assert.deepEqual(decodeSignature(loose), bytes);
  for (const value of [hex.slice(2), `${hex}00`, base64url.slice(1), `${base64url}A`, 'not a signature', 7, null]) assert.throws(() => decodeSignature(value), DemosClaimFormatError);
});

test('a wallet signature verifies over the exact UTF-8 message; anything else is false, never a throw', () => {
  const pair = testKeyPair(), address = `0x${pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')}`;
  const message = 'dacs-bundle-presentation:v1:é', signature = `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}`;
  assert.equal(verifyDemosSignature({ address, message, signature }), true);
  assert.equal(verifyDemosSignature({ address: address.toUpperCase().replace('0X', '0x'), message, signature: Buffer.from(signature.slice(2), 'hex').toString('base64url') }), true);
  const other = `0x${keyHex()}`;
  for (const input of [{ address, message: `${message} `, signature }, { address: other, message, signature }, { address, message, signature: 'bad' }, { address: 'bad', message, signature }, { address, message: undefined, signature }, {}]) {
    assert.equal(verifyDemosSignature(input), false);
  }
});


test('storage addresses hash the exact owner bytes, including case, as demosdk does', () => {
  assert.equal(deriveStorageAddress('0xABCDEF', 'probe', 1, ''), 'stor-26913fea878a28f7ca48cbccd148baa6db47a6f4');
  assert.equal(deriveStorageAddress('0xabcdef', 'probe', 1, ''), 'stor-b52de5b1050c95ef271b53a0d40b5be43717d48c');
});


test('wallet framing preserves a base64url signature beginning with 0x or 0X', () => {
  for (const [first, second] of [[0xd3, 0x10], [0xd1, 0x70]]) {
    const bytes = Buffer.alloc(64, 0x5a); bytes[0] = first; bytes[1] = second;
    const encoded = bytes.toString('base64url');
    assert.match(encoded, /^0[xX]/);
    for (const prefix of ['', '0x', '0X', '0x0X']) assert.deepEqual(decodeSignature(prefix + encoded), bytes);
  }
});

test('advisory claim parameters preserve the resolved address and require canonical spelling', () => {
  const hex = 'ab'.repeat(32), claim = `did:demos:agent:${hex}`;
  for (const suffix of ['?unknown=value', '?jurisdiction=GB&unknown=value']) assert.equal(addressForClaim(claim + suffix), `0x${hex}`);
  for (const suffix of ['?z=1&a=2', '?x=%41', '?x=1&x=2']) assert.throws(() => addressForClaim(claim + suffix), DemosClaimFormatError);
});

test('missing or null signature verification arguments are malformed, without throwing', () => {
  assert.equal(verifyDemosSignature(), false);
  assert.equal(verifyDemosSignature(null), false);
});

test('small-order public keys cannot authorize either of two messages with a constant forgery', () => {
  const signature = Buffer.from('01' + '00'.repeat(63), 'hex').toString('base64url');
  const points = [
    '00'.repeat(32), '01' + '00'.repeat(31), 'ec' + 'ff'.repeat(30) + '7f',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    'ed' + 'ff'.repeat(30) + '7f', 'ee' + 'ff'.repeat(30) + '7f',
  ];
  for (const point of points) for (const signBit of [0, 128]) {
    const key = Buffer.from(point, 'hex'); key[31] |= signBit;
    for (const message of ['authorize payment A', 'authorize payment B']) {
      assert.equal(verifyDemosSignature({ address: `0x${key.toString('hex')}`, message, signature }), false, `${point}: ${message}`);
    }
  }
});

test('the strict DACS signature predicate accepts only canonical 64-byte base64url', () => {
  const bytes = Buffer.alloc(64, 0xfb), value = bytes.toString('base64url');
  assert.equal(isCanonicalEd25519Signature(value), true);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const residual = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)) | 1];
  for (const bad of [residual, value + '==', ` ${value}`, value + '\n', bytes.toString('base64'), bytes.toString('hex'), value.slice(1), value + 'A', null, 4]) assert.equal(isCanonicalEd25519Signature(bad), false);
});

test('CREATE payload binds the exact artifact, logical address and public zero-spend operation', () => {
  const from = `0x${'ab'.repeat(32)}`, programName = 'TEST-program', nonce = 3;
  const storageAddress = deriveStorageAddress(from, programName, nonce), signedListing = { TEST: 'artifact' };
  const payload = buildStorageProgramCreatePayload({ from, storageAddress, programName, logicalAddress: 'TEST-logical', signedListing, nonce, timestamp: 42 });
  assert.deepEqual(payload, { content: { type: 'storageProgram', from, to: storageAddress, amount: 0,
    data: ['storageProgram', { operation: 'CREATE_STORAGE_PROGRAM', storageAddress, programName, encoding: 'json', data: signedListing,
      metadata: { logicalAddress: 'TEST-logical' }, acl: { mode: 'public' }, salt: '', storageLocation: 'onchain' }],
    nonce, timestamp: 42, transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null } },
    signature: null, hash: '', status: '', blockNumber: null });
  assert.deepEqual(payload.content.data[1].data, signedListing);
  payload.content.transaction_fee.network_fee = 1;
  assert.equal(buildStorageProgramCreatePayload(validCreate()).content.transaction_fee.network_fee, 0);
});


test('non-string messages never verify even when their decoded bytes were signed', () => {
  const pair = testKeyPair();
  const address = `0x${pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')}`;
  const signature = sign(null, Buffer.from([255]), pair.privateKey).toString('base64url');
  for (const message of [[255], { type: 'Buffer', data: [255] }, Buffer.from([255])]) {
    assert.equal(verifyDemosSignature({ address, message, signature }), false);
  }
});

const validCreate = (salt = '') => {
  const from = `0x${'ab'.repeat(32)}`, programName = 'TEST-program', nonce = 7;
  return { from, programName, nonce, salt, storageAddress: deriveStorageAddress(from, programName, nonce, salt),
    logicalAddress: 'TEST-logical', signedListing: { TEST: 'artifact' }, timestamp: 42 };
};

test('CREATE retains the salt that derives its requested storage address', () => {
  const input = validCreate('extra');
  const operation = buildStorageProgramCreatePayload(input).content.data[1];
  assert.equal(operation.salt, input.salt);
  assert.equal(deriveStorageAddress(input.from, operation.programName, input.nonce, operation.salt), operation.storageAddress);
});

test('CREATE refuses missing and malformed write inputs before exposing a wallet payload', () => {
  assert.throws(() => buildStorageProgramCreatePayload({}), TypeError);
  for (const change of [
    { from: undefined }, { from: 'invalid' }, { programName: '' }, { programName: 'bad:name' },
    { nonce: undefined }, { nonce: -1 }, { nonce: 1.5 }, { nonce: Number.MAX_SAFE_INTEGER + 1 },
    { timestamp: undefined }, { timestamp: -1 }, { timestamp: NaN }, { logicalAddress: '' },
    { logicalAddress: 7 }, { signedListing: undefined }, { signedListing: null }, { signedListing: [] },
    { storageAddress: deriveStorageAddress(validCreate().from, 'other', 7) }, { salt: 7 },
  ]) assert.throws(() => buildStorageProgramCreatePayload({ ...validCreate(), ...change }), TypeError);
});

const createInput = (signedListing) => {
  const from = `0x${'ab'.repeat(32)}`, programName = 'TEST-bounded-artifact', nonce = 1;
  return { from, programName, nonce, timestamp: 42, logicalAddress: 'TEST-logical', signedListing,
    storageAddress: deriveStorageAddress(from, programName, nonce) };
};

test('signature verification refuses lone surrogates rather than verifying replacement bytes', () => {
  const pair = testKeyPair();
  const address = `0x${pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')}`;
  const message = 'pay-to:\ufffd';
  const signature = sign(null, Buffer.from(message), pair.privateKey).toString('base64url');
  assert.equal(verifyDemosSignature({ address, message, signature }), true);
  for (const surrogate of ['\ud800', '\udfff']) {
    assert.equal(verifyDemosSignature({ address, message: `pay-to:${surrogate}`, signature }), false);
  }
});

test('CREATE snapshots the canonical artifact before caller mutations', () => {
  const signedListing = { listingId: 'before', offering: { text: 'original' }, tags: ['first'] };
  const expected = structuredClone(signedListing);
  const payload = buildStorageProgramCreatePayload(createInput(signedListing));
  signedListing.listingId = 'after'; signedListing.offering.text = 'changed'; signedListing.tags.push('later');
  assert.deepEqual(payload.content.data[1].data, expected);
  assert.notEqual(payload.content.data[1].data, signedListing);
});

test('CREATE enforces the 16,384-byte canonical listing boundary including UTF-8 expansion', () => {
  const capacity = 16_384 - Buffer.byteLength(JSON.stringify({ text: '' }));
  const listing = { text: 'é'.repeat(Math.floor(capacity / 2)) + 'x'.repeat(capacity % 2) };
  assert.equal(Buffer.byteLength(JSON.stringify(listing)), 16_384);
  assert.doesNotThrow(() => buildStorageProgramCreatePayload(createInput(listing)));
  listing.text += 'x';
  assert.throws(() => buildStorageProgramCreatePayload(createInput(listing)), /size|byte|large/i);
});

test('CREATE enforces the Demos storage 64-level JSON nesting boundary', () => {
  const nested = (levels) => {
    let value = {};
    for (let level = 1; level < levels; level++) value = { child: value };
    return value;
  };
  assert.doesNotThrow(() => buildStorageProgramCreatePayload(createInput(nested(64))));
  assert.throws(() => buildStorageProgramCreatePayload(createInput(nested(65))), /depth|nest/i);
});

for (const [label, make] of [
  ['bigint', () => ({ amount: 1n })], ['NaN', () => ({ amount: NaN })],
  ['infinity', () => ({ amount: Infinity })],
  ['cycle', () => { const value = {}; value.self = value; return value; }],
  ['accessor', () => Object.defineProperty({}, 'amount', { enumerable: true, get() { throw new Error('TEST accessor'); } })],
]) test(`CREATE refuses non-JSON artifact values: ${label}`, () => {
  assert.throws(() => buildStorageProgramCreatePayload(createInput(make())));
});

// The seller runner enables the VM isolation API (anchor-isolated-fixture.mjs) on both supported Node versions.
test('CI runs every seller Node regression file with VM isolation and serial execution', async () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /run: npm run seller:test(?:\s|$)/);
  const manifest=JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8'));
  assert.equal(manifest.scripts['seller:test'],'node scripts/run-seller-tests.mjs');
  const runnerUrl=new URL('../../../scripts/run-seller-tests.mjs',import.meta.url);
  const context=vm.createContext({URL,process:{argv:[],execPath:process.execPath,exitCode:null}});
  let invoked;
  const imports={'node:fs':{readdirSync},'node:url':{fileURLToPath},'node:child_process':{spawnSync:(...args)=>{invoked=args;return{status:0};}}};
  const runner=new vm.SourceTextModule(readFileSync(runnerUrl,'utf8'),{context,initializeImportMeta:meta=>{meta.url=runnerUrl.href;}});
  await runner.link(specifier=>{const values=imports[specifier];assert.ok(values,`expected runner import ${specifier}`);return new vm.SyntheticModule(Object.keys(values),function(){for(const [name,value]of Object.entries(values))this.setExport(name,value);},{context});});
  await runner.evaluate();
  assert.equal(invoked[0],process.execPath);
  const args=Array.from(invoked[1]);
  for(const flag of ['--experimental-vm-modules','--test','--test-concurrency=1'])assert.ok(args.includes(flag),flag);
  const files=readdirSync(new URL('./',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'packages/dacs-seller/test/'+name);
  assert.deepEqual(args.filter(arg=>arg.endsWith('.test.mjs')),files);
  assert.equal(invoked[2].cwd,fileURLToPath(new URL('../../../',import.meta.url)));
});
