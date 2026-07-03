/**
 * forum.ts — Forum (Reddit-style communities) helpers, per NIP-CHAT §20.
 *
 * Two community types share kind 1111 (NIP-22) for posts + comments:
 *   - Word community (decentralized): top-level post carries ["t", "<word>"];
 *     no creator, no central moderation. Handle: w/<word>.
 *   - Created community (NIP-72, planned): posts carry ["A"/"a","34550:…"].
 *
 * Comments use NIP-22 threading: uppercase E/K/P = thread root (the top-level
 * post), lowercase e/k/p = immediate parent. Top-level posts carry NO parent
 * `e` tag, so `{kinds:[1111], "#t":[word]}` returns only top-level posts.
 *
 * Reactions are kind 7 (NIP-25), classified into positive/negative buckets so
 * up/down sorting aggregates reactions from any client.
 */

import type { Event, UnsignedEvent } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { createUnsignedEvent, withClientTag } from '@/lib/nostr/events'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import { KINDS } from '@/lib/crypto/constants'

type Tag = [string, ...string[]]

/** NIP-72 community definition kind. */
export const COMMUNITY_KIND = 34550
/** NIP-72 post-approval kind. */
export const COMMUNITY_APPROVAL_KIND = 4550

// ─── Reaction sentiment buckets (ported from DEG Mods social.ts) ───

export type ReactionBucket = 'positive' | 'negative'

/**
 * Explicitly-negative reaction contents. Everything else — including `+`, empty
 * (NIP-25 "like"), and unknown emoji — is treated as positive, so reactions from
 * other clients still aggregate into the two up/down buckets.
 */
const NEGATIVE_REACTIONS = new Set([
  '-', '👎', '💩', '💀', '☠️', '☠', '🤮', '🤢', '🤡', '😡', '😠', '🤬', '😤',
  '😒', '🙄', '😞', '😔', '😟', '😕', '🙁', '☹️', '☹', '😣', '😖', '😫', '😩',
  '😢', '😭', '💔', '🥴', '😬', '🖕',
])

/** Classify a reaction `content` string into a positive or negative bucket. */
export function classifyReaction(content: string): ReactionBucket {
  return NEGATIVE_REACTIONS.has(content.trim()) ? 'negative' : 'positive'
}

/**
 * The id a kind-7 reaction targets. Per NIP-25 the target is the LAST `e` tag
 * (earlier `e` tags may reference the thread root), so a reaction on a comment
 * that also tags the root post is correctly credited to the comment.
 */
export function reactionTargetId(event: Event): string | undefined {
  let last: string | undefined
  for (const t of event.tags) if (t[0] === 'e' && t[1]) last = t[1]
  return last
}

/** Normalize a word-community handle (lowercase, trimmed, no leading w/). */
export function normalizeWord(word: string): string {
  return word.trim().replace(/^w\//i, '').toLowerCase()
}

// ─── Event creators (word communities) ───

/** Build the category (`c`, single) + user-tag (`t`, ≤10) tags from composer input. */
function classifierTags(opts?: { category?: string; tags?: string[] }): Tag[] {
  const out: Tag[] = []
  const cat = opts?.category?.trim().toLowerCase()
  if (cat) out.push(['c', cat])
  const seen = new Set<string>()
  for (const raw of opts?.tags || []) {
    const t = raw.trim().toLowerCase()
    if (t && !seen.has(t) && seen.size < 10) { seen.add(t); out.push(['t', t]) }
  }
  return out
}

/** Create a top-level word-community post (kind 1111 + `w` word + `subject` + optional `c`/`t`). */
export function createForumWordPost(
  word: string,
  title: string,
  body: string,
  opts?: { nsfw?: boolean; category?: string; tags?: string[] },
): UnsignedEvent {
  const tags: Tag[] = [
    ['w', normalizeWord(word)],
    ['subject', title.trim()],
    ...classifierTags(opts),
  ]
  if (opts?.nsfw) tags.push(['content-warning', 'nsfw'])
  return createUnsignedEvent(KINDS.FORUM_POST, body, withClientTag(tags))
}

/**
 * Create a comment (kind 1111, NIP-22). `root` is the top-level post; `parent`
 * is the immediate parent (the post itself for a direct comment, or another
 * comment for a nested reply).
 */
export function createForumComment(opts: {
  root: { id: string; pubkey: string; kind?: number }
  parent: { id: string; pubkey: string; kind?: number }
  body: string
}): UnsignedEvent {
  const { root, parent, body } = opts
  const tags: Tag[] = [
    ['E', root.id], ['K', String(root.kind ?? KINDS.FORUM_POST)], ['P', root.pubkey],
    ['e', parent.id], ['k', String(parent.kind ?? KINDS.FORUM_POST)], ['p', parent.pubkey],
  ]
  return createUnsignedEvent(KINDS.FORUM_POST, body, withClientTag(tags))
}

/** Create a reaction (kind 7, NIP-25) on a forum post or comment. */
export function createForumReaction(
  targetId: string,
  targetAuthor: string,
  content: string,
): UnsignedEvent {
  return createUnsignedEvent(7, content, withClientTag([
    ['e', targetId],
    ['p', targetAuthor],
    ['k', String(KINDS.FORUM_POST)],
  ]))
}

/** Replaceable list (kind 10044) of the user's followed word communities. */
export function createForumWordList(words: string[]): UnsignedEvent {
  const seen = new Set<string>()
  const tags: Tag[] = []
  for (const w of words) {
    const norm = normalizeWord(w)
    if (norm && !seen.has(norm)) { seen.add(norm); tags.push(['t', norm]) }
  }
  return createUnsignedEvent(KINDS.FORUM_WORD_LIST, '', tags)
}

/** Parse a kind-10044 list event into the followed word array. */
export function parseForumWordList(event: Event): string[] {
  return event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase())
}

// ─── Word community profiles (decentralized, no owner) ───

/**
 * Addressable "topic profile" for a word community. Anyone may publish their take
 * (keyed by `d = <word>`); clients render the version from the most-trusted author.
 * Addressable (30000-39999) so one author can profile many words — a plain
 * replaceable kind (10000-19999) would allow only one profile per author.
 */
export const WORD_PROFILE_KIND = 30044

export interface WordProfile {
  word: string
  pubkey: string         // who published this take
  picture?: string
  banner?: string
  description?: string
  /** If set, this event delegates appearance to another author's 30044 for the word. */
  delegate?: string
  createdAt: number
}

/** Addressable coordinate for a word profile: `30044:<pubkey>:<word>`. */
export function wordProfileAddress(pubkey: string, word: string): string {
  return `${WORD_PROFILE_KIND}:${pubkey}:${normalizeWord(word)}`
}

/** Build a self-authored appearance (picture/banner/description). */
export function createWordProfile(word: string, p: { picture?: string; banner?: string; description?: string }): UnsignedEvent {
  const tags: Tag[] = [['d', normalizeWord(word)]]
  if (p.picture) tags.push(['picture', p.picture.trim()])
  if (p.banner) tags.push(['banner', p.banner.trim()])
  if (p.description) tags.push(['description', p.description.trim()])
  return createUnsignedEvent(WORD_PROFILE_KIND, '', tags)
}

/** Build a delegation: "use <delegate>'s appearance for this word". */
export function createWordDelegation(word: string, delegate: string): UnsignedEvent {
  return createUnsignedEvent(WORD_PROFILE_KIND, '', [
    ['d', normalizeWord(word)],
    ['a', wordProfileAddress(delegate, word)],
  ])
}

export function parseWordProfile(event: Event): WordProfile | null {
  if (event.kind !== WORD_PROFILE_KIND) return null
  const word = event.tags.find((t) => t[0] === 'd')?.[1]
  if (!word) return null
  const aRef = event.tags.find((t) => t[0] === 'a' && t[1]?.startsWith(`${WORD_PROFILE_KIND}:`))?.[1]
  const delegate = aRef ? aRef.split(':')[1] : undefined
  return {
    word: word.toLowerCase(),
    pubkey: event.pubkey,
    picture: event.tags.find((t) => t[0] === 'picture')?.[1],
    banner: event.tags.find((t) => t[0] === 'banner')?.[1],
    description: event.tags.find((t) => t[0] === 'description')?.[1],
    delegate,
    createdAt: event.created_at,
  }
}

/** True when a profile carries some renderable appearance. */
export function hasWordProfileContent(p: WordProfile | null | undefined): boolean {
  return !!(p && (p.picture || p.banner || p.description))
}

export function wordProfileFilter(word: string, limit = 100) {
  return { kinds: [WORD_PROFILE_KIND], '#d': [normalizeWord(word)], limit }
}

export function wordProfileByAuthorsFilter(word: string, authors: string[]) {
  return { kinds: [WORD_PROFILE_KIND], authors, '#d': [normalizeWord(word)] }
}

// ─── Fetch filter builders ───

/** Filter for the top-level posts of a word community. */
export function wordPostsFilter(word: string, limit = 50) {
  return { kinds: [KINDS.FORUM_POST], '#w': [normalizeWord(word)], limit }
}

/** Filter for the full comment tree of a post (rooted on it via uppercase E). */
export function postCommentsFilter(postId: string, limit = 500) {
  return { kinds: [KINDS.FORUM_POST], '#E': [postId], limit }
}

/** Filter for reactions on a post or comment. */
export function reactionsFilter(eventId: string, limit = 500) {
  return { kinds: [7], '#e': [eventId], limit }
}

// ─── Parsing ───

export interface ForumPost {
  id: string
  pubkey: string
  title: string
  body: string
  /** Word community handle (the lowercase `w` tag) — set for word posts. */
  word?: string
  /** Created-community address `34550:pubkey:dtag` — set for NIP-72 posts. */
  community?: string
  /** Single category (first `c` tag). */
  category?: string
  /** User tags (`t` tags, ≤10). */
  tags: string[]
  createdAt: number
  pow: number
  nsfw?: boolean
  /** The raw signed event — for the post menu (copy address / view raw). */
  raw: Event
}

export interface ForumComment {
  id: string
  pubkey: string
  body: string
  createdAt: number
  rootId: string        // uppercase E (top-level post)
  parentId: string      // lowercase e (immediate parent)
  pow: number
  /** The raw signed event — for the comment menu (copy address / view raw). */
  raw: Event
}

const hasParent = (event: Event) => event.tags.some((t) => t[0] === 'e')

/** Extract the category (`c`, first) + user tags (`t`, ≤10) from a post event. */
function parseClassifiers(event: Event): { category?: string; tags: string[] } {
  return {
    category: event.tags.find((t) => t[0] === 'c' && t[1])?.[1],
    tags: event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1]).slice(0, 10),
  }
}

/**
 * Parse a kind-1111 event as a top-level word-community post. Returns null if it
 * isn't one (missing `t`/`subject`, or it has a parent `e` tag → it's a comment).
 */
export function parseForumWordPost(event: Event): ForumPost | null {
  if (event.kind !== KINDS.FORUM_POST) return null
  if (hasParent(event)) return null // it's a comment, not a top-level post
  const word = event.tags.find((t) => t[0] === 'w')?.[1]
  const title = event.tags.find((t) => t[0] === 'subject')?.[1]
  if (!word || !title) return null
  return {
    id: event.id,
    pubkey: event.pubkey,
    title,
    body: event.content,
    word: word.toLowerCase(),
    ...parseClassifiers(event),
    createdAt: event.created_at,
    pow: countLeadingZeroBits(event.id),
    nsfw: event.tags.some((t) => t[0] === 'content-warning'),
    raw: event,
  }
}

/** Parse a kind-1111 event as a comment (must have a parent `e` tag). */
export function parseForumComment(event: Event): ForumComment | null {
  if (event.kind !== KINDS.FORUM_POST) return null
  const parentId = event.tags.find((t) => t[0] === 'e')?.[1]
  if (!parentId) return null
  const rootId = event.tags.find((t) => t[0] === 'E')?.[1] || parentId
  return {
    id: event.id,
    pubkey: event.pubkey,
    body: event.content,
    createdAt: event.created_at,
    rootId,
    parentId,
    pow: countLeadingZeroBits(event.id),
    raw: event,
  }
}

// ─── NIP-72 created ("centralized") communities ───

/** Build the addressable community coordinate `34550:<pubkey>:<dTag>`. */
export function communityAddress(pubkey: string, dTag: string): string {
  return `${COMMUNITY_KIND}:${pubkey}:${dTag}`
}

/** Parse a `34550:<pubkey>:<dTag>` coordinate. */
export function parseCommunityAddress(address: string): { pubkey: string; dTag: string } | null {
  const parts = address.split(':')
  if (parts.length < 3 || parts[0] !== String(COMMUNITY_KIND)) return null
  return { pubkey: parts[1], dTag: parts.slice(2).join(':') }
}

/** Encode a community as a shareable naddr (NIP-19). */
export function encodeCommunityNaddr(pubkey: string, dTag: string, relays: string[] = []): string {
  return nip19.naddrEncode({ identifier: dTag, pubkey, kind: COMMUNITY_KIND, relays })
}

/** Decode an naddr into a community coordinate, or null if it isn't a 34550 naddr. */
export function decodeCommunityNaddr(naddr: string): { pubkey: string; dTag: string; relays: string[] } | null {
  try {
    const decoded = nip19.decode(naddr.trim().replace(/^c\//i, ''))
    if (decoded.type !== 'naddr') return null
    const d = decoded.data
    if (d.kind !== COMMUNITY_KIND) return null
    return { pubkey: d.pubkey, dTag: d.identifier, relays: d.relays || [] }
  } catch {
    return null
  }
}

export interface CommunityDef {
  address: string        // 34550:pubkey:dTag
  pubkey: string         // creator
  dTag: string
  name: string
  description: string
  image?: string         // icon
  banner?: string        // wide banner image
  nsfw: boolean          // content-warning on the community
  moderators: string[]   // pubkeys (creator is always an implicit moderator)
  relays: string[]
  createdAt: number
}

/** Create a NIP-72 community definition (kind 34550, addressable by d-tag). */
export function createCommunityDefinition(opts: {
  dTag: string
  name?: string
  description?: string
  image?: string
  banner?: string
  nsfw?: boolean
  moderators?: string[]
  relays?: string[]
}): UnsignedEvent {
  const tags: Tag[] = [['d', opts.dTag]]
  if (opts.name) tags.push(['name', opts.name.trim()])
  if (opts.description) tags.push(['description', opts.description.trim()])
  if (opts.image) tags.push(['image', opts.image.trim()])
  if (opts.banner) tags.push(['banner', opts.banner.trim()])
  if (opts.nsfw) tags.push(['content-warning', 'nsfw'])
  for (const m of opts.moderators || []) tags.push(['p', m, '', 'moderator'])
  for (const r of opts.relays || []) tags.push(['relay', r])
  return createUnsignedEvent(COMMUNITY_KIND, '', tags)
}

/** Parse a kind-34550 community definition. */
export function parseCommunityDefinition(event: Event): CommunityDef | null {
  if (event.kind !== COMMUNITY_KIND) return null
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  if (!dTag) return null
  const moderators = event.tags
    .filter((t) => t[0] === 'p' && (t[3] === 'moderator' || !t[3]))
    .map((t) => t[1])
  // The creator is always an implicit moderator.
  if (!moderators.includes(event.pubkey)) moderators.unshift(event.pubkey)
  return {
    address: communityAddress(event.pubkey, dTag),
    pubkey: event.pubkey,
    dTag,
    name: event.tags.find((t) => t[0] === 'name')?.[1] || dTag,
    description: event.tags.find((t) => t[0] === 'description')?.[1] || '',
    image: event.tags.find((t) => t[0] === 'image')?.[1],
    banner: event.tags.find((t) => t[0] === 'banner')?.[1],
    nsfw: event.tags.some((t) => t[0] === 'content-warning'),
    moderators,
    relays: event.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]),
    createdAt: event.created_at,
  }
}

/**
 * Create a top-level post inside a created community (kind 1111, NIP-22). The
 * community itself is the addressable root (uppercase A / a), so the post has no
 * parent `e` tag — `{kinds:[1111], "#a":[address]}` returns only top-level posts.
 */
export function createCommunityPost(
  community: { address: string; pubkey: string },
  title: string,
  body: string,
  opts?: { nsfw?: boolean; category?: string; tags?: string[] },
): UnsignedEvent {
  const tags: Tag[] = [
    ['A', community.address], ['K', String(COMMUNITY_KIND)], ['P', community.pubkey],
    ['a', community.address], ['k', String(COMMUNITY_KIND)], ['p', community.pubkey],
    ['subject', title.trim()],
    ...classifierTags(opts),
  ]
  if (opts?.nsfw) tags.push(['content-warning', 'nsfw'])
  return createUnsignedEvent(KINDS.FORUM_POST, body, withClientTag(tags))
}

/** Parse a kind-1111 event as a top-level created-community post. */
export function parseCommunityPost(event: Event): ForumPost | null {
  if (event.kind !== KINDS.FORUM_POST) return null
  if (hasParent(event)) return null // has a parent `e` → it's a comment
  const address = event.tags.find((t) => (t[0] === 'a' || t[0] === 'A') && t[1]?.startsWith(`${COMMUNITY_KIND}:`))?.[1]
  const title = event.tags.find((t) => t[0] === 'subject')?.[1]
  if (!address || !title) return null
  return {
    id: event.id,
    pubkey: event.pubkey,
    title,
    body: event.content,
    community: address,
    ...parseClassifiers(event),
    createdAt: event.created_at,
    pow: countLeadingZeroBits(event.id),
    nsfw: event.tags.some((t) => t[0] === 'content-warning'),
    raw: event,
  }
}

export interface CommunityApproval {
  address: string
  postId: string
  moderator: string
}

/** Create a NIP-72 approval (kind 4550) re-publishing an approved post. */
export function createCommunityApproval(address: string, approved: Event): UnsignedEvent {
  return createUnsignedEvent(COMMUNITY_APPROVAL_KIND, JSON.stringify(approved), [
    ['a', address],
    ['e', approved.id],
    ['p', approved.pubkey],
    ['k', String(approved.kind)],
  ])
}

/** Parse a kind-4550 approval. */
export function parseApproval(event: Event): CommunityApproval | null {
  if (event.kind !== COMMUNITY_APPROVAL_KIND) return null
  const address = event.tags.find((t) => t[0] === 'a')?.[1]
  const postId = event.tags.find((t) => t[0] === 'e')?.[1]
  if (!address || !postId) return null
  return { address, postId, moderator: event.pubkey }
}

/** Filter for a community definition by coordinate. */
export function communityDefFilter(pubkey: string, dTag: string) {
  return { kinds: [COMMUNITY_KIND], authors: [pubkey], '#d': [dTag], limit: 1 }
}

/** Filter for the top-level posts of a created community. */
export function communityPostsFilter(address: string, limit = 100) {
  return { kinds: [KINDS.FORUM_POST], '#a': [address], limit }
}

/** Filter for the approvals issued in a created community. */
export function communityApprovalsFilter(address: string, limit = 500) {
  return { kinds: [COMMUNITY_APPROVAL_KIND], '#a': [address], limit }
}

/** Filter to discover recently-defined communities. */
export function communityDiscoveryFilter(limit = 100) {
  return { kinds: [COMMUNITY_KIND], limit }
}

/** NIP-51 "communities" list kind — the user's joined created-communities. */
export const COMMUNITIES_LIST_KIND = 10004

/** Replaceable list (kind 10004) of the user's joined created communities. */
export function createCommunityListEvent(addresses: string[]): UnsignedEvent {
  const seen = new Set<string>()
  const tags: Tag[] = []
  for (const a of addresses) {
    if (a && a.startsWith(`${COMMUNITY_KIND}:`) && !seen.has(a)) { seen.add(a); tags.push(['a', a]) }
  }
  return createUnsignedEvent(COMMUNITIES_LIST_KIND, '', tags)
}

/** Parse a kind-10004 list into community addresses. */
export function parseCommunityList(event: Event): string[] {
  return event.tags.filter((t) => t[0] === 'a' && t[1]?.startsWith(`${COMMUNITY_KIND}:`)).map((t) => t[1])
}

// ─── Reaction sentiment (for Top / Hot sorting) ───

export interface ReactionSentiment {
  positive: number
  negative: number
  /** The current user's active reaction bucket on this target, if any. */
  mine?: ReactionBucket
  /** The event id of the current user's active reaction (for delete-then-react). */
  mineId?: string
}

/**
 * Reduce reaction events for one target into positive/negative counts (one
 * reaction per author, latest wins).
 */
export function summarizeSentiment(
  reactions: Event[],
  myPubkey?: string | null,
): ReactionSentiment {
  const latestByAuthor = new Map<string, Event>()
  for (const ev of reactions) {
    const prev = latestByAuthor.get(ev.pubkey)
    if (!prev || ev.created_at > prev.created_at) latestByAuthor.set(ev.pubkey, ev)
  }
  let positive = 0
  let negative = 0
  let mine: ReactionBucket | undefined
  let mineId: string | undefined
  for (const ev of latestByAuthor.values()) {
    const bucket = classifyReaction(ev.content)
    if (bucket === 'negative') negative++
    else positive++
    if (myPubkey && ev.pubkey === myPubkey) { mine = bucket; mineId = ev.id }
  }
  return { positive, negative, mine, mineId }
}

/** Sort modes for a forum feed (NIP-CHAT §20.3). */
export type ForumSort = 'new' | 'top' | 'hot'

/**
 * Best-effort reorder of already-fetched posts by sort mode.
 * - new: newest first
 * - top: highest (positive − negative)
 * - hot: highest total reactions (positive + negative)
 */
export function sortPosts(
  posts: ForumPost[],
  sort: ForumSort,
  sentimentOf: (postId: string) => ReactionSentiment | undefined,
): ForumPost[] {
  const arr = [...posts]
  if (sort === 'new') {
    arr.sort((a, b) => b.createdAt - a.createdAt)
  } else {
    arr.sort((a, b) => {
      const sa = sentimentOf(a.id) ?? { positive: 0, negative: 0 }
      const sb = sentimentOf(b.id) ?? { positive: 0, negative: 0 }
      const score = (s: ReactionSentiment) => (sort === 'top' ? s.positive - s.negative : s.positive + s.negative)
      const diff = score(sb) - score(sa)
      return diff !== 0 ? diff : b.createdAt - a.createdAt // tiebreak: newest
    })
  }
  return arr
}
