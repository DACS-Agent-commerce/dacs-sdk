// Shared by the existing three-package verifier and the five-package preparation gate.
export function validateReleaseIdentity(manifest, name) {
  if (manifest.name !== name || manifest.license !== "MIT" ||
      manifest.repository?.url !== "git+https://github.com/DACS-Agent-commerce/dacs-sdk.git" ||
      manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
    throw new Error(`${name}: release identity or publish policy is invalid`);
  }
}
