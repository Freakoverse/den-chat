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
  | 'longform-feed' | 'longform-write' | 'longform-mine' | 'longform-drafts' | 'longform-read' | 'longform-bookmarks' | 'longform-draft-preview'

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

  setActivePage: (page: SocialPage) => void
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

export const useSocialStore = create<SocialState>((set) => ({
  activePage: 'feed',
  posts: [],
  activeThreadId: null,
  activeProfilePubkey: null,
  activeArticleNaddr: null,
  editingArticleNaddr: null,
  previewDraftNaddr: null,

  setActivePage: (page) => set({ activePage: page }),

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

  setActiveThread: (id) => set({ activePage: 'thread', activeThreadId: id }),

  setActiveProfile: (pubkey) => set({ activePage: 'profile', activeProfilePubkey: pubkey }),

  setActiveArticle: (naddr) => set({ activePage: 'longform-read', activeArticleNaddr: naddr }),

  setEditingArticle: (naddr) => set({ activePage: 'longform-write', editingArticleNaddr: naddr }),

  setPreviewDraft: (naddr) => set({ activePage: 'longform-draft-preview', previewDraftNaddr: naddr }),

  goBack: () => set((s) => {
    // Long-form sub-pages go back to longform-feed
    if (s.activePage === 'longform-draft-preview') {
      return { activePage: 'longform-drafts' as SocialPage, previewDraftNaddr: null }
    }
    if (s.activePage.startsWith('longform-')) {
      return { activePage: 'longform-feed' as SocialPage, activeArticleNaddr: null, editingArticleNaddr: null, previewDraftNaddr: null }
    }
    return { activePage: 'feed' as SocialPage, activeThreadId: null, activeProfilePubkey: null }
  }),

  feedFilters: loadFilters(),
  setFeedFilter: (key, value) => set((s) => {
    const updated = { ...s.feedFilters, [key]: value }
    localStorage.setItem('feedFilters', JSON.stringify(updated))
    return { feedFilters: updated }
  }),
}))
