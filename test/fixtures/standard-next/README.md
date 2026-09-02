# DACS Standard `next` review fixtures

These fixtures isolate selected current vectors for focused test reporting.
Each entry below names the exact DACS Standard commit it was copied from; do
not infer one global fixture revision when a later merged ruling is tested
ahead of the repository-wide conformance pin.

- `listing-rail-registry-resolution-v0.4.json` — DACS-1 §6.3.4 LRR-1..LRR-6;
  DACS-4 §9.4.3; commit
  `c2ecd9fa658776f5511f2414d7b4c3e23b847463`.
- `domain-claim-gcr-v0.4.json` — DACS-1 DCR-1..DCR-8 and DACS-2
  DGCR-1..DGCR-6; commit
  `5c175d148932c8a3635e54a15f1db2f31f67a500` (Standard PR #346),
  SHA-256 `fc1734ddbd148e09738abdcc9e017ae5a0ad961a7fd022cc75c75dfd9e108e2e`.
- `alternative-payment-projection-v0.1.json` — DACS-4 APR-1..APR-8 and
  DACS-3/DACS-5 projection consumers; Standard PR #344, commit
  `332ba4d620930cc22b79fffa3f74440ebf0df5ca`; file SHA-256
  `73be437c15210ae57c0ad62a8e02fc70f37bface5da15cf207f9b88964aa5ca3`.

Do not edit a fixture locally. Replace it from a named Standard commit and
update this provenance note.
