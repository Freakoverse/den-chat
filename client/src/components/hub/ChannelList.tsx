import { useHubStore, type HubData } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { getPermissionsForUser } from '@/lib/hub/permissions'
import { Hash, Megaphone, MessagesSquare, MessageSquare, ChevronDown, ChevronUp, ChevronRight, Settings, UserPlus, Inbox, Loader2, SlidersHorizontal, Volume2, MicOff, HeadphoneOff, Camera, ScreenShare, X, User, Radar, Boxes, AlertTriangle, CalendarDays, Lock, Undo2, AtSign, GripVertical, ListOrdered, Check } from 'lucide-react'
import { cn, npubShort } from '@/lib/utils'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode, type DragEvent as ReactDragEvent } from 'react'
import { createPortal } from 'react-dom'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { CustomSelect } from '@/components/ui/custom-select'

import { useVoiceStore } from '@/stores/voiceStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { useVoiceDisplayPubkey, useMyVoicePubkey } from '@/hooks/useVoiceDisplayPubkey'
import { useCachedImageUrl } from '@/lib/imageCache'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { HubSettingsModal } from '@/components/hub/HubSettingsModal'
import { HubInfoModal } from '@/components/hub/HubInfoModal'
import { InviteModal } from '@/components/hub/InviteModal'
import { JoinRequestsModal } from '@/components/hub/JoinRequestsModal'
import { useJoinRequestCount, markJoinRequestsSeen } from '@/hooks/useJoinRequestCount'
import { UserHubSettingsModal } from '@/components/hub/UserHubSettingsModal'
import { UserPanel } from '@/components/ui/UserPanel'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { CalendarPanel } from '@/components/hub/CalendarPanel'
import { useCalendar, isEventLive } from '@/hooks/useCalendar'

/** Small tooltip wrapper matching the rest of the app (self-contained provider). */
function Tip({ children, text }: { children: ReactNode; text: string }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function ChannelList({ isModBanned = false, isMobile = false }: { isModBanned?: boolean; isMobile?: boolean } = {}) {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  const setActiveChannel = useHubStore((s) => s.setActiveChannel)
  const setMobileView = useNavigationStore((s) => s.setMobileView)
  const pubkey = useUserStore((s) => s.pubkey)
  const myVoicePubkey = useMyVoicePubkey(hub?.dTag) // v2: our voice host is authored under P, not R
  const groupSecrets = useHubStore((s) => activeHubId ? s.groupSecrets[activeHubId] : undefined)
  const hubMembers = useHubStore((s) => activeHubId ? s.hubMembers[activeHubId] : undefined)
  const channelScrollRef = useRef<HTMLDivElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showJoinRequests, setShowJoinRequests] = useState(false)
  const [showUserSettings, setShowUserSettings] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [showCreatorProfile, setShowCreatorProfile] = useState(false)
  const [rescinding, setRescinding] = useState(false)
  const [rescindDone, setRescindDone] = useState(false)
  const [showRescindConfirm, setShowRescindConfirm] = useState(false)
  // "Hub Menu" accordion — collapsed by default; remembers the creator's last choice across sessions.
  const [hubMenuOpen, setHubMenuOpen] = useState(() => {
    try { return localStorage.getItem('den_hub_menu_open') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('den_hub_menu_open', hubMenuOpen ? '1' : '0') } catch { /* ignore */ }
  }, [hubMenuOpen])
  const [userSettingsInitialTab, setUserSettingsInitialTab] = useState<'messages' | 'notifications' | 'voice' | undefined>(undefined)

  // ── Creator-only channel/category reordering (drag & drop, desktop) ──
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const setHubData = useHubStore((s) => s.setHubData)
  // Staged layout: null = no pending change (render live hub). Set on a drag; the
  // banner offers Publish / Discard. Nothing hits relays until Publish.
  const [layoutDraft, setLayoutDraft] = useState<{ channels: HubData['channels']; categories: HubData['categories'] } | null>(null)
  const [dragItem, setDragItem] = useState<{ type: 'category' | 'channel'; id: string } | null>(null)
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)
  const [publishingLayout, setPublishingLayout] = useState(false)
  const [layoutError, setLayoutError] = useState<string | null>(null)
  // Progress modal for publishing a reorder: null = hidden. Mirrors the step
  // overlay in Hub Settings → Channels.
  const [layoutStep, setLayoutStep] = useState<null | 'signing' | 'publishing' | 'done'>(null)
  // Reorder happens in a dedicated "edit mode" that swaps the heavy channel rows
  // for lightweight drag rows (keeps HTML5 drag reliable) and avoids the drag-vs-
  // click conflict in normal browsing.
  const [editingLayout, setEditingLayout] = useState(false)
  // Clear any staged reorder when switching hubs so it can't leak across hubs.
  // Also clear the optimistic "withdrawn" flag: opening a hub (activeHubId change) is the reliable
  // signal that we've (re-)entered it — e.g. after withdraw → request again → open — so the
  // not-a-member guard reappears instead of staying hidden from a stale rescindDone.
  useEffect(() => {
    setLayoutDraft(null); setDragItem(null); setDragOverTarget(null); setLayoutError(null); setEditingLayout(false); setLayoutStep(null)
    setRescindDone(false)
  }, [activeHubId])

  // Watch for pending notification settings action from context menu
  const pendingHubNotifDTag = useNavigationStore((s) => s.pendingHubNotifDTag)
  const clearPendingNotif = useNavigationStore((s) => s.setPendingHubNotifDTag)
  useEffect(() => {
    if (pendingHubNotifDTag && hub && hub.dTag === pendingHubNotifDTag) {
      clearPendingNotif(null)
      setUserSettingsInitialTab('notifications')
      setShowUserSettings(true)
    }
  }, [pendingHubNotifDTag, hub, clearPendingNotif])

  // Watch for pending voice-hosting settings action (from the voice channel view)
  const pendingHubVoiceHostingDTag = useNavigationStore((s) => s.pendingHubVoiceHostingDTag)
  const clearPendingVoiceHosting = useNavigationStore((s) => s.setPendingHubVoiceHostingDTag)
  useEffect(() => {
    if (pendingHubVoiceHostingDTag && hub && hub.dTag === pendingHubVoiceHostingDTag) {
      clearPendingVoiceHosting(null)
      setUserSettingsInitialTab('voice')
      setShowUserSettings(true)
    }
  }, [pendingHubVoiceHostingDTag, hub, clearPendingVoiceHosting])

  const markChannelRead = useNotificationStore((s) => s.markChannelRead)

  const isCreator = !!(hub && pubkey && (hub.creatorPubkey === pubkey || hub.ownerRealPubkey === pubkey))
  const isMember = !!(pubkey && hubMembers?.some((m) => m.pubkey === pubkey))
  const secretsResolved = useHubStore((s) => activeHubId ? !!s.hubSecretsResolved[activeHubId] : false)

  // Reset the optimistic "withdrawn" flag whenever the hub is (re-)present in the user's list.
  // Withdrawing sets rescindDone=true and removes the hub from the list; requesting AGAIN re-adds it,
  // so this fires and lets the not-a-member guard reappear. Without it, rescindDone stayed true across
  // a re-request and the guard silently never came back (looked like you were already in).
  const hubEntries = useHubStore((s) => s.hubEntries)
  const hubInList = !!(hub && hubEntries.some((e) => e.dTag === hub.dTag))
  useEffect(() => { if (hubInList) setRescindDone(false) }, [hubInList])

  // Show rescind button when: not creator, not a direct member, and secrets are resolved
  const showRescind = !isCreator && !isMember && secretsResolved && !rescindDone

  // Withdraw the pending join request (confirmed via the rescind modal).
  const handleRescind = useCallback(async () => {
    if (!hub || !pubkey || rescinding) return
    setRescinding(true)
    try {
      const { rescindJoinRequest } = await import('@/lib/hub/rescindJoinRequest')
      await rescindJoinRequest(hub, pubkey)
      setRescindDone(true)
      setShowRescindConfirm(false)
    } catch (err) {
      console.error('[ChannelList] Failed to rescind join request:', err)
    } finally {
      setRescinding(false)
    }
  }, [hub, pubkey, rescinding])

  // Mark the active channel as read whenever it changes
  useEffect(() => {
    if (activeHubId && activeChannelId) {
      markChannelRead(activeHubId, activeChannelId)
    }
  }, [activeHubId, activeChannelId, markChannelRead])

  /**
   * Resolve the effective encryption groupId for a channel.
   * Direct encryption > synced category encryption > null
   */
  const getChannelGroupId = (ch: { channelId: string; encryption: string | null; synced: boolean; categoryId: string | null }) => {
    if (ch.encryption) return ch.encryption
    if (ch.synced && ch.categoryId) {
      const cat = hub?.categories.find(c => c.categoryId === ch.categoryId)
      if (cat?.encryption) return cat.encryption
    }
    return null
  }

  /** Check if user has decrypted the group secret for a given groupId */
  const hasGroupAccess = (groupId: string | null): boolean => {
    if (!groupId) return true // not encrypted — accessible
    if (isCreator) return true // creator always has access
    return !!(groupSecrets && groupSecrets[groupId])
  }

  // ── Auto-select a channel on hub entry ──
  // Entering a hub leaves no channel selected. Open the first *text* (chat) channel the
  // user can actually use — visible to them (view_channel) and decryptable (hub-wide, or a
  // grouped-role channel whose secret they hold) — walking the sidebar order (uncategorized
  // first, then categories by position). Hidden channels and ones locked behind a role
  // secret they don't have are skipped. Re-runs when a group secret arrives so a channel
  // that was locked at first can be picked once it unlocks.
  useEffect(() => {
    if (!hub || activeChannelId) return
    const byPos = (a: { position: number }, b: { position: number }) => a.position - b.position
    const ordered = [
      ...hub.channels.filter((c) => !c.categoryId).sort(byPos),
      ...[...hub.categories].sort(byPos).flatMap((cat) =>
        hub.channels.filter((c) => c.categoryId === cat.categoryId).sort(byPos)),
    ]
    const canView = (channelId: string) =>
      isCreator || !pubkey ? true : getPermissionsForUser(hub, pubkey, hubMembers, channelId).view_channel
    const first = ordered.find((c) =>
      c.type === 'chat' && canView(c.channelId) && hasGroupAccess(getChannelGroupId(c)))
    if (first) setActiveChannel(first.channelId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, activeChannelId, groupSecrets, hubMembers, pubkey, isCreator])

  const hostsByHub = useVoiceStore((s) => s.hostsByHub)

  // Check if any of user's voice hosts have an epoch mismatch
  const hasVoiceEpochMismatch = useMemo(() => {
    if (!hub || !pubkey) return false
    const hosts = hostsByHub[hub.dTag] || []
    const myHosts = hosts.filter((h) => h.pubkey === myVoicePubkey)
    if (myHosts.length > 0) {
      console.log(`[EpochCheck] myHosts for ${hub.dTag.slice(0, 8)}:`, myHosts.map(h => ({
        groupId: h.groupId?.slice(0, 8) || 'hub-wide',
        hostEpoch: h.epoch,
        groupEpoch: h.groupId ? hub.groupedRoles?.find(g => g.groupId === h.groupId)?.epoch : hub.epoch,
      })))
    }
    return myHosts.some((h) => {
      if (h.epoch === 0) return false
      if (h.groupId) {
        // Group-scoped: compare with the group's epoch
        const group = hub.groupedRoles?.find((g) => g.groupId === h.groupId)
        return group ? h.epoch !== group.epoch : false
      }
      // Hub-wide: compare with hub epoch
      return h.epoch !== hub.epoch
    })
  }, [hub, pubkey, myVoicePubkey, hostsByHub])

  // Join request count (creator only)
  const joinRequestCount = useJoinRequestCount(hub, hubMembers, isCreator)

  // Live calendar events — filtered by create_calendar_events permission
  const { decryptedEvents } = useCalendar(activeHubId)
  const liveEventCount = useMemo(() => {
    if (!hub || !decryptedEvents.length) return 0
    return decryptedEvents.filter((event) => {
      if (!isEventLive(event)) return false
      if (event.pubkey === hub.creatorPubkey) return true
      const eventPerms = getPermissionsForUser(hub, event.pubkey, hubMembers)
      return eventPerms.create_calendar_events
    }).length
  }, [decryptedEvents, hub, hubMembers])

  // Show loading skeleton immediately when a hub is selected but data hasn't loaded yet
  if (!hub) {
    const skeleton = (
      <>
        {/* Skeleton banner */}
        <div className="h-28 bg-secondary animate-pulse" />
        {/* Skeleton action bar */}
        <div className="px-3 py-2 border-b border-border">
          <div className="h-7 bg-secondary rounded-md animate-pulse" />
        </div>
        {/* Skeleton channels */}
        <div className="flex-1 py-3 px-2 flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-7 bg-secondary rounded-md animate-pulse" style={{ width: `${70 + i * 8}%` }} />
          ))}
        </div>
        {!isMobile && <UserPanel />}
      </>
    )
    if (isMobile) {
      return <div className="flex flex-col flex-1 overflow-hidden bg-secondary/50">{skeleton}</div>
    }
    return (
      <ResizablePanel id="hub" defaultWidth={280} minWidth={200} maxWidth={420} className="flex flex-col overflow-hidden bg-secondary/50">
        {skeleton}
      </ResizablePanel>
    )
  }

  /** Check if the current user can view a channel (respects view_channel permission overrides) */
  const canViewChannel = (channelId: string): boolean => {
    if (isCreator) return true
    if (!pubkey || !hub) return true // fallback: show (non-members handled elsewhere)
    const perms = getPermissionsForUser(hub, pubkey, hubMembers, channelId)
    return perms.view_channel
  }

  // Channels/categories to render: the staged draft while reordering, else live.
  const workChannels = layoutDraft?.channels ?? hub.channels
  const workCategories = layoutDraft?.categories ?? hub.categories

  // Reindex positions from array order (categories globally; channels within their
  // category) — the sidebar renders by `position`, so each drop arranges the array
  // then normalizes here to keep positions consistent.
  const normalizeLayout = (channels: HubData['channels'], categories: HubData['categories']) => {
    const cats = categories.map((c, i) => ({ ...c, position: i }))
    const counters: Record<string, number> = {}
    const chans = channels.map((c) => {
      const key = c.categoryId ?? '__none'
      const p = counters[key] ?? 0
      counters[key] = p + 1
      return { ...c, position: p }
    })
    return { channels: chans, categories: cats }
  }

  const onCategoryDragStart = (e: ReactDragEvent, catId: string) => { setDragItem({ type: 'category', id: catId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', catId) }
  const onCategoryDragOver = (e: ReactDragEvent, catId: string) => { e.preventDefault(); if (dragItem && dragItem.id !== catId) setDragOverTarget(catId) }
  const onCategoryDrop = (e: ReactDragEvent, targetCatId: string) => {
    e.preventDefault(); setDragOverTarget(null)
    if (dragItem?.type === 'channel') { moveChannelToCategory(dragItem.id, targetCatId); return }
    if (dragItem?.type !== 'category') { setDragItem(null); return }
    const cats = workCategories.map((c) => ({ ...c }))
    const fromIdx = cats.findIndex((c) => c.categoryId === dragItem.id)
    const toIdx = cats.findIndex((c) => c.categoryId === targetCatId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) { setDragItem(null); return }
    const [moved] = cats.splice(fromIdx, 1); cats.splice(toIdx, 0, moved)
    setLayoutDraft(normalizeLayout(workChannels, cats)); setDragItem(null)
  }
  const onChannelDragStart = (e: ReactDragEvent, channelId: string) => { setDragItem({ type: 'channel', id: channelId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', channelId) }
  const onChannelDragOver = (e: ReactDragEvent, targetChannelId: string) => { e.preventDefault(); if (dragItem?.type === 'channel' && dragItem.id !== targetChannelId) setDragOverTarget(targetChannelId) }
  const onChannelDrop = (e: ReactDragEvent, targetChannelId: string, targetCategoryId: string | null) => {
    e.preventDefault(); setDragOverTarget(null)
    if (!dragItem || dragItem.type !== 'channel' || dragItem.id === targetChannelId) { setDragItem(null); return }
    const channelsCopy = workChannels.map((c) => ({ ...c }))
    const fromIdx = channelsCopy.findIndex((c) => c.channelId === dragItem.id)
    if (fromIdx < 0) { setDragItem(null); return }
    const [moved] = channelsCopy.splice(fromIdx, 1)
    moved.categoryId = targetCategoryId
    const insertAt = channelsCopy.findIndex((c) => c.channelId === targetChannelId)
    channelsCopy.splice(insertAt < 0 ? channelsCopy.length : insertAt, 0, moved)
    setLayoutDraft(normalizeLayout(channelsCopy, workCategories)); setDragItem(null)
  }
  // Move a channel into a category (or null = uncategorized at top), appended last.
  const moveChannelToCategory = (channelId: string, targetCatId: string | null) => {
    const moved = workChannels.find((c) => c.channelId === channelId)
    if (!moved) { setDragItem(null); return }
    const others = workChannels.filter((c) => c.channelId !== channelId).map((c) => ({ ...c }))
    let lastIdx = -1
    others.forEach((c, i) => { if (c.categoryId === targetCatId) lastIdx = i })
    others.splice(lastIdx + 1, 0, { ...moved, categoryId: targetCatId })
    setLayoutDraft(normalizeLayout(others, workCategories)); setDragItem(null); setDragOverTarget(null)
  }
  const onDragEnd = () => { setDragItem(null); setDragOverTarget(null) }

  // Touch-friendly reorder: ▲/▼ buttons (HTML5 drag doesn't fire on touch, so this
  // is what makes mobile work). Swaps a channel with its adjacent same-category
  // sibling, or a category with its neighbour; normalizeLayout reindexes positions.
  const moveChannelStep = (channelId: string, dir: -1 | 1) => {
    const ch = workChannels.find((c) => c.channelId === channelId)
    if (!ch) return
    const arr = workChannels.map((c) => ({ ...c }))
    const siblingIdxs = arr.map((c, i) => (c.categoryId === ch.categoryId ? i : -1)).filter((i) => i >= 0)
    const pos = siblingIdxs.findIndex((i) => arr[i].channelId === channelId)
    const swap = pos + dir
    if (pos < 0 || swap < 0 || swap >= siblingIdxs.length) return
    const a = siblingIdxs[pos], b = siblingIdxs[swap]
    ;[arr[a], arr[b]] = [arr[b], arr[a]]
    setLayoutDraft(normalizeLayout(arr, workCategories))
  }
  const moveCategoryStep = (categoryId: string, dir: -1 | 1) => {
    const cats = [...workCategories].sort((a, b) => a.position - b.position).map((c) => ({ ...c }))
    const idx = cats.findIndex((c) => c.categoryId === categoryId)
    const swap = idx + dir
    if (idx < 0 || swap < 0 || swap >= cats.length) return
    ;[cats[idx], cats[swap]] = [cats[swap], cats[idx]]
    setLayoutDraft(normalizeLayout(workChannels, cats))
  }

  const publishLayout = async () => {
    if (!layoutDraft || publishingLayout) return
    setPublishingLayout(true); setLayoutError(null); setLayoutStep('signing')
    try {
      const { signHubEventForPublish } = await import('@/lib/hub/buildHubEvent')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const { isV2 } = await import('@/lib/hub/version')
      const signed = await signHubEventForPublish(hub, {
        dTag: hub.dTag, name: hub.name, description: hub.description || undefined,
        epoch: hub.epoch, icon: hub.icon || undefined, banner: hub.banner || undefined,
        tags: hub.tags && hub.tags.length ? hub.tags : undefined,
        relays: [...hub.generalRelays],
        blossomServers: hub.blossomServers, indexFileHash: hub.indexFileHash,
        channels: layoutDraft.channels, categories: layoutDraft.categories, roles: hub.roles,
        minPow: hub.minPow > 0 ? hub.minPow : undefined, joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined, nsfw: hub.nsfw || undefined, messageExpiration: hub.messageExpiration || undefined,
        discoverable: hub.discoverable, groupedRoles: hub.groupedRoles && hub.groupedRoles.length ? hub.groupedRoles : undefined,
        publishedAt: hub.publishedAt, eventCreatedAt: hub.eventCreatedAt,
      }, { pubkey: pubkey!, privateKey, signer, minPow: hub.minPow })
      setLayoutStep('publishing')
      // v2: hub relays ONLY — this republish is authored under the owner pseudonym O; sending it to the
      // owner's personal NIP-65 relays would correlate O → R_owner by relay footprint (the single v2 publish
      // site that was missing this).
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays], { hubOnly: isV2(hub) }), signed)
      setHubData(hub.dTag, { ...hub, channels: layoutDraft.channels, categories: layoutDraft.categories, eventCreatedAt: signed.created_at })
      setLayoutDraft(null)
      setLayoutStep('done')
    } catch (err: any) {
      console.error('[ChannelList] Failed to publish channel order:', err)
      setLayoutError(err?.message || 'Failed to publish')
    } finally {
      setPublishingLayout(false)
    }
  }
  const discardLayout = () => { setLayoutDraft(null); setLayoutError(null); setDragItem(null); setDragOverTarget(null); setLayoutStep(null) }

  const uncategorized = workChannels
    .filter((c) => !c.categoryId)
    .filter((c) => canViewChannel(c.channelId))
    .slice()
    .sort((a, b) => a.position - b.position)

  const categorized = [...workCategories]
    .sort((a, b) => a.position - b.position)
    .map((cat) => ({
      ...cat,
      channels: workChannels
        .filter((c) => c.categoryId === cat.categoryId)
        .slice()
        .sort((a, b) => a.position - b.position),
    }))
    .filter((cat) => {
      // Hide categories where ALL channels are hidden by view_channel
      if (isCreator) return true
      return cat.channels.some((c) => canViewChannel(c.channelId))
    })

  // Lightweight draggable channel row for edit mode. Deliberately minimal (no store
  // subscriptions, no source-style change on drag) so HTML5 drag stays reliable —
  // unlike the heavy ChannelItem used for normal browsing.
  const layoutRow = (channel: HubData['channels'][number], categoryId: string | null, index: number, total: number) => (
    <div
      key={channel.channelId}
      draggable
      onDragStart={(e) => onChannelDragStart(e, channel.channelId)}
      onDragOver={(e) => onChannelDragOver(e, channel.channelId)}
      onDrop={(e) => { e.stopPropagation(); onChannelDrop(e, channel.channelId, categoryId) }}
      onDragEnd={onDragEnd}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-md border bg-background/60 cursor-grab active:cursor-grabbing text-sm transition-colors',
        dragOverTarget === channel.channelId ? 'border-primary ring-1 ring-primary/40' : 'border-border/60 hover:border-border',
      )}
    >
      <GripVertical size={12} className="text-muted-foreground/70 shrink-0" />
      <Hash size={12} className="text-muted-foreground shrink-0" />
      <span className="truncate text-foreground flex-1 min-w-0">{channel.name}</span>
      {/* Move to category (touch-friendly, matches the app's dropdown style) */}
      <CustomSelect
        compact
        value={categoryId ?? '__none'}
        onChange={(v) => moveChannelToCategory(channel.channelId, v === '__none' ? null : v)}
        options={[{ value: '__none', label: 'No category' }, ...workCategories.map((c) => ({ value: c.categoryId, label: c.name }))]}
        className="shrink-0"
        triggerClassName="max-w-[104px]"
      />
      {/* Up / down (work on touch) */}
      <Tip text="Move up">
        <button
          onClick={() => moveChannelStep(channel.channelId, -1)}
          disabled={index === 0}
          className={cn('p-0.5 rounded shrink-0', index === 0 ? 'opacity-30' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer')}
        >
          <ChevronUp size={13} />
        </button>
      </Tip>
      <Tip text="Move down">
        <button
          onClick={() => moveChannelStep(channel.channelId, 1)}
          disabled={index === total - 1}
          className={cn('p-0.5 rounded shrink-0', index === total - 1 ? 'opacity-30' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer')}
        >
          <ChevronDown size={13} />
        </button>
      </Tip>
    </div>
  )

  // Widest position number across the whole hub — used to right-align the index
  // column so 1- and 2-digit numbers line up without zero-padding.
  const positionDigits = workChannels.length
    ? String(Math.max(...workChannels.map((c) => c.position))).length
    : 1



  // On mobile, selecting a channel also transitions to chat view
  const handleSelectChannel = (channelId: string) => {
    setActiveChannel(channelId)
    if (isMobile) setMobileView('chat')
  }

  const Wrapper = isMobile ? MobileWrapper : DesktopWrapper

  return (
    <Wrapper>
      {/* Header card — banner + (live event) + nav merged into one card */}
      <div className="rounded-lg overflow-hidden shadow-md shrink-0">
      {/* Banner area */}
      <div className="relative bg-secondary/50" style={{ minHeight: hub.banner ? '110px' : '48px' }}>
        {hub.banner ? (
          <>
            <BlossomImage
              src={hub.banner}
              alt={`${hub.name} banner`}
              className="w-full h-28 object-cover"
            />
            {/* Bottom gradient so the hub name stays readable over the banner */}
            <div className="absolute bottom-0 left-0 right-0 h-full max-h-[50%] bg-gradient-to-t from-black/75 to-transparent pointer-events-none" />
            {/* Hub name — positioned over the gradient */}
            <div className="absolute bottom-0 left-0 right-0 flex items-center px-3 py-2 gap-2">

              <button
                onClick={() => setShowInfo(true)}
                className="font-semibold text-sm truncate text-white flex-1 text-left rounded-md px-2 py-0.5 drop-shadow-sm transition-all duration-300 hover:bg-white/10 cursor-pointer"
              >
                {hub.name}
              </button>
            </div>
          </>
        ) : (
          /* No banner — simple header with hub name */
          <div className="flex items-center gap-2 px-4 h-12 min-h-12">

            <button
              onClick={() => setShowInfo(true)}
              className="font-semibold text-sm truncate text-foreground hover:underline cursor-pointer"
            >
              {hub.name}
            </button>
          </div>
        )}
      </div>

      {/* Live event banner */}
      {liveEventCount > 0 && (
        <button
          onClick={() => setShowEvents(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 cursor-pointer hover:bg-blue-500/15 transition-colors w-full"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="text-[11px] font-medium text-blue-400">
            {liveEventCount === 1 ? 'An event is live' : `${liveEventCount} events are live`}
          </span>
        </button>
      )}

      {/* Action items — collapsible "Hub Menu" */}
      {!isModBanned && (
        <div className="p-1.5 bg-secondary/50">
          <button
            onClick={() => setHubMenuOpen((v) => !v)}
            className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <span>Hub Menu</span>
            <span className="ml-auto flex items-center gap-1.5">
              {/* When collapsed, surface anything inside that needs attention so it isn't hidden away. */}
              {!hubMenuOpen && (joinRequestCount > 0 || hasVoiceEpochMismatch) && (
                <span className="flex items-center gap-1">
                  {joinRequestCount > 0 && (
                    <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1 bg-blue-500 text-white">
                      {joinRequestCount > 99 ? '99+' : joinRequestCount}
                    </span>
                  )}
                  {hasVoiceEpochMismatch && <AlertTriangle size={13} className="text-amber-400" />}
                </span>
              )}
              <ChevronRight size={13} className={cn('transition-transform', hubMenuOpen && 'rotate-90')} />
            </span>
          </button>
          {hubMenuOpen && (
          <div className="flex flex-wrap gap-1 mt-1">
          {(() => {
            const canInvite = isCreator || (pubkey && hub ? getPermissionsForUser(hub, pubkey, hubMembers).create_invite : false)
            return canInvite ? (
              <button
                onClick={() => setShowInvite(true)}
                className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md text-left text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <UserPlus size={16} />
                <span>Invite</span>
              </button>
            ) : null
          })()}
          <button
            onClick={() => setShowEvents(true)}
            className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md text-left text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <CalendarDays size={16} />
            <span>Events</span>
            {liveEventCount > 0 && (
              <span className="relative flex h-2 w-2 ml-auto">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            )}
          </button>
          {isCreator && (
            <>
              <button
                onClick={() => setShowSettings(true)}
                className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md text-left text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <Settings size={16} />
                <span>Hub Settings</span>
              </button>
              <button
                onClick={() => { markJoinRequestsSeen(hub!.dTag); setShowJoinRequests(true) }}
                className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md text-left text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <Inbox size={16} />
                <span>Join Requests</span>
                {joinRequestCount > 0 && (
                  <span className="ml-auto min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1 bg-blue-500 text-white">
                    {joinRequestCount > 99 ? '99+' : joinRequestCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => setEditingLayout((v) => !v)}
                className={cn(
                  'flex-1 flex items-center gap-2 px-2 py-1 rounded-md text-left text-sm whitespace-nowrap transition-colors cursor-pointer',
                  editingLayout ? 'bg-primary/15 text-primary hover:bg-primary/20' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
              >
                {editingLayout ? <Check size={16} /> : <ListOrdered size={16} />}
                <span>{editingLayout ? 'Done Reordering' : 'Edit Channels'}</span>
              </button>
            </>
          )}
          <button
            onClick={() => setShowUserSettings(true)}
            className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md text-left text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <SlidersHorizontal size={13} />
            <span>User Settings</span>
            {hasVoiceEpochMismatch && (
              <AlertTriangle size={14} className="text-amber-400 ml-auto" />
            )}
          </button>
          {/* Rescind join request — visible when not a direct member and secrets resolved */}
          {showRescind && (
            <button
              onClick={() => setShowRescindConfirm(true)}
              className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md text-left text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer whitespace-nowrap"
            >
              <Undo2 size={16} />
              <span>Rescind Join Request</span>
            </button>
          )}
          </div>
          )}
        </div>
      )}
      </div>

      {/* Reorder banner (creator, desktop) — shows when there are staged changes */}
      {isCreator && !isMobile && layoutDraft && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 shrink-0">
          <span className="text-[11px] font-medium text-amber-500 truncate">Unconfirmed changes</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={discardLayout} disabled={publishingLayout} className="px-2 py-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-40">Discard</button>
            <button onClick={publishLayout} disabled={publishingLayout} className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">
              {publishingLayout ? <><Loader2 size={11} className="animate-spin" /> Publishing…</> : 'Publish'}
            </button>
          </div>
        </div>
      )}
      {isCreator && layoutError && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-destructive/10 border border-destructive/30 text-[11px] text-destructive shrink-0">
          <AlertTriangle size={11} className="shrink-0" /> {layoutError}
        </div>
      )}

      {/* Channel list — de-rendered when mod-banned */}
      {isModBanned ? (
        <div className="flex-1 flex items-center justify-center py-8 rounded-lg bg-secondary/50 shadow-md">
          <p className="text-xs text-muted-foreground/50 italic">Channels unavailable</p>
        </div>
      ) : editingLayout ? (
        /* ── Edit mode: lightweight reorder view (creator, desktop) ── */
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide rounded-lg bg-secondary/50 shadow-md p-2 space-y-2">
          <p className="text-[10px] text-muted-foreground leading-snug px-1">
            Use ▲ ▼ to reorder and the dropdown to move a channel between categories. On desktop you can also drag rows and drop a channel on a category header.
          </p>

          {/* No-category zone */}
          <div
            onDragOver={(e) => { if (dragItem?.type === 'channel') { e.preventDefault(); setDragOverTarget('__uncat_top') } }}
            onDrop={(e) => { if (dragItem?.type === 'channel') { e.preventDefault(); moveChannelToCategory(dragItem.id, null) } }}
            onDragLeave={() => setDragOverTarget((t) => (t === '__uncat_top' ? null : t))}
            className={cn('rounded-md border border-dashed p-1.5 space-y-1 transition-colors', dragOverTarget === '__uncat_top' ? 'border-primary bg-primary/10' : 'border-border/50')}
          >
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground/60 px-1">No category</p>
            {uncategorized.length === 0 && (
              <p className="text-[10px] text-muted-foreground/40 text-center py-1">Drop here to remove a channel from its category</p>
            )}
            {uncategorized.map((channel, i) => layoutRow(channel, null, i, uncategorized.length))}
          </div>

          {/* Categories (draggable headers) + their channels */}
          {categorized.map((cat, ci) => (
            <div key={cat.categoryId} onDragEnd={onDragEnd}>
              <div
                draggable
                onDragStart={(e) => onCategoryDragStart(e, cat.categoryId)}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (dragItem?.type === 'category' && dragItem.id !== cat.categoryId) setDragOverTarget(cat.categoryId)
                  else if (dragItem?.type === 'channel') setDragOverTarget(cat.categoryId)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragItem?.type === 'category') onCategoryDrop(e, cat.categoryId)
                  else if (dragItem?.type === 'channel') moveChannelToCategory(dragItem.id, cat.categoryId)
                }}
                onDragLeave={() => setDragOverTarget((t) => (t === cat.categoryId ? null : t))}
                className={cn('flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-grab active:cursor-grabbing transition-colors', dragOverTarget === cat.categoryId ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-accent/40')}
              >
                <GripVertical size={12} className="text-muted-foreground shrink-0" />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground truncate flex-1 min-w-0">{cat.name}</span>
                <Tip text="Move category up">
                  <button
                    onClick={(e) => { e.stopPropagation(); moveCategoryStep(cat.categoryId, -1) }}
                    disabled={ci === 0}
                    className={cn('p-0.5 rounded shrink-0', ci === 0 ? 'opacity-30' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer')}
                  >
                    <ChevronUp size={13} />
                  </button>
                </Tip>
                <Tip text="Move category down">
                  <button
                    onClick={(e) => { e.stopPropagation(); moveCategoryStep(cat.categoryId, 1) }}
                    disabled={ci === categorized.length - 1}
                    className={cn('p-0.5 rounded shrink-0', ci === categorized.length - 1 ? 'opacity-30' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer')}
                  >
                    <ChevronDown size={13} />
                  </button>
                </Tip>
              </div>
              <div className="pl-3 pt-1 space-y-1">
                {cat.channels.length === 0 && (
                  <p className="text-[10px] text-muted-foreground/40 px-1 py-0.5">Empty</p>
                )}
                {cat.channels.map((channel, i) => layoutRow(channel, cat.categoryId, i, cat.channels.length))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 min-h-0 relative">
        <div ref={channelScrollRef} className="h-full overflow-y-auto py-2 scrollbar-hide rounded-lg bg-secondary/50 shadow-md">
          {uncategorized.map((channel) => {
            const gid = getChannelGroupId(channel)
            const locked = !hasGroupAccess(gid)
            return (
              <ChannelItem
                key={channel.channelId}
                channel={channel}
                position={channel.position}
                positionDigits={positionDigits}
                isActive={activeChannelId === channel.channelId}
                onClick={() => !locked && handleSelectChannel(channel.channelId)}
                isLocked={locked}
                isPrivate={!!gid}
              />
            )
          })}

          {categorized.map((cat) => (
            <CategoryGroup
              key={cat.categoryId}
              categoryId={cat.categoryId}
              name={cat.name}
              channels={cat.channels}
              positionDigits={positionDigits}
              activeChannelId={activeChannelId}
              onSelectChannel={handleSelectChannel}
              categoryEncryption={cat.encryption}
              groupSecrets={groupSecrets}
              isCreator={isCreator}
              hub={hub}
              hubMembers={hubMembers}
              pubkey={pubkey}
            />
          ))}
        </div>
        {activeHubId && <UnreadScrollHints scrollRef={channelScrollRef} hubDTag={activeHubId} activeChannelId={activeChannelId} />}
        </div>
      )}

      {!isMobile && <UserPanel />}

      {/* Publish-progress modal for reordering (mirrors Hub Settings → Channels) */}
      {layoutStep !== null && createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card rounded-xl border border-border shadow-2xl w-[320px] p-5 space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5">
              {layoutError ? (
                <div className="w-8 h-8 rounded-full bg-destructive/15 flex items-center justify-center shrink-0"><AlertTriangle size={16} className="text-destructive" /></div>
              ) : layoutStep === 'done' ? (
                <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0"><Check size={16} className="text-emerald-400" /></div>
              ) : (
                <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0"><Loader2 size={16} className="text-primary animate-spin" /></div>
              )}
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-foreground">
                  {layoutError ? 'Failed to Publish' : layoutStep === 'done' ? 'Changes Published' : 'Publishing Changes…'}
                </h4>
                <p className="text-[11px] text-muted-foreground truncate">
                  {layoutError ? layoutError : layoutStep === 'done' ? 'Channel order updated for everyone.' : layoutStep === 'signing' ? 'Signing hub event…' : 'Publishing to relays…'}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              {([{ id: 'signing', label: 'Signing hub event' }, { id: 'publishing', label: 'Publishing to relays' }] as const).map((s) => {
                const order = ['signing', 'publishing', 'done']
                const curIdx = order.indexOf(layoutStep)
                const sIdx = order.indexOf(s.id)
                const isDone = layoutStep === 'done' || curIdx > sIdx
                const isCurrent = layoutStep === s.id && !layoutError
                return (
                  <div key={s.id} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs">
                    {isDone ? <Check size={12} className="text-emerald-400 shrink-0" /> : isCurrent ? <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" /> : <div className="w-3 h-3 rounded-full border border-border shrink-0" />}
                    <span className={cn(isDone ? 'text-emerald-400' : isCurrent ? 'text-foreground' : 'text-muted-foreground/50')}>{s.label}</span>
                  </div>
                )
              })}
            </div>

            {layoutStep === 'done' && !layoutError && (
              <button onClick={() => setLayoutStep(null)} className="w-full h-9 text-sm rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer">Close</button>
            )}
            {layoutError && (
              <div className="flex items-center gap-2">
                <button onClick={() => { setLayoutError(null); publishLayout() }} className="flex-1 h-8 text-xs rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer">Retry</button>
                <button onClick={() => { setLayoutStep(null); setLayoutError(null) }} className="flex-1 h-8 text-xs rounded-lg font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer">Dismiss</button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* Settings modal */}
      {isCreator && (
        <HubSettingsModal
          open={showSettings}
          onClose={() => setShowSettings(false)}
          hub={hub}
        />
      )}

      {/* Info modal */}
      <HubInfoModal
        open={showInfo}
        onClose={() => setShowInfo(false)}
        hub={hub}
        onCreatorClick={() => {
          setShowInfo(false)
          setShowCreatorProfile(true)
        }}
      />

      {/* Creator profile modal */}
      <UserProfileModal
        open={showCreatorProfile}
        onClose={() => setShowCreatorProfile(false)}
        targetPubkey={hub.creatorPubkey}
      />

      {/* Invite modal */}
      <InviteModal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        hub={hub}
      />

      {/* Join requests modal (creator only) */}
      {isCreator && (
        <JoinRequestsModal
          open={showJoinRequests}
          onClose={() => setShowJoinRequests(false)}
          hub={hub}
        />
      )}

      {/* User Hub Settings modal. Mount only while open AND key by hub, so it UNMOUNTS on close and
          REMOUNTS per hub — otherwise (it `return null`s but never unmounts) per-hub state bleeds
          across hubs: voice SFU credentials, the mod ban list, voice-scope configs. */}
      {showUserSettings && (
        <UserHubSettingsModal
          key={hub.dTag}
          open
          onClose={() => { setShowUserSettings(false); setUserSettingsInitialTab(undefined) }}
          hub={hub}
          initialTab={userSettingsInitialTab}
        />
      )}

      {/* Calendar Events modal */}
      {activeHubId && showEvents && (
        <CalendarPanel
          hubDTag={activeHubId}
          open={showEvents}
          onClose={() => setShowEvents(false)}
        />
      )}

      {/* Rescind join request confirmation */}
      {showRescindConfirm && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => { if (!rescinding) setShowRescindConfirm(false) }}
        >
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-foreground mb-2">Rescind Join Request</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Are you sure you want to rescind your join request? This withdraws your pending request and removes the hub from your list. You can request to join again later.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRescindConfirm(false)}
                disabled={rescinding}
                className="px-3 py-1.5 rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRescind}
                disabled={rescinding}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-destructive text-white hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {rescinding ? <><Loader2 size={14} className="animate-spin" /> Rescinding...</> : 'Yes, Rescind'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Wrapper>
  )
}

// Wrappers for mobile vs desktop rendering
function MobileWrapper({ children }: { children: ReactNode }) {
  return <div className="flex flex-col flex-1 overflow-hidden bg-background p-2 gap-2">{children}</div>
}
function DesktopWrapper({ children }: { children: ReactNode }) {
  return (
    <ResizablePanel id="hub" defaultWidth={280} minWidth={200} maxWidth={420} className="flex flex-col overflow-hidden bg-background pr-2 py-2 gap-2">
      {children}
    </ResizablePanel>
  )
}

/** Drag-and-drop handlers threaded from ChannelList into CategoryGroup (creator only). */
type HubDnd = {
  dragItem: { type: 'category' | 'channel'; id: string } | null
  dragOverTarget: string | null
  setDragOverTarget: (t: string | null | ((prev: string | null) => string | null)) => void
  onCategoryDragStart: (e: ReactDragEvent, catId: string) => void
  onCategoryDragOver: (e: ReactDragEvent, catId: string) => void
  onCategoryDrop: (e: ReactDragEvent, targetCatId: string) => void
  onChannelDragStart: (e: ReactDragEvent, channelId: string) => void
  onChannelDragOver: (e: ReactDragEvent, targetChannelId: string) => void
  onChannelDrop: (e: ReactDragEvent, targetChannelId: string, targetCategoryId: string | null) => void
  moveChannelToCategory: (channelId: string, targetCatId: string | null) => void
  onDragEnd: () => void
}

interface CategoryGroupProps {
  categoryId: string
  name: string
  channels: Array<{ channelId: string; name: string; type: string; position: number; encryption: string | null; synced: boolean; categoryId: string | null }>
  positionDigits: number
  activeChannelId: string | null
  onSelectChannel: (id: string) => void
  categoryEncryption: string | null
  groupSecrets?: Record<string, string>
  isCreator: boolean
  hub: import('@/stores/hubStore').HubData | null
  hubMembers?: Array<{ pubkey: string; roles: string }>
  pubkey: string | null
  dnd?: HubDnd | null
}

function CategoryGroup({ categoryId, name, channels, positionDigits, activeChannelId, onSelectChannel, categoryEncryption, groupSecrets, isCreator, hub, hubMembers, pubkey, dnd }: CategoryGroupProps) {
  const [collapsed, setCollapsed] = useState(false)

  const hasGroupAccess = (groupId: string | null): boolean => {
    if (!groupId) return true
    if (isCreator) return true
    return !!(groupSecrets && groupSecrets[groupId])
  }

  const getChannelGroupId = (ch: { encryption: string | null; synced: boolean; categoryId: string | null }) => {
    if (ch.encryption) return ch.encryption
    if (ch.synced && ch.categoryId && categoryEncryption) return categoryEncryption
    return null
  }

  // If the entire category is locked, show lock icon next to name
  const categoryLocked = categoryEncryption ? !hasGroupAccess(categoryEncryption) : false

  const isCatDropTarget = dnd?.dragOverTarget === categoryId

  return (
    <div className="mt-3" onDragEnd={dnd ? dnd.onDragEnd : undefined}>
      {/* Category-reorder drop indicator */}
      {dnd && isCatDropTarget && dnd.dragItem?.type === 'category' && (
        <div className="h-0.5 bg-primary rounded-full mx-2 mb-1" />
      )}
      <button
        onClick={() => setCollapsed(!collapsed)}
        draggable={!!dnd}
        onDragStart={dnd ? (e) => dnd.onCategoryDragStart(e, categoryId) : undefined}
        onDragOver={dnd ? (e) => {
          e.preventDefault()
          if (dnd.dragItem?.type === 'category' && dnd.dragItem.id !== categoryId) dnd.setDragOverTarget(categoryId)
          else if (dnd.dragItem?.type === 'channel') dnd.setDragOverTarget(categoryId)
        } : undefined}
        onDrop={dnd ? (e) => {
          e.preventDefault(); e.stopPropagation()
          if (dnd.dragItem?.type === 'category') dnd.onCategoryDrop(e, categoryId)
          else if (dnd.dragItem?.type === 'channel') dnd.moveChannelToCategory(dnd.dragItem.id, categoryId)
        } : undefined}
        onDragLeave={dnd ? () => dnd.setDragOverTarget((t) => (t === categoryId ? null : t)) : undefined}
        className={cn(
          'flex items-center gap-1 px-2 py-1 w-full text-left group rounded-md transition-colors',
          dnd ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
          isCatDropTarget && dnd?.dragItem?.type === 'channel' && 'ring-2 ring-primary/40 bg-primary/5',
        )}
      >
        {collapsed ? (
          <ChevronRight size={10} className="text-muted-foreground" />
        ) : (
          <ChevronDown size={10} className="text-muted-foreground" />
        )}
        <span className={cn('text-xs font-semibold uppercase tracking-wide', categoryLocked ? 'text-muted-foreground/40' : 'text-muted-foreground')}>{name}</span>
        {categoryEncryption && (
          <Lock size={10} className={cn('shrink-0 ml-auto', categoryLocked ? 'text-muted-foreground/40' : 'text-muted-foreground/60')} />
        )}
      </button>

      {!collapsed &&
        channels
          .filter((channel) => {
            // Enforce view_channel permission
            if (isCreator || !hub || !pubkey) return true
            const perms = getPermissionsForUser(hub, pubkey, hubMembers, channel.channelId)
            return perms.view_channel
          })
          .map((channel) => {
            const gid = getChannelGroupId(channel)
            const locked = !hasGroupAccess(gid)
            return (
              <ChannelItem
                key={channel.channelId}
                channel={channel}
                position={channel.position}
                positionDigits={positionDigits}
                isActive={activeChannelId === channel.channelId}
                onClick={() => !locked && onSelectChannel(channel.channelId)}
                isLocked={locked}
                isPrivate={!!gid}
                drag={dnd ? {
                  draggable: true,
                  onDragStart: (e) => dnd.onChannelDragStart(e, channel.channelId),
                  onDragOver: (e) => dnd.onChannelDragOver(e, channel.channelId),
                  onDrop: (e) => { e.stopPropagation(); dnd.onChannelDrop(e, channel.channelId, categoryId) },
                  onDragEnd: dnd.onDragEnd,
                  isOver: dnd.dragOverTarget === channel.channelId,
                  isDragging: dnd.dragItem?.id === channel.channelId,
                } : undefined}
              />
            )
          })}
    </div>
  )
}

/**
 * UnreadScrollHints — Discord-style sticky pills in the channel list.
 *
 * Shows "New unreads" at the top/bottom when a channel with unread messages is
 * scrolled out of view in that direction. A mention takes priority over a plain
 * unread (different styling + wording). Clicking scrolls to the nearest one —
 * preferring the nearest mention when there is one.
 */
function UnreadScrollHints({ scrollRef, hubDTag, activeChannelId }: {
  scrollRef: { current: HTMLDivElement | null }
  hubDTag: string
  activeChannelId: string | null
}) {
  const notifReady = useNotificationStore((s) => s.initialized)
  const hubUnreads = useNotificationStore((s) => s.hubUnreads[hubDTag])

  type Hint = { channelId: string; mention: boolean } | null
  const [above, setAbove] = useState<Hint>(null)
  const [below, setBelow] = useState<Hint>(null)

  // Channels with unread messages (excluding the one you're currently reading).
  const unreadList = useMemo(() => {
    if (!notifReady || !hubUnreads) return []
    return Object.entries(hubUnreads)
      .filter(([cid, u]) => u.count > 0 && cid !== activeChannelId)
      .map(([cid, u]) => ({ channelId: cid, mention: !!u.hasMention }))
  }, [notifReady, hubUnreads, activeChannelId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const measure = () => {
      if (unreadList.length === 0) { setAbove(null); setBelow(null); return }
      const box = el.getBoundingClientRect()
      // Track the nearest unread and the nearest mention separately per direction,
      // then let a mention win (mentions take priority over plain unreads).
      let aNear: Hint = null, aNearEdge = -Infinity
      let aMent: Hint = null, aMentEdge = -Infinity
      let bNear: Hint = null, bNearEdge = Infinity
      let bMent: Hint = null, bMentEdge = Infinity

      for (const u of unreadList) {
        const node = el.querySelector(`[data-channel-id="${CSS.escape(u.channelId)}"]`)
        if (!node) continue // e.g. inside a collapsed category — nothing to scroll to
        const r = node.getBoundingClientRect()

        if (r.bottom <= box.top + 2) {
          // Above the viewport — nearest is the largest bottom edge
          if (r.bottom > aNearEdge) { aNearEdge = r.bottom; aNear = u }
          if (u.mention && r.bottom > aMentEdge) { aMentEdge = r.bottom; aMent = u }
        } else if (r.top >= box.bottom - 2) {
          // Below the viewport — nearest is the smallest top edge
          if (r.top < bNearEdge) { bNearEdge = r.top; bNear = u }
          if (u.mention && r.top < bMentEdge) { bMentEdge = r.top; bMent = u }
        }
      }
      setAbove(aMent ?? aNear)
      setBelow(bMent ?? bNear)
    }

    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', measure); ro.disconnect() }
  }, [scrollRef, unreadList])

  const scrollTo = (channelId: string) => {
    const el = scrollRef.current
    const node = el?.querySelector(`[data-channel-id="${CSS.escape(channelId)}"]`)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const pill = (hint: NonNullable<Hint>, dir: 'up' | 'down') => (
    <button
      onClick={() => scrollTo(hint.channelId)}
      className={cn(
        'absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 px-2.5 py-1 rounded-full',
        'text-[10px] font-semibold shadow-md cursor-pointer transition-colors max-w-[92%]',
        dir === 'up' ? 'top-1' : 'bottom-1',
        hint.mention
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'bg-background/95 text-foreground border border-border hover:bg-accent',
      )}
    >
      {dir === 'up' ? <ChevronUp size={11} className="shrink-0" /> : null}
      {hint.mention && <AtSign size={11} className="shrink-0" />}
      <span className="truncate">{hint.mention ? 'Someone mentioned you' : 'New unreads'}</span>
      {dir === 'down' ? <ChevronDown size={11} className="shrink-0" /> : null}
    </button>
  )

  return (
    <>
      {above && pill(above, 'up')}
      {below && pill(below, 'down')}
    </>
  )
}

interface ChannelItemProps {
  channel: { channelId: string; name: string; type: string }
  position: number
  positionDigits: number
  isActive: boolean
  onClick: () => void
  isLocked?: boolean
  isPrivate?: boolean
  // Drag props live on the button itself — a `draggable` wrapper around a <button>
  // never starts a drag (form controls swallow the gesture), which is why the
  // category header (draggable directly on its button) works and a wrapper doesn't.
  drag?: {
    draggable: boolean
    onDragStart: (e: ReactDragEvent) => void
    onDragOver: (e: ReactDragEvent) => void
    onDrop: (e: ReactDragEvent) => void
    onDragEnd: (e: ReactDragEvent) => void
    isOver: boolean
    isDragging: boolean
  }
}

function ChannelItem({ channel, position, positionDigits, isActive, onClick, isLocked = false, isPrivate = false, drag }: ChannelItemProps) {
  // Voice channel presence count
  const presenceByHub = useVoiceStore((s) => s.presenceByHub)
  const getChannelPresence = useVoiceStore((s) => s.getChannelPresence)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const currentHostPubkey = useVoiceStore((s) => s.currentHostPubkey)
  const currentVoiceIdentity = useVoiceStore((s) => s.currentVoiceIdentity)
  const switchHost = useVoiceStore((s) => s.switchHost)
  const connectionState = useVoiceStore((s) => s.connectionState)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const selfSpeaking = useVoiceStore((s) => s._isSpeaking)
  const myIsMuted = useVoiceStore((s) => s.isMuted)
  const myIsDeafened = useVoiceStore((s) => s.isDeafened)
  const myIsVideoEnabled = useVoiceStore((s) => s.isVideoEnabled)
  const myIsScreenSharing = useVoiceStore((s) => s.isScreenSharing)
  const myIsSpatial = useVoiceStore((s) => s.spatialEnabled)
  const myIsVspace = useVoiceStore((s) => s.virtualSpaceOpen)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const myPubkey = useUserStore((s) => s.pubkey)
  // Our voice wire identity: pseudonym P on a v2 hub (once connected), else our real key R.
  // Presence entries are keyed by the wire identity, so self-recognition must use this.
  const myVoiceId = currentVoiceIdentity || myPubkey
  const voiceChatMode = useVoiceStore((s) => s.voiceChatMode)
  const toggleVoiceChatMode = useVoiceStore((s) => s.toggleVoiceChatMode)
  const setVoiceChatMode = useVoiceStore((s) => s.setVoiceChatMode)
  const activeChannelId = useHubStore((s) => s.activeChannelId)

  // Unread notification state — suppress until notification store is initialized
  const notifReady = useNotificationStore((s) => s.initialized)
  const channelUnread = useNotificationStore((s) =>
    activeHubId ? s.hubUnreads[activeHubId]?.[channel.channelId] : undefined
  )
  const isUnread = notifReady && !isActive && (channelUnread?.count ?? 0) > 0
  const hasMention = notifReady && (channelUnread?.hasMention ?? false)
  const unreadCount = notifReady ? (channelUnread?.count ?? 0) : 0

  const isVoice = channel.type === 'voice'
  const isInVoice = isVoice && connectionState === 'connected' && currentChannelId === channel.channelId
  const isConnecting = isVoice && connectionState === 'connecting' && currentChannelId === channel.channelId
  const voicePresence = isVoice && hub ? getChannelPresence(hub.dTag, channel.channelId) : []

  // Voice chat icon is highlighted only if THIS channel is active AND voiceChatMode is on
  const isThisChannelActive = activeChannelId === channel.channelId
  const chatActiveForThis = isThisChannelActive && voiceChatMode

  // Show self in the slab immediately while connecting or just connected but not yet in presence
  const selfAlreadyInPresence = voicePresence.some((p) => p.pubkey === myVoiceId)
  const showPendingSelf = (isConnecting || (isInVoice && !selfAlreadyInPresence)) && !!myPubkey

  return (
    <div
      className={cn('mb-1 relative rounded-md transition-shadow', drag?.isOver && 'ring-2 ring-primary/40')}
      data-channel-id={channel.channelId}
      data-channel-hub={activeHubId || undefined}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
    >
      {/* Discord-style unread pill bar on the left edge */}
      {isUnread && (
        <div
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-foreground transition-all duration-200',
            hasMention ? 'h-5' : 'h-2'
          )}
        />
      )}

      <button
        draggable={drag?.draggable}
        onDragStart={drag?.onDragStart}
        onDragEnd={drag?.onDragEnd}
        onClick={() => {
          if (!isThisChannelActive && voiceChatMode) {
            setVoiceChatMode(false)
          }
          onClick()
        }}
        className={cn(
          'flex items-center gap-2 px-2 py-2 mx-2 rounded-md text-sm w-[calc(100%-16px)] text-left transition-colors',
          isLocked
            ? 'opacity-40 cursor-not-allowed'
            : drag?.draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
          !isLocked && isThisChannelActive
            ? 'bg-accent text-accent-foreground'
            : !isLocked ? 'text-muted-foreground hover:bg-accent/50 hover:text-foreground' : 'text-muted-foreground',
          (isInVoice || isConnecting) && 'ring-1 ring-emerald-400/40 bg-emerald-500/5',
          isUnread && !isLocked && 'text-foreground'
        )}
      >
        {channel.type === 'voice' ? (
          <Volume2 size={18} className={cn('shrink-0', (isInVoice || isConnecting) ? 'text-emerald-400' : isUnread ? 'text-foreground/70' : 'text-muted-foreground')} />
        ) : channel.type === 'announcement' ? (
          <Megaphone size={18} className={cn('shrink-0', isUnread ? 'text-foreground/70' : 'text-muted-foreground')} />
        ) : channel.type === 'forum' ? (
          <MessagesSquare size={18} className={cn('shrink-0', isUnread ? 'text-foreground/70' : 'text-muted-foreground')} />
        ) : (
          <Hash size={18} className={cn('shrink-0', isUnread ? 'text-foreground/70' : 'text-muted-foreground')} />
        )}
        <span className="text-md text-muted-foreground/60 font-bold tabular-nums text-right shrink-0" style={{ width: `${positionDigits}ch` }}>{position}</span>
        <span className={cn('truncate flex-1', isUnread && 'font-semibold')}>{channel.name}</span>
        {isPrivate && <Lock size={14} className={cn('shrink-0', isLocked ? 'text-muted-foreground/40' : 'text-muted-foreground/60')} />}
        {/* Unread count badge — or pulsing dot while loading */}
        {!notifReady && !isActive ? (
          <span className="shrink-0 w-[8px] h-[8px] rounded-full bg-muted-foreground/30 animate-pulse" />
        ) : isUnread && unreadCount > 0 ? (
          <span className={cn(
            'shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1',
            hasMention
              ? 'bg-destructive text-destructive-foreground'
              : 'bg-muted-foreground/30 text-foreground'
          )}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
        {isVoice && (
          <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  const navStore = useNavigationStore.getState()
                  const isMobileNow = window.innerWidth <= 1080
                  if (isThisChannelActive) {
                    if (isMobileNow) {
                      // Mobile: always enable voice chat and navigate
                      setVoiceChatMode(true)
                      navStore.setMobileView('chat')
                    } else {
                      // Desktop: toggle chat mode
                      toggleVoiceChatMode()
                    }
                  } else {
                    // Different channel — select it and enable chat mode
                    onClick()
                    setVoiceChatMode(true)
                    if (isMobileNow) navStore.setMobileView('chat')
                  }
                }}
                className={cn(
                  'shrink-0 p-0.5 rounded transition-colors cursor-pointer',
                  chatActiveForThis
                    ? 'text-primary hover:text-primary/80'
                    : 'text-muted-foreground/40 hover:text-muted-foreground',
                )}
              >
                <MessageSquare size={14} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Toggle voice channel chat</TooltipContent>
          </Tooltip>
          </TooltipProvider>
        )}
      </button>

      {/* Voice channel participants — listed below channel like Discord */}
      {isVoice && (voicePresence.length > 0 || showPendingSelf) && (
        <div className="ml-6 mr-2 mt-0.5 flex flex-col gap-0">
          {/* Show self immediately while connecting / waiting for presence */}
          {showPendingSelf && (
            <VoicePresenceUser
              key="self-connecting"
              pubkey={myPubkey}
              isSelf={true}
              isSpeaking={false}
              isMuted={myIsMuted}
              isDeafened={myIsDeafened}
              hasVideo={false}
              hasScreenShare={false}
              hasSpatial={myIsSpatial}
              hasVspace={myIsVspace}
              isConnecting={isConnecting}
            />
          )}
          {(() => {
            const renderRow = (p: typeof voicePresence[number]) => {
              const part = participants[p.pubkey]
              return (
                <VoicePresenceUser
                  key={p.pubkey}
                  pubkey={p.pubkey}
                  isSelf={p.pubkey === myVoiceId}
                  isSpeaking={p.pubkey === myVoiceId ? selfSpeaking : (part?.isSpeaking ?? activeSpeakers.includes(p.pubkey))}
                  isMuted={p.pubkey === myVoiceId ? myIsMuted : (part?.isMuted ?? false)}
                  isDeafened={p.pubkey === myVoiceId ? myIsDeafened : (part?.isDeafened ?? false)}
                  hasVideo={p.pubkey === myVoiceId ? myIsVideoEnabled : (part?.hasVideo ?? false)}
                  hasScreenShare={p.pubkey === myVoiceId ? myIsScreenSharing : (part?.hasScreenShare ?? false)}
                  hasSpatial={p.pubkey === myVoiceId ? myIsSpatial : (part?.hasSpatial ?? false)}
                  hasVspace={p.pubkey === myVoiceId ? myIsVspace : (part?.hasVspace ?? false)}
                />
              )
            }

            // Group presence by host. When everyone is on one host, render flat
            // (unchanged). When split across hosts, show a labeled group per host so
            // people don't think they're all talking together — with a Join button to
            // switch to another host (only while you're connected in this channel).
            const groups = new Map<string, typeof voicePresence>()
            for (const p of voicePresence) {
              const h = p.hostPubkey || ''
              if (!groups.has(h)) groups.set(h, [])
              groups.get(h)!.push(p)
            }
            if (groups.size <= 1) return voicePresence.map(renderRow)

            const entries = Array.from(groups.entries()).sort((a, b) =>
              a[0] === currentHostPubkey ? -1 : b[0] === currentHostPubkey ? 1 : 0,
            )
            return entries.map(([hostPk, members]) => (
              <div key={hostPk || 'unknown'} className="flex flex-col gap-0">
                <VoiceHostGroupHeader
                  hostPubkey={hostPk}
                  count={members.length}
                  isMine={hostPk === currentHostPubkey}
                  canJoin={isInVoice && hostPk !== currentHostPubkey && !!hostPk}
                  onJoin={() => switchHost(hostPk)}
                />
                {members.map(renderRow)}
              </div>
            ))
          })()}
        </div>
      )}
    </div>
  )
}

/* ─── VoiceHostGroupHeader — shown when a voice channel's people span >1 host ─── */

function VoiceHostGroupHeader({
  hostPubkey,
  count,
  isMine,
  canJoin,
  onJoin,
}: {
  hostPubkey: string
  count: number
  isMine: boolean
  canJoin: boolean
  onJoin: () => void
}) {
  const { getProfile } = useProfileCache()
  const displayHost = useVoiceDisplayPubkey(hostPubkey) // v2: pseudonym P → real key R
  const isHex = /^[0-9a-f]{64}$/i.test(displayHost)
  const profile = isHex ? getProfile(displayHost) : null
  const name = profile?.display_name || profile?.name || (displayHost ? npubShort(displayHost) : 'Unknown host')
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 mt-0.5">
      <span className={cn('w-1 h-1 rounded-full shrink-0', isMine ? 'bg-emerald-400' : 'bg-muted-foreground/40')} />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 truncate">
        {name}'s host · {count}
      </span>
      {canJoin && (
        <button
          onClick={onJoin}
          className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors cursor-pointer shrink-0"
        >
          Join
        </button>
      )}
    </div>
  )
}

/* ─── VoicePresenceUser — Discord-style user row under voice channel ─── */

/** Load per-user volume from localStorage */
function getUserVolume(pubkey: string): number {
  try {
    const raw = localStorage.getItem('den-chat-user-volumes')
    if (raw) {
      const map = JSON.parse(raw)
      if (typeof map[pubkey] === 'number') return map[pubkey]
    }
  } catch { /* ignore */ }
  return 100
}

/** Save per-user volume to localStorage */
function setUserVolume(pubkey: string, volume: number) {
  try {
    const raw = localStorage.getItem('den-chat-user-volumes')
    const map = raw ? JSON.parse(raw) : {}
    map[pubkey] = volume
    localStorage.setItem('den-chat-user-volumes', JSON.stringify(map))
  } catch { /* ignore */ }
}

function VoicePresenceUser({
  pubkey,
  isSelf,
  isSpeaking,
  isMuted,
  isDeafened,
  hasVideo,
  hasScreenShare,
  hasSpatial,
  hasVspace = false,
  isConnecting = false,
}: {
  pubkey: string
  isSelf: boolean
  isSpeaking: boolean
  isMuted: boolean
  isDeafened: boolean
  hasVideo: boolean
  hasScreenShare: boolean
  hasSpatial: boolean
  hasVspace?: boolean
  isConnecting?: boolean
}) {
  const { getProfile } = useProfileCache()
  // v2: `pubkey` is the wire pseudonym P (used for SFU volume ops below). Resolve it to the
  // real key R for the face/name and the profile modal; on v1 it's already R (no-op).
  const displayPubkey = useVoiceDisplayPubkey(pubkey)
  const isHex = /^[0-9a-f]{64}$/i.test(displayPubkey)
  const profile = isHex ? getProfile(displayPubkey) : null
  const name = profile?.display_name || profile?.name || npubShort(displayPubkey)
  const cachedPicture = useCachedImageUrl(profile?.picture)
  const [showModal, setShowModal] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)

  return (
    <>
      <div className={cn(
        'group flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors relative',
        isConnecting ? 'opacity-60' : '',
        isSpeaking ? 'bg-emerald-500/10' : 'hover:bg-accent/30',
      )}>
        {/* Avatar */}
        <div className="relative shrink-0">
          <div
            className={cn(
              'w-6 h-6 rounded-full overflow-hidden ring-2 transition-all duration-200',
              isConnecting ? 'ring-emerald-400/40' : isSpeaking ? 'ring-emerald-400' : 'ring-transparent',
            )}
            style={isConnecting ? { animation: 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite' } : undefined}
          >
            {cachedPicture ? (
              <img src={cachedPicture} alt={name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-primary/80 flex items-center justify-center text-primary-foreground text-[8px] font-bold">
                {name.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
          {isSpeaking && (
            <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 border border-background" />
          )}
        </div>

        {/* Name */}
        <span className={cn(
          'text-[12px] truncate flex-1 min-w-0',
          isSpeaking ? 'text-emerald-400 font-medium' : 'text-muted-foreground',
        )}>
          {name}
        </span>

        {/* Status icons + gear button */}
        <div className="flex items-center gap-1 shrink-0">
          {isConnecting ? (
            <Loader2 size={10} className="text-emerald-400/70 animate-spin" />
          ) : (
            <>
              {isMuted && <MicOff size={10} className="text-red-400/70" />}
              {isDeafened && <HeadphoneOff size={10} className="text-red-400/70" />}
              {hasVideo && <Camera size={10} className="text-blue-400/70" />}
              {hasScreenShare && <ScreenShare size={10} className="text-purple-400/70" />}
              {hasVspace ? <Boxes size={10} className="text-indigo-400/70" /> : hasSpatial && <Radar size={10} className="text-indigo-400/70" />}
            </>
          )}
          {/* Gear button — appears on hover (not for self) */}
          {!isSelf && (
            <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowModal(true) }}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-all cursor-pointer"
                >
                  <SlidersHorizontal size={11} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">User settings</TooltipContent>
            </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {/* User volume/settings modal */}
      {showModal && (
        <UserVolumeModal
          pubkey={pubkey}
          name={name}
          picture={profile?.picture}
          onClose={() => setShowModal(false)}
          onViewProfile={() => { setShowModal(false); setShowProfileModal(true) }}
        />
      )}

      {/* Profile modal (rendered at parent level so it persists after volume modal closes) */}
      {showProfileModal && (
        <UserProfileModal
          open={showProfileModal}
          onClose={() => setShowProfileModal(false)}
          targetPubkey={displayPubkey}
        />
      )}
    </>
  )
}

/* ─── UserVolumeModal — per-user volume + actions ─── */

function UserVolumeModal({
  pubkey,
  name,
  picture,
  onClose,
  onViewProfile,
}: {
  pubkey: string
  name: string
  picture?: string
  onClose: () => void
  onViewProfile: () => void
}) {
  const [volume, setVolume] = useState(() => getUserVolume(pubkey))
  const provider = useVoiceStore((s) => s.provider)
  const backdropRef = useRef<HTMLDivElement>(null)

  // Apply volume when slider changes
  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume)
    setUserVolume(pubkey, newVolume)
    const vol = newVolume / 100
    // Apply to provider
    if (provider) {
      provider.setParticipantVolume(pubkey, vol)
    }
    // Apply to spatial engine (so boost works in spatial mode)
    const engine = useVoiceStore.getState()._spatialEngine
    if (engine) {
      engine.setUserVolume(pubkey, vol)
    }
  }, [pubkey, provider])

  // Apply saved volume on mount
  useEffect(() => {
    const vol = volume / 100
    if (provider) {
      provider.setParticipantVolume(pubkey, vol)
    }
    const engine = useVoiceStore.getState()._spatialEngine
    if (engine) {
      engine.setUserVolume(pubkey, vol)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewProfile = useCallback(() => {
    onViewProfile()
  }, [onViewProfile])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div className="w-[280px] rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-secondary/30">
          <div className="w-8 h-8 rounded-full overflow-hidden shrink-0">
            {picture ? (
              <img src={picture} alt={name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
                {name.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
          <span className="text-sm font-semibold text-foreground truncate flex-1">{name}</span>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        {/* Volume slider */}
        <div className="px-4 py-3 overflow-hidden">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">User Volume</label>
          <div className="flex items-center gap-3 mt-2">
            <Volume2 size={14} className="text-muted-foreground shrink-0" />
            <input
              type="range"
              min={0}
              max={500}
              value={volume}
              onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
              className="flex-1 min-w-0 h-1.5 rounded-full appearance-none bg-secondary cursor-pointer accent-primary"
            />
            <span className={cn(
              'text-xs font-mono w-10 text-right shrink-0',
              volume === 0 ? 'text-red-400' : volume > 100 ? 'text-amber-400' : 'text-muted-foreground',
            )}>
              {volume}%
            </span>
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Actions */}
        <div className="px-2 py-2 flex flex-col gap-0.5">
          <button
            onClick={handleViewProfile}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer w-full text-left"
          >
            <User size={14} />
            View Profile
          </button>
        </div>
      </div>
    </div>
  )
}

