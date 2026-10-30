// Strict Vet replay with a requirement that names a verified claim: the record
// passes only through the operator's authenticated VerifyResult, recipe and
// authority evidence, every read is bounded, and a failing reader keeps its cause.
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
async function verifiedClaimFixture({ recipeVersion = 1, scheme = 'domain', identifier = 'alice.example', urlTemplate = 'https://authority.example/{identifier}', list = 'dealSpecific', authority = 'canonical-json', bundleRequirement = requirement, data = { active: true }, party = buyer, verifier = seller, boundRequirement = bundleRequirement.required[0], steward = recipeSteward, resultWallet = resultSigner } = {}) {
  const recipe = await sign({ recipeVersion, scheme, defaultMethod: { kind: 'consensus-backed-proxy', endpoint: { method: 'GET', urlTemplate } },
    defaultMaxAgeSec: 3600, parserRules: { format: 'json', successJsonPath: '$.active' }, retryClass: 'permanent', availability: 'live',
    governance: { proposedBy: steward.claim, acceptedAt: NOW - 1000, anchoring: 'single-signer' } }, 'dacs-recipe:v1:', steward);
  const authorityValue = { active: true };
  const authorityContent = authority === 'bytes'
    ? { encoding: 'bytes', value: Buffer.from('{"active":true}').toString('base64url'), hash: core.sha256Hex(Buffer.from('{"active":true}')) }
    : authority === 'empty-bytes'
      ? { encoding: 'bytes', value: '', hash: core.sha256Hex(new Uint8Array(0)) }
      : { encoding: 'canonical-json', value: authorityValue, hash: core.sha256Hex(core.canonicalize(authorityValue)) };
  const result = await sign({ resultVersion: '1', scheme, identifier, recipeVersion, method: 'consensus-backed-proxy', decision: 'pass',
    reason: 'authority confirmed the claim', attestation: { anchor: { kind: 'https', locator: AUTHORITY_LOCATOR }, contentHash: authorityContent.hash, signer: resultWallet.claim },
    data, fetchedAt: NOW - 20, verifiedAt: NOW - 10 }, 'dacs-verifyresult:v1:', resultWallet);
  const resultRef = { anchor: { kind: 'storage-program', locator: `dacs2:${JOB}:${scheme}:${identifier}:v${recipeVersion}` }, contentHash: core.contentHash(result), recipeVersion };
  const bundleHash = core.sha256Hex('TEST evaluated bundle');
  const record = await sign({ recordVersion: '1', jobId: JOB, evaluatedParty: party.claim, bundleHash, requirementHash: core.sha256Hex(core.canonicalize(bundleRequirement)),
    freshness: list === 'freshness' ? [resultRef] : [], supplementary: [], dealSpecific: list === 'dealSpecific' ? [resultRef] : [], overallDecision: 'pass', generatedAt: NOW }, core.ARTIFACT_SEPARATORS.CompositeVerificationRecord, verifier);
  const ref = { anchor: { kind: 'storage-program', locator: core.compositeVerificationAddress(JOB, party.claim) }, contentHash: core.contentHash(record), signer: verifier.claim };
  const expected = [{ ref: resultRef, sourceJobId: JOB, scheme, identifier, method: 'consensus-backed-proxy', requirement: boundRequirement }];
  const invocation = { vetRecordRef: ref, evaluatedParty: party.claim, requirement: bundleRequirement, verifier: verifier.claim, freshness: list === 'freshness' ? expected : [], dealSpecific: list === 'dealSpecific' ? expected : [] };
  const contents = new Map([[resultRef.anchor.locator, { encoding: 'canonical-json', value: result }],
    [AUTHORITY_LOCATOR, authorityContent.encoding === 'bytes' ? { encoding: 'bytes', value: authorityContent.value } : { encoding: 'canonical-json', value: authorityValue }]]);
  const calls = [];
  const evidence = {
    resolveContent: async (input) => { calls.push(['resolveContent', input]); return contents.has(input.anchor.locator) ? structuredClone(contents.get(input.anchor.locator)) : null; },
    resolveRecipe: async (input) => { calls.push(['resolveRecipe', input]); return structuredClone(recipe); },
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
  assert.match(problem, /does not verify against its requirement \(unresolved: /);
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
  assert.match(await fixture.replay({ evidence: { resolveRecipe: async () => null } }), /recipe-resolution/);
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

test('a verified claim whose requirement leaves the recipe version unpinned passes at the session registry latest', async () => {
  const fixture = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  assert.equal(await fixture.replay(), null);
  assert.ok(fixture.calls.some(([name, input]) => name === 'resolveLatestRecipe'
    && input.scheme === 'domain' && input.method === 'consensus-backed-proxy' && input.required === true));
});

test('an unpinned verified claim whose result is not the session registry latest is refused', async () => {
  const fixture = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  const problem = await fixture.replay({ evidence: { resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: SESSION_REGISTRY_PIN, recipeVersion: 2, availability: 'live' }) } });
  assert.match(problem, /not the latest live recipe version/);
});

test('an unpinned verified claim is refused when the registry family head is not live', async () => {
  // v2 is the family's latest entry but disabled; v1 is still live. DACS-2
  // §7.4.3 selects the latest entry and refuses it, never falls back to v1.
  for (const availability of ['disabled', 'failed', 'mocked']) {
    const fixture = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
    const problem = await fixture.replay({ evidence: { resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: SESSION_REGISTRY_PIN, recipeVersion: 2, availability }) } });
    assert.match(problem, /latest recipe version is not live/);
  }
});

test('an unpinned verified claim is refused when the selection omits the latest entry availability', async () => {
  const fixture = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  const problem = await fixture.replay({ evidence: { resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: SESSION_REGISTRY_PIN, recipeVersion: 1 }) } });
  assert.match(problem, /session registry selection is malformed/);
});

test('an unpinned verified claim without a session registry lookup stays refused', async () => {
  const fixture = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  const { resolveLatestRecipe: _missing, ...withoutLatest } = fixture.evidence;
  assert.match(await fixture.replay({ input: { evidence: withoutLatest } }), /does not pin a recipe version/);
});

test('an unpinned session registry lookup with a malformed pin is refused', async () => {
  const fixture = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  const problem = await fixture.replay({ evidence: { resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: 'not-a-hash', recipeVersion: 1, availability: 'live' }) } });
  assert.match(problem, /session registry pin is malformed/);
});

test('an unpinned claim with no session recipe version is refused', async () => {
  const fixture = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  const problem = await fixture.replay({ evidence: { resolveLatestRecipe: async () => null } });
  assert.match(problem, /no recipe version/);
});

async function replayTwoResults(a,b,resolveLatestRecipe){
 const invocation={...a.invocation,dealSpecific:[...a.invocation.dealSpecific,...b.invocation.dealSpecific]},record=await sign({...core.stripSignature(a.record),dealSpecific:[...a.record.dealSpecific,...b.record.dealSpecific]},core.ARTIFACT_SEPARATORS.CompositeVerificationRecord,seller);
 const contents=new Map([...a.contents,...b.contents]),ref={...a.ref,contentHash:core.contentHash(record)};
 const recipes=new Map([a.recipe,b.recipe].map(recipe=>[`${recipe.scheme}/${recipe.recipeVersion}`,recipe]));
 const evidence={...a.evidence,resolveContent:async({anchor})=>contents.get(anchor.locator)??null,resolveRecipe:async({scheme,recipeVersion})=>recipes.get(`${scheme}/${recipeVersion}`),resolveLatestRecipe};
 return vetRecordProblem(record,{ref,jobId:JOB,role:'buyer',party:buyer.claim,bundleHash:record.bundleHash,verifier:seller.claim,invocation,now:()=>NOW,evidence});
}
test('one replay resolves distinct implicit families against one session snapshot',async()=>{
 const first={scheme:'domain',verificationRequired:true},second={scheme:'email',verificationRequired:true},bundleRequirement={requirementVersion:'1',required:[first,second]};
 const a=await verifiedClaimFixture({bundleRequirement,boundRequirement:first}),b=await verifiedClaimFixture({bundleRequirement,boundRequirement:second,scheme:'email',identifier:'alice@example.test'});
 assert.match(await replayTwoResults(a,b,async({scheme})=>({sessionRecipeRegistrySnapshotHash:(scheme==='domain'?'ab':'cd').repeat(32),recipeVersion:1,availability:'live'})),/another session registry snapshot/);
});

test('one job resolves both party records against one session registry snapshot', async () => {
  const pins = [];
  const buyerRecord = await verifiedClaimFixture({ bundleRequirement: unpinnedRequirement });
  const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},implicit={scheme:'domain',verificationRequired:true};
  const sellerRecord = await verifiedClaimFixture({ bundleRequirement: {requirementVersion:'1',required:[pinned,implicit]}, boundRequirement:pinned, party: seller, verifier: buyer });
  assert.equal(await buyerRecord.replay({ input: { sessionRegistryPins: pins } }), null);
  const problem = await sellerRecord.replay({ input: { sessionRegistryPins: pins },
    evidence: { resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: 'cd'.repeat(32), recipeVersion: 1, availability: 'live' }) } });
  assert.match(problem, /another session registry snapshot/);
});

test('a result bound to a pinned alternative cannot satisfy a compatible unpinned oneOf member under an older version', async () => {
  // The core projects the signed v1 result onto the unpinned GB alternative
  // even though it is explicitly bound to the pinned DE alternative. The
  // unpinned alternative's family head is v2, so the replay must be refused.
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1, parameters: { jurisdiction: 'DE' } };
  const unpinned = { scheme: 'domain', verificationRequired: true, parameters: { jurisdiction: 'GB' } };
  const bundleRequirement = { requirementVersion: '1', required: [], oneOf: [[pinned, unpinned]] };
  const fixture = await verifiedClaimFixture({ bundleRequirement, boundRequirement: pinned, data: { active: true, jurisdiction: 'GB' } });
  const problem = await fixture.replay({ evidence: { resolveLatestRecipe: async () => ({ sessionRecipeRegistrySnapshotHash: SESSION_REGISTRY_PIN, recipeVersion: 2, availability: 'live' }) } });
  assert.match(problem, /not the latest live recipe version/);
});

test('a compatible unpinned oneOf member is qualified even when the result is bound elsewhere', async () => {
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1, parameters: { jurisdiction: 'DE' } };
  const unpinned = { scheme: 'domain', verificationRequired: true, parameters: { jurisdiction: 'GB' } };
  const bundleRequirement = { requirementVersion: '1', required: [], oneOf: [[pinned, unpinned]] };
  const fixture = await verifiedClaimFixture({ bundleRequirement, boundRequirement: pinned, data: { active: true, jurisdiction: 'GB' } });
  assert.equal(await fixture.replay(), null);
  assert.ok(fixture.calls.some(([name, input]) => name === 'resolveLatestRecipe' && input.scheme === 'domain' && input.method === 'consensus-backed-proxy'));
});

test('an unbound unpinned alternative the core cannot project does not refuse a satisfied pinned oneOf member', async () => {
  // compatibleVerifiedExpectations never projects onto a member that carries
  // its own `identifier` parameter, so this alternative can never use the v1
  // result: the pinned DE member alone satisfies the group at its own version,
  // and the registry head (v2) does not apply to it.
  const pinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1, parameters: { jurisdiction: 'DE' } };
  const identified = { scheme: 'domain', verificationRequired: true, parameters: { identifier: 'bob' } };
  const bundleRequirement = { requirementVersion: '1', required: [], oneOf: [[pinned, identified]] };
  const fixture = await verifiedClaimFixture({ bundleRequirement, boundRequirement: pinned, data: { active: true, jurisdiction: 'DE' } });
  let lookups=0;
  assert.equal(await fixture.replay({ evidence: { resolveLatestRecipe: async () => (lookups++,{ sessionRecipeRegistrySnapshotHash: SESSION_REGISTRY_PIN, recipeVersion: 2, availability: 'live' }) } }), null);
  assert.equal(lookups,1,'family existence is preflighted without using the stale result for that member');
});

test('an unpinned alternative cannot be projected from a result bound to an identified member', async () => {
  // The committed result's own requirement names an identifier, so the core's
  // compatibility key is null and nothing can be projected from that entry: the
  // pinned, identified member alone satisfies the group at its own version.
  const identifiedPinned = { scheme: 'domain', verificationRequired: true, recipeVersion: 1, parameters: { identifier: 'bob' } };
  const other = { scheme: 'domain', verificationRequired: true };
  const bundleRequirement = { requirementVersion: '1', required: [], oneOf: [[identifiedPinned, other]] };
  const fixture = await verifiedClaimFixture({ bundleRequirement, boundRequirement: identifiedPinned, data: { active: true, identifier: 'bob' } });
  let lookups=0;
  assert.equal(await fixture.replay({ evidence: { resolveLatestRecipe: async () => (lookups++,{ sessionRecipeRegistrySnapshotHash: SESSION_REGISTRY_PIN, recipeVersion: 2, availability: 'live' }) } }), null);
  assert.equal(lookups,1,'family existence is preflighted without using the stale result for that member');
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

for(const [name,pinnedParameters,implicitParameters,urlTemplate,latest,reads] of [
 ['missing target binding',{jurisdiction:'DE'},undefined,'https://authority.example/{identifier}/{jurisdiction}',2,1],
 ['different target binding',{jurisdiction:'DE'},{jurisdiction:'GB'},'https://authority.example/{identifier}/{jurisdiction}',2,1],
 ['missing committed binding',undefined,{jurisdiction:'GB'},'https://authority.example/{identifier}/{jurisdiction}',2,1],
 ['projectable stale member',{jurisdiction:'DE'},{jurisdiction:'DE'},undefined,2,1],
 ['projectable missing reader',{jurisdiction:'DE'},{jurisdiction:'DE'},undefined,undefined,0],
])test((latest===undefined?'registry proof remains required: ':'passing pinned alternative survives ')+name,async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1,...(pinnedParameters?{parameters:pinnedParameters}:{})},implicit={scheme:'domain',verificationRequired:true,...(implicitParameters?{parameters:implicitParameters}:{})};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,implicit]]},boundRequirement:pinned,data:{active:true,jurisdiction:'DE'},urlTemplate});let calls=0;
 const evidence={resolveLatestRecipe:latest===undefined?undefined:async()=>{calls++;return{sessionRecipeRegistrySnapshotHash:SESSION_REGISTRY_PIN,recipeVersion:latest,availability:'live'};}};
 if(latest===undefined)assert.match(await f.replay({evidence}),/does not pin/);else assert.equal(await f.replay({evidence}),null);assert.equal(calls,reads);
});
for(const availability of ['disabled','failed','mocked'])test('non-live implicit family refuses replay before aggregation '+availability,async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},implicit={scheme:'domain',verificationRequired:true};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,implicit]]},boundRequirement:pinned});
 assert.match(await f.replay({evidence:{resolveLatestRecipe:async()=>({sessionRecipeRegistrySnapshotHash:SESSION_REGISTRY_PIN,recipeVersion:1,availability})}}),/not live/);
});
for(const bad of [{sessionRecipeRegistrySnapshotHash:'TEST-invalid',recipeVersion:1,availability:'live'},{sessionRecipeRegistrySnapshotHash:SESSION_REGISTRY_PIN,recipeVersion:'1',availability:'live'}])test('malformed unused alternative registry answer still refuses the record '+JSON.stringify(bad),async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},implicit={scheme:'domain',verificationRequired:true};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,implicit]]},boundRequirement:pinned});
 assert.match(await f.replay({evidence:{resolveLatestRecipe:async()=>bad}}),/malformed/);
});
test('a stale required member reached only by projection is unsatisfied',async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},implicit={scheme:'domain',verificationRequired:true};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[pinned,implicit]},boundRequirement:pinned});
 assert.match(await f.replay({evidence:{resolveLatestRecipe:async()=>({sessionRecipeRegistrySnapshotHash:SESSION_REGISTRY_PIN,recipeVersion:2,availability:'live'})}}),/not the latest live recipe version/);
});

test('implicit members of one family share one bounded selection read',async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},de={scheme:'domain',verificationRequired:true,parameters:{jurisdiction:'DE'}},gb={scheme:'domain',verificationRequired:true,parameters:{jurisdiction:'GB'}};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,de,gb]]},boundRequirement:pinned,data:{active:true,jurisdiction:'DE'}});let calls=0;
 const pins=[];assert.equal(await f.replay({input:{sessionRegistryPins:pins},evidence:{resolveLatestRecipe:async()=>({sessionRecipeRegistrySnapshotHash:(calls++===0?'ab':'cd').repeat(32),recipeVersion:1,availability:'live'})}}),null);
 assert.equal(calls,1);assert.deepEqual(pins,[SESSION_REGISTRY_PIN]);
});

test('one family selection qualifies each actual result version independently',async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},implicit={scheme:'domain',verificationRequired:true},bundleRequirement={requirementVersion:'1',required:[pinned,implicit]};
 const a=await verifiedClaimFixture({bundleRequirement,boundRequirement:pinned}),b=await verifiedClaimFixture({bundleRequirement,boundRequirement:implicit,recipeVersion:2});let calls=0;
 assert.equal(await replayTwoResults(a,b,async()=>{calls++;return{sessionRecipeRegistrySnapshotHash:SESSION_REGISTRY_PIN,recipeVersion:2,availability:'live'};}),null);assert.equal(calls,1);
});

for(const selection of [null,{sessionRecipeRegistrySnapshotHash:SESSION_REGISTRY_PIN,recipeVersion:2,availability:'disabled'},{sessionRecipeRegistrySnapshotHash:'TEST-invalid',recipeVersion:2,availability:'live'}])test('unprojectable implicit family still preflights registry errors '+JSON.stringify(selection),async()=>{
 const pinned={scheme:'domain',verificationRequired:true,recipeVersion:1},implicit={scheme:'domain',verificationRequired:true,parameters:{identifier:'bob'}};
 const f=await verifiedClaimFixture({bundleRequirement:{requirementVersion:'1',required:[],oneOf:[[pinned,implicit]]},boundRequirement:pinned});
 assert.match(await f.replay({evidence:{resolveLatestRecipe:async()=>selection}}),/no recipe version|not live|malformed/);
});
