// Apply the same bounded issuance policy to memory and authenticated storage.
// CORE SN-4 requires every issued, attempted and consumed challenge record to be
// retained until its bound session reaches a terminal state, and expiry only
// makes a later presentation invalid. Retained records are therefore never
// deleted here: they are tombstones (consumed, or expired before any attempt)
// and do not occupy live issuance capacity. Only a challenge still open for a
// presentation - never attempted and not yet expired - counts as live.
export function admitSessionChallenge(entries,value,{maxOutstanding,maxPerJob}){
  if(![maxOutstanding,maxPerJob].every(limit=>Number.isSafeInteger(limit)&&limit>0))throw new TypeError('challenge limits must be positive safe integers');
  let total=0,job=0;
  for(const [id,row] of entries){
    if(row.kind!=='session-challenge')throw Object.assign(new Error('retained challenge is malformed'),{code:'seller_state_corrupt'});
    // A retained issuance whose lifetime or attempt is unreadable is corruption,
    // not a tombstone: treating it as expired would free live issuance capacity.
    if(!Number.isSafeInteger(row.expiresAt)||row.expiresAt<0)throw Object.assign(new Error('the retained challenge lifetime is malformed'),{code:'seller_state_corrupt'});
    if(row.attempt!==null&&(typeof row.attempt!=='object'||Array.isArray(row.attempt)))throw Object.assign(new Error('the retained challenge attempt is malformed'),{code:'seller_state_corrupt'});
    if(row.attempt!==null||row.expiresAt<=value.issuedAt)continue;
    total++;if(row.jobId===value.jobId)job++;
  }
  if(total>=maxOutstanding||job>=maxPerJob)throw Object.assign(new Error('the seller has reached live challenge capacity'),{code:'seller_challenge_capacity'});
}
