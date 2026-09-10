import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const DEFAULT_MAX_SECRET_BYTES = 65_536;
const SECRET_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ENVIRONMENT_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export type DacsSecretSourceV1 = "file" | "secret-manager" | "environment";

export interface DacsSecretManagerV1 {
  readSecret(
    name: string,
  ): Promise<string | Uint8Array | null | undefined> |
    string | Uint8Array | null | undefined;
}

export interface DacsSecretLoadOptionsV1 {
  name: string;
  mode: "offline" | "live-demos";
  filePath?: string;
  secretManager?: DacsSecretManagerV1;
  environmentVariable?: string;
  /** Injection point for controlled tests. Defaults to `process.env`. */
  environment?: Readonly<Record<string, string | undefined>>;
  maxBytes?: number;
}

export interface DacsLoadedSecretV1 {
  readonly source: DacsSecretSourceV1;
  readonly warningCodes: readonly string[];
  readonly destroyed: boolean;
  bytes(): Uint8Array;
  text(): string;
  redact(value: string): string;
  destroy(): void;
  toJSON(): Readonly<{
    source: DacsSecretSourceV1;
    warningCodes: readonly string[];
    redacted: true;
  }>;
}

export class DacsSecretLoadError extends Error {
  override readonly name = "DacsSecretLoadError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    value <= maximum;
}

function captureSecretOptions(
  value: unknown,
): Readonly<DacsSecretLoadOptionsV1> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const required = new Set(["name", "mode"]);
    const allowed = new Set([
      ...required,
      "filePath",
      "secretManager",
      "environmentVariable",
      "environment",
      "maxBytes",
    ]);
    const keys = Reflect.ownKeys(value);
    if ([...required].some((key) => !keys.includes(key)) ||
        keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
      throw new TypeError();
    }
    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError();
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured) as unknown as Readonly<DacsSecretLoadOptionsV1>;
  } catch {
    throw new TypeError("secret load options must be a closed data object");
  }
}

function bytesFrom(value: string | Uint8Array, maximum: number): Uint8Array {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(value);
  if (bytes.byteLength === 0) {
    throw new DacsSecretLoadError("secret-empty");
  }
  if (bytes.byteLength > maximum) {
    bytes.fill(0);
    throw new DacsSecretLoadError("secret-too-large");
  }
  return bytes;
}

async function readSecretFile(
  filePath: string,
  mode: DacsSecretLoadOptionsV1["mode"],
  maximum: number,
): Promise<Uint8Array | undefined> {
  if (!isAbsolute(filePath) || filePath.includes("\0")) {
    throw new DacsSecretLoadError("secret-file-path-invalid");
  }
  let initial;
  try {
    initial = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DacsSecretLoadError("secret-file-unavailable");
  }
  if (initial.isSymbolicLink()) {
    throw new DacsSecretLoadError("secret-file-symlink");
  }
  if (!initial.isFile()) {
    throw new DacsSecretLoadError("secret-file-not-regular");
  }
  if (initial.size <= 0 || initial.size > maximum) {
    throw new DacsSecretLoadError(initial.size <= 0 ? "secret-empty" : "secret-too-large");
  }
  if (mode === "live-demos" && (initial.mode & 0o777) !== 0o600) {
    throw new DacsSecretLoadError("secret-file-permissions-unsafe");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (mode === "live-demos" && currentUid !== undefined && initial.uid !== currentUid) {
    throw new DacsSecretLoadError("secret-file-owner-mismatch");
  }

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const admitted = await handle.stat();
    if (!admitted.isFile() || admitted.dev !== initial.dev || admitted.ino !== initial.ino) {
      throw new DacsSecretLoadError("secret-file-changed-during-open");
    }
    if (mode === "live-demos" && (admitted.mode & 0o777) !== 0o600) {
      throw new DacsSecretLoadError("secret-file-permissions-unsafe");
    }
    if (mode === "live-demos" && currentUid !== undefined && admitted.uid !== currentUid) {
      throw new DacsSecretLoadError("secret-file-owner-mismatch");
    }
    const content = await handle.readFile();
    if (content.byteLength === 0 || content.byteLength > maximum) {
      content.fill(0);
      throw new DacsSecretLoadError(
        content.byteLength === 0 ? "secret-empty" : "secret-too-large",
      );
    }
    const captured = Uint8Array.from(content);
    content.fill(0);
    return captured;
  } catch (error) {
    if (error instanceof DacsSecretLoadError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new DacsSecretLoadError("secret-file-symlink");
    throw new DacsSecretLoadError("secret-file-unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function redactionTokens(secret: Uint8Array): readonly string[] {
  const tokens = new Set<string>();
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(secret);
  if (utf8.length >= 4 && !utf8.includes("\uFFFD")) tokens.add(utf8);
  const hex = Buffer.from(secret).toString("hex");
  const base64 = Buffer.from(secret).toString("base64");
  const base64url = Buffer.from(secret).toString("base64url");
  if (hex.length >= 8) tokens.add(hex);
  if (base64.length >= 8) tokens.add(base64);
  if (base64url.length >= 8) tokens.add(base64url);
  return Object.freeze([...tokens].sort((left, right) => right.length - left.length));
}

function loadedSecret(
  source: DacsSecretSourceV1,
  bytes: Uint8Array,
  warningCodes: readonly string[],
): Readonly<DacsLoadedSecretV1> {
  let material = bytes;
  let destroyed = false;
  const warnings = Object.freeze([...warningCodes]);
  let tokens = redactionTokens(material);
  const assertAvailable = (): void => {
    if (destroyed) throw new DacsSecretLoadError("secret-destroyed");
  };
  return Object.freeze({
    source,
    warningCodes: warnings,
    get destroyed() {
      return destroyed;
    },
    bytes() {
      assertAvailable();
      return Uint8Array.from(material);
    },
    text() {
      assertAvailable();
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(material);
      } catch {
        throw new DacsSecretLoadError("secret-not-utf8");
      }
    },
    redact(value: string) {
      assertAvailable();
      if (typeof value !== "string") {
        throw new TypeError("secret redaction input must be text");
      }
      let redacted = value;
      for (const token of tokens) redacted = redacted.split(token).join("[REDACTED]");
      return redacted;
    },
    destroy() {
      if (destroyed) return;
      material.fill(0);
      material = new Uint8Array();
      tokens = Object.freeze([]);
      destroyed = true;
    },
    toJSON() {
      return Object.freeze({
        source,
        warningCodes: warnings,
        redacted: true as const,
      });
    },
  });
}

/**
 * Load one role-local secret using the one-click precedence contract. A named
 * file is preferred, then an injected OS secret-manager adapter, then the
 * explicitly named environment variable. Environment use is always surfaced
 * as a warning and is intended only for controlled CI.
 */
export async function loadDacsSecretV1(
  rawOptions: Readonly<DacsSecretLoadOptionsV1>,
): Promise<Readonly<DacsLoadedSecretV1>> {
  const options = captureSecretOptions(rawOptions);
  let secretManagerReader: DacsSecretManagerV1["readSecret"] | undefined;
  if (options.secretManager !== undefined && options.secretManager !== null) {
    try {
      const candidate = options.secretManager.readSecret;
      if (typeof candidate === "function") {
        secretManagerReader = Function.prototype.bind.call(
          candidate,
          options.secretManager,
        ) as DacsSecretManagerV1["readSecret"];
      }
    } catch {
      // The bounded option validation below rejects the adapter.
    }
  }
  if (typeof options.name !== "string" || !SECRET_NAME_RE.test(options.name) ||
      (options.mode !== "offline" && options.mode !== "live-demos") ||
      (options.filePath !== undefined && typeof options.filePath !== "string") ||
      (options.secretManager !== undefined &&
        (options.secretManager === null ||
          secretManagerReader === undefined)) ||
      (options.environmentVariable !== undefined &&
        (typeof options.environmentVariable !== "string" ||
          !ENVIRONMENT_NAME_RE.test(options.environmentVariable)))) {
    throw new TypeError("secret load options are invalid");
  }
  const maximum = options.maxBytes ?? DEFAULT_MAX_SECRET_BYTES;
  if (!positiveInteger(maximum, DEFAULT_MAX_SECRET_BYTES)) {
    throw new TypeError("secret byte limit is invalid");
  }

  if (options.filePath !== undefined) {
    const file = await readSecretFile(options.filePath, options.mode, maximum);
    if (file !== undefined) return loadedSecret("file", file, []);
  }

  if (options.secretManager !== undefined) {
    let managed: string | Uint8Array | null | undefined;
    try {
      managed = await secretManagerReader!(options.name);
    } catch {
      throw new DacsSecretLoadError("secret-manager-unavailable");
    }
    if (managed !== undefined && managed !== null) {
      if (typeof managed !== "string" && !(managed instanceof Uint8Array)) {
        throw new DacsSecretLoadError("secret-manager-result-invalid");
      }
      return loadedSecret("secret-manager", bytesFrom(managed, maximum), []);
    }
  }

  if (options.environmentVariable !== undefined) {
    const environment = options.environment ?? process.env;
    const value = environment[options.environmentVariable];
    if (value !== undefined) {
      return loadedSecret(
        "environment",
        bytesFrom(value, maximum),
        ["secret-environment-source"],
      );
    }
  }

  throw new DacsSecretLoadError("secret-not-found");
}
