// The step-1 path mapping, a pure function of the source path and the same for
// both packages. No dependencies, so check-provenance.mjs can load it.
//   http-mcp/src/X    -> packages/<pkg>/src/X
//   http-mcp/public/Y -> packages/<pkg>/src/public/Y
//   http-mcp/test/Z   -> packages/<pkg>/test/Z
//   PR port source P  -> packages/<pkg>/port-sources/pr<N>-<7-character inspected head>/P
const MAPPING = [['http-mcp/src/', 'src/'], ['http-mcp/public/', 'src/public/'], ['http-mcp/test/', 'test/']];

export function mapPath(pkg, sourcePath) {
  for (const [from, to] of MAPPING) {
    if (sourcePath.startsWith(from)) return `packages/${pkg}/${to}${sourcePath.slice(from.length)}`;
  }
  throw new Error(`no path mapping for ${sourcePath}`);
}

export function portSourcePath(pkg, port, sourcePath) {
  return `packages/${pkg}/port-sources/pr${port.pr}-${port.inspectedHead.slice(0, 7)}/${sourcePath}`;
}
