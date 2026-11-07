// The read-only role's minted signer checks the TP-1 binding when it is minted, and its sign() checks the
// authority again for the job or discovery session it signs for; the wire signers that use it check too
// (signDiscoveryDocument and signWireResponse assert the binding before they call signer.sign). These tests pin
// that a binding revoked or changed after the role was minted produces no signature, through those signers or
// through the minted role itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL, cryptoCalls, discoveryPayload, importSellerKey, keyFixture, openOptions, refusalOf, requestPayload, responsePayload, wire } from './helpers/seller-key-fixture.mjs';

const { openSellerKey } = await importSellerKey();
const guard = await import('../src/kit-operation-guard.mjs');
const NOW = 1793102400000;
const READ_BODY = '{"status":"signed"}';
const REFUSAL_BODY = '{"error":"operation_uncertain"}';

async function revocableBinding() {
  const record = wire.TP1_APPROVED_IDENTITY_RECORD;
  const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
  const state = { revoked: false };
  const readAuthority = (scope) => {
    if (state.revoked) throw new Error('TEST authority revoked');
    return { local: { ...scope.local }, chainIdentity: profile.chainIdentity, provenance: 'test-only-independent-authority/v1',
      sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) };
  };
  return { state, binding: await wire.bindTp1Profile({ record, local: LOCAL, readAuthority }) };
}

/** A binding whose reader reads its answer from files in `directory`, which another process may write: `revoked`, and `connection` (the connection id it reports). */
async function fileBackedBinding(directory) {
  const record = wire.TP1_APPROVED_IDENTITY_RECORD;
  const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
  const readAuthority = (scope) => {
    if (existsSync(join(directory, 'revoked'))) throw new Error('TEST authority revoked by another process');
    const connectionFile = join(directory, 'connection');
    const connectionId = existsSync(connectionFile) ? readFileSync(connectionFile, 'utf8') : scope.local.connectionId;
    return { local: { ...scope.local, connectionId }, chainIdentity: profile.chainIdentity, provenance: 'test-only-independent-authority/v1',
      sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) };
  };
  return wire.bindTp1Profile({ record, local: LOCAL, readAuthority });
}

/** Writes `text` to `file` from another process, as another program on this machine would. */
function writeFromAnotherProcess(file, text) {
  const child = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', file, text], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
}

async function openAdmittedKey(t) {
  guard.setKitOperationGuardForTest('testnet-tp1');
  const key = await openSellerKey(openOptions(keyFixture(t)));
  t.after(() => { guard.setKitOperationGuardForTest('testnet-tp1'); key.close(); });
  return key;
}

/** One role of each read-only purpose minted under `binding`, each with the exact bytes it would sign. */
async function mintedRoles(key, binding) {
  const answer = (path, status, body) => wire.wireEnvelopeSigningBytes(responsePayload(requestPayload(binding, path), status, body));
  return {
    discovery: [await key.readOnlyAnswerSigner({ purpose: 'discovery', binding, local: LOCAL }), wire.discoverySigningBytes(discoveryPayload(binding))],
    'read answer': [await key.readOnlyAnswerSigner({ purpose: 'read-answer', binding, local: LOCAL, body: READ_BODY }), answer(wire.DACS_SELLER_HTTP_PATHS.state, 200, READ_BODY)],
    refusal: [await key.readOnlyAnswerSigner({ purpose: 'refusal', binding, local: LOCAL, body: REFUSAL_BODY }), answer(wire.DACS_SELLER_HTTP_PATHS.proposals, 503, REFUSAL_BODY)],
  };
}

async function assertMintedRolesSignNothing(roles, label) {
  const before = cryptoCalls.signs;
  for (const [name, [role, bytes]] of Object.entries(roles)) {
    assert.equal((await refusalOf(() => role.sign(bytes)))?.code, 'seller_key_role_refused', `${label}: the minted ${name} role refuses`);
  }
  assert.equal(cryptoCalls.signs - before, 0, `${label}: nothing reached the cryptographic signer`);
}

test('a read-only role minted under a binding that is then revoked signs no discovery document and no read answer through the wire signers', async (t) => {
  const key = await openAdmittedKey(t);
  const { state, binding } = await revocableBinding();
  const discovery = await key.readOnlyAnswerSigner({ purpose: 'discovery', binding, local: LOCAL });
  const answer = await key.readOnlyAnswerSigner({ purpose: 'read-answer', binding, local: LOCAL, body: READ_BODY });
  // Control: the same calls with roles minted alongside sign while the binding is current.
  const control = cryptoCalls.signs;
  await wire.signDiscoveryDocument(discoveryPayload(binding), await key.readOnlyAnswerSigner({ purpose: 'discovery', binding, local: LOCAL }), binding, LOCAL);
  await wire.signWireResponse(requestPayload(binding, wire.DACS_SELLER_HTTP_PATHS.state), 200, READ_BODY,
    { signer: await key.readOnlyAnswerSigner({ purpose: 'read-answer', binding, local: LOCAL, body: READ_BODY }), binding, local: LOCAL, now: NOW, purchaseProfile: binding.profile });
  assert.equal(cryptoCalls.signs - control, 2, 'both signers sign under the current binding');
  state.revoked = true;
  const before = cryptoCalls.signs;
  await assert.rejects(wire.signDiscoveryDocument(discoveryPayload(binding), discovery, binding, LOCAL));
  await assert.rejects(wire.signWireResponse(requestPayload(binding, wire.DACS_SELLER_HTTP_PATHS.state), 200, READ_BODY,
    { signer: answer, binding, local: LOCAL, now: NOW, purchaseProfile: binding.profile }));
  assert.equal(cryptoCalls.signs - before, 0, 'nothing reached the cryptographic signer after the binding was revoked');
});

test('a read-only role minted for one local connection signs nothing through the wire signers for another', async (t) => {
  const key = await openAdmittedKey(t);
  const { binding } = await revocableBinding();
  const discovery = await key.readOnlyAnswerSigner({ purpose: 'discovery', binding, local: LOCAL });
  const before = cryptoCalls.signs;
  await assert.rejects(wire.signDiscoveryDocument(discoveryPayload(binding), discovery, binding, { ...LOCAL, connectionId: 'another-conn' }));
  assert.equal(cryptoCalls.signs - before, 0, 'nothing reached the cryptographic signer under a changed local connection');
});

test('an already-minted read-only role signs nothing when this process revokes the binding after the mint', async (t) => {
  const key = await openAdmittedKey(t);
  const { state, binding } = await revocableBinding();
  const roles = await mintedRoles(key, binding);
  state.revoked = true;
  await assertMintedRolesSignNothing(roles, 'revoked in this process');
});

test('an already-minted read-only role signs nothing when another process revokes the authority or reports another connection after the mint', async (t) => {
  const key = await openAdmittedKey(t);
  for (const [label, file, text] of [['revoked by another process', 'revoked', 'yes'], ['another connection reported', 'connection', 'another-conn']]) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-seller-key-authority-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const binding = await fileBackedBinding(directory);
    const roles = await mintedRoles(key, binding);
    writeFromAnotherProcess(join(directory, file), text);
    await assertMintedRolesSignNothing(roles, label);
  }
});
