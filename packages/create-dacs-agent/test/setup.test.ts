import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";
import { afterEach, expect, test, vi } from "vitest";

import { VERSION } from "../../../src/version.js";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "../../../src/commerce/index.js";
import { createDacsAgentProject } from "../src/index.js";

// The built package, as a generated project loads it. A non-literal specifier
// keeps the generator typecheck independent of the package build output.
const DACS_NODE_PACKAGE = "@kynesyslabs/dacs-node";

type DoctorProbe = (context: unknown) => unknown;

interface DacsLiveDoctorOptionsV1 {
  phase: string;
  scope: string;
  probes?: Readonly<Record<string, DoctorProbe>>;
}

interface DacsLiveDoctorReportV1 {
  phase: string;
  scope: string;
  exitCode: number;
  checks: readonly {
    id: string;
    required: boolean;
    status: string;
    reasonCode?: string;
  }[];
}

interface DacsNodeDoctorSurface {
  DACS_LIVE_DOCTOR_CHECK_IDS: readonly string[];
  DACS_NODE_LIVE_PROFILE: string;
  createDacsRoleServiceDoctorProbesV1: unknown;
  formatDacsLiveDoctorTextV1: unknown;
  runDacsLiveDoctorV1: (
    options: DacsLiveDoctorOptionsV1 & Record<string, unknown>,
  ) => Promise<DacsLiveDoctorReportV1>;
}

const {
  DACS_LIVE_DOCTOR_CHECK_IDS,
  DACS_NODE_LIVE_PROFILE,
  createDacsRoleServiceDoctorProbesV1,
  formatDacsLiveDoctorTextV1,
  runDacsLiveDoctorV1,
}: DacsNodeDoctorSurface = await import(DACS_NODE_PACKAGE);

const directories: string[] = [];
const listeners: Server[] = [];
const require = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function roleListener(role: "buyer" | "seller", unrelated = false): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(unrelated ? {} : {
      version: 1,
      role,
      status: "healthy",
      ready: true,
      reasonCodes: [],
      lifecycle: "running",
      commerce: { status: "configured" },
      sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      profile: DACS_NODE_LIVE_PROFILE,
    }));
  });
  listeners.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  return "http://127.0.0.1:" + String(address.port);
}

async function generatedSetup(options: {
  rail?: "pay-dem" | "x402";
  unrelatedListener?: boolean;
  missingListing?: boolean;
  confirm?: boolean;
  doctorOnly?: boolean;
} = {}) {
  const rail = options.rail ?? "pay-dem";
  const parent = await mkdtemp(join(tmpdir(), "generated-setup-"));
  directories.push(parent);
  const target = join(parent, "agent");
  await createDacsAgentProject({
    targetDirectory: target,
    mode: "live-demos",
    role: "buyer",
    deployment: "local",
    rails: "both",
    install: false,
  });
  const endpoints = {
    buyer: await roleListener("buyer", options.unrelatedListener),
    seller: await roleListener("seller"),
  };
  const reports: Readonly<DacsLiveDoctorReportV1>[] = [];
  const output: string[] = [];
  const processFixture = {
    env: {
      DACS_DEPLOYMENT: "local",
      ...(options.confirm === false ? {} : { DACS_SETUP_WRITE_CONFIRM: "1" }),
    },
    argv: [process.execPath, "cli.js", ...(options.doctorOnly
      ? ["doctor", "--phase", "pre-start", "--for", "setup", "--rail", rail]
      : ["setup", "--rail", rail, "--max-spend-dem", "10", "--non-interactive"])],
    versions: process.versions,
    stdout: { write: (value: string) => output.push(value) },
    stderr: { write: (value: string) => output.push(value) },
    exitCode: undefined as number | undefined,
  };
  const loadRoleConfig = (role: "buyer" | "seller") => ({
    role,
    rail: { enabledProfiles: ["pay-dem", "x402"] },
    dataDirectory: join(target, "data", role),
    publicBaseUrl: endpoints[role],
  });
  // Keep the generated deployment probe and real HTTP service probes. Fixtures
  // supply chain, payment and storage prerequisites without live writes.
  const runDoctor = async (input: DacsLiveDoctorOptionsV1) => {
    const pass = () => ({ status: "pass" as const });
    const probes = Object.fromEntries(DACS_LIVE_DOCTOR_CHECK_IDS.map((id) => [id,
      id === "local.deployment-runtime" || id.startsWith("service.") ||
          options.missingListing && id === "demos.listing-candidate"
        ? input.probes?.[id] ?? pass : pass,
    ]));
    const report = await runDacsLiveDoctorV1({ ...input, probes });
    reports.push(report);
    return report;
  };
  const host = {
    DACS_LIVE_DOCTOR_CHECK_IDS,
    DACS_NODE_LIVE_PROFILE,
    createDacsRoleServiceDoctorProbesV1,
    formatDacsLiveDoctorTextV1,
    dacsLiveRailProfiles: () => ["pay-dem", "x402"],
    loadDacsSecretV1: async () => ({}),
    createDacsDemosActorRuntimeV1: async () => ({}),
    deriveDacsEvmRoleIdentityV1: () => ({}),
    createDacsRoleReadinessLatchV1: () => ({}),
    runDacsRoleTransportDiagnosticV1: async () => ({
      authenticated: true, durable: true, acknowledged: true, noAction: true,
    }),
    establishDacsRoleServiceReadinessV1: async ({ doctor }: { doctor: DacsLiveDoctorOptionsV1 }) => ({
      report: await runDoctor({ ...doctor, phase: "post-start", scope: "start" }),
    }),
    runDacsLiveDoctorV1: runDoctor,
  };
  const execute = vi.fn(async () => ({ status: "completed" }));
  const modules: Record<string, unknown> = {
    "@kynesyslabs/dacs": { VERSION },
    "@kynesyslabs/dacs/commerce": { FIXED_PRICE_X402_STANDARD_REVISION },
    "@kynesyslabs/dacs/identity": {},
    "@kynesyslabs/dacs-node": host,
    "@kynesyslabs/dacs-node/sqlite": {
      openDacsNodeSqliteDatabase: async () => ({ close() {} }),
    },
    "./config.js": {
      loadRoleConfig,
      serviceEndpoint: (role: "buyer" | "seller") => endpoints[role],
      configuredAuthority: (role: string) => role,
      actorSecretPath: () => "identity",
      actorDatabasePath: (role: string) => join(target, "data", role, "actor.sqlite"),
      configuredRailStewardAuthority: () => undefined,
      configuredListingDraftFile: () => undefined,
    },
    "./setup.js": {
      prepareGeneratedListingSetupV1: async () => ({ plan: { planHash: "prepared-plan" } }),
      executeGeneratedListingSetupV1: execute,
    },
  };
  async function evaluate(name: string): Promise<Record<string, unknown>> {
    const filename = join(target, "src", name + ".ts");
    const source = (await readFile(filename, "utf8"))
      .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href))
      .replace("main().catch(", "return main().catch(");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    const evaluateSource = new Function("require", "exports", "process", compiled);
    await evaluateSource((specifier: string) => specifier.startsWith("node:")
      ? require(specifier) : modules[specifier] ?? {}, exports, processFixture);
    return exports;
  }
  modules["./doctor.js"] = await evaluate("doctor");
  await evaluate("cli");
  return { code: processFixture.exitCode, execute, reports, output: output.join("") };
}

test.each(["pay-dem", "x402"] as const)(
  "generated setup completes for %s with both role services listening",
  async (rail) => {
    const result = await generatedSetup({ rail });
    expect(result.code, result.output).toBe(0);
    expect(result.execute).toHaveBeenCalledOnce();
    expect(result.reports.map(({ phase, scope, exitCode }) => ({ phase, scope, exitCode }))).toEqual([
      { phase: "post-start", scope: "start", exitCode: 0 },
      { phase: "pre-start", scope: "setup", exitCode: 0 },
    ]);
    const setup = result.reports[1]!;
    for (const id of ["demos.nonce", "demos.balance-fees", "demos.listing-candidate",
      rail + ".rail-authority", rail + ".payee-binding"]) {
      expect(setup.checks.find((check) => check.id === id)).toMatchObject({
        required: true, status: "pass",
      });
    }
    expect(result.execute.mock.calls[0]).toEqual([expect.objectContaining({
      selectedRail: rail, doctorReports: result.reports,
    })]);
  },
);

test("generated setup refuses an unrelated listener on a role port", async () => {
  const result = await generatedSetup({ unrelatedListener: true });
  expect(result.code, result.output).toBe(1);
  expect(result.execute).not.toHaveBeenCalled();
  expect(result.reports).toHaveLength(1);
  expect(result.reports[0]!.checks.find((check) => check.id === "service.health"))
    .toMatchObject({ required: true, status: "fail", reasonCode: "role-service-unhealthy" });
});

test("generated setup still requires its Listing prerequisite after post-start passes", async () => {
  const result = await generatedSetup({ missingListing: true });
  expect(result.code, result.output).toBe(5);
  expect(result.execute).not.toHaveBeenCalled();
  expect(result.reports[0]).toMatchObject({ phase: "post-start", exitCode: 0 });
  expect(result.reports[1]).toMatchObject({ phase: "pre-start", scope: "setup", exitCode: 5 });
  expect(result.reports[1]!.checks.find((check) => check.id === "demos.listing-candidate"))
    .toMatchObject({ required: true, status: "blocked", reasonCode: "listing-candidate-file-missing" });
});

test("standalone pre-start setup Doctor still requires free role ports", async () => {
  const result = await generatedSetup({ doctorOnly: true });
  expect(result.code, result.output).toBe(1);
  expect(result.execute).not.toHaveBeenCalled();
  expect(result.reports).toHaveLength(1);
  expect(result.reports[0]!.checks.find((check) => check.id === "local.deployment-runtime"))
    .toMatchObject({ required: true, status: "fail", reasonCode: "service-port-unavailable" });
});

test("generated setup without write confirmation stays plan-only", async () => {
  const result = await generatedSetup({ confirm: false });
  expect(result.code, result.output).toBe(0);
  expect(result.execute).not.toHaveBeenCalled();
  expect(result.reports).toHaveLength(0);
});
