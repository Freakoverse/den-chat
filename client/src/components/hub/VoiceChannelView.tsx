/**
 * VoiceChannelView — Main voice channel interface
 *
 * Displayed in the main content area when a voice channel is selected.
 * Shows:
 * - Channel header with name + connection status
 * - Connected participants grid with avatars + speaking indicators
 * - Separate tiles for cameras, screenshares, and spatial panel
 * - Click any tile to expand as primary view; click again to collapse
 * - Join/Leave button
 * - Voice control bar (mute/video/screenshare/disconnect)
 * - Available host list (from kind 36946)
 */

import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { truncateNpub, npubShort } from '@/lib/utils'
import { usePermissions } from '@/lib/hub/permissions'
import { nip19 } from 'nostr-tools'
import {
  Volume2,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Camera,
  CameraOff,
  ScreenShare,
  ScreenShareOff,
  PhoneOff,
  Phone,
  Users,
  Server,
  Wifi,
  WifiOff,
  Clock,
  Globe,
  Maximize,
  Minimize,
  Radar,
  Boxes,
  Pin,
  RefreshCw,
  Loader2,
  Shield,
  ShieldOff,
  Eye,
  EyeOff,
  Play,
  Square,
  AlertTriangle,
  ArrowLeft,
  Settings,
} from 'lucide-react'
import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react'
import { cn, isMobileOS } from '@/lib/utils'

// 3D virtual space is heavy (three.js / R3F) and PC-only — lazy-load so it never
// ships in the main bundle and only downloads when a user opens it.
const VirtualSpace = lazy(() => import('./VirtualSpace'))
import { getVoiceSensitivity } from '@/components/settings/SettingsPage'
import { supportsE2EE } from '@/lib/voice/e2ee-crypto'
import { SpatialPanel } from '@/components/hub/SpatialPanel'
import { ChannelView, ChannelDescriptionModal } from '@/components/hub/ChannelView'
import { usePinStore } from '@/stores/pinStore'
import { PinModal } from '@/components/hub/PinModal'
import { useNavigationStore } from '@/stores/navigationStore'
import { useMobile } from '@/hooks/useMobile'

/**
 * Hook: detect if the local user is speaking via Web Audio API.
 * Uses hysteresis (hold-off timer) to prevent flickering.
 */
function useSpeakingDetection(isConnected: boolean, isMuted: boolean): boolean {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const ctxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const rafRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)

  // Reuse the voiceStore's existing audio track instead of opening a new mic stream.
  // Firefox blocks/limits multiple getUserMedia streams to the same device simultaneously,
  // which causes the speaking indicator to never fire.
  const localAudioTrack = useVoiceStore((s) => s.localAudioTrack)

  useEffect(() => {
    if (!isConnected || isMuted) {
      setIsSpeaking(false)
      return
    }

    let cancelled = false

    const setupAnalyser = (stream: MediaStream, ownStream: boolean) => {
      if (cancelled) { if (ownStream) stream.getTracks().forEach((t) => t.stop()); return }

      streamRef.current = ownStream ? stream : null
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.85
      const source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)

      ctxRef.current = ctx
      sourceRef.current = source

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const THRESHOLD = getVoiceSensitivity()
      const HOLD_MS = 350
      let lastAbove = 0
      let lastUpdate = 0
      let currentState = false

      const tick = () => {
        if (cancelled) return
        analyser.getByteTimeDomainData(dataArray)

        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128
          sum += val * val
        }
        const rms = Math.sqrt(sum / dataArray.length) * 100
        const now = Date.now()

        if (rms > THRESHOLD) lastAbove = now

        const shouldSpeak = (now - lastAbove) < HOLD_MS

        if (shouldSpeak !== currentState && (now - lastUpdate) > 80) {
          currentState = shouldSpeak
          lastUpdate = now
          setIsSpeaking(shouldSpeak)
        }

        rafRef.current = requestAnimationFrame(tick)
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    if (localAudioTrack && localAudioTrack.readyState === 'live') {
      // Clone the store's mic track to avoid interfering with the SFU sender
      const clonedTrack = localAudioTrack.clone()
      const stream = new MediaStream([clonedTrack])
      setupAnalyser(stream, true)
    } else {
      // Fallback: open a new mic stream (works on Chrome, may fail on Firefox)
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        setupAnalyser(stream, true)
      }).catch(() => { /* mic not available */ })
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      sourceRef.current?.disconnect()
      ctxRef.current?.close()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      ctxRef.current = null
      sourceRef.current = null
      streamRef.current = null
      setIsSpeaking(false)
    }
  }, [isConnected, isMuted, localAudioTrack])

  return isSpeaking
}

// ── Tile ID types for the expand/collapse system ──
type TileId =
  | { type: 'participant'; pubkey: string }
  | { type: 'camera'; pubkey: string }
  | { type: 'screenshare'; pubkey: string }
  | { type: 'spatial' }

function tileIdKey(t: TileId): string {
  if (t.type === 'spatial') return 'spatial'
  return `${t.type}:${t.pubkey}`
}

export function VoiceChannelView() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const hubSecret = useHubStore((s) => (activeHubId ? s.hubSecrets[activeHubId] : undefined))
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  const pubkey = useUserStore((s) => s.pubkey)

  const connectionState = useVoiceStore((s) => s.connectionState)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const currentHubDTag = useVoiceStore((s) => s.currentHubDTag)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const isMuted = useVoiceStore((s) => s.isMuted)
  const isDeafened = useVoiceStore((s) => s.isDeafened)
  const isVideoEnabled = useVoiceStore((s) => s.isVideoEnabled)
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing)
  const joinedAt = useVoiceStore((s) => s.joinedAt)
  const presenceByHub = useVoiceStore((s) => s.presenceByHub)
  const hostsByHub = useVoiceStore((s) => s.hostsByHub)
  const getAvailableHosts = useVoiceStore((s) => s.getAvailableHosts)
  const getChannelPresence = useVoiceStore((s) => s.getChannelPresence)
  const joinChannel = useVoiceStore((s) => s.joinChannel)
  const leaveChannel = useVoiceStore((s) => s.leaveChannel)
  const switchHost = useVoiceStore((s) => s.switchHost)
  const currentHostPubkey = useVoiceStore((s) => s.currentHostPubkey)
  const toggleMute = useVoiceStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen)
  const toggleVideo = useVoiceStore((s) => s.toggleVideo)
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare)
  const remoteTracks = useVoiceStore((s) => s.remoteTracks)
  const localVideoTrack = useVoiceStore((s) => s.localVideoTrack)
  const localScreenTrack = useVoiceStore((s) => s.localScreenTrack)
  const spatialEnabled = useVoiceStore((s) => s.spatialEnabled)
  const spatialPanelOpen = useVoiceStore((s) => s.spatialPanelOpen)
  const toggleSpatialPanel = useVoiceStore((s) => s.toggleSpatialPanel)
  const virtualSpaceOpen = useVoiceStore((s) => s.virtualSpaceOpen)
  const toggleVirtualSpace = useVoiceStore((s) => s.toggleVirtualSpace)
  const voiceChatMode = useVoiceStore((s) => s.voiceChatMode)
  const refreshHosts = useVoiceStore((s) => s.refreshHosts)
  const isE2EE = useVoiceStore((s) => s.isE2EE)
  const screenWatching = useVoiceStore((s) => s._screenWatching)
  const cameraHidden = useVoiceStore((s) => s._cameraHidden)
  const watchScreenShare = useVoiceStore((s) => s.watchScreenShare)
  const unwatchScreenShare = useVoiceStore((s) => s.unwatchScreenShare)
  const showCamera = useVoiceStore((s) => s.showCamera)
  const hideCamera = useVoiceStore((s) => s.hideCamera)
  const isMobilVCV = useMobile()

  const channel = hub?.channels.find((c) => c.channelId === activeChannelId)
  const isConnected = connectionState === 'connected' && currentChannelId === activeChannelId
  const isConnecting = connectionState === 'connecting' && currentChannelId === activeChannelId
  const isReconnecting = connectionState === 'reconnecting' && currentChannelId === activeChannelId
  const isDisconnecting = connectionState === 'disconnecting'

  // Speaking detection — use voiceStore's gate-aware speaking state
  // (respects voice activity threshold, always-on, and push-to-talk modes)
  const selfSpeaking = useVoiceStore((s) => s._isSpeaking)

  // Participants from presence events (for when not connected)
  const presenceList = useMemo(
    () => (hub && activeChannelId ? getChannelPresence(hub.dTag, activeChannelId) : []),
    [hub, activeChannelId, presenceByHub],
  )

  // People in this channel on a DIFFERENT host than us — we can't hear them (they're
  // on a separate SFU). Grouped by host so the call window makes the split obvious,
  // with a button to switch to their host. Only meaningful while we're connected.
  const otherHostGroups = useMemo(() => {
    const groups = new Map<string, { pubkey: string }[]>()
    for (const p of presenceList) {
      if (p.pubkey === pubkey) continue
      // Only people confirmed (via presence) to be on a DIFFERENT host. Same-host
      // and unknown-host people are excluded — they belong on the call tiles.
      if (!p.hostPubkey || p.hostPubkey === currentHostPubkey) continue
      const arr = groups.get(p.hostPubkey) || []
      arr.push({ pubkey: p.pubkey })
      groups.set(p.hostPubkey, arr)
    }
    return Array.from(groups.entries())
  }, [presenceList, pubkey, currentHostPubkey])

  // Resolve voice permissions for this channel
  const perms = usePermissions(activeHubId ?? undefined, activeChannelId ?? undefined)

  // Derive the group scope from the channel's encryption setting
  // The encryption field is the raw groupId (hex hash) or null (hub-wide)
  const channelGroupId = useMemo(() => {
    return channel?.encryption || undefined
  }, [channel?.encryption])

  // For private channels: offer both group-scoped and hub-wide hosts
  const isPrivateVoice = !!channelGroupId
  const [useHubWideHosts, setUseHubWideHosts] = useState(false)

  // Group-scoped hosts (for private channels)
  const groupScopedHosts = useMemo(
    () => (hub && channelGroupId ? getAvailableHosts(hub.dTag, channelGroupId) : []),
    [hub, hostsByHub, channelGroupId],
  )
  // Hub-wide hosts (always available)
  const hubWideHosts = useMemo(
    () => (hub ? getAvailableHosts(hub.dTag, undefined) : []),
    [hub, hostsByHub],
  )

  // Active host pool: for private channels, togglable; for public channels, just hub-wide
  const availableHosts = useMemo(() => {
    if (!isPrivateVoice) return hubWideHosts
    // Auto-fallback: if no group-scoped hosts, show hub-wide
    if (groupScopedHosts.length === 0 && !useHubWideHosts) return hubWideHosts
    return useHubWideHosts ? hubWideHosts : groupScopedHosts
  }, [isPrivateVoice, useHubWideHosts, groupScopedHosts, hubWideHosts])

  // Whether we're currently using hub-wide hosts for a private channel (security concern)
  const usingHubWideForPrivate = isPrivateVoice && (useHubWideHosts || groupScopedHosts.length === 0)

  // Auto-select host: prefer the host that current participants are using
  const [selectedHostPubkey, setSelectedHostPubkey] = useState<string | null>(null)
  const selectedHost = useMemo(
    () => availableHosts.find((h) => h.pubkey === selectedHostPubkey) || availableHosts[0] || null,
    [availableHosts, selectedHostPubkey],
  )

  // Auto-detect which host is in use by existing participants
  useEffect(() => {
    if (selectedHostPubkey) return // user already chose manually
    if (presenceList.length === 0 || availableHosts.length === 0) return
    // Find the most common hostPubkey among participants in this channel
    const hostCounts: Record<string, number> = {}
    for (const p of presenceList) {
      if (p.hostPubkey) hostCounts[p.hostPubkey] = (hostCounts[p.hostPubkey] || 0) + 1
    }
    const topHost = Object.entries(hostCounts).sort((a, b) => b[1] - a[1])[0]
    if (topHost && availableHosts.some((h) => h.pubkey === topHost[0])) {
      setSelectedHostPubkey(topHost[0])
    }
  }, [presenceList, availableHosts])

  // Call duration
  const [duration, setDuration] = useState('00:00')
  const [joinError, setJoinError] = useState<string | null>(null)
  const [crossDeviceWarning, setCrossDeviceWarning] = useState(false)
  const [crossDeviceConfirmed, setCrossDeviceConfirmed] = useState(false)
  useEffect(() => {
    if (!joinedAt || !isConnected) {
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
  }, [joinedAt, isConnected])

  // ── Primary tile expand/collapse state ──
  const [primaryTileKey, setPrimaryTileKey] = useState<string | null>(null)

  const handleTileClick = useCallback((tile: TileId) => {
    const key = tileIdKey(tile)
    setPrimaryTileKey((prev) => (prev === key ? null : key))
  }, [])

  // Fullscreen ref
  const stageRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const toggleFullscreen = useCallback(() => {
    if (!stageRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      stageRef.current.requestFullscreen()
    }
  }, [])

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  if (!channel || !hub) return null

  // ── Pin + description state for chat mode header ──
  const [showDescModal, setShowDescModal] = useState(false)
  const [showPinModal, setShowPinModal] = useState(false)
  const subscribePins = usePinStore((s) => s.subscribePins)
  const unsubscribePins = usePinStore((s) => s.unsubscribePins)
  const hubPins = usePinStore((s) => activeHubId ? s.pinsByHub[activeHubId] : undefined)
  const totalChannelPins = useMemo(() => {
    if (!hubPins || !activeChannelId) return 0
    let count = 0
    for (const pe of hubPins) {
      for (const p of pe.pins) {
        if (p.channelId === activeChannelId) count++
      }
    }
    return count
  }, [hubPins, activeChannelId])

  useEffect(() => {
    if (!activeHubId || !hub) return
    const relays = [...hub.generalRelays]
    subscribePins(activeHubId, relays)
    return () => unsubscribePins(activeHubId)
  }, [activeHubId, hub?.generalRelays?.join(',')])

  const isCreator = !!(pubkey && hub.creatorPubkey === pubkey)

  // Map each present pubkey → its host, so the call tiles stay strictly to our own
  // host. Anyone known (via presence) to be on a different host must never render as
  // a call tile — they appear in the dimmed other-host group instead.
  const presenceHostByPk = new Map<string, string>()
  for (const pp of presenceList) if (pp.hostPubkey) presenceHostByPk.set(pp.pubkey, pp.hostPubkey)

  // Remote participants: never include our own pubkey (a stale/ghost session of
  // ourselves must not render as a remote), drop anyone on a different host, and
  // de-duplicate by pubkey so a duplicate roster entry can't multiply into cards.
  const _seenParticipantPk = new Set<string>()
  const participantList = Object.values(participants).filter((p) => {
    const pk = p.pubkey || p.id
    if (pk === pubkey) return false
    const theirHost = presenceHostByPk.get(pk)
    if (theirHost && currentHostPubkey && theirHost !== currentHostPubkey) return false
    if (_seenParticipantPk.has(pk)) return false
    _seenParticipantPk.add(pk)
    return true
  })

  // Helper: get a participant's video track from remote tracks (only live tracks)
  const getRemoteVideoTrack = (participantPubkey: string): MediaStreamTrack | null => {
    const tracks = remoteTracks[participantPubkey]
    const t = tracks?.find((t) => t.kind === 'video')?.track
    return t && t.readyState === 'live' ? t : null
  }

  // Helper: get a participant's screenshare track from remote tracks (only live tracks)
  const getRemoteScreenTrack = (participantPubkey: string): MediaStreamTrack | null => {
    const tracks = remoteTracks[participantPubkey]
    const t = tracks?.find((t) => t.kind === 'screenshare')?.track
    return t && t.readyState === 'live' ? t : null
  }

  // ── Build tile list ──
  // Order: spatial (if open), screenshares, cameras, participants
  type TileEntry = TileId & { key: string }
  const tiles: TileEntry[] = []

  // Spatial tile
  if (spatialPanelOpen) {
    tiles.push({ type: 'spatial', key: 'spatial' })
  }

  // Local screenshare
  if (isScreenSharing && localScreenTrack) {
    tiles.push({ type: 'screenshare', pubkey: pubkey || '', key: `screenshare:${pubkey}` })
  }
  // Remote screenshares — show tile if participant has screenshare active
  // (tile renders as placeholder with "Watch" button if track isn't pulled yet)
  for (const p of participantList) {
    const pk = p.pubkey || p.id
    if (p.hasScreenShare) {
      tiles.push({ type: 'screenshare', pubkey: pk, key: `screenshare:${pk}` })
    }
  }

  // Local camera
  if (isVideoEnabled && localVideoTrack) {
    tiles.push({ type: 'camera', pubkey: pubkey || '', key: `camera:${pubkey}` })
  }
  // Remote cameras — show if participant has video AND local user hasn't hidden it
  for (const p of participantList) {
    const pk = p.pubkey || p.id
    if (p.hasVideo && !cameraHidden.has(pk)) {
      const videoTrack = getRemoteVideoTrack(pk)
      if (videoTrack) {
        tiles.push({ type: 'camera', pubkey: pk, key: `camera:${pk}` })
      }
    }
  }

  // Self participant (always first avatar)
  tiles.push({ type: 'participant', pubkey: pubkey || '', key: `participant:${pubkey}` })

  // Remote participants
  for (const p of participantList) {
    const pk = p.pubkey || p.id
    tiles.push({ type: 'participant', pubkey: pk, key: `participant:${pk}` })
  }

  // Dedup tiles by key — final backstop so a duplicate participant/track entry
  // (e.g. a ghost session) can never render the same card more than once.
  const _seenTileKeys = new Set<string>()
  const dedupedTiles = tiles.filter((t) => {
    if (_seenTileKeys.has(t.key)) return false
    _seenTileKeys.add(t.key)
    return true
  })

  // Check if primary tile is still valid (e.g., screenshare stopped)
  const primaryTile = primaryTileKey ? dedupedTiles.find((t) => t.key === primaryTileKey) : null
  const otherTiles = primaryTile ? dedupedTiles.filter((t) => t.key !== primaryTileKey) : dedupedTiles

  // Render a single tile
  const renderTile = (tile: TileEntry, isPrimary: boolean) => {
    const onClick = () => handleTileClick(tile)

    if (tile.type === 'spatial') {
      return (
        <div
          key={tile.key}
          onClick={isPrimary ? undefined : onClick}
          className={cn(
            'relative rounded-xl overflow-hidden transition-all duration-200 bg-secondary/10 border border-border/30',
            isPrimary ? 'w-full flex-1 min-h-0 cursor-default' : 'cursor-pointer hover:ring-2 hover:ring-primary/40',
            !isPrimary && 'w-[220px] h-[160px] shrink-0',
          )}
        >
          {isPrimary ? (
            <SpatialPanel />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-[#111318]">
              <div className="flex flex-col items-center gap-1 text-muted-foreground">
                <Radar size={20} className="text-primary/60" />
                <span className="text-[10px] font-medium">Spatial</span>
              </div>
            </div>
          )}
        </div>
      )
    }

    if (tile.type === 'screenshare') {
      const isSelf = tile.pubkey === pubkey
      const track = isSelf ? localScreenTrack : getRemoteScreenTrack(tile.pubkey)
      const isWatching = isSelf || screenWatching.has(tile.pubkey)

      // Remote screenshare that user hasn't opted into — show placeholder
      if (!isSelf && !track) {
        return (
          <div
            key={tile.key}
            onClick={onClick}
            className={cn(
              'group relative flex items-center rounded-xl overflow-hidden transition-all duration-200 bg-[#111318] border border-border/30 cursor-pointer',
              isPrimary ? 'w-full flex-1 min-h-0' : 'hover:ring-2 hover:ring-emerald-400/40',
              !isPrimary && 'w-[220px] min-h-[160px] shrink-0',
            )}
          >
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-2">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <ScreenShare size={20} className="text-emerald-400" />
              </div>
              <div className="text-center">
                <ScreenShareLabel pubkey={tile.pubkey} isSelf={false} compact={!isPrimary} />
                {isPrimary && (
                  <p className="text-[12px] text-muted-foreground mt-0.5">Click to start receiving stream data</p>
                )}
              </div>
              {isWatching ? (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20">
                  <Loader2 size={12} className="animate-spin" /> Connecting to stream…
                </div>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); watchScreenShare(tile.pubkey) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 text-xs font-medium transition-colors cursor-pointer border border-emerald-500/20"
                >
                  <Play size={12} /> Watch Stream
                </button>
              )}
            </div>
          </div>
        )
      }

      if (!track) return null

      return (
        <div
          key={tile.key}
          ref={isPrimary ? stageRef : undefined}
          onClick={onClick}
          className={cn(
            'group relative rounded-xl overflow-hidden transition-all duration-200 bg-black/90 cursor-pointer',
            isPrimary ? 'w-full flex-1 min-h-0' : 'hover:ring-2 hover:ring-emerald-400/40',
            !isPrimary && 'w-[220px] h-[160px] shrink-0',
          )}
        >
          <VideoTile track={track} className="w-full h-full object-contain" />
          <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-md">
            <ScreenShare size={10} className="text-emerald-400" />
            <ScreenShareLabel pubkey={tile.pubkey} isSelf={isSelf} compact={!isPrimary} />
          </div>
          {/* Stream controls — label + icon, revealed on hover over the stream */}
          <div className="absolute top-2 right-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            {isPrimary && (
              <button
                onClick={(e) => { e.stopPropagation(); toggleFullscreen() }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-black/70 backdrop-blur-sm rounded-md text-white/90 hover:text-white text-xs font-medium transition-colors cursor-pointer"
              >
                {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
              </button>
            )}
            {!isSelf && (
              <button
                onClick={(e) => { e.stopPropagation(); unwatchScreenShare(tile.pubkey) }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-black/70 backdrop-blur-sm rounded-md text-red-400/90 hover:text-red-400 text-xs font-medium transition-colors cursor-pointer"
              >
                Stop watching
                <Square size={15} />
              </button>
            )}
          </div>
        </div>
      )
    }

    if (tile.type === 'camera') {
      const isSelf = tile.pubkey === pubkey
      const track = isSelf ? localVideoTrack : getRemoteVideoTrack(tile.pubkey)
      if (!track) return null

      return (
        <div
          key={tile.key}
          onClick={onClick}
          className={cn(
            'group relative rounded-xl overflow-hidden transition-all duration-200 bg-black/80 cursor-pointer',
            isPrimary
              ? 'w-full flex-1 min-h-0 ring-1 ring-border/30'
              : 'hover:ring-2 hover:ring-primary/40 ring-1 ring-border/30',
            !isPrimary && 'w-[220px] h-[160px] shrink-0',
          )}
        >
          <VideoTile track={track} className="w-full h-full object-contain" mirror={isSelf} />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
            <div className="flex items-center gap-1.5">
              <Camera size={10} className="text-primary/80" />
              <CameraTileLabel pubkey={tile.pubkey} isSelf={isSelf} />
            </div>
          </div>
          {/* Hide camera button for remote cameras */}
          {!isSelf && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); hideCamera(tile.pubkey) }}
                    className="absolute top-2 right-2 p-1.5 bg-black/60 backdrop-blur-sm rounded-md text-white/60 hover:text-white transition-all cursor-pointer opacity-0 group-hover:opacity-100"
                  >
                    <EyeOff size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Hide camera</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      )
    }

    // participant (avatar) tile
    const isSelf = tile.pubkey === pubkey
    const isSpeaking = isSelf ? selfSpeaking : (participants[tile.pubkey]?.isSpeaking ?? activeSpeakers.includes(tile.pubkey))
    const pIsMuted = isSelf ? isMuted : (participants[tile.pubkey]?.isMuted ?? false)
    const pIsDeafened = isSelf ? isDeafened : (participants[tile.pubkey]?.isDeafened ?? false)
    const pHasVideo = participants[tile.pubkey]?.hasVideo ?? false
    const pCameraHidden = !isSelf && pHasVideo && cameraHidden.has(tile.pubkey)

    return (
      <ParticipantTile
        key={tile.key}
        pubkey={tile.pubkey}
        isMuted={pIsMuted}
        isDeafened={pIsDeafened}
        isSpeaking={isSpeaking}
        isSelf={isSelf}
        compact={!!primaryTile}
        onClick={onClick}
        isPrimary={isPrimary}
        cameraHidden={pCameraHidden}
        onShowCamera={pCameraHidden ? () => showCamera(tile.pubkey) : undefined}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-background min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 min-h-12 shrink-0 my-2 bg-secondary/50 rounded-md shadow-md">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMobilVCV && (
            <button
              onClick={() => {
                useNavigationStore.getState().setMobileView('home')
                useVoiceStore.getState().setVoiceChatMode(false)
              }}
              className="shrink-0 p-1 -ml-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <Volume2 size={18} className="text-emerald-400 shrink-0" />
          <span className="font-semibold text-sm text-foreground shrink-0">{channel.name}</span>
          {isConnected && !isDisconnecting && (
            <span className="flex items-center gap-1 text-xs text-emerald-400/80 ml-2 shrink-0">
              <Wifi size={12} />
              Connected
            </span>
          )}
          {isConnected && !isDisconnecting && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`flex items-center gap-0.5 ml-1.5 shrink-0 ${isE2EE ? 'text-emerald-400' : 'text-amber-400/80'}`}>
                    {isE2EE ? <Shield size={14} /> : <ShieldOff size={14} />}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[200px]">
                  {isE2EE
                    ? 'End-to-end encrypted — only hub members can hear this call'
                    : 'Not end-to-end encrypted — hub secret not available'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {isConnected && !isDisconnecting && usingHubWideForPrivate && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 ml-1.5 text-[10px] text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                    <Globe size={10} /> Hub-wide
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[220px]">
                  Connected via hub-wide host — not using a private channel-scoped host
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {isConnecting && (
            <span className="flex items-center gap-1 text-xs text-amber-400/80 ml-2 animate-pulse shrink-0">
              <Wifi size={12} />
              Connecting...
            </span>
          )}
          {isReconnecting && (
            <span className="flex items-center gap-1 text-xs text-amber-400/80 ml-2 animate-pulse shrink-0">
              <Wifi size={12} />
              Reconnecting...
            </span>
          )}
          {isDisconnecting && (
            <span className="flex items-center gap-1 text-xs text-red-400/80 ml-2 animate-pulse shrink-0">
              <Loader2 size={12} className="animate-spin" />
              Disconnecting...
            </span>
          )}
          {/* Channel description — only in chat mode */}
          {voiceChatMode && (
            <>
              <div className="h-4 w-px bg-border mx-1 shrink-0" />
              <button
                onClick={() => setShowDescModal(true)}
                className="text-xs text-muted-foreground truncate hover:text-foreground transition-colors cursor-pointer min-w-0"
              >
                {channel.description || <span className="italic">No channel description</span>}
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Pin — only in chat mode */}
          {voiceChatMode && (
            totalChannelPins > 0 ? (
              <button
                onClick={() => setShowPinModal(true)}
                className="flex items-center gap-0 h-8 rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:border-border transition-colors cursor-pointer"
              >
                <span className="flex items-center justify-center px-2">
                  <Pin size={15} />
                </span>
                <span className="h-4 w-px bg-border/60" />
                <span className="px-2 text-xs tabular-nums">{totalChannelPins}</span>
              </button>
            ) : (
              <Button variant="ghost" size="icon" className="text-muted-foreground cursor-pointer" onClick={() => setShowPinModal(true)}>
                <Pin size={18} />
              </Button>
            )
          )}
          <span className="flex items-center gap-1 text-xs text-muted-foreground ml-1">
            <Users size={12} />
            {isConnected ? participantList.length + 1 : presenceList.length}
          </span>
        </div>
      </div>

      {/* Description modal */}
      {showDescModal && activeChannelId && (
        <ChannelDescriptionModal
          channelId={activeChannelId}
          channelName={channel.name}
          description={channel.description}
          isCreator={isCreator}
          onClose={() => setShowDescModal(false)}
        />
      )}

      {/* Pin modal */}
      {showPinModal && activeHubId && activeChannelId && (
        <PinModal
          hubDTag={activeHubId}
          channelId={activeChannelId}
          onClose={() => setShowPinModal(false)}
          onJumpToMessage={(aRef) => {
            setShowPinModal(false)
          }}
        />
      )}

      {/* Connecting modal — appears while joining, with a cancel to abort the attempt */}
      {isConnecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-xs rounded-2xl bg-card border border-border shadow-2xl p-6 flex flex-col items-center gap-4 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <Loader2 size={22} className="text-emerald-400 animate-spin" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">Connecting to voice…</h3>
              <p className="text-xs text-muted-foreground mt-1">Joining {channel?.name || 'the channel'}</p>
            </div>
            <Button variant="outline" className="w-full" onClick={() => leaveChannel([], null, null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Chat mode — reuse full ChannelView (toggled from sidebar icon) */}
      {voiceChatMode && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <ChannelView hideHeader />
        </div>
      )}

      {/* Voice view — main content area */}
      {!voiceChatMode && (
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6 overflow-y-auto">
          {/* Not connected state */}
          {!isConnected && !isConnecting && !isReconnecting && !isDisconnecting && (
            <div className="flex flex-col w-full items-center gap-6 max-w-sm text-center">
              <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <Volume2 size={36} className="text-emerald-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-1">{channel.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {presenceList.length > 0
                    ? `${presenceList.length} member${presenceList.length > 1 ? 's' : ''} currently in voice`
                    : 'No one is in this voice channel'}
                </p>
              </div>

              {/* Presence avatars (people already in channel) */}
              {presenceList.length > 0 && (
                <div className="flex flex-wrap justify-center gap-3">
                  {presenceList.map((p) => (
                    <PresenceAvatar
                      key={p.pubkey}
                      pubkey={p.pubkey}
                      hostPubkey={p.hostPubkey}
                      availableHosts={availableHosts}
                    />
                  ))}
                </div>
              )}

              {/* Available hosts */}
              {availableHosts.length > 0 ? (
                <div className="flex flex-col items-center gap-2">
                  <button
                    onClick={async () => {
                      // Check for cross-device conflict
                      if (pubkey && !crossDeviceConfirmed) {
                        // Look for own pubkey in ANY hub's presence with 'joined' status
                        const allPresence = useVoiceStore.getState().presenceByHub
                        for (const [hTag, entries] of Object.entries(allPresence)) {
                          const selfEntry = entries.find(
                            (p) => p.pubkey === pubkey && p.status === 'joined' &&
                              (Date.now() / 1000 - p.createdAt) < 60
                          )
                          if (selfEntry) {
                            setCrossDeviceWarning(true)
                            return
                          }
                        }
                      }

                      // Join selected host
                      if (pubkey && selectedHost?.config) {
                        setJoinError(null)
                        setCrossDeviceWarning(false)
                        setCrossDeviceConfirmed(false)
                        try {
                          await joinChannel(hub.dTag, activeChannelId!, selectedHost.config, selectedHost.pubkey, pubkey, hubSecret)
                        } catch (err: any) {
                          setJoinError(err?.message || 'Failed to connect to voice host')
                        }
                      }
                    }}
                    disabled={isConnecting || !perms.connect_voice}
                    className={cn(
                      'flex items-center gap-2 px-6 py-2.5 rounded-full bg-emerald-500 text-white font-medium text-sm hover:bg-emerald-400 transition-colors cursor-pointer shadow-lg shadow-emerald-500/20',
                      isConnecting && 'opacity-60 cursor-wait',
                    )}
                  >
                    {isConnecting ? (
                      <><Wifi size={16} className="animate-pulse" /> Connecting...</>
                    ) : (
                      <><Phone size={16} /> Join Voice</>
                    )}
                  </button>
                  {/* Permission denied message */}
                  {!perms.connect_voice && (
                    <p className="text-xs text-amber-400/80 mt-1">You don't have permission to join voice channels</p>
                  )}
                  {joinError && (
                    <div className="text-xs text-red-400 max-w-xs text-center px-2 py-1 rounded-md bg-red-500/10 border border-red-500/20">
                      {joinError}
                    </div>
                  )}
                  {crossDeviceWarning && (
                    <div className="max-w-xs text-center px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <p className="text-xs text-amber-400 font-medium mb-1">Already in voice</p>
                      <p className="text-[11px] text-muted-foreground mb-3">
                        You appear to be in a voice channel on another device or tab. Joining here may cause issues with your presence visibility.
                      </p>
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={async () => {
                            setCrossDeviceWarning(false)
                            setCrossDeviceConfirmed(true)
                            if (pubkey && selectedHost?.config) {
                              setJoinError(null)
                              try {
                                await joinChannel(hub.dTag, activeChannelId!, selectedHost.config, selectedHost.pubkey, pubkey, hubSecret)
                              } catch (err: any) {
                                setJoinError(err?.message || 'Failed to connect to voice host')
                              }
                            }
                          }}
                          className="px-3 py-1 rounded-full bg-amber-500/20 text-amber-400 text-[11px] font-medium hover:bg-amber-500/30 transition-colors cursor-pointer"
                        >
                          Join anyway
                        </button>
                        <button
                          onClick={() => setCrossDeviceWarning(false)}
                          className="px-3 py-1 rounded-full bg-muted text-muted-foreground text-[11px] hover:bg-accent transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground/60">
                    <WifiOff size={14} />
                    No voice hosts available
                  </div>
                  <p className="text-xs text-muted-foreground/40 max-w-xs">
                    A hub member needs to provide SFU hosting credentials via User Hub Settings → Voice Hosting.
                  </p>
                  <button
                    onClick={() => { if (hub) { const nav = useNavigationStore.getState(); nav.setPendingHubVoiceHostingDTag(hub.dTag); nav.setMobileView('home') } }}
                    className="mt-1 flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm font-medium hover:bg-emerald-500/25 transition-colors cursor-pointer"
                  >
                    <Volume2 size={14} /> Set Up Voice Hosting
                  </button>
                </div>
              )}

              {/* Host list */}
              {(availableHosts.length > 0 || (isPrivateVoice && (groupScopedHosts.length > 0 || hubWideHosts.length > 0))) && (
                <div className="w-full max-w-xs rounded-lg border border-border/50 bg-secondary/30 p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                    <Server size={12} />
                    Available Hosts ({availableHosts.length})
                  </div>

                  {/* Private/Hub-wide toggle for private voice channels */}
                  {isPrivateVoice && groupScopedHosts.length > 0 && (
                    <div className="flex flex-col items-center gap-1 mb-2">
                      <button
                        onClick={() => { setUseHubWideHosts(false); setSelectedHostPubkey(null) }}
                        className={cn(
                          'flex-1 flex items-center justify-center gap-1 p-1 w-full rounded-md text-[11px] font-medium transition-colors cursor-pointer',
                          !useHubWideHosts
                            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                            : 'bg-transparent text-muted-foreground/60 hover:text-muted-foreground border border-transparent',
                        )}
                      >
                        <Shield size={10} /> Private ({groupScopedHosts.length})
                      </button>
                      <button
                        onClick={() => { setUseHubWideHosts(true); setSelectedHostPubkey(null) }}
                        className={cn(
                          'flex-1 flex items-center justify-center gap-1 p-1 w-full rounded-md text-[11px] font-medium transition-colors cursor-pointer',
                          useHubWideHosts
                            ? 'bg-primary/15 text-primary border border-primary/30'
                            : 'bg-transparent text-muted-foreground/60 hover:text-muted-foreground border border-transparent',
                        )}
                      >
                        <Globe size={10} /> Hub-wide ({hubWideHosts.length})
                      </button>
                    </div>
                  )}

                  {/* Security warning when using hub-wide host for private channel */}
                  {usingHubWideForPrivate && availableHosts.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-2 px-2 py-1.5 rounded-md bg-amber-500/8 border border-amber-500/15">
                      <AlertTriangle size={10} className="text-amber-400 shrink-0" />
                      <span className="text-[10px] text-amber-400/90 leading-tight">
                        Using hub-wide host — credentials are not scoped to this private channel
                      </span>
                    </div>
                  )}

                  {availableHosts.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {availableHosts.map((host) => {
                        const pCount = presenceList.filter((p) => p.hostPubkey === host.pubkey).length
                        return (
                          <HostItem
                            key={host.pubkey}
                            host={host}
                            hub={hub}
                            isSelected={selectedHost?.pubkey === host.pubkey}
                            participantCount={pCount}
                            onClick={() => setSelectedHostPubkey(host.pubkey)}
                          />
                        )
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-2 text-[11px] text-muted-foreground/50">
                      No hosts in this scope
                    </div>
                  )}
                </div>
              )}

              {/* Subtle link to provide your own hosting when hosts already exist
                  (inverse of the prominent no-host button, so only one shows) */}
              {availableHosts.length > 0 && (
                <button
                  onClick={() => { if (hub) { const nav = useNavigationStore.getState(); nav.setPendingHubVoiceHostingDTag(hub.dTag); nav.setMobileView('home') } }}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground underline underline-offset-2 transition-colors cursor-pointer"
                >
                  <Volume2 size={11} /> Provide voice hosting
                </button>
              )}

              {/* Refresh hosts button — always visible */}
              <button
                onClick={() => {
                  if (!hub) return
                  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
                  const groupIds = hub.groupedRoles?.map((g) => g.groupId) || []
                  refreshHosts(hub.dTag, relays, hubSecret, groupIds)
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground/60 hover:text-muted-foreground hover:bg-secondary/40 transition-colors cursor-pointer"
              >
                <RefreshCw size={12} />
                Refresh Hosts
              </button>
            </div>
          )}

          {/* Connected state — tile grid */}
          {(isConnected || isConnecting || isReconnecting || isDisconnecting) && (
            <div className="flex-1 w-full flex flex-col gap-2 overflow-hidden min-h-0">

              {/* Security warning — using hub-wide host for a private channel */}
              {usingHubWideForPrivate && (
                <div className="flex items-center gap-2 mx-4 mt-2 px-3 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20 shrink-0">
                  <Globe size={14} className="text-amber-400 shrink-0" />
                  <span className="text-[11px] text-amber-400/90 leading-tight">
                    Connected via hub-wide host — this private channel's voice is not using scoped credentials
                  </span>
                </div>
              )}
              {virtualSpaceOpen ? (
                <div className="flex-1 min-h-0 p-2">
                  <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">Loading virtual space…</div>}>
                    <VirtualSpace />
                  </Suspense>
                </div>
              ) : (
              <>
              {/* Primary tile (expanded) */}
              {primaryTile && (
                <div className="flex-1 min-h-0 flex flex-col">
                  {renderTile(primaryTile, true)}
                </div>
              )}

              {/* Tile strip / grid — all tiles when no primary, or remaining tiles when primary is set */}
              <div
                className={cn(
                  'flex flex-wrap justify-center items-center gap-3 content-center p-4 shrink-0 overflow-x-auto rounded-md',
                  primaryTile ? 'max-h-[200px] bg-secondary/20' : 'flex-1',
                )}
              >
                {otherTiles.map((tile) => renderTile(tile, false))}
              </div>

              {/* People in this channel on a different host — can't hear them here */}
              {otherHostGroups.length > 0 && (
                <div className="shrink-0 flex flex-col gap-2 px-4 pb-1">
                  {otherHostGroups.map(([hostPk, members]) => (
                    <OtherHostGroup
                      key={hostPk}
                      hostPubkey={hostPk}
                      members={members}
                      onJoin={() => switchHost(hostPk)}
                    />
                  ))}
                </div>
              )}
              </>
              )}

              {/* Voice controls */}
              <div className="flex justify-center gap-2 pb-4 pt-2">
                <VoiceActionButton
                  icon={isMuted ? MicOff : Mic}
                  label={!perms.speak ? 'No permission to speak' : isMuted ? 'Unmute' : 'Mute'}
                  active={!isMuted && perms.speak}
                  danger={isMuted}
                  disabled={!perms.speak}
                  onClick={toggleMute}
                />
                <VoiceActionButton
                  icon={isDeafened ? HeadphoneOff : Headphones}
                  label={isDeafened ? 'Undeafen' : 'Deafen'}
                  active={!isDeafened}
                  danger={isDeafened}
                  onClick={toggleDeafen}
                />
                <VoiceActionButton
                  icon={isVideoEnabled ? Camera : CameraOff}
                  label={!perms.use_camera ? 'No permission to use camera' : isVideoEnabled ? 'Camera Off' : 'Camera On'}
                  active={isVideoEnabled}
                  disabled={!perms.use_camera}
                  onClick={toggleVideo}
                />
                <VoiceActionButton
                  icon={isScreenSharing ? ScreenShareOff : ScreenShare}
                  label={!perms.stream_video ? 'No permission to share screen' : isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
                  active={isScreenSharing}
                  disabled={!perms.stream_video}
                  onClick={toggleScreenShare}
                />
                <VoiceActionButton
                  icon={Radar}
                  label={!perms.use_spatial ? 'No permission for spatial audio' : spatialPanelOpen ? 'Close Spatial Panel' : 'Spatial Audio'}
                  active={spatialPanelOpen}
                  disabled={!perms.use_spatial}
                  onClick={toggleSpatialPanel}
                />
                {/* 3D virtual space — PC only (pointer lock + mouse look) */}
                {!isMobileOS() && (
                  <VoiceActionButton
                    icon={Boxes}
                    label={!perms.use_spatial ? 'No permission for spatial audio' : virtualSpaceOpen ? 'Exit Virtual Space' : 'Virtual Space'}
                    active={virtualSpaceOpen}
                    disabled={!perms.use_spatial}
                    onClick={toggleVirtualSpace}
                  />
                )}
                <VoiceActionButton
                  icon={Settings}
                  label="Voice & video settings"
                  onClick={() => {
                    const nav = useNavigationStore.getState()
                    nav.setActivePage('settings')
                    nav.setSettingsTab('voice-video')
                  }}
                />
                <VoiceActionButton
                  icon={isDisconnecting ? Loader2 : PhoneOff}
                  label={isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  danger
                  disabled={isDisconnecting}
                  spinning={isDisconnecting}
                  onClick={() => leaveChannel([], null, null)}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ─── OtherHostGroup — people in this channel on a different SFU host ─── */

function OtherHostAvatar({ pubkey }: { pubkey: string }) {
  const { getProfile } = useProfileCache()
  const isHex = /^[0-9a-f]{64}$/i.test(pubkey)
  const profile = isHex ? getProfile(pubkey) : null
  const name = profile?.display_name || profile?.name || npubShort(pubkey)
  return (
    <Avatar className="w-6 h-6 border border-border/40">
      <AvatarImage src={profile?.picture} alt={name} />
      <AvatarFallback className="text-[9px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  )
}

function OtherHostGroup({ hostPubkey, members, onJoin }: { hostPubkey: string; members: { pubkey: string }[]; onJoin: () => void }) {
  const { getProfile } = useProfileCache()
  const isHex = /^[0-9a-f]{64}$/i.test(hostPubkey)
  const hostProfile = isHex ? getProfile(hostPubkey) : null
  const hostName = hostProfile?.display_name || hostProfile?.name || (hostPubkey ? npubShort(hostPubkey) : 'another host')
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/40 bg-secondary/20 px-3 py-2 opacity-75">
      <Globe size={14} className="text-muted-foreground shrink-0" />
      <div className="flex items-center -space-x-1.5 shrink-0">
        {members.slice(0, 6).map((m) => <OtherHostAvatar key={m.pubkey} pubkey={m.pubkey} />)}
        {members.length > 6 && (
          <span className="text-[10px] text-muted-foreground ml-2 shrink-0">+{members.length - 6}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-tight truncate min-w-0 flex-1">
        On <span className="text-foreground/80 font-medium">{hostName}'s host</span> — join to hear them
      </p>
      <button
        onClick={onJoin}
        className="shrink-0 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors cursor-pointer"
      >
        Join this host
      </button>
    </div>
  )
}

/* ─── VideoTile — attach a MediaStreamTrack to a <video> element ─── */

function VideoTile({
  track,
  className = '',
  mirror = false,
}: {
  track: MediaStreamTrack
  className?: string
  mirror?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el || !track || track.readyState === 'ended') return

    const stream = new MediaStream([track])
    el.srcObject = stream

    // Firefox sometimes needs an explicit play() after setting srcObject
    el.play().catch(() => { })

    // Re-trigger play when a track is unmuted/enabled (Firefox can pause internally)
    const onUnmute = () => {
      el.srcObject = new MediaStream([track])
      el.play().catch(() => { })
    }
    track.addEventListener('unmute', onUnmute)

    // When remote peer disconnects, the track goes 'muted' (not 'ended').
    // Clear srcObject to prevent showing the last stuck frame.
    const onMute = () => {
      if (track.kind === 'video') {
        el.srcObject = null
      }
    }
    track.addEventListener('mute', onMute)

    // Clean up when track ends
    const onEnded = () => { el.srcObject = null }
    track.addEventListener('ended', onEnded)

    return () => {
      track.removeEventListener('unmute', onUnmute)
      track.removeEventListener('mute', onMute)
      track.removeEventListener('ended', onEnded)
      el.srcObject = null
    }
  }, [track])

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className={cn(className, mirror && 'scale-x-[-1]')}
    />
  )
}

/* ─── ScreenShareLabel — show who's sharing ─── */

function ScreenShareLabel({ pubkey, isSelf, compact = false }: { pubkey: string; isSelf: boolean; compact?: boolean }) {
  const { getProfile } = useProfileCache()
  const isHex = /^[0-9a-f]{64}$/i.test(pubkey)
  const profile = isHex ? getProfile(pubkey) : null
  const npub = isHex ? nip19.npubEncode(pubkey) : ''
  const name = profile?.display_name || profile?.name || (isHex ? truncateNpub(npub) : 'Unknown')

  if (compact) {
    return <span className="text-sm font-medium text-white/80 truncate max-w-[80px]">{isSelf ? 'You' : name}</span>
  }

  return (
    <span className="text-sm font-medium text-white/90">
      {isSelf ? 'You are sharing' : `${name} is sharing`}
    </span>
  )
}

/* ─── CameraTileLabel — show whose camera ─── */

function CameraTileLabel({ pubkey, isSelf }: { pubkey: string; isSelf: boolean }) {
  const { getProfile } = useProfileCache()
  const isHex = /^[0-9a-f]{64}$/i.test(pubkey)
  const profile = isHex ? getProfile(pubkey) : null
  const npub = isHex ? nip19.npubEncode(pubkey) : ''
  const name = profile?.display_name || profile?.name || (isHex ? truncateNpub(npub) : 'Unknown')

  return (
    <span className="text-[11px] font-medium text-white/90 truncate">
      {isSelf ? `${name} (You)` : name}
    </span>
  )
}

/* ─── ParticipantTile — avatar only (no embedded video) ─── */

function ParticipantTile({
  pubkey,
  isMuted,
  isDeafened,
  isSpeaking,
  isSelf,
  compact = false,
  onClick,
  isPrimary = false,
  cameraHidden = false,
  onShowCamera,
}: {
  pubkey: string
  isMuted: boolean
  isDeafened: boolean
  isSpeaking: boolean
  isSelf: boolean
  compact?: boolean
  onClick?: () => void
  isPrimary?: boolean
  cameraHidden?: boolean
  onShowCamera?: () => void
}) {
  const { getProfile } = useProfileCache()
  const isHexPubkey = /^[0-9a-f]{64}$/i.test(pubkey)
  const profile = isHexPubkey ? getProfile(pubkey) : null
  const npub = isHexPubkey ? nip19.npubEncode(pubkey) : ''
  const name = profile?.display_name || profile?.name || (isHexPubkey ? truncateNpub(npub) : pubkey || 'Unknown')

  if (isPrimary) {
    // Expanded primary view — large centered avatar
    return (
      <div
        onClick={onClick}
        className={cn(
          'flex-1 min-h-0 flex flex-col items-center justify-center gap-4 rounded-xl transition-all duration-200 relative cursor-pointer',
          isSpeaking ? 'bg-emerald-500/10 ring-2 ring-emerald-400/50' : 'bg-secondary/30',
        )}
      >
        <div className="relative">
          <div
            className={cn(
              'rounded-full overflow-hidden transition-all duration-300 w-28 h-28',
              isSpeaking ? 'ring-4 ring-emerald-400 ring-offset-3 ring-offset-background' : '',
            )}
          >
            {profile?.picture ? (
              <img src={profile.picture} alt={name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-3xl">
                {name.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
          {isMuted && (
            <div className="absolute -bottom-1 -right-1 bg-red-500 rounded-full p-1.5">
              <MicOff size={14} className="text-white" />
            </div>
          )}
          {isDeafened && !isMuted && (
            <div className="absolute -bottom-1 -right-1 bg-red-500 rounded-full p-1.5">
              <HeadphoneOff size={14} className="text-white" />
            </div>
          )}
          {isSpeaking && (
            <div className="absolute inset-0 rounded-full animate-ping bg-emerald-400/20" style={{ animationDuration: '1.5s' }} />
          )}
        </div>
        <div className="text-center">
          <div className="text-base font-semibold text-foreground">{isSelf ? `${name} (You)` : name}</div>
          {cameraHidden && onShowCamera && (
            <button
              onClick={(e) => { e.stopPropagation(); onShowCamera() }}
              className="inline-flex items-center justify-center gap-1.5 mx-auto mt-3 px-4 py-2 rounded-lg text-sm font-medium leading-none text-primary/80 hover:text-primary bg-primary/10 hover:bg-primary/20 transition-colors cursor-pointer"
            >
              <Eye size={14} className="shrink-0" /> Show Camera
            </button>
          )}
        </div>
      </div>
    )
  }

  // Compact / grid avatar tile
  return (
    <div
      onClick={onClick}
      className={cn(
        'flex flex-col justify-center items-center h-[160px] w-[220px] gap-2 rounded-2xl transition-all duration-200 cursor-pointer',
        isSpeaking ? 'bg-emerald-500/10 ring-2 ring-emerald-400/50' : 'bg-secondary/50 hover:bg-secondary/70',
        isSelf ? 'ring-1 ring-primary/20' : '',
        compact ? 'p-2' : 'p-2',
      )}
    >
      <div className="relative">
        <div
          className={cn(
            'rounded-full overflow-hidden transition-all duration-300',
            isSpeaking ? 'ring-3 ring-emerald-400 ring-offset-2 ring-offset-background' : '',
            compact ? 'w-12 h-12' : 'w-16 h-16',
          )}
        >
          {profile?.picture ? (
            <img src={profile.picture} alt={name} className="w-full h-full object-cover" />
          ) : (
            <div className={cn(
              'w-full h-full bg-primary flex items-center justify-center text-primary-foreground font-bold',
              compact ? 'text-sm' : 'text-lg',
            )}>
              {name.slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>

        {/* Muted badge */}
        {isMuted && (
          <div className="absolute -bottom-1 -right-1 bg-red-500 rounded-full p-1">
            <MicOff size={compact ? 8 : 10} className="text-white" />
          </div>
        )}
        {isDeafened && !isMuted && (
          <div className="absolute -bottom-1 -right-1 bg-red-500 rounded-full p-1">
            <HeadphoneOff size={compact ? 8 : 10} className="text-white" />
          </div>
        )}

        {/* Speaking pulse */}
        {isSpeaking && (
          <div className="absolute inset-0 rounded-full animate-ping bg-emerald-400/20" style={{ animationDuration: '1.5s' }} />
        )}
      </div>

      <div className="text-center min-w-0 w-full">
        <div className={cn('font-medium text-foreground truncate', compact ? 'text-xs' : 'text-sm')}>
          {isSelf ? `${name} (You)` : name}
        </div>
        {cameraHidden && onShowCamera && (
          <button
            onClick={(e) => { e.stopPropagation(); onShowCamera() }}
            className="inline-flex items-center justify-center gap-1 mx-auto mt-2 px-3 py-1.5 rounded text-xs font-medium leading-none text-primary/80 hover:text-primary bg-primary/10 hover:bg-primary/20 transition-colors cursor-pointer"
          >
            <Eye size={10} className="shrink-0" /> Show Camera
          </button>
        )}
      </div>
    </div>
  )
}

function PresenceAvatar({ pubkey, hostPubkey, availableHosts }: {
  pubkey: string
  hostPubkey?: string
  availableHosts?: ReturnType<typeof useVoiceStore.getState>['hostsByHub'][string]
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey)
  const npub = pubkey ? nip19.npubEncode(pubkey) : ''
  const name = profile?.display_name || profile?.name || truncateNpub(npub)

  // Find what host this person is on and get the host type badge
  const hostInfo = availableHosts?.find((h) => h.pubkey === hostPubkey)
  const hostProfile = hostPubkey ? getProfile(hostPubkey) : null
  const hostName = hostProfile?.display_name || hostProfile?.name || ''
  const hostBadge = hostInfo
    ? ` · ${hostInfo.providerType === 'cloudflare' ? 'CF' : 'LK'}${hostName ? ` (${hostName})` : ''}`
    : ''

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-emerald-400/30 cursor-default">
            {profile?.picture ? (
              <img src={profile.picture} alt={name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
                {name.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">{name}{hostBadge}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function HostItem({
  host,
  hub,
  isSelected,
  participantCount,
  onClick,
}: {
  host: ReturnType<typeof useVoiceStore.getState>['hostsByHub'][string][0]
  hub: ReturnType<typeof useHubStore.getState>['hubs'][string]
  isSelected: boolean
  participantCount: number
  onClick: () => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(host.pubkey)
  const npub = host.pubkey ? nip19.npubEncode(host.pubkey) : ''
  const name = profile?.display_name || profile?.name || truncateNpub(npub)

  // Epoch mismatch detection
  const expectedEpoch = host.groupId
    ? hub.groupedRoles?.find((g) => g.groupId === host.groupId)?.epoch ?? hub.epoch
    : hub.epoch
  const isStale = host.epoch < expectedEpoch

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors cursor-pointer w-full',
        isSelected
          ? 'bg-emerald-500/10 ring-1 ring-emerald-500/30'
          : 'bg-secondary/50 hover:bg-secondary/80',
      )}
    >
      <div className="w-5 h-5 rounded-full overflow-hidden shrink-0">
        {profile?.picture ? (
          <img src={profile.picture} alt={name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-primary flex items-center justify-center text-primary-foreground text-[8px] font-bold">
            {name.slice(0, 2).toUpperCase()}
          </div>
        )}
      </div>
      <span className="text-foreground/80 truncate flex-1 text-left">{name}</span>
      {participantCount > 0 && (
        <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full font-medium shrink-0">
          {participantCount}
        </span>
      )}
      <span className="flex items-center gap-1 text-muted-foreground shrink-0">
        {host.providerType === 'cloudflare' ? (
          <Globe size={10} className="text-orange-400" />
        ) : (
          <Server size={10} className="text-blue-400" />
        )}
        <span className="text-[10px]">{host.providerType === 'cloudflare' ? 'CF' : 'LK'}</span>
      </span>
      {isStale && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle size={12} className="text-amber-400 shrink-0" />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-[220px]">
              Credentials were published before the last key rotation — they may be compromised
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </button>
  )
}

function VoiceActionButton({
  icon: Icon,
  label,
  active = false,
  danger = false,
  disabled = false,
  spinning = false,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  spinning?: boolean
  onClick: () => void
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            className={`
              p-3 rounded-full transition-all duration-200
              ${disabled
                ? 'opacity-50 cursor-not-allowed'
                : 'cursor-pointer'
              }
              ${danger
                ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400'
                : active
                  ? 'bg-secondary hover:bg-secondary/80 text-foreground'
                  : 'bg-secondary/50 hover:bg-secondary/70 text-muted-foreground'
              }
            `}
          >
            <Icon size={20} className={spinning ? 'animate-spin' : ''} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
