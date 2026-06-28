/**
 * UserPanel — Shared bottom bar showing logged-in user info + voice controls
 *
 * Avatar, display name, truncated npub, and action buttons.
 * When connected to a voice channel, shows voice controls (mute, camera, etc.)
 * with the connected channel name and a disconnect button.
 * Mic and deafen buttons work globally (even before joining a call).
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useHubStore } from '@/stores/hubStore'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { useDnnStore } from '@/stores/dnnStore'
import { formatDnnId } from '@/lib/dnn/formatDnnId'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { truncateNpub, isTauri } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import {
  Camera,
  CameraOff,
  ScreenShare,
  ScreenShareOff,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  PhoneOff,
  Volume2,
  Clock,
  Loader2,
  ChevronsUpDown,
  Sprout,
  Key,
  Lock,
  Eye,
  EyeOff,
  Check,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  listAccounts, listSeeds, loginAccount,
  type StoredAccount, type StoredSeed,
} from '@/lib/auth/secure-storage'

import { useProfileCache } from '@/hooks/useProfileCache'
import { useCachedImageUrl } from '@/lib/imageCache'

export function UserPanel() {
  const pubkey = useUserStore((s) => s.pubkey)
  const displayName = useUserStore((s) => s.displayName)
  const avatar = useUserStore((s) => s.avatar)
  const authMethod = useUserStore((s) => s.authMethod)
  const cachedAvatar = useCachedImageUrl(avatar ?? undefined)
  const [profileOpen, setProfileOpen] = useState(false)
  const isDesktop = isTauri()
  const showSwitcher = isDesktop && (authMethod === 'seed' || authMethod === 'nsec')

  // ── Account switcher state ──
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [savedAccounts, setSavedAccounts] = useState<StoredAccount[]>([])
  const [savedSeeds, setSavedSeeds] = useState<StoredSeed[]>([])
  const [switchTarget, setSwitchTarget] = useState<StoredAccount | null>(null)
  const [switchPin, setSwitchPin] = useState('')
  const [switchShowPin, setSwitchShowPin] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [switchLoading, setSwitchLoading] = useState(false)

  const loadAccounts = useCallback(async () => {
    if (!isDesktop) return
    const [accounts, seeds] = await Promise.all([listAccounts(), listSeeds()])
    setSavedAccounts(accounts)
    setSavedSeeds(seeds)
  }, [isDesktop])

  // Load accounts when switcher opens
  useEffect(() => {
    if (switcherOpen) loadAccounts()
  }, [switcherOpen, loadAccounts])

  // Build account groups (same logic as LoginScreen)
  const accountGroups = useMemo(() => {
    const groups: { type: 'seed' | 'standalone'; seed?: StoredSeed; accounts: StoredAccount[] }[] = []
    for (const seed of savedSeeds) {
      const accts = savedAccounts.filter((a) => a.seed_id === seed.id)
      if (accts.length > 0) groups.push({ type: 'seed', seed, accounts: accts })
    }
    const standalone = savedAccounts.filter((a) => !a.seed_id)
    if (standalone.length > 0) groups.push({ type: 'standalone', accounts: standalone })
    return groups
  }, [savedAccounts, savedSeeds])

  // Handle account switch — stash credentials and reload for clean slate
  const handleSwitch = async () => {
    if (!switchTarget || !switchPin) return
    setSwitchLoading(true)
    setSwitchError(null)
    try {
      const privKeyHex = await loginAccount(switchTarget.pubkey, switchPin)
      // Stash credentials for LoginScreen to pick up after reload
      sessionStorage.setItem('pending-switch', JSON.stringify({
        pubkey: switchTarget.pubkey,
        authMethod: switchTarget.auth_method,
        privKeyHex,
      }))
      // Full reload — guarantees every store, subscription, and WebSocket
      // is torn down and re-initialized with the new identity
      window.location.reload()
    } catch {
      setSwitchError('Incorrect PIN')
    } finally {
      setSwitchLoading(false)
    }
  }

  const closeSwitcher = () => {
    setSwitcherOpen(false)
    setSwitchTarget(null)
    setSwitchPin('')
    setSwitchError(null)
    setSwitchShowPin(false)
  }

  // Trigger profile fetch + DNN verification for own pubkey on mount
  const { getProfile } = useProfileCache()
  useEffect(() => {
    if (pubkey) getProfile(pubkey)
  }, [pubkey, getProfile])

  // Voice state
  const connectionState = useVoiceStore((s) => s.connectionState)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const currentHubDTag = useVoiceStore((s) => s.currentHubDTag)
  const isMuted = useVoiceStore((s) => s.isMuted)
  const isDeafened = useVoiceStore((s) => s.isDeafened)
  const isVideoEnabled = useVoiceStore((s) => s.isVideoEnabled)
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing)
  const joinedAt = useVoiceStore((s) => s.joinedAt)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const toggleVideo = useVoiceStore((s) => s.toggleVideo)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const leaveChannel = useVoiceStore((s) => s.leaveChannel)

  // Resolve channel name
  const hub = useHubStore((s) => (currentHubDTag ? Object.values(s.hubs).find((h) => h.dTag === currentHubDTag) : null))
  const voiceChannel = hub?.channels.find((c) => c.channelId === currentChannelId)
  const isInVoice = connectionState === 'connected'
  const isDisconnecting = connectionState === 'disconnecting'

  // Call duration
  const [duration, setDuration] = useState('00:00')
  useEffect(() => {
    if (!joinedAt || !isInVoice) {
      setDuration('00:00')
      return
    }
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - joinedAt) / 1000)
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0')
      const secs = (elapsed % 60).toString().padStart(2, '0')
      setDuration(`${mins}:${secs}`)
    }, 1000)
    return () => clearInterval(interval)
  }, [joinedAt, isInVoice])

  const npub = pubkey ? nip19.npubEncode(pubkey) : ''
  const name = displayName || (npub ? truncateNpub(npub) : 'Anonymous')

  return (
    <>
      <div className="flex gap-2 px-1 py-1 min-h-14">
        <div className="w-full flex flex-col gap-0 bg-secondary/50 rounded-md overflow-hidden shadow-md p-1">
          {/* Voice connection indicator — show above user card when in voice */}
          {(isInVoice || isDisconnecting) && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 mb-1">
              {isDisconnecting ? (
                <Loader2 size={14} className="text-red-400 shrink-0 animate-spin" />
              ) : (
                <Volume2 size={14} className="text-emerald-400 shrink-0 animate-pulse" />
              )}
              <div className="flex-1 min-w-0">
                <div className={cn(
                  'text-xs font-medium truncate',
                  isDisconnecting ? 'text-red-400' : 'text-emerald-400',
                )}>
                  {isDisconnecting ? 'Disconnecting...' : (voiceChannel?.name || 'Voice Channel')}
                </div>
                {!isDisconnecting && (
                  <div className="flex items-center gap-1 text-[10px] text-emerald-400/60">
                    <Clock size={9} />
                    {duration}
                  </div>
                )}
              </div>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={isDisconnecting ? undefined : () => leaveChannel([], null, null)}
                      disabled={isDisconnecting}
                      className={cn(
                        'p-1 rounded transition-colors',
                        isDisconnecting
                          ? 'opacity-50 cursor-not-allowed text-red-400/50'
                          : 'hover:bg-red-500/20 text-red-400 cursor-pointer',
                      )}
                    >
                      {isDisconnecting ? <Loader2 size={14} className="animate-spin" /> : <PhoneOff size={14} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">{isDisconnecting ? 'Disconnecting...' : 'Disconnect'}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {/* Clickable user card + account switcher button */}
          <div className="flex items-center gap-0.5 mb-1">
            <button
              onClick={() => setProfileOpen(true)}
              className="flex-1 min-w-0 flex gap-2 rounded-md p-2 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <span className="relative flex shrink-0 overflow-hidden rounded-full h-9 w-9">
                {cachedAvatar && <img src={cachedAvatar} alt={name} className="w-full h-full object-cover" />}
                {!avatar && (
                  <span className="flex h-full w-full items-center justify-center rounded-full text-xs bg-primary text-primary-foreground">
                    {name.slice(0, 2).toUpperCase()}
                  </span>
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate text-foreground text-left">
                  {name}
                </div>
                <DnnSubline pubkey={pubkey} npub={npub} />
              </div>
            </button>
            {/* Account switcher button — desktop + in-app accounts only */}
            {showSwitcher && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setSwitcherOpen(true)}
                      className="h-full shrink-0 p-1.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <ChevronsUpDown size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Switch Account</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* Action buttons row */}
          <TooltipProvider delayDuration={300}>
            <div className="w-full flex gap-2 border-t border-white/10 h-10 pt-1">
              {/* Mic — always functional */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleMute}
                    className={cn(
                      'flex-1 p-2 rounded cursor-pointer transition-colors',
                      isMuted
                        ? 'text-red-400 hover:bg-red-500/10'
                        : 'text-emerald-400 hover:bg-emerald-500/10',
                    )}
                  >
                    {isMuted ? <MicOff size={18} className="mx-auto" /> : <Mic size={18} className="mx-auto" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {isMuted ? 'Unmute' : 'Mute'}
                </TooltipContent>
              </Tooltip>

              {/* Deafen — always functional */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleDeafen}
                    className={cn(
                      'flex-1 p-2 rounded cursor-pointer transition-colors',
                      isDeafened
                        ? 'text-red-400 hover:bg-red-500/10'
                        : 'text-white/80 hover:text-white hover:bg-white/10',
                    )}
                  >
                    {isDeafened ? <HeadphoneOff size={18} className="mx-auto" /> : <Headphones size={18} className="mx-auto" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {isDeafened ? 'Undeafen' : 'Deafen'}
                </TooltipContent>
              </Tooltip>

              {/* Camera — voice only */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={isInVoice ? toggleVideo : undefined}
                    className={cn(
                      'flex-1 p-2 rounded cursor-pointer transition-colors',
                      isInVoice
                        ? isVideoEnabled
                          ? 'text-emerald-400 hover:bg-emerald-500/10'
                          : 'text-white/80 hover:text-white hover:bg-white/10'
                        : 'text-white/30 cursor-default',
                    )}
                  >
                    {isVideoEnabled ? <Camera size={18} className="mx-auto" /> : <CameraOff size={18} className="mx-auto" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {isInVoice ? (isVideoEnabled ? 'Camera Off' : 'Camera On') : 'Camera'}
                </TooltipContent>
              </Tooltip>

              {/* Screen Share — voice only */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={isInVoice ? toggleScreenShare : undefined}
                    className={cn(
                      'flex-1 p-2 rounded cursor-pointer transition-colors',
                      isInVoice
                        ? isScreenSharing
                          ? 'text-emerald-400 hover:bg-emerald-500/10'
                          : 'text-white/80 hover:text-white hover:bg-white/10'
                        : 'text-white/30 cursor-default',
                    )}
                  >
                    {isScreenSharing ? <ScreenShare size={18} className="mx-auto" /> : <ScreenShareOff size={18} className="mx-auto" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {isInVoice ? (isScreenSharing ? 'Stop Sharing' : 'Share Screen') : 'Screen Share'}
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
      </div>

      <UserProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />

      {/* ── Account Switcher Modal ── */}
      {switcherOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={closeSwitcher}>
          <div
            className="w-[380px] max-h-[70vh] bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h4 className="text-sm font-semibold flex items-center gap-2"><ChevronsUpDown size={16} /> Switch Account</h4>
              <button onClick={closeSwitcher} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
            </div>

            {/* Account list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {accountGroups.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">No accounts found</p>
              )}
              {accountGroups.map((group, gi) => (
                <div key={gi}>
                  {/* Group header */}
                  <div className="flex items-center gap-1.5 px-2 mb-1.5">
                    {group.type === 'seed' ? (
                      <Sprout size={12} className="text-emerald-400 shrink-0" />
                    ) : (
                      <Key size={12} className="text-amber-400 shrink-0" />
                    )}
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                      {group.type === 'seed' ? (group.seed?.name || 'Seed') : 'Imported Keys'}
                    </span>
                  </div>

                  {/* Accounts in group */}
                  <div className="space-y-1">
                    {group.accounts.map((acct) => {
                      const isActive = acct.pubkey === pubkey
                      const acctNpub = acct.npub || nip19.npubEncode(acct.pubkey)
                      const acctName = acct.name || truncateNpub(acctNpub)

                      return (
                        <button
                          key={acct.pubkey}
                          onClick={() => {
                            if (isActive) return
                            setSwitchTarget(acct)
                            setSwitchPin('')
                            setSwitchError(null)
                            setSwitchShowPin(false)
                          }}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors',
                            isActive
                              ? 'bg-primary/10 cursor-default'
                              : switchTarget?.pubkey === acct.pubkey
                                ? 'bg-secondary ring-1 ring-primary/40'
                                : 'hover:bg-secondary/60 cursor-pointer',
                          )}
                        >
                          <AccountAvatar pubkey={acct.pubkey} size={32} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate text-foreground">{acctName}</div>
                            <div className="text-[10px] text-muted-foreground truncate">{truncateNpub(acctNpub)}</div>
                          </div>
                          {/* Auth method badge */}
                          <span className={cn(
                            'shrink-0 text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider',
                            acct.auth_method === 'seed'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : 'bg-amber-500/15 text-amber-400',
                          )}>
                            {acct.auth_method === 'seed' ? `#${(acct.account_index ?? 0)}` : 'nsec'}
                          </span>
                          {isActive && <Check size={14} className="shrink-0 text-primary" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* PIN prompt — shown when a target account is selected */}
            {switchTarget && (
              <div className="border-t border-border px-4 py-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Enter PIN for <span className="font-medium text-foreground">{switchTarget.name || truncateNpub(switchTarget.npub || '')}</span>
                  {switchTarget.pin_hint && (
                    <span className="text-muted-foreground/70"> — hint: {switchTarget.pin_hint}</span>
                  )}
                </p>
                {switchError && (
                  <p className="text-xs text-destructive">{switchError}</p>
                )}
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={switchShowPin ? 'text' : 'password'}
                      value={switchPin}
                      onChange={(e) => { setSwitchPin(e.target.value); setSwitchError(null) }}
                      onKeyDown={(e) => e.key === 'Enter' && handleSwitch()}
                      placeholder="PIN"
                      autoFocus
                      className="w-full h-9 rounded-lg border border-input bg-background px-3 pr-9 text-sm focus:outline-none [&::-ms-reveal]:hidden"
                    />
                    <button
                      type="button"
                      onClick={() => setSwitchShowPin(!switchShowPin)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      {switchShowPin ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button
                    onClick={handleSwitch}
                    disabled={!switchPin || switchLoading}
                    className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {switchLoading ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                    Switch
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** Shows verified DNN ID or truncated npub below the display name */
function DnnSubline({ pubkey, npub }: { pubkey: string | null; npub: string }) {
  const dnnId = useDnnStore((s) => pubkey ? s.verified[pubkey]?.dnnId : undefined)
  const status = useDnnStore((s) => pubkey ? s.status[pubkey] : undefined)

  if (status === 'verified' && dnnId) {
    return (
      <div className="text-sm truncate text-primary/70 text-left">
        @{formatDnnId(dnnId)}
      </div>
    )
  }

  return (
    <div className="text-sm truncate text-muted-foreground text-left">
      {npub ? truncateNpub(npub) : ''}
    </div>
  )
}

/** Small avatar for the account switcher — fetches profile from cache */
function AccountAvatar({ pubkey, size = 32 }: { pubkey: string; size?: number }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey) // synchronous — triggers bg fetch + re-render via hook
  const cachedUrl = useCachedImageUrl(profile?.picture ?? undefined)
  const npub = nip19.npubEncode(pubkey)
  const fallback = truncateNpub(npub).slice(0, 2).toUpperCase()

  return (
    <span
      className="relative flex shrink-0 overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      {cachedUrl ? (
        <img src={cachedUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full text-[10px] bg-primary text-primary-foreground">
          {fallback}
        </span>
      )}
    </span>
  )
}
