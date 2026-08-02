import { create } from 'zustand'
import type { Event } from 'nostr-tools'

/** Max posts to keep in memory in the social feed */
const MAX_FEED_POSTS = 500

// Load persisted feed filters from localStorage
const loadFilters = (): FeedFilters => {
  try {
    const raw = localStorage.getItem('feedFilters')
    if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_FILTERS }
}

export interface FeedFilters {
  showQuoteReposts: boolean
  showReposts: boolean
  showReplies: boolean
}

const DEFAULT_FILTERS: FeedFilters = {
  showQuoteReposts: true,
  showReposts: true,
  showReplies: false,
}

export type SocialPage = 'feed' | 'thread' | 'profile'
  | 'longform-feed' | 'longform-write' | 'longform-mine' | 'longform-drafts' | 'longform-read' | 'longform-bookmarks' | 'longform-draft-preview' | 'longform-notifications'
  | 'forum-feed' | 'forum-thread' | 'forum-notifications'

/** Snapshot of navigable state for the back stack */
interface NavSnapshot {
  activePage: SocialPage
  activeThreadId: string | null
  activeProfilePubkey: string | null
  activeArticleNaddr: string | null
  editingArticleNaddr: string | null
  previewDraftNaddr: string | null
  activeForumWord: string | null
  activeForumCommunity: string | null
  activeForumPostId: string | null
}

interface SocialState {
  /** Current social sub-page */
  activePage: SocialPage
  /** Feed posts */
  posts: Event[]
  /** Active thread root event ID */
  activeThreadId: string | null
  /** Active profile pubkey */
  activeProfilePubkey: string | null
  /** Active article naddr (for longform-read page) */
  activeArticleNaddr: string | null
  /** Article naddr being edited (for longform-write page in edit mode) */
  editingArticleNaddr: string | null
  /** Draft naddr being previewed (for longform-draft-preview page) */
  previewDraftNaddr: string | null
  /** Active forum word community (for forum-feed, decentralized tab) */
  activeForumWord: string | null
  /** Active forum created-community address `34550:pk:d` (centralized tab) */
  activeForumCommunity: string | null
  /** Active forum post id (for forum-thread) */
  activeForumPostId: string | null
  /** Navigation back stack */
  navStack: NavSnapshot[]

  setActivePage: (page: SocialPage) => void
  /** Open the forum home feed (clears any active community). */
  openForumFeed: () => void
  setActiveForumWord: (word: string) => void
  /** Open a created (NIP-72) community by its `34550:pk:d` address. */
  setActiveForumCommunity: (address: string) => void
  setActiveForumThread: (postId: string) => void
  setPosts: (posts: Event[]) => void
  addPost: (post: Event) => void
  prependPosts: (posts: Event[]) => void
  setActiveThread: (id: string) => void
  setActiveProfile: (pubkey: string) => void
  setActiveArticle: (naddr: string) => void
  setEditingArticle: (naddr: string | null) => void
  setPreviewDraft: (naddr: string) => void
  goBack: () => void
  /** Feed filters */
  feedFilters: FeedFilters
  setFeedFilter: <K extends keyof FeedFilters>(key: K, value: FeedFilters[K]) => void
}

/** Helper to snapshot current navigable state */
function snapshot(s: SocialState): NavSnapshot {
  return {
    activePage: s.activePage,
    activeThreadId: s.activeThreadId,
    activeProfilePubkey: s.activeProfilePubkey,
    activeArticleNaddr: s.activeArticleNaddr,
    editingArticleNaddr: s.editingArticleNaddr,
    previewDraftNaddr: s.previewDraftNaddr,
    activeForumWord: s.activeForumWord,
    activeForumCommunity: s.activeForumCommunity,
    activeForumPostId: s.activeForumPostId,
  }
}

/** Max back-stack depth to prevent unbounded growth */
const MAX_NAV_STACK = 20

export const useSocialStore = create<SocialState>((set) => ({
  activePage: 'feed',
  posts: [],
  activeThreadId: null,
  activeProfilePubkey: null,
  activeArticleNaddr: null,
  editingArticleNaddr: null,
  previewDraftNaddr: null,
  activeForumWord: null,
  activeForumCommunity: null,
  activeForumPostId: null,
  navStack: [],

  // Navigating to the Write page via the nav = a NEW article: clear any lingering
  // edit target so it doesn't reopen the last-edited article. (Edit mode is entered
  // only via setEditingArticle, which sets editingArticleNaddr directly.)
  setActivePage: (page) => set(page === 'longform-write' ? { activePage: page, editingArticleNaddr: null } : { activePage: page }),
  openForumFeed: () => set({ activePage: 'forum-feed', activeForumWord: null, activeForumCommunity: null, activeForumPostId: null, navStack: [] }),
  setActiveForumWord: (word) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'forum-feed',
    activeForumWord: word.toLowerCase(),
    activeForumCommunity: null,
    activeForumPostId: null,
  })),
  setActiveForumCommunity: (address) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'forum-feed',
    activeForumCommunity: address,
    activeForumWord: null,
    activeForumPostId: null,
  })),
  setActiveForumThread: (postId) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'forum-thread',
    activeForumPostId: postId,
  })),

  setPosts: (posts) => {
    let sorted = posts.sort((a, b) => b.created_at - a.created_at)
    if (sorted.length > MAX_FEED_POSTS) sorted = sorted.slice(0, MAX_FEED_POSTS)
    set({ posts: sorted })
  },

  addPost: (post) => set((s) => {
    // Deduplicate
    if (s.posts.some((p) => p.id === post.id)) return s
    let updated = [post, ...s.posts].sort((a, b) => b.created_at - a.created_at)
    // FIFO cap: trim oldest (end of array, since sorted newest-first)
    if (updated.length > MAX_FEED_POSTS) updated = updated.slice(0, MAX_FEED_POSTS)
    return { posts: updated }
  }),

  prependPosts: (posts) => set((s) => {
    const existing = new Set(s.posts.map((p) => p.id))
    const newPosts = posts.filter((p) => !existing.has(p.id))
    let updated = [...newPosts, ...s.posts].sort((a, b) => b.created_at - a.created_at)
    // FIFO cap: trim oldest (end of array, since sorted newest-first)
    if (updated.length > MAX_FEED_POSTS) updated = updated.slice(0, MAX_FEED_POSTS)
    return { posts: updated }
  }),

  setActiveThread: (id) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'thread',
    activeThreadId: id,
  })),

  setActiveProfile: (pubkey) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'profile',
    activeProfilePubkey: pubkey,
  })),

  setActiveArticle: (naddr) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'longform-read',
    activeArticleNaddr: naddr,
  })),

  setEditingArticle: (naddr) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'longform-write',
    editingArticleNaddr: naddr,
  })),

  setPreviewDraft: (naddr) => set((s) => ({
    navStack: [...s.navStack, snapshot(s)].slice(-MAX_NAV_STACK),
    activePage: 'longform-draft-preview',
    previewDraftNaddr: naddr,
  })),

  goBack: () => set((s) => {
    const stack = [...s.navStack]
    const prev = stack.pop()

    if (prev) {
      // Pop and restore the previous navigation state
      return { ...prev, navStack: stack }
    }

    // Fallback: no stack history — use hardcoded defaults
    if (s.activePage === 'longform-draft-preview') {
      return { activePage: 'longform-drafts' as SocialPage, previewDraftNaddr: null, navStack: [] }
    }
    if (s.activePage.startsWith('longform-')) {
      return { activePage: 'longform-feed' as SocialPage, activeArticleNaddr: null, editingArticleNaddr: null, previewDraftNaddr: null, navStack: [] }
    }
    if (s.activePage === 'forum-thread') {
      return { activePage: 'forum-feed' as SocialPage, activeForumPostId: null, navStack: [] }
    }
    return { activePage: 'feed' as SocialPage, activeThreadId: null, activeProfilePubkey: null, navStack: [] }
  }),

  feedFilters: loadFilters(),
  setFeedFilter: (key, value) => set((s) => {
    const updated = { ...s.feedFilters, [key]: value }
    localStorage.setItem('feedFilters', JSON.stringify(updated))
    return { feedFilters: updated }
  }),
}))
