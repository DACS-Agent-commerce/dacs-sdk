// Apply the same bounded issuance policy to memory and authenticated storage.
// Admitted presentations stay retained; expired, never-admitted entries are pruned.
const RETAINED_CHALLENGES_PER_SLOT=16;
export function admitSessionChallenge(entries,value,{maxOutstanding,maxPerJob},remove){
  if(![maxOutstanding,maxPerJob].every(limit=>Number.isSafeInteger(limit)&&limit>0))throw new TypeError('challenge limits must be positive safe integers');
  let total=0,active=0,job=0;
  const maxRetained=Math.min(Number.MAX_SAFE_INTEGER,maxOutstanding*RETAINED_CHALLENGES_PER_SLOT);
  for(const [id,row] of entries){
    if(row.kind!=='session-challenge')throw Object.assign(new Error('retained challenge is malformed'),{code:'seller_state_corrupt'});
    if(row.attempt?.admitted!==true&&Number.isSafeInteger(row.expiresAt)&&row.expiresAt<=value.issuedAt){remove(id);continue;}
    total++;if(row.attempt?.retired!==true)active++;if(row.jobId===value.jobId)job++;
  }
  if(active>=maxOutstanding||total>=maxRetained||job>=maxPerJob)throw Object.assign(new Error('the seller has reached retained challenge capacity'),{code:'seller_challenge_capacity'});
}
