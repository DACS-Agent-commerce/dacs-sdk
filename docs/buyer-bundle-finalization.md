# Buyer bundle finalization trust boundary

`verifyFinalizedSessionSettlement` authenticates one finalized settlement
observation. It verifies the signed `SettlementEvidence`, its exact PC-2 anchor
(`dacs4:payment:{jobId}:{CF-4 railId}:{phaseIndex}[:resolved]`), the finalized
anchor receipt, the content-addressed native proof, live rail finality, and the
canonical event/instruction-level SB-1 settlement identity.

The returned `AuthenticatedSessionSettlementObservation` is deliberately not:

- an irreversible payment, fulfilment, signing, or publication permit;
- proof that the settlement identity is unique in a consumer's evidence set; or
- authority to count the session in reputation.

Buyer bundle effects are authorized only after independently authenticating the
seller counter-signature request and finalized seller result. Those seller
artifacts inherit the exact one-shot consumed payment authorization retained by
the seller fulfilment stack. Recovery reauthenticates the retained seller state
and the live settlement observation before continuing.

DACS-4 SB-2 is a closed-set consumer rule: the earlier `observedAt` record wins,
with lower evidence hash as the tie-break. SDK issue #33 remains responsible for
applying that rule across bundle verification and reputation ingestion, where a
later-discovered winning record can demote a previously observed loser. This
point verifier does not expose a mutable global-winner claim that could be
mistaken for durable effect authority.
