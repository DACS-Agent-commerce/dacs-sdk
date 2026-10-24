// Apply the same bounded issuance policy to memory and authenticated storage.
// Attempted nonces stay retained; only expired, unattempted entries are pruned.
export function admitSessionChallenge(entries,value,{maxOutstanding,maxPerJob},remove){
  if(![maxOutstanding,maxPerJob].every(limit=>Number.isSafeInteger(limit)&&limit>0))throw new TypeError('challenge limits must be positive safe integers');
  let total=0,job=0;
  for(const [id,row] of entries){
    if(row.kind!=='session-challenge')throw Object.assign(new Error('retained challenge is malformed'),{code:'seller_state_corrupt'});
    if(row.attempt===null&&Number.isSafeInteger(row.expiresAt)&&row.expiresAt<=value.issuedAt){remove(id);continue;}
    total++;if(row.jobId===value.jobId)job++;
  }
  if(total>=maxOutstanding||job>=maxPerJob)throw Object.assign(new Error('the seller has reached retained challenge capacity'),{code:'seller_challenge_capacity'});
}
