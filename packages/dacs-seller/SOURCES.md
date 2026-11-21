# Sources

- http-mcp #58: `786aa1d9d6b6393190a6f388a4b92cb921af1fc6`.
- http-mcp #59: `ffef873a58a1e71f3a91ae159d92a549992c3857`.
- http-mcp base: `82bf8c4dabb2332a72f618f6cc29950e48d6feb6`.
- http-mcp module sources: `15fdf23`.
- CLI: adapted port of frontend `d6f0e16` `http-mcp/src/devnet-demo/operator.mjs` (config validation lines 121–149, retained draft lines 155–165); adds a closed `seller.json`, canonical data-directory binding and a shared Listing terms projection, rather than moving the operator.
- Seller Node wallet approval accounting: `createOperatorApprovalAttempt` moved from frontend `80e5162` `http-mcp/src/devnet-demo/operator-custody.mjs` (lines 35–66) into `src/devnet-demo/seller-node-wallet.mjs`. Delta: a settlement failure goes to the injected `diagnostics` sink as the closed `sellerDiagnostic(code)` projection instead of a stderr line carrying the error message. The request's own authorization check, which ran after the approval and again at the key's signature, is not moved, because the client's composition builds its own signing class.
- Seller approval ledger, payment-evidence request: the closed `payment-evidence-storage-create` shape in `src/devnet-demo/operator-approval.mjs` mirrors the request `planCreate` builds in `packages/dacs-client/src/wallet/node-payment-evidence-adapter.mjs` at `8f1ffc8bb` (lines 104–139); the ledger checks its members, debit and CREATE with the rules of the other payment-evidence kind.

The move-and-delta record is kept privately and is available on request.
