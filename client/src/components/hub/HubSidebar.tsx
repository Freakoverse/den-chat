import { useHubStore, type HubStatus, type HubEntry, type HubFolder } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import { usePublicChatStore } from '@/stores/publicChatStore'
import { Plus, Pencil, MessageSquare, MessagesSquare, Settings, AtSign, Compass, HelpCircle, XCircle, FolderClosed, Search, Sparkles, X, Volume2, RefreshCw, Loader2, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CreateHubDialog } from '@/components/hub/CreateHubDialog'
import { fetchReplaceable } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { useState, useEffect, useCallback, useMemo } from 'react'

// Persist collapsed folder IDs to localStorage
const COLLAPSED_KEY = 'den-chat-collapsed-folders'
function loadCollapsed(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY)
    if (stored) return new Set(JSON.parse(stored))
  } catch { /* ignore */ }
  return new Set()
}
function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
  } catch { /* ignore */ }
}

export function HubSidebar({ activePage, onNavigate, compact = false }: { activePage: 'hubs' | 'dms' | 'social' | 'discover' | 'settings' | 'wallet' | 'public-chat'; onNavigate?: (page: 'hubs' | 'dms' | 'social' | 'discover' | 'settings' | 'wallet' | 'public-chat') => void; compact?: boolean }) {
  const hubEntries = useHubStore((s) => s.hubEntries)
  const folders = useHubStore((s) => s.folders)
  const hubs = useHubStore((s) => s.hubs)
  const hubStatus = useHubStore((s) => s.hubStatus)
  const hubSecretsResolved = useHubStore((s) => s.hubSecretsResolved)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const setActiveHub = useHubStore((s) => s.setActiveHub)
  const hubListLoaded = useHubStore((s) => s.hubListLoaded)
  const hideDeletedHubs = useHubStore((s) => s.hideDeletedHubs)
  const hideNotFoundHubs = useHubStore((s) => s.hideNotFoundHubs)
  const previewHubId = useHubStore((s) => s.previewHubId)

  // Voice call — which hub is the user connected to?
  const voiceHubDTag = useVoiceStore((s) => s.connectionState === 'connected' ? s.currentHubDTag : null)

  // Suppress all unread badges until notification store is initialized
  // to prevent the "badges flash up then snap down" race condition
  const notifInitialized = useNotificationStore((s) => s.initialized)
  const hasSocialNotification = useNotificationStore((s) => s.hasSocialNotification)

  // DM unread totals (from both NIP-17 and NIP-04 stores)
  // Exclude blocked and WoT-hidden users to avoid phantom badges
  const nip17Conversations = useDMStore((s) => s.conversations)
  const nip04Conversations = useDM04Store((s) => s.conversations)
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const wotShouldHide = useWotStore((s) => s.shouldHide)
  const dmTotalUnread = useMemo(() => {
    if (!notifInitialized) return 0
    let total = 0
    for (const [pk, conv] of nip17Conversations) {
      if (blockedPubkeys.has(pk) || wotShouldHide(pk, 'dms')) continue
      total += conv.unread
    }
    for (const [pk, conv] of nip04Conversations) {
      if (blockedPubkeys.has(pk) || wotShouldHide(pk, 'dms')) continue
      total += conv.unread
    }
    return total
  }, [nip17Conversations, nip04Conversations, blockedPubkeys, wotShouldHide, notifInitialized])

  // Public Chat unread totals
  const pcMessages = usePublicChatStore((s) => s.messages)
  const pcTopics = usePublicChatStore((s) => s.topics)
  const pcReadTimes = useNotificationStore((s) => s.pcReadTimes)
  const pcTotalUnread = useMemo(() => {
    if (!notifInitialized) return 0
    let total = 0
    for (const topic of pcTopics) {
      const msgs = pcMessages[topic]
      const lastRead = pcReadTimes[topic] ?? 0
      if (msgs && lastRead > 0) {
        total += msgs.filter(m => m.createdAt > lastRead).length
      }
    }
    return total
  }, [pcTopics, pcMessages, pcReadTimes, notifInitialized])

  const [showCreateHub, setShowCreateHub] = useState(false)
  const showHubChoice = useNavigationStore((s) => s.showHubChoiceModal)
  const setShowHubChoice = useNavigationStore((s) => s.setShowHubChoiceModal)
  const setSettingsTab = useNavigationStore((s) => s.setSettingsTab)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Retry fetching the hub list (kind 16942) from relays
  const refreshHubList = useCallback(async () => {
    const pubkey = useUserStore.getState().pubkey
    if (!pubkey || isRefreshing) return
    setIsRefreshing(true)
    try {
      const setHubEntries = useHubStore.getState().setHubEntries
      const event = await fetchReplaceable(pubkey, KINDS.USER_HUB_LIST)
      if (!event) {
        // No event found — keep list empty but mark as loaded
        setHubEntries([], [])
      } else {
        const newFolders: HubFolder[] = []
        const newEntries: HubEntry[] = []
        for (const tag of event.tags) {
          if (tag[0] === 'folder' && tag[1] && tag[2]) {
            const color = tag[3] || undefined
            const position = tag[4] ? parseInt(tag[4], 10) : newFolders.length
            newFolders.push({ id: tag[1], name: tag[2], color, position })
          }
          if (tag[0] === 'v' && tag[1]) {
            const relayHint = tag[2] || ''
            const posField = tag[3] || '0'
            const colonIdx = posField.indexOf(':')
            let position: number
            let folderId: string | undefined
            if (colonIdx !== -1) {
              position = parseInt(posField.substring(0, colonIdx), 10)
              folderId = posField.substring(colonIdx + 1)
            } else {
              position = parseInt(posField, 10)
              folderId = undefined
            }
            newEntries.push({ dTag: tag[1], relayHint, position, folderId })
          }
        }
        setHubEntries(newEntries, newFolders)
      }
    } catch (err) {
      console.warn('[HubSidebar] Failed to refresh hub list:', err)
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing])
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => loadCollapsed())

  // Persist collapsed state
  useEffect(() => { saveCollapsed(collapsedFolders) }, [collapsedFolders])

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  // Filter out hidden hubs
  const visibleEntries = hubEntries.filter((e) => {
    const status = hubStatus[e.dTag]
    if (hideDeletedHubs && status === 'deleted') return false
    if (hideNotFoundHubs && status === 'not-found') return false
    if ((hideDeletedHubs || hideNotFoundHubs) && !status) return false
    return true
  })

  const topLevel = visibleEntries.filter((e) => !e.folderId).sort((a, b) => a.position - b.position)
  const sortedFolders = [...folders].sort((a, b) => a.position - b.position)
  const folderGroups = sortedFolders.map((folder) => ({
    ...folder,
    hubs: visibleEntries.filter((e) => e.folderId === folder.id).sort((a, b) => a.position - b.position),
  }))

  const isLoading = !hubListLoaded

  // Count hubs still waiting for status (pending check)
  const pendingCount = (hideDeletedHubs || hideNotFoundHubs)
    ? hubEntries.filter((e) => !hubStatus[e.dTag]).length
    : 0

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn('flex flex-col items-center bg-background h-full', compact ? 'w-[60px] min-w-[60px]' : 'w-[72px] min-w-[72px]')}>
        {/* Fixed top — DM button (hidden in compact/mobile mode) */}
        {!compact && (
          <div className="w-full flex flex-col items-center py-3 gap-2 shrink-0">
            <HubIcon label="Direct Messages" isActive={activePage === 'dms'} onClick={() => { setActiveHub(null); onNavigate?.('dms') }} dmUnreadCount={dmTotalUnread}>
              <MessageSquare size={20} />
            </HubIcon>
            <HubIcon label="Social Feed" isActive={activePage === 'social'} onClick={() => onNavigate?.('social')} hasNotificationDot={hasSocialNotification}>
              <AtSign size={20} />
            </HubIcon>
            <HubIcon label="Discover" isActive={activePage === 'discover'} onClick={() => onNavigate?.('discover')}>
              <Compass size={20} />
            </HubIcon>
            <HubIcon label="Public Chat" isActive={activePage === 'public-chat'} onClick={() => onNavigate?.('public-chat')} dmUnreadCount={pcTotalUnread}>
              <MessagesSquare size={20} />
            </HubIcon>
            <div className="w-8 h-px bg-border my-1" />
          </div>
        )}

        {/* Scrollable hub list */}
        <div className="flex-1 flex flex-col items-center gap-2 overflow-y-auto scrollbar-hide w-full min-h-0 py-1">
          {isLoading ? (
            /* Pulsating skeleton placeholders while fetching hub list */
            <>
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-12 h-12 rounded-[24px] bg-secondary animate-pulse" style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </>
          ) : (
            <>
              {topLevel.map((entry) => {
                const hub = hubs[entry.dTag]
                const status = hubStatus[entry.dTag]
                return (
                  <HubIcon
                    key={entry.dTag}
                    label={hub?.name ?? entry.dTag.slice(0, 6)}
                    isActive={activePage === 'hubs' && activeHubId === entry.dTag}
                    onClick={() => { setActiveHub(entry.dTag); onNavigate?.('hubs') }}
                    status={status}
                    isInVoice={voiceHubDTag === entry.dTag}
                    hubDTag={entry.dTag}
                    loadingSecrets={status === 'loaded' && !hubSecretsResolved[entry.dTag]}
                  >
                    {hub?.icon ? (
                      <BlossomImage src={hub.icon} alt={hub.name} className="absolute inset-0 w-full h-full object-cover" fallback={
                        <span className="text-sm font-semibold">{(hub?.name ?? entry.dTag).slice(0, 2).toUpperCase()}</span>
                      } />
                    ) : (
                      <span className="text-sm font-semibold">
                        {(hub?.name ?? entry.dTag).slice(0, 2).toUpperCase()}
                      </span>
                    )}
                  </HubIcon>
                )
              })}

              {folderGroups.map((folder) => {
                const isCollapsed = collapsedFolders.has(folder.id)
                const activeIndex = folder.hubs.findIndex(e => activePage === 'hubs' && activeHubId === e.dTag)
                const hasActiveHub = activeIndex !== -1
                // Vertical center of the active hub inside the expanded pill:
                //   p-1.5 top (6) + folder icon (h-11 = 44) + gap-1.5 (6) + i*(h-10 icon 40 + gap 6) + half icon (20)
                const barTop = isCollapsed || !hasActiveHub ? '50%' : 76 + activeIndex * 46

                return (
                  <div key={folder.id} className="relative flex flex-col items-center w-full">
                    {/* Active hub indicator bar (outside container so it hugs sidebar edge;
                        positioned at the active hub's vertical center, not the folder's). */}
                    <div
                      className={cn(
                        'absolute left-0 -translate-y-1/2 w-1 rounded-r-full bg-foreground transition-all duration-200',
                        hasActiveHub ? (isCollapsed ? 'h-5' : 'h-10') : 'h-0'
                      )}
                      style={{ top: barTop }}
                    />

                    {/* Folder pill container — snug fit around icons */}
                    <div
                      className={cn(
                        'flex flex-col items-center rounded-2xl transition-colors duration-200',
                        !isCollapsed && folder.hubs.length > 0 ? 'p-1.5 gap-1.5' : '',
                      )}
                      style={!isCollapsed && folder.hubs.length > 0 ? { backgroundColor: `${folder.color || '#5865F2'}10` } : undefined}
                    >
                      {/* Folder icon — click to expand/collapse */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => toggleFolder(folder.id)}
                            data-folder-id={folder.id}
                            className={cn(
                              'relative w-11 h-11 flex items-center justify-center rounded-[24px] hover:rounded-2xl transition-all duration-200 cursor-pointer overflow-hidden',
                              isCollapsed
                                ? hasActiveHub ? 'bg-primary/20 ring-1 ring-primary/40' : 'bg-secondary hover:bg-secondary/80'
                                : 'bg-secondary/60 rounded-2xl ring-1',
                            )}
                            style={!isCollapsed ? { borderColor: `${folder.color || '#5865F2'}40`, ['--tw-ring-color' as string]: `${folder.color || '#5865F2'}50` } : undefined}
                          >
                            <FolderClosed
                              size={isCollapsed ? 18 : 16}
                              style={{ color: folder.color || '#5865F2' }}
                              className="transition-all"
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {folder.name} ({folder.hubs.length} hub{folder.hubs.length !== 1 ? 's' : ''})
                        </TooltipContent>
                      </Tooltip>

                      {/* Folder hubs — shown when expanded */}
                      {!isCollapsed && folder.hubs.map((entry) => {
                        const hub = hubs[entry.dTag]
                        const status = hubStatus[entry.dTag]
                        return (
                          <HubIcon
                            key={entry.dTag}
                            label={hub?.name ?? entry.dTag.slice(0, 6)}
                            isActive={activePage === 'hubs' && activeHubId === entry.dTag}
                            onClick={() => { setActiveHub(entry.dTag); onNavigate?.('hubs') }}
                            status={status}
                            compact
                            folderColor={folder.color}
                            isInVoice={voiceHubDTag === entry.dTag}
                            hubDTag={entry.dTag}
                            loadingSecrets={status === 'loaded' && !hubSecretsResolved[entry.dTag]}
                          >
                            {hub?.icon ? (
                              <BlossomImage src={hub.icon} alt={hub.name} className="absolute inset-0 w-full h-full object-cover" fallback={
                                <span className="text-xs font-semibold">{(hub?.name ?? entry.dTag).slice(0, 2).toUpperCase()}</span>
                              } />
                            ) : (
                              <span className="text-xs font-semibold">
                                {(hub?.name ?? entry.dTag).slice(0, 2).toUpperCase()}
                              </span>
                            )}
                          </HubIcon>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              {/* Skeleton placeholders for hubs still being status-checked */}
              {pendingCount > 0 && Array.from({ length: pendingCount }).map((_, i) => (
                <div key={`pending-${i}`} className="w-12 h-12 rounded-[24px] bg-secondary animate-pulse" style={{ animationDelay: `${i * 150}ms` }} />
              ))}

              {/* Preview hub (ephemeral, dashed border) */}
              {previewHubId && !hubEntries.some(e => e.dTag === previewHubId) && hubs[previewHubId] && (
                <HubIcon
                  label={`${hubs[previewHubId].name} (Preview)`}
                  isActive={activePage === 'hubs' && activeHubId === previewHubId}
                  onClick={() => { setActiveHub(previewHubId); onNavigate?.('hubs') }}
                  isPreview
                >
                  {hubs[previewHubId]?.icon ? (
                    <BlossomImage src={hubs[previewHubId].icon!} alt={hubs[previewHubId].name} className="absolute inset-0 w-full h-full object-cover" fallback={
                      <span className="text-sm font-semibold">{hubs[previewHubId].name.slice(0, 2).toUpperCase()}</span>
                    } />
                  ) : (
                    <span className="text-sm font-semibold">
                      {hubs[previewHubId].name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                </HubIcon>
              )}

              {/* Refresh button — shown when hub list is loaded but truly empty */}
              {hubEntries.length === 0 && !previewHubId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={refreshHubList}
                      disabled={isRefreshing}
                      className={cn(
                        'relative w-12 h-12 flex items-center justify-center rounded-[24px] hover:rounded-2xl transition-all duration-200 cursor-pointer',
                        'bg-secondary text-amber-400 hover:bg-amber-500/20 hover:text-amber-300',
                        isRefreshing && 'opacity-60 cursor-wait',
                      )}
                    >
                      {isRefreshing ? (
                        <Loader2 size={20} className="animate-spin" />
                      ) : (
                        <RefreshCw size={20} />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {isRefreshing ? 'Refreshing...' : 'Retry loading hubs'}
                  </TooltipContent>
                </Tooltip>
              )}

              <div className="w-8 h-px bg-border my-1 shrink-0" />

              {/* Add hub */}
              <HubIcon label="Join or Create Hub" isActive={false} onClick={() => setShowHubChoice(true)} isAction>
                <Plus size={20} />
              </HubIcon>

              {/* Manage hub list */}
              <HubIcon label="Manage My Hubs" isActive={false} onClick={() => { setSettingsTab('my-hubs'); onNavigate?.('settings') }}>
                <Pencil size={18} />
              </HubIcon>
            </>
          )}
        </div>

        {/* Fixed bottom — Settings (hidden in compact/mobile mode) */}
        {!compact && (
          <div className="w-full flex flex-col items-center py-3 gap-2 shrink-0">
            <div className="w-8 h-px bg-border my-1" />
            <HubIcon label="Wallet" isActive={activePage === 'wallet'} onClick={() => onNavigate?.('wallet')}>
              <Wallet size={18} />
            </HubIcon>
            <HubIcon label="Settings" isActive={activePage === 'settings'} onClick={() => onNavigate?.('settings')}>
              <Settings size={18} />
            </HubIcon>
          </div>
        )}
      </div>

      <CreateHubDialog open={showCreateHub} onClose={() => setShowCreateHub(false)} />

      {/* Join or Create choice modal */}
      {showHubChoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={() => setShowHubChoice(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-foreground">What would you like to do?</h2>
              <button onClick={() => setShowHubChoice(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                <X size={16} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Join a Hub */}
              <button
                onClick={() => { setShowHubChoice(false); onNavigate?.('discover') }}
                className="group flex flex-col items-center gap-3 p-6 rounded-xl border border-border bg-secondary/30 hover:bg-primary/10 hover:border-primary/40 transition-all cursor-pointer"
              >
                <div className="w-14 h-14 rounded-2xl bg-primary/15 flex items-center justify-center group-hover:bg-primary/25 transition-colors">
                  <Search size={24} className="text-primary" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-foreground">Join a Hub</p>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-snug">Browse and discover public hubs to join</p>
                </div>
              </button>

              {/* Create a Hub */}
              <button
                onClick={() => { setShowHubChoice(false); setShowCreateHub(true) }}
                className="group flex flex-col items-center gap-3 p-6 rounded-xl border border-border bg-secondary/30 hover:bg-green-500/10 hover:border-green-500/40 transition-all cursor-pointer"
              >
                <div className="w-14 h-14 rounded-2xl bg-green-500/15 flex items-center justify-center group-hover:bg-green-500/25 transition-colors">
                  <Sparkles size={24} className="text-green-500" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-foreground">Create a Hub</p>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-snug">Start your own community from scratch</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </TooltipProvider>
  )
}

interface HubIconProps {
  label: string
  isActive: boolean
  onClick: () => void
  children: React.ReactNode
  isAction?: boolean
  isPreview?: boolean
  status?: HubStatus
  compact?: boolean
  folderColor?: string
  isInVoice?: boolean
  hubDTag?: string
  dmUnreadCount?: number
  hasNotificationDot?: boolean
  /** Show a spinner overlay while the hub's blossom secret/data is still being fetched+decrypted. */
  loadingSecrets?: boolean
}

function HubIcon({ label, isActive, onClick, children, isAction, isPreview, status, compact, folderColor, isInVoice, hubDTag, dmUnreadCount, hasNotificationDot, loadingSecrets }: HubIconProps) {
  const size = compact ? 'w-10 h-10' : 'w-12 h-12'
  const rounding = isActive ? 'rounded-2xl' : 'rounded-[24px] hover:rounded-2xl'

  // Unread state from notification store — suppress until initialized
  const notifReady = useNotificationStore((s) => s.initialized)
  const hubUnreads = useNotificationStore((s) => hubDTag ? s.hubUnreads[hubDTag] : undefined)
  const isMuted = useNotificationStore((s) => hubDTag ? s.hubMuteSettings[hubDTag]?.all ?? false : false)
  const totalUnread = notifReady && !isMuted && hubUnreads
    ? Object.values(hubUnreads).reduce((sum, ch) => sum + ch.count, 0)
    : 0
  const hasMention = notifReady && !isMuted && hubUnreads
    ? Object.values(hubUnreads).some((ch) => ch.hasMention)
    : false

  return (
    <div className="relative group flex items-center justify-center w-full">
      {/* Active / hover indicator bar — only for top-level icons (not inside folder pill) */}
      {!folderColor && (
        <div
          className={cn(
            'absolute left-0 w-1 rounded-r-full bg-foreground transition-all duration-200',
            isActive ? 'h-10' : 'h-0 group-hover:h-5'
          )}
        />
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            data-hub-dtag={hubDTag}
            className={cn(
              'relative flex items-center justify-center transition-all duration-200 cursor-pointer overflow-hidden',
              size, rounding,
              isActive ? 'bg-primary text-primary-foreground' : '',
              !isActive && !isAction && !isPreview && 'bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground',
              isAction && 'bg-secondary text-green-500 hover:bg-green-600 hover:text-white',
              isPreview && !isActive && 'bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground border-2 border-dashed border-primary/40'
            )}
          >
            {children}
            {/* Loading overlay while blossom secret/data is being fetched + decrypted */}
            {loadingSecrets && (
              <div className="absolute inset-0 z-[5] flex items-center justify-center bg-background/45 backdrop-blur-[1px]">
                <Loader2 size={16} className="animate-spin text-white" />
              </div>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{loadingSecrets ? `${label} — loading…` : label}</TooltipContent>
      </Tooltip>

      {/* Status badge */}
      {status === 'not-found' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn('absolute -bottom-0.5 w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center shadow-md z-10 cursor-default', compact ? '-right-0.5' : 'right-1')}>
              <HelpCircle size={12} className="text-white" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">Hub not found</TooltipContent>
        </Tooltip>
      )}
      {status === 'deleted' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn('absolute -bottom-0.5 w-5 h-5 rounded-full bg-destructive flex items-center justify-center shadow-md z-10 cursor-default', compact ? '-right-0.5' : 'right-1')}>
              <XCircle size={12} className="text-white" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">Hub deleted</TooltipContent>
        </Tooltip>
      )}

      {/* Voice call indicator */}
      {isInVoice && status !== 'deleted' && status !== 'not-found' && (
        <div className={cn('absolute bottom-0 w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center shadow-md z-10', compact ? '-right-1' : 'right-2')}>
          <Volume2 size={10} className="text-white" />
        </div>
      )}

      {/* Unread notification badge — or pulsing dot while loading */}
      {!isActive && status !== 'deleted' && status !== 'not-found' && !isInVoice && hubDTag && (
        !notifReady ? (
          /* Pulsing dot — indicates notifications are being loaded */
          <div className={cn('absolute bottom-0 w-[14px] h-[14px] rounded-full bg-muted-foreground/40 z-10 animate-pulse border-2 border-secondary', compact ? 'right-0' : 'right-3')} />
        ) : totalUnread > 0 ? (
          <div className={cn(
            'absolute bottom-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1 shadow-md z-10 border-2 border-secondary',
            compact ? '-right-1' : 'right-2',
            hasMention
              ? 'bg-destructive text-destructive-foreground'
              : 'bg-foreground text-background'
          )}>
            {totalUnread > 99 ? '99+' : totalUnread}
          </div>
        ) : null
      )}

      {/* DM / Public Chat unread badge — or pulsing dot while loading */}
      {!isActive && dmUnreadCount !== undefined && (
        !notifReady ? (
          <div className={cn('absolute bottom-0 w-[14px] h-[14px] rounded-full bg-muted-foreground/40 z-10 animate-pulse border-2 border-secondary', compact ? 'right-0' : 'right-3')} />
        ) : dmUnreadCount > 0 ? (
          <div className={cn('absolute bottom-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1 shadow-md z-10 bg-destructive text-destructive-foreground pointer-events-none border-2 border-secondary', compact ? '-right-1' : 'right-2')}>
            {dmUnreadCount > 99 ? '99+' : dmUnreadCount}
          </div>
        ) : null
      )}

      {/* Simple notification dot (e.g. social feed) */}
      {!isActive && hasNotificationDot && (
        <div className={cn('absolute bottom-0 w-[14px] h-[14px] rounded-full bg-destructive shadow-md z-10 pointer-events-none border-2 border-secondary', compact ? '-right-1' : 'right-2')} />
      )}
    </div>
  )
}

