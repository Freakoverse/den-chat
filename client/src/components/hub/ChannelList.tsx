import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { getPermissionsForUser } from '@/lib/hub/permissions'
import { Hash, Megaphone, MessagesSquare, MessageSquare, ChevronDown, ChevronRight, Settings, UserPlus, Inbox, Loader2, SlidersHorizontal, Volume2, MicOff, HeadphoneOff, Camera, ScreenShare, X, User, Radar, AlertTriangle, CalendarDays, Lock, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { PRESENCE_CONSTANTS } from '@/lib/voice/types'
import { useVoiceStore } from '@/stores/voiceStore'
import { useProfileCache } from '@/hooks/useProfileCache'
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
import { useCalendar } from '@/hooks/useCalendar'

export function ChannelList({ isModBanned = false, isMobile = false }: { isModBanned?: boolean; isMobile?: boolean } = {}) {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  const setActiveChannel = useHubStore((s) => s.setActiveChannel)
  const setMobileView = useNavigationStore((s) => s.setMobileView)
  const pubkey = useUserStore((s) => s.pubkey)
  const groupSecrets = useHubStore((s) => activeHubId ? s.groupSecrets[activeHubId] : undefined)
  const hubMembers = useHubStore((s) => activeHubId ? s.hubMembers[activeHubId] : undefined)
  const [showSettings, setShowSettings] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showJoinRequests, setShowJoinRequests] = useState(false)
  const [showUserSettings, setShowUserSettings] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [showCreatorProfile, setShowCreatorProfile] = useState(false)
  const [rescinding, setRescinding] = useState(false)
  const [rescindDone, setRescindDone] = useState(false)
  const [userSettingsInitialTab, setUserSettingsInitialTab] = useState<'messages' | 'notifications' | undefined>(undefined)

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

  const markChannelRead = useNotificationStore((s) => s.markChannelRead)

  const isCreator = !!(hub && pubkey && hub.creatorPubkey === pubkey)
  const isMember = !!(pubkey && hubMembers?.some((m) => m.pubkey === pubkey))
  const secretsResolved = useHubStore((s) => activeHubId ? !!s.hubSecretsResolved[activeHubId] : false)
  // Show rescind button when: not creator, not a direct member, and secrets are resolved
  const showRescind = !isCreator && !isMember && secretsResolved && !rescindDone

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
  const hostsByHub = useVoiceStore((s) => s.hostsByHub)

  // Check if any of user's voice hosts have an epoch mismatch
  const hasVoiceEpochMismatch = useMemo(() => {
    if (!hub || !pubkey) return false
    const hosts = hostsByHub[hub.dTag] || []
    const myHosts = hosts.filter((h) => h.pubkey === pubkey)
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
  }, [hub, pubkey, hostsByHub])

  // Join request count (creator only)
  const joinRequestCount = useJoinRequestCount(hub, hubMembers, isCreator)

  // Live calendar events
  const { liveEventCount } = useCalendar(activeHubId)

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

  const uncategorized = hub.channels
    .filter((c) => !c.categoryId)
    .filter((c) => canViewChannel(c.channelId))
    .sort((a, b) => a.position - b.position)

  const categorized = hub.categories
    .sort((a, b) => a.position - b.position)
    .map((cat) => ({
      ...cat,
      channels: hub.channels
        .filter((c) => c.categoryId === cat.categoryId)
        .sort((a, b) => a.position - b.position),
    }))
    .filter((cat) => {
      // Hide categories where ALL channels are hidden by view_channel
      if (isCreator) return true
      return cat.channels.some((c) => canViewChannel(c.channelId))
    })

  const hasVoiceChannels = hub.channels.some((c) => c.type === 'voice')

  // On mobile, selecting a channel also transitions to chat view
  const handleSelectChannel = (channelId: string) => {
    setActiveChannel(channelId)
    if (isMobile) setMobileView('chat')
  }

  const Wrapper = isMobile ? MobileWrapper : DesktopWrapper

  return (
    <Wrapper>
      {/* Banner area */}
      <div className="relative overflow-hidden group" style={{ minHeight: hub.banner ? '110px' : '48px' }}>
        {hub.banner ? (
          <>
            <BlossomImage
              src={hub.banner}
              alt={`${hub.name} banner`}
              className="w-full h-28 object-cover"
            />
            {/* Overlay — full-height gradient, visible on hover */}
            <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 ease-in-out" />
            {/* Hub name — positioned over the gradient */}
            <div className="absolute bottom-0 left-0 right-0 flex items-center px-3 py-2 gap-2">
              {hasVoiceChannels && <VoicePresenceRing />}
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
          <div className="flex items-center gap-2 px-4 h-12 min-h-12 border-b border-border bg-secondary/30">
            {hasVoiceChannels && <VoicePresenceRing />}
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
          className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 border-b border-blue-500/20 cursor-pointer hover:bg-blue-500/15 transition-colors w-full"
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

      {/* Action items */}
      {!isModBanned && (
        <div className="flex flex-col gap-1 px-2 py-1.5 border-b border-border bg-secondary/30">
          {(() => {
            const canInvite = isCreator || (pubkey && hub ? getPermissionsForUser(hub, pubkey, hubMembers).create_invite : false)
            return canInvite ? (
              <button
                onClick={() => setShowInvite(true)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <UserPlus size={16} />
                <span>Invite</span>
              </button>
            ) : null
          })()}
          <button
            onClick={() => setShowEvents(true)}
            className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
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
                className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <Settings size={16} />
                <span>Hub Settings</span>
              </button>
              <button
                onClick={() => { markJoinRequestsSeen(hub!.dTag); setShowJoinRequests(true) }}
                className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <Inbox size={16} />
                <span>Join Requests</span>
                {joinRequestCount > 0 && (
                  <span className="ml-auto min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1 bg-blue-500 text-white">
                    {joinRequestCount > 99 ? '99+' : joinRequestCount}
                  </span>
                )}
              </button>
            </>
          )}
          <button
            onClick={() => setShowUserSettings(true)}
            className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <SlidersHorizontal size={13} />
            <span>User Hub Settings</span>
            {hasVoiceEpochMismatch && (
              <AlertTriangle size={14} className="text-amber-400 ml-auto" />
            )}
          </button>
          {/* Rescind join request — visible when not a direct member and secrets resolved */}
          {showRescind && (
            <button
              onClick={async () => {
                if (!hub || !pubkey || rescinding) return
                setRescinding(true)
                try {
                  const { fetchEvents } = await import('@/lib/nostr/relay-pool')
                  const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
                  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
                  const { createDeletedJoinRequest, createDeletionEvent } = await import('@/lib/nostr/events')
                  const { signWithSigner: signFn } = await import('@/lib/nostr')
                  const { KINDS, STANDARD_KINDS } = await import('@/lib/crypto/constants')
                  const { signer, privateKey } = useUserStore.getState()
                  const relays = [...hub.generalRelays, ...hub.filterRelays]
                  const publishRelays = getPublishRelays(relays)

                  // Fetch the existing join request to get its created_at
                  const existing = await fetchEvents({
                    kinds: [KINDS.JOIN_REQUEST],
                    authors: [pubkey],
                    '#d': [hub.dTag],
                    limit: 1,
                  })
                  const originalCreatedAt = existing.length > 0 ? existing[0].created_at : Math.floor(Date.now() / 1000)

                  // Step 1: Re-publish with deleted tag (created_at + 1)
                  const deleted = createDeletedJoinRequest(hub.dTag, hub.creatorPubkey, originalCreatedAt)
                  const signedDeleted = await signFn(deleted, signer, privateKey)
                  await publishToSpecificRelays(publishRelays, signedDeleted)

                  // Step 2: NIP-09 deletion request
                  const aRef = `${KINDS.JOIN_REQUEST}:${pubkey}:${hub.dTag}`
                  const deletionReq = createDeletionEvent([], [aRef], 'rescind join request')
                  const signedDeletion = await signFn(deletionReq, signer, privateKey)
                  await publishToSpecificRelays(publishRelays, signedDeletion)

                  // Step 3: Remove from user's hub list and publish
                  const { createHubListEvent } = await import('@/lib/nostr/events')
                  const hubStore = useHubStore.getState()
                  const remainingEntries = hubStore.hubEntries.filter(e => e.dTag !== hub.dTag)
                  const currentFolders = hubStore.folders
                  hubStore.removeHubEntry(hub.dTag)
                  const hubListEv = createHubListEvent(
                    remainingEntries.map(e => ({ dTag: e.dTag, relayHint: e.relayHint, position: e.position, folderId: e.folderId })),
                    currentFolders,
                  )
                  const signedHubList = await signFn(hubListEv, signer, privateKey)
                  await publishToSpecificRelays(getPublishRelays(), signedHubList)

                  setRescindDone(true)
                } catch (err) {
                  console.error('[ChannelList] Failed to rescind join request:', err)
                } finally {
                  setRescinding(false)
                }
              }}
              disabled={rescinding}
              className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-50"
            >
              {rescinding ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />}
              <span>{rescinding ? 'Rescinding...' : 'Rescind Join Request'}</span>
            </button>
          )}
        </div>
      )}

      {/* Channel list — de-rendered when mod-banned */}
      {isModBanned ? (
        <div className="flex-1 flex items-center justify-center py-8">
          <p className="text-xs text-muted-foreground/50 italic">Channels unavailable</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-2 scrollbar-hide">
          {uncategorized.map((channel) => {
            const gid = getChannelGroupId(channel)
            const locked = !hasGroupAccess(gid)
            return (
              <ChannelItem
                key={channel.channelId}
                channel={channel}
                position={channel.position}
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
              name={cat.name}
              channels={cat.channels}
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
      )}

      {!isMobile && <UserPanel />}

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

      {/* User Hub Settings modal */}
      <UserHubSettingsModal
        open={showUserSettings}
        onClose={() => { setShowUserSettings(false); setUserSettingsInitialTab(undefined) }}
        hub={hub}
        initialTab={userSettingsInitialTab}
      />

      {/* Calendar Events modal */}
      {activeHubId && showEvents && (
        <CalendarPanel
          hubDTag={activeHubId}
          open={showEvents}
          onClose={() => setShowEvents(false)}
        />
      )}
    </Wrapper>
  )
}

// Wrappers for mobile vs desktop rendering
function MobileWrapper({ children }: { children: ReactNode }) {
  return <div className="flex flex-col flex-1 overflow-hidden bg-secondary/50">{children}</div>
}
function DesktopWrapper({ children }: { children: ReactNode }) {
  return (
    <ResizablePanel id="hub" defaultWidth={280} minWidth={200} maxWidth={420} className="flex flex-col overflow-hidden bg-secondary/50">
      {children}
    </ResizablePanel>
  )
}

interface CategoryGroupProps {
  name: string
  channels: Array<{ channelId: string; name: string; type: string; position: number; encryption: string | null; synced: boolean; categoryId: string | null }>
  activeChannelId: string | null
  onSelectChannel: (id: string) => void
  categoryEncryption: string | null
  groupSecrets?: Record<string, string>
  isCreator: boolean
  hub: import('@/stores/hubStore').HubData | null
  hubMembers?: Array<{ pubkey: string; roles: string }>
  pubkey: string | null
}

function CategoryGroup({ name, channels, activeChannelId, onSelectChannel, categoryEncryption, groupSecrets, isCreator, hub, hubMembers, pubkey }: CategoryGroupProps) {
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

  return (
    <div className="mt-3">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1 px-2 py-1 w-full text-left cursor-pointer group"
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
                isActive={activeChannelId === channel.channelId}
                onClick={() => !locked && onSelectChannel(channel.channelId)}
                isLocked={locked}
                isPrivate={!!gid}
              />
            )
          })}
    </div>
  )
}

interface ChannelItemProps {
  channel: { channelId: string; name: string; type: string }
  position: number
  isActive: boolean
  onClick: () => void
  isLocked?: boolean
  isPrivate?: boolean
}

function ChannelItem({ channel, position, isActive, onClick, isLocked = false, isPrivate = false }: ChannelItemProps) {
  // Voice channel presence count
  const presenceByHub = useVoiceStore((s) => s.presenceByHub)
  const getChannelPresence = useVoiceStore((s) => s.getChannelPresence)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const connectionState = useVoiceStore((s) => s.connectionState)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const selfSpeaking = useVoiceStore((s) => s._isSpeaking)
  const myIsMuted = useVoiceStore((s) => s.isMuted)
  const myIsDeafened = useVoiceStore((s) => s.isDeafened)
  const myIsVideoEnabled = useVoiceStore((s) => s.isVideoEnabled)
  const myIsScreenSharing = useVoiceStore((s) => s.isScreenSharing)
  const myIsSpatial = useVoiceStore((s) => s.spatialEnabled)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const myPubkey = useUserStore((s) => s.pubkey)
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
  const selfAlreadyInPresence = voicePresence.some((p) => p.pubkey === myPubkey)
  const showPendingSelf = (isConnecting || (isInVoice && !selfAlreadyInPresence)) && !!myPubkey

  return (
    <div className="mb-1 relative">
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
            : 'cursor-pointer',
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
        <span className="text-md text-muted-foreground/60 font-bold">{position}</span>
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
              isConnecting={isConnecting}
            />
          )}
          {voicePresence.map((p) => {
            const part = participants[p.pubkey]
            return (
              <VoicePresenceUser
                key={p.pubkey}
                pubkey={p.pubkey}
                isSelf={p.pubkey === myPubkey}
                isSpeaking={p.pubkey === myPubkey ? selfSpeaking : (part?.isSpeaking ?? activeSpeakers.includes(p.pubkey))}
                isMuted={p.pubkey === myPubkey ? myIsMuted : (part?.isMuted ?? false)}
                isDeafened={p.pubkey === myPubkey ? myIsDeafened : (part?.isDeafened ?? false)}
                hasVideo={p.pubkey === myPubkey ? myIsVideoEnabled : (part?.hasVideo ?? false)}
                hasScreenShare={p.pubkey === myPubkey ? myIsScreenSharing : (part?.hasScreenShare ?? false)}
                hasSpatial={p.pubkey === myPubkey ? myIsSpatial : (part?.hasSpatial ?? false)}
              />
            )
          })}
        </div>
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
  isConnecting?: boolean
}) {
  const { getProfile } = useProfileCache()
  const isHex = /^[0-9a-f]{64}$/i.test(pubkey)
  const profile = isHex ? getProfile(pubkey) : null
  const name = profile?.display_name || profile?.name || (isHex ? pubkey.slice(0, 8) + '…' : 'Unknown')
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
              {hasSpatial && <Radar size={10} className="text-indigo-400/70" />}
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
          targetPubkey={pubkey}
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

/* ─── VoicePresenceRing — 60s countdown ring for voice presence ─── */

const CYCLE_MS = PRESENCE_CONSTANTS.STALE_TIMEOUT_MS // 60_000

function VoicePresenceRing() {
  const [progress, setProgress] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    const tick = () => {
      const elapsed = (Date.now() - startRef.current) % CYCLE_MS
      setProgress(elapsed / CYCLE_MS)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Reset start reference when cycle completes
  useEffect(() => {
    if (progress >= 0.99) {
      startRef.current = Date.now()
    }
  }, [progress])

  const remaining = Math.ceil((1 - progress) * (CYCLE_MS / 1000))

  // SVG circle math
  const size = 14
  const strokeWidth = 1.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - progress)

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="shrink-0 cursor-default" aria-label="Voice presence check countdown">
            <svg width={size} height={size} className="block">
              {/* Background ring */}
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                className="text-muted-foreground/20"
              />
              {/* Progress arc */}
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
                className="text-emerald-500/70 transition-[stroke-dashoffset] duration-1000 ease-linear"
                style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
              />
            </svg>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[220px] text-center">
          <p className="text-xs font-medium">Active check</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Users in voice are verified every 60s — if they disconnect, they'll be removed automatically
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
