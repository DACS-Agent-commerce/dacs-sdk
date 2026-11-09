import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, identityBundleHash, sha256Hex, signedBytes, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { orchestratorFixture, W, SELLER, BUYER, OTHER, JOB, T0, address, copy, deferred, signedRecord, assertPresent, blocked } from './helpers/vet-orchestrator-fixture.mjs';
import { verifyComponent } from '../src/dacs/listing.mjs';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { privateModule } from './helpers/private-module.mjs';
test("W producer signs both records with the seller wallet for the Listing's exact seller bundle through the real native anchor, and the public resolveBuyer answer is disposition:'present' with value.input.seller.identityBundle canonically equal to the Listing bundle", async (t) => { const f = await orchestratorFixture(t, { real: true }), value = assertPresent(await f.run()); assert.deepEqual(Object.keys(value).sort(), ['input', 'scope']); assert.equal(canonicalize(value.input.seller.identityBundle), canonicalize(f.listing.seller.identity)); assert.equal(identityBundleHash(value.input.seller.identityBundle), '31b4d993fa159dcaa8e5def720c682fe74c7123a8256a34026d496dd02eda609'); for (const row of f.records.values())
    assert.equal(row.artifact.signature.signer, SELLER.claim); assert.equal(f.native.captured.length, 2); });
test("W producer makes zero counterparty calls, even to a capability that never settles, and signs no seller presentation", async (t) => { const f = await orchestratorFixture(t); f.config.counterparty = Object.fromEntries(['issueChallenge', 'readRecord', 'evaluate'].map(key => [key, () => { f.controls.counterpartyCalls++; return new Promise(() => { }); }])); assertPresent(await f.run()); assert.equal(f.controls.counterpartyCalls, 0); assert.equal(f.controls.signatures.length, 2); assert.ok(f.controls.signatures.every(bytes => !bytes.startsWith('dacs-bundle-presentation:'))); });
test("W producer writes and finalizes the seller record before it signs the buyer record", async (t) => { const f = await orchestratorFixture(t); f.controls.beforeSign = () => { if (f.controls.signatures.length)
    assert.equal(f.records.get(address(SELLER))?.receipt.state, 'finalized'); }; assertPresent(await f.run()); assert.deepEqual(f.controls.creates, [address(SELLER), address(BUYER)]); });
test("a restart after the seller record is finalized signs only the buyer record and leaves the seller record unchanged", async (t) => { const f = await orchestratorFixture(t, { real: true, disk: true }), reached = deferred(); f.controls.afterPublish = async ({ logicalAddress }) => { if (logicalAddress === address(SELLER)) {
    reached.resolve();
    await new Promise(() => { });
} }; void f.run().catch(() => { }); await reached.promise; f.controls.afterPublish = null; const seller = copy(f.records.get(address(SELLER))); assertPresent(await f.run(f.fresh())); assert.deepEqual(f.records.get(address(SELLER)), seller); assert.equal(f.controls.signatures.length, 2); });
test("a restart after both records are anchored signs nothing and answers the same references", async (t) => { const f = await orchestratorFixture(t, { disk: true }), first = assertPresent(await f.run()); assert.deepEqual(assertPresent(await f.run(f.fresh())), first); assert.equal(f.controls.signatures.length, 2); assert.equal(f.controls.creates.length, 2); });
test("a W signing reservation left by a cut is reconciled from its retained evidence by a fresh provider over the reopened store: every case completes with exactly one CVR signature per party in total, a retained signature is reused with its retained generatedAt and signBytes is not called again, and the two before-signer cases sign once under fresh authorization. The lost acknowledgement is injected by an update wrapper that throws after the underlying update commits; a throw inside the change function (the pattern of vet-checkpoints.test.mjs:83) is before commit and does not prove this case", async (t) => { for (const role of ['seller', 'buyer'])
    for (const phase of ['signature', 'reserved', 'prepared'])
        for (const lostAck of phase === 'signature' ? [false, true] : [false])
            await t.test(`${role}/${phase}/${lostAck}`, async (t) => { const f = await orchestratorFixture(t, { disk: true }), cut = await f.cut(role, phase, { lostAck }); if (lostAck)
                await blocked(() => cut.pending); const before = copy((await f.row()).ops[role].signing); assertPresent(await f.run(f.fresh())); assert.equal(f.controls.signatures.length, 2); if (phase === 'signature')
                for (const [key, entry] of Object.entries(before)) {
                    const next = (await f.row()).ops[role].signing[key];
                    assert.equal(next.signedBytes, entry.signedBytes); assert.equal(next.signature, entry.signature);
                    assert.equal(next.generatedAt, entry.generatedAt);
                } }); });
test("a W signing reservation left by a cut is reconciled from its retained evidence by a fresh provider over the reopened store: every case completes with exactly one CVR signature per party in total, a retained signature is reused with its retained generatedAt and signBytes is not called again, and the two before-signer cases sign once under fresh authorization. The lost acknowledgement is injected by an update wrapper that throws after the underlying update commits; a throw inside the change function (the pattern of vet-checkpoints.test.mjs:83) is before commit and does not prove this case (binding persisted before lifecycle)",async t=>{
 const f=await orchestratorFixture(t,{disk:true}),reached=deferred();let cut=false;
 f.controls.afterUpdate=async(_,row)=>{if(!cut&&row?.binding&&!row.lifecycle){cut=true;reached.resolve();await new Promise(()=>{});}};void f.run().catch(()=>{});await reached.promise;f.controls.afterUpdate=null;
 const fresh=f.fresh(),before=await f.base.entries();assert.deepEqual(await fresh.resumableBuyer(f.input),{writes:2});assert.equal(f.controls.signatures.length,0);
 const unknown=f.provider({anchor:{...f.config.anchor,readRetained:async()=>({status:'absent'})}});assert.equal(await unknown.resumableBuyer(f.input),null);assert.deepEqual(await f.base.entries(),before);
 let raced=false;f.controls.onRead=async()=>{if(raced)return;raced=true;f.controls.afterUpdate=async(old,row)=>{if(!old.lifecycle&&row.lifecycle)throw new Error('TEST concurrent admission acknowledgement lost');};await assert.rejects(f.run(f.fresh()),/concurrent admission/);f.controls.afterUpdate=null;}; assert.equal(await fresh.resumableBuyer(f.input),null);f.controls.onRead=null;assert.equal(f.controls.signatures.length,0);
 assertPresent(await f.run(fresh));assert.equal(f.controls.signatures.length,2);assert.equal(f.controls.creates.length,2);
});
test("concurrent and repeated W requests for one job join one run and sign each record once", async (t) => { const f = await orchestratorFixture(t), p = f.provider(), answers = await Promise.all([f.run(p), f.run(p), f.run(p)]); for (const out of answers)
    assertPresent(out); assertPresent(await f.run(p)); assert.equal(f.controls.signatures.length, 2); assert.equal(f.controls.creates.length, 2); });
test("W receipt verification answering invalid or indeterminate never yields context", async (t) => { for (const verdict of ['invalid', 'indeterminate']) {
    const f = await orchestratorFixture(t);
    f.controls.receiptVerdict = verdict;
    await blocked(() => f.run());
    assert.equal(f.provider().contexts.size, 0);
} });
test("a W reference at another job's composite address is refused at currentness and recovery",async t=>{
 const f=await orchestratorFixture(t),p=f.provider();assertPresent(await f.run(p));
 const [key,row]=(await f.base.entries())[0],saved=copy(row.seller);
 await f.base.update(key,row=>{const wrong=address(SELLER).replace(JOB,'01M5YKPJG048H248H248H248H2');row.seller.input.seller.vetRecordRef.anchor.locator=wrong;row.seller.vetRequirements[1].vetRecordRef.anchor.locator=wrong;return row;});
 await blocked(()=>f.run(p));assert.equal(await f.fresh().recoverBuyer(f.input),null);
 await f.base.update(key,row=>{row.seller=saved;return row;});assertPresent(await f.run(p));
 assert.equal(f.controls.signatures.length,2);assert.equal(f.controls.creates.length,2);
});
async function mutatedProof(t, mutate) {
    for (const entry of ['initial', 'recovered']) {
        const f = await orchestratorFixture(t);let altered=false;
        if (entry === 'recovered')
            assertPresent(await f.run());
        else
            f.controls.afterPublish = async ({ logicalAddress }) => { if (logicalAddress === address(BUYER))
                await alter(); };
        async function alter() {
            const kept = f.records.get(address(SELLER)), record = copy(kept.artifact);
            mutate(record);
            kept.artifact = await signedRecord(record);
            assert.equal(verifyComponent({signedBytes:signedBytes(ARTIFACT_SEPARATORS.CompositeVerificationRecord,contentHash(kept.artifact)),signature:kept.artifact.signature}),true);
            kept.receipt.contentHash = contentHash(kept.artifact);
            kept.receipt.transactionRef.value = contentHash(kept.artifact);
            const [key] = (await f.base.entries())[0];
            await f.base.update(key, row => { for (const checkpoint of Object.values(row.ops.seller.checkpoints)) {
                if (checkpoint.record) {
                    checkpoint.record = copy(kept.artifact);
                    checkpoint.recordArtifactHash = sha256Hex(canonicalize(kept.artifact));
                    if (checkpoint.recordAnchor) {
                        checkpoint.recordAnchor.ref.contentHash = contentHash(kept.artifact);
                        checkpoint.recordAnchor.receipt = copy(kept.receipt);
                    }
                }
            } row.seller = null; return row; });
            altered=true;
        }
        if (entry === 'recovered')
            await alter();
        await blocked(() => entry === 'initial' ? f.run() : f.fresh().recoverBuyer(f.input));assert.equal(altered,true);
    }
}
test("a W seller record whose bundleHash is not the Listing bundle's is refused by the provider's strict verifier before the answer and on recovery; the negative is correctly re-signed by the seller and its reference and receipt hashes are consistent, so only the bundle comparison can refuse it", async (t) => mutatedProof(t, record => record.bundleHash = identityBundleHash(foreignBundle())));
const foreignBundle = () => ({ bundleVersion: '1', presentedBy: OTHER.claim, presentedAt: T0, sessionNonce: 'a'.repeat(64), claims: [{ ref: OTHER.claim }] });
test("a W record signed by the buyer or by OTHER is refused by the anchor (wallet requests 0) and by the provider", async (t) => { for (const signer of [BUYER, OTHER]) {
    const f = await orchestratorFixture(t, { real: true });
    assertPresent(await f.run());
    const bad = await signedRecord(f.records.get(address(SELLER)).artifact, signer), count = f.native.captured.length;
    await assert.rejects(f.config.anchor.publish({ logicalAddress: address(SELLER), artifact: bad, artifactKind: 'CompositeVerificationRecord' }), error => error.code === 'invalid'); assert.equal(f.native.captured.length, count);
    f.records.get(address(SELLER)).artifact = bad;
    await blocked(() => f.fresh().recoverBuyer(f.input));
} });
test("after a restart a changed W seller or buyer record is refused on every retry, and the original answers again once restored", async (t) => { for (const party of [SELLER, BUYER]) {
    const f = await orchestratorFixture(t, { disk: true });
    assertPresent(await f.run());
    const kept = copy(f.records.get(address(party)));
    f.records.get(address(party)).artifact.generatedAt++;
    const p = f.fresh();
    for (let i = 0; i < 2; i++)
        await blocked(() => f.run(p));
    f.records.set(address(party), kept);
    assertPresent(await f.run(p));
    assert.equal(f.controls.signatures.length, 2);
} });
test("after a restart a changed W seller or buyer record is refused on every retry, and the original answers again once restored (partial retry authenticates the retained signature before the missing CREATE)", async (t) => { const f = await orchestratorFixture(t), p = f.provider(); f.controls.beforePublish = ({ logicalAddress }) => { if (logicalAddress === address(BUYER))
    throw new Error('TEST buyer before intent'); }; await assert.rejects(f.run(p)); f.controls.beforePublish = null; f.records.get(address(SELLER)).artifact.signature.value = 'A'.repeat(86); const signs = f.controls.signatures.length, creates = f.controls.creates.length; await blocked(() => f.run(p)); assert.equal(f.controls.signatures.length, signs); assert.equal(f.controls.creates.length, creates); });
test("a W record whose requirementHash is not the empty seller requirement's, or whose decision does not replay, is refused by the provider's strict verifier before the answer and on recovery; each negative is correctly re-signed, with consistent reference and receipt hashes", async (t) => { await mutatedProof(t, record => record.requirementHash = 'a'.repeat(64)); await mutatedProof(t, record => record.overallDecision = 'fail'); });
test("W invocations name the seller as verifier of both records in the initial resolveBuyer answer's retained vetRequirements and in a fresh provider's recovered answer, and both answers are present with the Listing seller bundle", async (t) => { const f = await orchestratorFixture(t, { disk: true }), p = f.provider(); assertPresent(await f.run(p)); for (const candidate of [p, f.fresh()]) {
    const answer = await candidate.resolveSeller(f.sellerRequest());
    assertPresent(answer);
    assert.deepEqual(answer.value.input.seller.identityBundle, f.listing.seller.identity); assert.deepEqual(answer.value.vetRequirements.map(value => [value.evaluatedParty, value.verifier]), [[BUYER.claim, SELLER.claim], [SELLER.claim, SELLER.claim]]);
} assertPresent(await f.fresh().recoverBuyer(f.input)); });
test("W resolveSeller after a restart stays indeterminate while readback is unavailable and answers once both records read back finalized",async t=>{const f=await orchestratorFixture(t,{disk:true});assertPresent(await f.run());
 const odd=Object.assign(new Error('TEST code getter'),{});Object.defineProperty(odd,'code',{get(){throw new Error('TEST getter');}});
 for(const [cause,klass] of [[new Error('TEST read outage'),'unavailable'],[new DOMException('TEST read deadline','TimeoutError'),'timeout'],[Object.assign(new Error('TEST journal damaged'),{code:'journal-integrity'}),'journal-integrity'],[Object.assign(new Error('TEST journal busy'),{code:'journal-busy'}),'journal-busy']]){
  f.controls.onRead=()=>{throw cause;};assert.deepEqual(await f.fresh().resolveSeller(f.sellerRequest()),{disposition:'indeterminate',reason:`party Vet readback failed (${klass})`});
 }
 // The reason is a closed class: whatever else is thrown, no thrown text reaches it and the catch itself never throws.
 for(const cause of [null,undefined,'TEST raw',Object.assign(new Error('x'),{code:'TEST\nline /home/x'}),odd]){
  f.controls.onRead=()=>{throw cause;};const answer=await f.fresh().resolveSeller(f.sellerRequest());assert.deepEqual(answer,{disposition:'indeterminate',reason:'party Vet readback failed (unavailable)'});assert.ok(!/TEST|\/home/.test(answer.reason));
 }f.controls.onRead=null;assertPresent(await f.fresh().resolveSeller(f.sellerRequest()));
});
test("a party-Vet row with started writes under the counterparty mode is refused vet_mode_mismatch by a W provider, with zero signatures and wallet requests", async (t) => { const f = productionFixture(), p = await f.provider(); await p.resolveBuyer(f.input(), { writable: () => true }); const w = await orchestratorFixture(t); w.config.buyerAccess = null; w.config.store = f.store; w.config.wallet = f.config.wallet; w.config.listing = f.listing; w.config.anchor = { ...w.config.anchor, writer: f.config.wallet.claim }; const count = f.controls.signs; const answer = await w.run(w.provider(), f.input()); assert.equal(answer.code, 'vet_mode_mismatch'); assert.equal(f.controls.signs, count); assert.equal(w.controls.creates.length, 0); });
test("W recovery of a counterparty-mode row answers no context and writes nothing", async (t) => { const f = await orchestratorFixture(t); await f.run(); const before = await f.base.entries(), p = f.provider({ vetMode: 'counterparty', anchor: { ...f.config.anchor, vetMode: 'counterparty' } }); assert.equal(await p.recoverBuyer(f.input), null); assert.deepEqual(await f.base.entries(), before); });
test("a counterparty provider refuses a W row with started writes; a row with no write started is rebound with no signature", async (t) => { const f = await orchestratorFixture(t); await f.run(); const p = f.provider({ vetMode: 'counterparty', anchor: { ...f.config.anchor, vetMode: 'counterparty' } }); assert.equal((await f.run(p)).code, 'vet_mode_mismatch'); const g = await orchestratorFixture(t); await g.cut('seller', 'reserved'); const [key] = (await g.base.entries())[0]; await g.base.update(key, row => { row.binding.vetMode = 'counterparty'; return row; }); assertPresent(await g.run(g.fresh())); assert.equal(g.controls.signatures.length, 2); });
test("a vetMode member in the context scope, buyer bundle or Listing never changes the provider's mode", async (t) => { for (const location of ['scope', 'bundle', 'listing']) {
    const f = await orchestratorFixture(t);
    if (location === 'scope')
        f.input.scope.vetMode = 'counterparty';
    if (location === 'bundle')
        f.input.buyerIdentityBundle.vetMode = 'counterparty';
    if (location === 'listing')
        f.listing.vetMode = 'counterparty';
    let answer;
    try {
        answer = await f.run();
    }
    catch { }
    if (answer?.disposition === 'present')
        assert.equal(answer.value.input.seller.vetRecordRef.signer, SELLER.claim); assert.equal(f.config.vetMode, W);
    assert.equal(f.controls.counterpartyCalls, 0);
} });
test("a vetMode member in the context scope, buyer bundle or Listing never changes the provider's mode (default composition)",async()=>{
 for(const location of ['scope','bundle','listing']){
  const f=productionFixture(),input=f.input(),p=await f.provider();
  if(location==='scope')input.scope.vetMode=W;if(location==='bundle')input.buyerIdentityBundle.vetMode=W;if(location==='listing')f.listing.vetMode=W;
  let answer;try{answer=await p.resolveBuyer(input,{writable:()=>true});}catch{}
  assert.equal(p.vetMode,'counterparty');if(answer?.disposition==='present')assert.equal(answer.value.input.seller.vetRecordRef.signer,input.buyerIdentityBundle.presentedBy);
 }
});
test("the provider and the anchor refuse an unsupported vetMode at construction, before any store, journal or wallet use", async (t) => { const f = await orchestratorFixture(t); for (const mode of [null, '', false, {}, 'unknown']) {
    let touched = 0;
    assert.throws(() => f.provider({ vetMode: mode, store: new Proxy({}, { get() { touched++; throw new Error('TEST store touched'); } }) }), /unsupported Vet mode/); assert.equal(touched, 0);
} const { assembleArtifactAnchor } = await privateModule(new URL('../src/devnet-demo/artifact-anchor.mjs', import.meta.url), ['assembleArtifactAnchor']); let wallets = 0; assert.throws(() => assembleArtifactAnchor({ vetMode: null, walletFactory: () => { wallets++; } }), /unsupported Vet mode/); assert.equal(wallets, 0); });
test("a W provider refuses a counterparty anchor, and a counterparty provider refuses a W anchor, at construction", async (t) => { const f = await orchestratorFixture(t); for (const [providerMode, anchorMode] of [[W, 'counterparty'], ['counterparty', W]])
    assert.throws(() => f.provider({ vetMode: providerMode, anchor: { ...f.config.anchor, vetMode: anchorMode } }), /composed in different Vet modes/); });
test("with the kit operation guard off, the W provider and W anchor refuse kit_operation_guard_off before any signer, wallet or store write", async (t) => { const f = await orchestratorFixture(t), url = new URL('../src/devnet-demo/agreement-context.mjs', import.meta.url); const guard = new URL('../src/kit-operation-guard.mjs?TEST-unbypassed', import.meta.url).href; const module = await privateModule(url, [], source => source.replace("'../kit-operation-guard.mjs'", JSON.stringify(guard))); assert.throws(() => module.createDevnetDemoAgreementContextProvider(f.config), error => error.code === 'kit_operation_guard_off'); assert.equal(f.controls.signatures.length, 0); assert.equal((await f.base.entries()).length, 0); const anchor = await privateModule(new URL('../src/devnet-demo/artifact-anchor.mjs', import.meta.url), ['assembleArtifactAnchor'], source => source.replace("'../kit-operation-guard.mjs'", JSON.stringify(guard))); const native = await orchestratorFixture(t, { real: true }); let requests = 0; const { DEVNET_DEMO_ARTIFACT_POLICY } = await import('../src/dacs/devnet-source.mjs'); const off = anchor.assembleArtifactAnchor({ vetMode: W, sourceCapability: native.native.source, journal: native.native.journal, buyerAccess: native.config.buyerAccess, network: 'local-only', signer: { claim: SELLER.claim, sign: SELLER.signBytes }, walletFactory: () => ({ getPublicAccount: () => ({ address: SELLER.address }), getWriteProfile: () => ({ demoArtifactPublication: { policy: DEVNET_DEMO_ARTIFACT_POLICY } }), request: () => { requests++; } }) }, { reader: native.native.controls.reader }); await assert.rejects(off.publish({}), error => error.code === 'kit_operation_guard_off'); assert.equal(requests, 0); assert.equal(native.native.captured.length, 0); });
test("a W cut after a party's CREATE is finalized and before its step-completion save completes from authenticated readback of that exact record in a fresh provider, with no second CREATE and no new signature", async (t) => { for (const party of [SELLER, BUYER]) {
    const f = await orchestratorFixture(t, { disk: true, real: true }), reached = deferred();
    f.controls.afterPublish = async ({ logicalAddress }, out) => { if (logicalAddress === address(party)) {
        assert.equal(out.receipt.state, 'finalized');
        reached.resolve();
        await new Promise(() => { });
    } };
    void f.run().catch(() => { });
    await reached.promise;
    f.controls.afterPublish = null;
    assertPresent(await f.run(f.fresh()));
    assert.equal(f.native.captured.length, 2); assert.equal(f.controls.signatures.length, 2);
} });
test("a W signing step that holds written-ahead bytes and no retained signature stays indeterminate (pending) or replays its failure (failed) on every retry, with zero new signatures and CREATEs", async (t) => { for (const role of ['seller', 'buyer'])
    for (const failed of [false, true]) {
        const f = await orchestratorFixture(t, { disk: true });
        if (!failed)
            await f.cut(role, 'bytes');
        else {
            f.controls.beforeSign = () => { if (f.controls.signatures.length === (role === 'seller' ? 0 : 1))
                throw new Error('TEST signer unknown'); };
            await blocked(() => f.run());
            f.controls.beforeSign = null;
        }
        const count = f.controls.signatures.length, creates = f.controls.creates.length;
        for (let i = 0; i < 2; i++)
            await blocked(() => f.run(f.fresh()));
        assert.equal(f.controls.signatures.length, count); assert.equal(f.controls.creates.length, creates);
    } });
test("two recoverers race over one retained W reservation and a stale completion arrives late: exactly one takeover wins the evidence comparison, only the current reservation saves an outcome, a failed step's missing owner is never used as a fence, and total CVR signatures and CREATEs stay at one per party. Live holder: while the recoverer's authorization is paused, the original holder advances to bytes without a signature and enters a delayed signer, and then the authorization is released. The stale classification must not transfer ownership or call another signer. In a second variant the holder saves its signature during that await: reclassification may reuse it and never signs again. The original holder and the recoverer together make one signature, and a stale completion cannot overwrite current evidence. Both run on separate step lanes over the same transactional store", async (t) => {
    for (const role of ['seller', 'buyer'])
        for (const phase of ['reserved', 'prepared', 'signature', 'failed']) {
            const f = await orchestratorFixture(t, { disk: true }), cut = await f.cut(role, phase === 'failed' ? 'signature' : phase, { lostAck: phase === 'failed' });
            if (phase === 'failed')
                await blocked(() => cut.pending);
            const answers = await Promise.allSettled([f.run(f.fresh()), f.run(f.fresh())]);
            assert.ok(answers.some(out => out.status === 'fulfilled' && out.value.disposition === 'present'));
            cut.resume.resolve();
            await Promise.allSettled([cut.pending]);
            assertPresent(await f.run(f.fresh()));
            assert.equal(f.controls.signatures.length, 2); assert.equal(f.records.size, 2);
        }
});
test("two recoverers race over one retained W reservation and a stale completion arrives late: exactly one takeover wins the evidence comparison, only the current reservation saves an outcome, a failed step's missing owner is never used as a fence, and total CVR signatures and CREATEs stay at one per party. Live holder: while the recoverer's authorization is paused, the original holder advances to bytes without a signature and enters a delayed signer, and then the authorization is released. The stale classification must not transfer ownership or call another signer. In a second variant the holder saves its signature during that await: reclassification may reuse it and never signs again. The original holder and the recoverer together make one signature, and a stale completion cannot overwrite current evidence. Both run on separate step lanes over the same transactional store (anchor completion race)", async (t) => {
    for (const party of [SELLER, BUYER])
        await t.test(party === SELLER ? 'seller' : 'buyer', async (t) => {
            const f = await orchestratorFixture(t, { disk: true, real: true }), reached = deferred(), returned = deferred();
            f.controls.afterPublish = async ({ logicalAddress }) => {
                if (logicalAddress === address(party)) {
                    reached.resolve();
                    await returned.promise;
                }
            };
            const original = f.run();
            void original.catch(() => {
            });
            await reached.promise;
            f.controls.afterPublish = null;
            const answers = await Promise.allSettled([f.run(f.fresh()), f.run(f.fresh())]);
            assert.ok(answers.some(out => out.status === 'fulfilled' && out.value.disposition === 'present'));
            returned.resolve();
            await Promise.allSettled([original]);
            assertPresent(await f.run(f.fresh()));
            assert.equal(f.controls.signatures.length, 2); assert.equal(f.native.captured.length, 2);
        });
});
test("two recoverers race over one retained W reservation and a stale completion arrives late: exactly one takeover wins the evidence comparison, only the current reservation saves an outcome, a failed step's missing owner is never used as a fence, and total CVR signatures and CREATEs stay at one per party. Live holder: while the recoverer's authorization is paused, the original holder advances to bytes without a signature and enters a delayed signer, and then the authorization is released. The stale classification must not transfer ownership or call another signer. In a second variant the holder saves its signature during that await: reclassification may reuse it and never signs again. The original holder and the recoverer together make one signature, and a stale completion cannot overwrite current evidence. Both run on separate step lanes over the same transactional store (live signing evidence)", async (t) => {
    const { durableOperationStore, partyVetState } = await privateModule(new URL('../src/devnet-demo/agreement-context.mjs', import.meta.url), ['durableOperationStore', 'partyVetState']);
    for (const role of ['seller', 'buyer'])
        for (const phase of ['reserved', 'prepared'])
            for (const saved of [false, true])
                await t.test(`${role}/${phase}/${saved}`, async (t) => {
                    const f = await orchestratorFixture(t, { disk: true }), cut = await f.cut(role, phase), row = await f.row(), [key, step] = Object.entries(row.ops[role].steps).find(([key]) => JSON.parse(key).step === 'composite');
                    const authorizing = deferred(), authorized = deferred(), signing = deferred(), signer = deferred(), signatureSaved = deferred(), saveReturned = deferred();
                    let recoverExecutions = 0, signerCalls = 0;
                    f.controls.beforeSign = async () => {
                        signerCalls++;
                        signing.resolve();
                        await signer.promise;
                    };
                    if (saved)
                        f.controls.afterUpdate = async (before, next) => {
                            const entry = next?.ops?.[role]?.signing[key];
                            if (entry?.signature && !before?.ops?.[role]?.signing[key]?.signature) {
                                signatureSaved.resolve();
                                await saveReturned.promise;
                            }
                        };
                    const durable = durableOperationStore(partyVetState({ ...f.store }, SELLER.claim), { jobId: JOB, binding: row.binding, incarnation: row.lifecycle.incarnation }, role, { now: () => T0 + 40000, clock: {}, reconcile: async () => ({ retry: true }) });
                    const recovering = durable.operationStore.runOnceAuthorized({ ...JSON.parse(key), operationHash: step.operationHash, inputHash: step.inputHash, authorize: async () => {
                            authorizing.resolve();
                            await authorized.promise;
                            return { status: 'authorized' };
                        }, execute: async () => {
                            recoverExecutions++;
                            const latest = await f.row(), entry = latest.ops[role].signing[key], signature = await durable.writeAhead(Buffer.from(entry.signedBytes, 'hex'));
                            assert.ok(signature);
                            const bundle = role === 'seller' ? f.listing.seller.identity : f.input.buyerIdentityBundle, requirement = role === 'seller' ? { requirementVersion: '1', required: [], preferredPresentation: 'any' } : f.listing.buyerRequirement;
                            return { recordVersion: '1', jobId: JOB, evaluatedParty: bundle.presentedBy, bundleHash: identityBundleHash(bundle), requirementHash: sha256Hex(canonicalize(requirement)), freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: entry.generatedAt, signature: { algorithm: 'ed25519', signer: SELLER.claim, value: signature } };
                        } });
                    void recovering.catch(() => {
                    });
                    await authorizing.promise;
                    cut.resume.resolve();
                    await signing.promise;
                    if (saved) {
                        signer.resolve();
                        await signatureSaved.promise;
                    }
                    authorized.resolve();
                    if (saved) {
                        assert.equal((await recovering).status, 'complete');
                        saveReturned.resolve();
                        await Promise.allSettled([cut.pending]);
                        assert.equal(recoverExecutions, 1);
                        f.controls.afterUpdate = null;
                        f.controls.beforeSign = null;
                        assertPresent(await f.run(f.fresh()));
                    }
                    else {
                        await assert.rejects(recovering, error => error.code === 'indeterminate');
                        assert.equal(recoverExecutions, 0);
                        signer.resolve();
                        assertPresent(await cut.pending);
                    }
                    assert.equal(signerCalls, saved ? 1 : role === 'seller' ? 2 : 1);
                    assert.equal(f.controls.signatures.length, 2); assert.equal(f.records.size, 2);
                });
});
test("a W takeover whose fresh authorization is refused or throws writes nothing: the step and its signing entry stay byte-equal, nothing is signed, and the next authorized call completes with one CVR signature per party in total", async (t) => {
    const { durableOperationStore, partyVetState } = await privateModule(new URL('../src/devnet-demo/agreement-context.mjs', import.meta.url), ['durableOperationStore', 'partyVetState']);
    for (const role of ['seller', 'buyer'])
        for (const phase of ['reserved', 'prepared', 'signature', 'failed'])
            for (const throws of [false, true]) {
                const f = await orchestratorFixture(t, { disk: true });
                const cut = await f.cut(role, phase === 'failed' ? 'signature' : phase, { lostAck: phase === 'failed' });
                if (phase === 'failed')
                    await blocked(() => cut.pending);
                const row = await f.row(), state = partyVetState({ ...f.store }, SELLER.claim), [key, step] = Object.entries(row.ops[role].steps).find(([key]) => JSON.parse(key).step === 'composite'), job = { jobId: JOB, binding: row.binding, incarnation: row.lifecycle.incarnation }, before = await f.base.entries();
                const durable = durableOperationStore(state, job, role, { now: () => T0, clock: {}, reconcile: async () => ({ retry: true }) });
                const work = () => durable.operationStore.runOnceAuthorized({ ...JSON.parse(key), ...step, execute: () => assert.fail('unauthorized executor'), authorize: async () => {
                        if (throws)
                            throw new Error('TEST auth unavailable');
                        return { status: 'rejected', reason: 'expired' };
                    } });
                if (throws)
                    await assert.rejects(work, /TEST auth unavailable/);
                else
                    assert.deepEqual(await work(), { status: 'authorization-rejected', reason: 'expired' });
                assert.deepEqual(await f.base.entries(), before);
                assertPresent(await f.run(f.fresh()));
                assert.equal(f.controls.signatures.length, 2);
            }
});
test("every Vet-backed W answer freshly reads both records and requires strictly valid records and verified finalized, established receipts; no fault yields present, including a joined answer and a previously answered context. For the partial-failure path, finalize the seller record, fail the buyer CREATE before any intent (a failed anchor step with proven unsigned absence), then inject each seller receipt fault before retry: no new signature or CREATE and no present. Faults target existing records; an expected missing record is allowed only while resuming its missing write, never in a successful answer. Each cell has an unchanged finalized control; partial-failure and resume controls write only what is missing and never re-sign the seller. Agent restart and its receipt-fault matrix run at P08b's head in T6, T11 and T23, which consume these fixtures without adding an agent dependency to P08a", async (t) => {
    for (const path of ['initial', 'joined', 'finished', 'partial', 'recovered'])
        for (const party of path === 'partial' ? [SELLER] : [SELLER, BUYER])
            for (const state of ['accepted', 'included', 'unknown', 'dropped', 'replaced', 'reorged', 'absent', 'throws', 'finalized'])
                await t.test(`${path}/${party === SELLER ? 'seller' : 'buyer'}/${state}`, async (t) => {
                    const f = await orchestratorFixture(t), p = f.provider();
                    if (path === 'partial') {
                        let once = true;
                        f.controls.beforePublish = ({ logicalAddress }) => {
                            if (once && logicalAddress === address(BUYER)) {
                                once = false;
                                throw new Error('TEST no buyer intent');
                            }
                        };
                        await blocked(() => f.run(p));
                    }
                    else if (['finished', 'recovered'].includes(path))
                        assertPresent(await f.run(p));
                    if (path === 'initial' || path === 'joined')
                        f.controls.afterPublish = ({ logicalAddress }) => {
                            if (logicalAddress === address(party))
                                f.controls.fault = { party: address(party), state };
                        };
                    else
                        f.controls.fault = { party: address(party), state };
                    const signatures = f.controls.signatures.length, creates = f.controls.creates.length;
                    const read = () => path === 'recovered' ? f.fresh().recoverBuyer(f.input) : f.run(p);
                    if (state === 'finalized')
                        assertPresent(await read());
                    else {
                        if (path === 'joined')
                            await Promise.all([blocked(read), blocked(read)]);
                        else
                            await blocked(read);
                        assert.equal(p.contexts.size, ['finished', 'recovered'].includes(path) ? 1 : 0);
                        if (path === 'partial') {
                            assert.equal(f.controls.signatures.length, signatures);
                            assert.equal(f.controls.creates.length, creates);
                        }
                    }
                });
});
test("in W, a request outside this seller's own Listing and wallet terms is refused (resolveBuyer rejected; the recovery and resume entries answer no context) before any signature, anchor write or counterparty call. After a restart, a request time that is not among the retained times gets neither present nor a cached context from recoverBuyer or resolveSeller, while the retained time still answers. A context ended or swept during the call's final verification is never answered present and leaves no cached answer. Each gate has a control with the seller's own terms, a retained time and no release, which answers present", async (t) => {
    for (const entry of ['resolveBuyer', 'recoverBuyer', 'resolveSeller', 'resumableBuyer'])
        for (const fault of ['payee', 'seller', 'listingPin', 'price', 'unsupported', 'released', 'ended', 'swept', 'control'])
            await t.test(`${entry}/${fault}`, async (t) => {
                const f = await orchestratorFixture(t), p = f.provider();
                assertPresent(await f.run(p));
                const value = copy(f.input), request = f.sellerRequest();
                if (['payee', 'seller'].includes(fault))
                    value.scope[fault] = OTHER[fault === 'seller' ? 'claim' : 'address'];
                if (fault === 'listingPin')
                    value.scope.listingPin.contentHash = 'a'.repeat(64);
                if (fault === 'price')
                    value.scope.price.amount = '999';
                if (fault === 'unsupported')
                    f.listing.pricing.kind = 'auction';
                if (fault === 'released') {
                    const later = { ...f.input, scope: { ...f.input.scope, generatedAt: T0 + 1 } };
                    assertPresent(await f.run(p, later));
                    await p.release({ jobId: JOB, generatedAt: T0 + 1 });
                    assertPresent(await f.fresh().recoverBuyer(later));
                    assertPresent(await f.fresh().resolveSeller({ ...request, generatedAt: T0 + 1 }));
                }
                if (entry === 'resolveSeller' && ['payee', 'seller', 'price'].includes(fault)) {
                    const [key] = (await f.base.entries())[0];
                    await f.base.update(key, row => {
                        row.binding.scope = copy(value.scope);
                        delete row.binding.scope.generatedAt;
                        return row;
                    });
                }
                const releasing = ['ended', 'swept'].includes(fault), fresh = releasing && entry === 'resolveBuyer' ? p : f.fresh();
                if (releasing) {
                    let reads = 0, hit = false;
                    f.controls.onRead = async () => {
                        if (entry === 'resolveBuyer' && ++reads < 3)
                            return;
                        if (hit)
                            return;
                        hit = true;
                        if (fault === 'ended')
                            await fresh.release({ jobId: JOB });
                        else
                            await fresh.sweep(() => true);
                    };
                }
                const count = f.controls.signatures.length;
                const read = () => entry === 'resolveBuyer' ? f.run(fresh, value) : entry === 'resolveSeller' ? fresh.resolveSeller({ ...request, listingPin: value.scope.listingPin }) : fresh[entry](value);
                if (fault === 'control')
                    assertPresent(await (entry === 'resumableBuyer' ? fresh.recoverBuyer(value) : read()));
                else
                    await blocked(read);
                assert.equal(f.controls.signatures.length, count); assert.equal(f.controls.counterpartyCalls, 0);
                if (releasing)
                    assert.equal(fresh.contexts.size, 0);
            });
});
test('a store-busy error while a taken-over W step runs again keeps its written-ahead bytes and kept signature, so the next run signs nothing new', async (t) => {
    for (const role of ['seller', 'buyer'])
        await t.test(role, async (t) => {
            const f = await orchestratorFixture(t, { disk: true });
            await f.cut(role, 'signature');
            const reservation = async () => Object.values((await f.row()).ops[role].signing)[0].reservation, original = await reservation();
            let busy = 0;
            // The takeover moves the signing entry to the recoverer's reservation; the next read of the row then meets a busy store.
            const flaky = { ...f.store, read: async (key) => { if (!busy && await reservation() !== original) { busy++; throw Object.assign(new Error('TEST store busy'), { code: 'journal-busy' }); } return f.store.read(key); } };
            await blocked(() => f.run(f.provider({ store: flaky, anchor: f.openAnchor() })));
            assert.equal(busy, 1);
            const kept = Object.values((await f.row()).ops[role].signing)[0];
            assert.ok(kept.signedBytes && kept.signature);
            assertPresent(await f.run(f.fresh()));
            assert.equal(f.controls.signatures.length, 2);
        });
});
const compositeEntries = async (f, role) => { const ops = (await f.row()).ops[role]; return { steps: Object.keys(ops.steps).filter(key => JSON.parse(key).step === 'composite'), signing: Object.keys(ops.signing) }; };
test('a W signer refusal that proves no signature was made clears the step and its written-ahead bytes, so a retry signs once', async (t) => {
    for (const role of ['seller', 'buyer'])
        await t.test(role, async (t) => {
            const f = await orchestratorFixture(t, { disk: true });
            let refused = 0;
            f.controls.beforeSign = () => { if (!refused && f.controls.signatures.length === (role === 'seller' ? 0 : 1)) { refused++; throw Object.assign(new Error('TEST operator refused'), { code: 'user_rejected' }); } };
            await blocked(() => f.run());
            assert.equal(refused, 1);
            assert.deepEqual(await compositeEntries(f, role), { steps: [], signing: [] });
            assertPresent(await f.run(f.fresh()));
            assert.equal(f.controls.signatures.length, 2);
        });
});
test('a store-busy error after the bytes are written ahead and before the signer runs clears the step, so a retry signs once', async (t) => {
    for (const role of ['seller', 'buyer'])
        await t.test(role, async (t) => {
            const f = await orchestratorFixture(t, { disk: true });
            let busy = 0;
            // The purchase check right after the write-ahead is the first read that sees bytes without a signature.
            const flaky = { ...f.store, read: async (key) => { const entries = Object.values((await f.row())?.ops[role].signing ?? {}); if (!busy && entries.some(entry => entry.signedBytes && !entry.signature)) { busy++; throw Object.assign(new Error('TEST store busy'), { code: 'journal-busy' }); } return f.store.read(key); } };
            await blocked(() => f.run(f.provider({ store: flaky, anchor: f.openAnchor() })));
            assert.equal(busy, 1);
            assert.equal(f.controls.signatures.length, role === 'seller' ? 0 : 1);
            assert.deepEqual(await compositeEntries(f, role), { steps: [], signing: [] });
            assertPresent(await f.run(f.fresh()));
            assert.equal(f.controls.signatures.length, 2);
        });
});
