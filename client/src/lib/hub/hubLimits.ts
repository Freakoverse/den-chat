/**
 * Hub Event Validation Limits
 *
 * Enforces size constraints on hub events (Kind 36942) to prevent
 * events from exceeding relay size limits (~128KB).
 *
 * Used by UI components (char counters, disabled add buttons) and
 * as a defense-in-depth guard in buildHubEvent().
 */

// ── String Limits ──────────────────────────────────────────────────
export const HUB_NAME_MAX = 100
export const HUB_DESCRIPTION_MAX = 1024
export const CHANNEL_NAME_MAX = 100
export const CHANNEL_DESCRIPTION_MAX = 256
export const CATEGORY_NAME_MAX = 100
export const ROLE_NAME_MAX = 100
export const TOPIC_TAG_MAX = 32

// ── Array Limits ───────────────────────────────────────────────────
export const MAX_CHANNELS = 100
export const MAX_CATEGORIES = 25
export const MAX_ROLES = 50
export const MAX_TOPIC_TAGS = 10
export const MAX_GENERAL_RELAYS = 10
export const MAX_BLOSSOM_SERVERS = 10
