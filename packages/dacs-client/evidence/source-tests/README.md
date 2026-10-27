# Historical source tests

These files are text evidence from the pre-review snapshot, not executable package tests. They depend on application modules, browser assets, stores or wallet components outside this package, or describe removed behavior. They establish no passing coverage here, including for wallet nonce reservation.

`INDEX.json` maps every original path to its exact archived bytes at `aac0305`. The executable layout regression verifies every entry against that Git snapshot. Existing evidence pass counts describe their recorded historical runs, not the current suite.

Run the current isolated package suite with `npm test --workspace @kynesyslabs/dacs-client` after building the SDK. It discovers every executable test in `scripts/` and `test/`, runs one file at a time, and reports each file's registered test count. Source-repository acceptance cases report explicit skips when their separate source repository is unavailable. This archive is excluded from executable discovery.
