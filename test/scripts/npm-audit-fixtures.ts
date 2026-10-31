// npm audit reports and the locks they audit, for audit-policy tests, and a
// real `npm audit --json` run against a loopback registry.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { npmCli } from "./npm-archive-fixtures.js";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

/** One package entry of an npm audit report. */
export type AuditFinding = { severity: string; isDirect: unknown; via: unknown[] };

/** An `npm audit --json` report of `vulnerabilities` with counts that match them. */
export function auditReport(vulnerabilities: Record<string, AuditFinding>) {
  const packages = Object.values(vulnerabilities);
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, packages.filter(value => value.severity === severity).length]));
  return { auditReportVersion: 2, metadata: { vulnerabilities: { ...counts, total: packages.length } }, vulnerabilities };
}

/** A lock that installs every reported package at 1.0.0 and declares the
 * direct ones (isDirect: true) as root dependencies. */
export function auditLock(vulnerabilities: Record<string, AuditFinding>) {
  const names = Object.keys(vulnerabilities);
  const direct = names.filter(name => vulnerabilities[name]?.isDirect === true);
  return { lockfileVersion: 3, packages: {
    "": { name: "audit-consumer", version: "1.0.0", dependencies: Object.fromEntries(direct.map(name => [name, "1.0.0"])) },
    ...Object.fromEntries(names.map(name => [`node_modules/${name}`, { version: "1.0.0" }])),
  } };
}

/** A registry packument: `versions` maps each version to its dependencies. */
export type Packument = Record<string, Record<string, string>>;
/** A bulk advisory as the registry returns it. */
export type BulkAdvisory = { id: number; url: string; title: string; severity: string; vulnerable_versions: string };

/** Runs real `npm audit --json --package-lock-only` in `project` against a
 * loopback registry serving `packuments` and the bulk `advisories`. */
export async function npmAuditReport(project: string, cache: string, packuments: Record<string, Packument>,
  advisories: Record<string, BulkAdvisory[]>) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      if (url.startsWith("/-/npm/v1/security/advisories/bulk")) {
        const body = Buffer.concat(chunks);
        const names = Object.keys(JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString()));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(Object.fromEntries(names.filter(name => advisories[name]).map(name => [name, advisories[name]]))));
        return;
      }
      const name = decodeURIComponent(url.slice(1));
      const versions = packuments[name];
      response.writeHead(versions ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(versions ? { name, "dist-tags": { latest: Object.keys(versions).at(-1) },
        versions: Object.fromEntries(Object.entries(versions).map(([version, dependencies]) =>
          [version, { name, version, dependencies, dist: { tarball: `http://127.0.0.1:9/${name}-${version}.tgz` } }])) } : {}));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    return await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [npmCli, "audit", "--json", "--package-lock-only", "--no-update-notifier", "--registry", registry],
        { cwd: project, env: { ...process.env, npm_config_cache: cache } });
      let stdout = "";
      child.stdout.on("data", data => { stdout += data; });
      child.on("error", reject);
      child.on("close", status => resolve({ status, stdout }));
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
