# DACS Standard `next` review fixtures

These fixtures isolate selected current vectors for focused test reporting.
Each is copied byte-for-byte from the named DACS Standard `next` revision.

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

Do not edit a fixture locally. Replace it from a named Standard commit and
update this provenance note.
