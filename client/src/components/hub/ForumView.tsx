/**
 * ForumView ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Forum-style channel view
 *
 * Renders forum posts in a grid or list layout with search, filters,
 * numbered pagination, create post modal, and full post detail view
 * with threaded replies using the shared ChatInputBar.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { getForumDraft, setForumDraft, clearDraft, forumDraftKey } from '@/stores/draftStore'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useBlockStore } from '@/stores/blockStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useNavigationStore } from '@/stores/navigationStore'
import { useMessages, type ChatMessage } from '@/hooks/useMessages'
import { fetchOlderMessages, PAGE_SIZE } from '@/hooks/useHubSubscriptions'
import { useProfileCache } from '@/hooks/useProfileCache'
import { uploadToBlossomServers, computeHash, blossomServers as blossomServerManager } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { ChatInputBar, type FileAttachment } from '@/components/chat/ChatInputBar'
import { MessageContent } from '@/components/chat/MessageContent'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { ReportModal } from '@/components/hub/ReportModal'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ChatMessageRow, MessageInput, DeleteConfirmDialog, RawEventModal,
  useDecryptedReactions,
  type OptimisticMessage, type ReplyContext, type Reaction,
} from '@/components/hub/ChannelView'
import { cn } from '@/lib/utils'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import {
  MessagesSquare, Search, Plus, LayoutGrid, List, ChevronLeft, ChevronRight,
  SlidersHorizontal, X, ArrowLeft, MoreHorizontal, Pencil, Trash2,
  Loader2, Clock, MessageSquare, Tag as TagIcon, Image as ImageIcon,
  Calendar, User, Check, MessageSquarePlus, Copy, Flag, EyeOff,
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  List as ListIcon, ListOrdered, Link, Code, CodeSquare, Eye, Smile, ALargeSmall,
  Upload, FileIcon,
} from 'lucide-react'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import type { Attachment } from '@/stores/messageStore'
import { useMessageStore } from '@/stores/messageStore'
import { usePermissions, getPermissionsForUser } from '@/lib/hub/permissions'
import { useMobile } from '@/hooks/useMobile'

const FORUM_PAGE_SIZE = 12
const FORUM_PLACEHOLDER = '/assets/forum-placeholder.jpg'
const EMPTY_HIDDEN: Record<string, any> = {}
const EMPTY_REACTIONS: Record<string, import('@/stores/messageStore').StoredReaction[]> = {}

/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Types ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

interface ForumPost extends ChatMessage {
  replyCount: number
}

/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ForumView (exported) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

export function ForumView() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hubMembers = useHubStore((s) => activeHubId ? s.hubMembers[activeHubId] : undefined)
  const hubPrefs = useHubStore((s) => activeHubId ? s.hubPrefs[activeHubId] : undefined)

  const channel = hub?.channels.find((c) => c.channelId === activeChannelId)
  const { messages, sendMessage, editMessage, deleteMessage, publishReaction, unreactReaction, getChannelKey } = useMessages(activeHubId || '', activeChannelId || '')

  // Membership check
  const isMember = !!(pubkey && hubMembers?.some((m) => m.pubkey === pubkey))
  const hubFacilitatorMembers = useHubStore((s) => activeHubId ? s.hubFacilitatorMembers[activeHubId] : undefined)
  const facilitatorPk = hubPrefs?.facilitator
  const isFacilitated = !isMember
    && !!facilitatorPk
    && !!hubMembers?.some((m) => m.pubkey === facilitatorPk)
    && !!(hubFacilitatorMembers?.[facilitatorPk]?.includes(pubkey!))

  // Role-based permission resolution
  const perms = usePermissions(activeHubId || undefined, activeChannelId || undefined)
  const canPublish = (isMember || isFacilitated) && perms.send_messages

  // Hidden messages state
  const hiddenMessages = useHubStore((s) => (activeHubId ? s.hiddenMessages[activeHubId] : undefined) ?? EMPTY_HIDDEN)
  const isCreatorForHide = !!(pubkey && hub?.creatorPubkey === pubkey)
  const canHide = isCreatorForHide || perms.hide_messages

  // ── Per-channel initial fetch ──
  // The global subscription fetches the latest 50 messages across ALL channels.
  // Forum posts in less-active channels may not appear. Eagerly fetch for this channel.
  const [initialLoading, setInitialLoading] = useState(false)
  const fetchedChannelsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!activeHubId || !activeChannelId) return
    const key = `${activeHubId}:${activeChannelId}`
    if (fetchedChannelsRef.current.has(key)) return
    fetchedChannelsRef.current.add(key)

    setInitialLoading(true)
    const now = Math.floor(Date.now() / 1000) + 1
    fetchOlderMessages(activeHubId, activeChannelId, now).then(() => {
      setInitialLoading(false)
    }).catch(() => {
      setInitialLoading(false)
    })
  }, [activeHubId, activeChannelId])

  // UI state
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [showFilterModal, setShowFilterModal] = useState(false)
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [filterAuthor, setFilterAuthor] = useState('')

  // Reset page when filters change
  useEffect(() => { setCurrentPage(1) }, [searchQuery, filterTags, filterAuthor, activeChannelId])

  // Separate forum posts from replies
  const { forumPosts, forumReplies } = useMemo(() => {
    const posts: ForumPost[] = []
    const replies: ChatMessage[] = []

    for (const msg of messages) {
      if (msg.deleted) continue
      if (msg.isForum && msg.title) {
        // Check if this post is hidden — non-mods should not see it
        const postRef = `36943:${msg.pubkey}:${msg.dTag}`
        const isHiddenPost = !!hiddenMessages[postRef]
        if (isHiddenPost && !canHide) continue
        posts.push({ ...msg, replyCount: 0 })
      } else if (msg.rootRef || msg.replyTo) {
        replies.push(msg)
      }
    }

    // Count replies per post
    for (const reply of replies) {
      const rootKey = reply.rootRef
      if (rootKey) {
        const post = posts.find(p => {
          const aTag = `36943:${p.pubkey}:${p.dTag}`
          return aTag === rootKey
        })
        if (post) post.replyCount++
      }
    }

    // Sort newest first
    posts.sort((a, b) => b.timestamp - a.timestamp)
    return { forumPosts: posts, forumReplies: replies }
  }, [messages, hiddenMessages, canHide])

  // Filter + search
  const filteredPosts = useMemo(() => {
    let result = forumPosts

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(p =>
        (p.title?.toLowerCase().includes(q)) ||
        (p.content?.toLowerCase().includes(q))
      )
    }

    if (filterTags.length > 0) {
      result = result.filter(p =>
        p.forumTags?.some(t => filterTags.includes(t.toLowerCase()))
      )
    }

    if (filterAuthor.trim()) {
      const a = filterAuthor.toLowerCase()
      result = result.filter(p => {
        try {
          const npub = nip19.npubEncode(p.pubkey)
          return npub.includes(a) || p.pubkey.includes(a)
        } catch {
          return p.pubkey.includes(a)
        }
      })
    }

    return result
  }, [forumPosts, searchQuery, filterTags, filterAuthor])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / FORUM_PAGE_SIZE))
  const pagedPosts = useMemo(() => {
    const start = (currentPage - 1) * FORUM_PAGE_SIZE
    return filteredPosts.slice(start, start + FORUM_PAGE_SIZE)
  }, [filteredPosts, currentPage])

  // Get selected post
  const selectedPost = selectedPostId ? forumPosts.find(p => p.dTag === selectedPostId) : null

  // Get replies for selected post
  const selectedPostReplies = useMemo(() => {
    if (!selectedPost) return []
    const postATag = `36943:${selectedPost.pubkey}:${selectedPost.dTag}`
    return messages.filter(m =>
      !m.deleted && (m.rootRef === postATag) && m.dTag !== selectedPost.dTag
    ).sort((a, b) => a.timestamp - b.timestamp)
  }, [selectedPost, messages])

  if (!channel || !hub) return null

  const isCreator = pubkey && hub.creatorPubkey === pubkey

  const isMobile = useMobile()
  const setMobileView = useNavigationStore((s) => s.setMobileView)

  return (
    <div className="flex flex-col h-full bg-background">
      {selectedPost ? (
        <ForumPostDetail
          post={selectedPost}
          replies={selectedPostReplies}
          allMessages={messages}
          onBack={() => setSelectedPostId(null)}
          canPublish={canPublish}
          isCreator={!!isCreator}
          pubkey={pubkey || ''}
          sendMessage={sendMessage}
          deleteMessage={deleteMessage}
          editMessage={editMessage}
          signer={signer}
          privateKey={privateKey}
          hub={hub}
          hubDTag={activeHubId || ''}
          channelId={activeChannelId || ''}
          publishReaction={publishReaction}
          unreactReaction={unreactReaction}
          getChannelKey={getChannelKey}
        />
      ) : (
        <>
          {/* Forum Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              {isMobile && (
                <button
                  onClick={() => setMobileView('home')}
                  className="shrink-0 p-1 -ml-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <MessagesSquare size={18} className="text-muted-foreground shrink-0" />
              <h2 className="font-semibold text-sm text-foreground truncate">{channel.name}</h2>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* View toggle */}
              <div className="flex items-center border border-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode('grid')}
                  className={cn(
                    'p-1.5 transition-colors cursor-pointer',
                    viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  )}
                >
                  <LayoutGrid size={14} />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={cn(
                    'p-1.5 transition-colors cursor-pointer',
                    viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  )}
                >
                  <List size={14} />
                </button>
              </div>

              {/* Create post button */}
              {canPublish && (
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  <Plus size={14} />
                  Create Post
                </button>
              )}
            </div>
          </div>

          {/* Search + Filter Bar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-secondary/30">
            <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border focus-within:border-primary/40 transition-colors">
              <Search size={14} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search posts..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-muted-foreground hover:text-foreground cursor-pointer">
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              onClick={() => setShowFilterModal(true)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer',
                filterTags.length > 0 || filterAuthor
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/50'
              )}
            >
              <SlidersHorizontal size={13} />
              Filters
              {(filterTags.length > 0 || filterAuthor) && (
                <span className="w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center">
                  {filterTags.length + (filterAuthor ? 1 : 0)}
                </span>
              )}
            </button>
          </div>

          {/* Post List */}
          <div className="flex-1 overflow-y-auto p-4">
            {initialLoading && filteredPosts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Loader2 size={24} className="text-primary animate-spin mb-3" />
                <p className="text-sm text-muted-foreground">Loading posts...</p>
              </div>
            ) : filteredPosts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <MessagesSquare size={40} className="text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery || filterTags.length > 0
                    ? 'No posts match your search'
                    : 'No posts yet'}
                </p>
                {canPublish && !searchQuery && filterTags.length === 0 && (
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="mt-3 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                  >
                    Create the first post
                  </button>
                )}
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {pagedPosts.map(post => (
                  <ForumPostCard key={post.dTag} post={post} onClick={() => setSelectedPostId(post.dTag)} isHidden={!!hiddenMessages[`36943:${post.pubkey}:${post.dTag}`]} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {pagedPosts.map(post => (
                  <ForumPostRow key={post.dTag} post={post} onClick={() => setSelectedPostId(post.dTag)} isHidden={!!hiddenMessages[`36943:${post.pubkey}:${post.dTag}`]} />
                ))}
              </div>
            )}

            {/* Numbered pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-1 pt-6 pb-2">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                  className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={14} />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => setCurrentPage(p)}
                    className={`w-7 h-7 rounded text-xs font-medium transition-colors cursor-pointer ${p === currentPage
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                  className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Create Post Modal */}
      {showCreateModal && (
        <CreateForumPostModal
          onClose={() => setShowCreateModal(false)}
          sendMessage={sendMessage}
          canPublish={canPublish}
          signer={signer}
          privateKey={privateKey}
          hub={hub}
          hubDTag={activeHubId || ''}
          channelId={activeChannelId || ''}
        />
      )}

      {/* Filter Modal */}
      <ForumFilterModal
        open={showFilterModal}
        onClose={() => setShowFilterModal(false)}
        filterTags={filterTags}
        setFilterTags={setFilterTags}
        filterAuthor={filterAuthor}
        setFilterAuthor={setFilterAuthor}
        availableTags={[...new Set(forumPosts.flatMap(p => p.forumTags || []))]}
      />
    </div>
  )
}

/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Forum Post Card (Grid View) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

function ForumPostCard({ post, onClick, isHidden }: { post: ForumPost; onClick: () => void; isHidden?: boolean }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(post.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(post.pubkey))

  return (
    <button
      onClick={onClick}
      className={`group flex flex-col rounded-xl border bg-card overflow-hidden hover:shadow-lg transition-all cursor-pointer text-left ${isHidden ? 'border-amber-500/30 opacity-70' : 'border-border hover:border-primary/30'}`}
    >
      {/* Featured image or placeholder */}
      <div className="w-full h-40 overflow-hidden bg-secondary relative">
        {post.featuredImage ? (
          <BlossomImage
            src={post.featuredImage}
            alt={post.title || ''}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <img
            src={FORUM_PLACEHOLDER}
            alt=""
            className="w-full h-full object-cover opacity-60"
          />
        )}
        {isHidden && (
          <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/90 text-white text-[10px] font-medium">
            <EyeOff size={10} /> Hidden
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col gap-2 p-3 flex-1">
        <h3 className="font-semibold text-sm text-foreground line-clamp-2 group-hover:text-primary transition-colors">
          {post.title}
        </h3>

        {post.content && (
          <p className="text-xs text-muted-foreground line-clamp-2">{post.content}</p>
        )}

        {/* Tags */}
        {post.forumTags && post.forumTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {post.forumTags.slice(0, 3).map(tag => (
              <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary font-medium">
                {tag}
              </span>
            ))}
            {post.forumTags.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{post.forumTags.length - 3}</span>
            )}
          </div>
        )}

        {/* Meta */}
        <div className="flex items-center justify-between mt-auto pt-2 border-t border-border/50">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] text-muted-foreground truncate">{displayName}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0 text-muted-foreground">
            <span className="flex items-center gap-1 text-[11px]">
              <MessageSquare size={11} />
              {post.replyCount}
            </span>
            <span className="text-[11px]">
              {new Date(post.timestamp * 1000).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}

/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Forum Post Row (List View) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

function ForumPostRow({ post, onClick, isHidden }: { post: ForumPost; onClick: () => void; isHidden?: boolean }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(post.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(post.pubkey))

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-4 px-4 py-3 rounded-lg border bg-card hover:bg-accent/20 transition-all cursor-pointer text-left w-full ${isHidden ? 'border-amber-500/30 opacity-70' : 'border-border hover:border-primary/30'}`}
    >
      {/* Thumbnail */}
      <div className="w-16 h-16 rounded-lg overflow-hidden bg-secondary shrink-0">
        {post.featuredImage ? (
          <BlossomImage src={post.featuredImage} alt="" className="w-full h-full object-cover" />
        ) : (
          <img src={FORUM_PLACEHOLDER} alt="" className="w-full h-full object-cover opacity-60" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-sm text-foreground truncate">{post.title}</h3>
        {post.content && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{post.content}</p>
        )}
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{displayName}</span>
          <span>{new Date(post.timestamp * 1000).toLocaleDateString()}</span>
          {post.forumTags && post.forumTags.length > 0 && (
            <div className="flex items-center gap-1">
              {post.forumTags.slice(0, 2).map(t => (
                <span key={t} className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Hidden badge */}
      {isHidden && (
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-medium shrink-0">
          <EyeOff size={10} /> Hidden
        </div>
      )}

      {/* Reply count */}
      <div className="flex items-center gap-1 text-muted-foreground shrink-0">
        <MessageSquare size={13} />
        <span className="text-xs">{post.replyCount}</span>
      </div>
    </button>
  )
}

/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Forum Post Detail ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

interface ForumPostDetailProps {
  post: ForumPost
  replies: ChatMessage[]
  allMessages: ChatMessage[]
  onBack: () => void
  canPublish: boolean
  isCreator: boolean
  pubkey: string
  sendMessage: (...args: any[]) => Promise<void>
  deleteMessage: (dTag: string) => Promise<void>
  editMessage: (dTag: string, newText: string, replyTo?: string, rootRef?: string, forumFields?: { title: string; featuredImage?: string; tags?: string[] }) => Promise<void>
  signer: any
  privateKey: string | null
  hub: any
  hubDTag: string
  channelId: string
  publishReaction: (emoji: string, targetEventId: string, targetPubkey: string, targetDTag: string, customUrl?: string) => Promise<void>
  unreactReaction: (reactionEventId: string) => Promise<void>
  getChannelKey: (epoch?: number) => Uint8Array | null
}

function ForumPostDetail({
  post, replies, onBack, canPublish, isCreator, pubkey,
  sendMessage, deleteMessage, editMessage, signer, privateKey, hub,
  hubDTag, channelId, publishReaction, unreactReaction, getChannelKey,
}: ForumPostDetailProps) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(post.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(post.pubkey))
  const avatarUrl = profile?.picture
  const isOwnPost = post.pubkey === pubkey
  const containerRef = useRef<HTMLDivElement>(null)

  // Hidden messages
  const hiddenMessages = useHubStore((s) => s.hiddenMessages[hubDTag] ?? EMPTY_HIDDEN)
  const permsForHide = usePermissions(hubDTag, channelId)
  const canHide = isCreator || permsForHide.hide_messages
  const postRef = `36943:${post.pubkey}:${post.dTag}`
  const isPostHidden = !!hiddenMessages[postRef]
  const [hideInProgress, setHideInProgress] = useState(false)

  const handleHidePost = useCallback(async () => {
    if (!canHide) return
    setHideInProgress(true)
    try {
      const { createHideMessageEvent } = await import('@/lib/nostr/events')
      const { signWithSigner: signFn } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const { signer: s, privateKey: pk } = useUserStore.getState()
      const unsigned = createHideMessageEvent(hubDTag, postRef, post.pubkey, 36943, true)
      const signed = await signFn(unsigned, s, pk)
      const relays = hub ? [...hub.filterRelays, ...hub.generalRelays] : []
      await publishToSpecificRelays(getPublishRelays(relays), signed)
      useHubStore.getState().addHiddenMessage(hubDTag, {
        ref: postRef,
        hiderPubkey: pubkey,
        kind: 36943,
        targetPubkey: post.pubkey,
        createdAt: Math.floor(Date.now() / 1000),
      })
    } catch (err) {
      console.error('[ForumView] Failed to hide post:', err)
    } finally {
      setHideInProgress(false)
    }
  }, [canHide, hubDTag, postRef, post.pubkey, hub, pubkey])

  const handleUnhidePost = useCallback(async () => {
    setHideInProgress(true)
    try {
      const { createDeletedHideEvent, createDeletionEvent } = await import('@/lib/nostr/events')
      const { signWithSigner: signFn } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const { KINDS } = await import('@/lib/crypto/constants')
      const { signer: s, privateKey: pk } = useUserStore.getState()
      const relays = hub ? [...hub.filterRelays, ...hub.generalRelays] : []
      const publishRelays = getPublishRelays(relays)
      const hideEntry = useHubStore.getState().hiddenMessages[hubDTag]?.[postRef]
      const deletedHide = createDeletedHideEvent(hubDTag, postRef, hideEntry?.createdAt)
      const signedDeleted = await signFn(deletedHide, s, pk)
      await publishToSpecificRelays(publishRelays, signedDeleted)
      const dTag = `${hubDTag}:${postRef}`
      const aRef = `${KINDS.HIDE_MESSAGE}:${pubkey}:${dTag}`
      const deletionReq = createDeletionEvent([], [aRef], 'unhide')
      const signedDeletion = await signFn(deletionReq, s, pk)
      await publishToSpecificRelays(publishRelays, signedDeletion)
      useHubStore.getState().removeHiddenMessage(hubDTag, postRef)
    } catch (err) {
      console.error('[ForumView] Failed to unhide post:', err)
    } finally {
      setHideInProgress(false)
    }
  }, [hubDTag, postRef, hub, pubkey])
  const scrollRef = useRef<HTMLDivElement>(null)

  // Featured image zoom toggle
  const [imageExpanded, setImageExpanded] = useState(false)

  // Chat-style reply state (same as ThreadModal)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [rawEventData, setRawEventData] = useState<{ rawJson: string; decryptedContent: string; isDecrypted: boolean } | null>(null)
  const [deleteModalMsg, setDeleteModalMsg] = useState<ChatMessage | null>(null)
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [inThreadReply, setInThreadReply] = useState<ReplyContext | null>(null)
  const [profileModalPubkey, setProfileModalPubkey] = useState<string | null>(null)
  const [showPostMenu, setShowPostMenu] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [pendingUnreact, setPendingUnreact] = useState<{ messageId: string; emoji: string; eventId: string } | null>(null)
  const [reportModalPubkey, setReportModalPubkey] = useState<string | null>(null)
  const [hiddenPostRevealed, setHiddenPostRevealed] = useState(false)

  const myPubkey = useUserStore((s) => s.pubkey)
  const myDisplayName = useUserStore((s) => s.displayName)
  const myAvatar = useUserStore((s) => s.avatar)
  const mutedWords = useBlockStore((s) => s.mutedWords)

  // Reactions: lazy-decrypt + convert to Reaction[]
  const forumHub = useHubStore((s) => s.hubs[hubDTag])
  const forumHubMembers = useHubStore((s) => s.hubMembers[hubDTag])
  const { storeReactions, reactions } = useDecryptedReactions(hubDTag, getChannelKey, forumHub, forumHubMembers, channelId)
  const hubRoleNames = useMemo(() => forumHub?.roles?.map((r: any) => r.name).filter(Boolean) || [], [forumHub])
  const hubChannels = useMemo(() => forumHub?.channels?.map((c: any) => ({ channelId: c.channelId, name: c.name, type: c.type })) || [], [forumHub])
  const allForumMessages = useMemo(() => [post as ChatMessage, ...replies], [post, replies])

  const addReaction = useCallback((messageId: string, emoji: string, customUrl?: string) => {
    const targetMsg = allForumMessages.find((m) => m.id === messageId)
    if (!targetMsg) return

    const existing = storeReactions[messageId] || []
    const myExisting = existing.find((r) => r.emoji === emoji && r.pubkey === myPubkey)
    if (myExisting) {
      setPendingUnreact({ messageId, emoji, eventId: myExisting.eventId })
      return
    }

    useMessageStore.getState().addReaction(hubDTag, messageId, {
      emoji,
      pubkey: myPubkey!,
      eventId: 'optimistic-' + Date.now(),
      createdAt: Math.floor(Date.now() / 1000),
      customUrl,
    })
    publishReaction(emoji, messageId, targetMsg.pubkey, targetMsg.dTag, customUrl).catch(() => {})
  }, [allForumMessages, storeReactions, myPubkey, hubDTag, publishReaction, unreactReaction])

  // Thread root ref for this forum post
  const postRoot = `36943:${post.pubkey}:${post.dTag}`
  const myNpubName = myDisplayName || (myPubkey ? truncateNpub(nip19.npubEncode(myPubkey)) : 'You')

  // Default reply context — always points to post
  const defaultReplyContext: ReplyContext = useMemo(() => ({
    dTag: post.dTag,
    pubkey: post.pubkey,
    displayName: displayName,
    preview: post.content.slice(0, 80),
    rootRef: postRoot,
    isThread: true,
  }), [post.dTag, post.pubkey, post.content, displayName, postRoot])

  const activeReplyContext = inThreadReply || defaultReplyContext

  // Auto-scroll to bottom when replies change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [replies.length, optimisticMessages.length])

  const startEdit = useCallback((msg: ChatMessage) => {
    setEditingId(msg.id)
    setEditText(msg.content)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditText('')
  }, [])

  const saveEdit = useCallback(async (msg: ChatMessage, newText: string) => {
    try {
      await editMessage(msg.dTag, newText, msg.replyTo, msg.rootRef)
      setEditingId(null)
      setEditText('')
    } catch (err) {
      console.error('Edit failed:', err)
    }
  }, [editMessage])

  const handleReplyInThread = useCallback((msg: ChatMessage) => {
    // Don't show reply banner if replying to post itself
    if (msg.dTag === post.dTag && msg.pubkey === post.pubkey) {
      setInThreadReply(null)
      return
    }
    const profile = getProfile(msg.pubkey)
    const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(msg.pubkey))
    setInThreadReply({
      dTag: msg.dTag,
      pubkey: msg.pubkey,
      displayName: name,
      preview: msg.content.slice(0, 80),
      rootRef: postRoot,
      isThread: true,
    })
  }, [post.dTag, post.pubkey, postRoot, getProfile])


  const getThreadMsgByRef = useCallback((ref: string) => {
    const parts = ref.split(':')
    if (parts.length >= 3) {
      const refDTag = parts.slice(2).join(':')
      const refPubkey = parts[1]
      if (post.dTag === refDTag && post.pubkey === refPubkey) return post
      return replies.find((m) => m.dTag === refDTag && m.pubkey === refPubkey)
    }
    return undefined
  }, [post, replies])

  const handleDeletePost = useCallback(async () => {
    await deleteMessage(post.dTag)
    onBack()
  }, [post.dTag, deleteMessage, onBack])

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      + ' at ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  const GROUP_WINDOW = 5 * 60 // 5 min

  return (
    <div ref={containerRef} className="flex flex-col h-full relative">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <button onClick={onBack} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm font-medium text-foreground truncate flex-1">{post.title}</span>
      </div>

      {/* Scrollable body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {/* Featured image — hide when post is hidden and not revealed */}
        {post.featuredImage && (!isPostHidden || !canHide || hiddenPostRevealed) && (
          <div
            className="w-full aspect-[16/4] bg-black/50 flex justify-center items-center overflow-hidden cursor-pointer"
            onClick={() => setImageExpanded(!imageExpanded)}
          >
            <BlossomImage
              src={post.featuredImage}
              alt={post.title || ''}
              className={cn(
                'h-full transition-all duration-300',
                imageExpanded ? 'object-contain' : 'w-full object-cover'
              )}
            />
          </div>
        )}

        {/* Post content */}
        <TooltipProvider delayDuration={300}>
          <div className="px-6 py-5">
            <h1 className="text-2xl font-bold text-foreground mb-3">{post.title}</h1>

            {/* Hidden post banner — visible only to mods */}
            {isPostHidden && canHide && !hiddenPostRevealed && (
              <div className="flex items-center gap-2.5 px-3 py-2 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/15 shrink-0">
                  <EyeOff size={12} className="text-amber-400" />
                </div>
                <span className="text-xs font-medium text-amber-400">This post is hidden from non-moderators</span>
                {(() => {
                  const entry = hiddenMessages[postRef]
                  if (!entry) return null
                  const p = getProfile(entry.hiderPubkey)
                  const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(entry.hiderPubkey))
                  return <span className="text-[10px] text-muted-foreground">hidden by {name}</span>
                })()}
                <button
                  onClick={() => setHiddenPostRevealed(true)}
                  className="ml-auto text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer font-medium"
                >
                  Show
                </button>
              </div>
            )}
            {isPostHidden && canHide && hiddenPostRevealed && (
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => setHiddenPostRevealed(false)}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium cursor-pointer select-none hover:bg-amber-500/25 transition-colors"
                >
                  hidden by {(() => {
                    const entry = hiddenMessages[postRef]
                    if (!entry) return 'moderator'
                    const p = getProfile(entry.hiderPubkey)
                    return p?.display_name || p?.name || truncateNpub(nip19.npubEncode(entry.hiderPubkey))
                  })()}
                </button>
              </div>
            )}

            {/* Author + date + menu */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <button onClick={() => setProfileModalPubkey(post.pubkey)} className="shrink-0 cursor-pointer">
                  <Avatar className="h-10 w-10">
                    {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                    <AvatarFallback className="text-xs bg-primary/20 text-primary">
                      {displayName.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setProfileModalPubkey(post.pubkey)}
                      className="text-sm font-semibold cursor-pointer hover:underline text-foreground"
                    >
                      {displayName}
                    </button>
                    <DnnBadge pubkey={post.pubkey} />
                    {post.facilitator && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium cursor-default select-none">
                            facilitated
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          Facilitated by {(() => {
                            const fp = getProfile(post.facilitator!)
                            return fp?.display_name || fp?.name || truncateNpub(nip19.npubEncode(post.facilitator!))
                          })()}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-default">{formatTimestamp(post.timestamp)}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {formatDate(post.timestamp)}
                      </TooltipContent>
                    </Tooltip>
                    {post.edited && (
                      <span className="text-muted-foreground/60 italic">(edited)</span>
                    )}
                    {post.clientTag && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-muted-foreground/60 cursor-default">Ãƒâ€šÃ‚Â· via {post.clientTag}</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          This post was published through the {post.clientTag} client
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>

              {/* 3-dot menu — visible to all users */}
              <div className="relative">
                <button
                  onClick={() => setShowPostMenu(!showPostMenu)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  <MoreHorizontal size={16} />
                </button>
                {showPostMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowPostMenu(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border border-border bg-popover shadow-lg p-1 flex flex-col gap-1">
                      <button
                        onClick={() => {
                          try {
                            const addr = nip19.naddrEncode({ kind: 36943, pubkey: post.pubkey, identifier: post.dTag })
                            navigator.clipboard.writeText(addr)
                          } catch { navigator.clipboard.writeText(post.id) }
                          setShowPostMenu(false)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                      >
                        <Copy size={14} /> Copy Event Address
                      </button>
                      <button
                        onClick={() => {
                          if (post.rawEvent) {
                            const payload = post.content
                            setRawEventData({ rawJson: post.rawEvent, decryptedContent: payload, isDecrypted: post.decrypted })
                          }
                          setShowPostMenu(false)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                      >
                        <Code size={14} /> View Raw Event
                      </button>
                      {isOwnPost && (
                        <button
                          onClick={() => { setShowPostMenu(false); setShowEditModal(true) }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                        >
                          <Pencil size={14} /> Edit Post
                        </button>
                      )}
                      {!isOwnPost && (
                        <button
                          onClick={() => { setShowPostMenu(false); setReportModalPubkey(post.pubkey) }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors rounded-md"
                        >
                          <Flag size={14} /> Report User
                        </button>
                      )}
                      {canHide && !isPostHidden && (
                        <button
                          disabled={hideInProgress}
                          onClick={async () => {
                            await handleHidePost()
                            setShowPostMenu(false)
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-500/10 transition-colors rounded-md ${hideInProgress ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          {hideInProgress ? <Loader2 size={14} className="animate-spin" /> : <EyeOff size={14} />} {hideInProgress ? 'Hiding…' : 'Hide Post'}
                        </button>
                      )}
                      {canHide && isPostHidden && (
                        <button
                          disabled={hideInProgress}
                          onClick={async () => {
                            await handleUnhidePost()
                            setShowPostMenu(false)
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-emerald-400 hover:bg-emerald-500/10 transition-colors rounded-md ${hideInProgress ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          {hideInProgress ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} {hideInProgress ? 'Unhiding…' : 'Unhide Post'}
                        </button>
                      )}
                      {(isOwnPost || isCreator) && (
                        <>
                          <div className="h-px bg-border mx-2" />
                          <button
                            onClick={() => { setShowPostMenu(false); setDeleteModalMsg(post) }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 cursor-pointer transition-colors rounded-md"
                          >
                            <Trash2 size={14} /> Delete Post
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Body — hidden for mods until revealed */}
            {(!isPostHidden || !canHide || hiddenPostRevealed) && (
            <div className="prose prose-sm dark:prose-invert max-w-none mb-4">
              <MessageContent content={post.content} mutedWords={mutedWords} hubRoleNames={hubRoleNames} hubChannels={hubChannels} />
            </div>
            )}

            {/* Tags — hidden for mods until revealed */}
            {post.forumTags && post.forumTags.length > 0 && (!isPostHidden || !canHide || hiddenPostRevealed) && (
              <div className="flex flex-wrap gap-1.5 mb-6">
                {post.forumTags.map(tag => (
                  <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary text-xs font-medium">
                    <TagIcon size={10} />
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* Replies section ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â uses same ChatMessageRow system as hub chat */}
            <div className="border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <MessageSquare size={14} />
                Replies ({replies.length})
              </h3>

              {replies.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No replies yet. Be the first to reply!</p>
              ) : (
                <div className="flex flex-col">
                  {replies.map((reply, i) => {
                    const prev = i > 0 ? replies[i - 1] : null
                    const isReplyToPostForGrouping = reply.replyTo === postRoot
                    const hasReply = !!reply.replyTo && !isReplyToPostForGrouping
                    const isGrouped = prev
                      && prev.pubkey === reply.pubkey
                      && !hasReply
                      && (reply.timestamp - prev.timestamp) <= GROUP_WINDOW

                    if (reply.deleted) return null

                    const isReplyToPost = reply.replyTo === postRoot
                    const repliedMsg = (reply.replyTo && !isReplyToPost) ? getThreadMsgByRef(reply.replyTo) : undefined
                    const replyDeleted = repliedMsg?.deleted
                    const replyNotFound = (reply.replyTo && !isReplyToPost) && !repliedMsg

                    const replyRef = `36943:${reply.pubkey}:${reply.dTag}`
                    const isReplyHidden = !!hiddenMessages[replyRef]

                    return (
                      <ChatMessageRow
                        key={reply.id}
                        msg={reply}
                        hubDTag={hubDTag}
                        isGrouped={!!isGrouped}
                        isMine={reply.pubkey === myPubkey}
                        onOpenProfile={setProfileModalPubkey}
                        onEdit={startEdit}
                        onReply={handleReplyInThread}
                        onThreadReply={() => { }}
                        onSaveEdit={saveEdit}
                        editingId={editingId}
                        editText={editText}
                        setEditText={setEditText}
                        cancelEdit={cancelEdit}
                        getProfile={getProfile}
                        reactions={reactions[reply.id] || []}
                        rawReactions={storeReactions[reply.id]}
                        onAddReaction={addReaction}
                        repliedMessage={replyNotFound ? undefined : (replyDeleted ? undefined : repliedMsg)}
                        replyStatus={replyNotFound ? 'not-found' : (replyDeleted ? 'deleted' : undefined)}
                        highlighted={false}
                        onScrollToMessage={() => { }}
                        onRequestDelete={() => setDeleteModalMsg(reply)}
                        onViewRaw={(raw) => {
                          const payload = reply.attachments?.length || reply.nsfw
                            ? JSON.stringify({ text: reply.content, ...(reply.attachments?.length ? { attachments: reply.attachments } : {}), ...(reply.nsfw ? { nsfw: true } : {}) }, null, 2)
                            : reply.content
                          setRawEventData({ rawJson: raw, decryptedContent: payload, isDecrypted: reply.decrypted })
                        }}
                        getProfileForReply={getProfile}
                        hideThreadReply
                        hidePin
                        canPublish={canPublish}
                        channelId={channelId}
                        onHideMessage={canHide ? async () => {
                          const { createHideMessageEvent } = await import('@/lib/nostr/events')
                          const { signWithSigner: signFn } = await import('@/lib/nostr')
                          const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
                          const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
                          const { signer: s, privateKey: pk } = useUserStore.getState()
                          const unsigned = createHideMessageEvent(hubDTag, replyRef, reply.pubkey, 36943, true)
                          const signed = await signFn(unsigned, s, pk)
                          const relays = hub ? [...hub.filterRelays, ...hub.generalRelays] : []
                          await publishToSpecificRelays(getPublishRelays(relays), signed)
                          useHubStore.getState().addHiddenMessage(hubDTag, {
                            ref: replyRef, hiderPubkey: pubkey, kind: 36943, targetPubkey: reply.pubkey,
                            createdAt: Math.floor(Date.now() / 1000),
                          })
                        } : undefined}
                        onUnhideMessage={canHide ? async () => {
                          const { createDeletedHideEvent, createDeletionEvent } = await import('@/lib/nostr/events')
                          const { signWithSigner: signFn } = await import('@/lib/nostr')
                          const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
                          const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
                          const { KINDS } = await import('@/lib/crypto/constants')
                          const { signer: s, privateKey: pk } = useUserStore.getState()
                          const relays = hub ? [...hub.filterRelays, ...hub.generalRelays] : []
                          const publishRelays = getPublishRelays(relays)
                          const replyHideEntry = useHubStore.getState().hiddenMessages[hubDTag]?.[replyRef]
                          const deletedHide = createDeletedHideEvent(hubDTag, replyRef, replyHideEntry?.createdAt)
                          const signedDeleted = await signFn(deletedHide, s, pk)
                          await publishToSpecificRelays(publishRelays, signedDeleted)
                          const dTagVal = `${hubDTag}:${replyRef}`
                          const aRefVal = `${KINDS.HIDE_MESSAGE}:${pubkey}:${dTagVal}`
                          const deletionReq = createDeletionEvent([], [aRefVal], 'unhide')
                          const signedDeletion = await signFn(deletionReq, s, pk)
                          await publishToSpecificRelays(publishRelays, signedDeletion)
                          useHubStore.getState().removeHiddenMessage(hubDTag, replyRef)
                        } : undefined}
                        isHidden={isReplyHidden}
                        canHide={canHide}
                        hiddenBy={(() => {
                          const entry = hiddenMessages[replyRef]
                          if (!entry) return undefined
                          const p = getProfile(entry.hiderPubkey)
                          return p?.display_name || p?.name || truncateNpub(nip19.npubEncode(entry.hiderPubkey))
                        })()}
                      />
                    )
                  })}
                </div>
              )}


              {/* Optimistic messages */}
              {optimisticMessages.filter((o) => o.channelId === channelId).map((optMsg) => (
                <div
                  key={optMsg.tempId}
                  className={`flex gap-3 mt-2 py-1 px-2 rounded-md -mx-2 transition-opacity ${optMsg.status === 'published' ? 'opacity-70' : 'opacity-50'}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{myNpubName}</span>
                      <div className="text-sm text-foreground/90 break-words"><MessageContent content={optMsg.content} hubRoleNames={hubRoleNames} hubChannels={hubChannels} /></div>
                      {optMsg.status === 'mining' && <span className="text-[10px] text-muted-foreground italic">processing...</span>}
                      {optMsg.status === 'publishing' && !optMsg.relayProgress?.confirmed && <span className="text-[10px] text-muted-foreground italic">publishing...</span>}
                      {optMsg.status === 'published' && <Check size={13} className="text-green-500 shrink-0" />}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </TooltipProvider>
      </div>

      {/* Message input ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â same component as normal hub chat */}
      <MessageInput
        hubDTag={hubDTag}
        channelId={channelId}
        channelName="reply"
        optimisticMessages={optimisticMessages}
        setOptimisticMessages={setOptimisticMessages}
        replyContext={activeReplyContext}
        onCancelReply={() => setInThreadReply(null)}
        dragContainerRef={containerRef}
        hideReplyBanner={!inThreadReply}
        canPublish={canPublish}
      />

      {/* Delete confirmation */}
      {deleteModalMsg && (
        <DeleteConfirmDialog
          onCancel={() => setDeleteModalMsg(null)}
          onConfirm={async () => {
            if (deleteModalMsg.dTag === post.dTag) {
              // Deleting the post itself
              await deleteMessage(deleteModalMsg.dTag)
              setDeleteModalMsg(null)
              onBack()
            } else {
              await deleteMessage(deleteModalMsg.dTag)
              setDeleteModalMsg(null)
            }
          }}
        />
      )}

      {/* Unreact confirmation */}
      {pendingUnreact && (
        <DeleteConfirmDialog
          onCancel={() => setPendingUnreact(null)}
          onConfirm={async () => {
            useMessageStore.getState().removeReaction(hubDTag, pendingUnreact.messageId, pendingUnreact.emoji, myPubkey!)
            await unreactReaction(pendingUnreact.eventId)
            setPendingUnreact(null)
          }}
          title="Remove Reaction"
          progressSteps={['Sending deletion request...']}
          confirmLabel="Yes, Remove"
        />
      )}

      {/* Raw event modal */}
      {rawEventData && (
        <RawEventModal
          rawJson={rawEventData.rawJson}
          decryptedContent={rawEventData.decryptedContent}
          isDecrypted={rawEventData.isDecrypted}
          onClose={() => setRawEventData(null)}
        />
      )}

      {/* User profile modal */}
      <UserProfileModal
        open={!!profileModalPubkey}
        onClose={() => setProfileModalPubkey(null)}
        targetPubkey={profileModalPubkey}
        hubContext={hub ? { dTag: hubDTag, creatorPubkey: hub.creatorPubkey } : null}
        onDM={(pk) => {
          useDM04Store.getState().setActiveConversation(pk)
          useDMStore.getState().setActiveConversation(pk)
          useNavigationStore.getState().setActivePage('dms')
        }}
      />

      {/* Edit post modal */}
      {showEditModal && (
        <EditForumPostModal
          post={post}
          onClose={() => setShowEditModal(false)}
          editMessage={editMessage}
          signer={signer}
          privateKey={privateKey}
          hub={hub}
        />
      )}

      {/* Report modal */}
      {reportModalPubkey && hub && (
        <ReportModal
          open={!!reportModalPubkey}
          onClose={() => setReportModalPubkey(null)}
          hubDTag={hubDTag}
          hubCreatorPubkey={hub.creatorPubkey}
          reportedPubkey={reportModalPubkey}
        />
      )}
    </div>
  )
}

/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Create Forum Post Modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

interface CreateForumPostModalProps {
  onClose: () => void
  sendMessage: (...args: any[]) => Promise<void>
  canPublish: boolean
  signer: any
  privateKey: string | null
  hub: any
  hubDTag: string
  channelId: string
}

function CreateForumPostModal({ onClose, sendMessage, canPublish, signer, privateKey, hub, hubDTag, channelId }: CreateForumPostModalProps) {
  const _forumKey = forumDraftKey(hubDTag, channelId)
  const _saved = useMemo(() => getForumDraft(_forumKey), [_forumKey])
  const [title, setTitle] = useState(() => _saved?.title ?? '')
  const [body, setBody] = useState(() => _saved?.body ?? '')
  const [tags, setTags] = useState<string[]>(() => _saved?.tags ?? [])
  const [tagInput, setTagInput] = useState(() => _saved?.tagInput ?? '')
  const [featuredImage, setFeaturedImage] = useState(() => _saved?.featuredImage ?? '')
  const [publishing, setPublishing] = useState(false)
  const [isNsfw, setIsNsfw] = useState(() => _saved?.isNsfw ?? false)

  // Persist forum draft on every field change
  useEffect(() => {
    setForumDraft(_forumKey, { title, body, tags, tagInput, featuredImage, isNsfw })
  }, [_forumKey, title, body, tags, tagInput, featuredImage, isNsfw])
  const [showToolbar, setShowToolbar] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const bodyFileInputRef = useRef<HTMLInputElement>(null)
  const featuredFileInputRef = useRef<HTMLInputElement>(null)

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Featured image: separate, independent upload state ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const [featuredPreview, setFeaturedPreview] = useState<string | null>(null)
  const [featuredFile, setFeaturedFile] = useState<File | null>(null)
  const [featuredUploading, setFeaturedUploading] = useState(false)
  const [featuredProgress, setFeaturedProgress] = useState<UploadProgress | null>(null)
  const [featuredUploadDone, setFeaturedUploadDone] = useState(false)
  const [featuredDragging, setFeaturedDragging] = useState(false)
  const featuredAbortRef = useRef<AbortController | null>(null)
  const featuredDropRef = useRef<HTMLDivElement>(null)

  const handleFeaturedSelect = useCallback((files: FileList | File[]) => {
    const file = Array.from(files).find(f => f.type.startsWith('image/'))
    if (!file) return
    setFeaturedFile(file)
    setFeaturedPreview(URL.createObjectURL(file))
    setFeaturedUploadDone(false)
    setFeaturedImage('')
  }, [])

  const handleFeaturedUpload = useCallback(async () => {
    if (!featuredFile) return
    setFeaturedUploading(true)
    setFeaturedProgress(null)
    try {
      const servers = getUploadBlossoms(hub?.blossomServers)
      const buffer = await featuredFile.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash } = await uploadToBlossomServers(
        data, signer, privateKey, servers, featuredFile.type,
        (progress) => setFeaturedProgress({ ...progress }),
        () => { const c = new AbortController(); featuredAbortRef.current = c; return c.signal },
      )
      const serverUrl = (servers[0] || '').replace(/\/+$/, '')
      setFeaturedImage(`${serverUrl}/${hash}`)
      setFeaturedUploadDone(true)
    } catch {
      // failed
    } finally {
      setFeaturedUploading(false)
      setFeaturedProgress(null)
    }
  }, [featuredFile, hub, signer, privateKey])

  const clearFeatured = useCallback(() => {
    if (featuredPreview) URL.revokeObjectURL(featuredPreview)
    setFeaturedPreview(null)
    setFeaturedFile(null)
    setFeaturedImage('')
    setFeaturedUploadDone(false)
    setFeaturedProgress(null)
  }, [featuredPreview])

  // Featured drag & drop
  useEffect(() => {
    const el = featuredDropRef.current
    if (!el) return
    let counter = 0
    const onEnter = (e: DragEvent) => { e.preventDefault(); counter++; setFeaturedDragging(true) }
    const onLeave = (e: DragEvent) => { e.preventDefault(); counter--; if (counter === 0) setFeaturedDragging(false) }
    const onOver = (e: DragEvent) => { e.preventDefault() }
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); counter = 0; setFeaturedDragging(false)
      if (e.dataTransfer?.files?.length) handleFeaturedSelect(e.dataTransfer.files)
    }
    el.addEventListener('dragenter', onEnter)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('dragover', onOver)
    el.addEventListener('drop', onDrop)
    return () => { el.removeEventListener('dragenter', onEnter); el.removeEventListener('dragleave', onLeave); el.removeEventListener('dragover', onOver); el.removeEventListener('drop', onDrop) }
  }, [handleFeaturedSelect])

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Body files: PendingFile system (same as MessageInput) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  type PendingFile = {
    id: string
    file: File
    status: 'pending' | 'uploading' | 'success' | 'failed'
    hash?: string
    progress?: UploadProgress
    previewUrl?: string
  }
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const knownHashesRef = useRef<Set<string>>(new Set())

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatSpeed = (bps: number) => {
    if (bps < 1024) return `${Math.round(bps)} B/s`
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
  }

  const shortServerName = (url: string) => {
    try { return new URL(url).hostname.replace('www.', '') } catch { return url }
  }

  const addBodyFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    const limitBytes = limitMb * 1024 * 1024
    const allowed = files.filter((f) => f.size <= limitBytes)
    if (allowed.length === 0) return

    const newPending: PendingFile[] = []
    for (const file of allowed) {
      const buffer = await file.arrayBuffer()
      const hash = computeHash(new Uint8Array(buffer))
      if (knownHashesRef.current.has(hash)) continue
      knownHashesRef.current.add(hash)
      const pf: PendingFile = {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        status: 'pending',
        hash,
      }
      if (file.type.startsWith('image/')) {
        pf.previewUrl = URL.createObjectURL(file)
      }
      newPending.push(pf)
    }
    if (newPending.length > 0) {
      setPendingFiles((prev) => [...prev, ...newPending])
    }
  }, [])

  const removeFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((f) => f.id === fileId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      if (removed?.hash) knownHashesRef.current.delete(removed.hash)
      return prev.filter((f) => f.id !== fileId)
    })
  }, [])

  const handleUploadBodyFiles = useCallback(async () => {
    const toUpload = pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed')
    if (toUpload.length === 0) return
    setIsUploading(true)

    const servers = getUploadBlossoms(hub?.blossomServers)

    for (const pf of toUpload) {
      setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'uploading' as const, progress: undefined } : f))
      try {
        const buffer = await pf.file.arrayBuffer()
        const data = new Uint8Array(buffer)
        const { hash } = await uploadToBlossomServers(
          data, signer, privateKey, servers, pf.file.type,
          (progress) => {
            setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, progress: { ...progress } } : f))
          },
          () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
        )
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'success' as const, hash, progress: undefined } : f))

        // Auto-insert markdown into body
        const serverUrl = (servers[0] || '').replace(/\/+$/, '')
        const url = `${serverUrl}/${hash}`
        const isImage = pf.file.type.startsWith('image/')
        const md = isImage ? `![${pf.file.name}](${url})` : `[${pf.file.name}](${url})`
        setBody(prev => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + md + '\n')
      } catch {
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'failed' as const, progress: undefined } : f))
      }
    }
    setIsUploading(false)
  }, [pendingFiles, hub, signer, privateKey])

  // Markdown helpers (same pattern as MessageInput)
  const insertMarkdown = useCallback((prefix: string, suffix = '', placeholder = '') => {
    const ta = bodyRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = body.substring(start, end)
    const text = selected || placeholder
    const before = body.substring(0, start)
    const after = body.substring(end)
    setBody(`${before}${prefix}${text}${suffix}${after}`)
    requestAnimationFrame(() => {
      ta.focus()
      const cursorPos = start + prefix.length + text.length + suffix.length
      ta.setSelectionRange(
        selected ? cursorPos : start + prefix.length,
        selected ? cursorPos : start + prefix.length + text.length
      )
    })
  }, [body])

  const insertLinePrefix = useCallback((prefix: string) => {
    const ta = bodyRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = body.lastIndexOf('\n', start - 1) + 1
    const before = body.substring(0, lineStart)
    const after = body.substring(lineStart)
    setBody(`${before}${prefix}${after}`)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + prefix.length, start + prefix.length)
    })
  }, [body])

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (tag && !tags.includes(tag)) setTags([...tags, tag])
    setTagInput('')
  }

  const handlePublish = useCallback(async () => {
    if (!title.trim() || !canPublish) return
    setPublishing(true)
    try {
      await sendMessage(
        body,
        undefined, // no reply-to
        undefined, // no phase callback
        undefined, // no root ref
        undefined, // no attachments
        isNsfw || undefined, // nsfw
        undefined, // isThread
        undefined, // encrypted
        undefined, // facilitator
        { title, featuredImage: featuredImage || undefined, tags: tags.length > 0 ? tags : undefined }
      )
      // Clean up file previews + clear draft
      clearDraft(_forumKey)
      pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
      if (featuredPreview) URL.revokeObjectURL(featuredPreview)
      onClose()
    } finally {
      setPublishing(false)
    }
  }, [title, body, featuredImage, tags, isNsfw, canPublish, sendMessage, onClose, pendingFiles, featuredPreview])

  const hasPendingOrUploading = pendingFiles.some(f => f.status === 'pending' || f.status === 'uploading') || featuredUploading || (!!featuredFile && !featuredUploadDone && !featuredImage)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose} onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }} onDrop={(e) => { e.preventDefault(); e.stopPropagation() }} onDragEnter={(e) => { e.preventDefault(); e.stopPropagation() }} onDragLeave={(e) => { e.preventDefault(); e.stopPropagation() }}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        ref={containerRef}
        className="relative z-10 w-full max-w-2xl max-h-[85vh] rounded-xl border border-border bg-background shadow-2xl flex flex-col animate-in fade-in-0 zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">Create Forum Post</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Title *</label>
            <input
              type="text"
              placeholder="Post title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors"
            />
          </div>

          {/* Featured image ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â full-width drop zone */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Featured Image (optional)</label>
            {/* Drop zone / click area */}
            {!featuredPreview && !featuredImage && (
              <div
                ref={featuredDropRef}
                onClick={() => featuredFileInputRef.current?.click()}
                className={cn(
                  'w-full h-40 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors',
                  featuredDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/20'
                )}
              >
                <ImageIcon size={28} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Click or drag & drop an image</span>
                <span className="text-[10px] text-muted-foreground/60">or paste a URL below</span>
              </div>
            )}
            {/* Preview ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â always visible once selected */}
            {(featuredPreview || featuredImage) && (
              <div className="relative rounded-lg overflow-hidden border border-border">
                <img
                  src={featuredPreview || featuredImage}
                  alt="Featured"
                  className="w-full h-48 object-cover"
                />
                <button
                  onClick={clearFeatured}
                  className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center cursor-pointer hover:bg-black/80 transition-colors"
                >
                  <X size={12} />
                </button>
                {/* Upload overlay */}
                {featuredFile && !featuredUploadDone && !featuredImage && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 py-2.5">
                    {featuredUploading && featuredProgress ? (
                      <div>
                        <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden mb-1">
                          <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${featuredProgress.percent}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-white/70">
                          <span>{shortServerName(featuredProgress.serverUrl)} ({featuredProgress.serverIndex + 1}/{featuredProgress.totalServers})</span>
                          <span className="flex items-center gap-1">
                            {featuredProgress.percent >= 100 ? <span className="text-amber-400">Processing...</span> : formatSpeed(featuredProgress.speed)}
                            <button onClick={() => { featuredAbortRef.current?.abort(); featuredAbortRef.current = null }} className="text-white/50 hover:text-white cursor-pointer ml-0.5">skip</button>
                          </span>
                        </div>
                      </div>
                    ) : featuredUploading ? (
                      <div className="flex items-center gap-2 text-xs text-white/80">
                        <Loader2 size={14} className="animate-spin" />
                        Uploading...
                      </div>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleFeaturedUpload() }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                      >
                        <Upload size={13} />
                        Upload Featured Image
                      </button>
                    )}
                  </div>
                )}
                {featuredUploadDone && (
                  <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/80 text-white text-[10px] font-medium">
                    <Check size={10} /> Uploaded
                  </div>
                )}
              </div>
            )}
            {/* URL field â€” always visible */}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] text-muted-foreground shrink-0">{featuredImage ? 'URL:' : 'Or paste URL:'}</span>
              <input
                type="text"
                placeholder="https://..."
                value={featuredImage}
                onChange={(e) => setFeaturedImage(e.target.value)}
                className="flex-1 p-2 rounded-lg border border-input bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40"
                />
            </div>
            <input ref={featuredFileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { if (e.target.files?.length) handleFeaturedSelect(e.target.files); e.target.value = '' }} />
          </div>

          {/* Tags */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Tags (optional)</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tags.map(tag => (
                <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary text-xs font-medium">
                  {tag}
                  <button onClick={() => setTags(tags.filter(t => t !== tag))} className="hover:text-destructive cursor-pointer">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
              <TagIcon size={13} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Add tag and press Enter..."
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput) }
                  else if (e.key === 'Backspace' && !tagInput && tags.length > 0) setTags(tags.slice(0, -1))
                }}
                className="flex-1 p-2 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm"
              />
            </div>
          </div>

          {/* Body */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Body</label>

            {/* Markdown toolbar */}
            {showToolbar && (
              <TooltipProvider delayDuration={200}>
                <div className="flex items-center gap-0.5 px-3 py-1.5 bg-secondary/80 border border-border border-b-0 rounded-t-lg">
                  {[
                    { icon: Bold, action: () => insertMarkdown('**', '**', 'bold'), tip: 'Bold' },
                    { icon: Italic, action: () => insertMarkdown('*', '*', 'italic'), tip: 'Italic' },
                    { icon: Strikethrough, action: () => insertMarkdown('~~', '~~', 'strikethrough'), tip: 'Strikethrough' },
                    { icon: Heading1, action: () => insertLinePrefix('# '), tip: 'Heading 1' },
                    { icon: Heading2, action: () => insertLinePrefix('## '), tip: 'Heading 2' },
                    { icon: Heading3, action: () => insertLinePrefix('### '), tip: 'Heading 3' },
                    { icon: ListIcon, action: () => insertLinePrefix('- '), tip: 'Bullet List' },
                    { icon: ListOrdered, action: () => insertLinePrefix('1. '), tip: 'Numbered List' },
                    { icon: Link, action: () => insertMarkdown('[', '](url)', 'text'), tip: 'Link' },
                    { icon: Code, action: () => insertMarkdown('`', '`', 'code'), tip: 'Inline Code' },
                    { icon: CodeSquare, action: () => insertMarkdown('```\n', '\n```', 'code'), tip: 'Code Block' },
                    { icon: Eye, action: () => insertMarkdown('||', '||', 'spoiler'), tip: 'Spoiler' },
                  ].map(({ icon: Icon, action, tip }) => (
                    <Tooltip key={tip}>
                      <TooltipTrigger asChild>
                        <button type="button" onClick={action} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                          <Icon size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{tip}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </TooltipProvider>
            )}

            {/* Body file preview strip */}
            {pendingFiles.length > 0 && (
              <div className={`flex flex-wrap gap-2 px-3 py-2 bg-secondary/60 border border-border border-b-0 ${!showToolbar ? 'rounded-t-lg' : ''}`}>
                {pendingFiles.map((pf) => (
                  <div key={pf.id} className="relative flex items-center gap-2 bg-background rounded-lg border border-border px-2 py-1.5 min-w-[140px] max-w-[200px]">
                    {pf.previewUrl ? (
                      <img src={pf.previewUrl} alt={pf.file.name} className="w-10 h-10 rounded object-cover shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded bg-secondary flex items-center justify-center shrink-0">
                        <FileIcon size={18} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">{pf.file.name}</p>
                      <p className="text-[10px] text-muted-foreground">{formatFileSize(pf.file.size)}</p>
                      {pf.status === 'uploading' && pf.progress && (
                        <div className="mt-0.5">
                          <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${pf.progress.percent}%` }} />
                          </div>
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
                            <span className="truncate">{shortServerName(pf.progress.serverUrl)} ({pf.progress.serverIndex + 1}/{pf.progress.totalServers})</span>
                            <span className="flex items-center gap-1">
                              {pf.progress.percent >= 100 ? <span className="text-amber-400">Processing...</span> : formatSpeed(pf.progress.speed)}
                              <button onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }} className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5">skip</button>
                            </span>
                          </div>
                        </div>
                      )}
                      {pf.status === 'success' && <span className="text-[10px] text-emerald-400">ÃƒÂ¢Ã…â€œÃ¢â‚¬Å“ Uploaded</span>}
                      {pf.status === 'failed' && (
                        <button onClick={() => setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'pending' as const } : f))} className="text-[10px] text-destructive hover:underline cursor-pointer">Failed ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â retry</button>
                      )}
                    </div>
                    {pf.status !== 'uploading' && (
                      <button onClick={() => removeFile(pf.id)} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center cursor-pointer hover:bg-destructive/80 transition-colors">
                        <X size={10} />
                      </button>
                    )}
                  </div>
                ))}
                {pendingFiles.some((f) => (f.status === 'pending' || f.status === 'failed')) && !isUploading && (
                  <button onClick={handleUploadBodyFiles} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer self-center">
                    <Upload size={14} />
                    Upload {pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length} file{pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length > 1 ? 's' : ''}
                  </button>
                )}
                {isUploading && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground self-center">
                    <Loader2 size={14} className="animate-spin" />
                    Uploading...
                  </div>
                )}
              </div>
            )}

            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const ta = bodyRef.current
                  if (ta) {
                    const start = ta.selectionStart
                    const end = ta.selectionEnd
                    const spaces = '   '
                    const before = body.substring(0, start)
                    const after = body.substring(end)
                    setBody(`${before}${spaces}${after}`)
                    requestAnimationFrame(() => {
                      ta.focus()
                      const pos = start + spaces.length
                      ta.setSelectionRange(pos, pos)
                    })
                  }
                }
              }}
              placeholder="Write your post content..."
              rows={8}
              className={cn(
                'w-full px-3 py-2 border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors resize-y',
                showToolbar || pendingFiles.length > 0 ? 'rounded-b-lg border-t-0' : 'rounded-lg'
              )}
            />

            {/* Action bar */}
            <div className="flex items-center gap-1 mt-1.5">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => bodyFileInputRef.current?.click()} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                      <Plus size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Attach files</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => setShowToolbar(!showToolbar)} className={cn('p-1.5 rounded cursor-pointer transition-colors', showToolbar ? 'text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50')}>
                      <ALargeSmall size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Formatting</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => setIsNsfw(!isNsfw)} className={cn('p-1.5 rounded cursor-pointer transition-colors text-xs font-bold', isNsfw ? 'text-red-400 bg-red-400/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50')}>
                      NSFW
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Mark as NSFW</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button ref={emojiButtonRef} type="button" onClick={() => setShowEmoji(!showEmoji)} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                      <Smile size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Emoji</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {showEmoji && (
                <EmojiPickerPopover
                  anchorRef={emojiButtonRef}
                  onClose={() => setShowEmoji(false)}
                  onSelect={(emoji) => { setBody(prev => prev + emoji); setShowEmoji(false); bodyRef.current?.focus() }}
                />
              )}
            </div>
            <input ref={bodyFileInputRef} type="file" multiple className="hidden" onChange={(e) => { addBodyFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
            Cancel
          </button>
          <button
            onClick={() => handlePublish()}
            disabled={!title.trim() || publishing || hasPendingOrUploading}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {publishing && <Loader2 size={12} className="animate-spin" />}
            Publish Post
          </button>
        </div>
      </div>
    </div>
  )
}



/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Edit Forum Post Modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

interface EditForumPostModalProps {
  post: ForumPost
  onClose: () => void
  editMessage: (dTag: string, newText: string, replyTo?: string, rootRef?: string, forumFields?: { title: string; featuredImage?: string; tags?: string[] }) => Promise<void>
  signer: any
  privateKey: string | null
  hub: any
}

function EditForumPostModal({ post, onClose, editMessage, signer, privateKey, hub }: EditForumPostModalProps) {
  const [title, setTitle] = useState(post.title || '')
  const [body, setBody] = useState(post.content || '')
  const [tags, setTags] = useState<string[]>(post.forumTags || [])
  const [tagInput, setTagInput] = useState('')
  const [featuredImage, setFeaturedImage] = useState(post.featuredImage || '')
  const [saving, setSaving] = useState(false)
  const [isNsfw, setIsNsfw] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const bodyFileInputRef = useRef<HTMLInputElement>(null)
  const featuredFileInputRef = useRef<HTMLInputElement>(null)

  // â”€â”€â”€ Featured image: separate upload state â”€â”€â”€
  const [featuredPreview, setFeaturedPreview] = useState<string | null>(null)
  const [featuredFile, setFeaturedFile] = useState<File | null>(null)
  const [featuredUploading, setFeaturedUploading] = useState(false)
  const [featuredProgress, setFeaturedProgress] = useState<UploadProgress | null>(null)
  const [featuredUploadDone, setFeaturedUploadDone] = useState(!!post.featuredImage)
  const [featuredDragging, setFeaturedDragging] = useState(false)
  const featuredAbortRef = useRef<AbortController | null>(null)
  const featuredDropRef = useRef<HTMLDivElement>(null)

  // â”€â”€â”€ Body file uploads (PendingFile system) â”€â”€â”€
  type PendingFile = {
    id: string; file: File; status: 'pending' | 'uploading' | 'success' | 'failed'
    hash?: string; progress?: UploadProgress; previewUrl?: string
  }
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const knownHashesRef = useRef<Set<string>>(new Set())

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  const formatSpeed = (bps: number) => {
    if (bps < 1024) return `${Math.round(bps)} B/s`
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
  }
  const shortServerName = (url: string) => {
    try { return new URL(url).hostname.replace('www.', '') } catch { return url }
  }

  // â”€â”€â”€ Featured image handlers â”€â”€â”€
  const handleFeaturedSelect = useCallback((files: FileList | File[]) => {
    const file = Array.from(files).find(f => f.type.startsWith('image/'))
    if (!file) return
    setFeaturedFile(file)
    setFeaturedPreview(URL.createObjectURL(file))
    setFeaturedUploadDone(false)
    setFeaturedImage('')
  }, [])

  const handleFeaturedUpload = useCallback(async () => {
    if (!featuredFile) return
    setFeaturedUploading(true)
    setFeaturedProgress(null)
    try {
      const servers = getUploadBlossoms(hub?.blossomServers)
      const buffer = await featuredFile.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash } = await uploadToBlossomServers(
        data, signer, privateKey, servers, featuredFile.type,
        (progress) => setFeaturedProgress({ ...progress }),
        () => { const c = new AbortController(); featuredAbortRef.current = c; return c.signal },
      )
      const serverUrl = (servers[0] || '').replace(/\/+$/, '')
      setFeaturedImage(`${serverUrl}/${hash}`)
      setFeaturedUploadDone(true)
    } catch {
      // failed
    } finally {
      setFeaturedUploading(false)
      setFeaturedProgress(null)
    }
  }, [featuredFile, hub, signer, privateKey])

  const clearFeatured = useCallback(() => {
    if (featuredPreview) URL.revokeObjectURL(featuredPreview)
    setFeaturedPreview(null)
    setFeaturedFile(null)
    setFeaturedImage('')
    setFeaturedUploadDone(false)
    setFeaturedProgress(null)
  }, [featuredPreview])

  // Drag & drop for featured image
  useEffect(() => {
    const el = featuredDropRef.current
    if (!el) return
    let counter = 0
    const onEnter = (e: DragEvent) => { e.preventDefault(); counter++; setFeaturedDragging(true) }
    const onLeave = (e: DragEvent) => { e.preventDefault(); counter--; if (counter === 0) setFeaturedDragging(false) }
    const onOver = (e: DragEvent) => { e.preventDefault() }
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); counter = 0; setFeaturedDragging(false)
      if (e.dataTransfer?.files?.length) handleFeaturedSelect(e.dataTransfer.files)
    }
    el.addEventListener('dragenter', onEnter)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('dragover', onOver)
    el.addEventListener('drop', onDrop)
    return () => { el.removeEventListener('dragenter', onEnter); el.removeEventListener('dragleave', onLeave); el.removeEventListener('dragover', onOver); el.removeEventListener('drop', onDrop) }
  }, [handleFeaturedSelect])

  // â”€â”€â”€ Body file handlers â”€â”€â”€
  const addBodyFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    const limitBytes = limitMb * 1024 * 1024
    const allowed = files.filter((f) => f.size <= limitBytes)
    if (allowed.length === 0) return
    const newPending: PendingFile[] = []
    for (const file of allowed) {
      const buffer = await file.arrayBuffer()
      const hash = computeHash(new Uint8Array(buffer))
      if (knownHashesRef.current.has(hash)) continue
      knownHashesRef.current.add(hash)
      const pf: PendingFile = { id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`, file, status: 'pending', hash }
      if (file.type.startsWith('image/')) pf.previewUrl = URL.createObjectURL(file)
      newPending.push(pf)
    }
    if (newPending.length > 0) setPendingFiles((prev) => [...prev, ...newPending])
  }, [])

  const removeFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((f) => f.id === fileId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      if (removed?.hash) knownHashesRef.current.delete(removed.hash)
      return prev.filter((f) => f.id !== fileId)
    })
  }, [])

  const handleUploadBodyFiles = useCallback(async () => {
    const toUpload = pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed')
    if (toUpload.length === 0) return
    setIsUploading(true)
    const servers = getUploadBlossoms(hub?.blossomServers)
    for (const pf of toUpload) {
      setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'uploading' as const, progress: undefined } : f))
      try {
        const buffer = await pf.file.arrayBuffer()
        const data = new Uint8Array(buffer)
        const { hash } = await uploadToBlossomServers(
          data, signer, privateKey, servers, pf.file.type,
          (progress) => { setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, progress: { ...progress } } : f)) },
          () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
        )
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'success' as const, hash, progress: undefined } : f))
        const serverUrl = (servers[0] || '').replace(/\/+$/, '')
        const url = `${serverUrl}/${hash}`
        const isImage = pf.file.type.startsWith('image/')
        const md = isImage ? `![${pf.file.name}](${url})` : `[${pf.file.name}](${url})`
        setBody(prev => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + md + '\n')
      } catch {
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'failed' as const, progress: undefined } : f))
      }
    }
    setIsUploading(false)
  }, [pendingFiles, hub, signer, privateKey])

  // â”€â”€â”€ Markdown helpers â”€â”€â”€
  const insertMarkdown = useCallback((prefix: string, suffix = '', placeholder = '') => {
    const ta = bodyRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = body.substring(start, end)
    const text = selected || placeholder
    const before = body.substring(0, start)
    const after = body.substring(end)
    setBody(`${before}${prefix}${text}${suffix}${after}`)
    requestAnimationFrame(() => {
      ta.focus()
      const cursorPos = start + prefix.length + text.length + suffix.length
      ta.setSelectionRange(
        selected ? cursorPos : start + prefix.length,
        selected ? cursorPos : start + prefix.length + text.length
      )
    })
  }, [body])

  const insertLinePrefix = useCallback((prefix: string) => {
    const ta = bodyRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = body.lastIndexOf('\n', start - 1) + 1
    const before = body.substring(0, lineStart)
    const after = body.substring(lineStart)
    setBody(`${before}${prefix}${after}`)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + prefix.length, start + prefix.length)
    })
  }, [body])

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (tag && !tags.includes(tag)) setTags([...tags, tag])
    setTagInput('')
  }

  const hasPendingFeatured = !!featuredFile && !featuredUploadDone && !featuredImage
  const hasPendingOrUploading = pendingFiles.some(f => f.status === 'pending' || f.status === 'uploading')

  const handleSave = useCallback(async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await editMessage(post.dTag, body, post.replyTo, post.rootRef,
        { title, featuredImage: featuredImage || undefined, tags: tags.length > 0 ? tags : undefined })
      if (featuredPreview) URL.revokeObjectURL(featuredPreview)
      pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
      onClose()
    } finally { setSaving(false) }
  }, [title, body, featuredImage, tags, isNsfw, post, editMessage, onClose, featuredPreview, pendingFiles])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose} onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }} onDrop={(e) => { e.preventDefault(); e.stopPropagation() }} onDragEnter={(e) => { e.preventDefault(); e.stopPropagation() }} onDragLeave={(e) => { e.preventDefault(); e.stopPropagation() }}>
      <div className="absolute inset-0 bg-black/60" />
      <div ref={containerRef} className="relative z-10 w-full max-w-2xl max-h-[85vh] rounded-xl border border-border bg-background shadow-2xl flex flex-col animate-in fade-in-0 zoom-in-95" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">Edit Forum Post</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Title *</label>
            <input type="text" placeholder="Post title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors" />
          </div>

          {/* Featured image â€” full-width drop zone */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Featured Image (optional)</label>
            {!featuredPreview && !featuredImage && (
              <div
                ref={featuredDropRef}
                onClick={() => featuredFileInputRef.current?.click()}
                className={cn(
                  'w-full h-40 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors',
                  featuredDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/20'
                )}
              >
                <ImageIcon size={28} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Click or drag & drop an image</span>
                <span className="text-[10px] text-muted-foreground/60">or paste a URL below</span>
              </div>
            )}
            {(featuredPreview || featuredImage) && (
              <div className="relative rounded-lg overflow-hidden border border-border">
                <img src={featuredPreview || featuredImage} alt="Featured" className="w-full h-48 object-cover" />
                <button onClick={clearFeatured} className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center cursor-pointer hover:bg-black/80 transition-colors"><X size={12} /></button>
                {featuredFile && !featuredUploadDone && !featuredImage && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 py-2.5">
                    {featuredUploading && featuredProgress ? (
                      <div>
                        <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden mb-1">
                          <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${featuredProgress.percent}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-white/70">
                          <span>{shortServerName(featuredProgress.serverUrl)} ({featuredProgress.serverIndex + 1}/{featuredProgress.totalServers})</span>
                          <span className="flex items-center gap-1">
                            {featuredProgress.percent >= 100 ? <span className="text-amber-400">Processing...</span> : formatSpeed(featuredProgress.speed)}
                            <button onClick={() => { featuredAbortRef.current?.abort(); featuredAbortRef.current = null }} className="text-white/50 hover:text-white cursor-pointer ml-0.5">skip</button>
                          </span>
                        </div>
                      </div>
                    ) : featuredUploading ? (
                      <div className="flex items-center gap-2 text-xs text-white/80"><Loader2 size={14} className="animate-spin" /> Uploading...</div>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); handleFeaturedUpload() }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                        <Upload size={13} /> Upload Featured Image
                      </button>
                    )}
                  </div>
                )}
                {featuredUploadDone && (
                  <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/80 text-white text-[10px] font-medium"><Check size={10} /> Uploaded</div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] text-muted-foreground shrink-0">{featuredImage ? 'URL:' : 'Or paste URL:'}</span>
              <input type="text" placeholder="https://..." value={featuredImage} onChange={(e) => setFeaturedImage(e.target.value)} className="flex-1 p-2 rounded-lg border border-input bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40" />
            </div>
            <input ref={featuredFileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { if (e.target.files?.length) handleFeaturedSelect(e.target.files); e.target.value = '' }} />
          </div>

          {/* Tags */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Tags (optional)</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tags.map(tag => (
                <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary text-xs font-medium">
                  {tag}
                  <button onClick={() => setTags(tags.filter(t => t !== tag))} className="hover:text-destructive cursor-pointer"><X size={10} /></button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
              <TagIcon size={13} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Add tag and press Enter..."
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput) }
                  else if (e.key === 'Backspace' && !tagInput && tags.length > 0) setTags(tags.slice(0, -1))
                }}
                className="flex-1 p-2 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm"
              />
            </div>
          </div>

          {/* Body */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Body</label>

            {/* Markdown toolbar */}
            {showToolbar && (
              <TooltipProvider delayDuration={200}>
                <div className="flex items-center gap-0.5 px-3 py-1.5 bg-secondary/80 border border-border border-b-0 rounded-t-lg">
                  {[
                    { icon: Bold, action: () => insertMarkdown('**', '**', 'bold'), tip: 'Bold' },
                    { icon: Italic, action: () => insertMarkdown('*', '*', 'italic'), tip: 'Italic' },
                    { icon: Strikethrough, action: () => insertMarkdown('~~', '~~', 'strikethrough'), tip: 'Strikethrough' },
                    { icon: Heading1, action: () => insertLinePrefix('# '), tip: 'Heading 1' },
                    { icon: Heading2, action: () => insertLinePrefix('## '), tip: 'Heading 2' },
                    { icon: Heading3, action: () => insertLinePrefix('### '), tip: 'Heading 3' },
                    { icon: ListIcon, action: () => insertLinePrefix('- '), tip: 'Bullet List' },
                    { icon: ListOrdered, action: () => insertLinePrefix('1. '), tip: 'Numbered List' },
                    { icon: Link, action: () => insertMarkdown('[', '](url)', 'text'), tip: 'Link' },
                    { icon: Code, action: () => insertMarkdown('`', '`', 'code'), tip: 'Inline Code' },
                    { icon: CodeSquare, action: () => insertMarkdown('```\n', '\n```', 'code'), tip: 'Code Block' },
                    { icon: Eye, action: () => insertMarkdown('||', '||', 'spoiler'), tip: 'Spoiler' },
                  ].map(({ icon: Icon, action, tip }) => (
                    <Tooltip key={tip}>
                      <TooltipTrigger asChild>
                        <button type="button" onClick={action} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                          <Icon size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{tip}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </TooltipProvider>
            )}

            {/* Body file preview strip */}
            {pendingFiles.length > 0 && (
              <div className={`flex flex-wrap gap-2 px-3 py-2 bg-secondary/60 border border-border border-b-0 ${!showToolbar ? 'rounded-t-lg' : ''}`}>
                {pendingFiles.map((pf) => (
                  <div key={pf.id} className="relative flex items-center gap-2 bg-background rounded-lg border border-border px-2 py-1.5 min-w-[140px] max-w-[200px]">
                    {pf.previewUrl ? (
                      <img src={pf.previewUrl} alt={pf.file.name} className="w-10 h-10 rounded object-cover shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded bg-secondary flex items-center justify-center shrink-0">
                        <FileIcon size={18} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">{pf.file.name}</p>
                      <p className="text-[10px] text-muted-foreground">{formatFileSize(pf.file.size)}</p>
                      {pf.status === 'uploading' && pf.progress && (
                        <div className="mt-0.5">
                          <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${pf.progress.percent}%` }} />
                          </div>
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
                            <span className="truncate">{shortServerName(pf.progress.serverUrl)} ({pf.progress.serverIndex + 1}/{pf.progress.totalServers})</span>
                            <span className="flex items-center gap-1">
                              {pf.progress.percent >= 100 ? <span className="text-amber-400">Processing...</span> : formatSpeed(pf.progress.speed)}
                              <button onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }} className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5">skip</button>
                            </span>
                          </div>
                        </div>
                      )}
                      {pf.status === 'success' && <span className="text-[10px] text-emerald-400">âœ“ Uploaded</span>}
                      {pf.status === 'failed' && (
                        <button onClick={() => setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'pending' as const } : f))} className="text-[10px] text-destructive hover:underline cursor-pointer">Failed â€” retry</button>
                      )}
                    </div>
                    {pf.status !== 'uploading' && (
                      <button onClick={() => removeFile(pf.id)} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center cursor-pointer hover:bg-destructive/80 transition-colors">
                        <X size={10} />
                      </button>
                    )}
                  </div>
                ))}
                {pendingFiles.some((f) => (f.status === 'pending' || f.status === 'failed')) && !isUploading && (
                  <button onClick={handleUploadBodyFiles} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer self-center">
                    <Upload size={14} />
                    Upload {pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length} file{pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length > 1 ? 's' : ''}
                  </button>
                )}
                {isUploading && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground self-center">
                    <Loader2 size={14} className="animate-spin" />
                    Uploading...
                  </div>
                )}
              </div>
            )}

            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const ta = bodyRef.current
                  if (ta) {
                    const start = ta.selectionStart
                    const end = ta.selectionEnd
                    const spaces = '   '
                    const before = body.substring(0, start)
                    const after = body.substring(end)
                    setBody(`${before}${spaces}${after}`)
                    requestAnimationFrame(() => {
                      ta.focus()
                      const pos = start + spaces.length
                      ta.setSelectionRange(pos, pos)
                    })
                  }
                }
              }}
              placeholder="Write your post content..."
              rows={8}
              className={cn(
                'w-full px-3 py-2 border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors resize-y',
                showToolbar || pendingFiles.length > 0 ? 'rounded-b-lg border-t-0' : 'rounded-lg'
              )}
            />

            {/* Action bar */}
            <div className="flex items-center gap-1 mt-1.5">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => bodyFileInputRef.current?.click()} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                      <Plus size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Attach files</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => setShowToolbar(!showToolbar)} className={cn('p-1.5 rounded cursor-pointer transition-colors', showToolbar ? 'text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50')}>
                      <ALargeSmall size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Formatting</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => setIsNsfw(!isNsfw)} className={cn('p-1.5 rounded cursor-pointer transition-colors text-xs font-bold', isNsfw ? 'text-red-400 bg-red-400/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50')}>
                      NSFW
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Mark as NSFW</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button ref={emojiButtonRef} type="button" onClick={() => setShowEmoji(!showEmoji)} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                      <Smile size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Emoji</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {showEmoji && (
                <EmojiPickerPopover
                  anchorRef={emojiButtonRef}
                  onClose={() => setShowEmoji(false)}
                  onSelect={(emoji) => { setBody(prev => prev + emoji); setShowEmoji(false); bodyRef.current?.focus() }}
                />
              )}
            </div>
            <input ref={bodyFileInputRef} type="file" multiple className="hidden" onChange={(e) => { addBodyFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">Cancel</button>
          <button onClick={handleSave} disabled={!title.trim() || saving || featuredUploading || hasPendingFeatured || hasPendingOrUploading} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {saving && <Loader2 size={12} className="animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  )
}



/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Forum Filter Modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */

interface ForumFilterModalProps {
  open: boolean
  onClose: () => void
  filterTags: string[]
  setFilterTags: (v: string[]) => void
  filterAuthor: string
  setFilterAuthor: (v: string) => void
  availableTags: string[]
}

function ForumFilterModal({ open, onClose, filterTags, setFilterTags, filterAuthor, setFilterAuthor, availableTags }: ForumFilterModalProps) {
  const [localTags, setLocalTags] = useState<string[]>(filterTags)
  const [localAuthor, setLocalAuthor] = useState(filterAuthor)
  const [tagInput, setTagInput] = useState('')

  useEffect(() => {
    if (open) {
      setLocalTags([...filterTags])
      setLocalAuthor(filterAuthor)
      setTagInput('')
    }
  }, [open, filterTags, filterAuthor])

  if (!open) return null

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (tag && !localTags.includes(tag)) setLocalTags([...localTags, tag])
    setTagInput('')
  }

  const handleApply = () => {
    setFilterTags(localTags)
    setFilterAuthor(localAuthor)
    onClose()
  }

  const handleReset = () => {
    setLocalTags([])
    setLocalAuthor('')
    setTagInput('')
  }

  const hasChanges = localTags.length > 0 || !!localAuthor

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Filter Posts</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-5">
          {/* Tag filter */}
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Filter by Tags</label>
            <p className="text-xs text-muted-foreground mb-2">Show only posts with these tags</p>

            {localTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {localTags.map(tag => (
                  <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-primary/10 border border-primary/20 text-primary">
                    {tag}
                    <button onClick={() => setLocalTags(localTags.filter(t => t !== tag))} className="hover:text-destructive transition-colors cursor-pointer">
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
              <TagIcon size={13} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder={localTags.length > 0 ? 'Add another tag...' : 'e.g. Discussion, Bug...'}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput) }
                  else if (e.key === 'Backspace' && !tagInput && localTags.length > 0) setLocalTags(localTags.slice(0, -1))
                }}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm p-1"
              />
            </div>

            {/* Available tags suggestion */}
            {availableTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {availableTags.filter(t => !localTags.includes(t)).slice(0, 10).map(tag => (
                  <button
                    key={tag}
                    onClick={() => addTag(tag)}
                    className="px-2 py-0.5 rounded text-[10px] bg-secondary/60 text-muted-foreground hover:bg-primary/10 hover:text-primary cursor-pointer transition-colors"
                  >
                    + {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Author filter */}
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Filter by Author</label>
            <p className="text-xs text-muted-foreground mb-2">Show only posts from a specific npub</p>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
              <User size={13} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="npub or hex pubkey..."
                value={localAuthor}
                onChange={(e) => setLocalAuthor(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm p-1"
              />
              {localAuthor && (
                <button onClick={() => setLocalAuthor('')} className="text-muted-foreground hover:text-foreground cursor-pointer">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border">
          <button
            onClick={handleReset}
            disabled={!hasChanges}
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Reset
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
              Cancel
            </button>
            <button onClick={handleApply} className="px-4 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer">
              Apply Filters
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
