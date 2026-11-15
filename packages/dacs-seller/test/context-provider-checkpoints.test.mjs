import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorFixture, SELLER, BUYER, address, copy, assertPresent, blocked } from './helpers/vet-orchestrator-fixture.mjs';

const ROLES = ['seller', 'buyer'];
const PARTY = { seller: SELLER, buyer: BUYER };

// The retained step of one kind for a role, with its signing entry.
const stepOf = (row, role, name) => {
    const ops = row.ops[role], key = Object.keys(ops.steps).find(candidate => JSON.parse(candidate).step === name);
    return { key, step: ops.steps[key], entry: ops.signing[key] };
};
const SIGNING = 'composite', ANCHOR = 'composite-anchor', UNCODED = 'seller_diagnostic_unknown';
// A purchase check that answers true until armed, then answers false from its `after`-th call on.
function purchaseCheck() {
    const check = { armed: false, calls: 0, after: 1 };
    check.open = () => !(check.armed && ++check.calls >= check.after);
    return check;
}
const resolve = (f, provider, writable = () => true) => provider.resolveBuyer(f.input, { writable });
const closureStages = step => (step.provenance?.entries ?? []).filter(entry => entry.result.kind === 'closure').map(entry => entry.stage);
const complete = async (f, role) => Object.values((await f.row()).ops[role].steps).every(step => step.state === 'complete');

test("a step that an earlier attempt's closed predicate refused is not a permanent failure through the real SDK wrapper: the successor reconciles it from the provider's closure provenance and fresh anchor evidence and completes", async (t) => {
    const points = {
        'after the written-ahead bytes': { phase: 'bytes', after: 2, step: SIGNING, stage: 'signing-after-write-ahead' },
        'before the anchor publishes': { phase: 'signature', after: 1, step: ANCHOR, stage: 'anchor-before-publish' },
        'while the anchor prepares to publish': { phase: 'signature', after: 2, step: ANCHOR, stage: 'anchor-authorize' },
        'at the first guard': { phase: 'prepared', after: 1, step: SIGNING, stage: 'signing-before-mark' },
    };
    for (const role of ROLES)
        for (const [name, point] of Object.entries(points))
            await t.test(`${role} ${name}`, async (t) => {
                const f = await orchestratorFixture(t, { disk: true, real: true }), check = purchaseCheck();
                check.after = point.after;
                f.when(role, point.phase, () => { check.armed = true; });
                await blocked(() => resolve(f, f.provider(), check.open));
                f.controls.afterUpdate = null;
                const kept = await f.row(), firstParty = role === 'seller' && point.stage === 'signing-before-mark';
                if (firstParty) {
                    // Nothing was written yet, so the row is gone and a successor binds afresh.
                    assert.equal(kept, undefined);
                    assertPresent(await resolve(f, f.fresh()));
                    assert.equal(f.controls.signatures.length, 2);
                    return;
                }
                const { step } = stepOf(kept, role, point.step), { entry } = stepOf(kept, role, SIGNING);
                assert.equal(step.state, 'failed');
                assert.deepEqual(closureStages(step), [point.stage]);
                // The SDK's anchor wrapper replaces the callback's error with a generic one; the signing step keeps the provider's own.
                assert.equal(step.error.code === UNCODED, point.step === ANCHOR);
                const signatures = f.controls.signatures.length, creates = f.controls.creates.length, before = copy(await f.base.entries());
                // A successor that is not writable changes nothing.
                await blocked(() => resolve(f, f.fresh(), () => false));
                assert.deepEqual(await f.base.entries(), before);
                assert.equal(f.controls.signatures.length, signatures);
                assertPresent(await resolve(f, f.fresh()));
                const done = stepOf(await f.row(), role, SIGNING).entry;
                assert.equal(done.generatedAt, entry.generatedAt);
                if (entry.signedBytes) assert.equal(done.signedBytes, entry.signedBytes);
                assert.equal(await complete(f, role), true);
                assert.equal(f.controls.signatures.length, 2);
                assert.equal(f.controls.creates.length, 2);
                assert.equal(f.records.size, 2);
                assert.ok(address(PARTY[role]));
            });
});
