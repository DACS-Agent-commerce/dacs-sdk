#!/usr/bin/env bash
# Run from the repository root: scripts/pack-buyer-install.sh <directory>
# Packs the root, client and Node host kit packages into <directory>, installs the archives into <directory>/app
# without scripts or optional dependencies, and fails unless dacs-node there is the packed archive, not a registry copy.
set -euo pipefail

directory="${1:?usage: pack-buyer-install.sh <directory>}"
mkdir -p "$directory/app"
npm pack --ignore-scripts --pack-destination "$directory"
npm pack --workspace @kynesyslabs/dacs-client --pack-destination "$directory"
npm pack --workspace @kynesyslabs/dacs-node --pack-destination "$directory"
npm install --prefix "$directory/app" --no-audit --ignore-scripts --omit=optional "$directory"/*.tgz
(cd "$directory/app" && npm ls --json @kynesyslabs/dacs-node | node -e 'const installed = JSON.parse(require("fs").readFileSync(0, "utf8")).dependencies["@kynesyslabs/dacs-node"]; if (!/^file:.*kynesyslabs-dacs-node-.*\.tgz$/.test(installed?.resolved)) { console.error("dacs-node is not the candidate archive: " + installed?.resolved); process.exit(1); }')
