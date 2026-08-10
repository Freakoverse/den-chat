import { HubSidebar } from '@/components/hub/HubSidebar'
import { ChannelList } from '@/components/hub/ChannelList'
import { ChannelView } from '@/components/hub/ChannelView'
import { ForumView } from '@/components/hub/ForumView'
import { VoiceChannelView } from '@/components/hub/VoiceChannelView'
import { MemberList } from '@/components/hub/MemberList'
import { SocialFeedPage } from '@/components/social/SocialFeedPage'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { DMPage } from '@/components/dm/DMPage'
import { DiscoverPage } from '@/components/discover/DiscoverPage'
import { PublicChatPage } from '@/components/public/PublicChatPage'
import { WalletPage } from '@/components/wallet/WalletPage'
import { useHubStore } from '@/stores/hubStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { usePublicChatStore } from '@/stores/publicChatStore'
import { DenChatLogo } from '@/components/ui/DenChatLogo'
import { DoodleBackground } from '@/components/ui/DoodleBackground'
import { UserPanel } from '@/components/ui/UserPanel'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { useVoicePresence } from '@/hooks/useVoicePresence'
import { useUserStore } from '@/stores/userStore'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import { useMobile } from '@/hooks/useMobile'
import { useMemo, useEffect, useState } from 'react'
import { ShieldAlert, LogOut, Plus, MessageSquare, MessagesSquare, AtSign, Compass, Settings, Home, X, Wallet, Loader2, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { OfflineBanner } from '@/components/ui/OfflineBanner'
import { createHubListEvent, signWithSigner } from '@/lib/nostr/events'
import { publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { useMessageStore } from '@/stores/messageStore'

export function AppLayout() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  const activePage = useNavigationStore((s) => s.activePage)
  const setActivePage = useNavigationStore((s) => s.setActivePage)
  const mobileView = useNavigationStore((s) => s.mobileView)
  const setMobileView = useNavigationStore((s) => s.setMobileView)
  const showMobileMembers = useNavigationStore((s) => s.showMobileMembers)
  const setShowMobileMembers = useNavigationStore((s) => s.setShowMobileMembers)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const activeChannel = hub?.channels.find((c) => c.channelId === activeChannelId)
  const isForumChannel = activeChannel?.type === 'forum'
  const isVoiceChannel = activeChannel?.type === 'voice'
  const isMobile = useMobile()

  // Voice presence: always mounted so DC broadcast + keepalive
  // persist across page navigation (settings, DMs, etc.)
  useVoicePresence()

  // Document title with unread count (hub + DM + PC unreads)
  // Suppress until notification store is initialized to prevent flashing
  const notifInitialized = useNotificationStore((s) => s.initialized)
  const hubTotalUnread = useNotificationStore((s) => s.totalUnread)
  const nip17Convos = useDMStore((s) => s.conversations)
  const nip04Convos = useDM04Store((s) => s.conversations)
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const wotShouldHide = useWotStore((s) => s.shouldHide)
  const dmTotalUnread = useMemo(() => {
    if (!notifInitialized) return 0
    let total = 0
    for (const [pk, conv] of nip17Convos) {
      if (blockedPubkeys.has(pk) || wotShouldHide(pk, 'dms')) continue
      total += conv.unread
    }
    for (const [pk, conv] of nip04Convos) {
      if (blockedPubkeys.has(pk) || wotShouldHide(pk, 'dms')) continue
      total += conv.unread
    }
    return total
  }, [nip17Convos, nip04Convos, blockedPubkeys, wotShouldHide, notifInitialized])
  const pcMessages = usePublicChatStore((s) => s.messages)
  const pcTopics = usePublicChatStore((s) => s.topics)
  const pcReadTimes = useNotificationStore((s) => s.pcReadTimes)
  const pcTotalUnread = useMemo(() => {
    if (!notifInitialized) return 0
    let total = 0
    for (const topic of pcTopics) {
      const msgs = pcMessages[topic]
      const lastRead = pcReadTimes[topic] ?? 0
      if (msgs && lastRead > 0) total += msgs.filter(m => m.createdAt > lastRead).length
    }
    return total
  }, [pcTopics, pcMessages, pcReadTimes, notifInitialized])
  const totalUnread = notifInitialized ? (hubTotalUnread + dmTotalUnread + pcTotalUnread) : 0
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) DEN Chat` : 'DEN Chat'
  }, [totalUnread])

  // ── Mod-ban detection ──
  const myPubkey = useUserStore((s) => s.pubkey)
  const modBanLists = useHubStore((s) => activeHubId ? s.modBanLists[activeHubId] : undefined)
  const hubMembers = useHubStore((s) => activeHubId ? s.hubMembers[activeHubId] : undefined)
  const isModBanned = useMemo(() => {
    if (!myPubkey || !modBanLists || !hubMembers) return false
    // Whitelisted members (w flag) are immune to mod bans
    const myMember = hubMembers.find(m => m.pubkey === myPubkey)
    if (myMember?.flags?.includes('w')) return false
    for (const bannedPks of Object.values(modBanLists)) {
      if (bannedPks.includes(myPubkey)) return true
    }
    return false
  }, [myPubkey, modBanLists, hubMembers])

  // ── Hard-ban detection (creator ban list) ──
  const hubBanList = useHubStore((s) => activeHubId ? s.hubBanLists[activeHubId] : undefined)
  const isHardBanned = useMemo(() => {
    if (!myPubkey || !hubBanList) return false
    return hubBanList.includes(myPubkey)
  }, [myPubkey, hubBanList])

  // Combined ban check — either type blocks access
  const isBanned = isModBanned || isHardBanned

  // When navigating to a non-hub page on mobile, reset to home view
  useEffect(() => {
    if (isMobile && activePage !== 'hubs') {
      setMobileView('home')
      setShowMobileMembers(false)
    }
  }, [activePage, isMobile])

  // ─── MOBILE LAYOUT ─────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="flex flex-col h-full w-full overflow-hidden">
        <OfflineBanner />
        {/* Main content area */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {activePage === 'settings' ? (
            <SettingsPage />
          ) : activePage === 'social' ? (
            <SocialFeedPage />
          ) : activePage === 'discover' ? (
            <DiscoverPage />
          ) : activePage === 'dms' ? (
            <DMPage />
          ) : activePage === 'public-chat' ? (
            <PublicChatPage />
          ) : activePage === 'wallet' ? (
            <WalletPage />
          ) : activePage === 'hubs' && mobileView === 'chat' && activeHubId && activeChannelId ? (
            /* Full-screen chat view */
            <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
              {isBanned ? (isHardBanned ? <HardBanOverlay dTag={activeHubId} /> : <ModBanOverlay />) : (
                isVoiceChannel ? <VoiceChannelView /> : isForumChannel ? <ForumView /> : <ChannelView />
              )}
            </div>
          ) : (
            /* Home view: compact sidebar + channel list */
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <HubSidebar activePage={activePage} onNavigate={setActivePage} compact />
              {activeHubId ? (
                <ChannelList isModBanned={isBanned} isMobile />
              ) : (
                <EmptyState hasHub={false} />
              )}
            </div>
          )}
        </div>

        {/* Mobile members overlay */}
        {showMobileMembers && activeHubId && activeChannelId && !isBanned && (
          <div className="fixed inset-0 z-50 flex">
            <div className="flex-1 bg-black/40" onClick={() => setShowMobileMembers(false)} />
            <div className="w-[280px] max-w-[80vw] h-full p-2 bg-background animate-in slide-in-from-right duration-200">
              <MemberList />
            </div>
          </div>
        )}

        {/* Bottom tab bar — always visible on mobile (except during full-screen chat) */}
        {!(activePage === 'hubs' && mobileView === 'chat') && (
          <MobileTabBar
            activePage={activePage}
            onNavigate={setActivePage}
            dmUnread={dmTotalUnread}
            pcUnread={pcTotalUnread}
          />
        )}
      </div>
    )
  }

  // ─── DESKTOP LAYOUT ────────────────────────────────────────
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <OfflineBanner />
      <div className="flex flex-1 min-h-0 overflow-hidden">
      <HubSidebar activePage={activePage} onNavigate={setActivePage} />

      {activePage === 'settings' ? (
        <SettingsPage />
      ) : activePage === 'wallet' ? (
        <WalletPage />
      ) : activePage === 'social' ? (
        <SocialFeedPage />
      ) : activePage === 'discover' ? (
        <DiscoverPage />
      ) : activePage === 'public-chat' ? (
        <PublicChatPage />
      ) : activePage === 'dms' ? (
        <DMPage />
      ) : (
        <>
          {activeHubId && <ChannelList isModBanned={isBanned} />}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
            {activeHubId && activeChannelId ? (
              isBanned ? (isHardBanned ? <HardBanOverlay dTag={activeHubId} /> : <ModBanOverlay />) : (
                isVoiceChannel ? <VoiceChannelView /> : isForumChannel ? <ForumView /> : <ChannelView />
              )
            ) : (
              isBanned ? (isHardBanned ? <HardBanOverlay dTag={activeHubId} /> : <ModBanOverlay />) : <EmptyState hasHub={!!activeHubId} />
            )}
          </div>
          {activeHubId && activeChannelId && !isBanned && (
            <ResizablePanel id="members" defaultWidth={240} minWidth={180} maxWidth={380} side="right" className="flex p-2 bg-background">
              <MemberList />
            </ResizablePanel>
          )}
        </>
      )}
      </div>
    </div>
  )
}

// ─── Bottom Tab Bar (Mobile) ─────────────────────────────────

function MobileTabBar({ activePage, onNavigate, dmUnread, pcUnread }: {
  activePage: string
  onNavigate: (page: 'hubs' | 'dms' | 'social' | 'discover' | 'settings' | 'wallet' | 'public-chat') => void
  dmUnread: number
  pcUnread: number
}) {
  const setMobileView = useNavigationStore((s) => s.setMobileView)
  const [moreOpen, setMoreOpen] = useState(false)

  type TabId = 'hubs' | 'dms' | 'social' | 'discover' | 'settings' | 'wallet' | 'public-chat'
  type Tab = { id: TabId; label: string; icon: typeof Home; badge?: number }

  // Primary bar — always visible
  const primaryTabs: Tab[] = [
    { id: 'hubs', label: 'Hubs', icon: Home },
    { id: 'dms', label: 'DMs', icon: MessageSquare, badge: dmUnread },
    { id: 'social', label: 'Social', icon: AtSign },
    { id: 'public-chat', label: 'Public', icon: MessagesSquare, badge: pcUnread },
  ]
  // Overflow — revealed by the "More" button
  const moreTabs: Tab[] = [
    { id: 'discover', label: 'Discover', icon: Compass },
    { id: 'wallet', label: 'Wallet', icon: Wallet },
    { id: 'settings', label: 'Settings', icon: Settings },
  ]
  const moreActive = moreTabs.some((t) => t.id === activePage)

  // Close the overflow panel whenever the page changes
  useEffect(() => { setMoreOpen(false) }, [activePage])

  const go = (id: TabId) => {
    onNavigate(id)
    if (id === 'hubs') setMobileView('home')
    setMoreOpen(false)
  }

  const renderTab = (tab: Tab) => {
    const Icon = tab.icon
    const isActive = activePage === tab.id
    return (
      <button
        key={tab.id}
        onClick={() => go(tab.id)}
        className={cn(
          'flex flex-1 flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer relative',
          isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <Icon size={20} />
        <span className="text-[10px] font-medium">{tab.label}</span>
        {!!tab.badge && tab.badge > 0 && (
          <span className="absolute -top-0.5 right-1 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold px-1">
            {tab.badge > 99 ? '99+' : tab.badge}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="relative shrink-0">
      {/* Overflow ("More") panel — an identical bar that slides up above this one */}
      {moreOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
          <div className="absolute bottom-full left-0 right-0 z-50 flex items-center border-t border-border bg-background/95 backdrop-blur-sm px-1 py-1 shadow-lg animate-in slide-in-from-bottom-2 fade-in duration-150">
            {moreTabs.map(renderTab)}
          </div>
        </>
      )}

      {/* Primary bar */}
      <div className="relative z-50 flex items-center border-t border-border bg-background/95 backdrop-blur-sm px-1 py-1">
        {primaryTabs.map(renderTab)}
        <button
          onClick={() => setMoreOpen((v) => !v)}
          className={cn(
            'flex flex-1 flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer relative',
            moreOpen || moreActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <MoreHorizontal size={20} />
          <span className="text-[10px] font-medium">More</span>
        </button>
      </div>
    </div>
  )
}

function EmptyState({ hasHub }: { hasHub: boolean }) {
  const setShowHubChoice = useNavigationStore((s) => s.setShowHubChoiceModal)

  return (
    <div className="flex-1 flex items-center justify-center bg-background relative overflow-hidden">
      <DoodleBackground />
      <div className="text-center flex flex-col items-center gap-4 relative z-10">
        <DenChatLogo size={80} />
        <h2 className="text-xl font-semibold text-foreground">
          {hasHub ? 'Select a channel' : 'Welcome to DEN Chat'}
        </h2>
        <p className="text-sm max-w-xs text-muted-foreground">
          {hasHub
            ? 'Pick a channel from the list to start chatting.'
            : 'Join a hub or create your own to get started.'}
        </p>
        {!hasHub && (
          <button
            onClick={() => setShowHubChoice(true)}
            className="w-full h-12 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary flex items-center justify-center transition-all duration-200 cursor-pointer hover:scale-102 active:scale-100"
          >
            <Plus size={24} />
          </button>
        )}
      </div>
    </div>
  )
}

function ModBanOverlay() {
  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="max-w-sm text-center px-6 py-8 space-y-4">
        <div className="mx-auto w-14 h-14 rounded-full bg-amber-500/10 flex items-center justify-center">
          <ShieldAlert size={28} className="text-amber-400" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">You've been soft-banned</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          A moderator has flagged your account. Your messages are currently hidden from other members.
        </p>
        <div className="rounded-lg bg-secondary/40 border border-border/50 px-4 py-3 text-xs text-muted-foreground leading-relaxed space-y-1.5">
          <p>The hub creator may review this decision and either:</p>
          <ul className="text-left space-y-1 pl-3">
            <li className="flex items-start gap-1.5">
              <span className="text-destructive mt-0.5">•</span>
              <span>Promote this to a <strong className="text-foreground">full ban</strong> (permanent removal)</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-emerald-400 mt-0.5">•</span>
              <span><strong className="text-foreground">Override</strong> the moderator's decision and restore access</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

function HardBanOverlay({ dTag }: { dTag: string | null }) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const hubEntries = useHubStore((s) => s.hubEntries)
  const folders = useHubStore((s) => s.folders)
  const removeHubEntry = useHubStore((s) => s.removeHubEntry)
  const setActiveHub = useHubStore((s) => s.setActiveHub)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const handleLeave = async () => {
    if (!dTag) return
    setLeaving(true)
    // Persist the updated hub list (kind 16942) — best-effort.
    try {
      const remaining = hubEntries.filter((e) => e.dTag !== dTag)
      const ev = createHubListEvent(
        remaining.map((e) => ({ dTag: e.dTag, relayHint: e.relayHint, position: e.position, folderId: e.folderId })),
        folders,
      )
      const signed = await signWithSigner(ev, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signed)
    } catch (err) {
      console.error('Failed to publish updated hub list:', err)
    }
    // Remove locally + leave the banned view regardless of publish outcome.
    removeHubEntry(dTag)
    useMessageStore.getState().clearHubData(dTag)
    setActiveHub(null)
    setLeaving(false)
    setShowConfirm(false)
  }

  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="max-w-sm text-center px-6 py-8 space-y-4">
        <div className="mx-auto w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center">
          <ShieldAlert size={28} className="text-destructive" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">You've been banned</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The hub creator has banned your account from this hub. You can no longer access channels or send messages.
        </p>
        <div className="rounded-lg bg-secondary/40 border border-border/50 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
          <p>
            This is a <strong className="text-foreground">permanent ban</strong> enforced by the hub creator.
            If you believe this was a mistake, you may try to contact the hub creator outside of this hub.
          </p>
        </div>
        <button
          onClick={() => setShowConfirm(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary/60 border border-border/50 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
        >
          <LogOut size={14} />
          Leave Hub
        </button>
      </div>

      {/* Confirm: remove from hub list */}
      {showConfirm && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => { if (!leaving) setShowConfirm(false) }}
        >
          <div
            className="bg-card rounded-xl border border-border shadow-2xl w-[320px] p-5 space-y-4 animate-in fade-in-0 zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1.5">
              <h4 className="text-sm font-semibold text-foreground">Remove from hub list?</h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                This removes the hub from your list and clears its cached messages on this device. You can add it back later if you're unbanned.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={leaving}
                className="flex-1 h-9 text-sm rounded-lg font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleLeave}
                disabled={leaving}
                className="flex-1 h-9 text-sm rounded-lg font-medium bg-destructive text-white hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {leaving ? <><Loader2 size={14} className="animate-spin" /> Removing…</> : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

