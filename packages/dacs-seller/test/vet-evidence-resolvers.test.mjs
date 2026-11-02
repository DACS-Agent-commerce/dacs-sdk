// Strict Vet replay with a requirement that names a verified claim: the record
// passes only through the operator's authenticated VerifyResult, recipe and
// authority evidence, every read is bounded, and a failing reader keeps its cause.
import { sessionRegistrySnapshot, sessionRegistryFixture } from './helpers/session-registry-fixture.mjs';
import { fixtureIdentityBundle } from './fixtures/listings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import { sessionAdmissionConfig, vetRecordProblem } from '../src/dacs/session-admission.mjs';
import { buyer, seller, testWallet, JOB, NOW } from './helpers/protocol-fixture.mjs';

const resultSigner = testWallet(31), recipeSteward = testWallet(32);
// A self-certifying `key:<32-byte hex>` wallet: the canonical representation a
// recipe steward or VerifyResult signer may use instead of a Demos agent claim.
const keyWallet = (tag) => {
  const seed = new Uint8Array(32).fill(tag), privateKey = core.privateKeyFromSeed(seed);
  return { claim: `key:${Buffer.from(core.rawPublicKey(core.publicKeyFromSeed(seed))).toString('hex')}`, signBytes: (bytes) => Buffer.from(core.ed25519Sign(bytes, privateKey)) };
};
const requirement = { requirementVersion: '1', required: [{ scheme: 'domain', verificationRequired: true, recipeVersion: 1 }] };
const AUTHORITY_LOCATOR = 'https://authority.example/evidence-1';
const RESULT_LOCATOR = `dacs2:${JOB}:domain:alice.example:v1`;
const SESSION_REGISTRY_PIN = 'ab'.repeat(32);
const unpinnedRequirement = { requirementVersion: '1', required: [{ scheme: 'domain', verificationRequired: true }] };
const sign = (unsigned, separator, wallet) => core.signComponentArtifact(unsigned, separator, { algorithm: 'ed25519', signer: wallet.claim, sign: wallet.signBytes });

// A counterparty-signed record of `buyer` (verified by `seller`) whose requirement names one verified claim,
// with that claim's VerifyResult, recipe and authority content kept as an operator would hold them.
async function verifiedClaimFixture({ decision = 'pass', recipeVersion = 1, scheme = 'domain', identifier = 'alice.example', urlTemplate = 'https://authority.example/{identifier}', availability = 'live', defaultMethod = { kind: 'consensus-backed-proxy', endpoint: { method: 'GET', urlTemplate } }, list = 'dealSpecific', authority = 'canonical-json', bundleRequirement = requirement, data = { active: true }, party = buyer, verifier = seller, boundRequirement = bundleRequirement.required[0], bundleHash = core.sha256Hex('TEST evaluated bundle'), steward = recipeSteward, resultWallet = resultSigner } = {}) {
  const recipe = await sign({ recipeVersion, scheme, defaultMethod,
    defaultMaxAgeSec: 3600, parserRules: { format: 'json', successJsonPath: '$.active' }, retryClass: 'permanent', availability,
    governance: { proposedBy: steward.claim, acceptedAt: NOW - 1000, anchoring: 'single-signer' } }, 'dacs-recipe:v1:', steward);
  const authorityValue = { active: true };
  const authorityContent = authority === 'bytes'
    ? { encoding: 'bytes', value: Buffer.from('{"active":true}').toString('base64url'), hash: core.sha256Hex(Buffer.from('{"active":true}')) }
    : authority === 'empty-bytes'
      ? { encoding: 'bytes', value: '', hash: core.sha256Hex(new Uint8Array(0)) }
      : { encoding: 'canonical-json', value: authorityValue, hash: core.sha256Hex(core.canonicalize(authorityValue)) };
  const result = await sign({ resultVersion: '1', scheme, identifier, recipeVersion, method: defaultMethod.kind, decision,
    reason: 'authority confirmed the claim', attestation: { anchor: { kind: 'https', locator: AUTHORITY_LOCATOR }, contentHash: authorityContent.hash, signer: resultWallet.claim },
    data, fetchedAt: NOW - 20, verifiedAt: NOW - 10 }, 'dacs-verifyresult:v1:', resultWallet);
  const resultRef = { anchor: { kind: 'storage-program', locator: `dacs2:${JOB}:${scheme}:${identifier}:v${recipeVersion}` }, contentHash: core.contentHash(result), recipeVersion };
  const record = await sign({ recordVersion: '1', jobId: JOB, evaluatedParty: party.claim, bundleHash, requirementHash: core.sha256Hex(core.canonicalize(bundleRequirement)),
    freshness: list === 'freshness' ? [resultRef] : [], supplementary: [], dealSpecific: list === 'dealSpecific' ? [resultRef] : [], overallDecision: 'pass', generatedAt: NOW }, core.ARTIFACT_SEPARATORS.CompositeVerificationRecord, verifier);
  const ref = { anchor: { kind: 'storage-program', locator: core.compositeVerificationAddress(JOB, party.claim) }, contentHash: core.contentHash(record), signer: verifier.claim };
  const expected = [{ ref: resultRef, sourceJobId: JOB, scheme, identifier, method: defaultMethod.kind, requirement: boundRequirement }];
  const invocation = { vetRecordRef: ref, evaluatedParty: party.claim, requirement: bundleRequirement, verifier: verifier.claim, freshness: list === 'freshness' ? expected : [], dealSpecific: list === 'dealSpecific' ? expected : [] };
  const contents = new Map([[resultRef.anchor.locator, { encoding: 'canonical-json', value: result }],
    [AUTHORITY_LOCATOR, authorityContent.encoding === 'bytes' ? { encoding: 'bytes', value: authorityContent.value } : { encoding: 'canonical-json', value: authorityValue }]]);
  const calls = [];
  const evidence = {
    resolveContent: async (input) => { calls.push(['resolveContent', input]); return contents.has(input.anchor.locator) ? structuredClone(contents.get(input.anchor.locator)) : null; },
    resolveRecipe: async (input) => { calls.push(['resolveRecipe', input]); return input.scheme === recipe.scheme && input.recipeVersion === recipe.recipeVersion ? structuredClone(recipe) : sign({ ...core.stripSignature(recipe), scheme: input.scheme, recipeVersion: input.recipeVersion }, 'dacs-recipe:v1:', steward); },
    resolveLatestRecipe: async (input) => { calls.push(['resolveLatestRecipe', input]); return { sessionRecipeRegistrySnapshotHash: SESSION_REGISTRY_PIN, recipeVersion: recipe.recipeVersion, availability: 'live' }; },
    isRecipeSignerAuthorized: async ({ signature }) => signature.signer === steward.claim,
    isVerifyResultSignerAuthorized: async ({ signature }) => signature.signer === resultWallet.claim,
    verifyAuthorityAttestation: async ({ content }) => (content.encoding === 'bytes' ? Buffer.from(content.value).toString() === '{"active":true}' : content.value.active === true) ? 'valid' : 'invalid',
  };
  const replay = (overrides = {}) => vetRecordProblem(record, { ref, jobId: JOB, role: party === buyer ? 'buyer' : 'seller', party: party.claim, bundleHash, verifier: verifier.claim, invocation, now: () => NOW,
    evidence: { ...evidence, ...overrides.evidence }, ...overrides.input });
  return { record, ref, result, recipe, contents, calls, evidence, replay, invocation };
}

test('a record with a required verified claim passes with operator evidence', async () => {
  const fixture = await verifiedClaimFixture();
  assert.equal(await fixture.replay(), null);
});

test('a record whose authority content is raw bytes passes with operator evidence', async () => {
  const fixture = await verifiedClaimFixture({ authority: 'bytes' });
  assert.equal(await fixture.replay(), null);
});

test('a freshness VerifyResult is resolved the same way as a deal-specific one', async () => {
  const fixture = await verifiedClaimFixture({ list: 'freshness' });
  assert.equal(await fixture.replay(), null);
});

test('without vetEvidence a required verified claim stays refused', async () => {
  const fixture = await verifiedClaimFixture();
  const problem = await fixture.replay({ input: { evidence: undefined } });
  assert.match(problem, /pinned recipe evidence is unavailable/);
});

test('evidence reads name the job, role and party', async () => {
  const fixture = await verifiedClaimFixture();
  await fixture.replay();
  assert.ok(fixture.calls.length >= 3);
  for (const [, input] of fixture.calls) assert.deepEqual([input.jobId, input.role, input.party], [JOB, 'buyer', buyer.claim]);
});

test('a VerifyResult signer the operator does not authorize is refused', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { isVerifyResultSignerAuthorized: async () => false } }), /verify-result-signature/);
});

test('a non-true authorization answer does not authorize a VerifyResult signer', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { isVerifyResultSignerAuthorized: async () => 'yes' } }), /verify-result-signature/);
});

test('a recipe signer the operator does not authorize is refused', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { isRecipeSignerAuthorized: async () => false } }), /recipe-signature/);
});

test('content that does not hash to its reference is refused', async () => {
  const fixture = await verifiedClaimFixture();
  const other = await sign({ ...core.stripSignature(fixture.result), reason: 'another reason' }, 'dacs-verifyresult:v1:', resultSigner);
  const problem = await fixture.replay({ evidence: { resolveContent: async (input) => (input.anchor.locator === RESULT_LOCATOR ? { encoding: 'canonical-json', value: other } : fixture.contents.get(input.anchor.locator)) } });
  assert.match(problem, /verify-result-hash/);
});

test('an authority attestation the operator calls invalid is refused', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { verifyAuthorityAttestation: async () => 'invalid' } }), /authority-signature/);
});

test('an unrecognized authority verdict is refused rather than accepted', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { verifyAuthorityAttestation: async () => 'ok' } }), /authority-signature/);
});

test('a missing recipe is refused', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { resolveRecipe: async () => null } }), /pinned recipe is missing/);
});

test('missing VerifyResult content is refused', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { resolveContent: async () => null } }), /does not verify against its requirement/);
});

test('a malformed content reply is refused as a record problem with its cause', async () => {
  const fixture = await verifiedClaimFixture();
  assert.match(await fixture.replay({ evidence: { resolveContent: async () => ({ encoding: 'text', value: 'x' }) } }), /content reply is malformed/);
});

test('a throwing evidence reader keeps its cause', async () => {
  const fixture = await verifiedClaimFixture();
  const cause = Object.assign(new Error('TEST source timeout'), { code: 'ETIMEDOUT' });
  await assert.rejects(fixture.replay({ evidence: { resolveRecipe: async () => { throw cause; } } }), (error) => error === cause);
});

test('oversized evidence is held with its real cause', async () => {
  const fixture = await verifiedClaimFixture();
  await assert.rejects(fixture.replay({ evidence: { resolveContent: async () => ({ encoding: 'canonical-json', value: { padding: 'x'.repeat(65537) } }) } }), RangeError);
});

test('an evidence reader receives its byte limit and an abort signal', async () => {
  const fixture = await verifiedClaimFixture();
  let limits;
  await fixture.replay({ evidence: { resolveContent: async (input, options) => { limits = options; return fixture.evidence.resolveContent(input); } } });
  assert.equal(limits.maxBytes, 65536);
  assert.equal(limits.signal.aborted, true);
});

test('a stalled evidence read aborts at the read deadline', async (t) => {
  const fixture = await verifiedClaimFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let limits;
  const pending = fixture.replay({ evidence: { resolveContent: (_input, options) => { limits = options; return new Promise(() => {}); } } });
  const settled = assert.rejects(pending, { name: 'TimeoutError' });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10001);
  await settled;
  assert.equal(limits.signal.aborted, true);
});

test('a replay is bounded by its total deadline across reads', async (t) => {
  const fixture = await verifiedClaimFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = (reader) => async (...args) => { t.mock.timers.tick(9000); return reader(...args); };
  const slowEvidence = Object.fromEntries(Object.entries(fixture.evidence).map(([name, reader]) => [name, slow(reader)]));
  await assert.rejects(fixture.replay({ evidence: slowEvidence }), { name: 'TimeoutError', message: /Vet evidence deadline expired/ });
});

test('the total deadline aborts the read in flight instead of waiting for its per-read limit', async (t) => {
  const fixture = await verifiedClaimFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const slow = (reader) => async (...args) => { t.mock.timers.tick(5900); return reader(...args); };
  const evidence = {
    ...Object.fromEntries(Object.entries(fixture.evidence).map(([name, reader]) => [name, slow(reader)])),
    resolveContent: async (input, options) => {
      if (input.anchor.locator === AUTHORITY_LOCATOR) { signal = options.signal; return new Promise(() => {}); }
      t.mock.timers.tick(5900);
      return fixture.evidence.resolveContent(input);
    },
  };
  const pending = fixture.replay({ evidence });
  const settled = assert.rejects(pending, { name: 'TimeoutError', message: /Vet evidence deadline expired/ });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(7000);
  await settled;
  assert.ok(signal);
  assert.equal(signal.aborted, true);
});

test('an evidence reader that rejects with undefined is still an unavailable read', async () => {
  const fixture = await verifiedClaimFixture();
  let rejected = false, reason = 'sentinel';
  try { await fixture.replay({ evidence: { resolveContent: async () => { throw undefined; } } }); }
  catch (error) { rejected = true; reason = error; }
  assert.equal(rejected, true);
  assert.equal(reason, undefined);
});

test('a VerifyResult returned as canonical bytes passes', async () => {
  const fixture = await verifiedClaimFixture();
  const bytes = Buffer.from(core.canonicalize(fixture.result)).toString('base64url');
  assert.equal(await fixture.replay({ evidence: { resolveContent: async (input) => (input.anchor.locator === RESULT_LOCATOR ? { encoding: 'bytes', value: bytes } : fixture.contents.get(input.anchor.locator)) } }), null);
});

test('a VerifyResult byte document that is not JSON is refused as a record problem', async () => {
  const fixture = await verifiedClaimFixture();
  const value = Buffer.from('not-json').toString('base64url');
  const problem = await fixture.replay({ evidence: { resolveContent: async (input) => (input.anchor.locator === RESULT_LOCATOR ? { encoding: 'bytes', value } : fixture.contents.get(input.anchor.locator)) } });
  assert.match(problem, /content reply is malformed/);
});

test('an empty VerifyResult byte document is refused as a record problem', async () => {
  const fixture = await verifiedClaimFixture();
  const problem = await fixture.replay({ evidence: { resolveContent: async (input) => (input.anchor.locator === RESULT_LOCATOR ? { encoding: 'bytes', value: '' } : fixture.contents.get(input.anchor.locator)) } });
  assert.match(problem, /content reply is malformed/);
});

test('a byte-encoded VerifyResult cannot exceed the decoded collection limits', async () => {
  for (const data of [{ items: Array(257).fill(0) }, { groups: Array.from({ length: 17 }, () => Array(250).fill(0)) }]) {
    const fixture = await verifiedClaimFixture({ data });
    const bytes = Buffer.from(core.canonicalize(fixture.result)).toString('base64url');
    await assert.rejects(fixture.replay({ evidence: { resolveContent: async (input) => (input.anchor.locator === RESULT_LOCATOR ? { encoding: 'bytes', value: bytes } : fixture.contents.get(input.anchor.locator)) } }), RangeError);
  }
});

test('a canonical-json VerifyResult cannot exceed the decoded collection limits', async () => {
  for (const data of [{ items: Array(257).fill(0) }, { groups: Array.from({ length: 17 }, () => Array(250).fill(0)) }]) {
    const fixture = await verifiedClaimFixture({ data });
    await assert.rejects(fixture.replay(), RangeError);
  }
});

test('an empty raw authority attestation passes', async () => {
  const fixture = await verifiedClaimFixture({ authority: 'empty-bytes' });
  assert.equal(await fixture.replay({ evidence: { verifyAuthorityAttestation: async ({ content }) => (content.encoding === 'bytes' && content.value.length === 0 ? 'valid' : 'invalid') } }), null);
});

test('a parameterized required claim passes only when its exact parameters match the result', async () => {
  const claim = { ...requirement.required[0], parameters: { jurisdiction: 'GB' } };
  const bundleRequirement = { requirementVersion: '1', required: [claim] };
  const fixture = await verifiedClaimFixture({ bundleRequirement, data: { active: true, jurisdiction: 'GB' } });
  assert.equal(await fixture.replay(), null);
  const mismatched = await verifiedClaimFixture({ bundleRequirement: { requirementVersion: '1', required: [{ ...claim, parameters: { jurisdiction: 'DE' } }] }, data: { active: true, jurisdiction: 'GB' } });
  assert.match(await mismatched.replay(), /requirement-parameters/);
});

async function registryFor(f, { headVersion = f.recipe.recipeVersion, availability = 'live', entries } = {}) {
  const head = await sign({ ...core.stripSignature(f.recipe), recipeVersion: headVersion, availability,
    governance: { ...f.recipe.governance, ...(headVersion !== f.recipe.recipeVersion ? { supersedes: f.recipe.recipeVersion } : {}) } }, 'dacs-recipe:v1:', recipeSteward);
  return sessionRegistrySnapshot(JOB, 'verified', entries ?? (headVersion === f.recipe.recipeVersion ? [head] : [f.recipe, head]), recipeSteward);
}

async function replayTwoResults(a, b, sessionSnapshot, extraRecipes = []) {
  const invocation = { ...a.invocation, dealSpecific: [...a.invocation.dealSpecific, ...b.invocation.dealSpecific] };
  const record = await sign({ ...core.stripSignature(a.record), dealSpecific: [...a.record.dealSpecific, ...b.record.dealSpecific] }, core.ARTIFACT_SEPARATORS.CompositeVerificationRecord, seller);
  const contents = new Map([...a.contents, ...b.contents]), ref = { ...a.ref, contentHash: core.contentHash(record) };
  const recipes = new Map([a.recipe, b.recipe, ...extraRecipes].map(recipe => [`${recipe.scheme}/${recipe.defaultMethod.kind}/${recipe.recipeVersion}`, recipe]));
  const evidence = { ...a.evidence, resolveContent: async ({ anchor }) => contents.get(anchor.locator) ?? null,
    resolveRecipe: async ({ scheme, method, recipeVersion }) => recipes.get(`${scheme}/${method}/${recipeVersion}`) ?? null };
  return vetRecordProblem(record, { ref, jobId: JOB, role: 'buyer', party: buyer.claim, bundleHash: record.bundleHash, verifier: seller.claim, invocation, now: () => NOW, evidence, sessionSnapshot });
}

test('one replay resolves distinct implicit families from one authenticated snapshot', async () => {
  const first = { scheme: 'domain', verificationRequired: true }, second = { scheme: 'email', verificationRequired: true };
  const bundleRequirement = { requirementVersion: '1', required: [first, second] };
  const a = await verifiedClaimFixture({ bundleRequirement, boundRequirement: first });
  const b = await verifiedClaimFixture({ bundleRequirement, boundRequirement: second, scheme: 'email', identifier: 'alice@example.test' });
  const sessionSnapshot = await registryFor(a, { entries: [a.recipe, b.recipe] });
  assert.equal(await replayTwoResults(a, b, sessionSnapshot), null);
  assert.notEqual(await replayTwoResults(a, b, await registryFor(a)), null);
});

for (const required of [false, true]) for (const decision of ['pass', 'error', 'indeterminate']) test(`a stale ${decision} result from another family is unsatisfied, required=${required}`, async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1 }, implicit = { scheme: 'email', verificationRequired: true };
  const bundleRequirement = { requirementVersion: '1', ...(required ? { required: [pinned, implicit] } : { required: [], oneOf: [[pinned, implicit]] }) };
  const a = await verifiedClaimFixture({ bundleRequirement, boundRequirement: pinned });
  const b = await verifiedClaimFixture({ bundleRequirement, boundRequirement: implicit, scheme: 'email', identifier: 'alice@example.test', decision });
  const head = await sign({ ...core.stripSignature(b.recipe), recipeVersion: 2, governance: { ...b.recipe.governance, supersedes: 1 } }, 'dacs-recipe:v1:', recipeSteward);
  const problem = await replayTwoResults(a, b, await registryFor(a, { entries: [a.recipe, b.recipe, head] }));
  if (required) assert.match(problem, /not the latest live recipe version/); else assert.equal(problem, null);
});

test('one job resolves both party records against one authenticated snapshot', async () => {
  const a = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  const b = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement, party: seller, verifier: buyer });
  const sessionSnapshot = await registryFor(a), pins = [];
  assert.equal(await a.replay({ input: { sessionSnapshot, sessionRegistryPins: pins } }), null);
  assert.equal(await b.replay({ input: { sessionRegistryPins: pins } }), null);
  assert.match(await b.replay({ input: { sessionSnapshot: await registryFor(b, { headVersion: 2 }), sessionRegistryPins: pins } }), /another session registry snapshot/);
});

for (const list of ['freshness', 'dealSpecific']) for (const decision of ['pass', 'error', 'indeterminate']) test(`stale bound implicit ${list} ${decision} result is unsatisfied`, async () => {
  const f = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement, list, decision });
  assert.match(await f.replay({ input: { sessionSnapshot: await registryFor(f, { headVersion: 2 }) } }), /not the latest live recipe version/);
});

for (const jurisdiction of ['DE', 'GB']) test(`a projected implicit alternative is qualified at the snapshot head: ${jurisdiction}`, async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1, parameters: { jurisdiction: 'DE' } };
  const implicit = { scheme: 'domain', verificationRequired: true, parameters: { jurisdiction: 'GB' } };
  const f = await verifiedClaimFixture({ bundleRequirement: { requirementVersion: '1', required: [], oneOf: [[pinned, implicit]] }, boundRequirement: pinned, data: { active: true, jurisdiction } });
  const problem = await f.replay({ input: { sessionSnapshot: await registryFor(f, { headVersion: 2 }) } });
  if (jurisdiction === 'DE') assert.equal(problem, null); else assert.match(problem, /not the latest live recipe version/);
});

test('a current result projected onto an unpinned alternative passes from snapshot evidence', async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1, parameters: { jurisdiction: 'DE' } };
  const implicit = { scheme: 'domain', verificationRequired: true, parameters: { jurisdiction: 'GB' } };
  const f = await verifiedClaimFixture({ bundleRequirement: { requirementVersion: '1', required: [], oneOf: [[pinned, implicit]] }, boundRequirement: pinned, data: { active: true, jurisdiction: 'GB' } });
  assert.equal(await f.replay({ input: { sessionSnapshot: await registryFor(f) } }), null);
});

test('a recipe steward using a canonical key: claim passes operator evidence', async () => {
  const fixture = await verifiedClaimFixture({ steward: keyWallet(41) });
  assert.equal(await fixture.replay(), null);
});

test('a VerifyResult signer using a canonical key: claim passes operator evidence', async () => {
  const fixture = await verifiedClaimFixture({ resultWallet: keyWallet(42) });
  assert.equal(await fixture.replay(), null);
});

test('a key: VerifyResult signer whose signature does not verify is refused', async () => {
  const claimed = keyWallet(43), actual = keyWallet(44);
  const fixture = await verifiedClaimFixture({ resultWallet: { claim: claimed.claim, signBytes: actual.signBytes } });
  // The operator authorizes the claimed signer; the signature still has to
  // verify under the key that claim names.
  assert.match(await fixture.replay({ evidence: { isVerifyResultSignerAuthorized: async ({ signature }) => signature.signer === claimed.claim } }), /verify-result-signature/);
});

test('agent configuration refuses the direct replay helper capability',()=>{
 const admission=Object.fromEntries(['admit','resolveVetRecord','readVetAnchorReceipt','verifyVetAnchorReceipt','readRevocationSurfaces','readRevocationMarker'].map(name=>[name,async()=>null]));
 assert.equal(sessionAdmissionConfig(admission),admission);
 const complete=Object.fromEntries(['resolveContent','resolveRecipe','isRecipeSignerAuthorized','isVerifyResultSignerAuthorized','verifyAuthorityAttestation'].map(name=>[name,async()=>null]));
 for(const vetEvidence of [complete,{},undefined])for(const config of [{...admission,vetEvidence},Object.assign(Object.create({vetEvidence}),admission)])assert.throws(()=>sessionAdmissionConfig(config),/direct Vet replay helper/);
});

for (const [name, pinnedParameters, implicitParameters, urlTemplate] of [
  ['missing target binding', { jurisdiction: 'DE' }, undefined, 'https://authority.example/{identifier}/{jurisdiction}'],
  ['different target binding', { jurisdiction: 'DE' }, { jurisdiction: 'GB' }, 'https://authority.example/{identifier}/{jurisdiction}'],
  ['missing committed binding', undefined, { jurisdiction: 'GB' }, 'https://authority.example/{identifier}/{jurisdiction}'],
  ['projectable stale member', { jurisdiction: 'DE' }, { jurisdiction: 'DE' }],
  ['identified target', undefined, { identifier: 'bob' }],
  ['identified source', { identifier: 'bob' }],
]) test(`passing pinned alternative survives ${name} with authenticated authority`, async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1, ...(pinnedParameters ? { parameters: pinnedParameters } : {}) };
  const implicit = { scheme: 'domain', verificationRequired: true, ...(implicitParameters ? { parameters: implicitParameters } : {}) };
  const f = await verifiedClaimFixture({ bundleRequirement: { requirementVersion: '1', required: [], oneOf: [[pinned, implicit]] }, boundRequirement: pinned,
    data: { active: true, jurisdiction: 'DE', ...(pinnedParameters?.identifier ? { identifier: pinnedParameters.identifier } : {}) }, urlTemplate });
  assert.equal(await f.replay({ input: { sessionSnapshot: await registryFor(f, { headVersion: 2 }) } }), null);
  assert.match(await f.replay(), /runtime-authenticated job registry snapshot/);
});

test('a stale required member reached only by projection is unsatisfied', async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1 }, implicit = { scheme: 'domain', verificationRequired: true };
  const f = await verifiedClaimFixture({ bundleRequirement: { requirementVersion: '1', required: [pinned, implicit] }, boundRequirement: pinned });
  assert.match(await f.replay({ input: { sessionSnapshot: await registryFor(f, { headVersion: 2 }) } }), /not the latest live recipe version/);
});

test('one snapshot family qualifies each actual result version independently', async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1 }, implicit = { scheme: 'domain', verificationRequired: true };
  const bundleRequirement = { requirementVersion: '1', required: [pinned, implicit] };
  const a = await verifiedClaimFixture({ bundleRequirement, boundRequirement: pinned });
  const b = await verifiedClaimFixture({ bundleRequirement, boundRequirement: implicit, recipeVersion: 2 });
  assert.equal(await replayTwoResults(a, b, await registryFor(a, { headVersion: 2 })), null);
});

for (const pin of [undefined, 2]) for (const list of ['freshness', 'dealSpecific']) test(`unused family without a derivable method permits a pinned alternative, pin=${pin}, ${list}`, async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1 };
  const unknown = { scheme: 'email', verificationRequired: true, ...(pin === undefined ? {} : { recipeVersion: pin }) };
  const f = await verifiedClaimFixture({ list, bundleRequirement: { requirementVersion: '1', required: [], oneOf: [[pinned, unknown]] }, boundRequirement: pinned });
  assert.equal(await f.replay({ input: { sessionSnapshot: await registryFor(f) } }), null);
  if (pin === undefined) assert.match(await f.replay(), /runtime-authenticated job registry snapshot/);
});
for(const role of ['buyer','seller'])for(const issue of ['absent','wrong-version','wrong-scheme','disabled','failed','mocked','signature','unauthorized','method'])test(`unused explicit recipe pin is preflighted: ${role} ${issue}`,async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},unused={scheme:'domain',verificationRequired:true,recipeVersion:2};
 const f=await verifiedClaimFixture({party:role==='buyer'?buyer:seller,verifier:role==='buyer'?seller:buyer,bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[unused,pinned]]},boundRequirement:pinned});
 let recipe=await sign({...core.stripSignature(f.recipe),recipeVersion:2,...(issue==='wrong-scheme'?{scheme:'email'}:{}),...(['disabled','failed','mocked'].includes(issue)?{availability:issue}:{}),...(issue==='method'?{defaultMethod:{kind:'dns-txt'}}:{})},'dacs-recipe:v1:',recipeSteward);
 if(issue==='absent')recipe=null;if(issue==='wrong-version')recipe=f.recipe;if(issue==='signature')recipe.signature.value='TEST invalid recipe signature';
 const problem=await f.replay({evidence:{resolveRecipe:async selector=>selector.recipeVersion===2?recipe:f.recipe,isRecipeSignerAuthorized:async({recipe})=>issue!=='unauthorized'||recipe.recipeVersion!==2}});
 assert.notEqual(problem,null);
});
test('valid unused exact recipe pin is resolved once and does not veto a passing alternative',async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},unused={scheme:'domain',verificationRequired:true,recipeVersion:2};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,unused,{...unused,parameters:{jurisdiction:'GB'}}]]},boundRequirement:pinned}),calls=[];
 const recipe=await sign({...core.stripSignature(f.recipe),recipeVersion:2},'dacs-recipe:v1:',recipeSteward);
 assert.equal(await f.replay({evidence:{resolveRecipe:async selector=>{calls.push(selector.recipeVersion);return selector.recipeVersion===2?recipe:f.recipe;}}}),null);
 assert.equal(calls.filter(version=>version===2).length,1);
});
for (const availability of ['live', 'operator_gated', 'disabled', 'absent']) test(`unused implicit method family preflights snapshot authority: ${availability}`, async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1 };
  const unused = { scheme: 'email', verificationRequired: true, parameters: { verificationMethod: 'consensus-backed-proxy' } };
  const f = await verifiedClaimFixture({ bundleRequirement: { requirementVersion: '1', required: [], oneOf: [[pinned, unused]] }, boundRequirement: pinned });
  const email = await sign({ ...core.stripSignature(f.recipe), scheme: 'email', availability: availability === 'absent' ? 'live' : availability }, 'dacs-recipe:v1:', recipeSteward);
  const sessionSnapshot = await registryFor(f, { entries: [f.recipe, ...(availability === 'absent' ? [] : [email])] });
  const problem = await f.replay({ input: { sessionSnapshot } });
  if (availability === 'live') assert.equal(problem, null); else assert.notEqual(problem, null);
});

for(const field of ['parserRules','governance','defaultMaxAgeSec','retryClass','backoff','extra'])test(`unused explicit pin uses the core recipe shape check: ${field}`,async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},unused={scheme:'domain',verificationRequired:true,recipeVersion:2};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,unused]]},boundRequirement:pinned});
 const malformed=await sign({...core.stripSignature(f.recipe),recipeVersion:2,[field]:'TEST malformed field'},'dacs-recipe:v1:',recipeSteward);
 assert.notEqual(await f.replay({evidence:{resolveRecipe:async selector=>selector.recipeVersion===2?malformed:f.recipe}}),null);
});

for(const availability of ['mocked','disabled','failed'])test(`a bound non-operational pin refuses replay despite a passing alternative: ${availability}`,async()=>{
 const domain={scheme:'domain',verificationRequired:true,recipeVersion:1},email={scheme:'email',verificationRequired:true,recipeVersion:1},bundleRequirement={requirementVersion:'1',required:[],oneOf:[[domain,email]]};
 const a=await verifiedClaimFixture({bundleRequirement,boundRequirement:domain,availability}),b=await verifiedClaimFixture({bundleRequirement,boundRequirement:email,scheme:'email',identifier:'alice@example.test'});
 assert.match(await replayTwoResults(a,b),/mocked, disabled or failed/);
});
for(const availability of ['missing','mocked','live'])test(`bound pins preflight every same-scheme result method family: ${availability}`,async()=>{
 const first={scheme:'domain',verificationRequired:true,recipeVersion:1},second={scheme:'domain',verificationRequired:true,recipeVersion:2,parameters:{verificationMethod:'verifiable-credential'}},bundleRequirement={requirementVersion:'1',required:[first,second]};
 const a=await verifiedClaimFixture({bundleRequirement,boundRequirement:first}),b=await verifiedClaimFixture({bundleRequirement,boundRequirement:second,recipeVersion:2,identifier:'second.example',defaultMethod:{kind:'verifiable-credential'}});
 const extra=availability==='missing'?[]:[await sign({...core.stripSignature(a.recipe),defaultMethod:b.recipe.defaultMethod,availability},'dacs-recipe:v1:',recipeSteward)];
 const problem=await replayTwoResults(a,b,undefined,extra);
 if(availability==='live')assert.equal(problem,null);else assert.match(problem,/pinned recipe is missing, mocked, disabled or failed/);
});
for(const availability of ['operator_gated','closed_data','bilateral']){
 test(`a bound exact pin permits ${availability}`,async()=>{
  const f=await verifiedClaimFixture({availability});assert.equal(await f.replay(),null);
 });
 test(`an unused exact pin permits ${availability}`,async()=>{
  const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},unused={...pinned,recipeVersion:2};
  const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,unused]]},boundRequirement:pinned});
  const recipe=await sign({...core.stripSignature(f.recipe),recipeVersion:2,availability},'dacs-recipe:v1:',recipeSteward);
  assert.equal(await f.replay({evidence:{resolveRecipe:async selector=>selector.recipeVersion===2?recipe:f.recipe}}),null);
 });
}
test('bound pin preflight and strict replay share one exact recipe read',async()=>{
 const f=await verifiedClaimFixture();assert.equal(await f.replay(),null);
 assert.equal(f.calls.filter(([name,input])=>name==='resolveRecipe'&&input.scheme==='domain'&&input.method==='consensus-backed-proxy'&&input.recipeVersion===1).length,1);
});
for (const availability of ['operator_gated', 'closed_data', 'bilateral', 'mocked', 'disabled', 'failed']) test(`unused implicit head refuses ${availability} without falling back`, async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1 }, implicit = { scheme: 'domain', verificationRequired: true };
  const f = await verifiedClaimFixture({ bundleRequirement: { requirementVersion: '1', required: [], oneOf: [[pinned, implicit]] }, boundRequirement: pinned });
  assert.notEqual(await f.replay({ input: { sessionSnapshot: await registryFor(f, { headVersion: 2, availability }) } }), null);
});

test('strict seller replay agrees with the qualification evaluator across member and head selections',async()=>{
 const P1={scheme:'domain',verificationRequired:true,recipeVersion:1},P2={...P1,recipeVersion:2},I={scheme:'domain',verificationRequired:true};
 const shapes=[{required:[I]},{required:[P1]},{required:[I,P1]},{required:[I,P2]},
  ...[[P1,I],[P2,I],[P1,P2],[P1,P2,I]].map(group=>({required:[],oneOf:[group]})),
  {required:[I],oneOf:[[P1,P2]]},{required:[P1],oneOf:[[I,P2]]},{required:[P2],oneOf:[[I,P1]]}];
 const material=new Map();for(const version of [1,2])for(const decision of ['pass','error'])material.set(`${version}/${decision}`,await verifiedClaimFixture({recipeVersion:version,decision}));
 const base=material.get('1/pass'),signedRecipes=new Map();
 for(const version of [1,2])for(const availability of ['live','operator_gated','mocked'])signedRecipes.set(`${version}/${availability}`,await sign({...core.stripSignature(base.recipe),recipeVersion:version,availability,governance:{...base.recipe.governance,...(version===2?{supersedes:1}:{})}},'dacs-recipe:v1:',recipeSteward));
 const snapshots=new Map();
 for(const version of [1,2])for(const availability of ['live','operator_gated','mocked'])snapshots.set(`${version}/${availability}`,await registryFor(base,{entries:[...(version===2?[signedRecipes.get('1/live')]:[]),signedRecipes.get(`${version}/${availability}`)]}));
 let comparisons=0;
 for(const shape of shapes){
  const members=[...shape.required,...(shape.oneOf??[]).flat()],bindings=[];
  for(const member of members)for(const version of member.recipeVersion?[member.recipeVersion]:[1,2])bindings.push([{member,version}]);
  for(let a=0;a<members.length;a++)for(let b=a+1;b<members.length;b++)for(const versionA of members[a].recipeVersion?[members[a].recipeVersion]:[1,2])for(const versionB of members[b].recipeVersion?[members[b].recipeVersion]:[1,2])if(versionA!==versionB)bindings.push([{member:members[a],version:versionA},{member:members[b],version:versionB}]);
  for(const binding of bindings)for(let mask=0;mask<2**binding.length;mask++){
   const chosen=binding.map(({member,version},index)=>({member,version,...material.get(`${version}/${mask&(1<<index)?'error':'pass'}`)}));
   const requirement={requirementVersion:'1',...shape},refs=chosen.map(f=>f.record.dealSpecific[0]);
   const record=await sign({...core.stripSignature(base.record),requirementHash:core.sha256Hex(core.canonicalize(requirement)),dealSpecific:refs},core.ARTIFACT_SEPARATORS.CompositeVerificationRecord,seller);
   const ref={...base.ref,contentHash:core.contentHash(record)},contents=new Map(chosen.flatMap(f=>[...f.contents]));
   const invocation={...base.invocation,requirement,dealSpecific:chosen.map((f,index)=>({...f.invocation.dealSpecific[0],requirement:f.member,ref:refs[index]}))};
   for(const headVersion of [1,2])for(const availability of ['live','operator_gated','mocked']){
    const versions={...(headVersion===2?{'1':'live'}:{}),[String(headVersion)]:availability};
    const registry={recipeRegistryVersion:1,latestByFamily:{domain:{'consensus-backed-proxy':headVersion}},versionsByFamily:{domain:{'consensus-backed-proxy':versions}}};
    // Production authority authenticates the test closure; replay independently authenticates every signed artifact below.
    const evaluated=await core.evaluateClaimRequirementQualification({generatedAt:NOW,recordJobId:JOB,requirement:shape,resolvedResults:chosen.map(f=>f.result),aggregationAuthority:{kind:'production',sessionStart:'TEST-matrix-session',vetInput:{jobId:JOB,recipeRegistryVersion:1,sessionContext:{jobId:JOB,recipeRegistryVersion:1}}}},
     {resolveAuthenticatedSessionStart:()=>({jobId:JOB,recipeRegistryVersion:1}),authenticateProductionQualification:()=> 'valid',authenticateReplayBundle:()=>{throw Error('unexpected replay authority');},authenticateCompositeRecord:()=>{throw Error('unexpected replay authority');},authenticateVerifyResult:()=>{throw Error('unexpected replay authority');},resolveRecipeRegistry:()=>registry});
    const evidence={...base.evidence,resolveContent:async({anchor})=>contents.get(anchor.locator)??null,
     resolveRecipe:async({recipeVersion})=>{const state=versions[String(recipeVersion)];return state?signedRecipes.get(`${recipeVersion}/${state}`):null;},
     resolveLatestRecipe:async()=>{throw Error('operator head reader must not run');}};
    const actual=await vetRecordProblem(record,{ref,jobId:JOB,role:'buyer',party:buyer.claim,bundleHash:record.bundleHash,verifier:seller.claim,invocation,now:()=>NOW,evidence,sessionSnapshot:snapshots.get(`${headVersion}/${availability}`)});
    const label=JSON.stringify({shape,binding:chosen.map(f=>[f.member,f.version,f.result.decision]),headVersion,availability,evaluated,actual});
    if(actual===null)assert.equal(evaluated.decision,'pass',label);
    if(evaluated.decision==='pass'&&!chosen.some(f=>f.member.recipeVersion===undefined&&f.version!==headVersion))assert.equal(actual,null,label);
    comparisons++;
   }
  }
 }
 assert.ok(comparisons>400);
});

for (const list of ['freshness', 'dealSpecific']) for (const matches of [true, false]) test(`mixed ${list} uses snapshot entries regardless of operator selection hash: ${matches}`, async () => {
  const bundle = fixtureIdentityBundle(buyer, NOW);
  const member = { scheme: 'did', verificationRequired: false };
  const bundleRequirement = { ...unpinnedRequirement, required: [unpinnedRequirement.required[0], member] };
  const f = await verifiedClaimFixture({ list, bundleRequirement, bundleHash: core.identityBundleHash(bundle), steward: seller });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB);
  const problem = await f.replay({ input: { presence: { bundle, sessionSnapshot } }, evidence: {
    resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: matches ? sessionSnapshot.snapshotHash : SESSION_REGISTRY_PIN, recipeVersion: f.recipe.recipeVersion, availability: 'live' }),
  } });
  assert.equal(problem, null);
});

const snapshotMethod = 'consensus-backed-proxy';
async function snapshotReplayFixture({ version = 1, explicit = false, mixed = true, list = 'dealSpecific', ...patch } = {}) {
  const bundle = fixtureIdentityBundle(buyer, NOW);
  const member = { scheme: 'domain', verificationRequired: true, parameters: { verificationMethod: snapshotMethod }, ...(explicit ? { recipeVersion: version } : {}) };
  return { bundle, ...await verifiedClaimFixture({ recipeVersion: version, steward: seller, list,
    bundleRequirement: { requirementVersion: '1', required: [member, ...(mixed ? [{ scheme: 'did', verificationRequired: false }] : [])] },
    bundleHash: core.identityBundleHash(bundle), ...patch }) };
}
const snapshotInput = (f, sessionSnapshot, pins = []) => ({ presence: { bundle: f.bundle, sessionSnapshot }, sessionRegistryPins: pins });
const noRecipeReaders = { resolveRecipe: async () => { throw Error('operator recipe reader must not run'); }, resolveLatestRecipe: async () => { throw Error('operator head reader must not run'); } };

for (const list of ['freshness', 'dealSpecific']) for (const group of ['required', 'oneOf']) test(`authenticated session snapshot replays an unpinned ${list} ${group} claim directly`, async () => {
  const member = { scheme: 'domain', verificationRequired: true, parameters: { verificationMethod: snapshotMethod } };
  const f = await snapshotReplayFixture({ mixed: false, list, boundRequirement: member,
    bundleRequirement: { requirementVersion: '1', required: group === 'required' ? [member] : [], ...(group === 'oneOf' ? { oneOf: [[member]] } : {}) } });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB, 'direct-verified', [f.recipe]);
  assert.equal(await f.replay({ input: { sessionSnapshot }, evidence: noRecipeReaders }), null);
});

for (const list of ['freshness', 'dealSpecific']) test(`authenticated session snapshot is required despite a plain ${list} head assertion`, async () => {
  const f = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement, list });
  assert.match(await f.replay(), /runtime-authenticated job registry snapshot/);
});

for (const kind of ['null', 'hash', 'wrong-job', 'clone', 'spread']) test(`direct implicit replay refuses ${kind} snapshot provenance`, async () => {
  const f = await snapshotReplayFixture({ mixed: false }), original = await sessionRegistrySnapshot(JOB);
  const sessionSnapshot = kind === 'null' ? null : kind === 'hash' ? original.snapshotHash
    : kind === 'wrong-job' ? await sessionRegistrySnapshot(`${JOB.slice(0, -1)}B`)
    : kind === 'clone' ? structuredClone(original) : { ...original };
  assert.match(await f.replay({ input: { sessionSnapshot, sessionRegistryPins: [original] } }), /runtime-authenticated job registry snapshot/);
});

for (const kind of ['different', 'unbranded']) test(`direct and presence snapshot options refuse ${kind} authority`, async () => {
  const f = await snapshotReplayFixture(), sessionSnapshot = await sessionRegistrySnapshot(JOB);
  const other = kind === 'different' ? await sessionRegistrySnapshot(JOB, 'other') : structuredClone(sessionSnapshot);
  for (const [direct, nested] of [[sessionSnapshot, other], [other, sessionSnapshot]])
    assert.notEqual(await f.replay({ input: { sessionSnapshot: direct, presence: { bundle: f.bundle, sessionSnapshot: nested } } }), null);
});

test('mixed presence and verified replay accepts the direct snapshot option', async () => {
  const f = await snapshotReplayFixture(), sessionSnapshot = await sessionRegistrySnapshot(JOB);
  assert.equal(await f.replay({ input: { sessionSnapshot, presence: { bundle: f.bundle } }, evidence: noRecipeReaders }), null);
});

test('direct replay and its sibling retain recovered snapshot authority', async () => {
  const f = await snapshotReplayFixture({ mixed: false });
  const { sessionSnapshot, recover } = await sessionRegistryFixture(JOB), pins = [];
  assert.equal(await f.replay({ input: { sessionSnapshot, sessionRegistryPins: pins }, evidence: noRecipeReaders }), null);
  const recovered = await recover();
  assert.equal(await f.replay({ input: { sessionSnapshot: recovered, presence: { sessionSnapshot }, sessionRegistryPins: pins }, evidence: noRecipeReaders }), null);
  assert.equal(await f.replay({ input: { sessionRegistryPins: pins }, evidence: noRecipeReaders }), null);
});

test('direct explicit replay uses the snapshot recipe despite operator replacement', async () => {
  const f = await snapshotReplayFixture({ mixed: false, explicit: true }), sessionSnapshot = await sessionRegistrySnapshot(JOB);
  assert.equal(await f.replay({ input: { sessionSnapshot }, evidence: noRecipeReaders }), null);
});

for (const reader of ['isRecipeSignerAuthorized', 'resolveContent']) test(`snapshot replay preserves the ${reader} failure cause`, async () => {
  const f = await snapshotReplayFixture({ mixed: false }), sessionSnapshot = await sessionRegistrySnapshot(JOB);
  const cause = new Error('TEST snapshot evidence reader failure');
  await assert.rejects(f.replay({ input: { sessionSnapshot }, evidence: { [reader]: async () => { throw cause; } } }), error => error === cause);
});

test('snapshot replay retains content reply byte limits', async () => {
  const f = await snapshotReplayFixture({ mixed: false }), sessionSnapshot = await sessionRegistrySnapshot(JOB);
  await assert.rejects(f.replay({ input: { sessionSnapshot }, evidence: { resolveContent: async () => ({ padding: 'x'.repeat(65537) }) } }), RangeError);
});

async function reviseRecipe(f, patch) {
  return sign({ ...core.stripSignature(f.recipe), ...patch }, 'dacs-recipe:v1:', seller);
}

for (const list of ['freshness', 'dealSpecific']) for (const explicit of [false, true]) test(`snapshot excludes v2 for ${list}, explicit=${explicit}`, async () => {
  const f = await snapshotReplayFixture({ version: 2, explicit, list });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB);
  assert.notEqual(await f.replay({ input: snapshotInput(f, sessionSnapshot), evidence: {
    resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: sessionSnapshot.snapshotHash, recipeVersion: 2, availability: 'live' }),
  } }), null);
});

for (const explicit of [false, true]) test(`strict replay uses the snapshot descriptor, explicit=${explicit}`, async () => {
  const f = await snapshotReplayFixture({ explicit });
  const changed = await reviseRecipe(f, { defaultMaxAgeSec: 7200 });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB, 'changed-descriptor', [changed]);
  assert.notEqual(await f.replay({ input: snapshotInput(f, sessionSnapshot), evidence: {
    resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: sessionSnapshot.snapshotHash, recipeVersion: 1, availability: 'live' }),
    verifyAuthorityAttestation: async ({ recipe }) => core.contentHash(recipe) === core.contentHash(f.recipe) ? 'valid' : 'invalid',
  } }), null);
});

test('snapshot latest head refuses older results and accepts its own v2 descriptor', async () => {
  const old = await snapshotReplayFixture(), latest = await snapshotReplayFixture({ version: 2 });
  const v2 = await reviseRecipe(latest, { governance: { ...latest.recipe.governance, supersedes: 1 } });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB, 'two-versions', [old.recipe, v2]);
  assert.notEqual(await old.replay({ input: snapshotInput(old, sessionSnapshot), evidence: {
    resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: sessionSnapshot.snapshotHash, recipeVersion: 1, availability: 'live' }),
  } }), null);
  assert.equal(await latest.replay({ input: snapshotInput(latest, sessionSnapshot), evidence: noRecipeReaders }), null);
});

for (const explicit of [false, true]) test(`verified sibling inherits snapshot entries, explicit=${explicit}`, async () => {
  const first = await snapshotReplayFixture({ explicit: true }), sibling = await snapshotReplayFixture({ version: 2, explicit, mixed: false, party: seller, verifier: buyer });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB), pins = [];
  assert.equal(await first.replay({ input: snapshotInput(first, sessionSnapshot, pins) }), null);
  assert.notEqual(await sibling.replay({ input: { sessionRegistryPins: pins }, evidence: {
    resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: sessionSnapshot.snapshotHash, recipeVersion: 2, availability: 'live' }),
  } }), null);
});

test('a saved string pin cannot establish snapshot authority for a later record', async () => {
  const f = await snapshotReplayFixture(), sessionSnapshot = await sessionRegistrySnapshot(JOB);
  assert.match(await f.replay({ input: snapshotInput(f, sessionSnapshot, [sessionSnapshot.snapshotHash]) }), /another session registry snapshot/);
});

test('a completed explicit replay without snapshot authority cannot be combined with later presence', async () => {
  const first = await snapshotReplayFixture({ version: 2, explicit: true, mixed: false });
  const later = await snapshotReplayFixture({ explicit: true }), pins = [];
  assert.equal(await first.replay({ input: { sessionRegistryPins: pins } }), null);
  assert.match(await later.replay({ input: snapshotInput(later, await sessionRegistrySnapshot(JOB), pins) }), /another session registry snapshot/);
});

for (const kind of ['wrong-job', 'clone', 'spread']) test(`verified-only replay refuses a supplied ${kind} snapshot`, async () => {
  const f = await snapshotReplayFixture({ explicit: true, mixed: false }), original = await sessionRegistrySnapshot(JOB);
  const sessionSnapshot = kind === 'wrong-job' ? await sessionRegistrySnapshot(core.generateCanonicalJobId())
    : kind === 'clone' ? structuredClone(original) : { ...original };
  assert.match(await f.replay({ input: snapshotInput(f, sessionSnapshot) }), /runtime-authenticated job registry snapshot/);
});

test('an unused explicit oneOf alternative must exist in the job snapshot', async () => {
  const member = { scheme: 'domain', verificationRequired: true, recipeVersion: 2, parameters: { verificationMethod: snapshotMethod } };
  const f = await snapshotReplayFixture({ version: 2, explicit: true, bundleRequirement: { requirementVersion: '1', required: [], oneOf: [
    [{ scheme: 'did', verificationRequired: false }, member],
  ] }, boundRequirement: member });
  const record = await sign({ ...core.stripSignature(f.record), dealSpecific: [] }, core.ARTIFACT_SEPARATORS.CompositeVerificationRecord, seller);
  assert.notEqual(await vetRecordProblem(record, { ref: { ...f.ref, contentHash: core.contentHash(record) }, jobId: JOB,
    party: buyer.claim, bundleHash: record.bundleHash, verifier: seller.claim, invocation: { ...f.invocation, dealSpecific: [] },
    now: () => NOW, evidence: f.evidence, ...snapshotInput(f, await sessionRegistrySnapshot(JOB)) }), null);
});

test('recovered snapshot objects retain the same job authority and recipe selection', async () => {
  const f = await snapshotReplayFixture({ explicit: true }), outside = await snapshotReplayFixture({ version: 2 });
  const { sessionSnapshot, recover } = await sessionRegistryFixture(JOB), pins = [];
  assert.equal(await f.replay({ input: snapshotInput(f, sessionSnapshot, pins) }), null);
  const recovered = await recover();
  assert.notEqual(recovered, sessionSnapshot);
  assert.equal(await f.replay({ input: snapshotInput(f, recovered, pins), evidence: noRecipeReaders }), null);
  assert.notEqual(await outside.replay({ input: snapshotInput(outside, recovered, pins) }), null);
});

for (const explicit of [false, true]) for (const verifiedFirst of [false, true]) test(`concurrent own-program record checks keep one snapshot, explicit=${explicit}, verifiedFirst=${verifiedFirst}`, async () => {
  const presence = await snapshotReplayFixture({ explicit: true }), sibling = await snapshotReplayFixture({ version: 2, explicit, mixed: false, party: seller, verifier: buyer });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB), pins = [];
  const runPresence = () => presence.replay({ input: snapshotInput(presence, sessionSnapshot, pins) });
  const runSibling = () => sibling.replay({ input: { sessionRegistryPins: pins }, evidence: {
    resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: sessionSnapshot.snapshotHash, recipeVersion: 2, availability: 'live' }),
  } });
  const results = await Promise.all(verifiedFirst ? [runSibling(), runPresence()] : [runPresence(), runSibling()]);
  assert.notEqual(results[verifiedFirst ? 0 : 1], null);
});

for (const [availability, deprecated, explicit, accepted] of [
  ...['operator_gated', 'closed_data', 'bilateral', 'mocked', 'disabled', 'failed'].map(state => [state, false, false, false]),
  ['live', true, false, false],
  ...['live', 'operator_gated', 'closed_data', 'bilateral', 'mocked', 'disabled', 'failed'].map(state => [state, false, true, ['live', 'operator_gated', 'closed_data', 'bilateral'].includes(state)]),
]) test(`snapshot availability ${availability}, deprecated=${deprecated}, explicit=${explicit}`, async () => {
  const f = await snapshotReplayFixture({ explicit });
  const recipe = await reviseRecipe(f, { availability, governance: { ...f.recipe.governance, ...(deprecated ? { deprecated: true, deprecationReason: 'TEST superseded' } : {}) } });
  const sessionSnapshot = await sessionRegistrySnapshot(JOB, 'availability', [recipe]);
  const problem = await f.replay({ input: snapshotInput(f, sessionSnapshot), evidence: {
    resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: sessionSnapshot.snapshotHash, recipeVersion: 1, availability: 'live' }),
  } });
  if (accepted) assert.equal(problem, null); else assert.notEqual(problem, null);
});
