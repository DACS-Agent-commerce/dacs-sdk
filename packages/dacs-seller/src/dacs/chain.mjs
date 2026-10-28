// Run-time port of http-mcp/src/dacs/chain.mjs at DACS-Agent-commerce/frontend 15fdf23: lines
// 22, 24-31.
// Left out: the chain reader and node parsers; only the OS and DEM amount patterns.
const DEM_DECIMALS = 9;
// The most digits an exact OS amount read from the node may have (enough for
// 2^256 - 1). Listing prices (listing.mjs normalizeDemAmount) and the model
// copy (seller-content.mjs) are bounded by these same two rules.
export const OS_DIGITS_MAX = 78;
// A canonical OS integer of at most OS_DIGITS_MAX digits.
export const OS_INTEGER = new RegExp(`^(?:0|[1-9][0-9]{0,${OS_DIGITS_MAX - 1}})$`);
// A canonical DEM decimal whose exact OS amount fits OS_DIGITS_MAX digits.
export const DEM_DECIMAL = new RegExp(`^(0|[1-9][0-9]{0,${OS_DIGITS_MAX - DEM_DECIMALS - 1}})(?:\\.([0-9]{1,${DEM_DECIMALS}}))?$`);
