# Demos node and external source pins

The Demos read paths decide between *verified*, *invalid* and *indeterminate*
(CORE §5.1, DEMOS-MAPPING §A.2) from the exact shapes the node returns. That
verdict depends on node behaviour that `package-lock.json` does not pin. This
page records the node build and the external source revisions the SDK's
tests and reviews were checked against.

## Demos node

| What | Pin | How it was checked |
| --- | --- | --- |
| `@kynesyslabs/demosdk` | `4.0.16` (lockfile; npm integrity matches) | Source read: `nodeCall` returns `response.data.response` on HTTP 2xx and `{ result: 500, response: <error> }` on a transport failure. The Storage Program `read` is an `axios.get` that throws on any non-2xx. |
| Node source | `kynesyslabs/node@ac8f45f02fc9c25082ce9b83595c2e3916b49c5a` (2026-09-29) | The not-found, transport and Storage Program shapes below were read from this commit. |
| Live deployment | `node2.demos.sh`, `/version` = `0.9.9 RC` on branch label `stabilisation`, commit `61b8e75aa8db5e408c49e1c3a89db4d673f45578`, read 2026-10-15 | Read-only probes, recorded in `test/fixtures/demos-node/node2-read-contract-2026-10-15.json`. A read-only `getNetworkInfo` during the same review round reported `0.9.8`, the same commit, and `dirty: true`. The deployment is therefore **not** a clean, reproducible build, and the commit is not `ac8f45f`. |

### Read contract the adapter relies on

| Read | Node answer (source and live) | Adapter verdict |
| --- | --- | --- |
| `getTxByHash` for an unknown hash | HTTP 200 `{ result: 400, response: "error" }` | indeterminate (`SubstrateError`) |
| `getBlockByNumber` past the head | HTTP 200 `{ result: 404, response: "error" }` | indeterminate |
| `getBlockByNumber(0)` | HTTP 200 `{ result: 400, response: "error" }` | indeterminate |
| `GET /storage-program/:address`, missing | HTTP 404 `{ success: false, errorCode: "NOT_FOUND" }` | indeterminate (demosdk throws) |
| Transport failure | `{ result: 500, response: Error }` | indeterminate |
| `getTxByHash`, found | `hash`, `status: "confirmed"`, numeric `blockNumber`, `content` object | compared member by member |
| `getBlockByNumber`, found | `number`, `hash`, `status`, `content.ordered_transactions`, `content.timestamp` in **seconds**, `validation_data.signatures` | compared; a block without `validation_data` is indeterminate |
| `GET /storage-program/:address`, found | 12 members; **no** `createdByTx`, `lastModifiedByTx` or `interactionTxs` | provenance is recovered from the owner's Storage Program history. Without that history the read is indeterminate, never verified. A node that does serve the write's `createdByTx` (create) or `lastModifiedByTx` (update) is held to it exactly; `interactionTxs` never overrides it. |
| `getTransactionHistory(owner, "storageProgram", { start, limit })` | HTTP 200 `{ result: 200, response: [rows] }`, newest first, paged by `start`/`limit`. Each row: `hash` (64 hex, no `0x`), `status: "confirmed"`, numeric `blockNumber`, `content.type: "storageProgram"`, `content.from` (owner), `content.to` (`stor-…`), `content.nonce` as a decimal string, `content.data: ["storageProgram", { operation, storageAddress, data, … }]` | a create proof must be the address's single `CREATE_STORAGE_PROGRAM`; an update proof must be its latest mutation. It is read only after every other observation matches. A malformed row, a head that moves during the scan, more than 100 pages of 100, or a value that changes after the scan is indeterminate. |

`test/substrate/anchor-and-wait.test.ts` replays the recorded not-found reads
through both verifiers. The history row shape was read from node2 (read-only,
owner `storageProgram` history) in the same review round. A node release that changes any row above has to be
re-recorded and re-pinned here before it is supported. A response outside this
contract is treated as unanswered: it is indeterminate and never verified.

## Other external sources

| Source | Revision reviewed | Used for |
| --- | --- | --- |
| DACS-Standard | `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20` (`package.json` `dacs.standardRevision`) | Normative text and vectors |
| x402 protocol | `x402-foundation/x402@22a7677f829584073638d2e5b9898e1f19089b61` (pinned by the Standard's vector README) | v2 headers, `SettlementResponse`, v1 network map |
| `@x402/core`, `@x402/evm`, `@x402/fetch` | `2.15.0` (lockfile) | Executable x402 types and v1 map |
| `viem` | `2.55.19` (lockfile) | keccak topics, EIP-712 signing |
| EIP-3009 (Draft ERC) | `ethereum/ERCs@7ef00333d6b62eeee89ab64fc6d8a0ee87b8f5a7` and `ethereum/ERCs@dc0c98f9e8c726775874e7009e9d1c4f630c9d9d` | `AuthorizationUsed` / `AuthorizationCanceled` topics, `TransferWithAuthorization` type hash |
| EIP-712 | `ethereum/EIPs@a53ca05661e55cb4326a7ece19c444d324e3d420` (`EIPS/eip-712.md`) | Domain members |
| ERC-20 | `ethereum/ERCs@dc0c98f9e8c726775874e7009e9d1c4f630c9d9d` (`ERCS/erc-20.md`) | `Transfer` event. At the EIPs commit above, `EIPS/eip-20.md` is only a "moved" stub. |

The SDK constants were compared with these texts. No changed-path mismatch was
found.
