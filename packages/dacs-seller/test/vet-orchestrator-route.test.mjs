import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorFixture, SELLER, BUYER, OTHER, address, copy, assertPresent } from './helpers/vet-orchestrator-fixture.mjs';
import { world, exchange, JOBS } from './helpers/d5-http-fixture.mjs';
const routeWorld = async (t, limits) => { const f = await orchestratorFixture(t), p = f.provider(), holds=[], w = await world(t, { fixture: { seller: { claim: SELLER.claim, sign: SELLER.signBytes }, buyer: { claim: BUYER.claim, sign: BUYER.signBytes }, other: { claim: OTHER.claim, sign: OTHER.signBytes }, listing: f.listing }, ...(limits ? { limits } : {}), admitWrites:async value=>{holds.push(value);return null;},perform: p.resolveBuyer, recover: p.recoverBuyer, resumable: p.resumableBuyer }); return { f, w, holds }; };
test("a W context start reserves two writes and makes exactly two Vet CREATEs; an identical retry makes none", async (t) => { const { f, w, holds } = await routeWorld(t), input = await w.wire(); assert.equal((await exchange(w.handler, input)).status, 200); assert.equal(w.effects().holds, 1); assert.equal(holds[0].writes,2); assert.equal(f.controls.creates.length, 2); assert.equal((await exchange(w.handler, input)).status, 200); assert.equal(f.controls.creates.length, 2); });
test("the per-buyer and global unpaid-start limits refuse a W start before any policy hold or Vet signature", async (t) => { for (const global of [false, true]) {
    const { f, w } = await routeWorld(t, { maxStartsPerHour: global ? 1 : 2, maxStartsPerBuyerPerHour: 1 });
    assert.equal((await exchange(w.handler, await w.wire())).status, 200);
    const held = w.effects().holds, count = f.controls.signatures.length;
    const out = await exchange(w.handler, await w.wire({ jobId: JOBS[1], actor: global ? w.other : w.buyer }));
    assert.equal(out.status, 409);
    assert.match(out.text, /unpaid_start_limit/);
    assert.equal(w.effects().holds, held);
    assert.equal(f.controls.signatures.length, count);
} });
test("W resumable answers null for: another binding; another or unsupported retained mode; a seller or same-binding buyer record that fails the strict check for its party's exact bundle and requirement, or whose receipt is not verified finalized and established; an address whose intent has an unknown outcome; and an address that reads plain absence, or hasIntent:false, without the anchor's no-intent proof. Each sits beside a control that answers {writes:1} or {writes:2}", async (t) => { for (const fault of ['binding', 'counterparty', 'unsupported', 'seller-bundle', 'buyer-requirement', 'seller-receipt', 'buyer-receipt', 'unknown', 'plain', 'false-intent', 'control'])
    await t.test(fault, async (t) => { const f = await orchestratorFixture(t); f.controls.beforePublish = ({ logicalAddress }) => { if (logicalAddress === address(BUYER))
        throw new Error('TEST buyer no intent'); }; await assert.rejects(f.run()); const p = f.fresh(); if (fault === 'control') {
        assert.deepEqual(await p.resumableBuyer(f.input), { writes: 1 });
        return;
    } let input = copy(f.input); if (fault === 'binding')
        input.scope.price.amount = '99'; if (['counterparty', 'unsupported'].includes(fault)) {
        const [key] = (await f.base.entries())[0];
        await f.base.update(key, row => { row.binding.vetMode = fault; return row; });
    } if (fault === 'seller-bundle')
        f.records.get(address(SELLER)).artifact.bundleHash = 'a'.repeat(64); if (fault === 'seller-receipt')
        f.records.get(address(SELLER)).receipt.state = 'included'; if (['buyer-requirement', 'buyer-receipt'].includes(fault)) {
        f.controls.beforePublish = null;
        assertPresent(await f.run(f.fresh()));
        f.records.get(address(BUYER))[fault === 'buyer-requirement' ? 'artifact' : 'receipt'][fault === 'buyer-requirement' ? 'requirementHash' : 'state'] = fault === 'buyer-requirement' ? 'a'.repeat(64) : 'included';
    } if (['unknown', 'plain', 'false-intent'].includes(fault)) {

        const anchor = { ...f.config.anchor, readRetained: async ({ logicalAddress, ...options }) => logicalAddress === address(BUYER) ? fault === 'unknown' ? { status: 'indeterminate' } : { status: 'absent', ...(fault === 'false-intent' ? { hasIntent: false } : {}) } : f.config.anchor.readRetained({ logicalAddress, ...options }) };
        assert.equal(await f.provider({ anchor }).resumableBuyer(input), null);
    }
    else
        assert.equal(await p.resumableBuyer(input), null); }); });
test("every Vet-backed W answer freshly reads both records and requires strictly valid records and verified finalized, established receipts; no fault yields present, including a joined answer and a previously answered context. For the partial-failure path, finalize the seller record, fail the buyer CREATE before any intent (a failed anchor step with proven unsigned absence), then inject each seller receipt fault before retry: no new signature or CREATE and no present. Faults target existing records; an expected missing record is allowed only while resuming its missing write, never in a successful answer. Each cell has an unchanged finalized control; partial-failure and resume controls write only what is missing and never re-sign the seller. Agent restart and its receipt-fault matrix run at P08b's head in T6, T11 and T23, which consume these fixtures without adding an agent dependency to P08a (resumed)", async (t) => { for (const state of ['accepted', 'included', 'unknown', 'dropped', 'replaced', 'reorged', 'absent', 'throws', 'finalized'])
    await t.test(state, async (t) => { const f = await orchestratorFixture(t); f.controls.beforePublish = ({ logicalAddress }) => { if (logicalAddress === address(BUYER))
        throw new Error('TEST missing buyer intent'); }; await assert.rejects(f.run()); f.controls.beforePublish = null; const signs = f.controls.signatures.length, creates = f.controls.creates.length; f.controls.fault = { party: address(SELLER), state }; const p = f.fresh(); if (state === 'finalized') {
        assert.deepEqual(await p.resumableBuyer(f.input), { writes: 1 });
        assertPresent(await f.run(p));
        assert.equal(f.controls.signatures.length, 2);
        assert.equal(f.controls.creates.length, 2);
    }
    else {
        let out;
        try {
            out = await p.resumableBuyer(f.input);
        }
        catch { }
        assert.equal(out ?? null, null);
        assert.equal(f.controls.signatures.length, signs);
        assert.equal(f.controls.creates.length, creates);
    } }); });
