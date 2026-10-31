import { canonicalize, contentHash, identityBundleHash, paymentEvidenceAddress, sameCanonicalClaimIdentity, sha256Hex, verifySellerPaymentIntake, verifySettlementEvidence } from '@kynesyslabs/dacs';
import { fixtureRef, signAnchorWrite, verifyFixtureRecord } from './fixture-anchors.mjs';
import { readAdmissionCapability } from './session-admission.mjs';
import { agreementTerms, deliverableAddress, deliveryEvidenceAddress, DEM_RAIL_DEFINITION, ed25519Deps, RAIL_REGISTRY_VERSION, verifyDelivery, verifyPaymentEvidence } from './purchase-protocol.mjs';
const normalized = value => String(value).toLowerCase().replace(/^0x/, '');
const same = (left, right) => canonicalize(left) === canonicalize(right);
// Fixture settlement uses current authenticated job facts and one retained
// authorization. Saved progress constrains bytes; it never grants credit.
export function createFixtureSettlement({ listing, validation, sellerBundle, claim, anchors, observer, receiptStore, sessionFor, commit, sign, signEvidence, reportFor, persist, durable, bindSettlement, assertCredit, heldFor, now, error }) {
    if (observer !== undefined && typeof observer !== 'function')
        throw new TypeError('observeDemosTransfer must be a function');
    const intents = new Set(), pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) };
    const read = address => readAdmissionCapability(anchors, 'read', address);
    const deps = session => ({
        resolveCommittedAgreement: async () => ({ disposition: 'verified', agreement: structuredClone(session.agreement), agreementHash: session.commitment.agreementHash,
            commitment: { finality: 'finalized', ref: session.commitment.logicalAddress, contentHash: contentHash(session.commitment.record), jobId: session.jobId, agreementHash: session.commitment.agreementHash,
                listingRef: { ...session.agreement.listingRef }, committedAt: session.commitment.committedAt, signer: session.commitment.record.signature.signer }, railRegistryVersion: RAIL_REGISTRY_VERSION }),
        resolveListingAtCommit: async (ref) => same(ref, pin) ? { rawListing: structuredClone(listing), validation: structuredClone(validation) } : { rawListing: {}, validation: { disposition: 'rejected', reason: 'unknown-listing' } },
        resolveRail: async ({ ref, railRegistryVersion }) => ref?.railId === DEM_RAIL_DEFINITION.railId && railRegistryVersion === RAIL_REGISTRY_VERSION
            ? { disposition: 'verified', rail: DEM_RAIL_DEFINITION, railRegistryVersion: RAIL_REGISTRY_VERSION } : { disposition: 'rejected', reason: 'unknown rail' },
        resolveIdentityBundle: async (hash) => {
            for (const bundle of [sellerBundle, session.buyerBundle])
                if (identityBundleHash(bundle) === hash)
                    return { disposition: 'verified', bundle: structuredClone(bundle) };
            return { disposition: 'rejected', reason: 'unknown identity bundle' };
        },
        resolvePayerAddress: async () => ({ disposition: 'rejected', reason: 'x402 is not supported by this agent' }),
        resolvePayeeDestination: async () => ({ disposition: 'error', reason: 'x402 is not supported by this agent', tier: 2 }),
        observeDemosTransfer: hash => readAdmissionCapability({ read: (value, limits) => observer(value, limits) }, 'read', hash),
        observeX402Transfer: async () => ({ status: 'unavailable', reason: 'x402 is not supported by this agent' }),
        verifyX402ReceiptExtensions: () => ({ disposition: 'fail', reason: 'x402 is not supported by this agent' }),
        classifyX402SettlementChain: () => ({ disposition: 'unsupported', reason: 'x402 is not supported by this agent' }), receiptStore,
    });
    const guard = jobId => { assertCredit(jobId); if (heldFor(jobId)() !== true)
        error('seller_state_locked', 'the job fence was lost'); };
    async function authenticate(session, txHash, payerPayingKey) {
        if (typeof observer !== 'function')
            error('payment_observation_unavailable', 'fixture payment observation is not configured');
        if (!session.commitment)
            error('not_committed', 'the Agreement is not committed; no payment is accepted before commitment', 422);
        if (!sameCanonicalClaimIdentity(payerPayingKey, session.buyerBundle.presentedBy))
            error('payer_not_authenticated', 'the paying key is not the authenticated buyer claim', 422);
        await commit({ jobId: session.jobId });
        txHash=session.paymentWork?.intake?.settlementIdentity?.txHash??normalized(txHash);
        const terms = agreementTerms(session.agreement);
        const intake = await verifySellerPaymentIntake({ jobId: session.jobId, phaseIndex: terms.paymentPhaseIndex, railId: terms.rail, payerPayingKey, receipt: { kind: 'pay-dem', txHash } }, deps(session));
        assertCredit(session.jobId);
        return intake;
    }
    async function anchorOnce(jobId, address, artifact) {
        guard(jobId);
        const retained = await read(address);
        if (retained?.status === 'present') {
            if (!same(retained.artifact, artifact) || verifyFixtureRecord(retained, { logicalAddress: address, expectedWriter: claim }) !== 'valid')
                error('payment_readback_required', 'retained fixture artifact differs');
            return { ref: fixtureRef(address, contentHash(artifact)), receipt: retained.receipt };
        }
        if (retained?.status !== 'absent')
            error('payment_readback_required', 'fixture artifact readback is unavailable');
        if (!durable && intents.has(address))
            error('payment_readback_required', 'an earlier fixture write has no authenticated readback');
        const authorize = () => { guard(jobId); return signAnchorWrite(sign, address, contentHash(artifact)); };
        if (durable)
            await durable.anchor({ jobId, logicalAddress: address, artifact, anchors, authorize });
        else {
            intents.add(address);
            await anchors.write({ logicalAddress: address, artifact, writer: claim, writerSignature: authorize() });
        }
        const record = await read(address);
        if (record?.status !== 'present' || !same(record.artifact, artifact) || verifyFixtureRecord(record, { logicalAddress: address, expectedWriter: claim }) !== 'valid')
            error('payment_readback_required', 'fixture write has no exact authenticated readback');
        guard(jobId);
        return { ref: fixtureRef(address, contentHash(artifact)), receipt: record.receipt };
    }
    async function verifyCompleted(session, intake) {
        const payment = session.payment;
        const records = await Promise.all([payment.ref, payment.deliverableRef, payment.deliveryRef].map(ref => read(ref.anchor.locator)));
        const [paymentRecord, deliverable, evidenceRecord] = records;
        const terms = agreementTerms(session.agreement), addresses = [paymentEvidenceAddress(session.jobId, terms.rail, terms.paymentPhaseIndex), deliverableAddress(session.jobId), deliveryEvidenceAddress(session.jobId)];
        const refs = [payment.ref, payment.deliverableRef, payment.deliveryRef];
        for (let index = 0; index < 3; index++)
            if (refs[index].anchor.locator !== addresses[index] || records[index]?.status !== 'present' || contentHash(records[index].artifact) !== refs[index].contentHash
                || verifyFixtureRecord(records[index], { logicalAddress: addresses[index], expectedWriter: claim }) !== 'valid')
                error('payment_readback_required', 'retained fixture artifacts changed');
        const checked = await verifyPaymentEvidence({ agreement: session.agreement, record: paymentRecord, observed: intake.settlementIdentity });
        const delivery = await verifyDelivery({ agreement: session.agreement, deliverable, evidenceRecord });
        if (checked.status !== 'verified' || delivery.status !== 'verified')
            error('payment_readback_required', 'retained fixture evidence is not authenticated');
        guard(session.jobId);
    }
    const answer = session => ({ status: 'delivered', settlementId: session.payment.settlementId, evidenceAddress: session.payment.ref.anchor.locator, deliverableAddress: session.payment.deliverableRef.anchor.locator, deliveryEvidenceAddress: session.payment.deliveryRef.anchor.locator });
    async function submitPayment({ jobId, txHash, payerPayingKey }) {
        const session = sessionFor(jobId), normalizedTx = normalized(txHash), work = session.paymentWork;
        if (session.payment && normalized(session.payment.txHash) !== normalizedTx)
            error('payment_already_recorded', 'this job already has a verified payment', 409);
        if (work && (normalized(work.txHash) !== normalizedTx || work.payerPayingKey !== payerPayingKey))
            error('seller_payment_work_conflict', 'retained payment tuple differs', 409);
        const intake = await authenticate(session, txHash, payerPayingKey);
        if ((session.payment||work) && (intake.disposition !== 'verified' || !['claim', 'already-claimed'].includes(intake.fulfilment))) error('payment_readback_required',intake.reason??'retained payment is not freshly authenticated');
        if (intake.disposition !== 'verified' || !['claim', 'already-claimed'].includes(intake.fulfilment))
            return { status: intake.disposition === 'error' ? 'error' : intake.disposition === 'indeterminate' ? 'indeterminate' : 'rejected', reason: intake.reason };
        if (!bindSettlement(intake.settlementId, jobId))
            return { status: 'indeterminate', reason: 'settlement-collision' };
        if (work && !same([work.intake.settlementId, work.intake.evidenceHash, work.intake.evidenceInput, work.intake.permitId], [intake.settlementId, intake.evidenceHash, intake.evidenceInput, intake.permitId]))
            error('seller_payment_work_conflict', 'retained payment authorization differs');
        if (session.payment) {
            if (session.payment.settlementId !== intake.settlementId)
                error('payment_readback_required', 'retained settlement differs');
            await verifyCompleted(session, intake);
            return answer(session);
        }
        if (!work)
            session.paymentWork = { txHash: normalizedTx, payerPayingKey, intake: JSON.parse(JSON.stringify(intake)), deliveredAt: now() };
        const saved = session.paymentWork;
        if (!saved.report)
            saved.report = reportFor(session, intake.settlementId);
        persist(session);
        guard(jobId);
        const evidence = await signEvidence(structuredClone(saved.intake.evidenceInput));
        if (contentHash(evidence) !== saved.intake.evidenceHash)
            error('evidence_hash_mismatch', 'signed evidence differs from the retained authorization');
        const terms = agreementTerms(session.agreement), paymentAnchor = await anchorOnce(jobId, paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex), evidence);
        const report = saved.report, deliverableAnchor = await anchorOnce(jobId, deliverableAddress(jobId), report), deliveredAt = saved.deliveredAt;
        guard(jobId);
        const deliveryEvidence = await signEvidence({ evidenceVersion: '1', jobId, phase: 'deliver-storage-program', outcome: 'success', deliverableContentHash: sha256Hex(canonicalize(report)), deliverableAnchor: { kind: 'storage-program', locator: deliverableAddress(jobId) }, observedAt: deliveredAt });
        const checked = await verifySettlementEvidence(deliveryEvidence, { orchestrator: claim, agreement: { amount: terms.price.amount, currency: terms.price.currency }, attestationRef: fixtureRef(deliveryEvidenceAddress(jobId), contentHash(deliveryEvidence)), result: { ok: true }, expectedAnchorLocator: deliverableAddress(jobId) }, ed25519Deps);
        if (checked.decision !== 'pass')
            error('delivery_evidence_invalid', checked.reasons.join('; '));
        const deliveryAnchor = await anchorOnce(jobId, deliveryEvidenceAddress(jobId), deliveryEvidence);
        guard(jobId);
        session.payment = { txHash: normalizedTx, blockNumber: saved.intake.settlementIdentity.blockNumber, settlementId: intake.settlementId, permitId: intake.permitId, ref: paymentAnchor.ref, deliveryRef: deliveryAnchor.ref, deliverableRef: deliverableAnchor.ref, deliveredAt };
        session.stage = 'delivered';
        persist(session);
        return answer(session);
    }
    // Read-only recovery of a completed claim: the exact retained payment is
    // authenticated afresh (commitment readback, intake over the observed
    // transfer with the permit inspected, never claimed, and every published
    // artifact), with nothing signed, claimed, anchored or sent.
    async function readPayment({ jobId, txHash, payerPayingKey }) {
        const session = sessionFor(jobId), work = session.paymentWork;
        if (!work || !session.payment || normalized(work.txHash) !== normalized(txHash) || work.payerPayingKey !== payerPayingKey)
            error('payment_readback_required', 'this exact payment has no durable completion checkpoint');
        const inspectOnly = { claim: async (candidate) => {
            const permit = await receiptStore.inspectPermit(work.intake.permitId);
            if (permit?.status !== 'available' || candidate.jobId !== jobId || candidate.settlementId !== work.intake.settlementId || !same(permit.claim?.authorization, candidate.authorization))
                error('payment_readback_required', 'the retained permit differs');
            return { status: 'already-claimed', permitId: work.intake.permitId, claim: permit.claim };
        } };
        await commit({ jobId }, { readbackOnly: true });
        const terms = agreementTerms(session.agreement);
        const intake = await verifySellerPaymentIntake({ jobId, phaseIndex: terms.paymentPhaseIndex, railId: terms.rail, payerPayingKey, receipt: { kind: 'pay-dem', txHash: work.intake.settlementIdentity.txHash } }, { ...deps(session), receiptStore: inspectOnly });
        if (intake.disposition !== 'verified' || intake.fulfilment !== 'already-claimed' || !same([intake.settlementId, intake.evidenceHash, intake.permitId], [work.intake.settlementId, work.intake.evidenceHash, work.intake.permitId]))
            error('payment_readback_required', 'fresh payment authentication differs from the retained payment');
        assertCredit(jobId);
        await verifyCompleted(session, intake);
        return answer(session);
    }
    return Object.freeze({ submitPayment, readPayment });
}
