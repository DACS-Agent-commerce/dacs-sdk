// Host-provided deployment identity must be independently verified before any
// native write. A source commit alone never identifies a deployed binary.
// Transaction signatures are checked in the signature domain the node's
// getNetworkInfo reports. Each listed node build was checked against the
// replies the SDK reads; any other build needs its own qualification first.
export const QUALIFIED_NODE_COMMITS = Object.freeze(['61b8e75aa8db5e408c49e1c3a89db4d673f45578', 'e6af8f4023fa4e77f482503dae97f1ca00834bf9']);
export async function assertQualifiedDeployment(source) {
  const pin=source?.pins?.deployment;
  if(!pin || pin.dirty!==false || !QUALIFIED_NODE_COMMITS.includes(pin.commit)
    || !/^[a-f0-9]{64}$/.test(pin.artifactSha256??'')
    || !Array.isArray(pin.qualifiedOperations)
    || !['fee','nonce','broadcast','confirmation'].every(key=>pin.qualifiedOperations?.includes(key))
    || typeof source.verifyDeployment!=='function' || await source.verifyDeployment(structuredClone(pin))!==true) {
    throw Object.assign(new Error('native writes require a verified clean deployment artifact and qualified write profile'),{code:'deployment_unqualified'});
  }
}
