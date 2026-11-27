// Writes revocation-proof-pinned.json and its manifest from the pinned node build. The storage proofs, heads and
// encoder outputs in those files are produced by the node's own tree, record, set-hash and encoder functions and are
// accepted only after the node's verifyStorageProof returns the verdict each vector is designed for.
//
// Run by hand, never in SDK CI: copy this file to test/dacs-revocation-vectors.tmp.mjs inside a node checkout at
// NODE_COMMIT (with `bun install` done), then, from the node checkout,
//   bun run test/dacs-revocation-vectors.tmp.mjs --output ../sdk/packages/dacs-seller/test/vectors/revocation-proof-pinned.json
// The signing keys are fresh ed25519 keys made for one run; only their public identities and signatures are written,
// so every run changes every identity, signature and digest, and the json and manifest are replaced together.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const NODE_COMMIT = 'a98cad194c5a41c3af9867371dee037609709253';
const SCRIPT_PATH = 'test/dacs-revocation-vectors.tmp.mjs';
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

// The fixture values are computed once from the SDK (addressForClaim, logicalToStorageProgramName and
// deriveStorageAddress); the primitives test checks every one of them against those functions.
const FIXTURE = {
  sellerClaim: 'did:demos:agent:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  listingId: 'proof-fixture',
  version: 1,
  membershipNonce: 7,
  competingNonce: 8,
  salt: '',
  logicalAddress: 'dacs1-revoked:did%3Ademos%3Aagent%3Ad75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a:proof-fixture:v1',
  owner: '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  programName: 'dacs1-revoked%3Adid%3Ademos%3Aagent%3Ad75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a%3Aproof-fixture%3Av1',
  storageAddress: 'stor-92e668ddaa270c4356cc55de9de482a1629095ad',
  competingStorageAddress: 'stor-e0745d327b0b508067080cc252c3a6cff1ed8f46',
};

const PARENT_NUMBER = 1200;
const PARENT_TIMESTAMP = 1767225600;
const ANCHOR_TIMESTAMP = 1767225606;
const NEWER_TIMESTAMP = 1767225612;
const DEFAULT_ROUND = 1;
const COMMIT_LOCK_ROUND = 3;
const ACTIVE = '2';
const INACTIVE = '1';
const STAKE = '1000';
const CONTENT_LIMIT = 65_536;
const FILLER_VALUE_TEXT = 'siblings-256-filler';
const MARKER_DATA = { listingId: FIXTURE.listingId, version: FIXTURE.version, revoked: true };

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const byIdentity = (a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
const bitAt = (bytes, index) => (bytes[index >> 3] >> (7 - (index & 7))) & 1;

/** Stops the run with a reason; nothing has been written when this throws. */
function refuse(reason) {
  throw new Error(`revocation proof vectors not written: ${reason}`);
}

function checkPinnedSources() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== NODE_COMMIT) refuse(`node checkout is at ${head}, not ${NODE_COMMIT}`);
  for (const [path, digest] of Object.entries(SOURCE_DIGESTS)) {
    if (sha256Hex(readFileSync(path)) !== digest) refuse(`${path} does not have the pinned digest`);
  }
}

function outputPaths() {
  const flag = process.argv.indexOf('--output');
  const output = flag === -1 ? undefined : process.argv[flag + 1];
  if (!output || !output.endsWith('.json')) refuse('pass --output <path>.json');
  if (relative(process.cwd(), process.argv[1]) !== SCRIPT_PATH) refuse(`run this file as ${SCRIPT_PATH} from the node checkout`);
  return { output, manifestPath: output.replace(/\.json$/, '.manifest.json'), command: `bun run ${SCRIPT_PATH} --output ${output}` };
}

/** The pinned node functions the vectors are built and checked with, loaded after the source digests match. */
const pinned = {};

async function loadPinnedNode() {
  Object.assign(pinned,
    await import('src/libs/consensus/v2/quorum'),
    await import('src/libs/consensus/v2/commitLock/messages'),
    await import('src/libs/crypto/canonicalJson'),
    await import('src/libs/crypto/jcs'),
    await import('src/libs/crypto/merkle/sparse'),
    await import('src/libs/blockchain/finality/storageRecord'),
    await import('src/libs/blockchain/finality/validatorSetRecord'),
    await import('src/libs/blockchain/finality/verify'));
}

// ---- signers and validator sets ----

function newSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { identity: `0x${raw.toString('hex')}`, privateKey };
}

const newSigners = (count) => Array.from({ length: count }, newSigner).sort(byIdentity);
const validatorOf = (signer, status = ACTIVE, validAt = 0) => ({ identity: signer.identity, stake: STAKE, status, validAt });
const validatorSet = (entries) => [...entries].sort(byIdentity);
const identities = (signers) => signers.map((signer) => signer.identity);

function signText(signer, text) {
  return sign(null, Buffer.from(text, 'utf8'), signer.privateKey).toString('hex');
}

// ---- storage rows and trees ----

function fixtureRow(change = {}) {
  const transaction = sha256Hex('fixture marker create transaction');
  return {
    storageAddress: FIXTURE.storageAddress, owner: FIXTURE.owner, programName: FIXTURE.programName, encoding: 'json',
    data: MARKER_DATA, sizeBytes: Buffer.byteLength(JSON.stringify(MARKER_DATA)), acl: null, metadata: null,
    createdByTx: transaction, lastModifiedByTx: transaction, isDeleted: false, ...change,
  };
}

function otherRow(label) {
  const data = { label };
  const transaction = sha256Hex(`${label} transaction`);
  return {
    storageAddress: `stor-${sha256Hex(label).slice(0, 40)}`, owner: FIXTURE.owner, programName: label.replaceAll(' ', '-'),
    encoding: 'json', data, sizeBytes: Buffer.byteLength(JSON.stringify(data)), acl: null, metadata: null,
    createdByTx: transaction, lastModifiedByTx: transaction, isDeleted: false,
  };
}

const keyOf = (address) => pinned.storageProgramKey(address);

/** `count` other programs, found by a fixed search, whose keys satisfy `accepts`. */
function otherRows(label, count, accepts = () => true) {
  const rows = [];
  for (let index = 0; rows.length < count; index += 1) {
    if (index > 4096) refuse(`no ${label} rows found`);
    const row = otherRow(`${label} ${index}`);
    if (accepts(keyOf(row.storageAddress))) rows.push(row);
  }
  return rows;
}

const treeOf = (rows) => pinned.SparseMerkleTree.build(rows.map((row) => ({ key: keyOf(row.storageAddress), valueHash: pinned.storageProgramLeafHex(row) })));

function entryOf(tree, rows, address) {
  const row = rows.find((candidate) => candidate.storageAddress === address);
  return { storageAddress: address, record: row ? pinned.storageProgramRecord(row) : null, ...tree.prove(keyOf(address)) };
}

// ---- blocks, headers and replies ----

function blockOf(number, content, size) {
  let body = content;
  if (size !== undefined) {
    const unpadded = Buffer.byteLength(JSON.stringify({ ...content, padding: '' }));
    if (unpadded > size) refuse(`block ${number} is already over ${size} bytes`);
    body = { ...content, padding: 'p'.repeat(size - unpadded) };
  }
  const contentBytes = JSON.stringify(body);
  if (size !== undefined && Buffer.byteLength(contentBytes) !== size) refuse(`block ${number} is not ${size} bytes`);
  return { number, hash: sha256Hex(contentBytes), contentBytes };
}

function committedFields({ root, validators, peerlist }) {
  return { native_tables_hashes: { native_storage_programs: root }, peerlist, validator_set_hash: pinned.validatorSetHash(validators) };
}

function blocksOf(spec) {
  const committed = committedFields(spec);
  const parent = blockOf(PARENT_NUMBER, {
    number: PARENT_NUMBER, previousHash: sha256Hex(`fixture block ${PARENT_NUMBER - 1}`), timestamp: PARENT_TIMESTAMP, ...committed,
  }, spec.parentSize);
  const anchor = blockOf(PARENT_NUMBER + 1, {
    number: PARENT_NUMBER + 1, previousHash: parent.hash, timestamp: ANCHOR_TIMESTAMP, ...committed,
  }, spec.anchorSize);
  return { parent, anchor };
}

const signedMessageOf = (block, round, commitLock) => (commitLock ? pinned.precommitMessage(block.number, round, block.hash) : block.hash);

function certify(block, signers, { round = DEFAULT_ROUND, commitLock = true } = {}) {
  const signedMessage = signedMessageOf(block, round, commitLock);
  const signatures = {};
  for (const signer of signers) signatures[signer.identity] = signText(signer, signedMessage);
  return { ...block, round: commitLock ? round : null, signedMessage, signatures };
}

/** The header with `removed`'s signature taken out and `signer`'s, over the same message, put in. */
function swapSignature(header, removed, signer, spelling = signer.identity) {
  const signatures = { ...header.signatures };
  delete signatures[removed.identity];
  signatures[spelling] = signText(signer, header.signedMessage);
  return { ...header, signatures };
}

function headOf(header, timestamp) {
  const { number, hash, signatures, round, signedMessage } = header;
  return {
    number, hash, timestamp, ageSeconds: 0, nodeSynced: true, checkedThroughBlock: number,
    signatureCount: Object.keys(signatures).length, signatures, round, signedMessage,
  };
}

/** A signed one-entry storage proof and its pin, from a validator group, a tree and the proved address. */
function signedProof(spec) {
  const commitLock = spec.commitLock ?? true;
  const tree = spec.tree ?? treeOf(spec.rows);
  const { parent, anchor } = blocksOf({ ...spec, root: tree.rootHex });
  const header = certify(anchor, spec.signers, { round: spec.round, commitLock });
  const entries = spec.entries ?? [entryOf(tree, spec.rows, spec.address ?? FIXTURE.storageAddress)];
  const reply = { anchor: header, anchorParent: parent, asOfBlock: parent.number, proofs: entries };
  const rules = { shardSize: spec.shardSize, commitLock, ...(spec.committee ? { committee: spec.committee } : {}) };
  const pin = { checkpoint: { height: parent.number, blockHash: parent.hash }, trusted: { validators: spec.validators }, rules };
  return { reply, pin };
}

const withHead = ({ reply, pin }) => ({ reply, head: headOf(reply.anchor, ANCHOR_TIMESTAMP), pin });
const withHeader = ({ reply, pin }, header) => ({ reply: { ...reply, anchor: header }, pin });

/** `size` active validators who all sign, with every one in the peerlist. */
function fullGroup(size) {
  const signers = newSigners(size);
  return { signers, validators: validatorSet(signers.map((signer) => validatorOf(signer))), peerlist: identities(signers), shardSize: size };
}

/** A control signed by `quorum` eligible signers and the variant with one of them swapped for `outsider`. */
function signerFilterPair(base, quorumSigners, outsider) {
  const control = signedProof({ ...base, signers: quorumSigners });
  const excluded = withHeader(control, swapSignature(control.reply.anchor, quorumSigners[0], outsider));
  return { control: withHead(control), excluded };
}

// ---- the named vectors ----

function membershipVectors(base) {
  const others = otherRows('other program', 3);
  const rows = [fixtureRow(), ...others];
  const sibling = signedProof({ ...base, rows });
  if (sibling.reply.proofs[0].siblings.length < 1) refuse('membership-sibling has no sibling');
  const deleted = signedProof({ ...base, rows: [fixtureRow({ isDeleted: true }), ...others] });
  const acl = signedProof({ ...base, rows: [fixtureRow({ acl: { mode: 'restricted', allowed: [FIXTURE.owner] } }), ...others] });
  return { sibling, deleted, acl, rows };
}

function nonMembershipVectors(base) {
  const target = keyOf(FIXTURE.storageAddress);
  const firstBit = bitAt(target, 0);
  const secondBit = bitAt(target, 1);
  const empty = signedProof({ ...base, rows: otherRows('empty-path program', 3, (key) => bitAt(key, 0) !== firstBit) });
  if (empty.reply.proofs[0].terminal.kind !== 'empty') refuse('nonmembership-empty does not end at an empty terminal');
  const otherLeafRows = [
    ...otherRows('shared-prefix program', 1, (key) => bitAt(key, 0) === firstBit && bitAt(key, 1) === secondBit),
    ...otherRows('left-branch program', 1, (key) => bitAt(key, 0) !== firstBit),
    ...otherRows('near-branch program', 1, (key) => bitAt(key, 0) === firstBit && bitAt(key, 1) !== secondBit),
  ];
  const otherLeaf = signedProof({ ...base, rows: otherLeafRows });
  const { terminal, siblings } = otherLeaf.reply.proofs[0];
  if (terminal.kind !== 'leaf' || siblings.length < 2) refuse('nonmembership-other-leaf is not a leaf at depth 2 or more');
  return { empty, otherLeaf };
}

function headVectors(base, sibling, rows) {
  const committed = committedFields({ ...base, root: treeOf(rows).rootHex });
  const newer = blockOf(PARENT_NUMBER + 2, {
    number: PARENT_NUMBER + 2, previousHash: sibling.reply.anchor.hash, timestamp: NEWER_TIMESTAMP, ...committed,
  });
  return {
    matching: withHead(sibling),
    stale: { reply: sibling.reply, head: headOf(certify(newer, base.signers), NEWER_TIMESTAMP), pin: sibling.pin },
  };
}

function nonceCompetingVector(base, rows) {
  const tree = treeOf(rows);
  const competing = signedProof({ ...base, rows, tree });
  const { reply } = competing;
  const proofs = { 7: reply, 8: { ...reply, proofs: [entryOf(tree, rows, FIXTURE.competingStorageAddress)] } };
  return { ...withHead(competing), proofs };
}

function bareHashVectors(base, rows) {
  const bare = signedProof({ ...base, rows, commitLock: false });
  const header = bare.reply.anchor;
  const wrongMessage = { ...header, signedMessage: pinned.precommitMessage(header.number, DEFAULT_ROUND, header.hash) };
  return { bare: withHead(bare), wrongMessage: withHeader(bare, wrongMessage) };
}

function poolVectors(rows) {
  const group = fullGroup(5);
  const proof = signedProof({ ...group, rows, shardSize: 4 });
  const committee = identities(group.signers.slice(0, 4));
  return { noCommittee: proof, validCommittee: withHead({ reply: proof.reply, pin: { ...proof.pin, rules: { ...proof.pin.rules, committee } } }) };
}

function signerVectors(rows) {
  const vectors = {};
  {
    const [inactive, ...active] = newSigners(5);
    const validators = validatorSet([...active.map((signer) => validatorOf(signer)), validatorOf(inactive, INACTIVE)]);
    const base = { validators, peerlist: identities([inactive, ...active]), shardSize: 5, rows };
    vectors.inactive = signerFilterPair(base, active, inactive);
  }
  {
    const [late, ...valid] = newSigners(5);
    const validators = validatorSet([...valid.map((signer) => validatorOf(signer)), validatorOf(late, ACTIVE, PARENT_NUMBER + 100)]);
    const base = { validators, peerlist: identities([late, ...valid]), shardSize: 5, rows };
    vectors.notYetValid = signerFilterPair(base, valid, late);
  }
  {
    const [outside, ...inside] = newSigners(5);
    const base = { validators: validatorSet([outside, ...inside].map((signer) => validatorOf(signer))), peerlist: identities(inside), shardSize: 5, rows };
    vectors.peerlist = signerFilterPair(base, inside, outside);
  }
  {
    const all = newSigners(5);
    const base = { validators: validatorSet(all.map((signer) => validatorOf(signer))), peerlist: identities(all.slice(0, 2)), shardSize: 5, rows };
    vectors.fallback = withHead(signedProof({ ...base, signers: all.slice(1, 5) }));
  }
  {
    const group = fullGroup(4);
    const quorum = group.signers.slice(0, 3);
    const control = signedProof({ ...group, rows, signers: quorum });
    const repeated = quorum[1];
    const header = swapSignature(control.reply.anchor, quorum[2], repeated, repeated.identity.slice(2));
    vectors.duplicate = { control: withHead(control), repeated: withHeader(control, header) };
  }
  {
    const all = newSigners(7);
    const active = all.slice(0, 5);
    const inactive = all.slice(5);
    const validators = validatorSet([...active.map((signer) => validatorOf(signer)), ...inactive.map((signer) => validatorOf(signer, INACTIVE))]);
    const base = { validators, peerlist: identities(all), shardSize: 7, committee: identities(all), rows };
    vectors.committee = signerFilterPair(base, active, inactive[0]);
  }
  return vectors;
}

function stakedOverShardVector(rows) {
  const group = fullGroup(6);
  const peerlist = identities(group.signers.slice(0, 5));
  return withHead(signedProof({ ...group, peerlist, shardSize: 5, signers: group.signers.slice(0, 4), rows }));
}

function nullStatusVector(rows) {
  const [idle, ...active] = newSigners(5);
  const validators = validatorSet([...active.map((signer) => validatorOf(signer)), { identity: idle.identity, stake: STAKE, status: null, validAt: null }]);
  return withHead(signedProof({ validators, peerlist: identities(active), shardSize: 5, signers: active, rows }));
}

function sizeVectors(base, rows) {
  const sized = (change) => signedProof({ ...base, rows, ...change });
  return {
    anchorAt: withHead(sized({ anchorSize: CONTENT_LIMIT })),
    anchorOver: sized({ anchorSize: CONTENT_LIMIT + 1 }),
    parentAt: withHead(sized({ parentSize: CONTENT_LIMIT })),
    parentOver: sized({ parentSize: CONTENT_LIMIT + 1 }),
  };
}

function countVectors(rows) {
  const signing = fullGroup(256);
  const signaturesAt = signedProof({ ...signing, rows });
  const header = signaturesAt.reply.anchor;
  const stranger = newSigner();
  const signaturesOver = withHeader(signaturesAt, { ...header, signatures: { ...header.signatures, [stranger.identity]: signText(stranger, header.signedMessage) } });
  const quorumOf = (group) => group.signers.slice(0, pinned.quorumThreshold(group.shardSize));
  const validating = fullGroup(256);
  const validatorsAt = signedProof({ ...validating, rows, signers: quorumOf(validating) });
  const larger = fullGroup(257);
  const validatorsOver = signedProof({ ...larger, rows, signers: quorumOf(larger) });
  return { signaturesAt: withHead(signaturesAt), signaturesOver, validatorsAt: withHead(validatorsAt), validatorsOver };
}

function siblingVectors(base) {
  const row = fixtureRow();
  const provedKey = keyOf(row.storageAddress);
  const fillerKey = Uint8Array.from(provedKey);
  fillerKey[31] ^= 1;
  const tree = pinned.SparseMerkleTree.build([
    { key: provedKey, valueHash: pinned.storageProgramLeafHex(row) },
    { key: fillerKey, valueHash: sha256Hex(FILLER_VALUE_TEXT) },
  ]);
  const entry = { storageAddress: row.storageAddress, record: pinned.storageProgramRecord(row), ...tree.prove(provedKey) };
  if (entry.siblings.length !== 256) refuse('siblings-256-control does not have 256 siblings');
  const control = signedProof({ ...base, tree, entries: [entry] });
  const longer = { ...entry, siblings: [...entry.siblings, '00'.repeat(32)] };
  return { control: withHead(control), over: { reply: { ...control.reply, proofs: [longer] }, pin: control.pin } };
}

/** Every named vector, in the designed order, with the verdict rule and disposition each is built for. */
function namedVectors() {
  const base = fullGroup(4);
  const membership = membershipVectors(base);
  const { rows } = membership;
  const absent = nonMembershipVectors(base);
  const heads = headVectors(base, membership.sibling, rows);
  const bare = bareHashVectors(base, rows);
  const pool = poolVectors(rows);
  const signer = signerVectors(rows);
  const sizes = sizeVectors(base, rows);
  const counts = countVectors(rows);
  const siblings = siblingVectors(base);
  return [
    ['membership-sibling', withHead(membership.sibling), 'final', 'present'],
    ['membership-deleted', withHead(membership.deleted), 'final', 'present'],
    ['membership-acl', withHead(membership.acl), 'final', 'present'],
    ['nonmembership-empty', absent.empty, 'final', 'unproven'],
    ['nonmembership-other-leaf', absent.otherLeaf, 'final', 'unproven'],
    ['head-matching', heads.matching, 'final', 'present'],
    ['head-stale', heads.stale, 'final', 'unproven'],
    ['nonce-competing', nonceCompetingVector(base, rows), { 7: 'final', 8: 'final' }, { 7: 'present', 8: 'unproven' }],
    ['commit-lock', withHead(signedProof({ ...base, rows, round: COMMIT_LOCK_ROUND })), 'final', 'present'],
    ['bare-hash', bare.bare, 'final', 'present'],
    ['bare-hash-wrong-message', bare.wrongMessage, 'not-final', 'unproven'],
    ['pool-large-no-committee', pool.noCommittee, 'indeterminate', 'unproven'],
    ['pool-large-valid-committee', pool.validCommittee, 'final', 'present'],
    ['signer-inactive-control', signer.inactive.control, 'final', 'present'],
    ['signer-inactive-excluded', signer.inactive.excluded, 'not-final', 'unproven'],
    ['signer-not-yet-valid-control', signer.notYetValid.control, 'final', 'present'],
    ['signer-not-yet-valid-excluded', signer.notYetValid.excluded, 'not-final', 'unproven'],
    ['signer-peerlist-control', signer.peerlist.control, 'final', 'present'],
    ['signer-peerlist-excluded', signer.peerlist.excluded, 'not-final', 'unproven'],
    ['peerlist-fallback-control', signer.fallback, 'final', 'present'],
    ['duplicate-signer-control', signer.duplicate.control, 'final', 'present'],
    ['duplicate-signer-repeated', signer.duplicate.repeated, 'not-final', 'unproven'],
    ['committee-active-control', signer.committee.control, 'final', 'present'],
    ['committee-inactive-excluded', signer.committee.excluded, 'not-final', 'unproven'],
    ['staked-over-shard-trusted-parent', stakedOverShardVector(rows), 'final', 'present'],
    ['validator-null-status-control', nullStatusVector(rows), 'final', 'present'],
    ['anchor-65536-control', sizes.anchorAt, 'final', 'present'],
    ['anchor-65537-over', sizes.anchorOver, 'recorded', 'unproven'],
    ['parent-65536-control', sizes.parentAt, 'final', 'present'],
    ['parent-65537-over', sizes.parentOver, 'recorded', 'unproven'],
    ['signatures-256-control', counts.signaturesAt, 'final', 'present'],
    ['signatures-257-over', counts.signaturesOver, 'recorded', 'unproven'],
    ['validators-256-control', counts.validatorsAt, 'final', 'present'],
    ['validators-257-over', counts.validatorsOver, 'recorded', 'unproven'],
    ['siblings-256-control', siblings.control, 'final', 'present'],
    ['siblings-257-over', siblings.over, 'invalid', 'unproven'],
  ];
}

// ---- the node verdict gate ----

function nodeVerdict(reply, pin, { lookup = true } = {}) {
  const { checkpoint } = pin;
  const trustedBlockHash = (height) => (height === checkpoint.height ? checkpoint.blockHash : undefined);
  return pinned.verifyStorageProof(reply, pin.trusted, { ...pin.rules, ...(lookup ? { trustedBlockHash } : {}) }).verdict;
}

function admits(rule, verdict) {
  if (rule === 'recorded') return ['final', 'invalid', 'indeterminate'].includes(verdict);
  if (rule === 'not-final') return verdict === 'invalid' || verdict === 'indeterminate';
  return verdict === rule;
}

function gate(name, vector, rule) {
  if (typeof rule === 'object') {
    const verdicts = Object.fromEntries(Object.keys(rule).map((nonce) => [nonce, nodeVerdict(vector.proofs[nonce], vector.pin)]));
    for (const [nonce, verdict] of Object.entries(verdicts)) if (!admits(rule[nonce], verdict)) refuse(`${name} nonce ${nonce} is ${verdict}`);
    return { nodeVerdict: verdicts };
  }
  const verdict = nodeVerdict(vector.reply, vector.pin);
  if (!admits(rule, verdict)) refuse(`${name} is ${verdict}, designed ${rule}`);
  if (name !== 'staked-over-shard-trusted-parent') return { nodeVerdict: verdict };
  const noLookupVerdict = nodeVerdict(vector.reply, vector.pin, { lookup: false });
  if (noLookupVerdict !== 'indeterminate') refuse(`${name} without the checkpoint lookup is ${noLookupVerdict}`);
  return { nodeVerdict: verdict, noLookupVerdict };
}

// ---- encoder cases: SDK-written inputs, node outputs ----

const SAFE = Number.MAX_SAFE_INTEGER;
const ENCODER_INPUTS = [
  ['sdk-null', 'json', null],
  ['sdk-true', 'json', true],
  ['sdk-false', 'json', false],
  ['sdk-zero', 'json', 0],
  ['sdk-negative', 'json', -42],
  ['sdk-max-safe', 'json', SAFE],
  ['sdk-min-safe', 'json', -SAFE],
  ['sdk-empty-text', 'json', ''],
  ['sdk-ascii', 'json', 'listing revoked'],
  ['sdk-decomposed-value', 'json', 'Café menu'],
  ['sdk-astral-value', 'json', 'lock \u{1F512} key'],
  ['sdk-controls', 'json', 'tab\tline\nnul\u0000bell\u0007end\u001f'],
  ['sdk-empty-array', 'json', []],
  ['sdk-empty-object', 'json', {}],
  ['sdk-nested', 'json', { seller: { claims: [3, { revoked: true, at: null }], name: 'n' }, listing: [[], {}] }],
  ['sdk-decomposed-key', 'json', { 'Café': 1 }],
  ['sdk-composed-key', 'json', { 'Café': 1 }],
  ['sdk-composed-key-order', 'json', { z: 1, 'é': 2, a: 3 }],
  ['sdk-decomposed-key-order', 'json', { f: 1, 'é': 2, e: 3 }],
  ['sdk-astral-key-order', 'json', { 'ﬁ': 1, '\u{1F600}': 2, a: 3 }],
  ['sdk-numeric-key-order', 'json', { 10: 'ten', 9: 'nine', 1: 'one', a: 'letter' }],
  ['sdk-value-key-normalization', 'json', { 'Café': 'Café', 'Café': 'Café' }],
  ['sdk-fraction', 'json', 1.5],
  ['sdk-above-safe', 'json', SAFE + 1],
  ['sdk-below-safe', 'json', -(SAFE + 1)],
  ['sdk-nan', 'nan', null],
  ['sdk-infinity', 'infinity', null],
  ['sdk-bigint', 'bigint', null],
  ['sdk-cycle', 'cycle', null],
  ['sdk-undefined', 'undefined', null],
];
const JCS_REFUSED = new Set(['sdk-fraction', 'sdk-above-safe', 'sdk-below-safe']);

function valueOfForm(form, input) {
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

function encoderOutcome(encode, value) {
  try {
    return { ok: true, text: encode(value) };
  } catch {
    return { ok: false };
  }
}

function encoderCases() {
  return ENCODER_INPUTS.map(([name, form, input]) => {
    const value = valueOfForm(form, input);
    const encoded = { name, form, input, jcs: encoderOutcome(pinned.jcsCanonicalize, value), canonicalJson: encoderOutcome(pinned.canonicalJson, value) };
    if (encoded.jcs.ok === (JCS_REFUSED.has(name) || form !== 'json')) refuse(`node jcs outcome for ${name} is not the designed one`);
    if (encoded.canonicalJson.ok !== (form === 'json')) refuse(`node canonicalJson outcome for ${name} is not the designed one`);
    return encoded;
  });
}

// ---- writing ----

function documents(command) {
  const named = namedVectors();
  const vectors = {};
  const verdicts = {};
  for (const [name, vector, rule, sdkDisposition] of named) {
    vectors[name] = vector;
    verdicts[name] = { ...gate(name, vector, rule), sdkDisposition };
  }
  const fileText = `${JSON.stringify({ fixture: FIXTURE, encoderCases: encoderCases(), vectors }, null, 2)}\n`;
  const stored = JSON.parse(fileText);
  const manifest = {
    nodeCommit: NODE_COMMIT, command, exitStatus: 0, sourceDigests: SOURCE_DIGESTS, fileSha256: sha256Hex(fileText),
    required: named.map(([name]) => name),
    vectors: Object.fromEntries(named.map(([name]) => {
      const { nodeVerdict: verdict, noLookupVerdict, sdkDisposition } = verdicts[name];
      const digest = sha256Hex(JSON.stringify(stored.vectors[name]));
      return [name, { sha256: digest, nodeVerdict: verdict, ...(noLookupVerdict ? { noLookupVerdict } : {}), sdkDisposition }];
    })),
    encoderCases: Object.fromEntries(stored.encoderCases.map((encoded) => [encoded.name, { sha256: sha256Hex(JSON.stringify(encoded)) }])),
  };
  return { fileText, manifestText: `${JSON.stringify(manifest, null, 2)}\n` };
}

const { output, manifestPath, command } = outputPaths();
checkPinnedSources();
await loadPinnedNode();
const { fileText, manifestText } = documents(command);
writeFileSync(output, fileText);
writeFileSync(manifestPath, manifestText);
