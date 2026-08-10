# Normative artifact fidelity

Normative source: DACS-Standard `next` at
`c2ecd9fa658776f5511f2414d7b4c3e23b847463`, pinned by
`scripts/sync-vectors.mjs`.

| SDK surface | Normative rule | Runtime behavior |
| --- | --- | --- |
| `AttestationRef` / `isAttestationRef` | DACS-2 §7.5.2 | Requires the exact `anchor.kind` closed set (`storage-program`, `ipfs`, `https`), a locator, content hash, and optional signer. Flat SDK MVP refs fail the normative validator. |
| `ChainTxRef` (`TxRef`) / `isChainTxRef` | DACS-4 §9.3 | Implements every discriminated arm and rejects flattened or cross-arm fields. Replays the Standard's 19-case reference-shape oracle. |
| `SettlementEvidence` / `isSettlementEvidence` | DACS-4 §9.7; §9.5.8 SB-1; AP2-2; DPA-6 | Enforces the phase/outcome conditions, finality model parameters, exact nested refs, required component signature, AP2 receipt attestation on successful AP2 refs, and attested-payload back-pointer. A signed `phaseIndex` is rejected. |
| `PhaseSummaryEntry` | DACS-1 §6.3 `PhaseType`; DACS-5 §10.4 | New `FaultAttestationBundle` writes accept only the closed phase set and exact `ChainTxRef` / `AttestationRef` values. Historical `AttestationBundle` phase labels remain readable. |
| `FaultAttestationBundle` / `isFaultAttestationBundle` | DACS-5 §10.4–§10.4.3 | Requires the fault discriminator, absolute permissible `faultedParty`, current references, current phases, role provenance, and signatures. Unknown discriminators/outcomes fail closed. |
| `verifyBundleCore.resolveAttestationRef` | DACS-2 §7.5.2 resolution; DACS-5 §10.4.3 | Receives the entire signed reference, including `anchor.locator`; a missing normative resolver yields `unresolved`, never an inferred SDK artifact address. |
| `LegacyMvp*` compatibility | DACS-5 §10.4.1 legacy-read policy; CORE §11.1.2 | Early SDK `{kind,id}` / flat transaction records are named as legacy and kept off normative write surfaces. They can be resumed/read through the deprecated legacy resolver but are excluded from normative reputation inputs. |
| Unknown artifact-level fields | CORE §B.7 SIG-5 | Retained in the signed scope. Known unsupported discriminators, forbidden legacy fields, and malformed nested variants still fail closed. |

The upstream oracle/prose divergence previously tracked by
DACS-Standard#308 was resolved by Standard PR #310. DACS-Standard#327 tracks a
separate stale one-sided fixture hash found while repinning; its consumer and
signature decisions replay, while the obsolete hash assertion remains an
explicit expected divergence.
