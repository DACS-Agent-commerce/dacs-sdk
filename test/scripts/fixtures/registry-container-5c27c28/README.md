# Registry/container evidence for 5c27c28

Source: `clean registry consumer (Node 20 / Docker)`, run
[38706155424, attempt 1](https://github.com/DACS-Agent-commerce/dacs-sdk/actions/runs/38706155424/attempts/1),
merge commit `5c27c28fd9225cff3e7653a5a013fd5f3168398c`
(`ded30d5` into `3904d70`), fixture artifact
[dacs-registry-container-fixtures-5c27c28fd9225cff3e7653a5a013fd5f3168398c](https://github.com/DACS-Agent-commerce/dacs-sdk/actions/runs/38706155424/artifacts/11959340907).

All files are copied verbatim except the filtered lock and image inventory.
Those retain 28 lock entries and 23 observed image entries covering the original
b7b180f locations and the demosdk → pqcrypto and MultiversX → bip39 paths.
Each retained entry is unchanged. Tests re-extract findings from these files;
only the engine scan's evaluated-package count differs from the complete run.
The original summary keeps its recorded failing disposition (exit 3).
Reconstructed replays explicitly supply completion metadata for the current
validator and use the recorded package version; the original legacy JSON stays unchanged.
`engine-strict.log.txt` preserves the uploaded engine log under a tracked filename.

The two findings outside the previous #191 baseline were a pqcrypto registry /
manifest version mismatch and an omitted optional bip39 copy. Their individual
dispositions and upstream dependency paths are recorded in
`scripts/registry-container-audit-baseline.json`.

SHA-256 of the original uploaded files (before filtering):

- `acceptance-summary.json`: `4a005a97a2ccf87c0549c7852d2587a7ea26c30b645bbb3afd6e6795b542c504`
- `consumer-lock-sbom.err`: `1e51ce5e4dc84c10fe3e90046c6d566381af2f81d6f552c6fb592d4143c683fd`
- `consumer-lock-sbom.exit-code`: `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`
- `consumer-physical-sbom.err`: `01a0cb90ea91c51854307158e00287e2c8a6369ee4969d20d5646dca5096b992`
- `consumer-physical-sbom.exit-code`: `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`
- `dependency-policy.json`: `8392c37fa33a285aa72e7592dd1bfff906254f91e55bda75199377fd00f10f17`
- `engine-strict.exit-code`: `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`
- `engine-strict.log.txt`: `0a36a2a18228da7d1fdac0207f4d9e18cf9b7376dce12375d6f14ca971bfc4e9`
- `engine-versions.json`: `765db2d95189ebbdbdce786598239ae4f7c9d5ebd0aff7d2ce050d90d37e8adc`
- `generated-package-lock.json`: `109dd26bfd4c359b0573e7cfe3c771c76d2d54472172279558bb0bafb951bfe7`
- `runtime-image-inventory.json`: `758ddfae98e30859ac0279ccfe4b4177f8ccb330e943ce8beda2db0a3e451b44`
- `runtime-image-policy.json`: `a704330bc2cd013d4f0d05ce32fd6c4317b3ee745dac2e6a1bc6cc5dda7b75c5`
