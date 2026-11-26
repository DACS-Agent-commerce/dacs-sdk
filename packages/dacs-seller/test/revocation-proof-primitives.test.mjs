// The stored node storage-proof vectors and the two primitives checked against them: the node encoders and the
// one-address storage path check. Every proof here is node output written by vectors/generate-revocation-proof-vectors.mjs
// and checked by the node's own verifier when it was written; nothing in this file builds a positive proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeAddressSegment, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { addressForClaim } from '../src/dacs/demos-claims.mjs';
import { deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { nodeCanonicalJson, nodeJcs } from '../src/dacs/revocation-proof-encoding.mjs';
import { verifyRevocationStorage } from '../src/dacs/revocation-proof-storage.mjs';

const vectorUrl = (name) => new URL(`./vectors/${name}`, import.meta.url);
const fileBytes = readFileSync(vectorUrl('revocation-proof-node.json'));
const fileText = fileBytes.toString('utf8');
const stored = JSON.parse(fileText);
const manifest = JSON.parse(readFileSync(vectorUrl('revocation-proof-node.manifest.json'), 'utf8'));

const NODE_COMMIT = 'a98cad194c5a41c3af9867371dee037609709253';
const COMMAND = 'bun run test/dacs-revocation-vectors.tmp.mjs --output ../sdk/packages/dacs-seller/test/vectors/revocation-proof-node.json';
const SOURCE_DIGESTS = {
  'src/libs/blockchain/finality/verify.test.ts': 'fa88260886d68cb2fd83341aa63d70f5d5fb8f656e7d179cda263df07390d237',
  'src/libs/blockchain/finality/storageRoot.test.ts': 'ba2883bcca2ba361efc8c531bea4ea73f1d6cf785276402600ea33522420497a',
  'src/libs/blockchain/finality/requesterFixtures.test.ts': '3b738a1d6a8babb452a7d4bcc00c83cb9f2728a75421437637ec358f13a2aa25',
  'src/libs/crypto/merkle/sparse.test.ts': '95514992e34ef71190d6db769c4bc0021f64ff76d48fcbc2f370771f44a146bb',
  'src/libs/blockchain/finality/__fixtures__/requester-1059-1060/MANIFEST.json': 'f6cb9588b3d271867d6c3ebce05dd989b040cb6116de7a9727158dd819265e87',
  'src/libs/consensus/v2/quorum.ts': 'db71b13474c6618c3c975c9353ad9c0fdcaea9710c6df62cdc141c1fb9bd1472',
  'src/libs/consensus/v2/commitLock/messages.ts': '1b9864116da73a787b15afe17d780fe0179cbb505f6aa1f8e4563db450bfc615',
  'src/libs/consensus/v2/routines/poolRules.ts': '20661277fe9b89ecf72e3f043069c80f4e334af461727283588045e653578483',
  'src/libs/blockchain/finality/validatorSetRecord.ts': '2395cd9d889e1cd1d519271486b28465efa55360798c1a6c19878f3431727d91',
  'src/libs/blockchain/finality/proofTestKit.ts': 'a9d4b5c7b7740bcf7d5f5f02f54d60af3ff5c4d2c582d9c1427872cdab1df046',
  'src/libs/blockchain/finality/verify.ts': '521834f5d794099e8fce4960834579651899e332fc241cef2a9870215cf2f6b3',
  'src/libs/crypto/canonicalJson.ts': '802a01f8f15f8c6653b0ed980b33615ffd139a5cb4f692dc14b83e1d6aa6b69b',
  'src/libs/crypto/jcs.ts': '8f53e1fca1380d6b8f937cfc7218128c0c40cbd58ebb855f9fff41a6d9e6d738',
  'src/libs/crypto/hashing.ts': '92c3ac21f82a6ff5c8d2b59c37264bd3b3396f6df64097188c74b35cf90be638',
  'src/libs/crypto/merkle/hex.ts': 'ef11cd659ab77dec897d0ad74d56a0214df766502d054aa76e82a415437d0f40',
  'src/libs/crypto/merkle/sparse.ts': 'f6e46cc8a56b868087d9321444f2986534a7cc6313468bfed59a71fa7bb633c0',
  'src/libs/blockchain/finality/storageRecord.ts': '1b848f585acfcab5d5843fe628bff9f7d3fbd59466deb288991545a97e3e4c4e',
  'src/libs/network/routines/nodecalls/getStorageProof.ts': 'f58b2ef34febd1a58faac483e89b079f55663fb0c70e108950824a93b5e7ecd6',
  'src/libs/network/routines/nodecalls/getFinalizedHead.ts': 'eca147807ff42d98f6a2821bde5f42f1446fe78dfef1516f999d64e521e8233b',
};

// Each designed vector, its node verdict group and the disposition the finality verifier is expected to give it.
// "not-final" is invalid or indeterminate; "recorded" is any of the three verdicts.
const VECTOR_TABLE = [
  ['membership-sibling', 'final', 'present'],
  ['membership-deleted', 'final', 'present'],
  ['membership-acl', 'final', 'present'],
  ['nonmembership-empty', 'final', 'unproven'],
  ['nonmembership-other-leaf', 'final', 'unproven'],
  ['head-matching', 'final', 'present'],
  ['head-stale', 'final', 'unproven'],
  ['nonce-competing', { 7: 'final', 8: 'final' }, { 7: 'present', 8: 'unproven' }],
  ['commit-lock', 'final', 'present'],
  ['bare-hash', 'final', 'present'],
  ['bare-hash-wrong-message', 'not-final', 'unproven'],
  ['pool-large-no-committee', 'indeterminate', 'unproven'],
  ['pool-large-valid-committee', 'final', 'present'],
  ['signer-inactive-control', 'final', 'present'],
  ['signer-inactive-excluded', 'not-final', 'unproven'],
  ['signer-not-yet-valid-control', 'final', 'present'],
  ['signer-not-yet-valid-excluded', 'not-final', 'unproven'],
  ['signer-peerlist-control', 'final', 'present'],
  ['signer-peerlist-excluded', 'not-final', 'unproven'],
  ['peerlist-fallback-control', 'final', 'present'],
  ['duplicate-signer-control', 'final', 'present'],
  ['duplicate-signer-repeated', 'not-final', 'unproven'],
  ['committee-active-control', 'final', 'present'],
  ['committee-inactive-excluded', 'not-final', 'unproven'],
  ['staked-over-shard-trusted-parent', 'final', 'present'],
  ['validator-null-status-control', 'final', 'present'],
  ['anchor-65536-control', 'final', 'present'],
  ['anchor-65537-over', 'recorded', 'unproven'],
  ['parent-65536-control', 'final', 'present'],
  ['parent-65537-over', 'recorded', 'unproven'],
  ['signatures-256-control', 'final', 'present'],
  ['signatures-257-over', 'recorded', 'unproven'],
  ['validators-256-control', 'final', 'present'],
  ['validators-257-over', 'recorded', 'unproven'],
  ['siblings-256-control', 'final', 'present'],
  ['siblings-257-over', 'invalid', 'unproven'],
];
const VECTOR_NAMES = VECTOR_TABLE.map(([name]) => name);
const ENCODER_CASE_NAMES = [
  'sdk-null', 'sdk-true', 'sdk-false', 'sdk-zero', 'sdk-negative', 'sdk-max-safe', 'sdk-min-safe', 'sdk-empty-text', 'sdk-ascii',
  'sdk-decomposed-value', 'sdk-astral-value', 'sdk-controls', 'sdk-empty-array', 'sdk-empty-object', 'sdk-nested',
  'sdk-decomposed-key', 'sdk-composed-key', 'sdk-composed-key-order', 'sdk-decomposed-key-order', 'sdk-astral-key-order',
  'sdk-numeric-key-order', 'sdk-value-key-normalization', 'sdk-fraction', 'sdk-above-safe', 'sdk-below-safe',
  'sdk-nan', 'sdk-infinity', 'sdk-bigint', 'sdk-cycle', 'sdk-undefined',
];
const HEAD_MEMBERS = ['number', 'hash', 'timestamp', 'ageSeconds', 'nodeSynced', 'checkedThroughBlock', 'signatureCount', 'signatures', 'round', 'signedMessage'];
const FIXTURE_MEMBERS = ['sellerClaim', 'listingId', 'version', 'membershipNonce', 'competingNonce', 'salt', 'logicalAddress', 'owner', 'programName', 'storageAddress', 'competingStorageAddress'];
const MEMBERSHIP_NAMES = ['membership-sibling', 'membership-deleted', 'membership-acl', 'commit-lock'];
const CONTENT_LIMIT = 65_536;
const INVALID = { status: 'invalid' };
const ABSENT = { status: 'absent' };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const IDENTITY = /^0x[0-9a-f]{64}$/;
const sha256 = (data) => createHash('sha256').update(data).digest();
const sha256Hex = (data) => sha256(data).toString('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIntegerOrNull = (value) => value === null || Number.isSafeInteger(value);
const isStringOrNull = (value) => value === null || typeof value === 'string';
const dispositionOf = (name) => VECTOR_TABLE.find(([candidate]) => candidate === name)[2];
const includesPresent = (disposition) => (typeof disposition === 'string' ? disposition === 'present' : Object.values(disposition).includes('present'));
const quorumThreshold = (shardSize) => Math.floor((shardSize * 2) / 3) + 1;
const contentOf = (block) => JSON.parse(block.contentBytes);
const storageRootOf = (reply) => contentOf(reply.anchor).native_tables_hashes.native_storage_programs;
const repliesOf = (vector) => (vector.proofs ? [vector.reply, ...Object.values(vector.proofs)] : [vector.reply]);
const headersOf = (vector) => (vector.head ? [vector.reply.anchor, vector.head] : [vector.reply.anchor]);

function assertMembers(value, required, optional, label) {
  assert.ok(isObject(value), `${label} is an object`);
  for (const member of required) assert.ok(Object.hasOwn(value, member), `${label} has ${member}`);
  for (const member of Object.keys(value)) assert.ok(required.includes(member) || optional.includes(member), `${label} has no member ${member}`);
}

function assertSignatureMap(signatures, label) {
  assert.ok(isObject(signatures), `${label} signatures are an object`);
  for (const signature of Object.values(signatures)) assert.match(signature, HEX128, `${label} signature`);
}

function assertBlockBytes(block, label, signed) {
  const members = signed ? ['number', 'hash', 'contentBytes', 'round', 'signedMessage', 'signatures'] : ['number', 'hash', 'contentBytes'];
  assertMembers(block, members, [], label);
  assert.ok(Number.isSafeInteger(block.number), `${label} number`);
  assert.match(block.hash, HEX64, `${label} hash`);
  assert.equal(typeof block.contentBytes, 'string', `${label} contentBytes`);
  if (!signed) return;
  assert.ok(isIntegerOrNull(block.round), `${label} round is a number or null`);
  assert.ok(isStringOrNull(block.signedMessage), `${label} signedMessage is a string or null`);
  assertSignatureMap(block.signatures, label);
}

function assertTerminal(terminal, label) {
  if (terminal?.kind === 'empty') return assertMembers(terminal, ['kind'], [], label);
  assertMembers(terminal, ['kind', 'key', 'valueHash'], [], label);
  assert.equal(terminal.kind, 'leaf', `${label} kind`);
  assert.match(terminal.key, HEX64, `${label} key`);
  assert.match(terminal.valueHash, HEX64, `${label} valueHash`);
}

function assertStorageProof(reply, label) {
  assertMembers(reply, ['anchor', 'anchorParent', 'asOfBlock', 'proofs'], [], label);
  assertBlockBytes(reply.anchor, `${label} anchor`, true);
  assertBlockBytes(reply.anchorParent, `${label} anchorParent`, false);
  assert.ok(Number.isSafeInteger(reply.asOfBlock), `${label} asOfBlock`);
  assert.ok(Array.isArray(reply.proofs) && reply.proofs.length === 1, `${label} has exactly one entry`);
  const [entry] = reply.proofs;
  assertMembers(entry, ['storageAddress', 'record', 'siblings', 'terminal'], [], `${label} entry`);
  assert.equal(typeof entry.storageAddress, 'string', `${label} storageAddress`);
  assert.ok(entry.record === null || isObject(entry.record), `${label} record is an object or null`);
  assert.ok(Array.isArray(entry.siblings) && entry.siblings.every((sibling) => HEX64.test(sibling)), `${label} siblings`);
  assertTerminal(entry.terminal, `${label} terminal`);
}

function assertHead(head, label) {
  assert.deepEqual(Object.keys(head), HEAD_MEMBERS, `${label} has the ten head members in order`);
  assert.ok(Number.isSafeInteger(head.number), `${label} number`);
  assert.match(head.hash, HEX64, `${label} hash`);
  for (const member of ['timestamp', 'ageSeconds']) {
    assert.ok(head[member] === null || (Number.isSafeInteger(head[member]) && head[member] >= 0), `${label} ${member}`);
  }
  assert.equal(head.ageSeconds === null, head.timestamp === null, `${label} ageSeconds is null exactly when timestamp is`);
  assert.equal(typeof head.nodeSynced, 'boolean', `${label} nodeSynced`);
  assert.ok(Number.isSafeInteger(head.checkedThroughBlock), `${label} checkedThroughBlock`);
  assertSignatureMap(head.signatures, label);
  assert.equal(head.signatureCount, Object.keys(head.signatures).length, `${label} signatureCount`);
  assert.ok(isIntegerOrNull(head.round), `${label} round`);
  assert.ok(isStringOrNull(head.signedMessage), `${label} signedMessage`);
}

function assertPin(pin, label) {
  assertMembers(pin, ['checkpoint', 'trusted', 'rules'], [], label);
  assertMembers(pin.checkpoint, ['height', 'blockHash'], [], `${label} checkpoint`);
  assert.ok(Number.isSafeInteger(pin.checkpoint.height), `${label} checkpoint height`);
  assert.match(pin.checkpoint.blockHash, HEX64, `${label} checkpoint blockHash`);
  assertMembers(pin.trusted, ['validators'], [], `${label} trusted`);
  assert.ok(Array.isArray(pin.trusted.validators), `${label} validators`);
  for (const validator of pin.trusted.validators) {
    assertMembers(validator, ['identity', 'stake', 'status', 'validAt'], [], `${label} validator`);
    assert.equal(typeof validator.identity, 'string');
    assert.equal(typeof validator.stake, 'string');
    assert.ok(isStringOrNull(validator.status) && isIntegerOrNull(validator.validAt), `${label} validator status and validAt`);
  }
  assertMembers(pin.rules, ['shardSize', 'commitLock'], ['committee'], `${label} rules`);
  assert.ok(Number.isSafeInteger(pin.rules.shardSize), `${label} shardSize`);
  assert.equal(typeof pin.rules.commitLock, 'boolean', `${label} commitLock`);
  if ('committee' in pin.rules) assert.ok(pin.rules.committee.every((id) => typeof id === 'string'), `${label} committee`);
}

function assertEncoderCase(encoded) {
  assertMembers(encoded, ['name', 'form', 'input', 'jcs', 'canonicalJson'], [], encoded.name);
  assert.ok(['json', 'nan', 'infinity', 'bigint', 'cycle', 'undefined'].includes(encoded.form), `${encoded.name} form`);
  if (encoded.form !== 'json') assert.equal(encoded.input, null, `${encoded.name} input is null for a non-JSON form`);
  for (const outcome of [encoded.jcs, encoded.canonicalJson]) {
    if (outcome.ok === true) assertMembers(outcome, ['ok', 'text'], [], encoded.name);
    else assert.deepEqual(outcome, { ok: false }, `${encoded.name} refusal`);
    if (outcome.ok) assert.equal(typeof outcome.text, 'string');
  }
}

/** The value an encoder case stands for: its stored JSON input, or the non-JSON value its form names. */
function valueOfCase({ form, input }) {
  if (form === 'nan') return Number.NaN;
  if (form === 'infinity') return Number.POSITIVE_INFINITY;
  if (form === 'bigint') return 1n;
  if (form === 'undefined') return undefined;
  if (form === 'cycle') {
    const cycle = {};
    cycle.self = cycle;
    return cycle;
  }
  return input;
}

// ---- a test-local sparse path, used to build roots for changed entries ----

const bitAt = (bytes, index) => (bytes[index >> 3] >> (7 - (index & 7))) & 1;
const addressKey = (address) => sha256(Buffer.from(address, 'utf8'));
const leafHashHex = (keyHex, valueHashHex) => sha256Hex(Buffer.concat([Buffer.of(2), Buffer.from(keyHex, 'hex'), Buffer.from(valueHashHex, 'hex')]));
const recordValueHashHex = (record) => sha256Hex(Buffer.concat([Buffer.of(0), Buffer.from(nodeCanonicalJson(record), 'utf8')]));

function foldHex(key, terminalHashHex, siblings) {
  let hash = Buffer.from(terminalHashHex, 'hex');
  for (let depth = siblings.length - 1; depth >= 0; depth -= 1) {
    const sibling = Buffer.from(siblings[depth], 'hex');
    hash = sha256(Buffer.concat(bitAt(key, depth) ? [Buffer.of(1), sibling, hash] : [Buffer.of(1), hash, sibling]));
  }
  return hash.toString('hex');
}

/** A fresh copy of a stored vector's entry with the options a caller passes for it. */
function storedCall(name, reply = stored.vectors[name].reply) {
  const entry = structuredClone(reply.proofs[0]);
  return { entry, options: { storageRoot: storageRootOf(reply), expectedAddress: entry.storageAddress } };
}

const flipHex = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('stored node proof vectors match the pinned manifest and primitive hashes', async (t) => {
  await t.test('the vector file has exactly the designed top-level, fixture, case and vector members and types', () => {
    assertMembers(stored, ['fixture', 'encoderCases', 'vectors'], [], 'document');
    assertMembers(stored.fixture, FIXTURE_MEMBERS, [], 'fixture');
    for (const member of ['version', 'membershipNonce', 'competingNonce']) assert.equal(typeof stored.fixture[member], 'number', member);
    for (const member of FIXTURE_MEMBERS.filter((name) => typeof stored.fixture[name] !== 'number')) assert.equal(typeof stored.fixture[member], 'string', member);
    assert.ok(Array.isArray(stored.encoderCases) && stored.encoderCases.length === ENCODER_CASE_NAMES.length, 'thirty encoder cases');
    stored.encoderCases.forEach(assertEncoderCase);
    assert.deepEqual(Object.keys(stored.vectors), VECTOR_NAMES);
    for (const name of VECTOR_NAMES) {
      const vector = stored.vectors[name];
      assertMembers(vector, ['reply', 'pin'], ['head', 'proofs'], name);
      assertStorageProof(vector.reply, name);
      assertPin(vector.pin, name);
      const headed = includesPresent(dispositionOf(name)) || name === 'head-matching' || name === 'head-stale';
      assert.equal('head' in vector, headed, `${name} carries a head exactly when it is designed to`);
      if (headed) assertHead(vector.head, `${name} head`);
      assert.equal('proofs' in vector, name === 'nonce-competing', `${name} proofs member`);
    }
    const competing = stored.vectors['nonce-competing'];
    assert.deepEqual(Object.keys(competing.proofs), ['7', '8']);
    for (const proof of Object.values(competing.proofs)) assertStorageProof(proof, 'nonce-competing proof');
    assert.deepEqual(competing.proofs['7'], competing.reply);
  });

  await t.test('the manifest has exactly the designed members and one entry per required name and encoder case', () => {
    assertMembers(manifest, ['nodeCommit', 'command', 'exitStatus', 'sourceDigests', 'fileSha256', 'required', 'vectors', 'encoderCases'], [], 'manifest');
    assert.match(manifest.nodeCommit, /^[0-9a-f]{40}$/);
    assert.equal(typeof manifest.command, 'string');
    assert.equal(typeof manifest.exitStatus, 'number');
    assert.ok(Object.values(manifest.sourceDigests).every((digest) => HEX64.test(digest)));
    assert.match(manifest.fileSha256, HEX64);
    assert.deepEqual(Object.keys(manifest.vectors), manifest.required);
    for (const [name, entry] of Object.entries(manifest.vectors)) {
      const noLookup = name === 'staked-over-shard-trusted-parent' ? ['noLookupVerdict'] : [];
      assertMembers(entry, ['sha256', 'nodeVerdict', ...noLookup, 'sdkDisposition'], [], `manifest ${name}`);
      assert.match(entry.sha256, HEX64);
    }
    assert.deepEqual(Object.keys(manifest.encoderCases), ENCODER_CASE_NAMES);
    for (const [name, entry] of Object.entries(manifest.encoderCases)) {
      assertMembers(entry, ['sha256'], [], `manifest case ${name}`);
      assert.match(entry.sha256, HEX64);
    }
  });

  await t.test('every vector digest, encoder case digest and the whole-file digest match the manifest', () => {
    for (const name of VECTOR_NAMES) assert.equal(sha256Hex(JSON.stringify(stored.vectors[name])), manifest.vectors[name].sha256, name);
    for (const encoded of stored.encoderCases) assert.equal(sha256Hex(JSON.stringify(encoded)), manifest.encoderCases[encoded.name].sha256, encoded.name);
    assert.equal(sha256Hex(fileBytes), manifest.fileSha256);
    assert.ok(fileText.endsWith('}\n'), 'the file ends with one LF');
    assert.ok(!fileText.includes('\r'), 'the file has no CR');
  });

  await t.test('the recorded command, exit status, node commit and source digests are the pinned values', () => {
    assert.equal(manifest.command, COMMAND);
    assert.equal(manifest.exitStatus, 0);
    assert.equal(manifest.nodeCommit, NODE_COMMIT);
    assert.equal(Object.keys(SOURCE_DIGESTS).length, 19);
    assert.deepEqual(manifest.sourceDigests, SOURCE_DIGESTS);
  });

  await t.test('the required names are exactly the designed thirty-six and every verdict and disposition matches its group', () => {
    assert.deepEqual(manifest.required, VECTOR_NAMES);
    assert.equal(VECTOR_NAMES.length, 36);
    const admits = (group, verdict) => ({
      final: verdict === 'final',
      invalid: verdict === 'invalid',
      indeterminate: verdict === 'indeterminate',
      'not-final': verdict === 'invalid' || verdict === 'indeterminate',
      recorded: ['final', 'invalid', 'indeterminate'].includes(verdict),
    })[group];
    for (const [name, group, disposition] of VECTOR_TABLE) {
      const { nodeVerdict, sdkDisposition } = manifest.vectors[name];
      if (typeof group === 'object') {
        assert.deepEqual(nodeVerdict, group, name);
      } else {
        assert.ok(admits(group, nodeVerdict), `${name} verdict ${nodeVerdict} is in group ${group}`);
      }
      assert.deepEqual(sdkDisposition, disposition, name);
    }
    assert.equal(manifest.vectors['staked-over-shard-trusted-parent'].noLookupVerdict, 'indeterminate');
  });

  await t.test('the fixture owner, program name and storage addresses match the SDK functions and the literal logical address', () => {
    const { fixture } = stored;
    const logical = `dacs1-revoked:${encodeAddressSegment(fixture.sellerClaim)}:${fixture.listingId}:v${fixture.version}`;
    assert.equal(logical, 'dacs1-revoked:did%3Ademos%3Aagent%3Ad75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a:proof-fixture:v1');
    assert.equal(fixture.logicalAddress, logical);
    assert.equal(fixture.owner, addressForClaim(fixture.sellerClaim));
    assert.equal(fixture.programName, logicalToStorageProgramName(logical));
    assert.equal(fixture.storageAddress, deriveStorageAddress(fixture.owner, fixture.programName, fixture.membershipNonce, fixture.salt));
    assert.equal(fixture.competingStorageAddress, deriveStorageAddress(fixture.owner, fixture.programName, fixture.competingNonce, fixture.salt));
    assert.deepEqual([fixture.membershipNonce, fixture.competingNonce, fixture.salt], [7, 8, '']);
  });

  await t.test('the block hash, validator-set commitment and record value hash match the stored node bytes', () => {
    for (const name of VECTOR_NAMES) {
      const vector = stored.vectors[name];
      const commitment = sha256Hex(nodeJcs(vector.pin.trusted.validators));
      for (const reply of repliesOf(vector)) {
        for (const block of [reply.anchor, reply.anchorParent]) assert.equal(sha256Hex(Buffer.from(block.contentBytes, 'utf8')), block.hash, `${name} block ${block.number}`);
        const committed = [...Object.values(contentOf(reply.anchor)), ...Object.values(contentOf(reply.anchorParent))];
        assert.ok(committed.includes(commitment), `${name} commits the validator set it pins`);
        const [entry] = reply.proofs;
        if (entry.record !== null) assert.equal(recordValueHashHex(entry.record), entry.terminal.valueHash, `${name} record value hash`);
      }
    }
  });

  await t.test('the signed control properties hold on the stored bytes', () => {
    const { vectors, fixture } = stored;
    const entryOf = (name) => vectors[name].reply.proofs[0];
    const bytesOf = (text) => Buffer.byteLength(text, 'utf8');
    assert.ok(entryOf('membership-sibling').siblings.length >= 1);
    assert.ok(vectors['membership-sibling'].pin.trusted.validators.length <= vectors['membership-sibling'].pin.rules.shardSize);
    assert.ok(entryOf('nonmembership-other-leaf').siblings.length >= 2);

    const provedKey = addressKey(fixture.storageAddress);
    const fillerKey = Buffer.from(provedKey);
    fillerKey[31] ^= 1;
    const longPath = entryOf('siblings-256-control').siblings;
    assert.equal(longPath.length, 256);
    assert.ok(longPath.slice(0, 255).every((sibling) => sibling === '0'.repeat(64)));
    assert.equal(longPath[255], leafHashHex(fillerKey.toString('hex'), sha256Hex('siblings-256-filler')));
    assert.equal(entryOf('siblings-257-over').siblings.length, 257);

    for (const [field, label] of [['anchor', 'anchor'], ['anchorParent', 'parent']]) {
      assert.equal(bytesOf(vectors[`${label}-65536-control`].reply[field].contentBytes), CONTENT_LIMIT);
      assert.equal(bytesOf(vectors[`${label}-65537-over`].reply[field].contentBytes), CONTENT_LIMIT + 1);
    }
    assert.equal(Object.keys(vectors['signatures-256-control'].reply.anchor.signatures).length, 256);
    assert.equal(Object.keys(vectors['signatures-257-over'].reply.anchor.signatures).length, 257);
    assert.equal(vectors['validators-256-control'].pin.trusted.validators.length, 256);
    assert.equal(vectors['validators-257-over'].pin.trusted.validators.length, 257);

    const staked = vectors['staked-over-shard-trusted-parent'];
    const parent = staked.reply.anchorParent;
    const height = Math.max(parent.number - 1, 0);
    const active = new Set(staked.pin.trusted.validators.filter((v) => v.status === '2' && v.validAt !== null && v.validAt <= height).map((v) => v.identity));
    const { shardSize } = staked.pin.rules;
    assert.ok(active.size > shardSize, 'more active staked validators than the shard size');
    assert.ok(!('committee' in staked.pin.rules), 'no committee');
    const overlap = contentOf(parent).peerlist.filter((id) => active.has(id.toLowerCase())).length;
    assert.ok(overlap >= quorumThreshold(shardSize) && overlap <= shardSize, 'the peerlist active intersection is between the quorum and the shard size');
    assert.deepEqual(staked.pin.checkpoint, { height: parent.number, blockHash: parent.hash });
    assert.equal(manifest.vectors['staked-over-shard-trusted-parent'].noLookupVerdict, 'indeterminate');

    const repeated = vectors['duplicate-signer-repeated'].reply.anchor.signatures;
    const bare = Object.keys(repeated).filter((id) => !id.startsWith('0x'));
    assert.equal(bare.length, 1);
    assert.equal(repeated[bare[0]], repeated[`0x${bare[0]}`], 'one key spelled with and without 0x carries one signature');
    assert.ok(vectors['validator-null-status-control'].pin.trusted.validators.some((v) => v.status === null && v.validAt === null));

    for (const name of VECTOR_NAMES) {
      const vector = stored.vectors[name];
      const named = [...vector.pin.trusted.validators.map((v) => v.identity), ...(vector.pin.rules.committee ?? [])];
      for (const header of headersOf(vector)) named.push(...Object.keys(header.signatures).filter((id) => id !== bare[0] || name !== 'duplicate-signer-repeated'));
      for (const identity of named) assert.match(identity, IDENTITY, `${name} identity`);
    }
  });

  await t.test('header members are typed as the node types them and the bare-hash header follows the bare-hash rule', () => {
    for (const name of VECTOR_NAMES) {
      const vector = stored.vectors[name];
      for (const header of headersOf(vector)) {
        assert.ok(isIntegerOrNull(header.round) && isStringOrNull(header.signedMessage), `${name} header round and signedMessage`);
        if (!vector.pin.rules.commitLock) continue;
        assert.ok(Number.isSafeInteger(header.round) && header.round > 0, `${name} commit-lock header has a numeric round`);
        assert.equal(header.signedMessage, `demos-precommit:${header.number}:${header.round}:${header.hash}`, `${name} precommit message`);
      }
      if (vector.head) assert.ok(typeof vector.head.signatureCount === 'number' && 'timestamp' in vector.head && 'ageSeconds' in vector.head);
    }
    assert.equal(stored.vectors['commit-lock'].reply.anchor.round, 3);
    const bare = stored.vectors['bare-hash'];
    assert.equal(bare.pin.rules.commitLock, false);
    assert.equal(bare.reply.anchor.signedMessage, bare.reply.anchor.hash);
    const wrong = stored.vectors['bare-hash-wrong-message'];
    assert.notEqual(wrong.reply.anchor.signedMessage, bare.reply.anchor.signedMessage);
    const restored = { ...wrong.reply, anchor: { ...wrong.reply.anchor, signedMessage: bare.reply.anchor.signedMessage } };
    assert.deepEqual(restored, bare.reply, 'the wrong-message vector differs from bare-hash only in signedMessage');
    assert.deepEqual(wrong.pin, bare.pin);
  });

  await t.test('the stored files carry no key material', () => {
    const secretName = /private|secret|seed|mnemonic|passphrase/i;
    const visit = (value, path) => {
      if (typeof value === 'string') {
        assert.ok(!value.includes('-----BEGIN'), `${path} is not PEM`);
        assert.ok(!/302e020100300506032b6570|MC4CAQAwBQYDK2Vw/.test(value), `${path} is not a PKCS#8 ed25519 key`);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        assert.ok(!secretName.test(key), `${path}.${key} is not named like key material`);
        visit(child, `${path}.${key}`);
      }
    };
    visit(stored, 'vectors');
    visit(manifest, 'manifest');
    for (const name of VECTOR_NAMES) {
      for (const header of headersOf(stored.vectors[name])) {
        for (const [identity, signature] of Object.entries(header.signatures)) {
          assert.ok(identity.length === 66 || (name === 'duplicate-signer-repeated' && identity.length === 64), `${name} identity length`);
          assert.match(signature, HEX128);
        }
      }
    }
  });
});

test('SDK-written JCS cases match every pinned node output and refusal', async (t) => {
  await t.test('every designed case name is visited exactly once and no other case is stored', () => {
    assert.deepEqual(stored.encoderCases.map(({ name }) => name), ENCODER_CASE_NAMES);
  });

  await t.test('nodeJcs matches every stored node output and throws for every stored refusal', () => {
    for (const encoded of stored.encoderCases) {
      const value = valueOfCase(encoded);
      if (encoded.jcs.ok) assert.equal(nodeJcs(value), encoded.jcs.text, encoded.name);
      else assert.throws(() => nodeJcs(value), { message: 'jcs_unsupported' }, encoded.name);
    }
  });

  await t.test('nodeCanonicalJson matches every stored node output and throws for every stored refusal', () => {
    for (const encoded of stored.encoderCases) {
      const value = valueOfCase(encoded);
      if (encoded.canonicalJson.ok) assert.equal(nodeCanonicalJson(value), encoded.canonicalJson.text, encoded.name);
      else assert.throws(() => nodeCanonicalJson(value), { message: 'canonical_json_unsupported' }, encoded.name);
    }
    const refusedByJcs = stored.encoderCases.filter(({ name }) => ['sdk-fraction', 'sdk-above-safe', 'sdk-below-safe'].includes(name));
    assert.equal(refusedByJcs.length, 3);
    for (const encoded of refusedByJcs) assert.equal(encoded.canonicalJson.ok, true, `${encoded.name} is accepted by the node's canonical JSON`);
    assert.deepEqual(stored.encoderCases.filter(({ form }) => form !== 'json').map(({ name }) => name), ['sdk-nan', 'sdk-infinity', 'sdk-bigint', 'sdk-cycle', 'sdk-undefined']);
  });

  await t.test('the stored SDK-written inputs keep distinct decomposed and composed keys and values and the safe-integer edges', () => {
    const input = (name) => stored.encoderCases.find((encoded) => encoded.name === name).input;
    assert.deepEqual(Object.keys(input('sdk-decomposed-key')), ['Café']);
    assert.deepEqual(Object.keys(input('sdk-composed-key')), ['Café']);
    assert.ok(input('sdk-decomposed-value').includes('é'));
    assert.deepEqual(input('sdk-value-key-normalization'), { 'Café': 'Café', 'Café': 'Café' });
    assert.equal(input('sdk-max-safe'), Number.MAX_SAFE_INTEGER);
    assert.equal(input('sdk-min-safe'), Number.MIN_SAFE_INTEGER);
    assert.equal(input('sdk-above-safe'), Number.MAX_SAFE_INTEGER + 1);
    assert.equal(input('sdk-below-safe'), Number.MIN_SAFE_INTEGER - 1);
    assert.equal(input('sdk-fraction'), 1.5);
  });
});

test('one-address storage paths reject mismatched records and same-key absence', async (t) => {
  await t.test('membership with siblings is present and returns the committed record', () => {
    for (const name of MEMBERSHIP_NAMES) {
      const { entry, options } = storedCall(name);
      assert.ok(entry.siblings.length >= 1, `${name} has a sibling`);
      const result = verifyRevocationStorage(entry, options);
      assert.equal(result.status, 'present', name);
      assert.equal(result.record, entry.record, `${name} returns the entry's own record object`);
      assert.deepEqual(Object.keys(result), ['status', 'record']);
    }
    assert.equal(storedCall('membership-deleted').entry.record.isDeleted, true);
  });

  await t.test('a changed sibling, storage root or committed record value is invalid', () => {
    const control = storedCall('membership-sibling');
    assert.equal(verifyRevocationStorage(control.entry, control.options).status, 'present');
    const sibling = storedCall('membership-sibling');
    sibling.entry.siblings[0] = flipHex(sibling.entry.siblings[0]);
    assert.deepEqual(verifyRevocationStorage(sibling.entry, sibling.options), INVALID);
    const root = storedCall('membership-sibling');
    root.options.storageRoot = flipHex(root.options.storageRoot);
    assert.deepEqual(verifyRevocationStorage(root.entry, root.options), INVALID);
    const value = storedCall('membership-sibling');
    value.entry.record.isDeleted = !value.entry.record.isDeleted;
    assert.deepEqual(verifyRevocationStorage(value.entry, value.options), INVALID);
  });

  await t.test('a same-key leaf with no record is invalid and a record on a non-membership proof is invalid', () => {
    const present = storedCall('membership-sibling');
    assert.equal(verifyRevocationStorage(present.entry, present.options).status, 'present');
    present.entry.record = null;
    assert.deepEqual(verifyRevocationStorage(present.entry, present.options), INVALID);
    const { record } = stored.vectors['membership-sibling'].reply.proofs[0];
    for (const name of ['nonmembership-empty', 'nonmembership-other-leaf']) {
      const absent = storedCall(name);
      assert.deepEqual(verifyRevocationStorage(absent.entry, absent.options), ABSENT, name);
      absent.entry.record = structuredClone(record);
      assert.equal(absent.entry.record.storageAddress, absent.entry.storageAddress);
      assert.deepEqual(verifyRevocationStorage(absent.entry, absent.options), INVALID, name);
    }
  });

  await t.test('both non-membership terminals are absent and a changed sibling, terminal or storage root is invalid', () => {
    for (const name of ['nonmembership-empty', 'nonmembership-other-leaf']) {
      const control = storedCall(name);
      assert.deepEqual(verifyRevocationStorage(control.entry, control.options), ABSENT, name);
      const sibling = storedCall(name);
      sibling.entry.siblings[0] = flipHex(sibling.entry.siblings[0]);
      assert.deepEqual(verifyRevocationStorage(sibling.entry, sibling.options), INVALID, `${name} sibling`);
      const terminal = storedCall(name);
      terminal.entry.terminal = terminal.entry.terminal.kind === 'empty'
        ? { kind: 'leaf', key: sha256Hex('another key'), valueHash: sha256Hex('another value') }
        : { ...terminal.entry.terminal, valueHash: flipHex(terminal.entry.terminal.valueHash) };
      assert.deepEqual(verifyRevocationStorage(terminal.entry, terminal.options), INVALID, `${name} terminal`);
      const root = storedCall(name);
      root.options.storageRoot = flipHex(root.options.storageRoot);
      assert.deepEqual(verifyRevocationStorage(root.entry, root.options), INVALID, `${name} root`);
    }
  });

  await t.test("an other-key leaf whose key does not share the requested key's path bits is invalid", () => {
    const control = storedCall('nonmembership-other-leaf');
    const { siblings, terminal } = control.entry;
    const terminalHash = leafHashHex(terminal.key, terminal.valueHash);
    assert.equal(foldHex(addressKey(control.entry.storageAddress), terminalHash, siblings), control.options.storageRoot, 'the test fold matches the stored root');
    assert.deepEqual(verifyRevocationStorage(control.entry, control.options), ABSENT);
    const terminalKey = Buffer.from(terminal.key, 'hex');
    let probe;
    for (let index = 0; index < 1024 && !probe; index += 1) {
      const address = `shared-prefix-probe-${index}`;
      const key = addressKey(address);
      if (siblings.some((_, depth) => bitAt(key, depth) !== bitAt(terminalKey, depth))) probe = { address, key };
    }
    assert.ok(probe, 'a probe address that breaks the shared prefix exists');
    const entry = { ...control.entry, storageAddress: probe.address };
    const options = { storageRoot: foldHex(probe.key, terminalHash, siblings), expectedAddress: probe.address };
    assert.deepEqual(verifyRevocationStorage(entry, options), INVALID);
  });

  await t.test('a record or expected address that does not match the entry is invalid', () => {
    const { competingStorageAddress } = stored.fixture;
    const control = storedCall('membership-sibling');
    assert.equal(verifyRevocationStorage(control.entry, control.options).status, 'present');
    const expected = storedCall('membership-sibling');
    expected.options.expectedAddress = competingStorageAddress;
    assert.deepEqual(verifyRevocationStorage(expected.entry, expected.options), INVALID);
    const record = storedCall('membership-sibling');
    record.entry.record.storageAddress = competingStorageAddress;
    assert.deepEqual(verifyRevocationStorage(record.entry, record.options), INVALID);
    const entryAddress = storedCall('membership-sibling');
    entryAddress.entry.storageAddress = competingStorageAddress;
    entryAddress.options.expectedAddress = competingStorageAddress;
    assert.deepEqual(verifyRevocationStorage(entryAddress.entry, entryAddress.options), INVALID);
  });

  await t.test('the competing-nonce proofs are present at the first nonce and absent at the second', () => {
    const { proofs } = stored.vectors['nonce-competing'];
    const first = storedCall('nonce-competing', proofs['7']);
    const second = storedCall('nonce-competing', proofs['8']);
    assert.equal(first.options.storageRoot, second.options.storageRoot, 'both entries are under one root');
    assert.equal(first.entry.storageAddress, stored.fixture.storageAddress);
    assert.equal(second.entry.storageAddress, stored.fixture.competingStorageAddress);
    assert.equal(verifyRevocationStorage(first.entry, first.options).status, 'present');
    assert.deepEqual(verifyRevocationStorage(second.entry, second.options), ABSENT);
  });

  await t.test('malformed entries, options, roots, paths, terminals and records are invalid without throwing', () => {
    const present = storedCall('membership-sibling');
    const absent = storedCall('nonmembership-other-leaf');
    assert.equal(verifyRevocationStorage(present.entry, present.options).status, 'present');
    assert.deepEqual(verifyRevocationStorage(absent.entry, absent.options), ABSENT);
    const cyclic = () => {
      const record = structuredClone(present.entry.record);
      record.self = record;
      return record;
    };
    const withEntry = (change, from = 'membership-sibling') => () => {
      const call = storedCall(from);
      change(call.entry);
      return [call.entry, call.options];
    };
    const withOptions = (change) => () => {
      const call = storedCall('membership-sibling');
      change(call.options);
      return [call.entry, call.options];
    };
    const rows = [
      ...[null, [], 'entry', 5].map((entry) => [`entry ${JSON.stringify(entry)}`, () => [entry, present.options]]),
      ...[null, [], 'options', 5].map((options) => [`options ${JSON.stringify(options)}`, () => [present.entry, options]]),
      ['storageAddress a number', withEntry((entry) => { entry.storageAddress = 5; })],
      ['storageAddress empty', withEntry((entry) => { entry.storageAddress = ''; })],
      ['storageAddress missing', withEntry((entry) => { delete entry.storageAddress; })],
      ['expectedAddress a number', withOptions((options) => { options.expectedAddress = 5; })],
      ['expectedAddress empty', withOptions((options) => { options.expectedAddress = ''; })],
      ['expectedAddress missing', withOptions((options) => { delete options.expectedAddress; })],
      ['expectedAddress another address', withOptions((options) => { options.expectedAddress = stored.fixture.competingStorageAddress; })],
      ['storageRoot upper-case', withOptions((options) => { options.storageRoot = options.storageRoot.toUpperCase(); })],
      ['storageRoot 63 characters', withOptions((options) => { options.storageRoot = options.storageRoot.slice(1); })],
      ['storageRoot 65 characters', withOptions((options) => { options.storageRoot += '0'; })],
      ['storageRoot 0x prefix', withOptions((options) => { options.storageRoot = `0x${options.storageRoot}`; })],
      ['storageRoot not a string', withOptions((options) => { options.storageRoot = 7; })],
      ['siblings not an array', withEntry((entry) => { entry.siblings = 'siblings'; })],
      ['siblings missing', withEntry((entry) => { delete entry.siblings; })],
      ['siblings over 256 entries', withEntry((entry) => { entry.siblings = Array.from({ length: 257 }, () => '0'.repeat(64)); })],
      ['a sibling upper-case', withEntry((entry) => { entry.siblings[0] = entry.siblings[0].toUpperCase(); })],
      ['a sibling 63 characters', withEntry((entry) => { entry.siblings[0] = entry.siblings[0].slice(1); })],
      ['a sibling not a string', withEntry((entry) => { entry.siblings[0] = 1; })],
      ['terminal an unknown kind', withEntry((entry) => { entry.terminal = { ...entry.terminal, kind: 'branch' }; })],
      ['terminal not an object', withEntry((entry) => { entry.terminal = 'leaf'; })],
      ['terminal null', withEntry((entry) => { entry.terminal = null; })],
      ['terminal an array', withEntry((entry) => { entry.terminal = [entry.terminal]; })],
      ['leaf terminal with a malformed key', withEntry((entry) => { entry.terminal.key = entry.terminal.key.toUpperCase(); })],
      ['leaf terminal with a malformed valueHash', withEntry((entry) => { entry.terminal.valueHash = entry.terminal.valueHash.slice(2); })],
      ['other-leaf terminal with a malformed key', withEntry((entry) => { entry.terminal.key = `0x${entry.terminal.key}`; }, 'nonmembership-other-leaf')],
      ...['record', 7, [], true].map((record) => [`record ${JSON.stringify(record)}`, withEntry((entry) => { entry.record = record; })]),
      ['record missing', withEntry((entry) => { delete entry.record; })],
      ['record with a cycle', withEntry((entry) => { entry.record = cyclic(); })],
      ['record with a non-finite number', withEntry((entry) => { entry.record.sizeBytes = Number.POSITIVE_INFINITY; })],
      ['record with a bigint', withEntry((entry) => { entry.record.sizeBytes = 56n; })],
      ['record without storageAddress', withEntry((entry) => { delete entry.record.storageAddress; })],
      ['record storageAddress not a string', withEntry((entry) => { entry.record.storageAddress = 5; })],
      ['record storageAddress another address', withEntry((entry) => { entry.record.storageAddress = stored.fixture.competingStorageAddress; })],
    ];
    for (const [label, build] of rows) {
      const [entry, options] = build();
      let result;
      assert.doesNotThrow(() => { result = verifyRevocationStorage(entry, options); }, label);
      assert.deepEqual(result, INVALID, label);
    }
  });

  await t.test('frozen inputs are read without mutation', () => {
    for (const [name, expected] of [['membership-sibling', 'present'], ['nonmembership-other-leaf', 'absent'], ['siblings-257-over', 'invalid']]) {
      const plain = storedCall(name);
      const frozen = storedCall(name);
      deepFreeze(frozen);
      const snapshot = JSON.stringify(frozen);
      const result = verifyRevocationStorage(frozen.entry, frozen.options);
      assert.equal(result.status, expected, name);
      assert.deepEqual(result, verifyRevocationStorage(plain.entry, plain.options), name);
      assert.equal(JSON.stringify(frozen), snapshot, `${name} inputs are unchanged`);
    }
  });

  await t.test('a path of 256 siblings is present and a path of 257 siblings is invalid', () => {
    const control = storedCall('siblings-256-control');
    assert.equal(control.entry.siblings.length, 256);
    assert.equal(verifyRevocationStorage(control.entry, control.options).status, 'present');
    const over = storedCall('siblings-257-over');
    assert.equal(over.entry.siblings.length, 257);
    assert.deepEqual(verifyRevocationStorage(over.entry, over.options), INVALID);
  });

  await t.test('a record whose own address differs from the entry address is invalid even when its leaf and root are recomputed', () => {
    const control = storedCall('membership-sibling');
    const { siblings, terminal } = control.entry;
    const key = addressKey(control.entry.storageAddress);
    assert.equal(foldHex(key, leafHashHex(terminal.key, recordValueHashHex(control.entry.record)), siblings), control.options.storageRoot, 'the test fold matches the stored root');
    assert.equal(verifyRevocationStorage(control.entry, control.options).status, 'present');
    const changes = [
      ['the competing address', (record) => { record.storageAddress = stored.fixture.competingStorageAddress; }],
      ['no address', (record) => { delete record.storageAddress; }],
      ['a number', (record) => { record.storageAddress = 7; }],
    ];
    for (const [label, change] of changes) {
      const call = storedCall('membership-sibling');
      change(call.entry.record);
      call.entry.terminal = { kind: 'leaf', key: terminal.key, valueHash: recordValueHashHex(call.entry.record) };
      call.options.storageRoot = foldHex(key, leafHashHex(terminal.key, call.entry.terminal.valueHash), siblings);
      assert.equal(foldHex(key, leafHashHex(call.entry.terminal.key, call.entry.terminal.valueHash), call.entry.siblings), call.options.storageRoot, `${label}: the changed record is committed under the root passed`);
      assert.deepEqual(verifyRevocationStorage(call.entry, call.options), INVALID, label);
    }
  });
});
