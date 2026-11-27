// Classification of every function a shipped seller module exports (51-3):
// an effect entry is guarded (the entries it reaches are named, and each is
// listed in kit-operation-guard.test.mjs), anything else signs, sends and
// rebroadcasts nothing itself. A new export fails the sweep until it is added
// here. src/index.mjs only re-exports functions classified below.
export const EXPORT_CLASSIFICATION = Object.freeze({
  'src/cli/config.mjs': { effect: {}, pure: ['SellerConfigError', 'assertConfigBindsDirectory', 'assertSellerConfigComplete', 'listingTermsFromConfig', 'listingTermsFromListing', 'parseSellerConfig'] },
  'src/cli/init.mjs': { effect: {}, pure: ['runInit'] },
  'src/cli/main.mjs': { effect: {}, pure: ['main', 'parseCliArguments'] },
  'src/cli/node-identity.mjs': { effect: {}, pure: ['deriveWalletIdentity', 'generateWalletMnemonic', 'validateMnemonic'] },
  'src/dacs/abandoned-purchase.mjs': { effect: {}, pure: ['createAbandonedPurchaseState'] },
  'src/dacs/accounting-reconciliation.mjs': { effect: {  }, pure: ['createAccountingReconciler'] },
  // Its signer signs only inside a pass of the guarded effect boundary, with the key's guarded effect role.
  'src/dacs/agent-effect-signer.mjs': { effect: {}, pure: ['agentEffectOperation', 'createAgentEffectSigner'] },
  // Constructing it signs nothing; its answers are signed only through the roles it is given: the effect role inside a pass of the
  // guarded effect boundary, and the closed read-only role otherwise. Its returned signAnswer is classified in RETURNED_CLASSIFICATION.
  'src/dacs/answer-signers.mjs': { effect: {}, pure: ['createAnswerSigners'] },
  'src/dacs/authority-reader.mjs': { effect: {}, pure: ['createSellerAuthorityReader', 'currentEnrollment'] },
  'src/dacs/bootstrap-scope.mjs': { effect: {}, pure: ['createBootstrapScopes'] },
  'src/dacs/bounded-call.mjs': { effect: {  }, pure: ['boundedCall', 'isBoundedCallTimeout'] },
  'src/dacs/bounded-reads.mjs': { effect: {  }, pure: ['readFailureCode', 'readRetainedBounded'] },
  'src/dacs/commit-on-signature.mjs': { effect: { signatureCommitmentAnchor: ['signatureCommitmentAnchor'] }, pure: ['commitOnSignatureConfig', 'verifyAgreementCreateAuthorization', 'verifySignatureAgreement'] },
  'src/dacs/closed-bootstrap-gate.mjs': { effect: {  }, pure: ['createClosedBootstrapGate'] },
  'src/dacs/compensation-proof.mjs': { effect: {  }, pure: ['classifyAddress', 'compensationProof', 'createContextEffectEvidence'] },
  'src/dacs/context-work-registry.mjs': { effect: {  }, pure: ['createContextWorkRegistry'] },
  // Its answer is written only inside a pass of the guarded effect boundary.
  'src/dacs/cosignature-answer.mjs': { effect: {}, pure: ['createCosignatureAnswer'] },
  'src/dacs/deliverable-wallet-journal.mjs': { effect: { createDeliverableWalletJournal: ['guardedCreate'] }, pure: ['deliverableJournalFor'] },
  'src/dacs/delivery-evidence.mjs': { effect: {  }, pure: ['isNativeDeliveryEvidence'] },
  'src/dacs/capability-authority.mjs': { effect: {}, pure: ['admitKitCapabilityAuthority'] },
  'src/dacs/dem-delivery-context-consumer.mjs': { effect: { createDemDeliveryContext: ['createDemDeliveryContext'] }, pure: ['demDeliveryContextConfig', 'demDeliveryContextHost', 'demDeliveryContextUsage', 'demDeliveryContextVetMode', 'isDemDeliveryContextAuthority', 'releaseDemDeliveryContext', 'resolveDemDeliverySellerContext'] },
  'src/dacs/demos-claims.mjs': { effect: {  }, pure: ['DemosClaimFormatError', 'addressForClaim', 'claimForAddress', 'decodeSignature', 'isCanonicalEd25519Signature', 'isSmallOrderPublicKey', 'normalizeDemosAddress', 'verifyDemosSignature'] },
  'src/dacs/demos-sr2-adapter.mjs': { effect: {  }, pure: ['DemosSr2Error', 'createDemosSr2Adapter', 'createInMemoryDemosSr2Journal', 'demosSr2TxRef'] },
  'src/dacs/devnet-source.mjs': { effect: {  }, pure: ['isDevnetAgreementTransport', 'isDevnetDemoTransport', 'isDevnetSettlementTransport'] },
  'src/dacs/effect-boundary.mjs': { effect: { createEffectBoundary: ['effectBoundary'] }, pure: ['effectBoundaryBinding', 'effectPassRemainingMs', 'jobPassContext'] },
  'src/dacs/effect-history.mjs': { effect: {  }, pure: ['createEffectHistory', 'initHistory'] },
  'src/dacs/enrollment-proof.mjs': { effect: {}, pure: ['parseTrustedNodePin', 'verifyEnrollmentAnswer'] },
  'src/dacs/fixture-anchors.mjs':{ effect: { signAnchorWrite: ['signAnchorWrite'] }, pure: ['anchorWriteMessage', 'canonicalSignature', 'fixtureRef', 'fixtureTxRef', 'fixtureWriteHash', 'verifyFixtureReceipt', 'verifyFixtureRecord'] },
  'src/dacs/fixture-settlement.mjs': { effect: {  }, pure: ['createFixtureSettlement'] },
  'src/dacs/host-stages.mjs': { effect: {}, pure: ['openSellerStages'] },
  'src/dacs/kit-data-format.mjs': { effect: {  }, pure: ['assertKitDataFormat', 'kitFormatRefusal'] },
  'src/dacs/listing.mjs': { effect: {  }, pure: ['attachIdentityPresentation', 'attachListingSignature', 'buildListingDraft', 'buildUnsignedIdentityBundle', 'canonicalize', 'contentHash', 'isReportableTitle', 'listingSigningMessage', 'logicalListingAddress', 'normalizeDemAmount', 'purchaseSupport', 'utf8', 'validateListing', 'verifyComponent'] },
  'src/dacs/native-dem-delivery-consumer.mjs': { effect: { submitNativeDemDelivery: ['submitNativeDemDelivery'], createNativeDemDeliveryCapability: ['createNativeDemDeliveryCapability'] }, pure: ['deadRefusedCreate', 'hasGuardedNativeDemDelivery', 'isDeadRefusedCreate', 'isProvenUnsignedAbsence', 'mayPublishAgain', 'nativeDemDeliveryConfig', 'nativeDemDeliverySubmitsOf', 'provenUnsignedAbsence', 'readNativeDemDelivery', 'reconcileNativeDemDelivery', 'verifyNativeDemDeliveryReceipt'] },
  'src/dacs/native-observation-evidence.mjs': { effect: {  }, pure: ['reportNativeRefusal', 'withNativeObservationEvidence'] },
  'src/dacs/native-payment-evidence-consumer.mjs': { effect: { createNativePaymentEvidenceConsumer: ['createNativePaymentEvidenceConsumer'] }, pure: ['checkNativePaymentEvidence', 'nativeEvidenceReadOutcome', 'nativePaymentEvidenceConfig', 'observedTransferMatches', 'usesNativePaymentEvidence'] },
  'src/dacs/payment-evidence-wallet-journal.mjs': { effect: { createPaymentEvidenceWalletJournal: ['anchorEvidence', 'reconcilePaymentEvidence', 'ensureEvidence'], createSignedCreateJournal: ['anchorEvidence', 'reconcilePaymentEvidence', 'ensureEvidence', 'guardedCreate'] }, pure: ['isPaymentEvidenceWalletJournalPair', 'paymentEvidenceWalletJournalOf'] },
  'src/dacs/payment-evidence-pass.mjs': { effect: { createPaymentEvidencePass: ['paymentEvidence.approveAhead', 'paymentEvidence.signCreate', 'paymentEvidence.approveSendAhead', 'paymentEvidence.broadcast'] }, pure: [] },
  'src/dacs/process-lease.mjs': { effect: {  }, pure: ['ProcessLeaseError', 'leaseFile', 'leaseHolderState', 'leaseState', 'takeLease'] },
  'src/dacs/purchase-protocol.mjs': { effect: {  }, pure: ['agreementInput', 'agreementTerms', 'assembleBundleCopies', 'bundleAddress', 'bundleSession', 'bundleSigningPlan', 'claimPublicKeyRaw', 'commitmentReader', 'commitmentSession', 'commitmentVerifier', 'contributionVerifier', 'deliverableAddress', 'deliveryEvidenceAddress', 'finalityCommitmentAddress', 'fixedPriceAgreementLogicalAddress', 'listingPin', 'paymentEvidenceAddress', 'plainJson', 'protocolSupport', 'verifyAnchoredCopy', 'verifyDelivery', 'verifyPaymentEvidence', 'vetNotPerformedRef'] },
  'src/dacs/rail-authority.mjs': { effect: {  }, pure: ['intakeRailDefinition', 'railAuthorityConfig', 'validateSellerListing'] },
  'src/dacs/revocation-proof-encoding.mjs': { effect: {}, pure: ['nodeCanonicalJson', 'nodeJcs'] },
  'src/dacs/revocation-proof-storage.mjs': { effect: {}, pure: ['verifyRevocationStorage'] },
  'src/dacs/seller-agent.mjs': { effect: { createSellerAgent: ['createSellerAgent'] }, pure: ['SellerAgentError', 'buildReport', 'canonicalSignature', 'isFinalPaymentAnswer', 'isPendingPaymentAnswer', 'paymentTxHash', 'proposalTimeProblem', 'receiptFeeCeilingsConfig', 'transportOutcome'] },
  'src/dacs/seller-admission-transaction.mjs': { effect: { createContextAdmissionTransaction: ['begin', 'runningCheck', 'reserveContext', 'complete', 'compensate'] }, pure: ['admissionTransactionInternals', 'assertAdmissionJobLease', 'evidenceProof', 'storedCause'] },
  'src/dacs/seller-challenge-ledger.mjs': { effect: { createSellerChallengeLedger: ['issue'] }, pure: ['deepFreeze'] },
  'src/dacs/seller-completion-records.mjs': { effect: {  }, pure: ['createCompletionRecords'] },
  'src/dacs/seller-context-attempt.mjs': { effect: {  }, pure: ['createContextAttempt'] },
  'src/dacs/seller-context-continuation.mjs': { effect: {  }, pure: ['createAcceptedContinuation', 'createContextOutcomeRevalidation', 'createContinuationCheck'] },
  'src/dacs/seller-context-recovery.mjs': { effect: {  }, pure: ['resumeContext'] },
  'src/dacs/seller-context-route.mjs': { effect: {  }, pure: ['completedContextOutcome', 'contextOperationView', 'createSellerContextRecords', 'createSellerContextRoute', 'createWireSellerContextRoute'] },
  'src/dacs/seller-durable-state.mjs': { effect: { createSellerDurableState: ['signOnce', 'anchor'] }, pure: ['SellerRecoveryError'] },
  'src/dacs/seller-effect-routes.mjs': { effect: {  }, pure: ['createSellerEffectRoutes'] },
  'src/dacs/seller-http.mjs': { effect: { createSellerHttpHandler: ['createSellerHttpHandler'], createSellerAgentClient: ['createSellerAgentClient'] }, pure: ['SellerRefusedError', 'SellerTlsUnusableError', 'SellerUnavailableError', 'createCompletedOutcomeReader', 'createOrdinaryCompletionPort', 'endWireAttempt', 'loopbackSocket', 'refusalMessage', 'sellerFailureAttempt', 'sellerFailureCause'] },
  'src/dacs/seller-obsolete-store-tables.mjs': { effect: {  }, pure: ['dropEmptyObsoleteTables'] },
  'src/dacs/seller-planned-agreement.mjs': { effect: {  }, pure: ['createPlannedAgreementReader', 'plannedStateRecords'] },
  'src/dacs/seller-proposal-time.mjs': { effect: {  }, pure: ['proposalTimeProblem'] },
  'src/dacs/seller-purchase-capacity.mjs': { effect: {  }, pure: ['createPurchaseCapacity', 'ownsPurchaseCapacity'] },
  'src/dacs/seller-reservation-accounting.mjs': { effect: { createReservationAccounting: ['reserveAccounted'], createReservationCoordinator: ['reserveCoordinated'] }, pure: ['createLiveAttemptGate', 'requestNonceKey'] },
  'src/dacs/seller-transport-auth.mjs': { effect: {  }, pure: ['SellerTransportError', 'createSellerTransportStore', 'pinValid', 'readSellerSessionState', 'sellerContextChallengeScope', 'sellerContextScopeHash', 'sellerStoreInternals', 'validateBody'] },
  'src/dacs/seller-wire-discovery.mjs': { effect: {  }, pure: ['signedDiscovery'] },
  'src/dacs/seller-wire-requests.mjs': { effect: {  }, pure: ['createWireContext', 'openWireRequest', 'wireAuthenticator'] },
  'src/dacs/session-admission.mjs': { effect: {  }, pure: ['hasPresenceOnlyClaim', 'identityPresentationValid', 'isOrchestratorVetMode', 'listingRevocationProblem', 'readAdmissionCapability', 'sellerBundleProblem', 'sellerRecordVerifier', 'sellerSessionPresentationProblem', 'sessionAdmissionConfig', 'sessionAdmissionProblem', 'vetAnchorReceiptProblem', 'vetRecordProblem'] },
  'src/dacs/signing-gate-bind.mjs': { effect: {  }, pure: ['bindWhenNoSigningGate'] },
  'src/dacs/sr2-live-identity.mjs': { effect: {}, pure: ['liveExpectedIdentity', 'sameSharedTuple'] },
  'src/dacs/signature-domain.mjs': { effect: {  }, pure: ['assertNoCallerSignatureDomain', 'signatureDomainFromNetworkInfo', 'transactionSignatureMessage'] },
  'src/dacs/transaction-signature.mjs': { effect: {  }, pure: ['verifyTransactionSignature'] },
  'src/dacs/wallet-transactions.mjs': { effect: {  }, pure: ['assertStorageJsonDepth', 'buildStorageProgramCreatePayload', 'deriveStorageAddress'] },
  'src/devnet-demo/agreement-context.mjs': { effect: { createDevnetDemoAgreementContextProvider: ['createDevnetDemoAgreementContextProvider'] }, pure: [] },
  'src/devnet-demo/approval-ledger-append.mjs': { effect: {  }, pure: ['appendApprovalLedgerLine', 'assertApprovalLedgerDirectoryCreatable', 'syncApprovalLedger'] },
  'src/devnet-demo/artifact-anchor.mjs': { effect: { createDevnetDemoArtifactAnchor: ['publish'] }, pure: [] },
  'src/devnet-demo/buyer-access.mjs': { effect: {  }, pure: ['createOperatorBuyerAccess', 'operatorBuyerAccessConfig'] },
  'src/devnet-demo/connection-authority.mjs': { effect: {}, pure: ['createConnectionAuthorityReader'] },
  'src/devnet-demo/create-pass.mjs': { effect: { createSellerCreatePass: ['effectBoundary'], lateSellerCreatePass: ['effectBoundary'] }, pure: ['currentAuthorizationFor', 'isSellerCreatePass'] },
  'src/devnet-demo/deliverable.mjs': { effect: {  }, pure: ['createDevnetPurchasedReportProducer', 'isDevnetPurchasedReport'] },
  'src/devnet-demo/deployment-qualification.mjs': { effect: {  }, pure: ['assertQualifiedDeployment'] },
  'src/devnet-demo/doctor-node.mjs': { effect: {}, pure: ['openDoctorNode', 'readSellerBalance'] },
  'src/devnet-demo/node-chain-readers.mjs': { effect: {}, pure: ['createNodeChainReaders', 'createReadOnlyDemosSr2Journal'] },
  'src/devnet-demo/durable-file.mjs': { effect: {  }, pure: ['publishFileExclusive', 'syncDirectory', 'syncFile'] },
  'src/devnet-demo/late-write-watch.mjs': { effect: {  }, pure: ['lateWriteWatchOpen', 'watchLateWrite'] },
  'src/devnet-demo/listing.mjs': { effect: { createDevnetDemoListingPublisher: ['createDevnetDemoListingPublisher'] }, pure: [] },
  'src/devnet-demo/native-delivery.mjs': { effect: { createDevnetDemoDeliveryCapability: ['createDevnetDemoDeliveryCapability', 'createDevnetDemoDeliveryCapability.submit'] }, pure: ['hasDevnetDeliveryEvidenceReader', 'hasDevnetPurchasedReportReader', 'readDevnetDeliveryEvidence', 'readDevnetPurchasedReport'] },
  'src/devnet-demo/operator-approval.mjs': { effect: {  }, pure: ['composeSellerApproval', 'confirmedWriteOs', 'createExactOperatorApproval', 'createSellerContextAdmission', 'cutTornContextLine', 'decidedFromJournals', 'heldPolicyBudget', 'parsePolicyLedger', 'policyRefusal', 'releaseSellerContextHolds', 'sellerApprovalSettings', 'sellerIssuanceJournalIds', 'sellerPurchaseSource', 'serializedPolicy', 'stillAuthorizedToSign', 'stillOpenBeforePayment', 'withContextHolds'] },
  'src/devnet-demo/party-vet-store.mjs': { effect: {  }, pure: ['createInMemoryPartyVetStore', 'openPartyVetStore'] },
  'src/devnet-demo/seller-node-wallet.mjs': { effect: { createSellerNodeWallet: ['createSellerNodeWallet'] }, pure: [] },
  'src/devnet-demo/seller-enrollment-reader.mjs': { effect: {  }, pure: ['openVerifiedEnrollmentReader'] },
  'src/devnet-demo/seller-purchase-source.mjs': { effect: {  }, pure: ['isPaymentTxRef', 'sellerHeldEvidenceJobs', 'sellerHoldNotice', 'sellerRecordsPurchaseResolver'] },
  'src/devnet-demo/seller-state-lock.mjs': { effect: {  }, pure: ['acquireSellerStateLock'] },
  'src/devnet-demo/seller-wallet-session.mjs': { effect: { createSellerWalletSession: ['createSellerWalletSession', 'sellerWalletSession.finalize', 'publish'] }, pure: ['createNodeAuthorityReader', 'isSellerWalletSession'] },
  'src/devnet-demo/stop-request.mjs': { effect: {  }, pure: ['requestStop', 'stopRequested'] },
  'src/devnet-demo/storage-write-recovery.mjs': { effect: { storageWriteRpcSigner: ['storageWriteRpcSigner'] }, pure: ['classifyStorageWriteSubmission', 'rpcEnvelope', 'storageWriteAbsent', 'storageWriteAccountNonce', 'storageWriteConfirmationMatches', 'storageWriteIdentityMatches'] },
  'src/devnet-demo/wallet-signature-pass.mjs': { effect: { signInPass: ['effectBoundary'], signRetainedInPass: ['effectBoundary'] }, pure: [] },
  'src/devnet-demo/write-exclusion.mjs': { effect: {  }, pure: ['createWriteExclusionRule'] },
  'src/host.mjs': { effect: { startSellerHost: ['startSellerHost'] }, pure: [] },
  'src/kit-operation-guard.mjs': { effect: {}, pure: ['KitOperationGuardError', 'assertKitOperationAdmitted', 'kitOperationAdmitted'] },
  'src/mcp/seller-content.mjs': { effect: {  }, pure: ['escapeJson', 'sellerData'] },
  'src/operations.mjs': { effect: {  }, pure: ['OperationError'] },
  'src/private-directory.mjs': { effect: {  }, pure: ['isPrivateDirectory'] },
  'src/seller-diagnostics.mjs': { effect: {  }, pure: ['sellerDiagnostic'] },
  'src/seller-key.mjs': { effect: { openSellerKey: ['sellerKey.sign', 'sellerKey.readOnlyAnswerSigner'] }, pure: ['SellerKeyError', 'loadKeyFile', 'parseSellerKeyRecord', 'runtimeSupported'] },
  'src/util/bounded-resolution.mjs': { effect: {  }, pure: ['boundedResolutionValue', 'isResolverDeadline', 'resolveWithDeadline'] },
  'src/util/http.mjs': { effect: {  }, pure: ['OutboundError', 'fetchBoundedJson'] },
  'src/util/immutable-readbacks.mjs': { effect: {  }, pure: ['createImmutableReadbacks'] },
  'src/util/text.mjs': { effect: {  }, pure: ['cutText'] },
});

// Classification of every function member a constructor's capability hands out, keyed '<file>#<constructor>' (built in
// helpers/kit-returned-capabilities.mjs). A member's class is what that member can reach, never the class of the export that
// returned it: an effect member names the guard entries it reaches at each call (each listed in kit-operation-guard.test.mjs), a
// role member is one of the seller key's closed non-effect roles, and a pure member signs, sends and rebroadcasts nothing itself.
// `()` is a capability that is itself a function; `a.b` is a function member of a plain object member. `as` names, for a plain
// object member that is itself another row's capability, the row it is enumerated against. A row that equals another row (an
// accessor that hands back a capability another constructor built) is that row.
const PROVIDER_CALLS = ['agreementContextProvider.resolveBuyer', 'agreementContextProvider.recoverBuyer'];
// Guards other than an assertKitOperationAdmitted entry, each with the source text that makes the check, which the test reads:
// the client package's purchase hold, which its effect boundary, wallet factory and transport facade check at every pass, request
// and active transport call, and the artifact anchor's resend, which a read makes only while the kit guard admits.
export const OTHER_GUARDS = Object.freeze({
  clientPurchaseHold: [['../dacs-client/src/wallet/effect-boundary.mjs', 'assertPurchaseActionsAdmitted();'],
    ['../dacs-client/src/wallet/node-wallet-session.mjs', 'assertAdmitted: assertPurchaseActionsAdmitted']],
  'artifactAnchor.resend': [['src/devnet-demo/artifact-anchor.mjs', 'resend && kitOperationAdmitted()']],
});
const CLIENT_HOLD = ['clientPurchaseHold'];
const prefixed = (prefix, names) => names.map((name) => `${prefix}.${name}`);
// The client transport facade: its active members run the purchase hold, its passive members only read or observe.
const TRANSPORT_ACTIVE = ['rpc', 'walletBinding', 'recoverStorageWrite', 'cancelNativeTransfer', 'withWalletNonceLock', 'binding'];
const TRANSPORT_PASSIVE = ['readRpc', 'observeBinding', 'chainReader', 'nativeTransferClaimed', 'nativeTransferCancelled', 'nativeTransferRefused', 'nativeNonceConsumer',
  'isWalletIdle', 'profile', 'onPurchaseStep', 'onStorageWriteResend', 'reserveRpcAuth', 'close'];
const LOCAL_JOURNAL = ['appendUnderLock', 'close', 'entries', 'get', 'inspectLocks', 'put', 'releaseAbandonedLock', 'withOwnedOrAcquiredLane', 'withWalletLock'];
const EVIDENCE_JOURNAL_KEY = 'src/dacs/payment-evidence-wallet-journal.mjs#createPaymentEvidenceWalletJournal';
const EVIDENCE_CONSUMER_KEY = 'src/dacs/native-payment-evidence-consumer.mjs#createNativePaymentEvidenceConsumer';
const EVIDENCE_PASS_KEY = 'src/dacs/payment-evidence-pass.mjs#createPaymentEvidencePass';
const EVIDENCE_EFFECTS = ['approveAhead', 'signCreate', 'approveSendAhead', 'broadcast'];
const EVIDENCE_READS = ['readAccountNonce', 'readTransactionState'];
// The four effect members of a payment-evidence adapter or pass, named `<member>` after `memberPrefix`, each guarded at its call
// as `<guardPrefix>.<member>`.
const evidenceEffects = (guardPrefix, memberPrefix = '') => Object.fromEntries(EVIDENCE_EFFECTS.map((member) => [`${memberPrefix}${member}`, [`${guardPrefix}.${member}`]]));
// The seller's Node wallet composition, as createSellerNodeWallet returns it and the port's finalize hands it on; `transport` is the
// facade's member name (`sourceCapability` on the wallet). Its wallet factory and passes sign only through the client's effect gate.
const nodeWalletRow = (transport, extraPure = []) => ({ role: [],
  effect: Object.fromEntries([['walletFactory', CLIENT_HOLD], ['effectPass', CLIENT_HOLD], ['runInEffectPass', CLIENT_HOLD], ...prefixed(transport, TRANSPORT_ACTIVE).map((name) => [name, CLIENT_HOLD])]),
  pure: ['close', 'readBalance', ...extraPure, ...prefixed('artifactJournal', LOCAL_JOURNAL), ...prefixed('observer', ['observe', 'provenance', 'readNodeInfo']), ...prefixed(transport, TRANSPORT_PASSIVE)] });
// The wallet hands out the client's payment-evidence adapter, guarded at each effect call; the finalized session hands out instead
// its own journal over the session's passes, the consumer anchoring through it, and endApprovalWaits, which only aborts a signal.
const walletRow = () => {
  const row = nodeWalletRow('sourceCapability');
  return { ...row, effect: { ...row.effect, ...evidenceEffects('paymentEvidenceAdapter', 'paymentEvidenceAdapter.') }, pure: [...row.pure, ...prefixed('paymentEvidenceAdapter', EVIDENCE_READS)] };
};
const sessionRow = () => ({ ...nodeWalletRow('transport', ['acquireConnectionFence', 'endApprovalWaits']), as: { paymentEvidence: EVIDENCE_JOURNAL_KEY, nativePaymentEvidence: EVIDENCE_CONSUMER_KEY } });
const EVIDENCE_JOURNAL = { role: [], effect: { anchorEvidence: ['anchorEvidence'], ensureEvidence: ['ensureEvidence'], reconcilePaymentEvidence: ['reconcilePaymentEvidence'] },
  pure: ['clearHeldWrite', 'close', 'readSignedProjection'] };
const DELIVERABLE_JOURNAL = { role: [], effect: { submitAuthorized: ['guardedCreate'], resume: ['guardedCreate'] }, pure: ['clearHeldWrite', 'close', 'readSignedProjection'] };
const LEDGER_LOCAL = ['accept', 'acceptWithin', 'attempt', 'closeLostValidations', 'importAccepted', 'jobBinding', 'recordFailed', 'recordFailedWithin', 'retained', 'retainedForSession'];
const AGENT_EFFECTS = ['agreementState', 'bundleRequest', 'commit', 'commitOnSignature', 'countersign', 'receiveProposal', 'reconcileTransport', 'resume', 'submitPayment'];
const EFFECT_ROUTE_PATHS = ['/dacs/v1/agreements/proposals', '/dacs/v1/bundles/countersignature', '/dacs/v1/bundles/request', '/dacs/v1/commitments', '/dacs/v1/commitments/signature', '/dacs/v1/payments'];
const PARTY_VET_STORE = { role: [], effect: {}, pure: ['close', 'entries', 'read', 'update', 'usage'] };
// The read-only connection pair: the client's authority capability (no sign or send) and its connection reader.
const CONNECTION_PAIR = { role: [], effect: {}, pure: ['connectionAuthority', 'authority.authorityRpc', 'authority.claim', 'authority.context', 'authority.connectionGeneration'] };
// The chain readers only read the finalized session: nothing they call signs or sends.
const CHAIN_READER_MEMBERS = ['observePayment', 'readCommitmentReceipt', 'sessionAdmission.admit', 'sessionAdmission.resolveVetRecord', 'sessionAdmission.readVetAnchorReceipt',
  'sessionAdmission.verifyVetAnchorReceipt', 'sessionAdmission.readRevocationSurfaces', 'sessionAdmission.readRevocationMarker'];
export const RETURNED_CLASSIFICATION = Object.freeze({
  'src/devnet-demo/seller-wallet-session.mjs#createSellerWalletSession.finalize()': sessionRow(),
  'src/devnet-demo/seller-node-wallet.mjs#createSellerNodeWallet': walletRow(),
  [EVIDENCE_PASS_KEY]: { role: [], effect: evidenceEffects('paymentEvidence'), pure: EVIDENCE_READS },
  'src/dacs/host-stages.mjs#openSellerStages': { role: [], effect: { finalize: ['sellerWalletSession.finalize', 'effectBoundary'] }, pure: ['bootstrap.current', 'bootstrap.enter', 'close', 'local'] },
  'src/seller-key.mjs#loadKeyFile': { role: [], effect: {}, pure: ['bytes', 'destroy', 'redact', 'text', 'toJSON'] },
  'src/devnet-demo/create-pass.mjs#currentAuthorizationFor': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/seller-http.mjs#createSellerHttpHandler': { role: [], effect: { '()': ['effectBoundary', 'issue', 'reserveCoordinated'] }, pure: [] },
  'src/dacs/seller-http.mjs#createCompletedOutcomeReader': { role: [], effect: {}, pure: ['completedOutcomeWithoutReservation'] },
  'src/dacs/seller-http.mjs#createOrdinaryCompletionPort': { role: [], effect: {}, pure: ['capture'] },
  'src/dacs/seller-wire-requests.mjs#createWireContext': { role: ['readSigner', 'signer.readOnlyAnswerSigner'],
    effect: { 'answers.signAnswer': ['effectBoundary'], 'reservations.reserveCoordinated': ['reserveCoordinated'], 'signer.sign': ['sellerKey.sign'], plannedAgreementOf: ['agreementContextProvider.recoverBuyer'] },
    pure: ['admitPresentation', 'bindPlannedAgreementReader', 'continuationFor', 'local', 'now', 'readCommitmentReceipt', 'ready', 'reservations.addPreAccountingGate', 'retainedFor', 'stopped',
      'tuple', ...prefixed('store', ['bind', 'close', 'contextHoldState', 'jobSlotReleased', 'purchaseProfile', 'sessionTerminal'])] },
  'src/dacs/seller-context-route.mjs#createSellerContextRoute': { role: [], effect: { challengeOnWire: ['issue'] }, pure: [] },
  'src/dacs/seller-context-route.mjs#createSellerContextRecords': { role: [], effect: {}, pure: ['completedScope', 'exactRequest', 'retainedBody'] },
  'src/dacs/seller-context-route.mjs#contextOperationView': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/seller-context-route.mjs#completedContextOutcome': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/seller-context-continuation.mjs#createContinuationCheck': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/seller-context-continuation.mjs#createAcceptedContinuation': { role: [], effect: { '()': ['agreementContextProvider.recoverBuyer'] }, pure: [] },
  'src/dacs/seller-context-attempt.mjs#createContextAttempt': { role: [], effect: { writable: ['runningCheck'] }, pure: ['close', 'isClosed', 'run'] },
  'src/dacs/seller-planned-agreement.mjs#createPlannedAgreementReader': { role: [], effect: { '()': ['agreementContextProvider.recoverBuyer'] }, pure: [] },
  'src/dacs/seller-admission-transaction.mjs#createContextAdmissionTransaction': { role: [],
    effect: { begin: ['begin'], compensate: ['compensate'], reserveContext: ['reserveContext'], runningCheck: ['runningCheck'] },
    pure: ['addAcceptanceHook', 'admissionRecord', 'cleanupPending', 'fitsNewPurchase', 'jobEffectMutex', 'sweep'] },
  'src/dacs/seller-admission-transaction.mjs#admissionTransactionInternals': { role: [], effect: {}, pure: ['ownedIntent'] },
  'src/dacs/seller-reservation-accounting.mjs#createReservationCoordinator': { role: [], effect: { reserveCoordinated: ['reserveCoordinated'] }, pure: ['addPreAccountingGate'] },
  'src/dacs/seller-reservation-accounting.mjs#createReservationAccounting': { role: [], effect: { reserveAccounted: ['reserveAccounted'] }, pure: ['reservedRequest'] },
  'src/dacs/seller-reservation-accounting.mjs#createLiveAttemptGate': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/seller-transport-auth.mjs#createSellerTransportStore': { role: [], effect: { 'challenges.issue': ['issue'], 'reservationAccounting.reserveAccounted': ['reserveAccounted'] },
    pure: ['bind', 'close', 'contextHoldState', 'jobSlotReleased', 'purchaseProfile', 'sessionTerminal', 'reservationAccounting.reservedRequest', ...prefixed('challenges', LEDGER_LOCAL)] },
  'src/dacs/seller-transport-auth.mjs#sellerStoreInternals': { role: [], effect: { 'challenges.issue': ['issue'], terminalSession: ['terminalSession'] },
    pure: ['admissionCounts', 'bindTerminalCleanup', 'flushTerminalObservations', 'keepPurchaseProfileWithin', 'reserveAdmissionWithin', 'retainedReservationCount', 'retireSlotsWithin', 'sessionState',
      'transaction', ...prefixed('challenges', LEDGER_LOCAL)] },
  'src/dacs/seller-purchase-capacity.mjs#createPurchaseCapacity': { role: [], effect: { terminalSession: ['terminalSession'] },
    pure: ['allocateWithin', 'allocationWithin', 'allotment', 'capacityReport', 'classify', 'fitsNewPurchase', 'flushTerminalObservations', 'recordExhaustion', 'releaseAllWithin',
      'releaseTerminalAllocations', 'retainedAllocated', 'returnRouteSlotWithin'] },
  'src/dacs/seller-completion-records.mjs#createCompletionRecords': { role: [], effect: {}, pure: ['complete', 'reservationRow'] },
  'src/dacs/accounting-reconciliation.mjs#createAccountingReconciler': { role: [], effect: {}, pure: ['reconcileStartup'] },
  'src/dacs/seller-challenge-ledger.mjs#createSellerChallengeLedger': { role: [], effect: { issue: ['issue'] }, pure: LEDGER_LOCAL },
  'src/dacs/closed-bootstrap-gate.mjs#createClosedBootstrapGate': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/bootstrap-scope.mjs#createBootstrapScopes': { role: [], effect: {}, pure: ['current', 'enter'] },
  'src/dacs/abandoned-purchase.mjs#createAbandonedPurchaseState': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/context-work-registry.mjs#createContextWorkRegistry': { role: [], effect: {}, pure: ['drain', 'stop', 'track'] },
  'src/dacs/compensation-proof.mjs#createContextEffectEvidence': { role: [], effect: {}, pure: ['()'] },
  'src/dacs/cosignature-answer.mjs#createCosignatureAnswer': { role: [], effect: { send: ['effectBoundary'] }, pure: [] },
  'src/dacs/agent-effect-signer.mjs#createAgentEffectSigner': { role: [], effect: { '()': ['effectBoundary'] }, pure: [] },
  'src/dacs/effect-boundary.mjs#createEffectBoundary': { role: [],
    effect: Object.fromEntries(['checkNow', 'dispatchPass', 'pass', 'refresh', 'signPass', 'signerFor', 'withFence'].map((name) => [name, ['effectBoundary']])),
    pure: ['connectionGeneration', 'recordObserved', 'replaceConnection'] },
  'src/dacs/effect-history.mjs#createEffectHistory': { role: [], effect: {}, pure: ['append', 'read'] },
  'src/dacs/seller-durable-state.mjs#createSellerDurableState': { role: [], effect: { anchor: ['anchor'], signOnce: ['signOnce'] },
    pure: ['assertHeld', 'bindSettlement', 'close', 'context', 'hasAnchor', 'inspectLocks', 'legacyAcceptedChallenges', 'loadSession', 'readAnchor', 'reconcileAnchor', 'reconcileJob',
      'releaseAbandonedLock', 'releaseSignatureCommitment', 'releaseStaleLocks', 'reserveSignatureCommitment', 'retainContext', 'saveSession', 'sessions', 'settlementBoundTo', 'settlementJob', 'signature',
      'withJob', ...prefixed('fencedStore', ['acquireLease', 'bindHash', 'bindSessionAuthorization', 'claimCheckpoint', 'create', 'list', 'load', 'renewLease', 'transition']),
      ...prefixed('receiptStore', ['claim', 'consumePermit', 'inspectPermit'])] },
  'src/dacs/seller-agent.mjs#createSellerAgent': { role: [], effect: Object.fromEntries(AGENT_EFFECTS.map((name) => [name, ['effectBoundary', 'signOnce', 'anchor']])),
    pure: ['admitSessionPresentation', 'assertAuthenticatedPayment', 'assertSettlementCredit', 'close', 'confirmBuyerCopy', 'continuationEvidenceOf', 'deliveryStateOf', 'durableSessionOf', 'durableSessions',
      'finalityCommitmentAddress', 'holdsRecordedPayment', 'readCommitment', 'reconcile', 'releaseStaleLocks', 'retainedAgreementDeadline', 'retainsCommitmentWork', 'retainsPaymentClaim', 'retainsPaymentWork',
      'retainsProposalWork', 'retainsUnfinishedWork', 'revalidateCompletedAnswer', 'stageOf', 'transportAgreementOf'] },
  // A fixture payment signs its evidence and anchors it through the agent's guarded signer and durable anchor; its reads only read back.
  'src/dacs/fixture-settlement.mjs#createFixtureSettlement': { role: [], effect: { submitPayment: ['effectBoundary', 'signOnce', 'anchor'] }, pure: ['readPayment', 'verifyRetainedPayment'] },
  // A route's recovery may finish retained work through the agent; its end decision and revalidation only read.
  'src/dacs/seller-effect-routes.mjs#createSellerEffectRoutes': { role: [], effect: Object.fromEntries(EFFECT_ROUTE_PATHS.map((path) => [`${path}.recover`, ['effectBoundary', 'signOnce', 'anchor']])),
    pure: EFFECT_ROUTE_PATHS.flatMap((path) => [`${path}.endAfter`, `${path}.revalidate`]) },
  'src/dacs/commit-on-signature.mjs#signatureCommitmentAnchor': { role: [], effect: { anchorAgreement: ['signatureCommitmentAnchor'] }, pure: [] },
  'src/dacs/purchase-protocol.mjs#commitmentReader': { role: [], effect: {}, pure: ['resolve', 'verifyAnchorReceipt'] },
  [EVIDENCE_JOURNAL_KEY]: EVIDENCE_JOURNAL,
  'src/dacs/payment-evidence-wallet-journal.mjs#paymentEvidenceWalletJournalOf': EVIDENCE_JOURNAL,
  'src/dacs/payment-evidence-wallet-journal.mjs#createSignedCreateJournal': { role: [], effect: { guardedCreate: ['guardedCreate'] }, pure: ['clearHeldWrite', 'close', 'readSignedProjection'] },
  'src/dacs/deliverable-wallet-journal.mjs#createDeliverableWalletJournal': DELIVERABLE_JOURNAL,
  'src/dacs/deliverable-wallet-journal.mjs#deliverableJournalFor': DELIVERABLE_JOURNAL,
  'src/dacs/native-payment-evidence-consumer.mjs#createNativePaymentEvidenceConsumer': { role: [], effect: { anchorEvidence: ['anchorEvidence'] }, pure: ['observeDemosTransfer', 'readEvidence'] },
  'src/dacs/demos-sr2-adapter.mjs#createInMemoryDemosSr2Journal': { role: [], effect: {}, pure: ['get', 'put', 'records', 'withWalletLock'] },
  'src/dacs/demos-sr2-adapter.mjs#createDemosSr2Adapter': { role: [], effect: {}, pure: ['read', 'recheck', 'verifyReceipt'] },
  'src/dacs/authority-reader.mjs#createSellerAuthorityReader': { role: [], effect: {}, pure: ['()'] },
  'src/devnet-demo/artifact-anchor.mjs#createDevnetDemoArtifactAnchor': { role: [], effect: { publish: ['publish'], read: ['artifactAnchor.resend'], readRetained: ['artifactAnchor.resend'] },
    pure: ['hasIntent', 'retainedSignedCreate', 'verifyReceipt'] },
  'src/devnet-demo/buyer-access.mjs#createOperatorBuyerAccess': { role: [], effect: {}, pure: ['allowsWallet', 'assertRelayWallet', 'assertSellerJob', 'assertSellerWallet', 'assertWallet', 'jobAccess', 'sellerNotice'] },
  'src/devnet-demo/deliverable.mjs#createDevnetPurchasedReportProducer': { role: [], effect: {}, pure: ['()'] },
  // The approval only decides: it signs and sends nothing, and the write it approves signs inside the guarded boundary.
  'src/devnet-demo/operator-approval.mjs#composeSellerApproval': { role: [], effect: {}, pure: ['()'] },
  'src/devnet-demo/operator-approval.mjs#createExactOperatorApproval': { role: [], effect: {}, pure: ['()'] },
  'src/devnet-demo/operator-approval.mjs#createSellerContextAdmission': { role: [], effect: {}, pure: ['release', 'reserve'] },
  'src/devnet-demo/party-vet-store.mjs#createInMemoryPartyVetStore': PARTY_VET_STORE,
  'src/devnet-demo/party-vet-store.mjs#openPartyVetStore': PARTY_VET_STORE,
  'src/devnet-demo/seller-enrollment-reader.mjs#openVerifiedEnrollmentReader': { role: [], effect: {}, pure: ['close', 'entriesFor'] },
  'src/devnet-demo/seller-purchase-source.mjs#sellerRecordsPurchaseResolver': { role: [], effect: {}, pure: ['()'] },
  'src/devnet-demo/seller-state-lock.mjs#acquireSellerStateLock': { role: [], effect: {}, pure: ['held', 'release'] },
  'src/devnet-demo/storage-write-recovery.mjs#storageWriteRpcSigner': { role: [], effect: { '()': ['storageWriteRpcSigner'] }, pure: [] },
  'src/devnet-demo/write-exclusion.mjs#createWriteExclusionRule': { role: [], effect: {}, pure: ['()'] },
  'src/util/immutable-readbacks.mjs#createImmutableReadbacks': { role: [], effect: {}, pure: ['delete', 'get', 'put'] },
  'src/host.mjs#startSellerHost': { role: [], effect: {}, pure: ['close'] },
  'src/devnet-demo/agreement-context.mjs#createDevnetDemoAgreementContextProvider': { role: [],
    effect: { resolveBuyer: ['agreementContextProvider.resolveBuyer', 'effectBoundary'], recoverBuyer: ['agreementContextProvider.recoverBuyer'],
      resolveSeller: ['agreementContextProvider.resolveSeller', 'effectBoundary'] },
    pure: ['readBackRecords', 'resumableBuyer', 'release', 'sweep', 'bindRetainedScope', 'usage', 'assertBuyerAccess'] },
  'src/devnet-demo/seller-wallet-session.mjs#createSellerWalletSession': { role: [],
    effect: { finalize: ['sellerWalletSession.finalize'], runCreate: ['effectBoundary'], 'artifactAnchor.publish': ['publish'], 'artifactAnchor.read': ['effectBoundary'],
      'artifactAnchor.readRetained': ['effectBoundary'] },
    pure: ['close', 'connectionAuthority', 'authority.authorityRpc', 'authority.claim', 'authority.context', 'authority.connectionGeneration', 'artifactAnchor.retainedSignedCreate',
      'artifactAnchor.hasIntent', 'artifactAnchor.verifyReceipt', ...CHAIN_READER_MEMBERS] },
  'src/devnet-demo/seller-wallet-session.mjs#createNodeAuthorityReader': { ...CONNECTION_PAIR, pure: [...CONNECTION_PAIR.pure, ...CHAIN_READER_MEMBERS] },
  'src/devnet-demo/node-chain-readers.mjs#createNodeChainReaders': { role: [], effect: {}, pure: CHAIN_READER_MEMBERS },
  'src/devnet-demo/node-chain-readers.mjs#createReadOnlyDemosSr2Journal': { role: [], effect: {}, pure: ['get', 'put', 'records', 'withWalletLock'] },
  'src/devnet-demo/connection-authority.mjs#createConnectionAuthorityReader': CONNECTION_PAIR,
  // The doctor's read-only owner, connection reader and observer: the owner's fence is a read-ordering lease, and nothing signs or sends.
  'src/devnet-demo/doctor-node.mjs#openDoctorNode': { role: [], effect: {},
    pure: ['close', 'readAuthority', 'owner.acquireConnectionFence', 'owner.close', 'owner.currentLocal', 'owner.fetchImpl', 'owner.getContext', 'observer.observe',
      'observer.provenance', 'observer.readNodeInfo'] },
  'src/devnet-demo/listing.mjs#createDevnetDemoListingPublisher': { role: [], effect: { '()': ['createDevnetDemoListingPublisher', 'effectBoundary'] }, pure: [] },
  'src/devnet-demo/create-pass.mjs#createSellerCreatePass': { role: [], effect: { runCreate: ['effectBoundary'] }, pure: [] },
  'src/devnet-demo/create-pass.mjs#lateSellerCreatePass': { role: [], effect: { '()': ['effectBoundary'] }, pure: [] },
  'src/seller-key.mjs#openSellerKey': { effect: { sign: ['sellerKey.sign'] }, role: ['readOnlyAnswerSigner', 'integritySigner.sign'], pure: ['close'] },
  'src/dacs/seller-http.mjs#createSellerAgentClient': { role: [], pure: [], effect: Object.fromEntries(['propose', 'agreementState', 'commit', 'commitOnSignature', 'submitPayment', 'bundleRequest',
    'countersign', 'confirmBuyerCopy', 'agreementContext', 'contextChallenge'].map((method) => [method, [`sellerAgentClient.${method}`]])) },
  // For an effect-route success signAnswer signs in a pass of the guarded boundary; a read answer or refusal goes to the closed read-only role.
  'src/dacs/answer-signers.mjs#createAnswerSigners': { role: [], effect: { signAnswer: ['effectBoundary'] }, pure: [] },
  'src/dacs/seller-wire-requests.mjs#wireAuthenticator': { role: [], effect: { sign: ['effectBoundary'], 'store.reserve': ['reserveCoordinated'] },
    pure: ['encode', 'open', 'store.claim', 'store.reconcile', 'store.finish', 'store.assertPending', 'store.assertSession'] },
  'src/dacs/seller-context-route.mjs#createWireSellerContextRoute': { role: [],
    effect: { handleContext: PROVIDER_CALLS, revalidateContextOutcome: ['agreementContextProvider.recoverBuyer'], readPlannedAgreement: ['agreementContextProvider.recoverBuyer'] },
    pure: ['closeAttempts'] },
  'src/dacs/seller-context-recovery.mjs#resumeContext': { role: [], effect: { '()': PROVIDER_CALLS }, pure: [] },
  'src/dacs/seller-context-continuation.mjs#createContextOutcomeRevalidation': { role: [], effect: { '()': ['agreementContextProvider.recoverBuyer'] }, pure: [] },
  'src/dacs/dem-delivery-context-consumer.mjs#demDeliveryContextHost': { role: [],
    effect: { resolveBuyer: ['agreementContextProvider.resolveBuyer'], recoverBuyer: ['agreementContextProvider.recoverBuyer'] }, pure: ['resumableBuyer', 'bindRetainedScope'] },
});

// The exports named like constructors (create, open, take, compose, late) that return only data or a registered-capability
// descriptor, so they have no row. kit-operation-guard.test.mjs builds each and checks it hands out no function.
export const NO_CAPABILITY = Object.freeze({
  // A frozen { source, authority } descriptor; its callbacks are reached through the registry.
  'src/dacs/dem-delivery-context-consumer.mjs': ['createDemDeliveryContext'],
  // A frozen { source, authority } descriptor; its submit is reached through the registry and checks the guard there.
  'src/dacs/native-dem-delivery-consumer.mjs': ['createNativeDemDeliveryCapability'],
  'src/devnet-demo/native-delivery.mjs': ['createDevnetDemoDeliveryCapability'],
  // The opened request envelope, as the wire verified it.
  'src/dacs/seller-wire-requests.mjs': ['openWireRequest'],
  // The lease holder's id.
  'src/dacs/process-lease.mjs': ['takeLease'],
  // Whether a late write is still watched.
  'src/devnet-demo/late-write-watch.mjs': ['lateWriteWatchOpen'],
});

// Exports outside the constructor name rule that return a function or an object with function members, read from each
// `export function`'s return in src/. Each has a row.
export const ALSO_CONSTRUCTORS = Object.freeze(['resumeContext', 'demDeliveryContextHost', 'wireAuthenticator', 'commitmentReader', 'currentAuthorizationFor',
  'sellerRecordsPurchaseResolver', 'signatureCommitmentAnchor', 'storageWriteRpcSigner', 'startSellerHost', 'contextOperationView', 'completedContextOutcome',
  'sellerStoreInternals', 'admissionTransactionInternals', 'loadKeyFile', 'deliverableJournalFor', 'paymentEvidenceWalletJournalOf', 'acquireSellerStateLock']);
