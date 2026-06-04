/**
 * UserProfilePage — Social profile page for any user
 * Banner, avatar, name, bio, follow/DM buttons, and their kind:1 posts
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { useUserStore } from '@/stores/userStore'
import { useSocialStore } from '@/stores/socialStore'
import { useFollowStore } from '@/stores/followStore'
import { useBlockStore } from '@/stores/blockStore'
import type { BlockType } from '@/stores/blockStore'
import { BlockTypeModal } from '@/components/ui/BlockTypeModal'
import { FollowSafetyModal } from '@/components/ui/FollowSafetyModal'
import { useNavigationStore } from '@/stores/navigationStore'
import { useDMStore } from '@/stores/dmStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { FilteredFeed, FeedFilterModal } from '@/components/social/SocialFeedPage'
import { ArticleCardItem, dedupeAndFilter, type ArticleCard } from '@/components/social/LongFormFeedPage'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  ArrowLeft, UserPlus, UserMinus, Copy, Check, Loader2,
  MessageCircle, Globe, Zap, AtSign, MoreVertical, Pencil,
  ShieldBan, ShieldCheck, SlidersHorizontal, Newspaper,
} from 'lucide-react'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'

/** Banner image with blossom fallback */
function BlossomBannerImg({ src }: { src: string }) {
  const blossom = useBlossomMedia(src)
  return <img src={blossom.src || src} alt="Banner" className="w-full h-full object-cover" />
}

export function UserProfilePage() {
  const activeProfilePubkey = useSocialStore((s) => s.activeProfilePubkey)
  const goBack = useSocialStore((s) => s.goBack)
  const setActiveThread = useSocialStore((s) => s.setActiveThread)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)

  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const { getProfile } = useProfileCache()
  const followStore = useFollowStore()

  const blockStore = useBlockStore()

  const [userPosts, setUserPosts] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [showFilterModal, setShowFilterModal] = useState(false)
  const [showBlockTypeModal, setShowBlockTypeModal] = useState(false)
  const feedFilters = useSocialStore((s) => s.feedFilters)

  // Follow safety modal state
  const [showFollowSafetyModal, setShowFollowSafetyModal] = useState(false)
  const [pendingFollowSafetyStatus, setPendingFollowSafetyStatus] = useState<'empty-list' | 'not-loaded' | 'load-error'>('empty-list')
  const setFeedFilter = useSocialStore((s) => s.setFeedFilter)
  const setActiveArticle = useSocialStore((s) => s.setActiveArticle)

  // ── Tab state ──
  type ProfileTab = 'short' | 'long'
  const [profileTab, setProfileTab] = useState<ProfileTab>('short')

  // ── Long-form article state ──
  const [longArticles, setLongArticles] = useState<ArticleCard[]>([])
  const [longLoading, setLongLoading] = useState(false)
  const longLoadedRef = useRef<string | null>(null) // track which pubkey we loaded for

  const pubkey = activeProfilePubkey
  const isSelf = pubkey === myPubkey
  const following = pubkey ? followStore.isFollowing(pubkey) : false
  const blocked = pubkey ? blockStore.isBlocked(pubkey) : false

  const profile = pubkey ? getProfile(pubkey) : undefined
  const npub = pubkey ? nip19.npubEncode(pubkey) : ''
  const displayName = profile?.display_name || profile?.name || truncateNpub(npub)

  // Fetch user's short-form posts
  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    setUserPosts([])
    setProfileTab('short') // reset tab on profile change
    longLoadedRef.current = null // reset long-form cache
    setLongArticles([])

    fetchEvents({ kinds: [1, 6], authors: [pubkey], limit: 80 }).then((events) => {
      setUserPosts(events.sort((a, b) => b.created_at - a.created_at))
      setLoading(false)
    })
  }, [pubkey])

  // Fetch user's long-form articles (lazy — only when tab switches to 'long')
  useEffect(() => {
    if (profileTab !== 'long' || !pubkey || longLoadedRef.current === pubkey) return
    longLoadedRef.current = pubkey
    setLongLoading(true)
    fetchEvents({ kinds: [30023], authors: [pubkey], limit: 100 }).then((events) => {
      setLongArticles(dedupeAndFilter(events))
      setLongLoading(false)
    })
  }, [profileTab, pubkey])

  const loadMore = useCallback(async () => {
    if (!pubkey || userPosts.length === 0 || loadingMoreRef.current) return
    setLoadingMore(true)
    loadingMoreRef.current = true
    try {
      const oldest = userPosts[userPosts.length - 1]
      const events = await fetchEvents({
        kinds: [1, 6],
        authors: [pubkey],
        until: oldest.created_at,
        limit: 80,
      })
      setUserPosts((prev) => {
        const ids = new Set(prev.map((e) => e.id))
        const fresh = events.filter((e) => !ids.has(e.id))
        return [...prev, ...fresh].sort((a, b) => b.created_at - a.created_at)
      })
    } catch (err) {
      console.error('Failed to load more profile posts:', err)
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [pubkey, userPosts])

  // Infinite scroll observer
  useEffect(() => {
    const sentinel = sentinelRef.current
    const scroll = scrollRef.current
    if (!sentinel || !scroll) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMoreRef.current && userPosts.length > 0) {
          loadMore()
        }
      },
      { root: scroll, rootMargin: '0px 0px 800px 0px', threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore, userPosts.length])

  const handleFollow = async () => {
    if (!myPubkey || !pubkey || (!signer && !privateKey)) return

    // For follow (not unfollow), check safety status
    if (!following) {
      const safety = followStore.getFollowSafetyStatus()
      if (safety !== 'safe') {
        setPendingFollowSafetyStatus(safety as 'empty-list' | 'not-loaded' | 'load-error')
        setShowFollowSafetyModal(true)
        return
      }
    }

    await executeFollow()
  }

  const executeFollow = async () => {
    if (!myPubkey || !pubkey || (!signer && !privateKey)) return
    setFollowLoading(true)
    try {
      if (following) {
        await followStore.unfollowUser(pubkey, myPubkey, signer, privateKey)
      } else {
        await followStore.followUser(pubkey, myPubkey, signer, privateKey)
      }
    } catch (err) {
      console.error('Failed to toggle follow:', err)
    } finally {
      setFollowLoading(false)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(npub)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDM = () => {
    if (!pubkey) return
    useDMStore.getState().setActiveConversation(pubkey)
    useNavigationStore.getState().setActivePage('dms')
  }

  const handleToggleBlock = async () => {
    if (!myPubkey || !pubkey || (!signer && !privateKey)) return
    setShowDropdown(false)
    if (blocked) {
      await blockStore.unblockUser(pubkey, myPubkey, signer, privateKey)
    } else {
      setShowBlockTypeModal(true)
    }
  }

  const handleBlockWithType = async (blockType: BlockType) => {
    if (!myPubkey || !pubkey) return
    setShowBlockTypeModal(false)
    await blockStore.blockUser(pubkey, myPubkey, signer, privateKey, blockType)
  }

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!pubkey) return null

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-12 min-h-12 border-b border-border shrink-0">
        <button onClick={goBack} className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
          <ArrowLeft size={18} />
        </button>
        <span className="font-semibold text-sm text-foreground">{displayName}</span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full mx-auto py-4 px-2" style={{ maxWidth: 640 }}>
          {/* Profile card with background */}
          <div className="rounded-xl bg-secondary/50 overflow-hidden">
            {/* Banner */}
            <div className="h-40 bg-gradient-to-br from-primary/30 via-secondary to-primary/10 relative overflow-hidden">
              {profile?.banner && (
                <BlossomBannerImg src={profile.banner} />
              )}
            </div>

            {/* Profile info area */}
            <div className="px-5 pb-5 relative" style={{ marginTop: -40 }}>
              {/* Row: avatar on left, action buttons on right */}
              <div className="flex items-end justify-between mb-3">
                <Avatar className="h-20 w-20 border-4 border-background shadow-lg">
                  {profile?.picture && <AvatarImage src={profile.picture} />}
                  <AvatarFallback className="text-xl bg-primary text-primary-foreground font-bold">
                    {displayName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>

                {isSelf && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowEditModal(true)}
                      className="gap-1.5 rounded-full"
                    >
                      <Pencil size={13} /> Edit Profile
                    </Button>
                  </div>
                )}

                {!isSelf && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDM}
                      className="gap-1.5 rounded-full"
                    >
                      <MessageCircle size={14} /> Message
                    </Button>
                    <Button
                      variant={following ? 'outline' : 'default'}
                      size="sm"
                      onClick={handleFollow}
                      disabled={followLoading}
                      className="gap-1.5 rounded-full"
                    >
                      {followLoading ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : following ? (
                        <><UserMinus size={13} /> Unfollow</>
                      ) : (
                        <><UserPlus size={13} /> Follow</>
                      )}
                    </Button>
                    {/* 3-dot menu */}
                    <div className="relative" ref={dropdownRef}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowDropdown(!showDropdown)}
                        className="h-8 w-8 p-0 rounded-full"
                      >
                        <MoreVertical size={14} />
                      </Button>
                      {showDropdown && (
                        <div className="absolute right-0 top-full mt-1 w-48 rounded-xl border border-border bg-popover/95 backdrop-blur-md shadow-xl z-50 p-1 flex flex-col gap-1 animate-in fade-in-0 zoom-in-95">
                          <button
                            onClick={handleToggleBlock}
                            className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm transition-colors cursor-pointer rounded-md ${blocked
                              ? 'text-foreground hover:bg-accent/50'
                              : 'text-destructive hover:bg-destructive/10'
                              }`}
                          >
                            {blocked ? (
                              <><ShieldCheck size={14} className="text-muted-foreground" /> Unblock User</>
                            ) : (
                              <><ShieldBan size={14} /> Block User</>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Name + handle */}
              <div className="mb-2">
                <h2 className="text-xl font-bold text-foreground leading-tight">{displayName}</h2>
                {profile?.name && profile?.display_name && (
                  <span className="text-sm text-muted-foreground">@{profile.name}</span>
                )}
              </div>

              {/* npub */}
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer mb-3 px-2 py-1 rounded-md bg-background/50 hover:bg-background/80"
              >
                <span className="font-mono">{truncateNpub(npub, 12)}</span>
                {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              </button>

              {/* Bio */}
              {profile?.about && (
                <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed mb-3">{profile.about}</p>
              )}

              {/* Meta info row */}
              {(profile?.nip05 || profile?.website || profile?.lud16) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  {profile?.nip05 && (
                    <span className="flex items-center gap-1">
                      <AtSign size={12} className="text-primary" />
                      <span>{profile.nip05}</span>
                    </span>
                  )}
                  {profile?.website && (
                    <a
                      href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline"
                    >
                      <Globe size={12} />
                      <span>{profile.website.replace(/^https?:\/\//, '')}</span>
                    </a>
                  )}
                  {profile?.lud16 && (
                    <span className="flex items-center gap-1">
                      <Zap size={12} className="text-amber-400" />
                      <span>{profile.lud16}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Tab bar + Posts section */}
          <div className="mt-3">
            {/* Tab bar */}
            <div className="flex items-center gap-0 border-b border-border mb-3">
              <button
                onClick={() => setProfileTab('short')}
                className={`px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer relative ${
                  profileTab === 'short'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Short
                {profileTab === 'short' && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
              <button
                onClick={() => setProfileTab('long')}
                className={`px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer relative ${
                  profileTab === 'long'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Long
                {profileTab === 'long' && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>

              {/* Filter button — only for short tab */}
              {profileTab === 'short' && (
                <div className="ml-auto">
                  <button
                    onClick={() => setShowFilterModal(true)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                  >
                    <SlidersHorizontal size={13} />
                    <span>Filters</span>
                  </button>
                </div>
              )}
            </div>

            {/* Short-form posts */}
            {profileTab === 'short' && (
              <>
                <div ref={scrollRef} className="space-y-3 pb-4">
                  {loading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 size={22} className="animate-spin text-muted-foreground" />
                    </div>
                  ) : userPosts.length === 0 ? (
                    <div className="text-center py-12 text-sm text-muted-foreground">No posts yet.</div>
                  ) : (
                    <FilteredFeed
                      posts={userPosts}
                      feedFilters={feedFilters}
                      onOpenProfile={setActiveProfile}
                      onOpenThread={setActiveThread}
                      sentinelRef={sentinelRef}
                      loadingMore={loadingMore}
                    />
                  )}
                </div>

                <FeedFilterModal
                  open={showFilterModal}
                  onClose={() => setShowFilterModal(false)}
                  filters={feedFilters}
                  setFilter={setFeedFilter}
                />
              </>
            )}

            {/* Long-form articles */}
            {profileTab === 'long' && (
              <div className="pb-4">
                {longLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={22} className="animate-spin text-muted-foreground" />
                  </div>
                ) : longArticles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
                    <Newspaper size={28} className="text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No long-form articles yet.</p>
                  </div>
                ) : (
                  <div className="grid gap-3 grid-cols-1 min-[480px]:grid-cols-2">
                    {longArticles.map((article) => (
                      <ArticleCardItem
                        key={`${article.event.pubkey}:${article.dTag}`}
                        article={article}
                        onOpenArticle={setActiveArticle}
                        onOpenProfile={setActiveProfile}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit Profile Modal */}
      <UserProfileModal open={showEditModal} onClose={() => setShowEditModal(false)} startEditing />
      {/* Block type modal */}
      <BlockTypeModal
        open={showBlockTypeModal}
        onClose={() => setShowBlockTypeModal(false)}
        onSelect={handleBlockWithType}
        displayName={displayName}
      />
      {/* Follow safety warning modal */}
      {pubkey && (
        <FollowSafetyModal
          open={showFollowSafetyModal}
          onClose={() => setShowFollowSafetyModal(false)}
          targetPubkey={pubkey}
          onConfirmFollow={executeFollow}
          status={pendingFollowSafetyStatus}
        />
      )}
    </div>
  )
}
