// DACS_SELLER_CONTEXT at its default (in-process) is main, byte for byte.
// All three pinned digests were produced by these same helpers on main
// 8228e66. Re-derive them for any revision with
// `node scripts/print-seller-context-digests.mjs <revision>` (it prints every
// canonical part's hash; --parts <directory> writes the parts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';
import { sellerContextOffScenario } from './helpers/seller-context-off-scenario.mjs';
import { operatorPlanAtDefaults } from './helpers/seller-context-off-operator.mjs';

// Agreement and Vet artifact bytes, transport declarations, the seven routes'
// request and response bytes, the context path's answer and every transport
// journal row (seller-context-off-scenario.mjs), as main produced them.
const MAIN_SCENARIO_DIGEST = '4b32173b349d2740c992480937455f4ce5ab41dbd73296bd25dc0ba1a5ad94bb';
// The shape of the real operator's tool and portal outputs, seller approval
// prompts, purchase row, history and every journal row up to the Agreement
// plan (seller-context-off-operator.mjs), as main produced it.
const MAIN_OPERATOR_PLAN_SHAPE = '3775d8a8c9490cd4b6dc881dc22ed31ef2dac48c428d827fee992ab284d7ad29';
// The same outputs' values, with only run-specific keys, ids, hashes, times
// and ports replaced by their kind (seller-context-off-operator.mjs valuesOf):
// statuses, kinds, authorities, prompt text, fees and sizes are pinned as values.
const MAIN_OPERATOR_PLAN_VALUES = '57eef22d6f7056cd516eb7a543dcd2cec5491c7bf3a50abf77cd4f3d6348d40d';
// main's operator composition options, exactly.
const MAIN_COMPOSITION_KEYS = ['agreementAnchor', 'authority', 'buyerAccess', 'commitOnSignature', 'deliveryEvidenceEnabled', 'durableDirectory', 'listingDraft', 'loadRailResolution', 'nativePaymentEvidence',
  'observeDemosTransfer', 'partyVetStore', 'producePurchasedContent', 'publicJournal', 'scanOwnListings', 'sellerEndpoint', 'sellerSigner', 'sellerTlsReadiness', 'sellerTransport', 'sellerWalletFactory', 'signatureBuyer', 'sourceCapability'];
const configEnv = { DACS_PUBLIC_ORIGIN: 'https://TEST.example', DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: 'https://TEST-issuer.example' };

function withSellerContext(t, value) {
  const previous = process.env.DACS_SELLER_CONTEXT;
  if (value === undefined) delete process.env.DACS_SELLER_CONTEXT; else process.env.DACS_SELLER_CONTEXT = value;
  t.after(() => { if (previous === undefined) delete process.env.DACS_SELLER_CONTEXT; else process.env.DACS_SELLER_CONTEXT = previous; });
}

test('switch off: Agreement, Vet artifacts, transport bindings, routes and transport journal rows equal main byte for byte', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-context-off-')));t.after(() => rmSync(directory, { recursive: true }));
  const { digest, parts } = await sellerContextOffScenario({ directory });
  assert.equal(parts.traffic.length, 8);assert.equal(parts.vetArtifacts.length, 2);
  assert.deepEqual(parts.traffic.at(-1).response, { status: 404, contentType: 'application/json', connection: 'close', text: '{"error":"not_found"}' }, 'no context route unless the switch mounts it');
  assert.equal(digest, MAIN_SCENARIO_DIGEST);
});

test('the switch defaults to in-process, refuses typos and matches the deployment contract', (t) => {
  assert.equal(loadConfig(configEnv).sellerContext, 'in-process');
  assert.equal(loadConfig({ ...configEnv, DACS_SELLER_CONTEXT: 'route' }).sellerContext, 'route');
  for (const value of ['', 'Route', 'ROUTE', 'off', 'on', 'remote', ' route']) assert.throws(() => loadConfig({ ...configEnv, DACS_SELLER_CONTEXT: value }), /DACS_SELLER_CONTEXT must be in-process or route/, JSON.stringify(value));
  // A switch file (src/switches/DACS_SELLER_CONTEXT.switch, docs/SWITCHES.md).
  assert.deepEqual(contractView().variables.DACS_SELLER_CONTEXT, { kind: 'enum', values: ['in-process', 'route'], default: 'in-process', deployValue: 'in-process', note: "read by the devnet operator's in-process seller only", operator: true });
  assert.ok(runtimeNames().includes('DACS_SELLER_CONTEXT'));
  // Its order keeps the place of the inline check it replaced: after
  // DACS_DELIVERY_DEADLINE_WATCH and before DACS_SHOWCASE_WALKTHROUGH.
  const first = (env) => { try { loadConfig({ ...configEnv, ...env });return null; } catch (error) { return error.message; } };
  assert.equal(first({ DACS_DELIVERY_DEADLINE_WATCH: 'x', DACS_SELLER_CONTEXT: 'x' }), 'DACS_DELIVERY_DEADLINE_WATCH must be off or on');
  assert.equal(first({ DACS_SELLER_CONTEXT: 'x', DACS_SHOWCASE_WALKTHROUGH: 'x' }), 'DACS_SELLER_CONTEXT must be in-process or route');
});

test('the operator refuses an unknown switch value before it opens anything', async (t) => {
  const missing = join(tmpdir(), 'seller-context-no-such-directory', 'operator.json');
  withSellerContext(t, 'remote');
  await assert.rejects(createDevnetDemoOperator({ configPath: missing }), /DACS_SELLER_CONTEXT must be in-process or route/);
  // A known value gets past the switch to the config read.
  process.env.DACS_SELLER_CONTEXT = 'route';
  await assert.rejects(createDevnetDemoOperator({ configPath: missing }), (error) => error.code === 'ENOENT');
});

test('switch off: the real operator plans in-process, mounts no route, and its outputs, prompts and journal rows have main\'s shape and values', { timeout: 600000 }, async (t) => {
  withSellerContext(t, undefined);
  const out = await operatorPlanAtDefaults();t.after(() => out.h.close());
  const { h } = out;
  assert.deepEqual(Object.keys(h.prepared.composition).sort(), MAIN_COMPOSITION_KEYS);
  assert.equal(h.composition.contextProvider.invocations.length, 2, 'both Vet records came from the in-process call');
  assert.equal(out.prompts.filter((prompt) => prompt.request.content.artifactKind === 'CompositeVerificationRecord').length, 2);
  for (const table of ['peer_nonces', 'peer_effects', 'peer_slots', 'peer_jobs']) assert.deepEqual(out.journal['seller-transport.sqlite'][table], [], table);
  const response = await h.fetchImpl(`${h.config.sellerOrigin}/dacs/v1/agreements/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 404);assert.equal(await response.text(), '{"error":"not_found"}');
  assert.equal(out.digest, MAIN_OPERATOR_PLAN_SHAPE);
  assert.equal(out.valuesDigest, MAIN_OPERATOR_PLAN_VALUES);
});
