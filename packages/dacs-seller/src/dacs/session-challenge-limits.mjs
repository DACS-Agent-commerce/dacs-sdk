// Apply the same bounded issuance policy to memory and authenticated storage.
// Retain issued challenges as replay fences. Bound retained history separately
// from live issuance; consumed and expired rows do not occupy live capacity.
const RETAINED_CHALLENGES_PER_SLOT=16;
export function admitSessionChallenge(entries,value,{maxOutstanding,maxPerJob}){
  if(![maxOutstanding,maxPerJob].every(limit=>Number.isSafeInteger(limit)&&limit>0))throw new TypeError('challenge limits must be positive safe integers');
  let total=0,active=0,job=0;
  const maxRetained=Math.min(Number.MAX_SAFE_INTEGER,maxOutstanding*RETAINED_CHALLENGES_PER_SLOT);
  for(const [id,row] of entries){
    if(row.kind!=='session-challenge')throw Object.assign(new Error('retained challenge is malformed'),{code:'seller_state_corrupt'});
    total++;
    if(row.attempt!==null||!Number.isSafeInteger(row.expiresAt)||row.expiresAt<=value.issuedAt)continue;
    active++;if(row.jobId===value.jobId)job++;
  }
  if(active>=maxOutstanding||total>=maxRetained||job>=maxPerJob)throw Object.assign(new Error('the seller has reached retained challenge capacity'),{code:'seller_challenge_capacity'});
}
