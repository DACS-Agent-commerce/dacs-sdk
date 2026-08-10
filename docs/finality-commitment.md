# Finalized fixed-price commitment traceability

This layer is the transport-independent DACS-3 commitment primitive used after
the exact fixed-price agreement core. It validates the signed agreement against
the immutable Listing, refuses unsafe absence/retry decisions, emits only the
new finality commitment type, and returns success only after a binding-owned
proof verifier authenticates a complete finalized receipt.

| SDK rule | Normative source |
| --- | --- |
| New writes emit `FinalityCommitmentRecord`; historical `CommitmentRecord` has an explicit read-only validator | DACS-3 §8.6 procedure step 4; CA-9; §8.11 |
| Record signature uses `dacs-finality-commitment:v1:` and the authenticated orchestrator claim | DACS-3 §8.6 step 5; CA-6; CORE §B.7 SIG-2/SIG-6 |
| Both agreement-party signatures verify before SR-2 resolution or submission | DACS-3 §8.5.1; §8.6 steps 1–2; CA-7 |
| Agreement discriminator, Listing pin, fixed price, rail, deliverable, party, pattern, and payout coverage gate before submission | DACS-3 §8.5.2 checks 1–4, 7, and 9; §8.6 step 3; CA-5 |
| Logical address is exactly `dacs3:commit:{jobId}` | DACS-3 §8.6 step 5; CORE §B.1 CF-4 |
| An existing record must bind the same immutable session content and is never replaced by another commitment type/content | DACS-3 §8.6 CA-3 |
| Only an established `finalized` receipt with exact logical/native/content bindings and authenticated binding-owned proof passes | CORE §5.1 SR2-4–SR2-7; DACS-3 §8.6 step 6 |
| `committedAt` comes only from `anchorReceipt.blockRef.timestamp`; `createdAt` and `observedAt` are never substitutes | DACS-3 §8.6 CA-8; CORE §5.1 SR2-6 |
| Finalized receipt time rechecks the agreement deadline limit and Listing `notAfter` | DACS-3 §8.5.2 checks 5–6 and ordering note; §8.6 step 6 |
| `indeterminate` lookup never becomes absence, and an ambiguous submit must be resolved before retry | CORE §5.1 SR-2 read outcomes; DACS-3 §8.6 CA-3 |
| Commitment compatibility behavior is exercised against `commitment-record-compatibility-v0.1.json` | DACS-3 §8.6 CA-6–CA-9 |

The provider boundary owns substrate-specific receipt proof authentication and
the mapping between the portable receipt transaction reference and the returned
DACS-4 `TxRef`. It must verify transaction, writer, nonce, finality evidence,
and native ordering; receipt fields alone are assertions under CORE SR2-4.

This PR advances #99 but does not close it. The public legacy `runSession()`
path is intentionally unchanged. Wiring this gate before `settle()`, persisting
the receipt in `SessionStore`, and recovering the high-level two-party seller
session remain the subsequent orchestration PR.
