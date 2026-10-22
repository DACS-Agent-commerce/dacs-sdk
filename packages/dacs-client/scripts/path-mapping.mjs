// Source-to-destination path mapping for the verbatim copy (client package step 1).
// A pure function of the frontend source path, shared by the copy script and
// the provenance checker, and the same mapping the seller package uses:
//   http-mcp/src/X    -> <package>/src/X
//   http-mcp/public/Y -> <package>/src/public/Y
//   http-mcp/test/Z   -> <package>/test/Z
// Any other source path has no destination and is an error.

export const CLIENT_PACKAGE_DIR = "packages/dacs-client";

export function mapSourcePath(sourcePath, packageDir = CLIENT_PACKAGE_DIR) {
  const match = /^http-mcp\/(src|public|test)\/(.+)$/.exec(sourcePath);
  if (!match || match[2].split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`no destination mapping for source path ${JSON.stringify(sourcePath)}`);
  }
  const [, top, rest] = match;
  if (top === "src") return `${packageDir}/src/${rest}`;
  if (top === "public") return `${packageDir}/src/public/${rest}`;
  return `${packageDir}/test/${rest}`;
}
