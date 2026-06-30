/**
 * forumStore — Forum word communities (NIP-CHAT §20, Phase 1).
 *
 * Holds the user's followed word communities (kind 10044), and caches of
 * top-level posts per word, comments per post, and reaction sentiment per
 * target. Mirrors the public-chat model (kind-pinned fetches, client-side
 * filtering applied at render). Created (NIP-72) communities are Phase 2.
 */

import { create } from 'zustand'
import type { Event } from 'nostr-tools'
import { fetchEvents, fetchReplaceable, fetchEventById, publishEvent, assertPublished } from '@/lib/nostr/relay-pool'
import { signWithSigner, mineAndSign } from '@/lib/nostr'
import { createDeletionEvent } from '@/lib/nostr/events'
import { useUserStore } from '@/stores/userStore'
import { useFollowStore } from '@/stores/followStore'
import { KINDS } from '@/lib/crypto/constants'
import {
  createForumWordList, parseForumWordList,
  createWordProfile, createWordDelegation, parseWordProfile, hasWordProfileContent,
  wordProfileByAuthorsFilter, WORD_PROFILE_KIND, type WordProfile,
  createForumWordPost, createForumComment, createForumReaction,
  parseForumWordPost, parseForumComment, classifyReaction,
  wordPostsFilter, postCommentsFilter,
  summarizeSentiment, normalizeWord, reactionTargetId,
  createCommunityDefinition, parseCommunityDefinition, COMMUNITY_KIND,
  createCommunityPost, parseCommunityPost,
  createCommunityApproval, parseApproval,
  communityDefFilter, communityPostsFilter, communityApprovalsFilter, communityDiscoveryFilter,
  parseCommunityAddress,
  createCommunityListEvent, parseCommunityList, COMMUNITIES_LIST_KIND,
  type ForumPost, type ForumComment, type ReactionSentiment, type ForumSort, type CommunityDef,
} from '@/lib/nostr/forum'

/** App-wide default PoW difficulty (matches public chat / compose). */
const DEFAULT_POW = 15
/** Exposed so the PoW slider's "reset to default" matches the app default. */
export const FORUM_DEFAULT_POW = DEFAULT_POW
const SHOW_NSFW_KEY = 'den-forum-show-nsfw'
/**
 * Max entries in a follow/join list. Derived from the created-community worst
 * case: a kind-10004 `["a","34550:<64hex>:<dtag>"]` entry is ~110 bytes, so 400
 * entries ≈ 44KB of tags — safely inside a 64KB relay event limit. Word lists
 * (kind 10044, ~30 bytes/entry) are far smaller at the same count.
 */
export const MAX_FORUM_LIST = 400

// ── Discovery pagination (right-rail "from people you follow") ──
const DISCOVER_BATCH = 60       // follows processed per "load more"
const DISCOVER_PER_PERSON = 5   // communities credited per followed person
const DISCOVER_MAX = 100        // total distinct communities shown
let discoverCursor = 0          // module-level cursor into the follows list
const PUBLISH_POW_KEY = 'den-forum-publish-pow'
const VIEW_POW_KEY = 'den-forum-view-pow'

function loadPow(key: string): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) { const n = Number(raw); if (Number.isFinite(n) && n >= 0) return Math.min(40, Math.round(n)) }
  } catch { /* ignore */ }
  return DEFAULT_POW
}

const SHOW_MEDIA_KEY = 'den-forum-show-media'
const SHOW_EMBEDS_KEY = 'den-forum-show-embeds'
const SHOW_EMOJIS_KEY = 'den-forum-show-emojis'
const DNN_ONLY_KEY = 'den-forum-dnn-only'

function loadBool(key: string, def: boolean): boolean {
  try { const raw = localStorage.getItem(key); if (raw !== null) return raw === '1' } catch { /* ignore */ }
  return def
}

interface ForumState {
  // ── Proof of Work (spam control) ──
  /** Difficulty to mine outgoing posts/comments to. */
  publishPow: number
  setPublishPow: (n: number) => void
  /** Hide posts/comments whose id PoW is below this (render-time filter). */
  viewPow: number
  setViewPow: (n: number) => void
  /** Show NSFW (content-warning) posts in feeds (render-time filter). */
  showNsfw: boolean
  setShowNsfw: (v: boolean) => void
  // ── Content filters (per-forum; ANDed with the global render prefs) ──
  showMedia: boolean
  setShowMedia: (v: boolean) => void
  showEmbeds: boolean
  setShowEmbeds: (v: boolean) => void
  showCustomEmojis: boolean
  setShowCustomEmojis: (v: boolean) => void
  /** Only show posts/comments from authors with a verified DNN ID. */
  dnnOnly: boolean
  setDnnOnly: (v: boolean) => void

  // ── Followed word communities (kind 10044) ──
  followedWords: string[]
  followedLoaded: boolean
  loadFollowedWords: (pubkey: string) => Promise<void>
  followWord: (word: string) => Promise<void>
  unfollowWord: (word: string) => Promise<void>
  isFollowed: (word: string) => boolean

  // ── Word community profiles (kind 30044, addressable per word) ──
  wordProfiles: Record<string, WordProfile | null>      // resolved appearance to render (null = none)
  myWordProfile: Record<string, WordProfile | null>     // my own 30044 (may delegate) — for the editor
  othersWordProfiles: Record<string, WordProfile[]>     // appearances by people I follow
  fetchWordProfile: (word: string) => Promise<void>
  /** Resolve appearances for many words at once (for rail thumbnails). */
  fetchWordProfilesBatch: (words: string[]) => Promise<void>
  fetchOthersWordProfiles: (word: string) => Promise<void>
  publishWordProfile: (word: string, p: { picture?: string; banner?: string; description?: string }) => Promise<void>
  setWordDelegation: (word: string, delegate: string) => Promise<void>

  // ── Follow/join list cap feedback ──
  listFull: 'word' | 'community' | null
  clearListFull: () => void

  // ── Discovery: word communities followed by people you follow ──
  discoverWords: { word: string; count: number }[]
  discoverLoading: boolean
  discoverDone: boolean
  loadDiscoverWords: (follows: string[], reset?: boolean) => Promise<void>

  // ── Created (NIP-72) communities ──
  /** Joined communities (kind 10004) — addresses `34550:pk:d`. */
  joinedCommunities: string[]
  joinedCommunitiesLoaded: boolean
  loadJoinedCommunities: (pubkey: string) => Promise<void>
  /** Communities the user created (kind 34550 authored by them). */
  myCreatedCommunities: string[]
  myCreatedLoaded: boolean
  loadMyCreatedCommunities: (pubkey: string) => Promise<void>
  joinCommunity: (address: string) => Promise<void>
  leaveCommunity: (address: string) => Promise<void>
  isCommunityJoined: (address: string) => boolean
  /** Cached community definitions, posts, approved-id sets. */
  communitiesByAddress: Record<string, CommunityDef>
  postsByCommunity: Record<string, ForumPost[]>
  approvedByCommunity: Record<string, string[]>
  loadingCommunity: string | null
  communityDiscovery: CommunityDef[]
  communityDiscoveryLoaded: boolean
  fetchCommunity: (address: string) => Promise<CommunityDef | null>
  fetchCommunityPosts: (address: string) => Promise<void>
  fetchCommunityDiscovery: () => Promise<void>
  createCommunity: (opts: { name: string; description?: string; image?: string; banner?: string; nsfw?: boolean; moderators?: string[] }) => Promise<CommunityDef | null>
  /** Republish a community definition (creator only). `moderators` excludes the creator. */
  updateCommunity: (def: CommunityDef, changes: { name?: string; description?: string; image?: string; banner?: string; nsfw?: boolean; moderators?: string[] }) => Promise<CommunityDef | null>
  publishCommunityPost: (community: CommunityDef, title: string, body: string, opts?: { nsfw?: boolean }) => Promise<ForumPost | null>
  approvePost: (community: CommunityDef, post: ForumPost) => Promise<void>

  // ── Active view ──
  activeWord: string | null
  setActiveWord: (word: string | null) => void
  sort: ForumSort
  setSort: (s: ForumSort) => void

  // ── Caches ──
  postsByWord: Record<string, ForumPost[]>
  loadingWord: string | null
  commentsByPost: Record<string, ForumComment[]>
  commentCounts: Record<string, number>
  sentimentByTarget: Record<string, ReactionSentiment>

  // ── Fetch ──
  fetchWordPosts: (word: string) => Promise<void>
  fetchPostComments: (postId: string) => Promise<void>
  fetchCommentCounts: (postIds: string[]) => Promise<void>
  fetchSentiments: (ids: string[]) => Promise<void>
  /** Resolve a post from any cache, fetching + parsing the event if needed. */
  getPost: (id: string) => ForumPost | undefined
  fetchPostById: (id: string) => Promise<ForumPost | null>

  // ── Publish ──
  publishWordPost: (word: string, title: string, body: string, opts?: { nsfw?: boolean }) => Promise<ForumPost | null>
  publishComment: (root: { id: string; pubkey: string }, parent: { id: string; pubkey: string }, body: string) => Promise<ForumComment | null>
  react: (target: { id: string; pubkey: string }, content: string) => Promise<void>

  // ── Live ingest (real-time subscriptions) ──
  ingestPost: (event: Event) => void
  ingestComment: (event: Event) => void
  ingestReaction: (event: Event) => void
  ingestApproval: (event: Event) => void
}

/** Read current signer + key + pubkey from the user store. */
function auth() {
  const { signer, privateKey, pubkey } = useUserStore.getState()
  return { signer, privateKey, pubkey }
}

export const useForumStore = create<ForumState>((set, get) => ({
  publishPow: loadPow(PUBLISH_POW_KEY),
  setPublishPow: (n) => {
    const v = Math.max(0, Math.min(40, Math.round(n)))
    try { localStorage.setItem(PUBLISH_POW_KEY, String(v)) } catch { /* ignore */ }
    set({ publishPow: v })
  },
  viewPow: loadPow(VIEW_POW_KEY),
  setViewPow: (n) => {
    const v = Math.max(0, Math.min(40, Math.round(n)))
    try { localStorage.setItem(VIEW_POW_KEY, String(v)) } catch { /* ignore */ }
    set({ viewPow: v })
  },
  showNsfw: (() => { try { return localStorage.getItem(SHOW_NSFW_KEY) === '1' } catch { return false } })(),
  setShowNsfw: (v) => {
    try { localStorage.setItem(SHOW_NSFW_KEY, v ? '1' : '0') } catch { /* ignore */ }
    set({ showNsfw: v })
  },
  showMedia: loadBool(SHOW_MEDIA_KEY, true),
  setShowMedia: (v) => { try { localStorage.setItem(SHOW_MEDIA_KEY, v ? '1' : '0') } catch { /* ignore */ } set({ showMedia: v }) },
  showEmbeds: loadBool(SHOW_EMBEDS_KEY, true),
  setShowEmbeds: (v) => { try { localStorage.setItem(SHOW_EMBEDS_KEY, v ? '1' : '0') } catch { /* ignore */ } set({ showEmbeds: v }) },
  showCustomEmojis: loadBool(SHOW_EMOJIS_KEY, true),
  setShowCustomEmojis: (v) => { try { localStorage.setItem(SHOW_EMOJIS_KEY, v ? '1' : '0') } catch { /* ignore */ } set({ showCustomEmojis: v }) },
  dnnOnly: loadBool(DNN_ONLY_KEY, false),
  setDnnOnly: (v) => { try { localStorage.setItem(DNN_ONLY_KEY, v ? '1' : '0') } catch { /* ignore */ } set({ dnnOnly: v }) },

  followedWords: [],
  followedLoaded: false,

  loadFollowedWords: async (pubkey) => {
    try {
      const ev = await fetchReplaceable(pubkey, KINDS.FORUM_WORD_LIST)
      const words = ev ? parseForumWordList(ev) : []
      set({ followedWords: words, followedLoaded: true })
    } catch {
      set({ followedLoaded: true })
    }
  },

  followWord: async (word) => {
    const norm = normalizeWord(word)
    if (!norm || get().followedWords.includes(norm)) return
    if (get().followedWords.length >= MAX_FORUM_LIST) { set({ listFull: 'word' }); return }
    const next = [...get().followedWords, norm]
    set({ followedWords: next })
    await publishWordList(next)
  },

  unfollowWord: async (word) => {
    const norm = normalizeWord(word)
    const next = get().followedWords.filter((w) => w !== norm)
    set({ followedWords: next })
    await publishWordList(next)
  },

  isFollowed: (word) => get().followedWords.includes(normalizeWord(word)),

  wordProfiles: {},
  myWordProfile: {},
  othersWordProfiles: {},
  fetchWordProfile: async (word) => {
    const norm = normalizeWord(word)
    const me = auth().pubkey
    try {
      // 1. My own appearance event for this word (may be a delegation).
      const mine = me
        ? (await fetchEvents(wordProfileByAuthorsFilter(norm, [me]))).map(parseWordProfile).filter(Boolean)
            .sort((a, b) => b!.createdAt - a!.createdAt)[0] || null
        : null
      // 2. Resolve what to render: my delegate's appearance, or my own.
      let resolved: WordProfile | null = null
      if (mine?.delegate) {
        const del = (await fetchEvents(wordProfileByAuthorsFilter(norm, [mine.delegate]))).map(parseWordProfile).filter(Boolean)
          .sort((a, b) => b!.createdAt - a!.createdAt)[0] || null
        resolved = hasWordProfileContent(del) ? del : null
      } else {
        resolved = hasWordProfileContent(mine) ? mine : null
      }
      set({
        myWordProfile: { ...get().myWordProfile, [norm]: mine },
        wordProfiles: { ...get().wordProfiles, [norm]: resolved },
      })
    } catch { /* ignore */ }
  },
  fetchWordProfilesBatch: async (words) => {
    const me = auth().pubkey
    if (!me || words.length === 0) return
    const norms = [...new Set(words.map(normalizeWord))].filter((w) => !(w in get().wordProfiles))
    if (norms.length === 0) return
    try {
      const mineEvents = await fetchEvents({ kinds: [WORD_PROFILE_KIND], authors: [me], '#d': norms })
      const mineByWord = new Map<string, WordProfile>()
      for (const ev of mineEvents) {
        const p = parseWordProfile(ev); if (!p) continue
        const prev = mineByWord.get(p.word); if (!prev || p.createdAt > prev.createdAt) mineByWord.set(p.word, p)
      }
      const delegates = new Set<string>()
      for (const p of mineByWord.values()) if (p.delegate) delegates.add(p.delegate)
      const delByKey = new Map<string, WordProfile>()
      if (delegates.size > 0) {
        const delEvents = await fetchEvents({ kinds: [WORD_PROFILE_KIND], authors: [...delegates], '#d': norms })
        for (const ev of delEvents) {
          const p = parseWordProfile(ev); if (!p) continue
          const key = `${p.pubkey}:${p.word}`
          const prev = delByKey.get(key); if (!prev || p.createdAt > prev.createdAt) delByKey.set(key, p)
        }
      }
      const next = { ...get().wordProfiles }
      for (const w of norms) {
        const mine = mineByWord.get(w)
        if (mine?.delegate) { const d = delByKey.get(`${mine.delegate}:${w}`); next[w] = hasWordProfileContent(d) ? d! : null }
        else next[w] = hasWordProfileContent(mine) ? mine! : null
      }
      set({ wordProfiles: next })
    } catch { /* ignore */ }
  },
  fetchOthersWordProfiles: async (word) => {
    const norm = normalizeWord(word)
    const follows = [...useFollowStore.getState().followedPubkeys]
    if (follows.length === 0) { set({ othersWordProfiles: { ...get().othersWordProfiles, [norm]: [] } }); return }
    try {
      const events = await fetchEvents(wordProfileByAuthorsFilter(norm, follows))
      const byAuthor = new Map<string, WordProfile>()
      for (const ev of events) {
        const p = parseWordProfile(ev)
        if (!p || !hasWordProfileContent(p)) continue // skip pure delegations
        const prev = byAuthor.get(p.pubkey)
        if (!prev || p.createdAt > prev.createdAt) byAuthor.set(p.pubkey, p)
      }
      set({ othersWordProfiles: { ...get().othersWordProfiles, [norm]: [...byAuthor.values()] } })
    } catch { /* ignore */ }
  },
  publishWordProfile: async (word, p) => {
    const { signer, privateKey } = auth()
    if (!signer && !privateKey) return
    const norm = normalizeWord(word)
    const signed = await signWithSigner(createWordProfile(norm, p), signer, privateKey)
    await publishEvent(signed)
    const mine = parseWordProfile(signed)
    set({
      myWordProfile: { ...get().myWordProfile, [norm]: mine },
      wordProfiles: { ...get().wordProfiles, [norm]: hasWordProfileContent(mine) ? mine : null },
    })
  },
  setWordDelegation: async (word, delegate) => {
    const { signer, privateKey } = auth()
    if (!signer && !privateKey) return
    const norm = normalizeWord(word)
    const signed = await signWithSigner(createWordDelegation(norm, delegate), signer, privateKey)
    await publishEvent(signed)
    const mine = parseWordProfile(signed)
    let resolved: WordProfile | null = null
    try {
      const del = (await fetchEvents(wordProfileByAuthorsFilter(norm, [delegate]))).map(parseWordProfile).filter(Boolean)
        .sort((a, b) => b!.createdAt - a!.createdAt)[0] || null
      resolved = hasWordProfileContent(del) ? del : null
    } catch { /* ignore */ }
    set({
      myWordProfile: { ...get().myWordProfile, [norm]: mine },
      wordProfiles: { ...get().wordProfiles, [norm]: resolved },
    })
  },

  listFull: null,
  clearListFull: () => set({ listFull: null }),

  discoverWords: [],
  discoverLoading: false,
  discoverDone: false,
  loadDiscoverWords: async (follows, reset = false) => {
    if (get().discoverLoading) return
    if (!reset && (get().discoverDone || get().discoverWords.length >= DISCOVER_MAX)) return
    const cursor = reset ? 0 : discoverCursor
    set({ discoverLoading: true, ...(reset ? { discoverWords: [], discoverDone: false } : {}) })
    if (reset) discoverCursor = 0
    const batch = follows.slice(cursor, cursor + DISCOVER_BATCH)
    try {
      const counts = new Map(get().discoverWords.map((d) => [d.word, d.count]))
      if (batch.length > 0) {
        const events = await fetchEvents({ kinds: [KINDS.FORUM_WORD_LIST], authors: batch })
        for (const ev of events) {
          // Up to 5 communities credited per person.
          for (const w of parseForumWordList(ev).slice(0, DISCOVER_PER_PERSON)) {
            counts.set(w, (counts.get(w) || 0) + 1)
          }
        }
      }
      const merged = [...counts.entries()]
        .map(([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, DISCOVER_MAX)
      discoverCursor = cursor + batch.length
      set({
        discoverWords: merged,
        discoverDone: discoverCursor >= follows.length || merged.length >= DISCOVER_MAX,
        discoverLoading: false,
      })
    } catch {
      set({ discoverLoading: false })
    }
  },

  // ── Created (NIP-72) communities ──
  joinedCommunities: [],
  joinedCommunitiesLoaded: false,
  loadJoinedCommunities: async (pubkey) => {
    try {
      const ev = await fetchReplaceable(pubkey, COMMUNITIES_LIST_KIND)
      set({ joinedCommunities: ev ? parseCommunityList(ev) : [], joinedCommunitiesLoaded: true })
    } catch {
      set({ joinedCommunitiesLoaded: true })
    }
  },
  joinCommunity: async (address) => {
    if (get().joinedCommunities.includes(address)) return
    if (get().joinedCommunities.length >= MAX_FORUM_LIST) { set({ listFull: 'community' }); return }
    const next = [...get().joinedCommunities, address]
    set({ joinedCommunities: next })
    await publishCommunityList(next)
  },
  leaveCommunity: async (address) => {
    const next = get().joinedCommunities.filter((a) => a !== address)
    set({ joinedCommunities: next })
    await publishCommunityList(next)
  },
  isCommunityJoined: (address) => get().joinedCommunities.includes(address),

  myCreatedCommunities: [],
  myCreatedLoaded: false,
  loadMyCreatedCommunities: async (pubkey) => {
    try {
      const events = await fetchEvents({ kinds: [COMMUNITY_KIND], authors: [pubkey], limit: 200 })
      const byAddr = new Map<string, CommunityDef>()
      for (const ev of events) {
        const d = parseCommunityDefinition(ev)
        if (!d) continue
        const prev = byAddr.get(d.address)
        if (!prev || d.createdAt > prev.createdAt) byAddr.set(d.address, d)
      }
      const list = [...byAddr.values()].sort((a, b) => b.createdAt - a.createdAt).map((d) => d.address)
      set({
        myCreatedCommunities: list,
        myCreatedLoaded: true,
        communitiesByAddress: { ...get().communitiesByAddress, ...Object.fromEntries(byAddr) },
      })
    } catch {
      set({ myCreatedLoaded: true })
    }
  },

  communitiesByAddress: {},
  postsByCommunity: {},
  approvedByCommunity: {},
  loadingCommunity: null,
  communityDiscovery: [],
  communityDiscoveryLoaded: false,

  fetchCommunity: async (address) => {
    const coord = parseCommunityAddress(address)
    if (!coord) return null
    try {
      const events = await fetchEvents(communityDefFilter(coord.pubkey, coord.dTag))
      const def = events.map(parseCommunityDefinition).find(Boolean) || null
      if (def) set({ communitiesByAddress: { ...get().communitiesByAddress, [address]: def } })
      return def
    } catch {
      return null
    }
  },

  fetchCommunityPosts: async (address) => {
    set({ loadingCommunity: address })
    try {
      const def = get().communitiesByAddress[address] || (await get().fetchCommunity(address))
      const moderators = new Set(def?.moderators || [])
      const [postEvents, approvalEvents] = await Promise.all([
        fetchEvents(communityPostsFilter(address)),
        fetchEvents(communityApprovalsFilter(address)),
      ])
      const seen = new Set<string>()
      const posts: ForumPost[] = []
      for (const ev of postEvents) {
        if (seen.has(ev.id)) continue
        const p = parseCommunityPost(ev)
        if (p) { seen.add(ev.id); posts.push(p) }
      }
      // Approved = referenced by an approval from a moderator (creator counts).
      const approved = new Set<string>()
      for (const ev of approvalEvents) {
        const a = parseApproval(ev)
        if (a && (moderators.size === 0 || moderators.has(a.moderator))) approved.add(a.postId)
      }
      set({
        postsByCommunity: { ...get().postsByCommunity, [address]: posts },
        approvedByCommunity: { ...get().approvedByCommunity, [address]: [...approved] },
        loadingCommunity: null,
      })
      const ids = posts.map((p) => p.id)
      get().fetchSentiments(ids).catch(() => {})
      get().fetchCommentCounts(ids).catch(() => {})
    } catch {
      set({ loadingCommunity: null })
    }
  },

  fetchCommunityDiscovery: async () => {
    try {
      const events = await fetchEvents(communityDiscoveryFilter())
      // Keep the newest definition per address.
      const byAddr = new Map<string, CommunityDef>()
      for (const ev of events) {
        const def = parseCommunityDefinition(ev)
        if (!def) continue
        const prev = byAddr.get(def.address)
        if (!prev || def.createdAt > prev.createdAt) byAddr.set(def.address, def)
      }
      const list = [...byAddr.values()].sort((a, b) => b.createdAt - a.createdAt)
      set({
        communityDiscovery: list,
        communityDiscoveryLoaded: true,
        communitiesByAddress: { ...get().communitiesByAddress, ...Object.fromEntries(byAddr) },
      })
    } catch {
      set({ communityDiscoveryLoaded: true })
    }
  },

  createCommunity: async ({ name, description, image, banner, nsfw, moderators }) => {
    const { signer, privateKey, pubkey } = auth()
    if ((!signer && !privateKey) || !pubkey || !name.trim()) return null
    // Slugify the name into a stable d-tag identifier.
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const dTag = slug || `c-${Date.now().toString(36)}`
    const unsigned = createCommunityDefinition({ dTag, name, description, image, banner, nsfw, moderators })
    const signed = await signWithSigner(unsigned, signer, privateKey)
    await publishEvent(signed)
    const def = parseCommunityDefinition(signed)
    if (def) {
      set({ communitiesByAddress: { ...get().communitiesByAddress, [def.address]: def } })
      await get().joinCommunity(def.address)
    }
    return def
  },

  updateCommunity: async (def, changes) => {
    const { signer, privateKey, pubkey } = auth()
    if ((!signer && !privateKey) || pubkey !== def.pubkey) return null
    // Moderators stored on the event exclude the creator (re-added implicitly on parse).
    const mods = (changes.moderators ?? def.moderators).filter((m) => m !== def.pubkey)
    const unsigned = createCommunityDefinition({
      dTag: def.dTag,
      name: changes.name ?? def.name,
      description: changes.description ?? def.description,
      image: changes.image ?? def.image,
      banner: changes.banner ?? def.banner,
      nsfw: changes.nsfw ?? def.nsfw,
      moderators: mods,
      relays: def.relays,
    })
    const signed = await signWithSigner(unsigned, signer, privateKey)
    await publishEvent(signed)
    const updated = parseCommunityDefinition(signed)
    if (updated) set({ communitiesByAddress: { ...get().communitiesByAddress, [updated.address]: updated } })
    return updated
  },

  publishCommunityPost: async (community, title, body, opts) => {
    const { signer, privateKey, pubkey } = auth()
    if ((!signer && !privateKey) || !title.trim()) return null
    const unsigned = createCommunityPost({ address: community.address, pubkey: community.pubkey }, title, body, opts)
    const signed = await mineAndSign(unsigned, get().publishPow, pubkey, signer, privateKey)
    assertPublished(await publishEvent(signed))
    const post = parseCommunityPost(signed)
    if (post) {
      const addr = community.address
      set({ postsByCommunity: { ...get().postsByCommunity, [addr]: [post, ...(get().postsByCommunity[addr] || [])] } })
      // If the author is a moderator, self-approve so it appears immediately.
      if (community.moderators.includes(pubkey || '')) get().approvePost(community, post).catch(() => {})
    }
    return post
  },

  approvePost: async (community, post) => {
    const { signer, privateKey } = auth()
    if (!signer && !privateKey) return
    try {
      const raw = await fetchEventById(post.id)
      if (!raw) return
      const unsigned = createCommunityApproval(community.address, raw)
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishEvent(signed)
      const addr = community.address
      const cur = get().approvedByCommunity[addr] || []
      if (!cur.includes(post.id)) {
        set({ approvedByCommunity: { ...get().approvedByCommunity, [addr]: [...cur, post.id] } })
      }
    } catch { /* ignore */ }
  },

  activeWord: null,
  setActiveWord: (word) => set({ activeWord: word ? normalizeWord(word) : null }),
  sort: 'new',
  setSort: (s) => set({ sort: s }),

  postsByWord: {},
  loadingWord: null,
  commentsByPost: {},
  commentCounts: {},
  sentimentByTarget: {},

  fetchCommentCounts: async (postIds) => {
    if (postIds.length === 0) return
    const want = new Set(postIds)
    try {
      const events = await fetchEvents({ kinds: [KINDS.FORUM_POST], '#E': postIds, limit: 3000 })
      const counts: Record<string, number> = {}
      const seen = new Set<string>()
      for (const ev of events) {
        if (seen.has(ev.id)) continue
        seen.add(ev.id)
        const root = ev.tags.find((t) => t[0] === 'E')?.[1]
        if (root && want.has(root)) counts[root] = (counts[root] || 0) + 1
      }
      const next = { ...get().commentCounts }
      for (const id of postIds) next[id] = counts[id] || 0
      set({ commentCounts: next })
    } catch { /* ignore */ }
  },

  fetchWordPosts: async (word) => {
    const norm = normalizeWord(word)
    set({ loadingWord: norm })
    try {
      const events = await fetchEvents(wordPostsFilter(norm))
      const seen = new Set<string>()
      const posts: ForumPost[] = []
      for (const ev of events) {
        if (seen.has(ev.id)) continue
        const p = parseForumWordPost(ev)
        if (p) { seen.add(ev.id); posts.push(p) }
      }
      set({ postsByWord: { ...get().postsByWord, [norm]: posts }, loadingWord: null })
      // Best-effort: pull reaction sentiment + comment counts.
      const ids = posts.map((p) => p.id)
      get().fetchSentiments(ids).catch(() => {})
      get().fetchCommentCounts(ids).catch(() => {})
    } catch {
      set({ loadingWord: null })
    }
  },

  fetchPostComments: async (postId) => {
    try {
      const events = await fetchEvents(postCommentsFilter(postId))
      const seen = new Set<string>()
      const comments: ForumComment[] = []
      for (const ev of events) {
        if (seen.has(ev.id)) continue
        const c = parseForumComment(ev)
        if (c) { seen.add(ev.id); comments.push(c) }
      }
      set({ commentsByPost: { ...get().commentsByPost, [postId]: comments } })
      get().fetchSentiments(comments.map((c) => c.id)).catch(() => {})
    } catch { /* ignore */ }
  },

  fetchSentiments: async (ids) => {
    if (ids.length === 0) return
    const myPubkey = auth().pubkey
    try {
      // Batch reaction fetch keyed by all target ids.
      const events = await fetchEvents({ kinds: [7], '#e': ids, limit: 2000 })
      const byTarget = new Map<string, Event[]>()
      for (const ev of events) {
        const target = reactionTargetId(ev)
        if (!target) continue
        if (!byTarget.has(target)) byTarget.set(target, [])
        byTarget.get(target)!.push(ev)
      }
      const next = { ...get().sentimentByTarget }
      for (const id of ids) {
        next[id] = summarizeSentiment(byTarget.get(id) || [], myPubkey)
      }
      set({ sentimentByTarget: next })
    } catch { /* ignore */ }
  },

  getPost: (id) => {
    const { postsByWord, postsByCommunity } = get()
    for (const list of Object.values(postsByWord)) { const p = list.find((x) => x.id === id); if (p) return p }
    for (const list of Object.values(postsByCommunity)) { const p = list.find((x) => x.id === id); if (p) return p }
    return undefined
  },

  fetchPostById: async (id) => {
    const cached = get().getPost(id)
    if (cached) return cached
    try {
      const ev = await fetchEventById(id)
      if (!ev) return null
      const wordPost = parseForumWordPost(ev)
      if (wordPost?.word) {
        set({ postsByWord: { ...get().postsByWord, [wordPost.word]: [wordPost, ...(get().postsByWord[wordPost.word] || []).filter((p) => p.id !== id)] } })
        get().fetchSentiments([id]).catch(() => {})
        return wordPost
      }
      const commPost = parseCommunityPost(ev)
      if (commPost?.community) {
        const addr = commPost.community
        set({ postsByCommunity: { ...get().postsByCommunity, [addr]: [commPost, ...(get().postsByCommunity[addr] || []).filter((p) => p.id !== id)] } })
        get().fetchSentiments([id]).catch(() => {})
        return commPost
      }
      return null
    } catch {
      return null
    }
  },

  publishWordPost: async (word, title, body, opts) => {
    const { signer, privateKey, pubkey } = auth()
    if ((!signer && !privateKey) || !title.trim() || !word.trim()) return null
    const unsigned = createForumWordPost(word, title, body, opts)
    const signed = await mineAndSign(unsigned, get().publishPow, pubkey, signer, privateKey)
    assertPublished(await publishEvent(signed))
    const post = parseForumWordPost(signed)
    if (post) {
      const norm = post.word
      set({ postsByWord: { ...get().postsByWord, [norm]: [post, ...(get().postsByWord[norm] || [])] } })
    }
    return post
  },

  publishComment: async (root, parent, body) => {
    const { signer, privateKey, pubkey } = auth()
    if ((!signer && !privateKey) || !body.trim()) return null
    const unsigned = createForumComment({ root, parent, body })
    const signed = await mineAndSign(unsigned, get().publishPow, pubkey, signer, privateKey)
    assertPublished(await publishEvent(signed))
    const comment = parseForumComment(signed)
    if (comment) {
      set({ commentsByPost: { ...get().commentsByPost, [root.id]: [...(get().commentsByPost[root.id] || []), comment] } })
    }
    return comment
  },

  react: async (target, content) => {
    const { signer, privateKey } = auth()
    if (!signer && !privateKey) return
    const bucket = classifyReaction(content)
    const cur = get().sentimentByTarget[target.id] || { positive: 0, negative: 0 }
    const togglingOff = cur.mine === bucket // clicking the same arrow again removes it

    // ── Optimistic update first (instant UI) ──
    const optimistic: ReactionSentiment = {
      positive: cur.positive - (cur.mine === 'positive' ? 1 : 0) + (!togglingOff && bucket === 'positive' ? 1 : 0),
      negative: cur.negative - (cur.mine === 'negative' ? 1 : 0) + (!togglingOff && bucket === 'negative' ? 1 : 0),
      mine: togglingOff ? undefined : bucket,
      mineId: undefined, // set below after the new reaction is signed
    }
    set({ sentimentByTarget: { ...get().sentimentByTarget, [target.id]: optimistic } })

    try {
      // 1. Remove any existing reaction of ours (NIP-09 deletion).
      if (cur.mineId) {
        const del = createDeletionEvent([cur.mineId])
        const signedDel = await signWithSigner(del, signer, privateKey)
        await publishEvent(signedDel)
      }
      // 2. Publish the new reaction unless we're just toggling off.
      if (!togglingOff) {
        const signed = await signWithSigner(createForumReaction(target.id, target.pubkey, content), signer, privateKey)
        await publishEvent(signed)
        set({ sentimentByTarget: { ...get().sentimentByTarget, [target.id]: { ...optimistic, mineId: signed.id } } })
      }
    } catch {
      // Reconcile from relays on failure.
      get().fetchSentiments([target.id]).catch(() => {})
    }
  },

  // ── Live ingest (real-time subscriptions) ──
  ingestPost: (event) => {
    const wordPost = parseForumWordPost(event)
    if (wordPost?.word) {
      const w = wordPost.word
      const list = get().postsByWord[w] || []
      if (list.some((p) => p.id === wordPost.id)) return
      set({ postsByWord: { ...get().postsByWord, [w]: [wordPost, ...list] } })
      get().fetchSentiments([wordPost.id]).catch(() => {})
      return
    }
    const commPost = parseCommunityPost(event)
    if (commPost?.community) {
      const addr = commPost.community
      const list = get().postsByCommunity[addr] || []
      if (list.some((p) => p.id === commPost.id)) return
      set({ postsByCommunity: { ...get().postsByCommunity, [addr]: [commPost, ...list] } })
      get().fetchSentiments([commPost.id]).catch(() => {})
    }
  },

  ingestComment: (event) => {
    const c = parseForumComment(event)
    if (!c) return
    const list = get().commentsByPost[c.rootId] || []
    if (list.some((x) => x.id === c.id)) return
    set({ commentsByPost: { ...get().commentsByPost, [c.rootId]: [...list, c] } })
    get().fetchSentiments([c.id]).catch(() => {})
  },

  ingestReaction: (event) => {
    const target = reactionTargetId(event)
    if (target && get().sentimentByTarget[target]) get().fetchSentiments([target]).catch(() => {})
  },

  ingestApproval: (event) => {
    const a = parseApproval(event)
    if (!a) return
    const cur = get().approvedByCommunity[a.address] || []
    if (cur.includes(a.postId)) return
    set({ approvedByCommunity: { ...get().approvedByCommunity, [a.address]: [...cur, a.postId] } })
  },
}))

/** Sign + publish the joined-communities list (kind 10004). */
async function publishCommunityList(addresses: string[]) {
  const { signer, privateKey } = auth()
  if (!signer && !privateKey) return
  try {
    const signed = await signWithSigner(createCommunityListEvent(addresses), signer, privateKey)
    await publishEvent(signed)
  } catch (err) {
    console.error('[forum] failed to publish community list:', err)
  }
}

/** Sign + publish the followed-words list (kind 10044). */
async function publishWordList(words: string[]) {
  const { signer, privateKey } = auth()
  if (!signer && !privateKey) return
  try {
    const unsigned = createForumWordList(words)
    const signed = await signWithSigner(unsigned, signer, privateKey)
    await publishEvent(signed)
  } catch (err) {
    console.error('[forum] failed to publish word list:', err)
  }
}
