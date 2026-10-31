# Registry/container audit baseline

The machine-readable policy is `registry-container-audit-baseline.json`.
The original sources and earlier dispositions remain recorded there. Baseline
classification is exit 4; production publication remains blocked. A listed ID
never permits a direct high/critical result, and unknown findings still block.

## Node 20 consumer refresh

Source: the clean registry consumer job at `90f8443`, independently checked
against a fresh lock of the packed SDK, Node host and pinned generated peers.
No package or generator dependency declarations change here. Exact package,
location, integrity and engine range identify each engine exception.

| Finding | Dependency path and reason retained |
| --- | --- |
| `@tufjs/models@5.0.1 at node_modules/@tufjs/models` | The packed consumer selects demosdk 4.0.16 -> sigstore ^5.0.0 -> @sigstore/tuf ^5.0.0 -> tuf-js ^6.0.0 -> @tufjs/models 5.0.1. Both published models 5.x versions require Node 22.22.2 or newer supported majors; pinning 5.0.0 does not restore Node 20 support. A compatible parent-major change belongs in a separate consumer dependency change. |
| `tuf-js@6.0.1 at node_modules/tuf-js` | The packed consumer selects demosdk 4.0.16 -> sigstore ^5.0.0 -> @sigstore/tuf ^5.0.0 -> tuf-js ^6.0.0. Both published tuf-js 6.x versions require Node 22.22.2 or newer supported majors; pinning 6.0.0 does not restore Node 20 support. A compatible parent-major change belongs in a separate consumer dependency change. |
| `GHSA-4qx8-w7c3-pj3p` | The transitive path is demosdk 4.0.16 -> @coral-xyz/anchor 0.32.1 -> toml ^3.0.0 (3.0.0). Many array-of-tables headers cause quadratic parsing work. The corrected toml 5.0.1 is outside the selected parent range; the parent must change before this entry can be removed. |
| `GHSA-9j65-hcg3-gc64` | The same transitive Anchor/toml 3.0.0 path permits quadratic parsing work on long dotted keys or table paths. The corrected toml 5.0.1 is outside Anchor's ^3.0.0 range; retain the notice until the parent changes. |
| `GHSA-9qmh-m7c6-f92p` | The same transitive Anchor/toml 3.0.0 path permits excessive CPU use for long integer literals. The corrected toml 5.0.1 is outside Anchor's ^3.0.0 range; retain the notice until the parent changes. |
| `GHSA-mrhx-c7xc-m3w5` | The transitive path is @x402/core 2.15.0 -> zod ^3.24.2 (3.25.76). Oversized constrained collections can exhaust memory. The corrected zod 4.6.6 is outside the selected parent range; a compatible x402 parent update is required. Direct high/critical results remain blocking. |

A major-version override would replace dependencies outside their parents'
declared contracts. That needs a separate consumer dependency change and its
runtime compatibility checks. The current allowed tuf-js/models majors have
no Node 20 release; older patch pins retain the same engine restriction.
The toml and zod corrections likewise require parent range changes.

Remove each entry after its upstream constraint is corrected and fresh consumer
acceptance confirms it. Never convert incomplete evidence or a new identity to
baseline success.

## Additional fresh-lock notices

An independent check at `442164bc` found two more IDs in optional dependency
chains. npm 11.19.0 audits the virtual lock tree; CLI `--omit=dev` replaces the
container default `omit=optional`, so these notices are part of that evidence.
The audit scope is unchanged.

| Finding | Dependency path and reason retained |
| --- | --- |
| `GHSA-gcqx-w48m-w2h4` | The optional path is demosdk 4.0.16 -> rubic-sdk 5.57.4 -> @tonconnect/ui 2.4.4 -> deepmerge ^4.3.1 (4.3.1). The returned-object prototype-poisoning notice has no corrected release in this range; 4.3.1 is the latest published version. Retain it until the parent/module is corrected. |
| `GHSA-qr28-fpjm-wq7f` | The optional path is demosdk 4.0.16 -> rubic-sdk 5.57.4 -> web3 1.10.4 -> web3-bzz 1.10.4 -> swarm-js 0.1.42 -> xhr-request 1.1.0 -> query-string 5.1.1 -> decode-uri-component ^0.2.0 (0.2.2). The percent-encoded-run CPU correction is 0.5.1, outside the selected range; a compatible parent dependency update is required. |
