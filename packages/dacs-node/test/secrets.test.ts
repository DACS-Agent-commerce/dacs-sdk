import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DacsSecretLoadError,
  loadDacsSecretV1,
} from "../src/index.js";

describe("role-local secret loading", () => {
  const roots: string[] = [];

  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "dacs-secret-loader-"));
    roots.push(directory);
    return directory;
  }

  function secretFile(value = "correct horse battery staple"): string {
    const path = join(root(), "wallet.secret");
    writeFileSync(path, value, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  afterEach(() => {
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prefers an owner-only regular file over manager and environment sources", async () => {
    const manager = vi.fn(() => "manager-secret");
    const secret = await loadDacsSecretV1({
      name: "buyer-demos-key",
      mode: "live-demos",
      filePath: secretFile(),
      secretManager: { readSecret: manager },
      environmentVariable: "DACS_BUYER_DEMOS_KEY",
      environment: { DACS_BUYER_DEMOS_KEY: "environment-secret" },
    });
    expect(secret.source).toBe("file");
    expect(secret.text()).toBe("correct horse battery staple");
    expect(manager).not.toHaveBeenCalled();
    expect(JSON.stringify(secret)).not.toContain("correct horse");
    expect(secret.redact("key=correct horse battery staple"))
      .toBe("key=[REDACTED]");
  });

  it("uses the secret manager when the configured file is absent", async () => {
    const secret = await loadDacsSecretV1({
      name: "seller-demos-key",
      mode: "live-demos",
      filePath: join(root(), "missing.secret"),
      secretManager: { readSecret: () => Uint8Array.from([1, 2, 3, 4]) },
      environmentVariable: "DACS_SELLER_DEMOS_KEY",
      environment: { DACS_SELLER_DEMOS_KEY: "environment-secret" },
    });
    expect(secret.source).toBe("secret-manager");
    expect(secret.bytes()).toEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(secret.warningCodes).toEqual([]);
  });

  it("marks environment fallback as controlled-CI-only", async () => {
    const secret = await loadDacsSecretV1({
      name: "buyer-evm-key",
      mode: "live-demos",
      secretManager: { readSecret: () => null },
      environmentVariable: "DACS_BUYER_EVM_KEY",
      environment: { DACS_BUYER_EVM_KEY: "ci-only-secret" },
    });
    expect(secret.source).toBe("environment");
    expect(secret.warningCodes).toEqual(["secret-environment-source"]);
  });

  it("rejects symlinks and unsafe live permissions", async () => {
    const target = secretFile();
    const link = join(root(), "linked.secret");
    symlinkSync(target, link);
    await expect(loadDacsSecretV1({
      name: "buyer-demos-key",
      mode: "live-demos",
      filePath: link,
    })).rejects.toEqual(new DacsSecretLoadError("secret-file-symlink"));

    chmodSync(target, 0o640);
    await expect(loadDacsSecretV1({
      name: "buyer-demos-key",
      mode: "live-demos",
      filePath: target,
    })).rejects.toEqual(new DacsSecretLoadError("secret-file-permissions-unsafe"));
  });

  it("zeros retained material on destroy and refuses subsequent reads", async () => {
    const secret = await loadDacsSecretV1({
      name: "buyer-demos-key",
      mode: "live-demos",
      filePath: secretFile("destroy-me"),
    });
    const detached = secret.bytes();
    secret.destroy();
    expect(secret.destroyed).toBe(true);
    expect(detached).toEqual(new TextEncoder().encode("destroy-me"));
    expect(() => secret.bytes()).toThrowError(
      new DacsSecretLoadError("secret-destroyed"),
    );
  });

  it("fails closed on missing, invalid, oversized, and manager-error sources", async () => {
    await expect(loadDacsSecretV1({
      name: "missing-secret",
      mode: "live-demos",
    })).rejects.toEqual(new DacsSecretLoadError("secret-not-found"));
    await expect(loadDacsSecretV1({
      name: "manager-secret",
      mode: "live-demos",
      secretManager: { readSecret: () => { throw new Error("private detail"); } },
      environmentVariable: "DACS_MANAGER_SECRET",
      environment: { DACS_MANAGER_SECRET: "must-not-fallback" },
    })).rejects.toEqual(new DacsSecretLoadError("secret-manager-unavailable"));
    await expect(loadDacsSecretV1({
      name: "large-secret",
      mode: "live-demos",
      secretManager: { readSecret: () => "12345" },
      maxBytes: 4,
    })).rejects.toEqual(new DacsSecretLoadError("secret-too-large"));
    await expect(loadDacsSecretV1({
      name: "invalid-secret",
      mode: "live-demos",
      filePath: "relative.secret",
    })).rejects.toEqual(new DacsSecretLoadError("secret-file-path-invalid"));
  });

  it("does not invoke accessors while capturing secret options", async () => {
    const invoked = vi.fn(() => secretFile());
    const options = {
      name: "buyer-demos-key",
      mode: "live-demos",
    } as Record<string, unknown>;
    Object.defineProperty(options, "filePath", {
      enumerable: true,
      get: invoked,
    });
    await expect(loadDacsSecretV1(options as never)).rejects.toThrow(/closed data object/);
    expect(invoked).not.toHaveBeenCalled();
  });
});
