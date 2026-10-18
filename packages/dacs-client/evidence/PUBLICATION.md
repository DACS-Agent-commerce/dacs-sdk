The immutable publication checkpoint is SDK commit
`5c7d5e066eed8ebf9b9744b7a44e6cee72abe7f1`. It ships in this branch's ancestry.
The publication squashed the original destination history; its historical
baseline `ecb2cd76cdb00f44b0ca05c4cead2774bae0f064` is unavailable here.

`publication-history.json` preserves the full original source manifest, delta
ledger (including before/after blob identities), and commit inventory. Its
SHA-256 is pinned in `scripts/delta-map.mjs`. These are archived assertions,
not a claim that the discarded Git objects were independently authenticated.
The original source manifest is immutable and still checked by the `--source`
acceptance gate against frontend commit
`82bf8c4dabb2332a72f618f6cc29950e48d6feb6` when that repository is supplied.
`--local-only` remains explicitly NOT an original-source acceptance check.

The v2 ledger enumerates every source/test change after the shipped publication
checkpoint and verifies each before/after blob, exact unique commit subject,
complete file inventory, working bytes and index. The generated delta table
uses publication-to-current coordinates. No missing-history fallback or main
baseline substitution is permitted. Original-source acceptance remains pending
until the independently verified frontend source repository is supplied.

The hold gate now freezes only the private client package, with its reciprocal control pair. Original purchase prerequisites remain recorded. Outside SDK files are unrestricted. The original publication inventory through `aac0305` remains audited; later commits require client inventory entries only when they change the client package. Merge commits are excluded from authored-delta enumeration, and package bytes remain checked at HEAD.

CI uses a full-history checkout (`fetch-depth: 0`) so the publication checkpoint and snapshot used to authenticate archived source tests are available. A shallow checkout must fetch that ancestry before running the provenance gate. Historical tests are labelled text under `source-tests/`; they establish no current package coverage.
