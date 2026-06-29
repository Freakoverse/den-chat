/**
 * UserPanel — Shared bottom bar showing logged-in user info + voice controls
 *
 * Avatar, display name, truncated npub, and action buttons.
 * When connected to a voice channel, shows voice controls (mute, camera, etc.)
 * with the connected channel name and a disconnect button.
 * Mic and deafen buttons work globally (even before joining a call).
 */

import { useState, useEffect } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useHubStore } from '@/stores/hubStore'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { AccountSwitcher } from '@/components/ui/AccountSwitcher'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { useDnnStore } from '@/stores/dnnStore'
import { formatDnnId } from '@/lib/dnn/formatDnnId'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { truncateNpub } from '@/lib/utils'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'

import { useProfileCache } from '@/hooks/useProfileCache'
import { useCachedImageUrl } from '@/lib/imageCache'

export function UserPanel() {
  const pubkey = useUserStore((s) => s.pubkey)
  const displayName = useUserStore((s) => s.displayName)
  const avatar = useUserStore((s) => s.avatar)
  const authMethod = useUserStore((s) => s.authMethod)
  const cachedAvatar = useCachedImageUrl(avatar ?? undefined)
  const [profileOpen, setProfileOpen] = useState(false)

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
      <div className="flex gap-2 min-h-14">
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
            {/* Account switcher — desktop keyring (seed/nsec) + PWA vault */}
            <AccountSwitcher
              trigger={(open) => (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={open}
                        className="h-full shrink-0 p-1.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                      >
                        <ChevronsUpDown size={16} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">Switch Account</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            />
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
