/**
 * NIP-CHAT Cryptographic Constants
 * These MUST NOT change between implementations.
 */

/** Domain salt for HKDF key derivation — isolates NIP-CHAT keys from all other protocols */
export const DOMAIN_SALT = '14bf723f-5c4d-4898-9e57-a6aee6e2c8fa-v1'


/** NIP-CHAT event kinds */
export const KINDS = {
  HUB_EVENT: 36942,
  MESSAGE: 36943,
  MESSAGE_EDIT_HINT: 26943,
  JOIN_REQUEST: 36944,
  PIN_LIST: 36945,
  VOICE_HOST: 36946,
  VOICE_PRESENCE: 36947,
  REPORT: 36948,
  HIDE_MESSAGE: 36949,
  USER_HUB_LIST: 16942,
  POLL: 1067,
  POLL_VOTE: 1017,
  CALENDAR_TIME_EVENT: 31923,
  CALENDAR_RSVP: 31925,
  PUBLIC_CHAT: 1312,
} as const

/** Standard Nostr event kinds used by DEN Chat */
export const STANDARD_KINDS = {
  USER_METADATA: 0,
  CONTACT_LIST: 3,
  NIP04_DM: 4,
  DELETION: 5,
  REACTION: 7,
  SEAL: 13,
  DM_RUMOR: 14,
  DM_FILE: 15,
  GIFT_WRAP: 1059,
  SEALED_SENDER: 1060,
  REPORT: 1984,
  ZAP_REQUEST: 9734,
  ZAP_RECEIPT: 9735,
  RELAY_LIST: 10002,
  DM_RELAY_LIST: 10050,
  BLOSSOM_SERVER_LIST: 10063,
  APP_DATA: 30078,
  UPV2: 24134,
  DNN_NODE: 64600,
} as const

/** Nostr derivation path for BIP-32 HD keys */
export const NOSTR_DERIVATION_BASE = "m/44'/1237'"


/** AES-GCM constants */
export const AES_IV_LENGTH = 12
export const AES_TAG_LENGTH = 16
export const AES_KEY_LENGTH = 32

/** NIP-78 Application Data d-tag identifiers for read-state events */
export const APP_DATA_DTAGS = {
  /** Social feed — Jumble-compatible (same d-tag for cross-client sync) */
  SOCIAL_SEEN_AT: 'notifications_seen_at',
  /** Hub chat — per-hub, per-channel read timestamps (encrypted content) */
  HUB_READ_STATE: 'den-hub-read-state',
  /** DMs — per-conversation read timestamps (encrypted content) */
  DM_READ_STATE: 'den-dm-read-state',
  /** Public chat — per-topic read timestamps (plaintext content) */
  PC_READ_STATE: 'den-pc-read-state',
} as const
