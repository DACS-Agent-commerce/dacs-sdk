import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorFixture, SELLER, BUYER, T0, address, copy, deferred, assertPresent, blocked } from './helpers/vet-orchestrator-fixture.mjs';
import { reportNativeRefusal, withNativeObservationEvidence } from '../src/dacs/native-observation-evidence.mjs';

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
            });
});

// Wraps the real native anchor so a plan can fail one source call of the party's address: the SDK's lookup (its first
// plain read), the receipt check, or the artifact read (its second plain read). Reads the provider makes for its own
// evidence (fresh or proof-of-no-intent) pass through.
function faulty(anchor, plan, logicalAddress) {
    let reads = 0;
    const gate = async stage => { await plan.fail?.[stage]?.(); };
    return { ...anchor,
        readRetained: async (request, options) => {
            if (request.logicalAddress === logicalAddress && !request.fresh && !request.proofOfNoIntent)
                await gate(reads++ === 0 ? 'lookup' : 'artifact');
            return anchor.readRetained(request, options);
        },
        verifyReceipt: async request => { if (request.logicalAddress === logicalAddress) await gate('receipt'); return anchor.verifyReceipt(request); } };
}
const OUTAGE = () => new Error('TEST source outage');
const TIMEOUT = () => new DOMException('TEST source deadline', 'TimeoutError');
const INCONSISTENT = () => Object.assign(new Error('TEST node reply is inconsistent'), { code: 'invalid' });
const createsFor = (f, role) => f.controls.creates.filter(logicalAddress => logicalAddress === address(PARTY[role])).length;
// The wallet requests made for the party's address: a CREATE counts here even when its publication threw.
const requestsFor = (f, role) => f.native.captured.filter(request => request.logicalAddress === address(PARTY[role])).length;
const entriesOf = step => step.provenance.entries.map(entry => [entry.stage, entry.phase, entry.result.kind]);
// The distinct [kind, address] of every refusal proof in the step's log.
const refusalsOf = step => [...new Set(step.provenance.entries.filter(entry => entry.result.kind === 'refusal').map(entry => JSON.stringify([entry.result.proof.kind, entry.result.proof.address])))].map(pair => JSON.parse(pair));
// Leaves the party's CREATE on the chain with its step unfinished: the publication's own receipt check answers indeterminate.
async function publishedButUnfinished(f, role) {
    const reader = f.native.controls.reader, verify = reader.verifyReceipt;
    reader.verifyReceipt = async request => request.logicalAddress === address(PARTY[role]) ? 'indeterminate' : verify(request);
    await blocked(() => resolve(f, f.provider()));
    reader.verifyReceipt = verify;
}
// Replaces the wallet's answer for the party's address; the original answers every other address.
function answerWalletFor(f, role, answer) {
    const original = f.native.controls.request;
    f.native.controls.request = request => request.logicalAddress === address(PARTY[role]) ? answer(request, original) : original(request);
}
// A store handle that stops answering once the process "dies", so the run it belonged to saves nothing more while its locks unwind.
function mortal(f) {
    const life = { dead: false };
    return { store: { ...f.store, update: (key, change) => life.dead ? Promise.reject(new Error('TEST process died')) : f.store.update(key, change) },
        die: () => { life.dead = true; throw new Error('TEST process died'); } };
}
const walletRequests = f => f.native.captured.length;
// A valid record for the party's address that differs from the one the provider writes: made by a second provider whose clock is one tick later.
async function otherRecord(t, role) {
    const g = await orchestratorFixture(t, { real: true });
    assertPresent(await resolve(g, g.provider({ now: () => T0 + 1 })));
    return copy(g.records.get(address(PARTY[role])).artifact);
}
// Every later attempt, fresh or after a restart, is refused with nothing signed, requested or created.
async function assertReplays(f, attempts = 2) {
    const before = [f.controls.signatures.length, f.controls.creates.length, walletRequests(f)];
    for (let i = 0; i < attempts; i++)
        await blocked(() => resolve(f, f.fresh()));
    assert.deepEqual([f.controls.signatures.length, f.controls.creates.length, walletRequests(f)], before);
}

test("a generic SDK anchor failure is classified from publication and observation provenance and fresh evidence: a source failure before or during publication continues or adopts, unknown dispatch holds, real refusals replay", async (t) => {
    const observed = {
        'an initial lookup that throws': { stage: 'lookup', error: OUTAGE },
        'an initial lookup that times out': { stage: 'lookup', error: TIMEOUT },
        'a receipt read that throws': { stage: 'receipt', error: OUTAGE },
        'an artifact read that throws': { stage: 'artifact', error: OUTAGE },
        'an artifact read that times out': { stage: 'artifact', error: TIMEOUT },
    };
    for (const role of ROLES)
        for (const mode of ['in the same process', 'after a restart']) {
            const successor = (f, failing) => mode === 'after a restart' ? f.fresh() : failing;
            for (const [name, cell] of Object.entries(observed))
                await t.test(`${role}: ${name} leaves the record in place and recovery adopts it ${mode}`, async (t) => {
                    const f = await orchestratorFixture(t, { disk: true, real: true });
                    await publishedButUnfinished(f, role);
                    const plan = { fail: { [cell.stage]: () => { throw cell.error(); } } };
                    const failing = f.fresh({ anchor: faulty(f.openAnchor(), plan, address(PARTY[role])) });
                    await blocked(() => resolve(f, failing));
                    plan.fail = null;
                    const { step } = stepOf(await f.row(), role, ANCHOR);
                    // The SDK's anchor wrapper replaced the error; the provider's log names the source call, and no publication was entered.
                    assert.equal(step.state, 'failed');
                    const log = entriesOf(step);
                    assert.deepEqual(log.at(-1), [cell.stage, 'initial', 'source']);
                    assert.ok(log.slice(0, -1).every(([, , kind]) => kind === 'returned'));
                    assert.ok(log.every(([stage]) => stage !== 'publish'));
                    const chain = copy(f.records.get(address(PARTY[role])));
                    assertPresent(await resolve(f, successor(f, failing)));
                    assert.equal(createsFor(f, role), 1);
                    assert.deepEqual(f.records.get(address(PARTY[role])), chain);
                    assert.equal(f.controls.signatures.length, 2);
                    assert.equal(f.records.size, 2);
                    assert.equal(await complete(f, role), true);
                });
            await t.test(`${role}: a lookup that fails before any intent continues with the retained signed record ${mode}`, async (t) => {
                const f = await orchestratorFixture(t, { disk: true, real: true }), plan = { fail: { lookup: () => { throw OUTAGE(); } } };
                const failing = f.fresh({ anchor: faulty(f.openAnchor(), plan, address(PARTY[role])) });
                await blocked(() => resolve(f, failing));
                plan.fail = null;
                assert.deepEqual(entriesOf(stepOf(await f.row(), role, ANCHOR).step), [['lookup', 'initial', 'source']]);
                assertPresent(await resolve(f, successor(f, failing)));
                assert.equal(f.controls.signatures.length, 2);
                assert.equal(createsFor(f, role), 1);
                assert.equal(f.records.size, 2);
            });
            await t.test(`${role}: a nonce read that fails before the intent continues with the retained signed record ${mode}`, async (t) => {
                const f = await orchestratorFixture(t, { disk: true, real: true }), read = f.native.source.readRpc, failing = f.fresh();
                f.when(role, 'signature', () => { f.native.source.readRpc = async () => { throw OUTAGE(); }; });
                await blocked(() => resolve(f, failing));
                f.native.source.readRpc = read;
                const signatures = f.controls.signatures.length;
                assertPresent(await resolve(f, successor(f, failing)));
                assert.equal(f.controls.signatures.length, role === 'seller' ? signatures + 1 : signatures);
                assert.equal(createsFor(f, role), 1);
                assert.equal(f.records.size, 2);
            });
        }
    await t.test('a failure inside the publication readback and the recovery read that follows is source evidence and the record is adopted', async (t) => {
        for (const failure of [OUTAGE, INCONSISTENT])
            for (const role of ROLES) {
                const f = await orchestratorFixture(t, { disk: true, real: true });
                f.when(role, 'signature', () => { f.controls.onRead = logicalAddress => { if (logicalAddress === address(PARTY[role])) throw failure(); }; });
                await blocked(() => resolve(f, f.provider()));
                f.controls.onRead = null;
                const { step } = stepOf(await f.row(), role, ANCHOR);
                assert.equal(step.state, 'failed');
                assert.deepEqual(entriesOf(step), [['lookup', 'initial', 'returned'], ['publish', 'initial', 'source'], ['lookup', 'recovery', 'source']]);
                assert.equal(requestsFor(f, role), 1);
                assertPresent(await resolve(f, f.fresh()));
                assert.equal(requestsFor(f, role), 1);
                assert.equal(f.controls.signatures.length, 2);
                assert.equal(f.records.size, 2);
            }
    });
    await t.test('a receipt verdict of invalid is source evidence: the failed step is reconsidered and the record is adopted once the node answers correctly', async (t) => {
        for (const role of ROLES) {
            const f = await orchestratorFixture(t, { disk: true, real: true }), reader = f.native.controls.reader, verify = reader.verifyReceipt;
            reader.verifyReceipt = async request => request.logicalAddress === address(PARTY[role]) ? 'invalid' : verify(request);
            await blocked(() => resolve(f, f.provider()));
            reader.verifyReceipt = verify;
            const { step } = stepOf(await f.row(), role, ANCHOR);
            assert.equal(step.state, 'failed');
            assert.deepEqual(refusalsOf(step), []);
            assertPresent(await resolve(f, f.fresh()));
            assert.equal(createsFor(f, role), 1);
            assert.equal(f.controls.signatures.length, 2);
        }
    });
    await t.test('a wallet answer lost after the intent leaves the dispatch unknown: every later attempt is held with nothing signed or sent', async (t) => {
        for (const role of ROLES) {
            const f = await orchestratorFixture(t, { disk: true, real: true });
            answerWalletFor(f, role, async (request, original) => { await original(request); f.records.delete(request.logicalAddress); throw new Error('TEST wallet answer lost'); });
            await blocked(() => resolve(f, f.provider()));
            await assertReplays(f);
            assert.equal((await f.row()).lifecycle.state, 'open');
        }
    });
    await t.test('a CREATE the source has not included yet is held until the source answers, then adopted without a second CREATE', async (t) => {
        for (const role of ROLES) {
            const f = await orchestratorFixture(t, { disk: true, real: true }), binding = f.native.source.binding;
            f.when(role, 'signature', () => { f.native.source.binding = async () => ({ disposition: 'pending' }); });
            await blocked(() => resolve(f, f.provider()));
            await assertReplays(f);
            f.native.source.binding = binding;
            assertPresent(await resolve(f, f.fresh()));
            assert.equal(createsFor(f, role), 1);
            assert.equal(f.controls.signatures.length, 2);
        }
    });
    await t.test('a failed step whose address shows no intent while a signed CREATE naming it is retained stays held, and continues once that CREATE is gone', async (t) => {
        for (const role of ROLES) {
            const f = await orchestratorFixture(t, { disk: true, real: true }), plan = { fail: { lookup: () => { throw OUTAGE(); } } };
            await blocked(() => resolve(f, f.fresh({ anchor: faulty(f.openAnchor(), plan, address(PARTY[role])) })));
            assert.equal(stepOf(await f.row(), role, ANCHOR).step.state, 'failed');
            await f.native.sourceJournal.put('TEST/orphan', { hash: 'a'.repeat(64), signedTransaction: { content: { data: [0, { metadata: { logicalAddress: address(PARTY[role]) } }] } } });
            await assertReplays(f);
            f.native.sourceJournal.rows.delete('TEST/orphan');
            assertPresent(await resolve(f, f.fresh()));
            assert.equal(createsFor(f, role), 1);
        }
    });
    await t.test('an operator denial keeps its refusal after a restart even when the operator would now approve', async (t) => {
        for (const role of ROLES) {
            const f = await orchestratorFixture(t, { disk: true, real: true }), original = f.native.controls.request;
            answerWalletFor(f, role, async () => ({ success: false, error: { code: 'user_rejected', message: 'TEST operator declined' } }));
            await blocked(() => resolve(f, f.provider()));
            f.native.controls.request = original;
            const { step } = stepOf(await f.row(), role, ANCHOR);
            assert.deepEqual(refusalsOf(step), [['operator-denied', address(PARTY[role])]]);
            await assertReplays(f);
        }
    });
    await t.test('a retained intent that differs from the record to write is a local scope conflict and keeps its refusal', async (t) => {
        for (const role of ROLES) {
            const f = await orchestratorFixture(t, { disk: true, real: true }), other = await otherRecord(t, role);
            // Another write of the same address lands after the job is bound and the record is signed, before this provider anchors it.
            f.when(role, 'signature', () => f.native.open().publish({ logicalAddress: address(PARTY[role]), artifact: other, artifactKind: 'CompositeVerificationRecord' }));
            await blocked(() => resolve(f, f.provider()));
            const { step } = stepOf(await f.row(), role, ANCHOR);
            assert.deepEqual(refusalsOf(step), [['immutable-scope-conflict', address(PARTY[role])]]);
            await assertReplays(f);
        }
    });
    await t.test('an authenticated record at the address that contradicts the retained one keeps its refusal', async (t) => {
        for (const role of ROLES) {
            const f = await orchestratorFixture(t, { disk: true, real: true }), other = await otherRecord(t, role);
            answerWalletFor(f, role, async (request, original) => { const answer = await original(request); f.records.get(request.logicalAddress).artifact = copy(other); return answer; });
            await blocked(() => resolve(f, f.provider()));
            const { step } = stepOf(await f.row(), role, ANCHOR);
            assert.deepEqual(refusalsOf(step), [['authenticated-contradiction', address(PARTY[role])]]);
            await assertReplays(f);
        }
    });
    await t.test('a refusal before any source contact, from the SDK\'s own time check, leaves an empty complete log and keeps its refusal', async (t) => {
        for (const role of ROLES) {
            // After the signature, the SDK reads the clock for the step's acceptance, then inside the step for its effect time: only the second read is local to the step.
            const clock = { armed: false, reads: 0 }, f = await orchestratorFixture(t, { disk: true, real: true });
            f.when(role, 'signature', () => { clock.armed = true; });
            await blocked(() => resolve(f, f.provider({ now: () => clock.armed && ++clock.reads === 3 ? -1 : T0 })));
            const { step } = stepOf(await f.row(), role, ANCHOR);
            assert.equal(step.state, 'failed');
            assert.deepEqual(step.provenance.entries, []);
            assert.equal(step.provenance.coverage, 'complete');
            await assertReplays(f);
        }
    });
});

test("the real provider's checkpoint matrix, for each party: a successor continues only from proven evidence and never re-signs a retained record", async (t) => {
    // Each cell abandons a first run at one cut: the run never settles, as if its process had died. The retained store is
    // then reopened by fresh providers.
    const abandonedAt = {
        'after the step reservation': { cut: (f, role) => f.cut(role, 'reserved') },
        'after the signing time reservation': { cut: (f, role) => f.cut(role, 'prepared') },
        'after the written-ahead bytes': { cut: (f, role) => f.cut(role, 'bytes'), held: true },
        'after the retained signature': { cut: (f, role) => f.cut(role, 'signature') },
        'during the anchor step with no intent': { cut: async (f, role) => {
            const reached = deferred();
            f.controls.beforePublish = ({ logicalAddress }) => { if (logicalAddress === address(PARTY[role])) { reached.resolve(); return new Promise(() => { }); } };
            void resolve(f, f.provider()).catch(() => { });
            await reached.promise;
            f.controls.beforePublish = null;
        } },
        'during the anchor step with an intent that proves nothing was signed': { cut: async (f, role) => {
            const original = f.native.controls.request, process = mortal(f);
            answerWalletFor(f, role, async () => process.die());
            await blocked(() => resolve(f, f.provider({ store: process.store })));
            f.native.controls.request = original;
        } },
        'during the anchor step with an intent whose outcome is unknown': { held: true, cut: async (f, role) => {
            const process = mortal(f);
            answerWalletFor(f, role, async (request, original) => { await original(request); f.records.delete(request.logicalAddress); return process.die(); });
            await blocked(() => resolve(f, f.provider({ store: process.store })));
        } },
    };
    for (const role of ROLES)
        for (const [name, cell] of Object.entries(abandonedAt))
            await t.test(`${role} ${name}`, async (t) => {
                const f = await orchestratorFixture(t, { disk: true, real: true });
                await cell.cut(f, role);
                const kept = stepOf(await f.row(), role, SIGNING).entry, before = [f.controls.signatures.length, f.controls.creates.length, walletRequests(f)];
                // The first restart is not writable and changes nothing.
                const retained = copy(await f.base.entries());
                await blocked(() => resolve(f, f.fresh(), () => false));
                assert.deepEqual(await f.base.entries(), retained);
                if (cell.held) {
                    for (let restart = 0; restart < 2; restart++)
                        await blocked(() => resolve(f, f.fresh()));
                    assert.deepEqual([f.controls.signatures.length, f.controls.creates.length, walletRequests(f)], before);
                    return;
                }
                assertPresent(await resolve(f, f.fresh()));
                assert.equal(f.controls.signatures.length, 2);
                for (const party of ROLES) assert.equal(createsFor(f, party), 1);
                const done = stepOf(await f.row(), role, SIGNING).entry;
                if (kept) assert.equal(done.generatedAt, kept.generatedAt);
                if (kept?.signedBytes) assert.equal(done.signedBytes, kept.signedBytes);
                if (kept?.signature) assert.equal(done.signature, kept.signature);
                assert.equal(await complete(f, role), true);
            });
});

test('bytes written ahead without a signature are held unless the final guard stopped the signer, and a stopped final guard lets the successor sign the retained bytes once', async (t) => {
    for (const role of ROLES) {
        await t.test(`${role}: the final guard stops the signer`, async (t) => {
            const f = await orchestratorFixture(t, { disk: true, real: true }), check = purchaseCheck();
            check.after = 2;
            f.when(role, 'bytes', () => { check.armed = true; });
            await blocked(() => resolve(f, f.provider(), check.open));
            const { step, entry } = stepOf(await f.row(), role, SIGNING);
            assert.deepEqual(closureStages(step), ['signing-after-write-ahead']);
            assert.ok(entry.signedBytes && !entry.signature);
            const signatures = f.controls.signatures.length;
            assertPresent(await resolve(f, f.fresh()));
            assert.equal(f.controls.signatures.length, signatures + (role === 'seller' ? 2 : 1));
            assert.equal(stepOf(await f.row(), role, SIGNING).entry.signedBytes, entry.signedBytes);
        });
        await t.test(`${role}: the purchase check that refuses before the final guard leaves no proof that the signer did not run`, async (t) => {
            const f = await orchestratorFixture(t, { disk: true, real: true }), check = purchaseCheck();
            f.when(role, 'bytes', () => { check.armed = true; });
            await blocked(() => resolve(f, f.provider(), check.open));
            const { step } = stepOf(await f.row(), role, SIGNING);
            assert.equal(step.state, 'failed');
            assert.deepEqual(closureStages(step), []);
            await assertReplays(f);
        });
        await t.test(`${role}: a wallet answer lost after the signer was asked stays held`, async (t) => {
            const f = await orchestratorFixture(t, { disk: true, real: true });
            f.controls.beforeSign = () => { if (f.controls.signatures.length === (role === 'seller' ? 0 : 1)) throw new Error('TEST wallet answer lost'); };
            await blocked(() => resolve(f, f.provider()));
            f.controls.beforeSign = null;
            const { step, entry } = stepOf(await f.row(), role, SIGNING);
            assert.ok(step.state === 'failed' && entry.signedBytes && !entry.signature);
            await assertReplays(f);
        });
    }
});

test('a failed step whose log could not be saved stays pending and uncertain: a closure before publication continues from fresh evidence and a closure at the final guard is held', async (t) => {
    for (const role of ROLES)
        for (const point of ['before publication', 'at the final guard'])
            await t.test(`${role} ${point}`, async (t) => {
                const f = await orchestratorFixture(t, { disk: true, real: true }), check = purchaseCheck(), signing = point === 'at the final guard';
                check.after = signing ? 2 : 1;
                f.when(role, signing ? 'bytes' : 'signature', () => { check.armed = true; });
                // The save of any failed step is lost before it commits, so neither the failure nor its log is kept.
                const lossy = { ...f.store, update: (key, change) => f.store.update(key, (old, rows) => {
                    const next = change(old, rows);
                    if (next?.ops && Object.values(next.ops[role].steps).some(step => step.state === 'failed')) throw new Error('TEST failed-step save lost');
                    return next;
                }) };
                await blocked(() => resolve(f, f.provider({ store: lossy }), check.open));
                const { step } = stepOf(await f.row(), role, signing ? SIGNING : ANCHOR);
                assert.equal(step.state, 'pending');
                assert.equal(step.provenance, undefined);
                if (signing) {
                    await assertReplays(f);
                    return;
                }
                assertPresent(await resolve(f, f.fresh()));
                assert.equal(createsFor(f, role), 1);
                assert.equal(f.controls.signatures.length, 2);
            });
});

test('a late failure of a step another owner has taken over is rejected and a log that names another step, role or owner is not trusted', async (t) => {
    for (const role of ROLES) {
        await t.test(`${role}: the late old execution saves neither its failure nor its log over the successor`, async (t) => {
            const f = await orchestratorFixture(t, { disk: true }), cut = await f.cut(role, 'prepared');
            // The successor takes the reservation over and completes; then the old execution wakes, fails its fence and saves nothing.
            assertPresent(await resolve(f, f.fresh()));
            cut.resume.resolve();
            await assert.rejects(cut.pending);
            const { step } = stepOf(await f.row(), role, SIGNING);
            assert.equal(step.state, 'complete');
            assert.equal(step.provenance, undefined);
            assert.equal(f.controls.signatures.length, 2);
        });
        const tampered = { 'another role': step => { step.provenance.role = role === 'seller' ? 'buyer' : 'seller'; },
            'another input': step => { step.provenance.inputHash = 'f'.repeat(64); },
            'another owner': step => { step.provenance.owner = 'another-owner'; },
            'an unknown coverage': step => { step.provenance.coverage = 'unknown'; },
            'no log at all': step => { delete step.provenance; } };
        for (const [name, tamper] of Object.entries(tampered))
            await t.test(`${role}: a log that names ${name} is not trusted`, async (t) => {
                const f = await orchestratorFixture(t, { disk: true, real: true }), check = purchaseCheck();
                f.when(role, 'signature', () => { check.armed = true; });
                await blocked(() => resolve(f, f.provider(), check.open));
                const [rowKey] = (await f.base.entries())[0], { key, step } = stepOf(await f.row(), role, ANCHOR);
                await f.base.update(rowKey, row => { tamper(row.ops[role].steps[key]); return row; });
                await assertReplays(f);
                await f.base.update(rowKey, row => { row.ops[role].steps[key] = copy(step); return row; });
                assertPresent(await resolve(f, f.fresh()));
                assert.equal(f.controls.signatures.length, 2);
            });
    }
});

test('a recovered run keeps the producer order, the Vet mode and the retained bytes of the interrupted run', async (t) => {
    for (const role of ROLES) {
        const f = await orchestratorFixture(t, { disk: true, real: true }), check = purchaseCheck();
        check.after = 1;
        f.when(role, 'signature', () => { check.armed = true; });
        await blocked(() => resolve(f, f.provider(), check.open));
        const retained = copy(stepOf(await f.row(), role, SIGNING).entry);
        const answer = assertPresent(await resolve(f, f.fresh()));
        // The seller's record is written before the buyer's, both signed by the seller wallet, and no buyer verifier is ever asked.
        assert.deepEqual(f.controls.creates, [address(SELLER), address(BUYER)]);
        assert.equal(f.controls.counterpartyCalls, 0);
        assert.equal(answer.input.seller.vetRecordRef.signer, SELLER.claim);
        assert.deepEqual(stepOf(await f.row(), role, SIGNING).entry.signedBytes, retained.signedBytes);
        for (const record of f.records.values()) assert.equal(record.artifact.signature.signer, SELLER.claim);
    }
});

test('every context observation remains passive for a pending accepted CREATE, including recovery, completed replay, outside-step reads and closed attempts', async (t) => {
    // An RPC signer and a spy on the source's recovery send are wired in, so a read that was not passive would act.
    const withRecoverySpy = async (t) => {
        const f = await orchestratorFixture(t, { disk: true, real: true, signRpc: async () => ({}) }), seen = { recoveries: 0, closedReads: 0 };
        f.native.source.recoverStorageWrite = async () => { seen.recoveries++; return { resent: true }; };
        f.native.source.binding = async () => ({ disposition: 'included' });
        return { f, seen };
    };
    const recoveryRows = f => JSON.stringify([...f.native.journal.rows].filter(([key]) => key.startsWith('demo/recovery/')));
    const snapshot = (f, seen) => JSON.stringify([seen.recoveries, recoveryRows(f), f.controls.signatures.length, walletRequests(f)]);
    const pending = f => { f.native.source.binding = async () => ({ disposition: 'pending' }); };
    for (const role of ROLES) {
        await t.test(`${role}: a retained CREATE the source reports as pending is only read, by every observation caller, immediately and after a restart`, async (t) => {
            const { f, seen } = await withRecoverySpy(t);
            f.when(role, 'signature', () => pending(f));
            await blocked(() => resolve(f, f.provider()));
            // The publication itself may send an authorized recovery; it is counted here and everything below must leave it alone.
            assert.ok(seen.recoveries >= 1);
            const baseline = snapshot(f, seen), observations = { calls: 0 };
            for (let repeat = 0; repeat < 2; repeat++) {
                // The pure readers leave the retained row as it was.
                const rows = await f.base.entries(), provider = f.fresh();
                assert.equal(await provider.recoverBuyer(f.input), null);
                assert.equal(await provider.resumableBuyer(f.input), null);
                assert.deepEqual(await f.base.entries(), rows);
                // Attempts the deadline closes after two, three... purchase checks still make their lookups, and only read.
                for (const after of [2, 3, 4, 5]) {
                    const check = purchaseCheck(), observer = f.openAnchor();
                    check.armed = true; check.after = after;
                    await blocked(() => resolve(f, f.fresh({ anchor: { ...observer, readRetained: (...args) => { observations.calls++; return observer.readRetained(...args); } } }), check.open));
                }
                assert.equal(snapshot(f, seen), baseline);
            }
            assert.ok(observations.calls > 0);
        });
        await t.test(`${role}: a completed job replayed while the source reports its records as pending is refused without any send`, async (t) => {
            const { f, seen } = await withRecoverySpy(t), provider = f.provider();
            assertPresent(await resolve(f, provider));
            pending(f);
            const baseline = snapshot(f, seen);
            for (let repeat = 0; repeat < 2; repeat++) {
                await blocked(() => resolve(f, provider));
                await blocked(() => resolve(f, f.fresh()));
                assert.equal(snapshot(f, seen), baseline);
            }
        });
    }
});

test('concurrent native observation collectors each receive only their own refusal proofs, and a malformed collector or work is refused', async () => {
    const proof = kind => ({ kind, address: 'a', retainedHash: 'b', observedHash: null });
    const collected = { first: [], second: [] }, pause = () => new Promise(done => setImmediate(done));
    await Promise.all([
        withNativeObservationEvidence(found => collected.first.push(found.kind), async () => { reportNativeRefusal(proof('operator-denied')); await pause(); reportNativeRefusal(proof('immutable-scope-conflict')); }),
        withNativeObservationEvidence(found => collected.second.push(found.kind), async () => { await pause(); reportNativeRefusal(proof('authenticated-contradiction')); }),
    ]);
    assert.deepEqual(collected, { first: ['operator-denied', 'immutable-scope-conflict'], second: ['authenticated-contradiction'] });
    reportNativeRefusal(proof('operator-denied'));
    assert.deepEqual(collected.first.length + collected.second.length, 3);
    await assert.rejects(withNativeObservationEvidence(null, async () => { }), TypeError);
    await assert.rejects(withNativeObservationEvidence(() => { }, null), TypeError);
    await assert.rejects(withNativeObservationEvidence(() => { }, async () => { throw new RangeError('TEST work failure'); }), RangeError);
});
