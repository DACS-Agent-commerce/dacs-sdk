// Host-provided deployment identity must be independently verified before any
// native write. A source commit alone never identifies a deployed binary.
// The pinned node has no signatureDomain fork. The wallet journal verifies
// Ed25519 over the raw transaction hash; a domain-separated signing upgrade
// needs a new journal verifier and deployment qualification before use.
export const QUALIFIED_NODE_COMMITS = Object.freeze(['61b8e75aa8db5e408c49e1c3a89db4d673f45578']);
export async function assertQualifiedDeployment(source) {
  const pin=source?.pins?.deployment;
  if(!pin || pin.dirty!==false || !QUALIFIED_NODE_COMMITS.includes(pin.commit)
    || !/^[a-f0-9]{64}$/.test(pin.artifactSha256??'')
    || !['fee','nonce','broadcast','confirmation'].every(key=>pin.qualifiedOperations?.includes(key))
    || typeof source.verifyDeployment!=='function' || await source.verifyDeployment(structuredClone(pin))!==true) {
    throw Object.assign(new Error('native writes require a verified clean deployment artifact and qualified write profile'),{code:'deployment_unqualified'});
  }
}
