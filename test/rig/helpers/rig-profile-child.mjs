// A real Node process, compiled package bytes, no source-rewriting loader.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const [name, second] = process.argv.slice(2);
assert.deepEqual(process.execArgv, []);
assert(!/kit-guard-fixture\.mjs|kit-client\/test-loader\.mjs/.test(process.env.NODE_OPTIONS ?? ''));
if (process.env.RIG_PRELOAD_MARKER) assert.equal(globalThis.rigHarmlessPreload, process.env.RIG_PRELOAD_MARKER);
const wire = await import('@kynesyslabs/dacs/wire');
const { KIT_OPERATION_GUARD, assertKitOperationAdmitted } = await import('./node_modules/@kynesyslabs/dacs-seller/src/kit-operation-guard.mjs');
const { PURCHASE_ADMISSION } = await import('./node_modules/@kynesyslabs/dacs-client/src/dacs/purchase-admission-state.mjs');
// Always establish the shipped constants BEFORE exercising any boundary.
assert.equal(KIT_OPERATION_GUARD, 'off');
assert.equal(PURCHASE_ADMISSION, 'held');
const record = wire.RIG_IDENTITY_RECORD;
assert.deepEqual(record, {
  format: 'dacs-rig-identity-record/v1', recordId: 'dacs-demos-rig-identity/2026-11-08', network: 'demos-rig',
  profile: { id: 'dacs-rig-tp1', revision: 'TP-1', base: 'd45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20' },
  chainIdentity: '26f74217d02edb713bb2affb694a5ad38c40e0edaf71c793c75321f42c1f6e71',
  genesisFileSha256: '5444bfbe73018e31c40a964da577c9a75ebb85e42d03b3db64094c3b0e47a721',
  pinVersion: 'dacs-demos-rig-identity/2026-11-08', sourceKind: 'confirmed-block-one-predecessor',
  documentation: "Private four-validator rig, frozen genesis 2026-11-08. Numeric block 0 returns the reviewed literal error; resolve identity from confirmed block 1 content.previousHash. Check continuation with the selected run's block-two hash.",
  deployment: { commit: 'e6af8f4023fa4e77f482503dae97f1ca00834bf9', dirty: false,
    artifactSha256: record.deployment.artifactSha256, qualifiedOperations: ['fee', 'nonce', 'broadcast', 'confirmation'] },
});
assert(record.documentation.length > 0 && record.documentation.length <= 512);
assert.equal('rigDeploymentPin' in wire, false);
assert.equal('RIG_RECORD_SHA256' in wire, false);
for (const selection of [undefined, null, {}, record, new Proxy({}, {})]) {
  assert.throws(() => wire.rigProfileRecord(selection), error => error.code === 'rig_selection_required');
}
for (const value of [record, record.profile, record.deployment, record.deployment.qualifiedOperations]) assert(Object.isFrozen(value));
const sha = text => createHash('sha256').update(text).digest('hex');
const jcs = value => value && typeof value === 'object' ? Array.isArray(value)
  ? `[${value.map(jcs).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}` : JSON.stringify(value);
const incomplete = record.deployment.artifactSha256 === null;
const recordSha256 = sha(jcs(record));
if (!incomplete) assert.match(record.deployment.artifactSha256, /^[0-9a-f]{64}$/);
assert.equal(wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, 'd59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc');
assert(!wire.TP1_APPROVED_IDENTITY_RECORD_DIGESTS.includes(recordSha256));
assert.equal(wire.rigProfileSelected(), false);
assert.equal('unselectRigProfile' in wire, false);
const effects = { transaction: 0, wire: 0, discovery: 0, delegation: 0, broadcasts: 0 };
const local = { endpoint: 'https://rig.invalid/', transportAuthority: 'TEST-rig', connectionId: 'rig-connection' };
const buyer = `did:demos:agent:${'a'.repeat(64)}`, seller = `did:demos:agent:${'b'.repeat(64)}`;
const runHash = 'c'.repeat(64);
const input = () => ({ recordSha256, acknowledgement: 'PRIVATE FOUR-NODE RIG ONLY', runBlockTwoHash: runHash });
const select = () => wire.selectRigProfile(input());
const tp1Profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION,
  chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: wire.TP1_APPROVED_IDENTITY_RECORD.pinVersion };
const rigProfile = { ...record.profile, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
const readTp1 = scope => ({ local: scope.local, chainIdentity: tp1Profile.chainIdentity, provenance: 'TEST-authority',
  sessionId: scope.sessionId, participants: scope.participants.map(claim => ({ claim, profile: tp1Profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) });
const bindTp1 = (readAuthority = readTp1) => wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local, readAuthority });
const code = expected => error => { assert.equal(error.code, expected); return true; };
const failSelection = (value, expected) => {
  assert.throws(() => wire.selectRigProfile(value), expected ? code(expected) : undefined);
  assert.equal(wire.rigProfileSelected(), false);
};
function sourceFixture(selection) {
  const pins = { network: record.network, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion,
    endpoint: local.endpoint, transportAuthority: local.transportAuthority };
  const source = { pins, runBlockTwoHash: selection.runBlockTwoHash,
    demoArtifactPublication: { policy: 'dacs-devnet-demo-artifacts/v1', authority: 'TEST-RUN-rig-12345678',
      artifactKinds: ['CompositeVerificationRecord', 'Deliverable', 'FinalityCommitmentRecord', 'Listing', 'SettlementEvidence'] },
    settlementPublication: { artifactKind: 'SettlementEvidence', authority: 'TEST-RUN-rig-12345678', phase: 'pay-dem',
      phaseIndex: 2, policy: 'dacs-native-settlement-publication/v1', railId: 'demos-native:DEM' },
    deliveryPublication: { artifactKind: 'Deliverable', authority: 'TEST-RUN-rig-12345678', phase: 'deliver-storage-program',
      phaseIndex: 3, policy: 'dacs-native-delivery-publication/v1' },
    observeBinding() { return observation(); } };
  source.transportBinding = { source: 'devnet-agreement-transport/v1', bindingVersion: 'dacs-demos-network-binding/v1',
    bindingId: sha(JSON.stringify(['dacs-demos-network-binding/v1', ...['network','chainIdentity','pinVersion','endpoint','transportAuthority'].map(k => pins[k])])),
    ...pins, settlementPublication: source.settlementPublication, deliveryPublication: source.deliveryPublication,
    demoArtifactPublication: source.demoArtifactPublication };
  let observation = () => ({ bindingVersion: 'dacs-demos-network-binding/v1',
    bindingId: sha(JSON.stringify(['dacs-demos-network-binding/v1', ...['network','chainIdentity','pinVersion','endpoint','transportAuthority'].map(k => pins[k])])),
    ...pins, connectionId: local.connectionId, source: { kind: record.sourceKind, blockNumber: 1, blockHash: 'd'.repeat(64), fallbackDocumentation: record.documentation },
    observedAt: Date.now(), expiresAt: Date.now() + 10000 });
  return { source, setObservation(fn) { observation = fn; }, observe: () => observation(),
    register() { wire.registerRigSource({ selection, source, kind: 'demo', buyer, seller }); },
    bind() { return wire.bindRigProfile({ selection, source, local }); } };
}
async function refuseSign(binding, expected) {
  const signer = domain => ({ claim: buyer, sign() { effects[domain]++; return new Uint8Array(64); } });
  await assert.rejects(wire.signWireEnvelope({}, { binding, local, purchaseProfile: null, signer: signer('wire') }), code(expected));
  await assert.rejects(wire.signDiscoveryDocument({}, signer('discovery'), binding, local), code(expected));
  await assert.rejects(wire.signSellerSessionDelegation({}, signer('delegation'), binding, local), code(expected));
}
const needsSelection = new Set(['selected', 'duplicate', 'identities', 'authority', 'deadline', 'reset', 'kinds', 'unregistered']);
if (needsSelection.has(name) && incomplete) {
  failSelection(input(), 'rig_record_incomplete');
  process.stdout.write(JSON.stringify({ blocked: 'operator image digest missing; shipped seed cannot select' }));
} else {
  if (name === 'defaults' || name === 'runner-environment') {
    const sellerApi = await import('@kynesyslabs/dacs-seller');
    const clientApi = await import('@kynesyslabs/dacs-client');
    assert.throws(() => sellerApi.createSellerAgentClient({}), code('kit_operation_guard_off'));
    assert.throws(() => clientApi.createProtocolPurchases({}));
    assert.throws(() => assertKitOperationAdmitted('rig-probe'), code('kit_operation_guard_off'));
    assert.equal(wire.rigProfileSelected(), false);
  } else if (name === 'invalid') {
    let touched = 0;
    const proxy = new Proxy(input(), { ownKeys() { touched++; throw Error('proxy trap'); }, get() { touched++; throw Error('get trap'); } });
    const accessor = Object.defineProperty(input(), 'acknowledgement', { get() { touched++; return 'PRIVATE FOUR-NODE RIG ONLY'; } });
    const inherited = Object.create(input());
    const exotic = Object.assign(Object.create({ extra: true }), input());
    const revoked = Proxy.revocable(input(), {}); revoked.revoke();
    for (const value of [undefined, null, [], 'on', {}, inherited, exotic, proxy, revoked.proxy, accessor,
      { ...input(), extra: true }, { ...input(), extra: undefined }, { ...input(), [Symbol('extra')]: true },
      { ...input(), recordSha256: undefined }, { ...input(), acknowledgement: 'private four-node rig only' },
      { ...input(), acknowledgement: 'PRIVATE FOUR-NODE RIG ONLY ' }, { ...input(), recordSha256: 'A'.repeat(64) },
      { ...input(), recordSha256: sha('unapproved record') },
      ...[undefined, null, 2, '', 'a'.repeat(63), 'A'.repeat(64), '0'.repeat(65)].map(runBlockTwoHash => ({ ...input(), runBlockTwoHash }))]) failSelection(value);
    assert.equal(touched, 0);
    if (incomplete) {
      failSelection(input(), 'rig_record_incomplete');
      failSelection({ ...input(), recordSha256: sha(jcs(record)) }, 'rig_record_incomplete');
    }
    await bindTp1(); // Failed selection did not reserve either mode.
  } else if (name === 'tp1-first' || name === 'tp1-cross') {
    const binding = await bindTp1();
    await wire.assertTp1Binding(binding, local);
    failSelection(input(), 'tp1_binding_active');
    if (name === 'tp1-cross') {
      await assert.rejects(wire.assertPeerProfile(rigProfile, binding), code('tp1_profile_mismatch'));
      await assert.rejects(wire.assertPurchaseProfile(rigProfile, binding), code('tp1_purchase_profile_mismatch'));
    }
    await wire.assertTp1Binding(binding, local);
  } else if (name === 'pending' || name === 'pending-success') {
    let settle, scope;
    const pending = bindTp1(value => { scope = value; return new Promise((resolve, reject) => { settle = { resolve, reject }; }); });
    failSelection(input(), 'tp1_binding_active');
    if (name === 'pending-success') {
      settle.resolve(readTp1(scope));
      await pending;
      failSelection(input(), 'tp1_binding_active');
    } else {
      let rejectSecond;
      const secondPending = bindTp1(() => new Promise((_, reject) => { rejectSecond = reject; }));
      const unavailable = Error('unavailable');
      settle.reject(unavailable);
      await assert.rejects(pending, error => error === unavailable);
      failSelection(input(), 'tp1_binding_active');
      rejectSecond(unavailable);
      await assert.rejects(secondPending, error => error === unavailable);
      if (incomplete) failSelection(input(), 'rig_record_incomplete');
      else { select(); await assert.rejects(bindTp1(), code('rig_selected')); }
    }
  } else if (name === 'closed-registry') {
    const awaitedCopy = await import(second);
    const { wire: copy } = awaitedCopy;
    assert.notEqual(copy.selectRigProfile, wire.selectRigProfile);
    assert.equal((await import(second)).KIT_OPERATION_GUARD, 'off');
    assert.equal((await import(second)).PURCHASE_ADMISSION, 'held');
    const fixture = sourceFixture({ runBlockTwoHash: runHash });
    assert.throws(() => fixture.register(), code('rig_selection_required'));
    assert.equal(wire.isRigSource(fixture.source), false);
    assert.equal(copy.isRigSource(fixture.source), false);
    await assert.rejects(fixture.bind(), code('rig_selection_required'));
    const binding = await bindTp1();
    await assert.rejects(copy.assertTp1Binding(binding, local), code('tp1_binding_required'));
    await assert.rejects(wire.assertTp1Binding({ ...binding }, local), code('tp1_binding_required'));
    assert.equal(copy.rigProfileSelected(), false);
    assert.throws(() => awaitedCopy.sellerApi.createSellerAgentClient({}), code('kit_operation_guard_off'));
    assert.throws(() => awaitedCopy.clientApi.createProtocolPurchases({}));
    await refuseSign({ ...binding }, 'tp1_binding_required');
  } else {
    const callerInput = input(), selection = wire.selectRigProfile(callerInput);
    assert(Object.isFrozen(selection));
    assert.equal(wire.rigProfileRecord(selection), record);
    assert.throws(() => wire.rigProfileRecord({ ...selection }), code('rig_selection_required'));
    assert.throws(() => wire.rigProfileRecord(new Proxy(selection, {})), code('rig_selection_required'));
    callerInput.runBlockTwoHash = 'e'.repeat(64);
    assert.equal(selection.runBlockTwoHash, runHash);
    assert.equal(wire.rigProfileSelected(), true);
    assert.throws(select, code('rig_already_selected'));
    assert.throws(() => wire.selectRigProfile({}), code('rig_already_selected'));
    await assert.rejects(bindTp1(), code('rig_selected'));
    const fixture = sourceFixture(selection);
    fixture.register();
    const binding = await fixture.bind();
    assert(Object.isFrozen(binding) && Object.isFrozen(binding.profile));
    await wire.assertTp1Binding(binding, local);
    if (name === 'unregistered') {
      let observed = 0;
      const lookalike = { ...fixture.source, observeBinding() { observed++; return fixture.observe(); } };
      await assert.rejects(wire.bindRigProfile({ selection, source: lookalike, local }), code('rig_source_required'));
      assert.equal(observed, 0);
    } else if (name === 'kinds') {
      assert.equal(wire.isRigSource(fixture.source, 'demo'), true);
      assert.equal(wire.isRigSource(fixture.source, 'agreement'), false);
      assert.equal(wire.isRigSource(fixture.source, 'wrong'), false);
      for (const kind of [undefined, null, 'wrong', 'agreement']) {
        const wrong = sourceFixture(selection).source;
        assert.throws(() => wire.registerRigSource({ selection, source: wrong, kind, buyer, seller }), code('rig_source_invalid'));
        assert.equal(wire.isRigSource(wrong), false);
      }
      const agreement = sourceFixture(selection).source;
      for (const field of ['demoArtifactPublication', 'settlementPublication', 'deliveryPublication']) {
        delete agreement[field]; delete agreement.transportBinding[field];
      }
      wire.registerRigSource({ selection, source: agreement, kind: 'agreement', buyer, seller });
      assert.equal(wire.isRigSource(agreement, 'agreement'), true);
      assert.equal(wire.isRigSource(agreement, 'demo'), false);
      await wire.bindRigProfile({ selection, source: agreement, local });
      assert.throws(() => wire.registerRigSource({ selection, source: agreement, kind: 'demo', buyer, seller }), code('rig_source_invalid'));
      assert.equal(wire.isRigSource(agreement, 'agreement'), true);
    } else if (name === 'duplicate') {
      const awaitedCopy = await import(second);
      const { wire: copy } = awaitedCopy;
      assert.notEqual(copy.selectRigProfile, wire.selectRigProfile);
      assert.equal((await import(second)).KIT_OPERATION_GUARD, 'off');
      assert.equal((await import(second)).PURCHASE_ADMISSION, 'held');
      assert.equal(copy.rigProfileSelected(), false);
      assert.throws(() => awaitedCopy.sellerApi.createSellerAgentClient({}), code('kit_operation_guard_off'));
      assert.throws(() => awaitedCopy.clientApi.createProtocolPurchases({}));
      assert.throws(() => copy.rigProfileRecord(selection), code('rig_selection_required'));
      assert.equal(copy.isRigSource(fixture.source), false);
      assert.throws(() => copy.registerRigSource({ selection, source: fixture.source, kind: 'demo', buyer, seller }), code('rig_selection_required'));
      await assert.rejects(copy.bindRigProfile({ selection, local, source: fixture.source }), code('rig_selection_required'));
      await assert.rejects(copy.assertTp1Binding(binding, local), code('tp1_binding_required'));
      const tp1 = await copy.bindTp1Profile({ record: copy.TP1_APPROVED_IDENTITY_RECORD, local, readAuthority: readTp1 });
      await assert.rejects(wire.assertTp1Binding(tp1, local), code('tp1_binding_required'));
    } else if (name === 'identities') {
      await assert.rejects(wire.assertPeerProfile(tp1Profile, binding), code('tp1_profile_mismatch'));
      await assert.rejects(wire.assertPurchaseProfile(tp1Profile, binding), code('tp1_purchase_profile_mismatch'));
      const original = fixture.observe();
      for (const identity of [tp1Profile.chainIdentity, ...wire.TP1_REFUSED_CHAIN_IDENTITIES, ...wire.TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES,
        sha('arbitrary unequal synthetic identity'), sha('SYNTHETIC mainnet-labelled unequal identity, not a measured mainnet hash'),
        ...Array.from({ length: 1000 }, (_, i) => sha(`synthetic unequal identity ${i}`))]) {
        assert.notEqual(identity, record.chainIdentity);
        const wrongSource = sourceFixture(selection);
        wrongSource.source.pins.chainIdentity = identity;
        assert.throws(() => wrongSource.register(), code('identity_mismatch'));
        fixture.setObservation(() => ({ ...original, chainIdentity: identity }));
        await assert.rejects(fixture.bind(), code('identity_mismatch'));
        await refuseSign(binding, 'identity_mismatch');
      }
    } else if (name === 'authority') {
      for (const endpoint of ['http://rig.invalid/', 'https://user:password@rig.invalid/', 'https://rig.invalid/?query=1', 'https://rig.invalid/#fragment', 'https://rig.invalid/path']) {
        const wrongSource = sourceFixture(selection);
        wrongSource.source.pins.endpoint = endpoint;
        assert.throws(() => wrongSource.register(), code('rig_source_invalid'));
        assert.equal(wire.isRigSource(wrongSource.source), false);
      }
      for (const policy of [{}, { ...fixture.source.demoArtifactPublication, authority: 'TEST-unscoped' },
        { ...fixture.source.demoArtifactPublication, artifactKinds: ['Listing'] }, { ...fixture.source.demoArtifactPublication, policy: 'wrong' }]) {
        const wrongSource = sourceFixture(selection);
        wrongSource.source.demoArtifactPublication = policy;
        assert.throws(() => wrongSource.register(), code('rig_source_invalid'));
      }
      for (const field of ['settlementPublication', 'deliveryPublication', 'transportBinding']) {
        const wrongSource = sourceFixture(selection);
        wrongSource.source[field] = {};
        assert.throws(() => wrongSource.register(), code('rig_source_invalid'));
      }
      await assert.rejects(wire.bindRigProfile({ selection: { ...selection }, local, source: fixture.source }), code('rig_selection_required'));
      for (const lookalike of [{ ...fixture.source }, JSON.parse(JSON.stringify(fixture.source))]) {
        assert.equal(wire.isRigSource(lookalike), false);
        await assert.rejects(wire.bindRigProfile({ selection, local, source: lookalike }), code('rig_source_required'));
      }
      const session = '01J00000000000000000000000';
      await wire.assertTp1Authority(binding, local, [buyer, seller], session);
      await wire.assertTp1Authority(binding, local, [buyer], 'dacs-seller-discovery/v1');
      await assert.rejects(wire.assertTp1Authority(binding, local, [`did:demos:agent:${'e'.repeat(64)}`], 'dacs-seller-discovery/v1'), code('tp1_participant_profile_mismatch'));
      await assert.rejects(wire.assertTp1Authority(binding, local, [buyer, buyer], session), code('tp1_participant_profile_mismatch'));
      await assert.rejects(wire.assertTp1Binding(binding, { ...local, connectionId: 'changed' }), code('tp1_local_binding_changed'));
      const original = fixture.observe();
      for (const delta of [{ network: 'demos-testnet' }, { endpoint: 'https://changed.invalid/' }, { transportAuthority: 'wrong' }, { connectionId: 'wrong' },
        { observedAt: Date.now() + 100000 }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 100000 }]) {
        fixture.setObservation(() => ({ ...original, ...delta }));
        await assert.rejects(fixture.bind(), code('rig_connection_unverified'));
        await refuseSign(binding, 'rig_connection_unverified');
      }
      for (const bad of [null, {}, { ...original, chainIdentity: null }, { ...original, chainIdentity: [record.chainIdentity] }]) {
        fixture.setObservation(() => bad);
        await assert.rejects(fixture.bind(), code('identity_mismatch'));
      }
      const unavailable = Error('authority unavailable');
      fixture.setObservation(() => { throw unavailable; });
      await assert.rejects(fixture.bind(), error => error === unavailable);
      fixture.setObservation(() => original);
      fixture.source.demoArtifactPublication.authority = 'TEST-unscoped';
      assert.equal(wire.isRigSource(fixture.source), false);
      await refuseSign(binding, 'rig_source_required');
    } else if (name === 'deadline') {
      let reply;
      const original = fixture.observe();
      fixture.setObservation(() => new Promise(resolve => { reply = resolve; }));
      await assert.rejects(fixture.bind(), code('rig_connection_unverified'));
      reply(original); // A late completion must not brand an object or unblock a signer.
      await new Promise(resolve => setImmediate(resolve));
      await refuseSign({ ...binding }, 'tp1_binding_required');
    } else if (name === 'reset') {
      const original = fixture.observe();
      let currentRun = runHash;
      fixture.setObservation(() => {
        if (currentRun !== selection.runBlockTwoHash) throw new wire.WireError('identity_mismatch', 500);
        return original;
      });
      currentRun = 'e'.repeat(64); // Backend continuation's run-N+1 observation.
      await refuseSign(binding, 'identity_mismatch');
      assert.throws(() => wire.selectRigProfile({ ...input(), runBlockTwoHash: currentRun }), code('rig_already_selected'));
      fixture.source.runBlockTwoHash = currentRun;
      assert.equal(wire.isRigSource(fixture.source), false);
      await refuseSign(binding, 'rig_source_required');
    }
    assert.equal(wire.rigProfileSelected(), true);
  }
  assert.deepEqual(effects, { transaction: 0, wire: 0, discovery: 0, delegation: 0, broadcasts: 0 });
  process.stdout.write(JSON.stringify({ passed: name }));
}
