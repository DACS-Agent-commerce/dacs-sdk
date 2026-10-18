// Host-provided deployment identity must be independently verified before any
// native write. A source commit alone never identifies a deployed binary.
export async function assertQualifiedDeployment(source) {
  const pin=source?.pins?.deployment;
  if(!pin || pin.dirty!==false || !/^[a-f0-9]{40}$/.test(pin.commit??'')
    || !/^[a-f0-9]{64}$/.test(pin.artifactSha256??'')
    || !['fee','nonce','broadcast','confirmation'].every(key=>pin.qualifiedOperations?.includes(key))
    || typeof source.verifyDeployment!=='function' || await source.verifyDeployment(structuredClone(pin))!==true) {
    throw Object.assign(new Error('native writes require a verified clean deployment artifact and qualified write profile'),{code:'deployment_unqualified'});
  }
}
