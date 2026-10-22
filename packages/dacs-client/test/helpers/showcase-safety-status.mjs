// Showcase vocabulary only; retain the raw reader result alongside it.
export const evidenceStatus=(observation)=>observation.status==='unavailable'?'unknown':observation.status;
