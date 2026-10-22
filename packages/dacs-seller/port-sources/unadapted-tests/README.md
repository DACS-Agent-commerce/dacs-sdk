# Historical test sources

These 70 files retain the port's unadapted test sources. They depend on
upstream application modules and keep their original import paths for reference;
they are not executable seller-package tests. Their original locations and hashes
remain recorded in PROVENANCE.json and PUBLISHED-BASELINE.json, with the relocation
recorded in MAINTENANCE.json.

The 22 executable standalone seller test files live in ../../test/. Both
package.json seller:test and test/seller/standalone.test.ts enumerate that complete
set; provenance-checkout.test.mjs checks that the two runners stay in sync.
