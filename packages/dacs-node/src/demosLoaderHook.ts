const DEMOS_OPERATIONS_DIRECTORY =
  "/@kynesyslabs/demosdk/build/demoswork/operations/";

interface ResolveError {
  code?: unknown;
  url?: unknown;
}

interface ResolveContext {
  parentURL?: string;
  conditions: readonly string[];
  importAttributes: Readonly<Record<string, string>>;
}

type NextResolve = (
  specifier: string,
  context: Readonly<ResolveContext>,
) => Promise<Readonly<Record<string, unknown>>>;

/** Resolve only demosdk's published extensionless operations directory. */
export async function resolve(
  specifier: string,
  context: Readonly<ResolveContext>,
  nextResolve: NextResolve,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const observed = error as ResolveError;
    if (observed.code !== "ERR_UNSUPPORTED_DIR_IMPORT" ||
        typeof observed.url !== "string" ||
        !observed.url.endsWith(DEMOS_OPERATIONS_DIRECTORY)) {
      throw error;
    }
    return Object.freeze({
      url: new URL("index.js", observed.url).href,
      shortCircuit: true,
    });
  }
}
