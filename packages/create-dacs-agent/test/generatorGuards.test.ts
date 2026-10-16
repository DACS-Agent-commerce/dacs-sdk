import type { Stats } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createDacsAgentProject } from "../src/index.js";

// What the generator's file-system calls and template set see. Each hook, while
// set, changes one answer, as a parent replaced mid-generation or a template
// set the public API cannot produce would.
const hooks = vi.hoisted(() => ({
  afterStaging: undefined as undefined | (() => Promise<void>),
  lstat: undefined as undefined | ((path: string, stat: Stats) => unknown),
  realpath: undefined as undefined | ((path: string, resolved: string) => string),
  templates: {} as Record<string, string>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: string) => {
      const stat = await actual.lstat(path);
      return hooks.lstat?.(path, stat) ?? stat;
    },
    realpath: async (path: string) => {
      const resolved = await actual.realpath(path);
      return hooks.realpath?.(path, resolved) ?? resolved;
    },
    mkdtemp: async (prefix: string) => {
      const created = await actual.mkdtemp(prefix);
      await hooks.afterStaging?.();
      return created;
    },
  };
});

vi.mock("../src/templates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/templates.js")>();
  return {
    ...actual,
    projectTemplates: (options: Parameters<typeof actual.projectTemplates>[0]) => ({
      ...actual.projectTemplates(options),
      ...hooks.templates,
    }),
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  hooks.afterStaging = undefined;
  hooks.lstat = undefined;
  hooks.realpath = undefined;
  hooks.templates = {};
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "create-dacs-agent-guards-")));
  temporaryDirectories.push(directory);
  return directory;
}

describe.runIf(process.platform !== "win32")("create-dacs-agent generation guards", () => {
  test("refuses a template path that leaves the project directory and leaves nothing behind",
    async () => {
      const parent = await temporaryDirectory();
      for (const file of ["", ".", "..", "../escaped", "nested/../../escaped",
        join(parent, "escaped")]) {
        hooks.templates = { [file]: "escaped\n" };
        await expect(createDacsAgentProject({
          targetDirectory: join(parent, "agent"),
          install: false,
        }), file).rejects.toThrow(`template path escapes the project directory: ${file}`);
        expect(await readdir(parent), file).toEqual([]);
      }
    });

  test("refuses a target parent whose canonical path is not a directory", async () => {
    const parent = await temporaryDirectory();
    const requested = join(parent, "requested");
    await mkdir(requested);
    const file = join(parent, "file");
    await writeFile(file, "kept", "utf8");
    const link = join(parent, "link");
    await symlink(requested, link);
    // The parent is replaced after its first check, by a file or a symbolic link.
    for (const replacement of [file, link]) {
      hooks.realpath = (path, resolved) => path === requested ? replacement : resolved;
      await expect(createDacsAgentProject({
        targetDirectory: join(requested, "agent"),
        install: false,
      }), replacement).rejects.toThrow("canonical target parent must be a non-symlink directory");
      expect(await readdir(requested)).toEqual([]);
    }
  });

  test("publishes nothing once the target parent changes during generation", async () => {
    const parent = await temporaryDirectory();
    const requested = join(parent, "requested");
    await mkdir(requested);
    // A stat of the parent that differs in one respect only.
    const changed = (change: Partial<Record<"symlink" | "directory" | "dev" | "ino", unknown>>) =>
      (path: string, stat: Stats) => path !== requested ? stat : {
        isSymbolicLink: () => change.symlink ?? false,
        isDirectory: () => change.directory ?? true,
        dev: change.dev ?? stat.dev,
        ino: change.ino ?? stat.ino,
      };
    const races: [string, () => void][] = [
      ["a symbolic link", () => { hooks.lstat = changed({ symlink: true }); }],
      ["not a directory", () => { hooks.lstat = changed({ directory: false }); }],
      ["another device", () => {
        hooks.lstat = (path, stat) => changed({ dev: stat.dev + 1 })(path, stat);
      }],
      ["another inode", () => {
        hooks.lstat = (path, stat) => changed({ ino: stat.ino + 1 })(path, stat);
      }],
      ["another canonical path", () => {
        hooks.realpath = (path, resolved) => path === requested ? `${requested}-elsewhere` : resolved;
      }],
    ];
    for (const [label, replace] of races) {
      hooks.afterStaging = async () => replace();
      await expect(createDacsAgentProject({
        targetDirectory: join(requested, "agent"),
        install: false,
      }), label).rejects.toThrow("target parent changed during project generation");
      // The staging tree is removed and no project is published.
      expect(await readdir(requested), label).toEqual([]);
      hooks.lstat = undefined;
      hooks.realpath = undefined;
    }

    // The parent directory itself is replaced while the project is staged.
    hooks.afterStaging = async () => {
      hooks.afterStaging = undefined;
      await rename(requested, `${requested}-old`);
      await mkdir(requested);
    };
    await expect(createDacsAgentProject({
      targetDirectory: join(requested, "agent"),
      install: false,
    })).rejects.toThrow("target parent changed during project generation");
    expect(await readdir(requested)).toEqual([]);
  });

  test("pins the generator's remaining target, name and runtime-identity rules", async () => {
    const parent = await temporaryDirectory();
    // The parent must exist and be a directory.
    const missing = createDacsAgentProject({
      targetDirectory: join(parent, "missing", "agent"),
      install: false,
    });
    await expect(missing).rejects.toThrow("target parent must already exist");
    await expect(missing).rejects.toMatchObject({ cause: { code: "ENOENT" } });
    await writeFile(join(parent, "file"), "kept", "utf8");
    await expect(createDacsAgentProject({
      targetDirectory: join(parent, "file", "agent"),
      install: false,
    })).rejects.toThrow("target parent must be a directory, not a symbolic link");

    // An existing empty target is used; surrounding spaces are trimmed; each run
    // of other characters in the package name becomes one -; files are sorted.
    await mkdir(join(parent, "my  agent"));
    const created = await createDacsAgentProject({
      targetDirectory: `  ${join(parent, "my  agent")}  `,
      install: false,
    });
    expect(created.targetDirectory).toBe(join(parent, "my  agent"));
    expect(JSON.parse(await readFile(join(parent, "my  agent", "package.json"), "utf8")))
      .toMatchObject({ name: "my-agent" });
    expect(created.files).toEqual([...created.files].sort());

    // The offline refusal names the live alternative.
    await expect(createDacsAgentProject({
      targetDirectory: join(parent, "offline-buyer"),
      role: "buyer",
      install: false,
    })).rejects.toThrow("this generator supports only the single-process demo-all simulation; " +
      "use live-demos for independent role services");

    // A non-root runner's own user and group run compose.
    const getuid = process.getuid;
    const getgid = process.getgid;
    process.getuid = () => 4242;
    process.getgid = () => 4343;
    try {
      await createDacsAgentProject({
        targetDirectory: join(parent, "runner"),
        mode: "live-demos",
        profile: "dacs-sdk:fixed-price-x402:v1",
        role: "buyer",
        deployment: "docker",
        install: false,
      });
    } finally {
      process.getuid = getuid;
      process.getgid = getgid;
    }
    const environment = await readFile(join(parent, "runner", ".env.example"), "utf8");
    expect(environment).toMatch(/^DACS_RUNTIME_UID=4242$/m);
    expect(environment).toMatch(/^DACS_RUNTIME_GID=4343$/m);

    // npm that cannot be started fails generation rather than the process.
    const inheritedPath = process.env.PATH;
    process.env.PATH = await temporaryDirectory();
    try {
      await expect(createDacsAgentProject({ targetDirectory: join(parent, "no-npm") }))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.env.PATH = inheritedPath;
    }
  });
});
