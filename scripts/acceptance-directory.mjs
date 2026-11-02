import { lstatSync } from "node:fs";
import { isAbsolute, join, parse, sep } from "node:path";

/** Requires an existing directory with no linked component; throws before following a link.
 * Checks lexical components before resolving dot segments, including trailing separators. */
export function requireDirectory(path) {
  if (typeof path !== "string" || !path) throw new Error("not a directory (or a link to one): " + path);
  const absolute = isAbsolute(path) ? path : process.cwd() + sep + path;
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (!part) continue;
    current = join(current, part);
    if (!lstatSync(current).isDirectory()) throw new Error("not a directory (or a link to one): " + current);
  }
}
