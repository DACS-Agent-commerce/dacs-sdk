Directory manifest fixtures are the complete return objects of directoryManifest
from DACS-Agent-commerce/Community:

- directory-v1.json: b4226cc5a255df322da248344f2121afe764438d,
  reference-implementations/dacs-directory/src/catalog/contracts.ts.
- directory-v2.json: b5ac07d3f999bcb548b531b68be1ba27b1adf35d,
  the same path, using DACS_DIRECTORY_VERSION = "2", TESTNET_RESTRICTIONS
  and LISTING_QUERY_PARAMETERS from src/catalog/testnetMetricPolicy.ts.

Both use origin https://directory.example and demosRpc https://rpc.example.
Tests derive missing-capability and malformed cases from these fixtures.
