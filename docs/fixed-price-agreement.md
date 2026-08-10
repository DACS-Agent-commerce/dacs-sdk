# Fixed-price agreement traceability

This layer is a transport-independent DACS-3 core. It accepts only a normative
Listing with an explicit `verified` disposition and produces the exact
`AgreementDocument` or `PayeeBoundAgreementDocument` selected by its pipeline.
It performs no anchoring, payment, delivery, network transport, or private
repository call.

| SDK rule | Normative source |
| --- | --- |
| Exact `AgreementDocument`, `PayeeBoundAgreementDocument`, party, terms, fee, payout, and signature types | DACS-3 §8.5–§8.5.3 |
| Fixed price copied exactly; negotiable fixed-price path uses `bandCenter`; auction/metered fail closed until their handlers are selected | DACS-3 §8.4.1; §8.5.2 checks 1–2; MTR-5 |
| Exactly one fixed-price phase followed immediately by one supported agreement commitment phase | DACS-3 §8.8 PS-1–PS-3 |
| Agreement pins the immutable `(listingId, version, contentHash)` tuple | DACS-1 §6.3.4 LR-1; DACS-3 §8.5.2 check 4 |
| Buyer/seller claims, post-Vet bundle hashes, and exact Vet references are signed agreement inputs | DACS-3 §8.4.1; §8.5 `AgreementParty` |
| Deliverable reference hashes the Listing's anchored `offering.deliverable` bytes | DACS-4 §9.3 `DeliverableRef`; DACS-3 §8.5.2 check 5 |
| A complete selected rail must exactly match `acceptedRails` and every pay phase; zero-pay pipelines omit it | DACS-3 §8.5.2 check 3; DACS-4 §9.5.1 PC-2 |
| Payee-bound agreements cover every pay-phase tuple exactly once and legacy agreements reject payout bindings | DACS-3 §8.5; DACS-4 §9.5.1 PB-1 |
| Artifact discriminator, required payout-binding, and duplicate-tuple behavior is exercised against `payee-destination-binding-v0.1.json` | DACS-3 §8.5 compatibility; DACS-4 §9.5.1 PB-1–PB-3 |
| Provisional deadline derives from `generatedAt + deadlineSecAfterCommit` | DACS-3 §8.4.1; §8.5.2 check 7 |
| Buyer and seller sign the signature-free agreement hash under the artifact-specific domain; Base64URL is canonical and unpadded | DACS-3 §8.5.1; CORE §B.7 SIG-2/SIG-6 |
| Unknown/unsupported pricing and auto-accept without its verified commitment plus live instance signature fail closed | DACS-3 §8.4.1; §8.5.2 MTR-5; CORE §11.1.2 |
| Early SDK buyer-only agreements are read only as `LegacyMvpAgreementDocument`; they are never exposed as normative writes | CORE §11.1.2 |

The finalized agreement commitment, authoritative `committedAt` checks, and the
barrier before irreversible settlement remain owned by #99. The auto-accept
commitment/instance-signature recipe also remains a separate focused branch;
this core refuses to reinterpret a normal agreement signature as that recipe.
