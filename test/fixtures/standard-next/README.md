# DACS Standard `next` review fixtures

These fixtures isolate selected current vectors for focused test reporting.
Each entry below names the exact DACS Standard commit it was copied from; do
not infer one global fixture revision when a later merged ruling is tested
ahead of the repository-wide conformance pin.

- `listing-rail-registry-resolution-v0.4.json` — DACS-1 §6.3.4 LRR-1..LRR-6;
  DACS-4 §9.4.3; commit
  `c2ecd9fa658776f5511f2414d7b4c3e23b847463`.
- `channel-message-replay-v0.1.json` — DACS-3 §8.3.3 and CH-6;
  commit `332ba4d620930cc22b79fffa3f74440ebf0df5ca`; file SHA-256
  `ce43b226e358e15cb126b4b7d53b8638648c14ca55250eb57e6db68e451ba13f`.
  Its historical raw-digest/hex signature conflict with current §8.5.1/SIG-6
  and Demos L2PS is tracked upstream in DACS-Standard#349.

Do not edit a fixture locally. Replace it from a named Standard commit and
update this provenance note.
