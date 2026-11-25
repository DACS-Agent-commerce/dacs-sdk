// Fixed bounds for one read-only Listing lookup. Each byte cap is half the
// default of the reader it narrows, so a reply between the two is refused only
// because the read-only verifier passes its own cap.

/** Most Directory and chain requests one lookup may start: five pages, the detail, two genesis reads and the Listing. */
export const LISTING_MAX_FETCHES = 9;
/** Deadline for a whole lookup, in milliseconds, whatever each request does with its own signal. */
export const LISTING_CALL_TIMEOUT_MS = 15_000;
/** Deadline for each Directory request, in milliseconds. */
export const LISTING_DIRECTORY_TIMEOUT_MS = 2_000;
/** Deadline for each chain request, in milliseconds. */
export const LISTING_CHAIN_TIMEOUT_MS = 2_000;
/** Largest Directory listings page, in bytes after decompression (reader default 1,000,000). */
export const LISTING_DIRECTORY_PAGE_MAX_BYTES = 500_000;
/** Largest Directory Listing detail, in bytes (reader default 65,536). */
export const LISTING_DIRECTORY_DETAIL_MAX_BYTES = 32_768;
/** Largest genesis block reply, in bytes (reader default 4,194,304). */
export const LISTING_CHAIN_IDENTITY_MAX_BYTES = 2_097_152;
/** Largest storage-program reply, for the Listing and its revocation marker, in bytes (reader default 262,144). */
export const LISTING_STORAGE_MAX_BYTES = 131_072;
