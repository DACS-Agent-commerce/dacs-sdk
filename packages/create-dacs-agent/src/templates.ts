export interface ProjectTemplateOptions {
  packageName: string;
  deployment: "local" | "docker";
}

const SDK_VERSION = "0.1.0-alpha.0";

function packageJson(packageName: string): string {
  return JSON.stringify(
    {
      name: packageName,
      version: "0.1.0",
      private: true,
      type: "module",
      engines: { node: "^20.19.0 || >=22.12.0" },
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc --noEmit -p tsconfig.json",
        test: "npm run build && node --test dist/test/offline-lifecycle.test.js",
        "dacs:smoke:offline": "npm run build && node dist/src/service.js",
      },
      dependencies: {
        "@kynesyslabs/dacs": SDK_VERSION,
        "@kynesyslabs/dacs-node": SDK_VERSION,
      },
      devDependencies: {
        "@types/node": "20.19.1",
        typescript: "5.9.2",
      },
    },
    null,
    2,
  ) + "\n";
}

function dacsConfig(): string {
  return `import type { DacsAgentConfig } from "@kynesyslabs/dacs-node";

const config = {
  mode: "offline",
  profile: "dacs-sdk:fixed-price-offline:v1",
  role: "demo-all",
  dataDirectory: "./data",
  limits: {
    maxServiceAmount: { asset: "USD", amount: "1" },
    maxSetupSpendDem: "0",
    maxDemosNetworkFeeDem: "0",
    maxEvmNetworkFeeEth: "0",
  },
} satisfies DacsAgentConfig;

export default config;
`;
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["dacs.config.ts", "src", "test"]
}
`;

const CONFIG_SOURCE = `import { validateDacsAgentConfig } from "@kynesyslabs/dacs-node";

import fileConfig from "../dacs.config.js";

export function loadConfig() {
  return validateDacsAgentConfig(fileConfig);
}
`;

const BUYER_SOURCE = `export const buyerComponent = Object.freeze({
  role: "buyer" as const,
  description: "Logical buyer fixture in the single-process simulation",
});
`;

const SELLER_SOURCE = `export const sellerComponent = Object.freeze({
  role: "seller" as const,
  description: "Logical seller fixture in the single-process simulation",
});
`;

const VERIFIER_SOURCE = `export const verifierComponent = Object.freeze({
  role: "verifier" as const,
  description: "Logical verifier fixture in the single-process simulation",
});
`;

const SERVICE_SOURCE = `import { resolve } from "node:path";

import { runOfflineVerifierSimulation } from "@kynesyslabs/dacs-node";

import { buyerComponent } from "./buyer.js";
import { loadConfig } from "./config.js";
import { sellerComponent } from "./seller.js";
import { verifierComponent } from "./verifier.js";

const config = loadConfig();
if (config.mode !== "offline") {
  throw new Error("this generated quickstart contains only the offline profile");
}
if (config.role !== "demo-all") {
  throw new Error(
    "independent role services require the production host-kit work package; use role demo-all for this offline quickstart",
  );
}

const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const outputDirectory = resolve(config.dataDirectory, "runs", runId);
const report = await runOfflineVerifierSimulation({ outputDirectory });

process.stdout.write(
  JSON.stringify(
    {
      event: "dacs.offline-simulation.complete",
      roles: [buyerComponent.role, sellerComponent.role, verifierComponent.role],
      jobId: report.jobId,
      profile: report.profile,
      paymentDisposition: report.payment.disposition,
      reportPath: report.reportPath,
      normativeConformance: report.normativeConformance,
      commercialSuccess: report.commercialSuccess,
      simulationPassed: report.simulationPassed,
    },
    null,
    2,
  ) + "\\n",
);
`;

const TEST_SOURCE = `import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runOfflineVerifierSimulation } from "@kynesyslabs/dacs-node";

test("offline quickstart produces a fail-closed verifier simulation report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dacs-generated-test-"));
  try {
    const report = await runOfflineVerifierSimulation({ outputDirectory: directory });
    assert.equal(report.simulationPassed, true);
    assert.equal(report.normativeConformance, false);
    assert.equal(report.commercialSuccess, false);
    assert.equal(report.mode, "offline");
    assert.equal(report.profile, "dacs-sdk:fixed-price-offline:v1");
    assert.equal(report.payment.availability, "mocked");
    assert.equal(report.assurance.substrateAuthority, "mocked-local-not-sr2");
    assert.equal(report.assurance.providerAuthority, "mocked-self-signed-not-sr3");
    assert.equal(report.assurance.railAuthority, "mocked-local-not-rav-r5");
    assert.equal(report.assurance.jobIdDiscipline, "fresh-csprng-ulid-per-run");
    assert.deepEqual(report.phases.map((phase) => phase.stage), [
      "DACS-1",
      "DACS-2",
      "DACS-3",
      "DACS-4",
      "DACS-5",
    ]);
    const persisted = JSON.parse(await readFile(report.reportPath, "utf8"));
    assert.deepEqual(persisted, report);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
`;

const DOCKERFILE = `FROM node:20.19.1-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
# The generator deliberately emits no fabricated lock. A normal registry-backed
# install creates the first valid package-lock.json from published packages.
RUN npm install --ignore-scripts
# The generated .dockerignore keeps credentials, local state and host
# dependencies outside both the build context and the resulting image.
COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:20.19.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system dacs && useradd --system --gid dacs --home-dir /app dacs
COPY --from=build --chown=dacs:dacs /app/package.json /app/package-lock.json ./
COPY --from=build --chown=dacs:dacs /app/node_modules ./node_modules
COPY --from=build --chown=dacs:dacs /app/dist ./dist
USER dacs
CMD ["node", "dist/src/service.js"]
`;

const DOCKERIGNORE = `.git*
.context
.DS_Store
.env
.env.*
*.env
.netrc
.npmrc
.pnpmrc
.yarnrc*
.aws
.config
.gnupg
.ssh
node_modules
dist
coverage
data
artifacts
secrets
*.log
*.pem
*.key
*.crt
*.der
*.p8
*.p12
*.pfx
*.jks
*.keystore
id_rsa
id_ed25519
`;

const COMPOSE = `services:
  offline-demo:
    build: .
    volumes:
      - offline-data:/app/data
    read_only: true
    tmpfs:
      - /tmp
    restart: "no"

# The production host-kit PR will replace this single-process offline service
# with independently supervised buyer/seller/verifier services and distinct
# secret mounts. This file intentionally exposes no database or public port.
volumes:
  offline-data:
`;

function readme(deployment: ProjectTemplateOptions["deployment"]): string {
  return `# DACS offline verifier simulation

This project runs a local SDK verifier exercise with logical buyer, seller and
verifier fixtures. It is **not** a conformant DACS transaction and it does not
assert commercial success.

The payment, provider receipt, substrate anchors and finality are simulated.
The provider fixture is self-signed test data, not the SR-3 attestation required
by AP2-2. It does not use x402, Demos, a live provider, credentials or funds.
The run uses fresh job and presentation identifiers, but it does not implement
the durable CORE §B.8 SN-1..SN-4 challenge ledger. Its local rail fixture is not
the signed, anchored DACS-4 §9.4.4 RAV-R5 authority.

## Run

\`\`\`bash
npm run typecheck
npm test
npm run dacs:smoke:offline
\`\`\`

The smoke command prints the absolute path to \`simulation-report.json\`. Every
persisted fixture is wrapped in a non-conformant simulation envelope below the
report's \`simulation-artifacts/\` directory. Those files are not independently
anchored \`AttestationRef\` targets.

No lockfile is fabricated by the generator. The default install creates a valid
lock from the published registry packages; with \`--no-install\`, run
\`npm install --ignore-scripts\` before using \`npm ci\`.

Selected deployment: **${deployment}**.

Live mode is deliberately absent from this work package. SQLite recovery,
authenticated role services, doctor gates, guarded setup/purchase and funded
testnet operation must land before this project may be described as a production
one-click deployment.
`;
}

const ENV_EXAMPLE = `# Safe public defaults only. The simulation needs no secrets.
`;

const GITIGNORE = `.env
.env.*
!.env.example
node_modules/
dist/
data/*
!data/.gitkeep
artifacts/
*.log
*.pem
*.key
secrets/*
!secrets/README.md
`;

const SECRETS_README = `# Secrets

The offline profile uses no credentials. Do not add keys to this directory.
Future live profiles will consume role-separated, read-only secret files and
will never commit them to source control.
`;

export function projectTemplates(
  options: ProjectTemplateOptions,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "package.json": packageJson(options.packageName),
    "tsconfig.json": TSCONFIG,
    "dacs.config.ts": dacsConfig(),
    ".env.example": ENV_EXAMPLE,
    ".gitignore": GITIGNORE,
    ".dockerignore": DOCKERIGNORE,
    Dockerfile: DOCKERFILE,
    "compose.yaml": COMPOSE,
    "README.md": readme(options.deployment),
    "src/buyer.ts": BUYER_SOURCE,
    "src/seller.ts": SELLER_SOURCE,
    "src/verifier.ts": VERIFIER_SOURCE,
    "src/service.ts": SERVICE_SOURCE,
    "src/config.ts": CONFIG_SOURCE,
    "test/offline-lifecycle.test.ts": TEST_SOURCE,
    "data/.gitkeep": "",
    "secrets/README.md": SECRETS_README,
  });
}
