# DACS Standard `next` review fixtures

These fixtures isolate selected current vectors for focused test reporting.
Each entry below names the exact DACS Standard commit it was copied from; do
not infer one global fixture revision when a later merged ruling is tested
ahead of the repository-wide conformance pin.

- `listing-rail-registry-resolution-v0.4.json` — commit
  `c2ecd9fa658776f5511f2414d7b4c3e23b847463`; DACS-1 §6.3.4 LRR-1..LRR-6;
  DACS-4 §9.4.3.
- `demos-agent-claim-reference.json` — commit
  `81ded2b49851d8fa17399e3fdade9e36e33a4ff7`; DACS-1 §6.3.1; CORE §B.1.
- `claim-requirement-qualification-v0.3.json` — commit
  `662be1d4899a2cadf327fe2d5523e93a80334e5f`; DACS-2 §7.7.1 CRQ-1..CRQ-4
  plus authenticated production/replay authority and cross-session reuse.
- `rail-availability-selection-v0.1.json` — commit
  `662be1d4899a2cadf327fe2d5523e93a80334e5f`; DACS-4 §9.4.4
  RAV-R1/R2/R3/R5 and DACS-1 §6.3.4 LRR-6.
- `domain-claim-gcr-v0.4.json` — DACS-1 DCR-1..DCR-8 and DACS-2
  DGCR-1..DGCR-6; commit
  `5c175d148932c8a3635e54a15f1db2f31f67a500` (Standard PR #346),
  SHA-256 `fc1734ddbd148e09738abdcc9e017ae5a0ad961a7fd022cc75c75dfd9e108e2e`.
- `alternative-payment-projection-v0.1.json` — DACS-4 APR-1..APR-8 and
  DACS-3/DACS-5 projection consumers; Standard PR #344, commit
  `332ba4d620930cc22b79fffa3f74440ebf0df5ca`; file SHA-256
  `73be437c15210ae57c0ad62a8e02fc70f37bface5da15cf207f9b88964aa5ca3`.
- `bundle-settlement-evidence-bijection-v0.4.json` — DACS-5 SEB-1..SEB-6,
  30 exact-set and rejection-precedence cases; commit
  `662be1d4899a2cadf327fe2d5523e93a80334e5f`, file SHA-256
  `d4a68beb877e563114388cb3b53d2f67140b6136e6cec9883873f87e4c35a593`.
- `evidence-bound-fault-bundle-compatibility-v0.4.json` — signed EBFAB direct,
  pointer, discriminator, cross-domain, lifecycle, and mixed-version cases;
  commit `662be1d4899a2cadf327fe2d5523e93a80334e5f`, file SHA-256
  `b5bad52a6293ea0d02414cd68243587a29ce0c74e803e6f4f7e8f589b6db9dfa`.
- `fab-bundle-extended-pointer-v0.3.json` — four retained v0.3 E7 pointer
  outcomes; commit `662be1d4899a2cadf327fe2d5523e93a80334e5f`, file SHA-256
  `5d6e596c0f22c74281b8791d5801047aba7f809d250917f5f05184a6b5bb6cfc`.

Do not edit a fixture locally. Replace it from a named Standard commit and
update this provenance note.
