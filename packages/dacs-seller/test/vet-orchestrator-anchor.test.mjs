import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { orchestratorFixture, W, SELLER, BUYER, OTHER, JOB, address, copy, signedRecord, assertPresent } from './helpers/vet-orchestrator-fixture.mjs';
const kind = 'CompositeVerificationRecord';
const request = (artifact, verifier = SELLER.claim) => ({ logicalAddress: address(SELLER), artifact, artifactKind: kind, verifier });
async function sellerRecord(t){const producer=await orchestratorFixture(t);assertPresent(await producer.run());return copy(producer.records.get(address(SELLER)).artifact);}
test("a W anchor publishes, reads back and verifies a seller-signed seller record, also after a restart (wallet requests 1, owner SELLER)",async t=>{const f=await orchestratorFixture(t,{real:true}),artifact=await sellerRecord(t),input=request(artifact);assert.equal((await f.native.open().publish(input)).status,'present');
 const anchor=f.native.open(),read=await anchor.read({...input,fresh:true});assert.equal(read.status,'present');assert.equal(read.receipt.state,'finalized');
 assert.equal(await anchor.verifyReceipt({...input,receipt:read.receipt,fresh:true}),'valid');assert.equal(f.native.captured.length,1);assert.equal(f.native.captured[0].owner,SELLER.claim);});
test("a W anchor refuses a seller record whose signer or signature is wrong at each boundary it owns, wallet requests 0 at publication, each beside a successful same-boundary control; receipt faults apply only to readback and receipt verification (T45, T9), because publish takes no receipt", async (t) => { for (const fault of ['buyer', 'other', 'signature'])
    for (const boundary of ['publish', 'read', 'readRetained', 'verifyReceipt'])
        await t.test(`${boundary}/${fault}`, async (t) => { const f = await orchestratorFixture(t, { real: true }); assertPresent(await f.run()); const good = copy(f.records.get(address(SELLER)).artifact), bad = fault === 'signature' ? { ...good, signature: { ...good.signature, value: 'A'.repeat(86) } } : await signedRecord(good, fault === 'buyer' ? BUYER : OTHER), anchor = f.native.open(), count = f.native.captured.length; assert.equal((await anchor.read({ ...request(good), fresh: true })).status, 'present'); let answer; if (boundary === 'readRetained') {
            for (const [key, row] of f.native.journal.rows)
                if (row.input?.logicalAddress === address(SELLER)) {
                    row.input.artifact = bad;
                    f.native.journal.rows.set(key, row);
                }
            answer = await anchor.readRetained({ logicalAddress: address(SELLER), artifactKind: kind, fresh: true });
        }
        else if (boundary === 'verifyReceipt')
            answer = await anchor.verifyReceipt({ ...request(bad), receipt: f.records.get(address(SELLER)).receipt, fresh: true });
        else if (boundary === 'publish') {
            await assert.rejects(anchor.publish(request(bad)), error => error.code === 'invalid');
            answer = 'invalid';
        }
        else
            answer = await anchor.read(request(bad)); assert.ok(answer === 'invalid' || answer.status === 'rejected'); assert.equal(f.native.captured.length, count); }); });
test("a counterparty anchor refuses a W-shaped record whatever vetMode the artifact, request or publish({verifier}) carries; a W anchor stays W", async (t) => { const f = await orchestratorFixture(t, { real: true }); assertPresent(await f.run()); const artifact = f.records.get(address(SELLER)).artifact; const { anchorFixture } = await import('./helpers/anchor-isolated-fixture.mjs'); const g = await anchorFixture({ writer: { claim: SELLER.claim, sign: SELLER.signBytes } }); for (const option of [{ vetMode: W }, { verifier: SELLER.claim, vetMode: W }, { artifact: { ...artifact, vetMode: W } }])
    await assert.rejects(g.open().publish({ ...request(artifact), ...option }), error => error.code === 'invalid'); assert.equal(g.captured.length, 0); assert.equal(f.native.open().vetMode, W); await assert.rejects(f.native.open().publish(request(artifact, BUYER.claim)), error => error.code === 'invalid'); });
test("a seller-record intent retained under the other mode is refused by the anchor itself on every path: no change to either journal, no wallet request, no recovery transmission, and no unsigned-resume proof; each branch has a valid same-mode control, and a later provider refusal never stands in for the anchor's",async t=>{
 const {anchorFixture}=await import('./helpers/anchor-isolated-fixture.mjs');
 const {isProvenUnsignedAbsence}=await import('../src/dacs/native-dem-delivery-consumer.mjs');
 for(const from of [W,'counterparty'])for(const unsigned of [false,true])for(const path of ['readRetained','read','publish','verifyReceipt'])
  await t.test(`${from}/${unsigned}/${path}`,async t=>{
   const f=await orchestratorFixture(t,{real:true,vetMode:from}),original=f.native.open();
   let record=await sellerRecord(t);
   if(from==='counterparty')record=await signedRecord(record,BUYER);
   const input=request(record,from===W?SELLER.claim:BUYER.claim),landing=f.native.controls.request;
   if(unsigned)f.native.controls.request=async()=>({success:false,error:{code:'TEST-unsigned'}});
   const published=await original.publish(input);assert.equal(published.status,unsigned?'indeterminate':'present');
   const other=await anchorFixture({writer:{claim:SELLER.claim,sign:SELLER.signBytes},vetMode:from===W?'counterparty':W});
   for(const [k,v]of f.native.journal.rows)other.journal.rows.set(k,copy(v));for(const [k,v]of f.native.sourceJournal.rows)other.sourceJournal.rows.set(k,copy(v));
   Object.assign(other.controls.reader,f.native.controls.reader);other.controls.reader.verifyReceipt=async()=>assert.fail('other-mode receipt reader');other.source.binding=async()=>assert.fail('other-mode recovery send');
   f.native.controls.request=landing;
   const control=unsigned&&path==='verifyReceipt'?await original.publish(input):published;
   const swapped=await signedRecord(record,from===W?BUYER:SELLER),otherInput=request(swapped,from===W?BUYER.claim:SELLER.claim);
   const invoke=(anchor,requested=input)=>path==='readRetained'?anchor.readRetained({logicalAddress:address(SELLER),artifactKind:kind,fresh:true,proofOfNoIntent:true}):path==='verifyReceipt'?anchor.verifyReceipt({...requested,receipt:control.receipt,fresh:true}):anchor[path]({...requested,fresh:true});
   const positive=await invoke(original);
   if(unsigned&&['read','readRetained'].includes(path))assert.equal(isProvenUnsignedAbsence(positive),true);
   else assert.ok(positive==='valid'||positive.status==='present');
   const before=canonicalize(await other.journal.entries()),sourceBefore=canonicalize(await other.sourceJournal.entries());
   // publish meets the retained intent as the existing scope conflict; verifyReceipt never reads intents, so it refuses the record's other-mode shape.
   let negative;if(path==='publish'){await assert.rejects(invoke(other.open(),otherInput),error=>error.code==='conflict');negative='invalid';}else negative=await invoke(other.open(),path==='verifyReceipt'?input:otherInput);
   assert.ok(negative==='invalid'||negative.status==='rejected');assert.equal(other.captured.length,0);
   assert.equal(canonicalize(await other.journal.entries()),before);assert.equal(canonicalize(await other.sourceJournal.entries()),sourceBefore);
  });
});
test("a seller record published at another job's composite address through the W anchor composed with the packaged seller wallet (operator-approval.mjs, not the isolated fixture's request counter) is refused by the wallet (logical-address) with zero transaction signatures and zero transmissions, beside a successful canonical-address control", async (t) => {
    const f = await orchestratorFixture(t, { real: true });
    // Each wallet request is answered by the packaged seller policy (operator-approval.mjs), then counted as a signature and a transmission.
    const { policyRefusal, SELLER_POLICY_DEFAULTS } = await import('../src/devnet-demo/operator-approval.mjs');
    const { requestFor, sourceBinding, artifactAuthority } = await import('./helpers/d5-policy-fixtures.mjs');
    const policy = { address: SELLER.address, seller: SELLER.claim, sourceBinding, artifactAuthority, listingPin: () => f.input.scope.listingPin, resolvePurchase: () => ({ jobId: JOB, seller: SELLER.claim, buyer: BUYER.claim, listingPin: f.input.scope.listingPin, sourceBinding, agreementHash: 'a'.repeat(64), amountOs: f.input.scope.price.amountOs, paymentObserved: false, paymentTxRef: null, prePaymentOpen: true }) };
    const landing = f.native.controls.request;
    let transactionSignatures = 0, transmissions = 0;
    f.native.controls.request = async (request) => { const input = requestFor({ artifactKind: kind, job: JOB, party: request.transaction.content.data[1].data.evaluatedParty, artifact: request.transaction.content.data[1].data, walletAddress: SELLER.address, writer: SELLER.claim, logicalAddress: request.logicalAddress }); const reason = await policyRefusal(input, policy, SELLER_POLICY_DEFAULTS); if (reason)
        return { success: false, error: { code: reason } }; transactionSignatures++; transmissions++; return landing(request); };
    const record = await sellerRecord(t);
    const published = await f.native.open().publish(request(record));
    assert.equal(published.status, 'present');
    assert.equal(transactionSignatures, 1);
    assert.equal(transmissions, 1);
    const out = await f.native.open().publish({ ...request(record), logicalAddress: address(SELLER).replace(JOB, '01M5YKPJG048H248H248H248H2') });
    assert.match(out.reason, /logical-address/);
    assert.equal(transactionSignatures, 1);
    assert.equal(transmissions, 1);
});
