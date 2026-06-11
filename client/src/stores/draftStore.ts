/**
 * draftStore — Persists unsent message drafts across navigation.
 *
 * Stores draft text (and multi-field forum data) keyed by context so that
 * switching channels / conversations / topics preserves the user's input.
 *
 * Persistence: localStorage only (no cross-device sync).
 *
 * Key format:
 *   hub:<hubDTag>:<channelId>            — hub channel chat
 *   hub-thread:<hubDTag>:<channelId>:<rootRef>  — thread replies
 *   forum:<hubDTag>:<channelId>          — forum post creation
 *   dm04:<recipientPubkey>               — NIP-04 DMs
 *   dm17:<recipientPubkey>               — NIP-17 DMs
 *   pc:<topic>                           — public chat
 */

const STORAGE_KEY_PREFIX = 'den-chat-drafts'
const MAX_DRAFTS = 200 // Prevent unbounded growth

export interface ForumDraft {
  title: string
  body: string
  tags: string[]
  tagInput: string
  featuredImage: string
  isNsfw: boolean
}

type DraftValue = string | ForumDraft

// ── Per-account scoping ──

let _activePubkey = ''

function _storageKey(): string {
  return _activePubkey ? `${STORAGE_KEY_PREFIX}:${_activePubkey}` : STORAGE_KEY_PREFIX
}

/** Switch the active user for draft storage. Call on login/logout. */
export function setDraftUser(pubkey: string) {
  if (_activePubkey === pubkey) return
  _activePubkey = pubkey
  _cache = null // invalidate so next access reads from the correct localStorage bucket
}

// ── In-memory cache (single source of truth, lazily hydrated from localStorage) ──

let _cache: Record<string, DraftValue> | null = null

function _load(): Record<string, DraftValue> {
  if (_cache) return _cache
  try {
    const raw = localStorage.getItem(_storageKey())
    _cache = raw ? JSON.parse(raw) : {}
  } catch {
    _cache = {}
  }
  return _cache!
}

function _persist() {
  try {
    localStorage.setItem(_storageKey(), JSON.stringify(_cache ?? {}))
  } catch {
    // Storage full — silently drop; drafts are best-effort
  }
}

// ── Public API ──

/** Get a text draft for a given key. Returns '' if none. */
export function getDraft(key: string): string {
  const val = _load()[key]
  return typeof val === 'string' ? val : ''
}

/** Get a forum draft for a given key. Returns null if none. */
export function getForumDraft(key: string): ForumDraft | null {
  const val = _load()[key]
  if (val && typeof val === 'object' && 'title' in val) return val as ForumDraft
  return null
}

/** Set a text draft. Pass '' to clear it. */
export function setDraft(key: string, value: string) {
  const store = _load()
  if (!value) {
    delete store[key]
  } else {
    store[key] = value
  }
  _evictIfNeeded(store)
  _persist()
}

/** Set a forum draft. Pass null to clear it. */
export function setForumDraft(key: string, value: ForumDraft | null) {
  const store = _load()
  if (!value || (!value.title && !value.body && value.tags.length === 0 && !value.tagInput && !value.featuredImage)) {
    delete store[key]
  } else {
    store[key] = value
  }
  _evictIfNeeded(store)
  _persist()
}

/** Clear a draft by key. */
export function clearDraft(key: string) {
  const store = _load()
  delete store[key]
  _persist()
}

// ── Key builders ──

export function hubDraftKey(hubDTag: string, channelId: string): string {
  return `hub:${hubDTag}:${channelId}`
}

export function hubThreadDraftKey(hubDTag: string, channelId: string, rootRef: string): string {
  return `hub-thread:${hubDTag}:${channelId}:${rootRef}`
}

export function forumDraftKey(hubDTag: string, channelId: string): string {
  return `forum:${hubDTag}:${channelId}`
}

export function dm04DraftKey(recipientPubkey: string): string {
  return `dm04:${recipientPubkey}`
}

export function dm17DraftKey(recipientPubkey: string): string {
  return `dm17:${recipientPubkey}`
}

export function pcDraftKey(topic: string): string {
  return `pc:${topic}`
}

// ── Eviction ──

function _evictIfNeeded(store: Record<string, DraftValue>) {
  const keys = Object.keys(store)
  if (keys.length <= MAX_DRAFTS) return
  // Remove oldest entries (earliest keys in insertion order)
  const toRemove = keys.length - MAX_DRAFTS
  for (let i = 0; i < toRemove; i++) {
    delete store[keys[i]]
  }
}
