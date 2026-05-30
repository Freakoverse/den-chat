/**
 * SocialFeedPage — Main social feed page (Twitter/X-like)
 *
 * Shows: compose box (sticky) + scrollable feed of kind:1 posts from followed users
 * Sub-pages: thread view, user profile view
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useFollowStore } from '@/stores/followStore'
import { useUserStore } from '@/stores/userStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { nip04, nip19 } from 'nostr-tools'
import { ComposeBox } from '@/components/social/ComposeBox'
import { SocialPost } from '@/components/social/SocialPost'
import { PostThread } from '@/components/social/PostThread'
import { UserProfilePage } from '@/components/social/UserProfilePage'
import { LongFormFeedPage } from '@/components/social/LongFormFeedPage'
import { LongFormArticleReader } from '@/components/social/LongFormArticleReader'
import { LongFormWritePage } from '@/components/social/LongFormWritePage'
import { LongFormMinePage } from '@/components/social/LongFormMinePage'
import { LongFormDraftsPage } from '@/components/social/LongFormDraftsPage'
import { LongFormBookmarksPage } from '@/components/social/LongFormBookmarksPage'
import { DraftPreviewPage } from '@/components/social/DraftPreviewPage'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Loader2, RefreshCw, Newspaper, Heart, Bookmark, User, SlidersHorizontal, X, ChevronDown, Bell, Repeat2, AtSign, Zap, MessageCircle, FileText, PenLine, FolderOpen, FileArchive, Video, Mail } from 'lucide-react'
import type { SocialPage } from '@/stores/socialStore'
import { Button } from '@/components/ui/button'
import { UserPanel } from '@/components/ui/UserPanel'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { cn, truncateNpub, formatTimestamp } from '@/lib/utils'
import type { Event } from 'nostr-tools'

type FeedTab = 'home' | 'reactions' | 'bookmarks' | 'notifications'

/** Threshold in px above the bottom to start loading the next batch */
const PREFETCH_MARGIN = 800

/* ─── Left Sidebar Nav ────────────────────────────────────── */

function SocialNav({ activeTab, activePage, onTabChange, onOpenProfile, onPageChange }: { activeTab: FeedTab; activePage: string; onTabChange: (tab: FeedTab) => void; onOpenProfile: () => void; onPageChange: (page: SocialPage) => void }) {
  const isProfile = activePage === 'profile'
  const isLongForm = activePage.startsWith('longform-')
  const [shortFormOpen, setShortFormOpen] = useState(!isLongForm)
  const [longFormOpen, setLongFormOpen] = useState(isLongForm)
  const [forumOpen, setForumOpen] = useState(false)
  const [videoOpen, setVideoOpen] = useState(false)
  const [nmailOpen, setNmailOpen] = useState(false)
  const hasSocialNotification = useNotificationStore((s) => s.hasSocialNotification)

  const tabs: { id: FeedTab; label: string; icon: React.ReactNode; badge?: boolean }[] = [
    { id: 'home', label: 'Feed', icon: <Newspaper size={18} /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell size={18} />, badge: hasSocialNotification },
    { id: 'reactions', label: 'Reactions', icon: <Heart size={18} /> },
    { id: 'bookmarks', label: 'Bookmarks', icon: <Bookmark size={18} /> },
  ]

  const longFormTabs: { id: SocialPage; label: string; icon: React.ReactNode }[] = [
    { id: 'longform-feed', label: 'Feed', icon: <Newspaper size={18} /> },
    { id: 'longform-write', label: 'Write', icon: <PenLine size={18} /> },
    { id: 'longform-mine', label: 'My Articles', icon: <FolderOpen size={18} /> },
    { id: 'longform-drafts', label: 'Drafts', icon: <FileArchive size={18} /> },
    { id: 'longform-bookmarks', label: 'Bookmarks', icon: <Bookmark size={18} /> },
  ]

  return (
    <nav className="flex flex-col gap-1 px-2 pt-4">
      {/* Short Form accordion */}
      <button
        onClick={() => setShortFormOpen(!shortFormOpen)}
        className="flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span>Short Form</span>
        <ChevronDown size={14} className={`transition-transform duration-200 ${shortFormOpen ? '' : '-rotate-90'}`} />
      </button>
      {shortFormOpen && (
        <div className="flex flex-col gap-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                ${!isProfile && !isLongForm && activeTab === tab.id
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
            >
              <span className="relative">
                {tab.icon}
                {tab.badge && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary" />
                )}
              </span>
              {tab.label}
            </button>
          ))}
          <button
            onClick={onOpenProfile}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
              ${isProfile
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
          >
            <User size={18} />
            Profile
          </button>
        </div>
      )}

      {/* Long Form accordion */}
      <button
        onClick={() => setLongFormOpen(!longFormOpen)}
        className="flex items-center justify-between px-3 py-1.5 mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span>Long Form</span>
        <ChevronDown size={14} className={`transition-transform duration-200 ${longFormOpen ? '' : '-rotate-90'}`} />
      </button>
      {longFormOpen && (
        <div className="flex flex-col gap-0.5">
          {longFormTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onPageChange(tab.id)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                ${activePage === tab.id
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Forum accordion */}
      <button
        onClick={() => setForumOpen(!forumOpen)}
        className="flex items-center justify-between px-3 py-1.5 mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span>Forum</span>
        <ChevronDown size={14} className={`transition-transform duration-200 ${forumOpen ? '' : '-rotate-90'}`} />
      </button>
      {forumOpen && (
        <p className="px-3 py-2 text-xs text-muted-foreground">coming soon</p>
      )}

      {/* Video accordion */}
      <button
        onClick={() => setVideoOpen(!videoOpen)}
        className="flex items-center justify-between px-3 py-1.5 mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span>Video</span>
        <ChevronDown size={14} className={`transition-transform duration-200 ${videoOpen ? '' : '-rotate-90'}`} />
      </button>
      {videoOpen && (
        <p className="px-3 py-2 text-xs text-muted-foreground">coming soon</p>
      )}

      {/* N-MAIL accordion */}
      <button
        onClick={() => setNmailOpen(!nmailOpen)}
        className="flex items-center justify-between px-3 py-1.5 mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span>N-Mail</span>
        <ChevronDown size={14} className={`transition-transform duration-200 ${nmailOpen ? '' : '-rotate-90'}`} />
      </button>
      {nmailOpen && (
        <p className="px-3 py-2 text-xs text-muted-foreground">coming soon</p>
      )}
    </nav>
  )
}

export function SocialFeedPage() {
  const activePage = useSocialStore((s) => s.activePage)
  const posts = useSocialStore((s) => s.posts)
  const setPosts = useSocialStore((s) => s.setPosts)
  const prependPosts = useSocialStore((s) => s.prependPosts)
  const follows = useFollowStore((s) => s.followedPubkeys)
  const followsLoaded = useFollowStore((s) => s.loaded)
  const setActiveThread = useSocialStore((s) => s.setActiveThread)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)
  const feedFilters = useSocialStore((s) => s.feedFilters)
  const setFeedFilter = useSocialStore((s) => s.setFeedFilter)

  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [feedTab, setFeedTab] = useState<FeedTab>('home')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Reactions / Bookmarks state
  const [reactionPosts, setReactionPosts] = useState<Event[]>([])
  const [bookmarkPosts, setBookmarkPosts] = useState<Event[]>([])
  const [subLoading, setSubLoading] = useState(false)
  const [showFilterModal, setShowFilterModal] = useState(false)

  // Load feed when follows are ready (or immediately for self-posts)
  useEffect(() => {
    if (!followsLoaded || posts.length > 0) return
    if (follows.size === 0 && !pubkey) return
    loadFeed()
  }, [followsLoaded, follows, pubkey])

  const loadFeed = useCallback(async () => {
    setLoading(true)
    try {
      const authorSet = new Set(follows)
      if (pubkey) authorSet.add(pubkey)
      const authors = Array.from(authorSet).slice(0, 500)
      if (authors.length === 0) { setLoading(false); return }
      const since = Math.floor(Date.now() / 1000) - 86400

      const events = await fetchEvents({
        kinds: [1, 6],
        authors,
        since,
        limit: 150,
      })
      setPosts(events)
    } catch (err) {
      console.error('Failed to load feed:', err)
    } finally {
      setLoading(false)
    }
  }, [follows, pubkey, setPosts])

  const loadMore = useCallback(async () => {
    if (posts.length === 0 || loadingMoreRef.current) return
    setLoadingMore(true)
    loadingMoreRef.current = true
    try {
      const oldest = posts[posts.length - 1]
      const authorSet = new Set(follows)
      if (pubkey) authorSet.add(pubkey)
      const authors = Array.from(authorSet).slice(0, 500)
      if (authors.length === 0) { setLoadingMore(false); loadingMoreRef.current = false; return }

      const events = await fetchEvents({
        kinds: [1, 6],
        authors,
        until: oldest.created_at,
        limit: 80,
      })
      prependPosts(events)
    } catch (err) {
      console.error('Failed to load more:', err)
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [follows, pubkey, posts, prependPosts])

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current
    const scroll = scrollRef.current
    if (!sentinel || !scroll) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMoreRef.current && posts.length > 0) {
          loadMore()
        }
      },
      { root: scroll, rootMargin: `0px 0px ${PREFETCH_MARGIN}px 0px`, threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore, posts.length])

  const handleRefresh = useCallback(() => {
    setPosts([])
    loadFeed()
  }, [loadFeed, setPosts])

  // Load reactions when switching to reactions tab
  useEffect(() => {
    if (feedTab !== 'reactions' || !pubkey) return
    setSubLoading(true)
    fetchEvents({ kinds: [7], authors: [pubkey], limit: 100 })
      .then(async (reactions) => {
        const eventIds = reactions
          .map((r) => r.tags.find((t) => t[0] === 'e')?.[1])
          .filter((id): id is string => !!id)
        const unique = [...new Set(eventIds)]
        if (unique.length === 0) { setReactionPosts([]); return }
        const resolved = await fetchEvents({ ids: unique.slice(0, 50), limit: 50 })
        setReactionPosts(resolved.sort((a, b) => b.created_at - a.created_at))
      })
      .finally(() => setSubLoading(false))
  }, [feedTab, pubkey])

  // Load bookmarks when switching to bookmarks tab
  useEffect(() => {
    if (feedTab !== 'bookmarks' || !pubkey) return
    setSubLoading(true)
    fetchEvents({ kinds: [10003], authors: [pubkey], limit: 1 })
      .then(async (lists) => {
        const latest = lists.sort((a, b) => b.created_at - a.created_at)[0]
        if (!latest) { setBookmarkPosts([]); return }

        // Try to decrypt private bookmarks from content
        let eventIds: string[] = []
        if (latest.content) {
          try {
            let decrypted: string
            if (privateKey) {
              decrypted = await nip04.decrypt(privateKey, pubkey, latest.content)
            } else if (signer?.nip04Decrypt) {
              decrypted = await signer.nip04Decrypt(pubkey, latest.content)
            } else if (signer?.nip04?.decrypt) {
              decrypted = await signer.nip04.decrypt(pubkey, latest.content)
            } else {
              throw new Error('No decryption method')
            }
            const privateTags: string[][] = JSON.parse(decrypted)
            eventIds = privateTags.filter(t => t[0] === 'e').map(t => t[1])
          } catch {
            // Fallback: legacy public tags
            eventIds = latest.tags.filter(t => t[0] === 'e').map(t => t[1])
          }
        } else {
          // Legacy: public tags
          eventIds = latest.tags.filter(t => t[0] === 'e').map(t => t[1])
        }

        if (eventIds.length === 0) { setBookmarkPosts([]); return }
        const resolved = await fetchEvents({ ids: eventIds.slice(0, 50), limit: 50 })
        setBookmarkPosts(resolved.sort((a, b) => b.created_at - a.created_at))
      })
      .finally(() => setSubLoading(false))
  }, [feedTab, pubkey, signer, privateKey])

  // Left sidebar (shared across all sub-pages) — hidden on mobile
  const LeftPanel = (
    <ResizablePanel id="social" defaultWidth={280} minWidth={200} maxWidth={420} className="flex flex-col bg-secondary/50 max-[1080px]:hidden">
      <div className="flex-1 overflow-y-auto">
        <SocialNav activeTab={feedTab} activePage={activePage} onTabChange={(tab) => { setFeedTab(tab); useSocialStore.getState().setActivePage('feed') }} onOpenProfile={() => pubkey && setActiveProfile(pubkey)} onPageChange={(page) => useSocialStore.getState().setActivePage(page)} />
      </div>
      <UserPanel />
    </ResizablePanel>
  )

  // Determine which section is active
  const activeSection: 'short' | 'long' | 'forum' | 'video' = activePage.startsWith('longform-') ? 'long' : 'short'

  // Mobile tab bar — shown only on mobile, with section switcher + contextual sub-tabs
  const MobileTabBar = (
    <div className="hidden max-[1080px]:flex flex-col shrink-0 border-b border-border bg-secondary/30">
      {/* Section switcher row */}
      <div className="flex items-center border-b border-border/40">
        {([
          { id: 'short' as const, label: 'Short Form', icon: <Newspaper size={14} /> },
          { id: 'long' as const, label: 'Long Form', icon: <FileText size={14} /> },
          { id: 'forum' as const, label: 'Forum', icon: <MessageCircle size={14} /> },
          { id: 'video' as const, label: 'Video', icon: <Video size={14} /> },
          { id: 'nmail' as const, label: 'N-Mail', icon: <Mail size={14} /> },
        ]).map((section) => (
          <button
            key={section.id}
            onClick={() => {
              if (section.id === 'short') {
                setFeedTab('home')
                useSocialStore.getState().setActivePage('feed')
              } else if (section.id === 'long') {
                useSocialStore.getState().setActivePage('longform-feed')
              }
              // forum/video/nmail: do nothing (coming soon)
            }}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap transition-colors cursor-pointer',
              activeSection === section.id
                ? 'text-primary border-b-2 border-primary'
                : (section.id === 'forum' || section.id === 'video' || section.id === 'nmail')
                  ? 'text-muted-foreground/40 cursor-default'
                  : 'text-muted-foreground hover:text-foreground'
            )}
            disabled={section.id === 'forum' || section.id === 'video' || section.id === 'nmail'}
          >
            {section.icon}
            {section.label}
          </button>
        ))}
      </div>

      {/* Contextual sub-tabs */}
      <div className="flex flex-wrap items-center gap-1 px-2">
        {activeSection === 'short' ? (
          <>
            {([
              { id: 'home' as FeedTab, label: 'Feed', icon: <Newspaper size={15} /> },
              { id: 'notifications' as FeedTab, label: 'Notifications', icon: <Bell size={15} /> },
              { id: 'reactions' as FeedTab, label: 'Reactions', icon: <Heart size={15} /> },
              { id: 'bookmarks' as FeedTab, label: 'Bookmarks', icon: <Bookmark size={15} /> },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setFeedTab(tab.id); useSocialStore.getState().setActivePage('feed') }}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
                  activePage !== 'thread' && activePage !== 'profile' && feedTab === tab.id
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
            <button
              onClick={() => pubkey && setActiveProfile(pubkey)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
                activePage === 'profile'
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <User size={15} />
              Profile
            </button>
          </>
        ) : activeSection === 'long' ? (
          <>
            {([
              { id: 'longform-feed' as SocialPage, label: 'Feed', icon: <Newspaper size={15} /> },
              { id: 'longform-write' as SocialPage, label: 'Write', icon: <PenLine size={15} /> },
              { id: 'longform-mine' as SocialPage, label: 'My Articles', icon: <FolderOpen size={15} /> },
              { id: 'longform-drafts' as SocialPage, label: 'Drafts', icon: <FileArchive size={15} /> },
              { id: 'longform-bookmarks' as SocialPage, label: 'Bookmarks', icon: <Bookmark size={15} /> },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => useSocialStore.getState().setActivePage(tab.id)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
                  activePage === tab.id
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </>
        ) : (
          <div className="px-3 py-2.5 text-xs text-muted-foreground">Coming soon</div>
        )}
      </div>
    </div>
  )

  // Render sub-pages
  if (activePage === 'thread') {
    return (
      <>
        {LeftPanel}
        <div id="social-content" className="flex-1 flex flex-col min-w-0 bg-background relative">
          {MobileTabBar}
          <PostThread />
        </div>
      </>
    )
  }

  if (activePage === 'profile') {
    return (
      <>
        {LeftPanel}
        <div id="social-content" className="flex-1 flex flex-col min-w-0 bg-background relative">
          {MobileTabBar}
          <UserProfilePage />
        </div>
      </>
    )
  }

  // Long-form sub-pages — now with MobileTabBar
  if (activePage === 'longform-feed') {
    return (<>{LeftPanel}<div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">{MobileTabBar}<LongFormFeedPage /></div></>)
  }
  if (activePage === 'longform-read') {
    return (<>{LeftPanel}<div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">{MobileTabBar}<LongFormArticleReader /></div></>)
  }
  if (activePage === 'longform-write') {
    return (<>{LeftPanel}<div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">{MobileTabBar}<LongFormWritePage /></div></>)
  }
  if (activePage === 'longform-mine') {
    return (<>{LeftPanel}<div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">{MobileTabBar}<LongFormMinePage /></div></>)
  }
  if (activePage === 'longform-drafts') {
    return (<>{LeftPanel}<div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">{MobileTabBar}<LongFormDraftsPage /></div></>)
  }
  if (activePage === 'longform-bookmarks') {
    return (<>{LeftPanel}<div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">{MobileTabBar}<LongFormBookmarksPage /></div></>)
  }
  if (activePage === 'longform-draft-preview') {
    return (<>{LeftPanel}<div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">{MobileTabBar}<DraftPreviewPage /></div></>)
  }

  const tabTitles: Record<FeedTab, string> = { home: 'Social Feed', reactions: 'Reactions', bookmarks: 'Bookmarks', notifications: 'Notifications' }

  return (
    <>
      {LeftPanel}
      <div id="social-content" className="flex-1 flex flex-col min-w-0 bg-background relative">
        {/* Mobile tab bar — above header to match Long Form structure */}
        {MobileTabBar}

        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 min-h-12 border-b border-border shrink-0">
          <span className="font-semibold text-sm text-foreground">{tabTitles[feedTab]}</span>
          {feedTab === 'home' && (
            <Button variant="ghost" size="icon" onClick={handleRefresh} className="text-muted-foreground">
              <RefreshCw size={16} />
            </Button>
          )}
        </div>

        {/* ─── Home tab ─── */}
        {feedTab === 'home' && (
          <>
            <div className="shrink-0 overflow-y-scroll scrollbar-invisible">
              <div className="w-full mx-auto pt-4 pb-2 max-[1080px]:px-2" style={{ maxWidth: 640 }}>
                <ComposeBox />
              </div>
            </div>

            {/* Filter bar */}
            <div className="shrink-0 overflow-y-scroll scrollbar-invisible">
              <div className="w-full flex pb-2 px-2 border-b border-border/30" style={{ maxWidth: 640, width: '100%', margin: '0 auto' }}>
                <div className="flex items-center justify-end px-4 py-1 bg-secondary rounded-sm max-[1080px]:mx-2" style={{ maxWidth: 640, width: '100%', margin: '0 auto' }}>
                  <button
                    onClick={() => setShowFilterModal(true)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                  >
                    <SlidersHorizontal size={13} />
                    <span>Filters</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-scroll" ref={scrollRef}>
              <div className="w-full mx-auto space-y-3 py-2 max-[1080px]:px-2 max-[1080px]:pb-12" style={{ maxWidth: 640 }}>
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={24} className="animate-spin text-muted-foreground" />
                  </div>
                ) : !followsLoaded ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={24} className="animate-spin text-muted-foreground" />
                  </div>
                ) : follows.size === 0 && !pubkey ? (
                  <div className="text-center py-12 px-4">
                    <h3 className="text-lg font-semibold text-foreground mb-2">Your feed is empty</h3>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      You're not following anyone yet. Follow users from the chat or search to see their posts here.
                    </p>
                  </div>
                ) : posts.length === 0 ? (
                  <div className="text-center py-12 text-sm text-muted-foreground">
                    No recent posts from people you follow.
                  </div>
                ) : (
                  <FilteredFeed
                    posts={posts}
                    feedFilters={feedFilters}
                    onOpenProfile={setActiveProfile}
                    onOpenThread={setActiveThread}
                    sentinelRef={sentinelRef}
                    loadingMore={loadingMore}
                  />
                )}
              </div>
            </div>

            {/* Filter modal */}
            <FeedFilterModal
              open={showFilterModal}
              onClose={() => setShowFilterModal(false)}
              filters={feedFilters}
              setFilter={setFeedFilter}
            />
          </>
        )}

        {/* ─── Reactions tab ─── */}
        {feedTab === 'reactions' && (
          <div className="flex-1 overflow-y-auto">
            <div className="w-full mx-auto space-y-3 py-4 max-[1080px]:px-2 max-[1080px]:pb-12" style={{ maxWidth: 640 }}>
              {subLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-muted-foreground" />
                </div>
              ) : reactionPosts.length === 0 ? (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  No reacted posts yet.
                </div>
              ) : (
                reactionPosts.map((event) => (
                  <div key={event.id} className="rounded-md bg-secondary/50 overflow-hidden">
                    <SocialPost
                      event={event}
                      onOpenProfile={setActiveProfile}
                      onOpenThread={setActiveThread}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ─── Bookmarks tab ─── */}
        {feedTab === 'bookmarks' && (
          <div className="flex-1 overflow-y-auto">
            <div className="w-full mx-auto space-y-3 py-4 max-[1080px]:px-2 max-[1080px]:pb-12" style={{ maxWidth: 640 }}>
              {subLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-muted-foreground" />
                </div>
              ) : bookmarkPosts.length === 0 ? (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  No bookmarked posts yet.
                </div>
              ) : (
                bookmarkPosts.map((event) => (
                  <div key={event.id} className="rounded-md bg-secondary/50 overflow-hidden">
                    <SocialPost
                      event={event}
                      onOpenProfile={setActiveProfile}
                      onOpenThread={setActiveThread}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        {/* ─── Notifications tab ─── */}
        {feedTab === 'notifications' && (
          <SocialNotificationView
            onOpenProfile={setActiveProfile}
            onOpenThread={setActiveThread}
          />
        )}
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════ */
/*  SOCIAL NOTIFICATION VIEW                   */
/* ═══════════════════════════════════════════ */

type NotifType = 'mention' | 'reply' | 'reaction' | 'repost' | 'zap'
type NotifFilter = 'all' | NotifType

interface SocialNotification {
  id: string
  type: NotifType
  event: Event        // the notification event itself
  sourceEvent?: Event // the referenced post (resolved)
  createdAt: number
}

function SocialNotificationView({ onOpenProfile, onOpenThread }: {
  onOpenProfile: (pubkey: string) => void
  onOpenThread: (eventId: string) => void
}) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const socialSeenAt = useNotificationStore((s) => s.socialSeenAt)
  const updateSocialSeenAt = useNotificationStore((s) => s.updateSocialSeenAt)
  const setHasSocialNotification = useNotificationStore((s) => s.setHasSocialNotification)

  const [notifications, setNotifications] = useState<SocialNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [activeFilter, setActiveFilter] = useState<NotifFilter>('all')

  // Mark as seen when opening the tab
  useEffect(() => {
    setHasSocialNotification(false)
    // Debounce the relay publish slightly
    const timer = setTimeout(() => {
      updateSocialSeenAt(signer, privateKey)
    }, 2000)
    return () => clearTimeout(timer)
  }, [signer, privateKey, updateSocialSeenAt, setHasSocialNotification])

  // Fetch notification events on mount
  useEffect(() => {
    if (!myPubkey) { setLoading(false); return }

    const load = async () => {
      setLoading(true)
      try {
        // Fetch all event types that tag us
        const [mentions, reactions, reposts, zaps] = await Promise.all([
          fetchEvents({ kinds: [1], '#p': [myPubkey], limit: 50 }),
          fetchEvents({ kinds: [7], '#p': [myPubkey], limit: 50 }),
          fetchEvents({ kinds: [6], '#p': [myPubkey], limit: 30 }),
          fetchEvents({ kinds: [9735], '#p': [myPubkey], limit: 30 }),
        ])

        const notifs: SocialNotification[] = []

        // Process mentions — kind 1 events that tag us but aren't our own
        for (const event of mentions) {
          if (event.pubkey === myPubkey) continue
          const hasReplyTag = event.tags.some(t => t[0] === 'e')
          notifs.push({
            id: event.id,
            type: hasReplyTag ? 'reply' : 'mention',
            event,
            createdAt: event.created_at,
          })
        }

        // Process reactions
        for (const event of reactions) {
          if (event.pubkey === myPubkey) continue
          notifs.push({
            id: event.id,
            type: 'reaction',
            event,
            createdAt: event.created_at,
          })
        }

        // Process reposts
        for (const event of reposts) {
          if (event.pubkey === myPubkey) continue
          notifs.push({
            id: event.id,
            type: 'repost',
            event,
            createdAt: event.created_at,
          })
        }

        // Process zaps
        for (const event of zaps) {
          notifs.push({
            id: event.id,
            type: 'zap',
            event,
            createdAt: event.created_at,
          })
        }

        // Sort newest first
        notifs.sort((a, b) => b.createdAt - a.createdAt)

        // Resolve referenced posts for reactions/reposts
        const refIds = new Set<string>()
        for (const n of notifs) {
          if (n.type === 'reaction' || n.type === 'repost') {
            const eTag = n.event.tags.find(t => t[0] === 'e')
            if (eTag?.[1]) refIds.add(eTag[1])
          }
        }
        if (refIds.size > 0) {
          const resolved = await fetchEvents({ ids: [...refIds].slice(0, 50), limit: 50 })
          const resolvedMap = new Map(resolved.map(e => [e.id, e]))
          for (const n of notifs) {
            if (n.type === 'reaction' || n.type === 'repost') {
              const eTag = n.event.tags.find(t => t[0] === 'e')
              if (eTag?.[1]) n.sourceEvent = resolvedMap.get(eTag[1])
            }
          }
        }

        setNotifications(notifs)
      } catch (err) {
        console.error('[Social] Failed to fetch notifications:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [myPubkey])

  const filtered = useMemo(() => {
    if (activeFilter === 'all') return notifications
    return notifications.filter(n => n.type === activeFilter)
  }, [notifications, activeFilter])

  const filterTabs: { id: NotifFilter; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: 'All', icon: <Bell size={13} /> },
    { id: 'mention', label: 'Mentions', icon: <AtSign size={13} /> },
    { id: 'reply', label: 'Replies', icon: <MessageCircle size={13} /> },
    { id: 'reaction', label: 'Reactions', icon: <Heart size={13} /> },
    { id: 'zap', label: 'Zaps', icon: <Zap size={13} /> },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Sub-filter tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border/50 shrink-0 bg-background">
        {filterTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveFilter(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
              activeFilter === tab.id
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Notification list */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full mx-auto py-2" style={{ maxWidth: 640 }}>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-4">
              <Bell size={28} className="text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No notifications yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                When someone mentions you, reacts to your posts, or zaps you, it will show up here.
              </p>
            </div>
          ) : (
            <div className="flex flex-col">
              {filtered.map(notif => (
                <SocialNotificationRow
                  key={notif.id}
                  notif={notif}
                  socialSeenAt={socialSeenAt}
                  onOpenProfile={onOpenProfile}
                  onOpenThread={onOpenThread}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SocialNotificationRow({ notif, socialSeenAt, onOpenProfile, onOpenThread }: {
  notif: SocialNotification
  socialSeenAt: number
  onOpenProfile: (pubkey: string) => void
  onOpenThread: (eventId: string) => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(notif.event.pubkey)
  const npub = nip19.npubEncode(notif.event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(npub, 8)
  const isUnread = notif.createdAt > socialSeenAt

  // Type-specific icon and label
  const typeConfig: Record<NotifType, { icon: React.ReactNode; label: string; color: string }> = {
    mention: { icon: <AtSign size={14} />, label: 'mentioned you', color: 'text-blue-400' },
    reply: { icon: <MessageCircle size={14} />, label: 'replied to you', color: 'text-blue-400' },
    reaction: {
      icon: <Heart size={14} />,
      label: `reacted ${notif.event.content === '+' ? '❤️' : notif.event.content || '❤️'} to your post`,
      color: 'text-pink-400',
    },
    repost: { icon: <Repeat2 size={14} />, label: 'reposted your post', color: 'text-green-400' },
    zap: { icon: <Zap size={14} />, label: 'zapped you', color: 'text-yellow-400' },
  }
  const config = typeConfig[notif.type]

  // Get the referenced event ID for click handling
  // For replies: navigate to the parent post so the thread shows properly
  // For mentions: navigate to the mention event itself
  // For reactions/reposts: navigate to the reacted/reposted post
  const refEventId = (() => {
    if (notif.type === 'mention') return notif.event.id
    if (notif.type === 'reply') {
      // Find the root or reply-to event
      const rootTag = notif.event.tags.find(t => t[0] === 'e' && t[3] === 'root')
        || notif.event.tags.find(t => t[0] === 'e')
      return rootTag?.[1] || notif.event.id
    }
    // reactions, reposts, zaps — point to the referenced post
    return notif.event.tags.find(t => t[0] === 'e')?.[1]
  })()

  return (
    <button
      onClick={() => refEventId && onOpenThread(refEventId)}
      className={cn(
        'w-full flex gap-3 px-4 py-3 text-left transition-colors cursor-pointer hover:bg-accent/30 border-b border-border/20',
        isUnread && 'bg-primary/[0.03]'
      )}
    >
      {/* Unread dot + type icon */}
      <div className="flex flex-col items-center gap-1 pt-1 shrink-0">
        <span className={cn('shrink-0', config.color)}>
          {config.icon}
        </span>
        {isUnread && (
          <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
        )}
      </div>

      {/* Avatar */}
      <Avatar className="w-9 h-9 shrink-0 mt-0.5">
        {profile?.picture && <AvatarImage src={profile.picture} />}
        <AvatarFallback className="text-xs bg-primary/20 text-primary">
          {displayName.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            onClick={(e) => { e.stopPropagation(); onOpenProfile(notif.event.pubkey) }}
            className="text-sm font-semibold text-foreground hover:underline cursor-pointer"
          >
            {displayName}
          </span>
          <DnnBadge pubkey={notif.event.pubkey} />
          <span className="text-xs text-muted-foreground">{config.label}</span>
          <span className="text-[11px] text-muted-foreground/60">· {formatTimestamp(notif.createdAt)}</span>
        </div>

        {/* Message preview for mentions/replies */}
        {(notif.type === 'mention' || notif.type === 'reply') && notif.event.content && (
          <p className="text-sm text-foreground/70 mt-1 line-clamp-2 break-words">
            {notif.event.content.slice(0, 200)}
          </p>
        )}

        {/* Source post preview for reactions/reposts */}
        {(notif.type === 'reaction' || notif.type === 'repost') && notif.sourceEvent && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 break-words pl-2 border-l-2 border-border/50">
            {notif.sourceEvent.content.slice(0, 150)}
          </p>
        )}
      </div>
    </button>
  )
}

/* ─── Filtered Feed (smart post rendering) ─── */

import type { FeedFilters } from '@/stores/socialStore'

interface FilteredFeedProps {
  posts: Event[]
  feedFilters: FeedFilters
  onOpenProfile: (pubkey: string) => void
  onOpenThread: (eventId: string) => void
  sentinelRef: React.RefObject<HTMLDivElement | null>
  loadingMore: boolean
}

/** Categorise a nostr event:  root | quote-repost | repost | reply */
function classifyPost(event: Event): 'root' | 'quote-repost' | 'repost' | 'reply' {
  if (event.kind === 6) return 'repost'
  const hasQ = event.tags.some(t => t[0] === 'q')
  if (hasQ) return 'quote-repost'
  const hasE = event.tags.some(t => t[0] === 'e')
  if (hasE) return 'reply'
  return 'root'
}

/** Try to parse the inner event from a kind:6 repost */
function parseRepostInner(event: Event): Event | null {
  try {
    const inner = JSON.parse(event.content) as Event
    if (inner && inner.id && inner.pubkey && inner.content !== undefined) return inner
  } catch { /* not valid JSON, try e-tag fallback */ }
  return null
}

export function FilteredFeed({ posts, feedFilters, onOpenProfile, onOpenThread, sentinelRef, loadingMore }: FilteredFeedProps) {
  // Build filtered + deduped feed
  const feedItems = useMemo(() => {
    const items: Array<{ key: string; event: Event; type: 'root' | 'quote-repost' | 'repost' | 'reply'; repostedByPubkey?: string; replyParentId?: string }> = []
    // Track reposted event IDs for 24h dedup (repostTargetId -> oldest repost timestamp)
    const repostSeen = new Map<string, number>()

    for (const event of posts) {
      const type = classifyPost(event)

      if (type === 'root') {
        items.push({ key: event.id, event, type })
        continue
      }

      if (type === 'quote-repost' && feedFilters.showQuoteReposts) {
        items.push({ key: event.id, event, type })
        continue
      }

      if (type === 'repost' && feedFilters.showReposts) {
        const inner = parseRepostInner(event)
        if (!inner) continue
        const targetId = inner.id
        const existing = repostSeen.get(targetId)
        // Dedup within 24h: keep the oldest repost
        if (existing !== undefined) {
          const diff = Math.abs(event.created_at - existing)
          if (diff < 86400) continue // within 24h window, skip this duplicate
        }
        repostSeen.set(targetId, event.created_at)
        items.push({ key: `repost-${event.id}`, event: inner, type: 'repost', repostedByPubkey: event.pubkey })
        continue
      }

      if (type === 'reply' && feedFilters.showReplies) {
        // Find the root event ID (first 'e' tag with 'root' marker, or just first 'e' tag)
        const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root') || event.tags.find(t => t[0] === 'e')
        const replyParentId = rootTag?.[1]
        items.push({ key: event.id, event, type, replyParentId })
        continue
      }
    }

    return items
  }, [posts, feedFilters])

  return (
    <>
      {feedItems.map((item) => (
        <div key={item.key} className="rounded-md bg-secondary/50 overflow-hidden">
          {/* Repost attribution header */}
          {item.type === 'repost' && item.repostedByPubkey && (
            <RepostHeader pubkey={item.repostedByPubkey} onOpenProfile={onOpenProfile} />
          )}
          {/* Reply context: small preview of original post */}
          {item.type === 'reply' && item.replyParentId && (
            <ReplyContext eventId={item.replyParentId} onOpenThread={onOpenThread} />
          )}
          <SocialPost
            event={item.event}
            onOpenProfile={onOpenProfile}
            onOpenThread={onOpenThread}
          />
        </div>
      ))}
      <div ref={sentinelRef} className="h-1" />
      {loadingMore && (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={18} className="animate-spin text-muted-foreground" />
        </div>
      )}
    </>
  )
}

/* ─── Repost Header ─── */

function RepostHeader({ pubkey, onOpenProfile }: { pubkey: string; onOpenProfile: (pk: string) => void }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey)
  const name = profile?.display_name || profile?.name || pubkey.slice(0, 8) + '...'
  return (
    <button
      onClick={() => onOpenProfile(pubkey)}
      className="flex items-center gap-1.5 px-4 pt-2.5 pb-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      <Repeat2 size={12} />
      <span>{name} reposted</span>
    </button>
  )
}

/* ─── Reply Context (compact preview of the original post) ─── */

const replyCache = new Map<string, Event | null>()

function ReplyContext({ eventId, onOpenThread }: { eventId: string; onOpenThread: (id: string) => void }) {
  const [parent, setParent] = useState<Event | null>(null)
  const [fetched, setFetched] = useState(false)
  const { getProfile } = useProfileCache()

  useEffect(() => {
    if (replyCache.has(eventId)) {
      setParent(replyCache.get(eventId) ?? null)
      setFetched(true)
      return
    }
    fetchEvents({ ids: [eventId], limit: 1 }).then((events) => {
      const ev = events[0] ?? null
      replyCache.set(eventId, ev)
      setParent(ev)
      setFetched(true)
    }).catch(() => setFetched(true))
  }, [eventId])

  if (!fetched || !parent) return null

  const profile = getProfile(parent.pubkey)
  const name = profile?.display_name || profile?.name || parent.pubkey.slice(0, 8) + '...'

  return (
    <button
      onClick={() => onOpenThread(eventId)}
      className="w-full flex items-center gap-2 px-4 py-1.5 bg-secondary/30 border-b border-border/30 max-h-[50px] overflow-hidden text-left cursor-pointer hover:bg-secondary/50 transition-colors"
    >
      <span className="text-[10px] text-muted-foreground/60 shrink-0">↩</span>
      <span className="text-[11px] font-medium text-muted-foreground shrink-0">{name}</span>
      <span className="text-[11px] text-muted-foreground/60 truncate min-w-0">{parent.content.slice(0, 120)}</span>
    </button>
  )
}

/* ─── Feed Filter Modal ─── */

export function FeedFilterModal({
  open,
  onClose,
  filters,
  setFilter,
}: {
  open: boolean
  onClose: () => void
  filters: FeedFilters
  setFilter: <K extends keyof FeedFilters>(key: K, value: FeedFilters[K]) => void
}) {
  if (!open) return null

  const toggles: Array<{ key: keyof FeedFilters; label: string; description: string }> = [
    { key: 'showQuoteReposts', label: 'Quote Reposts', description: 'Posts that quote and comment on another post' },
    { key: 'showReposts', label: 'Reposts', description: 'Reposted content from people you follow' },
    { key: 'showReplies', label: 'Reply Posts', description: 'Replies to other posts from people you follow' },
  ]

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm mx-4 rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="font-semibold text-sm text-foreground">Feed Filters</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-3 flex flex-col gap-3">
          {toggles.map((t) => (
            <label key={t.key} className="flex items-center justify-between gap-3 cursor-pointer group">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{t.label}</div>
                <div className="text-[11px] text-muted-foreground">{t.description}</div>
              </div>
              <button
                onClick={() => setFilter(t.key, !filters[t.key])}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 cursor-pointer ${filters[t.key] ? 'bg-primary' : 'bg-secondary'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${filters[t.key] ? 'translate-x-4' : ''}`} />
              </button>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
