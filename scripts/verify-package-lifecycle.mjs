import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staleRelative = "dist/__dacs_stale_pack_probe__.js";
const packages = [
  {
    label: "core",
    directory: repoRoot,
    dist: join(repoRoot, "dist"),
    expected: "dist/index.js",
  },
  {
    label: "dacs-node",
    directory: join(repoRoot, "packages", "dacs-node"),
    dist: join(repoRoot, "packages", "dacs-node", "dist"),
    expected: "dist/index.js",
  },
  {
    label: "create-dacs-agent",
    directory: join(repoRoot, "packages", "create-dacs-agent"),
    dist: join(repoRoot, "packages", "create-dacs-agent", "dist"),
    expected: "dist/index.js",
  },
];

function runPack(packageDirectory, destination) {
  const result = spawnSync(
    "npm",
    ["pack", "--silent", "--json", "--pack-destination", destination],
    {
      cwd: packageDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed in ${packageDirectory} (${String(result.status)})\n` +
        result.stdout.toString("utf8") + result.stderr.toString("utf8"),
    );
  }
  const parsed = JSON.parse(result.stdout.toString("utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
    throw new Error(`npm pack returned invalid metadata in ${packageDirectory}`);
  }
  return new Set(parsed[0].files.map((entry) => entry.path));
}

function assertPackFiles(label, files, expected) {
  if (!files.has(expected)) {
    throw new Error(`${label} pack did not rebuild ${expected} from missing dist`);
  }
  if (files.has(staleRelative)) {
    throw new Error(`${label} pack retained ignored stale output ${staleRelative}`);
  }
}

const scratch = await mkdtemp(join(tmpdir(), "dacs-package-lifecycle-"));
try {
  for (const item of packages) {
    await rm(item.dist, { recursive: true, force: true });
    const fromMissing = runPack(item.directory, scratch);
    assertPackFiles(item.label, fromMissing, item.expected);

    await mkdir(item.dist, { recursive: true });
    await writeFile(
      join(item.directory, staleRelative),
      "throw new Error('stale pack output must never ship');\n",
      "utf8",
    );
    const afterStale = runPack(item.directory, scratch);
    assertPackFiles(item.label, afterStale, item.expected);
    try {
      await stat(join(item.directory, staleRelative));
      throw new Error(`${item.label} prepack did not remove the stale local output`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  process.stdout.write("package lifecycle verification passed for core, dacs-node and generator\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
