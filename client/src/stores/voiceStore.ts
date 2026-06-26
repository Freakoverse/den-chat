/**
 * voiceStore — Zustand store for hub voice channels
 *
 * Manages:
 * - Voice connection state (which channel, which provider)
 * - Local media (mic, camera, screen share)
 * - Remote participants (from SFU)
 * - Voice host pool (kind 36946 subscriptions)
 * - Voice presence (kind 36947 heartbeats)
 * - Spatial audio state (position, sphere radius)
 */

import { create } from 'zustand'
import { useUserStore } from '@/stores/userStore'
import { KINDS } from '@/lib/crypto/constants'
import {
  createUnsignedEvent,
  signWithSigner,
} from '@/lib/nostr'
import {
  publishToSpecificRelays,
  subscribeToRelays,
} from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { CloudflareProvider } from '@/lib/voice/cloudflare-provider'
import { LiveKitProvider } from '@/lib/voice/livekit-provider'
import { SpatialAudioEngine } from '@/lib/voice/spatial-engine'
import { deriveE2EEKey, supportsE2EE, cleanupE2EEWorkers } from '@/lib/voice/e2ee-crypto'
import { registerGlobalPtt, unregisterGlobalPtt } from '@/lib/voice/globalPtt'
import { playSoundEffect } from '@/lib/voice/soundEffects'
import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceHost,
  VoicePresence,
  VoiceParticipant,
  RemoteTrack,
  TrackKind,
  ConnectionState,
  VoiceProviderType,
} from '@/lib/voice/types'
import {
  SPATIAL_DEFAULTS,
  PRESENCE_CONSTANTS,
} from '@/lib/voice/types'
import type { DataChannelMessage } from '@/lib/voice/types'
import type { Event, Filter } from 'nostr-tools'
import { getCameraDeviceId, getScreenShareQuality } from '@/components/settings/SettingsPage'

/* ─── Types ─── */

interface VoiceStoreState {
  // Connection
  connectionState: ConnectionState
  currentChannelId: string | null
  currentHubDTag: string | null
  currentSessionId: string | null
  currentHostPubkey: string | null
  provider: VoiceProvider | null

  // Local media
  isMuted: boolean
  isDeafened: boolean
  isVideoEnabled: boolean
  isScreenSharing: boolean

  // Local video tracks for UI preview
  localAudioTrack: MediaStreamTrack | null  // raw mic track for speaking detection (cloned by UI)
  localVideoTrack: MediaStreamTrack | null
  localScreenTrack: MediaStreamTrack | null

  // Remote participants (live from SFU)
  participants: Record<string, VoiceParticipant>
  remoteTracks: Record<string, RemoteTrack[]>
  activeSpeakers: string[]

  // Spatial
  spatialEnabled: boolean
  spatial3DEnabled: boolean
  spatialPanelOpen: boolean
  virtualSpaceOpen: boolean   // 3D "virtual space" (FPS) view open (PC only)
  myPosition: { x: number; y: number }
  myHeading: number  // radians, 0 = up/north
  myElevation: number  // height (world units) → audio Y. 0 in 2D mode.
  myPitch: number      // radians, vertical look. 0 in 2D mode.
  mySphereRadius: number
  myConePercent: number  // 0 = full circle, 100 = tight cone
  _spatialEngine: SpatialAudioEngine | null

  // Host pool (from kind 36946 events)
  hostsByHub: Record<string, VoiceHost[]>

  // Presence (from kind 36947 events, for sidebar display)
  presenceByHub: Record<string, VoicePresence[]>

  // Timing
  joinedAt: number | null

  // Subscriptions
  _hostSubs: Record<string, { close: () => void }>
  _presenceSubs: Record<string, { close: () => void }>
  _keepaliveInterval: ReturnType<typeof setInterval> | null   // Nostr keepalive (45s)
  _stateBroadcastInterval: ReturnType<typeof setInterval> | null  // DC state broadcast (100ms)
  _vadCleanup: (() => void) | null   // Voice activity detection gate cleanup
  _isSpeaking: boolean  // local VAD speaking state — broadcast via DataChannel
  // Maps remote sessionId → pubkey (resolved when subscribing DC)
  _dcSessionToPubkey: Record<string, string>
  // Heartbeat: last time we received a DC state message from each participant
  _dcLastSeen: Record<string, number>
  _heartbeatInterval: ReturnType<typeof setInterval> | null
  _micGainNode: GainNode | null  // Live-adjustable mic gain node
  // Mic pipeline handles — kept so setInputDevice can hot-swap the source mid-call
  _vadCtx: AudioContext | null
  _micSource: MediaStreamAudioSourceNode | null
  _micAnalyser: AnalyserNode | null
  _micPostSourceNode: AudioNode | null  // first node the source feeds (rnnoise or mic-gain)

  /** Whether to show the chat view overlay on the voice channel */
  voiceChatMode: boolean

  /** Whether the current call has E2EE enabled */
  isE2EE: boolean

  // Stream opt-in/out (keyed by participant pubkey)
  /** Screen shares the local user opted INTO watching (default: not watching) */
  _screenWatching: Set<string>
  /** Cameras the local user opted OUT of receiving (default: watching) */
  _cameraHidden: Set<string>

  // ── Actions ──

  /** Join a voice channel */
  joinChannel: (
    hubDTag: string,
    channelId: string,
    hostConfig: VoiceProviderConfig,
    hostPubkey: string,
    identity: string,
    hubSecret?: string,
  ) => Promise<void>

  /** Switch to a different host in the current channel (disconnects current, rejoins) */
  switchHost: (hostPubkey: string) => Promise<void>

  /** Leave the current voice channel */
  leaveChannel: (
    relays: string[],
    signer: any,
    privateKey: string | null,
  ) => Promise<void>

  /** Toggle mute (works before joining a call too) */
  toggleMute: () => void

  /** Toggle deafen — mutes all remote audio (works before joining a call too) */
  toggleDeafen: () => void

  /** Toggle video */
  toggleVideo: () => Promise<void>

  /** Toggle screen share */
  toggleScreenShare: () => Promise<void>

  /** Toggle spatial panel */
  toggleSpatialPanel: () => void
  /** Toggle the 3D virtual-space (FPS) view. Enables spatial audio while open. */
  toggleVirtualSpace: () => void

  /** Toggle voice chat mode (show chat overlay in voice channel) */
  toggleVoiceChatMode: () => void
  setVoiceChatMode: (value: boolean) => void

  /** Update mic gain live (0.5-3.0) — works mid-call */
  updateMicGain: (gain: number) => void

  /** Set audio output device for remote audio playback (live, mid-call) */
  setOutputDevice: (deviceId: string) => Promise<void>
  setInputDevice: (deviceId: string) => Promise<void>

  /** Update spatial position */
  updatePosition: (x: number, y: number) => void

  /** Update heading (radians, 0 = up/north) */
  updateHeading: (heading: number) => void
  /** Update local height (3D mode); feeds the spatial engine's Y axis */
  updateElevation: (elevation: number) => void
  /** Update local vertical look (3D mode); tilts the spatial listener */
  updatePitch: (pitch: number) => void

  /** Toggle 3D spatial audio (HRTF) vs scalar fallback */
  toggle3DAudio: () => void

  /** Update sphere radius */
  updateSphereRadius: (radius: number) => void

  /** Update hearing cone percent (0 = full circle, 100 = tight cone) */
  updateConePercent: (percent: number) => void

  /** Subscribe to voice host events for a hub */
  subscribeHosts: (hubDTag: string, relays: string[], hubSecret?: string, groupIds?: string[]) => void

  /** Unsubscribe from voice host events */
  unsubscribeHosts: (hubDTag: string) => void

  /** Force-refresh hosts — clears cached hosts and re-subscribes */
  refreshHosts: (hubDTag: string, relays: string[], hubSecret?: string, groupIds?: string[]) => void

  /** Subscribe to voice presence events (kind 36947) for a hub */
  subscribePresence: (hubDTag: string, relays: string[]) => void

  /** Unsubscribe from voice presence events */
  unsubscribePresence: (hubDTag: string) => void

  /** Get active participants in a specific voice channel (for sidebar) */
  getChannelPresence: (hubDTag: string, channelId: string) => VoicePresence[]

  /** Get available hosts for a hub, optionally filtered by group scope */
  getAvailableHosts: (hubDTag: string, groupId?: string) => VoiceHost[]

  /** Publish voice host availability event (kind 36946) */
  publishHostAvailability: (
    hubDTag: string,
    config: VoiceProviderConfig,
    status: 'available' | 'paused',
    epoch: number,
    secret: string,
    relays: string[],
    signer: any,
    privateKey: string | null,
    groupId?: string,
  ) => Promise<void>

  /** Start DataChannel state broadcasting + Nostr keepalive */
  _startStateBroadcast: () => void

  /** Start Nostr keepalive (minimal event every 45s for sidebar staleness) */
  _startKeepalive: (
    hubDTag: string,
    channelId: string,
    hostPubkey: string,
    sessionId: string,
    relays: string[],
    signer: any,
    privateKey: string | null,
  ) => void

  /** Stop broadcasting and keepalive */
  _stopBroadcast: () => void

  /** Immediately send current state via DataChannel (for track change notifications) */
  _broadcastStateNow: () => void

  /** Subscribe to a remote participant's DataChannel */
  _subscribeParticipantDC: (pubkey: string, sessionId: string) => void

  /** Watch a participant's screen share (pulls the track, starts receiving data) */
  watchScreenShare: (pubkey: string) => void
  /** Stop watching a participant's screen share (closes the track, stops bandwidth) */
  unwatchScreenShare: (pubkey: string) => void
  /** Show a participant's camera (pulls the track if needed) */
  showCamera: (pubkey: string) => void
  /** Hide a participant's camera (closes the track, stops bandwidth) */
  hideCamera: (pubkey: string) => void
}

/* ─── Helpers ─── */

function parseVoiceHost(event: Event, decryptContent?: (content: string) => Promise<string>): VoiceHost | null {
  try {
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
    const status = (event.tags.find((t) => t[0] === 'status')?.[1] || 'available') as 'available' | 'paused'
    const providerType = (event.tags.find((t) => t[0] === 'provider')?.[1] || 'cloudflare') as VoiceProviderType
    const epochTag = event.tags.find((t) => t[0] === 'epoch')?.[1]
    const epoch = epochTag ? parseInt(epochTag, 10) : 0
    const groupId = event.tags.find((t) => t[0] === 'group')?.[1]

    if (!dTag) return null

    // For group-scoped events, the d tag is "hubDTag:groupId" — extract the hub part
    const hubDTag = groupId && dTag.includes(':') ? dTag.split(':')[0] : dTag

    // Config starts as stub — async decryption fills it in later
    const config: VoiceProviderConfig = { provider: providerType } as any

    return {
      pubkey: event.pubkey,
      hubDTag,
      status,
      providerType,
      config,
      epoch,
      createdAt: event.created_at,
      groupId,
      encryptedContent: event.content || undefined,
    }
  } catch {
    return null
  }
}

/** Try to decrypt a voice host event's content and return the parsed config */
export async function decryptHostConfig(
  content: string,
  hubSecret: string,
  eventEpoch: number,
): Promise<VoiceProviderConfig | null> {
  try {
    const { deriveKey } = await import('@/lib/crypto/hkdf')
    const { aesDecrypt } = await import('@/lib/crypto/aes')
    const secretBytes = new Uint8Array(hubSecret.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
    const derivedKey = deriveKey(secretBytes, `voice-host:epoch:${eventEpoch}`)
    const decrypted = await aesDecrypt(derivedKey, content)
    return JSON.parse(decrypted)
  } catch {
    return null
  }
}

function parseVoicePresence(event: Event): VoicePresence | null {
  try {
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
    const channelId = event.tags.find((t) => t[0] === 'c')?.[1]
    const status = (event.tags.find((t) => t[0] === 'status')?.[1] || 'joined') as 'joined' | 'left'
    const hostPubkey = event.tags.find((t) => t[0] === 'host')?.[1] || ''
    const sessionId = event.tags.find((t) => t[0] === 'session')?.[1] || ''
    const posTag = event.tags.find((t) => t[0] === 'pos')
    const sphereTag = event.tags.find((t) => t[0] === 'sphere')
    const tracksTag = event.tags.find((t) => t[0] === 'tracks')
    const tracks = tracksTag ? tracksTag.slice(1) : []

    if (!dTag || !channelId) return null

    const headingTag = event.tags.find((t) => t[0] === 'heading')
    const elevationTag = event.tags.find((t) => t[0] === 'elevation')
    const pitchTag = event.tags.find((t) => t[0] === 'pitch')

    return {
      pubkey: event.pubkey,
      hubDTag: dTag,
      channelId,
      status,
      hostPubkey,
      sessionId,
      position: {
        x: posTag ? parseFloat(posTag[1]) || 0 : 0,
        y: posTag ? parseFloat(posTag[2]) || 0 : 0,
      },
      heading: headingTag ? parseFloat(headingTag[1]) || 0 : 0,
      elevation: elevationTag ? parseFloat(elevationTag[1]) || 0 : 0,
      pitch: pitchTag ? parseFloat(pitchTag[1]) || 0 : 0,
      sphereRadius: sphereTag ? parseFloat(sphereTag[1]) || SPATIAL_DEFAULTS.DEFAULT_SPHERE_RADIUS : SPATIAL_DEFAULTS.DEFAULT_SPHERE_RADIUS,
      cone: 0,  // Nostr presence doesn't broadcast cone — defaults to full circle
      tracks,
      createdAt: event.created_at,
    }
  } catch {
    return null
  }
}

function isPresenceStale(presence: VoicePresence): boolean {
  const now = Math.floor(Date.now() / 1000)
  return (now - presence.createdAt) > (PRESENCE_CONSTANTS.STALE_TIMEOUT_MS / 1000)
}

/* ─── Store ─── */

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  // Initial state
  connectionState: 'disconnected',
  currentChannelId: null,
  currentHubDTag: null,
  currentSessionId: null,
  currentHostPubkey: null,
  provider: null,

  isMuted: false,
  isDeafened: false,
  isVideoEnabled: false,
  isScreenSharing: false,
  localAudioTrack: null,
  localVideoTrack: null,
  localScreenTrack: null,

  participants: {},
  remoteTracks: {},
  activeSpeakers: [],

  spatialEnabled: false,
  spatial3DEnabled: true,
  spatialPanelOpen: false,
  myPosition: { ...SPATIAL_DEFAULTS.SPAWN_POSITION },
  myHeading: 0,
  myElevation: 0,
  myPitch: 0,
  mySphereRadius: SPATIAL_DEFAULTS.DEFAULT_SPHERE_RADIUS,
  myConePercent: 0,
  _spatialEngine: null,

  hostsByHub: {},
  presenceByHub: {},

  joinedAt: null,

  _hostSubs: {},
  _presenceSubs: {},
  _keepaliveInterval: null,
  _stateBroadcastInterval: null,
  _isSpeaking: false,
  _vadCleanup: null,
  _dcSessionToPubkey: {},
  _dcLastSeen: {},
  _heartbeatInterval: null,
  _micGainNode: null,
  _vadCtx: null,
  _micSource: null,
  _micAnalyser: null,
  _micPostSourceNode: null,
  voiceChatMode: false,
  isE2EE: false,
  _screenWatching: new Set<string>(),
  _cameraHidden: new Set<string>(),
  _joinInProgress: false,

  // ── Actions ──

  joinChannel: async (hubDTag, channelId, hostConfig, hostPubkey, identity, hubSecret) => {
    // Prevent joining while mid-disconnect (race condition)
    const current = get()
    if (current.connectionState === 'disconnecting') {
      console.warn('[VoiceStore] Cannot join while disconnecting — wait for disconnect to finish')
      return
    }
    if (current.provider) {
      // Send "left" via DataChannel (instant notification to in-call peers)
      try { current.provider.sendData({ type: 'left' }) } catch { }

      // Publish "left" Nostr event for external sidebar cleanup
      const { currentHubDTag: oldHub, currentChannelId: oldChannel } = current
      if (oldHub && oldChannel) {
        const userState = useUserStore.getState()
        const effectiveSigner = userState.signer
        const effectivePrivateKey = userState.privateKey
        if (effectiveSigner || effectivePrivateKey) {
          try {
            const leftTags: [string, ...string[]][] = [
              ['d', oldHub],
              ['c', oldChannel],
              ['status', 'left'],
              ['host', ''],
              ['session', ''],
            ]
            const unsigned = createUnsignedEvent(KINDS.VOICE_PRESENCE, '', leftTags)
            const signed = await signWithSigner(unsigned, effectiveSigner, effectivePrivateKey)
            // Determine relays for the old hub
            const hubStore = (await import('@/stores/hubStore')).useHubStore.getState()
            const oldHubData = hubStore.hubs[oldHub]
            const oldRelays = oldHubData
              ? [...new Set([...oldHubData.generalRelays, ...oldHubData.filterRelays])].filter(Boolean)
              : []
            if (oldRelays.length > 0) {
              await publishToSpecificRelays(getPublishRelays(oldRelays), signed)
            } else {
              await publishToSpecificRelays(getPublishRelays(), signed)
            }
            console.log('[VoiceStore] Published "left" for old channel before switching')
          } catch (err) {
            console.warn('[VoiceStore] Failed to publish leave for old channel:', err)
          }
        }
      }

      // Stop broadcast intervals
      get()._stopBroadcast()

      // Stop VAD gate
      const vadCleanup = get()._vadCleanup
      if (vadCleanup) { vadCleanup(); set({ _vadCleanup: null }) }

      // Stop spatial engine
      const spatialEngine = get()._spatialEngine
      if (spatialEngine) spatialEngine.destroy()

      // Stop local video/screen tracks so hardware is released
      const localVideoTrack = get().localVideoTrack
      const localScreenTrack = get().localScreenTrack
      if (localScreenTrack) {
        localScreenTrack.onended = null
        localScreenTrack.stop()
      }
      if (localVideoTrack) {
        localVideoTrack.stop()
      }

      // Disconnect old provider
      await current.provider.disconnect()

      // Terminate old E2EE Workers
      cleanupE2EEWorkers()

      // Purge own presence from old hub (same fix as leaveChannel)
      const myPubkey = useUserStore.getState().pubkey
      if (myPubkey && oldHub) {
        set((s) => {
          const entries = s.presenceByHub[oldHub] || []
          const filtered = entries.filter((p) => p.pubkey !== myPubkey)
          return { presenceByHub: { ...s.presenceByHub, [oldHub]: filtered } }
        })
      }
    }

    // Set connecting state immediately for instant UI feedback
    // Clear participants and remoteTracks from any stale session to prevent
    // duplicate tiles when the same participants rejoin the new session.
    set({
      connectionState: 'connecting',
      currentChannelId: channelId,
      currentHubDTag: hubDTag,
      currentHostPubkey: hostPubkey,
      participants: {},
      remoteTracks: {},
      activeSpeakers: [],
      isVideoEnabled: false,
      isScreenSharing: false,
      localVideoTrack: null,
      localScreenTrack: null,
      _joinInProgress: true,
    })

    // Create provider based on config type
    let provider: VoiceProvider
    if (hostConfig.provider === 'cloudflare') {
      provider = new CloudflareProvider(hostConfig)
    } else {
      provider = new LiveKitProvider(hostConfig)
    }

    // Apply saved output device so incoming audio tracks use the right speaker
    try {
      const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
      if (vs.outputDeviceId) {
        await provider.setOutputDevice(vs.outputDeviceId)
      }
    } catch { }

    // ── E2EE: derive key from hub secret and set on provider ──
    let e2eeEnabled = false
    if (hubSecret && supportsE2EE()) {
      try {
        const hubStore = await import('@/stores/hubStore')
        const hub = hubStore.useHubStore.getState().hubs[hubDTag]
        const epoch = hub?.epoch || 0
        const secretBytes = new Uint8Array(hubSecret.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
        const { cryptoKey, rawKeyBytes } = await deriveE2EEKey(secretBytes, epoch)
        provider.setEncryptionKey(cryptoKey, rawKeyBytes)
        e2eeEnabled = true
        console.log(`[VoiceStore] E2EE enabled — epoch ${epoch}`)
      } catch (err) {
        console.warn('[VoiceStore] Failed to derive E2EE key:', err)
      }
    } else if (!supportsE2EE()) {
      console.log('[VoiceStore] E2EE not supported by this browser')
    }

    // Wire up callbacks
    provider.setCallbacks({
      onParticipantJoined: (p) => {
        set((s) => ({
          participants: { ...s.participants, [p.id]: p },
        }))
      },
      onParticipantLeft: (id) => {
        set((s) => {
          const { [id]: _, ...rest } = s.participants
          const { [id]: __, ...restTracks } = s.remoteTracks
          return { participants: rest, remoteTracks: restTracks }
        })
      },
      onTrackSubscribed: (track) => {
        console.log(`[VoiceStore] onTrackSubscribed: ${track.participantId.slice(0, 8)}...:${track.kind}, readyState=${track.track.readyState}`)
        set((s) => {
          const existing = s.remoteTracks[track.participantId] || []
          return {
            remoteTracks: {
              ...s.remoteTracks,
              [track.participantId]: [...existing, track],
            },
          }
        })
        // Apply saved per-user volume from localStorage
        if (track.kind === 'audio') {
          try {
            const raw = localStorage.getItem('den-chat-user-volumes')
            if (raw) {
              const map = JSON.parse(raw)
              const savedVolume = map[track.participantId]
              if (typeof savedVolume === 'number' && savedVolume !== 100) {
                const p = get().provider
                if (p) p.setParticipantVolume(track.participantId, savedVolume / 100)
              }
            }
          } catch { /* ignore */ }

          // Apply deafen state — re-apply to all (including newly added track)
          if (get().isDeafened) {
            const p = get().provider
            if (p) p.setDeafened(true)
          }

          // Connect to spatial audio if engine is active (both 3D and scalar modes)
          const { _spatialEngine } = get()
          if (_spatialEngine) {
            // Register participant in the engine's map so scalar ticks see them
            _spatialEngine.updateParticipant({
              id: track.participantId,
              position: { x: 250, y: 250 },  // default until DC state arrives
              heading: 0,
            })
            // In 3D mode, also connect audio to the Web Audio graph
            if (_spatialEngine.get3DEnabled()) {
              // Small delay to ensure audio element is created by the provider
              setTimeout(() => {
                _spatialEngine.connectParticipantAudio(track.participantId)
              }, 100)
            }
          }
        }
      },
      onTrackUnsubscribed: (participantId, kind) => {
        set((s) => {
          const existing = (s.remoteTracks[participantId] || [])
            .filter((t) => t.kind !== kind)
          return {
            remoteTracks: {
              ...s.remoteTracks,
              [participantId]: existing,
            },
          }
        })
      },
      onConnectionStateChanged: (state) => {
        // During the join flow, suppress backward state transitions from the SDK.
        // The SDK may fire rapid connected→disconnected→connected events during
        // initial negotiation, which causes the UI to flash. Only allow 'connected'
        // through; the final state is set explicitly after mic setup completes.
        if ((get() as any)._joinInProgress && state !== 'connected') {
          console.log(`[VoiceStore] Suppressing '${state}' during join flow`)
          return
        }
        // Smooth transient fluctuations so a brief connection blip doesn't flap the
        // UI "in and out" of the call. 'connected' applies immediately and cancels any
        // pending downgrade; a downgrade (reconnecting/disconnected/failed) is held for
        // a short grace and only applied if it persists — if 'connected' returns within
        // the grace, the user never sees a flicker, and the audio (which usually keeps
        // flowing through brief ICE blips) is uninterrupted.
        const prevTimer = (get() as any)._connDowngradeTimer as ReturnType<typeof setTimeout> | null
        if (prevTimer) clearTimeout(prevTimer)
        if (state === 'connected') {
          set({ connectionState: 'connected', _connDowngradeTimer: null } as any)
          return
        }
        const timer = setTimeout(() => {
          // Don't surface a stale downgrade after the call has been torn down.
          if (!get().provider) { set({ _connDowngradeTimer: null } as any); return }
          set({ connectionState: state, _connDowngradeTimer: null } as any)
        }, 2000)
        set({ _connDowngradeTimer: timer } as any)
      },
      onActiveSpeakerChanged: (ids) => {
        set({ activeSpeakers: ids })
      },
      onDataMessage: (senderIdentity: string, data: DataChannelMessage) => {
        // Resolve sender pubkey from sessionId→pubkey map or identity directly
        const dcMap = get()._dcSessionToPubkey
        const senderPubkey = dcMap[senderIdentity] || senderIdentity

        // Never treat our own (possibly ghost/duplicate) session as a remote
        // participant — that is what produced runaway self-cards on rejoin.
        if (senderPubkey === useUserStore.getState().pubkey) return

        if (data.type === 'state') {
          // Update heartbeat timestamp for this participant
          set((s) => ({ _dcLastSeen: { ...s._dcLastSeen, [senderPubkey]: Date.now() } }))

          // Update presence with real-time position/sphere/tracks from DC
          const { currentHubDTag, currentChannelId, _spatialEngine } = get()
          if (!currentHubDTag || !currentChannelId) return

          // Update spatial engine with remote position + heading
          if (_spatialEngine) {
            _spatialEngine.updateParticipant({
              id: senderPubkey,
              position: data.pos,
              heading: data.heading ?? 0,
              elevation: data.elevation ?? 0,
              pitch: data.pitch ?? 0,
            })
          }

          // Update presenceByHub for the spatial panel to read
          set((s) => {
            const existing = s.presenceByHub[currentHubDTag] || []
            const idx = existing.findIndex((p) => p.pubkey === senderPubkey)
            const updatedPresence: VoicePresence = {
              pubkey: senderPubkey,
              hubDTag: currentHubDTag,
              channelId: currentChannelId,
              status: 'joined',
              hostPubkey: s.currentHostPubkey || '',
              sessionId: senderIdentity,
              position: data.pos,
              heading: data.heading ?? 0,
              elevation: data.elevation ?? 0,
              pitch: data.pitch ?? 0,
              sphereRadius: data.sphere,
              tracks: data.tracks,
              createdAt: Math.floor(Date.now() / 1000),  // always fresh
              cone: data.cone ?? 0,
            }
            let updated: VoicePresence[]
            if (idx >= 0) {
              updated = [...existing]
              updated[idx] = updatedPresence
            } else {
              updated = [...existing, updatedPresence]
            }
            return { presenceByHub: { ...s.presenceByHub, [currentHubDTag]: updated } }
          })

          // Auto-pull new tracks if we detect track changes from DC
          const state = get()
          if (state.provider && state.connectionState === 'connected') {
            const sessionId = senderIdentity
            if (sessionId && sessionId !== state.currentSessionId) {
              const existingParticipant = state.participants[senderPubkey]
              const incomingTrackKinds = data.tracks as string[]   // e.g. ['audio', 'video']
              const trackNames = incomingTrackKinds.map(k => `${senderPubkey}:${k}`)

              if (!existingParticipant) {
                // Play join sound for remote participant
                playSoundEffect('join')
                // New participant — pull tracks (but respect opt-in/out)
                // Filter out screenshare unless opted in, camera if hidden
                const filteredTrackNames = trackNames.filter(t => {
                  if (t.endsWith(':screenshare')) return state._screenWatching.has(senderPubkey)
                  if (t.endsWith(':video')) return !state._cameraHidden.has(senderPubkey)
                  return true // always pull audio
                })
                if (filteredTrackNames.length > 0) {
                  console.log(`[VoiceStore] DC: Pulling tracks from new participant ${senderPubkey.slice(0, 8)}...`)
                  state.provider.pullRemoteTracks(sessionId, filteredTrackNames).catch((err) => {
                    console.warn('[VoiceStore] DC: Failed to pull tracks:', err)
                  })
                }
                set((s) => ({
                  participants: {
                    ...s.participants,
                    [senderPubkey]: {
                      id: senderPubkey,
                      pubkey: senderPubkey,
                      isMuted: data.muted ?? false,
                      isDeafened: data.deafened ?? false,
                      isSpeaking: data.speaking ?? false,
                      hasVideo: incomingTrackKinds.includes('video'),
                      hasScreenShare: incomingTrackKinds.includes('screenshare'),
                      hasSpatial: data.spatial ?? false,
                      hasVspace: data.vspace ?? false,
                    },
                  },
                }))

                // If spatial engine is active in 3D mode, try connecting audio now
                // (audio element may already exist from onTrackSubscribed)
                const engine3D = get()._spatialEngine
                if (engine3D && engine3D.get3DEnabled()) {
                  setTimeout(() => {
                    engine3D.connectParticipantAudio(senderPubkey)
                  }, 150)
                }
              } else {
                // Existing participant — detect new/removed tracks
                const hadVideo = existingParticipant.hasVideo
                const hadScreen = existingParticipant.hasScreenShare
                const nowHasVideo = incomingTrackKinds.includes('video')
                const nowHasScreen = incomingTrackKinds.includes('screenshare')

                // Pull newly added tracks (first time only) — respect opt-in/out
                const newKinds: string[] = []
                if (nowHasVideo && !hadVideo && !state._cameraHidden.has(senderPubkey)) newKinds.push(`${senderPubkey}:video`)
                if (nowHasScreen && !hadScreen && state._screenWatching.has(senderPubkey)) newKinds.push(`${senderPubkey}:screenshare`)
                if (newKinds.length > 0) {
                  // pullRemoteTracks dedup-filters already-pulled tracks, so calling
                  // this on a "resumed" track is a harmless no-op.
                  console.log(`[VoiceStore] DC: Pulling NEW tracks from ${senderPubkey.slice(0, 8)}:`, newKinds)
                  state.provider.pullRemoteTracks(sessionId, newKinds).catch((err) => {
                    console.warn('[VoiceStore] DC: Failed to pull new tracks:', err)
                  })
                }

                // NOTE: When video/screenshare is toggled off, we do NOT remove the
                // RemoteTrack from remoteTracks. The sender uses replaceTrack(null)
                // which keeps the transceiver alive. When the sender resumes, the
                // receiver's track automatically gets new frames. We only toggle the
                // hasVideo/hasScreenShare flags for UI visibility.

                // Update participant state if track availability changed
                const nowSpeaking = data.speaking ?? false
                if (hadVideo !== nowHasVideo || hadScreen !== nowHasScreen || existingParticipant.isMuted !== (data.muted ?? false) || existingParticipant.isDeafened !== (data.deafened ?? false) || existingParticipant.hasSpatial !== (data.spatial ?? false) || existingParticipant.hasVspace !== (data.vspace ?? false) || existingParticipant.isSpeaking !== nowSpeaking) {
                  set((s) => ({
                    participants: {
                      ...s.participants,
                      [senderPubkey]: {
                        ...s.participants[senderPubkey],
                        hasVideo: nowHasVideo,
                        hasScreenShare: nowHasScreen,
                        isMuted: data.muted ?? false,
                        isDeafened: data.deafened ?? false,
                        hasSpatial: data.spatial ?? false,
                        hasVspace: data.vspace ?? false,
                        isSpeaking: nowSpeaking,
                      },
                    },
                  }))
                }
              }
            }
          }
        } else if (data.type === 'left') {
          // Remote participant left via DataChannel
          const state = get()
          if (state.participants[senderPubkey]) {
            // Play leave sound for remote participant
            playSoundEffect('leave')
            console.log(`[VoiceStore] DC: Participant left: ${senderPubkey.slice(0, 8)}...`)
            const engine = state._spatialEngine
            if (engine) engine.removeParticipant(senderPubkey)
            set((s) => {
              const { [senderPubkey]: _, ...restParticipants } = s.participants
              const { [senderPubkey]: __, ...restTracks } = s.remoteTracks

              // Also remove from presenceByHub so the sidebar updates immediately
              const updatedPresences: Record<string, VoicePresence[]> = {}
              for (const [key, presences] of Object.entries(s.presenceByHub)) {
                updatedPresences[key] = presences.filter((p) => p.pubkey !== senderPubkey)
              }

              return {
                participants: restParticipants,
                remoteTracks: restTracks,
                presenceByHub: updatedPresences,
              }
            })
          }
        }
      },
    })

    // Connect
    const roomName = `${hubDTag}:${channelId}`
    try {
      await provider.connect(roomName, identity)
    } catch (err) {
      console.error('[VoiceStore] Provider connect failed:', err)
      cleanupE2EEWorkers()
      set({
        provider: null,
        connectionState: 'disconnected',
        currentChannelId: null,
        currentHubDTag: null,
        currentHostPubkey: null,
        isE2EE: false,
        _joinInProgress: false,
      })
      throw err
    }

    // Store E2EE state
    set({ isE2EE: e2eeEnabled })

    // Get mic and publish audio with Voice Activity Detection
    // Uses AudioContext pipeline:
    //   off/basic:  Mic → source → analyser + gateNode → destination → SFU
    //   rnnoise:    Mic → source → analyser + rnnoiseNode → gateNode → destination → SFU
    try {
      let audioConstraints: MediaStreamConstraints['audio'] = true
      let noiseMode: 'off' | 'basic' | 'rnnoise' = 'basic'
      try {
        const voiceSettings = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}'
        )
        if (voiceSettings.inputDeviceId) {
          audioConstraints = { deviceId: { exact: voiceSettings.inputDeviceId } }
        }
        // Read noise suppression mode (migrate old boolean format)
        if (typeof voiceSettings.noiseCancellation === 'boolean') {
          noiseMode = voiceSettings.noiseCancellation ? 'basic' : 'off'
        } else {
          noiseMode = voiceSettings.noiseSuppression ?? 'rnnoise'
        }
        // For 'basic' mode, enable browser-level processing
        // For 'off' and 'rnnoise', disable browser processing (rnnoise does its own)
        const useBrowserNC = noiseMode === 'basic'
        audioConstraints = {
          ...(typeof audioConstraints === 'object' ? audioConstraints : {}),
          noiseSuppression: useBrowserNC,
          echoCancellation: true,  // always keep echo cancellation
          autoGainControl: useBrowserNC,
        }
      } catch { }
      // Try the configured (possibly non-default) mic; if it's gone/unavailable the
      // { exact } constraint throws, so fall back to the system default rather than
      // failing the whole join.
      let rawStream: MediaStream
      try {
        rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      } catch (err) {
        if (typeof audioConstraints === 'object' && audioConstraints && 'deviceId' in audioConstraints) {
          console.warn('[VoiceStore] Configured mic unavailable, falling back to default:', err)
          const fallback = { ...(audioConstraints as MediaTrackConstraints) }
          delete fallback.deviceId
          rawStream = await navigator.mediaDevices.getUserMedia({ audio: fallback })
        } else {
          throw err
        }
      }

      // Expose the raw mic track so the UI speaking-detection hook can clone it.
      // (Firefox blocks opening a second getUserMedia stream to the same device.)
      const rawMicTrack = rawStream.getAudioTracks()[0]
      if (rawMicTrack) set({ localAudioTrack: rawMicTrack })

      // RNNoise requires 48kHz sample rate
      const vadCtx = new AudioContext(noiseMode === 'rnnoise' ? { sampleRate: 48000 } : undefined)
      const source = vadCtx.createMediaStreamSource(rawStream)

      // Analyser reads raw mic — never affected by the gate
      const analyser = vadCtx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.85
      source.connect(analyser)

      // Determine what feeds into the gate: source directly, or via RNNoise
      let gateInput: AudioNode = source

      // Insert RNNoise AudioWorklet if selected
      if (noiseMode === 'rnnoise') {
        try {
          const { createRnnoiseNode } = await import('@/lib/voice/rnnoise')
          const rnnoiseNode = await createRnnoiseNode(vadCtx)
          source.connect(rnnoiseNode)
          gateInput = rnnoiseNode
          console.log('[VoiceStore] RNNoise noise suppression active')
        } catch (err) {
          console.warn('[VoiceStore] Failed to initialize RNNoise, falling back to no suppression:', err)
          // gateInput stays as source
        }
      }

      // Apply user mic gain (applies to all noise suppression modes)
      const micGainValue = (() => {
        try {
          const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
          return vs.micGain ?? 1.0
        } catch { return 1.0 }
      })()
      const micGainNode = vadCtx.createGain()
      micGainNode.gain.value = micGainValue
      gateInput.connect(micGainNode)
      // The node the source feeds: rnnoise (when active) else mic-gain directly.
      // Kept (with the ctx/analyser) so setInputDevice can swap the source live.
      const micPostSourceNode: AudioNode = gateInput === source ? micGainNode : gateInput
      set({
        _micGainNode: micGainNode,
        _vadCtx: vadCtx,
        _micSource: source,
        _micAnalyser: analyser,
        _micPostSourceNode: micPostSourceNode,
      })

      // Read voice mode and settings early — needed for initial gate state
      let voiceMode: 'activity' | 'alwaysOn' | 'pushToTalk' = 'activity'
      let releaseDelay = 0.3
      let pttKey = 'KeyV'
      try {
        const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
        voiceMode = vs.voiceMode ?? 'activity'
        releaseDelay = vs.releaseDelay ?? 0.3
        pttKey = vs.pushToTalkKey ?? 'KeyV'
      } catch { }
      console.log(`[VoiceStore] Voice mode: ${voiceMode}, PTT key: ${pttKey}`)

      // GainNode is the gate — gain=0 silences, gain=1 passes audio
      const gateNode = vadCtx.createGain()
      // PTT starts closed, others start open
      gateNode.gain.value = voiceMode === 'pushToTalk' ? 0 : 1
      micGainNode.connect(gateNode)

      // Create a new processed track from the gated output
      const destination = vadCtx.createMediaStreamDestination()
      // Force a MONO capture track. The pipeline upstream is mono (RNNoise is
      // maxChannels:1), and a mono signal into the default *stereo* destination
      // yields a stereo track with a silent right channel on Chromium — which
      // LiveKit's SFU preserves, so receivers hear left-ear-only (Cloudflare
      // down-mixes it so it was masked there). Mono is the correct layout for
      // voice, plays on both speakers everywhere, and is exactly what the spatial
      // PannerNode wants (a mono point source).
      destination.channelCount = 1
      destination.channelCountMode = 'explicit'
      gateNode.connect(destination)
      const processedTrack = destination.stream.getAudioTracks()[0]

      if (processedTrack) {
        await provider.publishTrack(processedTrack, 'audio')

        // Apply pre-muted state if user toggled mute before joining
        if (get().isMuted) {
          provider.setMuted('audio', true)
        }

        const vadData = new Uint8Array(analyser.frequencyBinCount)
        let vadTimerId: ReturnType<typeof setTimeout> | null = null
        let vadStopped = false
        let lastAboveThreshold = Date.now()

        const HOLD_MS = Math.round(releaseDelay * 1000)
        let consecutiveAbove = 0
        const ATTACK_FRAMES = 2
        let consecutiveBelow = 0
        const RELEASE_FRAMES = 4
        const rmsHistory = [0, 0, 0, 0]
        let rmsIdx = 0
        // For alwaysOn: gate starts open. For PTT: gate starts closed. For activity: start open.
        let gateOpen = voiceMode !== 'pushToTalk'
        let pttKeyDown = false
        const handlePTTDown = (e: KeyboardEvent) => {
          if (voiceMode !== 'pushToTalk') return
          // Re-read PTT key each time in case user changes it
          let currentPttKey = pttKey
          try {
            const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
            currentPttKey = vs.pushToTalkKey ?? 'KeyV'
          } catch { }
          if (e.code === currentPttKey && !pttKeyDown) {
            pttKeyDown = true
            gateOpen = true
          }
        }
        const handlePTTUp = (e: KeyboardEvent) => {
          if (voiceMode !== 'pushToTalk') return
          let currentPttKey = pttKey
          try {
            const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
            currentPttKey = vs.pushToTalkKey ?? 'KeyV'
          } catch { }
          if (e.code === currentPttKey) {
            pttKeyDown = false
            gateOpen = false
          }
        }
        window.addEventListener('keydown', handlePTTDown)
        window.addEventListener('keyup', handlePTTUp)

        // Register system-wide global shortcut for PTT (Tauri desktop only).
        // This allows PTT to work even when another window is focused.
        registerGlobalPtt(
          pttKey,
          () => { if (voiceMode === 'pushToTalk' && !pttKeyDown) { pttKeyDown = true; gateOpen = true } },
          () => { if (voiceMode === 'pushToTalk') { pttKeyDown = false; gateOpen = false } },
        )

        // Mute / Deafen keybind listeners (read from den-chat-keybinds)
        const handleKeybindAction = (e: KeyboardEvent) => {
          // Ignore when typing in an input/textarea
          const tag = (e.target as HTMLElement)?.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return

          try {
            const kb = JSON.parse(localStorage.getItem('den-chat-keybinds') || '{}')
            if (kb.muteToggle && e.code === kb.muteToggle) {
              e.preventDefault()
              get().toggleMute()
            } else if (kb.deafenToggle && e.code === kb.deafenToggle) {
              e.preventDefault()
              get().toggleDeafen()
            }
          } catch { /* ignore */ }
        }
        window.addEventListener('keydown', handleKeybindAction)

        // VAD tick interval — uses setTimeout chain instead of requestAnimationFrame
        // so it keeps running when the window/tab loses focus (RAF pauses on blur).
        const VAD_INTERVAL_MS = 20  // ~50Hz — fast enough for responsive gate
        // Track real elapsed time between ticks so we can detect timer throttling.
        // Browsers throttle setTimeout to ~1Hz when the window is unfocused/occluded,
        // and a de-scheduled process (e.g. on Linux) shows the same symptom.
        let lastVadTickAt = Date.now()
        const vadTick = () => {
          if (vadStopped) return

          const tickNow = Date.now()
          const tickGap = tickNow - lastVadTickAt
          lastVadTickAt = tickNow
          // If ticks arrive far slower than 20ms, responsive VAD is impossible, so we
          // fail the gate OPEN (handled in the activity branch below) to keep the voice
          // flowing cleanly instead of choppily gating it. This fixes "voice gets a lot
          // worse when another window is focused."
          const vadThrottled = tickGap > VAD_INTERVAL_MS * 6

          // Ensure AudioContext is running (browsers can suspend it in background)
          if (vadCtx.state === 'suspended') {
            vadCtx.resume().catch(() => {})
          }

          // Re-read voiceMode live so settings changes take effect
          let currentMode = voiceMode
          try {
            const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
            currentMode = vs.voiceMode ?? 'activity'
            // Update voiceMode if changed (for PTT listeners)
            if (currentMode !== voiceMode) {
              voiceMode = currentMode
              // If switched to alwaysOn, open gate
              if (currentMode === 'alwaysOn') gateOpen = true
              // If switched to PTT, close gate (until key pressed)
              if (currentMode === 'pushToTalk') { gateOpen = false; pttKeyDown = false }
            }
          } catch { }

          if (currentMode === 'activity' && !vadThrottled) {
            // Voice Activity Detection logic
            analyser.getByteTimeDomainData(vadData)
            let sum = 0
            for (let i = 0; i < vadData.length; i++) {
              const v = (vadData[i] - 128) / 128
              sum += v * v
            }
            const rawRms = Math.sqrt(sum / vadData.length) * 100

            rmsHistory[rmsIdx % 4] = rawRms
            rmsIdx++
            const rms = rmsHistory.reduce((a, b) => a + b, 0) / rmsHistory.length

            const now = Date.now()

            let threshold = 10 * 0.5 // slider default 10 → RMS 5
            let holdMs = HOLD_MS
            try {
              const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
              threshold = (vs.inputSensitivity ?? 1.5) * 0.5 // slider 0-20 → RMS 0-10
              holdMs = Math.round((vs.releaseDelay ?? 0.3) * 1000)
            } catch { }

            if (rms > threshold) {
              consecutiveAbove++
              consecutiveBelow = 0
              if (consecutiveAbove >= ATTACK_FRAMES) { gateOpen = true; lastAboveThreshold = now }
            } else {
              consecutiveBelow++
              consecutiveAbove = 0
              if (consecutiveBelow >= RELEASE_FRAMES && (now - lastAboveThreshold) >= holdMs) { gateOpen = false }
            }
          } else if (currentMode === 'alwaysOn' || (currentMode === 'activity' && vadThrottled)) {
            // alwaysOn, or activity mode while the VAD timer is throttled (window
            // unfocused/occluded) — keep the gate open so voice isn't choppily cut.
            gateOpen = true
          }
          // For 'pushToTalk', gateOpen is managed by keydown/keyup handlers

          const { isMuted: storeMuted, _isSpeaking: wasSpeaking } = get()
          const nowSpeaking = !storeMuted && gateOpen
          if (nowSpeaking !== wasSpeaking) {
            set({ _isSpeaking: nowSpeaking })
          }
          if (!storeMuted) {
            gateNode.gain.cancelScheduledValues(vadCtx.currentTime)
            gateNode.gain.setValueAtTime(gateOpen ? 1 : 0, vadCtx.currentTime)
          } else {
            gateNode.gain.cancelScheduledValues(vadCtx.currentTime)
            gateNode.gain.setValueAtTime(0, vadCtx.currentTime)
          }

          vadTimerId = setTimeout(vadTick, VAD_INTERVAL_MS)
        }
        vadTimerId = setTimeout(vadTick, VAD_INTERVAL_MS)

        // Keep AudioContext alive when tab/window loses focus.
        // Browsers may suspend AudioContext when the document is hidden.
        const handleVisibilityChange = () => {
          if (vadCtx.state === 'suspended') {
            vadCtx.resume().catch(() => {})
          }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)

        set({
          _vadCleanup: () => {
            vadStopped = true
            if (vadTimerId != null) clearTimeout(vadTimerId)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            window.removeEventListener('keydown', handlePTTDown)
            window.removeEventListener('keyup', handlePTTUp)
            window.removeEventListener('keydown', handleKeybindAction)
            unregisterGlobalPtt() // Remove system-wide PTT shortcut
            source.disconnect()
            gateNode.disconnect()
            vadCtx.close()
            rawStream.getTracks().forEach((t) => t.stop())
          },
        })
      }
    } catch (err) {
      console.warn('[VoiceStore] Could not get mic:', err)
    }

    set({
      provider,
      currentHubDTag: hubDTag,
      currentChannelId: channelId,
      currentSessionId: provider.getSessionId(),
      currentHostPubkey: hostPubkey,
      connectionState: 'connected',
      joinedAt: Date.now(),
      // Preserve pre-mute state — don't reset isMuted/isDeafened
      isVideoEnabled: false,
      isScreenSharing: false,
      myPosition: { ...SPATIAL_DEFAULTS.SPAWN_POSITION },
      myHeading: 0,
      mySphereRadius: SPATIAL_DEFAULTS.DEFAULT_SPHERE_RADIUS,
      spatialPanelOpen: false,
      virtualSpaceOpen: false,
      _joinInProgress: false,
    })

    // Play join sound for local user
    playSoundEffect('join')

    // Create our publishing DataChannel
    try {
      await provider.createDataChannel(`state-${identity}`)
      console.log('[VoiceStore] DataChannel created for state broadcasting')
    } catch (err) {
      console.warn('[VoiceStore] Failed to create DataChannel:', err)
    }

    // Start DataChannel state broadcast (100ms interval)
    get()._startStateBroadcast()

    // Pull tracks from participants who are already in the channel
    // (their Nostr presence arrived before we joined)
    const mySessionId = provider.getSessionId()
    const existingPresence = (get().presenceByHub[hubDTag] || []).filter(
      (p) =>
        p.channelId === channelId &&
        // Only people on the host we just joined — a different host is a separate
        // SFU we can't pull from (they're shown via the dimmed other-host group).
        (!p.hostPubkey || p.hostPubkey === hostPubkey) &&
        p.status === 'joined' &&
        p.sessionId &&
        p.sessionId !== mySessionId &&
        p.tracks.length > 0 &&
        !isPresenceStale(p),
    )
    for (const p of existingPresence) {
      // Filter tracks: skip screenshare (opt-in) and hidden cameras (opt-out)
      const filteredTracks = p.tracks.filter((t: string) => {
        if (t.endsWith(':screenshare')) return get()._screenWatching.has(p.pubkey)
        if (t.endsWith(':video')) return !get()._cameraHidden.has(p.pubkey)
        return true // always pull audio
      })
      if (filteredTracks.length > 0) {
        console.log(`[VoiceStore] Pulling existing participant ${p.pubkey.slice(0, 8)}... tracks:`, filteredTracks)
        provider.pullRemoteTracks(p.sessionId, filteredTracks).catch((err) => {
          console.warn('[VoiceStore] Failed to pull existing tracks:', err)
        })
      }
      // Also subscribe to their DataChannel
      get()._subscribeParticipantDC(p.pubkey, p.sessionId)
      set((s) => ({
        participants: {
          ...s.participants,
          [p.pubkey]: {
            id: p.pubkey,
            pubkey: p.pubkey,
            isMuted: false,
            isDeafened: false,
            isSpeaking: false,
            hasVideo: false,
            hasScreenShare: false,
          },
        },
      }))
    }
  },

  switchHost: async (hostPubkey) => {
    const { currentHubDTag, currentChannelId, hostsByHub, currentHostPubkey } = get()
    if (!currentHubDTag || !currentChannelId || hostPubkey === currentHostPubkey) return
    const host = (hostsByHub[currentHubDTag] || []).find((h) => h.pubkey === hostPubkey)
    if (!host || !host.config) {
      console.warn('[VoiceStore] switchHost: no decrypted config for host', hostPubkey.slice(0, 8))
      return
    }
    const myPubkey = useUserStore.getState().pubkey
    if (!myPubkey) return
    let hubSecret: string | undefined
    try {
      const hubStore = (await import('@/stores/hubStore')).useHubStore.getState()
      hubSecret = hubStore.hubSecrets?.[currentHubDTag]
    } catch { /* ignore */ }
    // Surface the connecting modal immediately — joinChannel tears down the current
    // provider before connecting to the new host, which can take a moment.
    set({ connectionState: 'connecting' })
    try {
      // joinChannel disconnects the current provider before connecting to the new host.
      await get().joinChannel(currentHubDTag, currentChannelId, host.config, hostPubkey, myPubkey, hubSecret)
    } catch (err) {
      console.error('[VoiceStore] switchHost failed:', err)
      set({ connectionState: 'failed' })
    }
  },

  leaveChannel: async (relays, signer, privateKey) => {
    // Play leave sound for local user
    playSoundEffect('leave')
    const { provider, currentHubDTag, currentChannelId } = get()

    // Send "left" via DataChannel (instant notification to in-call peers)
    if (provider) {
      try { provider.sendData({ type: 'left' }) } catch { }
    }

    // Stop DC broadcast + Nostr keepalive immediately
    get()._stopBroadcast()

    // Stop VAD gate
    const vadCleanup = get()._vadCleanup
    if (vadCleanup) { vadCleanup(); set({ _vadCleanup: null }) }

    // Stop local video/screen tracks so camera/screenshare is released
    const localVideoTrack = get().localVideoTrack
    const localScreenTrack = get().localScreenTrack
    if (localScreenTrack) {
      localScreenTrack.onended = null
      localScreenTrack.stop()
    }
    if (localVideoTrack) {
      localVideoTrack.stop()
    }

    // Stop spatial engine
    const spatialEngine = get()._spatialEngine
    if (spatialEngine) spatialEngine.destroy()

    // Disconnect provider immediately (don't wait for Nostr event)
    if (provider) {
      provider.disconnect().catch((err) =>
        console.warn('[VoiceStore] Provider disconnect error:', err)
      )
    }

    // Terminate E2EE Workers
    cleanupE2EEWorkers()

    // Fire-and-forget: publish "left" Nostr event (for sidebar cleanup by external observers).
    // The DataChannel 'left' already notified in-call peers instantly.
    // We don't await this — signing via remote signer can take seconds.
    const userState = useUserStore.getState()
    const effectiveSigner = signer || userState.signer
    const effectivePrivateKey = privateKey || userState.privateKey
    if (currentHubDTag && currentChannelId && (effectiveSigner || effectivePrivateKey)) {
      // Resolve relays synchronously from cached store state (no await)
      let effectiveRelays = relays
      if (effectiveRelays.length === 0 && currentHubDTag) {
        try {
          const hubStore = (await import('@/stores/hubStore')).useHubStore.getState()
          const hubData = hubStore.hubs[currentHubDTag]
          if (hubData) {
            effectiveRelays = [...new Set([...hubData.generalRelays, ...hubData.filterRelays])].filter(Boolean)
          }
        } catch { }
      }

      const tags: [string, ...string[]][] = [
        ['d', currentHubDTag],
        ['c', currentChannelId],
        ['status', 'left'],
        ['host', ''],
        ['session', ''],
      ]
      // Background sign + publish — don't block disconnect
      signWithSigner(createUnsignedEvent(KINDS.VOICE_PRESENCE, '', tags), effectiveSigner, effectivePrivateKey)
        .then((signed) => {
          const publishRelays = effectiveRelays.length > 0
            ? getPublishRelays(effectiveRelays)
            : getPublishRelays()
          return publishToSpecificRelays(publishRelays, signed)
        })
        .catch((err) => console.warn('[VoiceStore] Failed to publish leave:', err))
    }

    // Immediately purge our own presence from presenceByHub so the sidebar
    // and cross-device check don't see a stale 'joined' entry.
    const myPubkey = useUserStore.getState().pubkey
    if (myPubkey && currentHubDTag) {
      set((s) => {
        const entries = s.presenceByHub[currentHubDTag] || []
        const filtered = entries.filter((p) => p.pubkey !== myPubkey)
        return { presenceByHub: { ...s.presenceByHub, [currentHubDTag]: filtered } }
      })
    }

    set({
      provider: null,
      currentChannelId: null,
      currentHubDTag: null,
      currentSessionId: null,
      currentHostPubkey: null,
      connectionState: 'disconnected',
      participants: {},
      remoteTracks: {},
      activeSpeakers: [],
      joinedAt: null,
      isMuted: false,
      isE2EE: false,
      isVideoEnabled: false,
      isScreenSharing: false,
      localAudioTrack: null,
      localVideoTrack: null,
      localScreenTrack: null,
      spatialEnabled: false,
      spatial3DEnabled: true,
      spatialPanelOpen: false,
      virtualSpaceOpen: false,
      _spatialEngine: null,
      myHeading: 0,
      _micGainNode: null,
      _vadCtx: null,
      _micSource: null,
      _micAnalyser: null,
      _micPostSourceNode: null,
      _dcSessionToPubkey: {},
      _screenWatching: new Set<string>(),
      _cameraHidden: new Set<string>(),
    })
  },

  toggleMute: () => {
    const { provider, isMuted, isDeafened } = get()
    const newMuted = !isMuted
    // When unmuting while deafened, also undeafen (restore full audio)
    const newDeafened = !newMuted ? false : isDeafened
    set({ isMuted: newMuted, isDeafened: newDeafened })
    playSoundEffect(newMuted ? 'mute' : 'unmute')
    if (provider) {
      provider.setMuted('audio', newMuted)
      if (isDeafened && !newDeafened) {
        provider.setDeafened(false)
      }
      get()._broadcastStateNow()
    }
  },

  toggleDeafen: () => {
    const { provider, isDeafened, isMuted } = get()
    const newDeafened = !isDeafened
    // When deafening, also mute mic. When undeafening, keep mute as-is
    // (user must manually unmute after undeafening).
    const newMuted = newDeafened ? true : isMuted
    set({ isDeafened: newDeafened, isMuted: newMuted })
    playSoundEffect(newDeafened ? 'deafen' : 'undeafen')
    if (provider) {
      provider.setMuted('audio', newMuted)
      // Mute/unmute all remote audio
      provider.setDeafened(newDeafened)
      get()._broadcastStateNow()
    }
  },

  toggleVideo: async () => {
    const { provider, isVideoEnabled } = get()
    if (!provider) return

    // Guard against rapid toggling — ignore if already in progress
    if ((get() as any)._videoToggling) return
    set({ _videoToggling: true } as any)

    try {
      if (isVideoEnabled) {
        await provider.unpublishTrack('video')  // stops track + closes on SFU
        set({ isVideoEnabled: false, localVideoTrack: null })
      } else {
        const cameraId = getCameraDeviceId()
        const constraints: MediaStreamConstraints = {
          video: cameraId ? { deviceId: { exact: cameraId } } : true,
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        const videoTrack = stream.getVideoTracks()[0]
        if (videoTrack) {
          try {
            await provider.publishTrack(videoTrack, 'video')
            set({ isVideoEnabled: true, localVideoTrack: videoTrack })
          } catch (err) {
            // Publish failed — stop the camera so the light turns off
            videoTrack.stop()
            console.warn('[VoiceStore] Failed to publish camera track:', err)
          }
        }
      }
    } catch (err) {
      console.warn('[VoiceStore] toggleVideo error:', err)
    } finally {
      set({ _videoToggling: false } as any)
    }
    // Immediately broadcast updated track list via DC so remote sees it in <50ms
    get()._broadcastStateNow()
  },

  toggleScreenShare: async () => {
    const { provider, isScreenSharing } = get()
    if (!provider) return

    // Guard against rapid toggling
    if ((get() as any)._screenToggling) return
    set({ _screenToggling: true } as any)

    try {
      if (isScreenSharing) {
        // Clear onended before unpublishing to prevent duplicate state change
        const track = get().localScreenTrack
        if (track) track.onended = null
        await provider.unpublishTrack('screenshare')  // stops track + closes on SFU
        set({ isScreenSharing: false, localScreenTrack: null })
      } else {
        const isFirefox = navigator.userAgent.includes('Firefox')
        const quality = getScreenShareQuality()
        const displayMediaOpts: DisplayMediaStreamOptions = isFirefox
          ? {
              video: {
                width: { max: quality.width },
                height: { max: quality.height },
                frameRate: { ideal: quality.fps, max: quality.fps },
              },
              audio: false,
            }
          : {
              video: {
                width: { ideal: quality.width, max: quality.width },
                height: { ideal: quality.height, max: quality.height },
                frameRate: { ideal: quality.fps, max: quality.fps },
              },
              audio: true,
              selfBrowserSurface: 'exclude',
              systemAudio: 'include',
            } as any
        const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOpts)
        const screenTrack = stream.getVideoTracks()[0]
        if (screenTrack) {
          // Firefox: apply constraints again post-capture since getDisplayMedia
          // may ignore constraints in the initial call
          if (isFirefox) {
            try {
              await screenTrack.applyConstraints({
                width: { max: quality.width },
                height: { max: quality.height },
                frameRate: { max: quality.fps },
              })
            } catch { /* constraints may not be supported, continue anyway */ }
          }
          try {
            await provider.publishTrack(screenTrack, 'screenshare')
            // Auto-stop when user stops sharing via browser UI
            screenTrack.onended = () => {
              provider.unpublishTrack('screenshare').catch(() => {})
              set({ isScreenSharing: false, localScreenTrack: null })
              // Broadcast immediately that screenshare stopped
              get()._broadcastStateNow()
            }
            set({ isScreenSharing: true, localScreenTrack: screenTrack })
          } catch (err) {
            // Publish failed — stop the track so screen capture ends
            screenTrack.stop()
            console.warn('[VoiceStore] Failed to publish screenshare track:', err)
          }
        }
      }
    } catch (err) {
      console.warn('[VoiceStore] toggleScreenShare error:', err)
    } finally {
      set({ _screenToggling: false } as any)
    }
    // Immediately broadcast updated track list via DC so remote sees it in <50ms
    get()._broadcastStateNow()
  },

  toggleSpatialPanel: () => {
    const { spatialEnabled, provider, _spatialEngine } = get()

    if (spatialEnabled) {
      // Disable spatial — stop engine, reset all volumes to 1.0
      if (_spatialEngine) {
        _spatialEngine.destroy()
      }
      set({ spatialEnabled: false, spatialPanelOpen: false, _spatialEngine: null })
    } else {
      // Enable spatial — create engine & start
      const { spatial3DEnabled, myPosition, myHeading, myElevation, myPitch, mySphereRadius } = get()
      const engine = new SpatialAudioEngine()
      engine.setCallbacks({
        onVolumeUpdate: (participantId, volume) => {
          const p = get().provider
          if (p) p.setParticipantVolume(participantId, volume)
        },
      })
      engine.set3DEnabled(spatial3DEnabled)
      if (provider) engine.setProvider(provider)
      engine.updateMyPosition(myPosition.x, myPosition.y)
      engine.updateMyHeading(myHeading)
      engine.updateMyElevation(myElevation)
      engine.updateMyPitch(myPitch)
      engine.updateMySphereRadius(mySphereRadius)

      // Seed with current participant positions from presence
      const { presenceByHub, currentHubDTag, currentChannelId, participants } = get()
      if (currentHubDTag) {
        const presences = presenceByHub[currentHubDTag] || []
        for (const p of presences) {
          if (p.channelId === currentChannelId && p.status === 'joined' && participants[p.pubkey]) {
            engine.updateParticipant({
              id: p.pubkey,
              position: p.position,
              heading: p.heading ?? 0,
              elevation: p.elevation ?? 0,
              pitch: p.pitch ?? 0,
            })
          }
        }
      }

      // Seed saved per-user volumes so boost carries into spatial mode
      try {
        const raw = localStorage.getItem('den-chat-user-volumes')
        if (raw) {
          const map = JSON.parse(raw)
          for (const [pk, vol] of Object.entries(map)) {
            if (typeof vol === 'number' && vol !== 100) {
              engine.setUserVolume(pk, (vol as number) / 100)
            }
          }
        }
      } catch { /* ignore */ }

      engine.start()
      set({ spatialEnabled: true, spatialPanelOpen: true, _spatialEngine: engine })
    }
  },

  toggleVirtualSpace: () => {
    const { virtualSpaceOpen, spatialEnabled, _spatialEngine } = get()
    if (virtualSpaceOpen) {
      // Close the 3D view — tear the spatial engine down (it existed for this view).
      if (_spatialEngine) _spatialEngine.destroy()
      set({ virtualSpaceOpen: false, spatialEnabled: false, spatialPanelOpen: false, _spatialEngine: null })
    } else {
      // Reuse the spatial-panel path to create + start the (3D) engine, then show the
      // 3D view instead of the 2D radar.
      if (!spatialEnabled) get().toggleSpatialPanel()
      set({ virtualSpaceOpen: true, spatialPanelOpen: false })
    }
  },

  toggleVoiceChatMode: () => {
    set((s) => ({ voiceChatMode: !s.voiceChatMode }))
  },

  setVoiceChatMode: (value) => {
    set({ voiceChatMode: value })
  },

  updateMicGain: (gain) => {
    const node = get()._micGainNode
    if (node) {
      node.gain.value = gain
      console.log(`[VoiceStore] Mic gain updated to ${gain}`)
    }
  },

  setOutputDevice: async (deviceId) => {
    const { provider } = get()
    if (provider) {
      await provider.setOutputDevice(deviceId)
      console.log(`[VoiceStore] Output device set to: ${deviceId || '(default)'}`)
    }
  },

  setInputDevice: async (deviceId) => {
    const { _vadCtx, _micSource, _micAnalyser, _micPostSourceNode, localAudioTrack } = get()
    // No live pipeline (not in a call) — nothing to swap; the next join reads the
    // saved device from settings.
    if (!_vadCtx || !_micSource || !_micAnalyser || !_micPostSourceNode) return
    try {
      // Match the join constraints: the browser noise-suppression flags must stay
      // consistent with the pipeline that's already built.
      let noiseMode: 'off' | 'basic' | 'rnnoise' = 'rnnoise'
      try {
        const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
        noiseMode = typeof vs.noiseCancellation === 'boolean'
          ? (vs.noiseCancellation ? 'basic' : 'off')
          : (vs.noiseSuppression ?? 'rnnoise')
      } catch { }
      const useBrowserNC = noiseMode === 'basic'
      const base: MediaTrackConstraints = {
        noiseSuppression: useBrowserNC,
        echoCancellation: true,
        autoGainControl: useBrowserNC,
      }
      // Try the requested device; fall back to default if it's unavailable.
      let newStream: MediaStream
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
        })
      } catch (err) {
        console.warn('[VoiceStore] Requested mic unavailable, falling back to default:', err)
        newStream = await navigator.mediaDevices.getUserMedia({ audio: base })
      }

      // Swap the source feeding the (unchanged) VAD analyser + gate/destination chain,
      // so the already-published track keeps flowing from the new mic — no republish.
      const newSource = _vadCtx.createMediaStreamSource(newStream)
      _micSource.disconnect()
      newSource.connect(_micAnalyser)
      newSource.connect(_micPostSourceNode)

      // Stop the old raw mic track now that nothing reads from it, and expose the new
      // one for the speaking-detection hook to re-clone.
      localAudioTrack?.stop()
      const newRawTrack = newStream.getAudioTracks()[0] || null
      set({ _micSource: newSource, localAudioTrack: newRawTrack })
      console.log(`[VoiceStore] Input device switched to: ${deviceId || '(default)'}`)
    } catch (err) {
      console.warn('[VoiceStore] Failed to switch input device:', err)
    }
  },

  updatePosition: (x, y) => {
    set({ myPosition: { x, y } })
    const engine = get()._spatialEngine
    if (engine) engine.updateMyPosition(x, y)
  },

  updateHeading: (heading) => {
    set({ myHeading: heading })
    const engine = get()._spatialEngine
    if (engine) engine.updateMyHeading(heading)
  },

  updateElevation: (elevation) => {
    set({ myElevation: elevation })
    const engine = get()._spatialEngine
    if (engine) engine.updateMyElevation(elevation)
  },

  updatePitch: (pitch) => {
    set({ myPitch: pitch })
    const engine = get()._spatialEngine
    if (engine) engine.updateMyPitch(pitch)
  },

  toggle3DAudio: () => {
    const { spatial3DEnabled, _spatialEngine, provider } = get()
    const newValue = !spatial3DEnabled
    set({ spatial3DEnabled: newValue })
    if (_spatialEngine) {
      if (provider) _spatialEngine.setProvider(provider)
      _spatialEngine.set3DEnabled(newValue)
    }
  },

  updateSphereRadius: (radius) => {
    const clamped = Math.max(
      SPATIAL_DEFAULTS.MIN_SPHERE_RADIUS,
      Math.min(SPATIAL_DEFAULTS.MAX_SPHERE_RADIUS, radius),
    )
    set({ mySphereRadius: clamped })
    const engine = get()._spatialEngine
    if (engine) engine.updateMySphereRadius(clamped)
  },

  updateConePercent: (percent) => {
    const clamped = Math.max(0, Math.min(100, percent))
    set({ myConePercent: clamped })
    const engine = get()._spatialEngine
    if (engine) engine.updateMyConePercent(clamped)
  },

  // ── Host pool subscription (kind 36946) ──

  subscribeHosts: (hubDTag, relays, hubSecret, groupIds?) => {
    if (get()._hostSubs[hubDTag]) return

    // Include group-scoped d-tags: hub-wide is "hubDTag", group-scoped is "hubDTag:groupId"
    const dTags = [hubDTag, ...(groupIds || []).map((gid) => `${hubDTag}:${gid}`)]

    const filter: Filter = {
      kinds: [KINDS.VOICE_HOST as number],
      '#d': dTags,
    }

    const sub = subscribeToRelays(relays, filter, (event) => {
      const host = parseVoiceHost(event)
      if (!host) return

      set((s) => {
        const existing = s.hostsByHub[hubDTag] || []
        const idx = existing.findIndex((h) => h.pubkey === host.pubkey && h.groupId === host.groupId)
        let updated: VoiceHost[]
        if (idx >= 0) {
          if (host.createdAt > existing[idx].createdAt) {
            updated = [...existing]
            updated[idx] = host
          } else {
            return s
          }
        } else {
          updated = [...existing, host]
        }
        return { hostsByHub: { ...s.hostsByHub, [hubDTag]: updated } }
      })

      // Async: try to decrypt the config — first with current hubSecret,
      // then fall back to old epoch secrets (so voice stays up after key rotation)
      if (event.content) {
        ;(async () => {
          let config: VoiceProviderConfig | null = null

          if (host.groupId) {
            // Group-scoped host — try group secret
            const { useHubStore } = await import('@/stores/hubStore')
            const groupSecret = useHubStore.getState().groupSecrets[hubDTag]?.[host.groupId]
            if (groupSecret) {
              config = await decryptHostConfig(event.content, groupSecret, host.epoch)
            }
            // If that fails, try historical group epoch secrets
            if (!config) {
              const groupEpochSecrets = useHubStore.getState().groupEpochSecrets[hubDTag]?.[host.groupId]
              const oldSecret = groupEpochSecrets?.[host.epoch]
              if (oldSecret) {
                config = await decryptHostConfig(event.content, oldSecret, host.epoch)
              }
            }
          } else if (hubSecret) {
            // Hub-wide host — try current hub secret
            config = await decryptHostConfig(event.content, hubSecret, host.epoch)

            // If that fails, try the epoch-specific secret from history
            if (!config) {
              const { useHubStore } = await import('@/stores/hubStore')
              const epochSecrets = useHubStore.getState().epochSecrets[hubDTag]
              const oldSecret = epochSecrets?.[host.epoch]
              if (oldSecret) {
                config = await decryptHostConfig(event.content, oldSecret, host.epoch)
              }
            }
          }

          if (!config) return
          set((s) => {
            const hosts = s.hostsByHub[hubDTag] || []
            const idx = hosts.findIndex((h) => h.pubkey === host.pubkey && h.groupId === host.groupId)
            if (idx < 0) return s
            const updated = [...hosts]
            updated[idx] = { ...updated[idx], config, encryptedContent: undefined }
            return { hostsByHub: { ...s.hostsByHub, [hubDTag]: updated } }
          })
        })()
      }
    })

    set((s) => ({ _hostSubs: { ...s._hostSubs, [hubDTag]: sub } }))
  },

  unsubscribeHosts: (hubDTag) => {
    const sub = get()._hostSubs[hubDTag]
    if (sub) {
      sub.close()
      set((s) => {
        const { [hubDTag]: _, ...rest } = s._hostSubs
        return { _hostSubs: rest }
      })
    }
  },

  refreshHosts: (hubDTag, relays, hubSecret, groupIds?) => {
    console.log(`[VoiceStore] Refreshing hosts for ${hubDTag}`)
    // Clear existing hosts and subscription, then re-subscribe
    const sub = get()._hostSubs[hubDTag]
    if (sub) sub.close()
    set((s) => {
      const { [hubDTag]: _, ...restSubs } = s._hostSubs
      const { [hubDTag]: __, ...restHosts } = s.hostsByHub
      return { _hostSubs: restSubs, hostsByHub: restHosts }
    })
    // Re-subscribe after a tick to ensure cleanup completes
    setTimeout(() => {
      get().subscribeHosts(hubDTag, relays, hubSecret, groupIds)
    }, 100)
  },

  // ── Presence subscription (kind 36947) ──

  subscribePresence: (hubDTag, relays) => {
    if (get()._presenceSubs[hubDTag]) return

    const filter: Filter = {
      kinds: [KINDS.VOICE_PRESENCE as number],
      '#d': [hubDTag],
    }

    const sub = subscribeToRelays(relays, filter, (event) => {
      const presence = parseVoicePresence(event)
      if (!presence) return

      // Capture old tracks BEFORE updating the store (for diff comparison below)
      const oldPresenceList = get().presenceByHub[hubDTag] || []
      const oldPresenceEntry = oldPresenceList.find(
        (p) => p.pubkey === presence.pubkey && p.status === 'joined'
      )
      const oldTracks = oldPresenceEntry?.tracks || []

      set((s) => {
        const existing = s.presenceByHub[hubDTag] || []
        const idx = existing.findIndex((p) => p.pubkey === presence.pubkey)
        let updated: VoicePresence[]
        if (idx >= 0) {
          if (presence.createdAt > existing[idx].createdAt) {
            updated = [...existing]
            updated[idx] = presence
          } else {
            return s
          }
        } else {
          updated = [...existing, presence]
        }
        return { presenceByHub: { ...s.presenceByHub, [hubDTag]: updated } }
      })

      // ── Auto-pull remote tracks + subscribe DataChannel ──
      // If we're connected to the same channel and this is a different user,
      // pull their audio/video tracks and subscribe to their DataChannel.
      const state = get()
      if (
        state.provider &&
        state.connectionState === 'connected' &&
        state.currentHubDTag === hubDTag &&
        state.currentChannelId === presence.channelId &&
        // Only pull/add people on OUR host — a different host is a separate SFU we
        // can't pull from. Other-host people are surfaced via the dimmed "other host"
        // group in the UI instead (computed from presence). Empty host = treat as ours.
        (!presence.hostPubkey || presence.hostPubkey === state.currentHostPubkey) &&
        presence.status === 'joined' &&
        presence.sessionId &&
        presence.sessionId !== state.currentSessionId &&
        presence.tracks.length > 0 &&
        presence.pubkey !== (state.provider as any).identity &&
        presence.pubkey !== useUserStore.getState().pubkey
      ) {
        // Check if we need to pull tracks — either new participant or new tracks from existing one
        const existingParticipant = state.participants[presence.pubkey]
        if (!existingParticipant) {
          // Only add brand-new participants from very recent presence events.
          // Stale relay events (e.g. from a user who left <60s ago) can cause
          // ghost users to appear briefly. The DC heartbeat will clean them
          // up eventually, but this prevents them from appearing at all.
          const presenceAge = Math.floor(Date.now() / 1000) - presence.createdAt
          if (presenceAge > 15) return // Too old — wait for a fresh heartbeat
          // Filter tracks: skip screenshare (opt-in) and hidden cameras (opt-out)
          const filteredTracks = presence.tracks.filter((t: string) => {
            if (t.endsWith(':screenshare')) return state._screenWatching.has(presence.pubkey)
            if (t.endsWith(':video')) return !state._cameraHidden.has(presence.pubkey)
            return true
          })
          if (filteredTracks.length > 0) {
            console.log(`[VoiceStore] Pulling tracks from new participant ${presence.pubkey.slice(0, 8)}..., session ${presence.sessionId}, tracks:`, filteredTracks)
            state.provider.pullRemoteTracks(presence.sessionId, filteredTracks).catch((err) => {
              console.warn('[VoiceStore] Failed to pull remote tracks:', err)
            })
          }

          // Subscribe to their DataChannel for real-time state updates
          get()._subscribeParticipantDC(presence.pubkey, presence.sessionId)

          // Add them as a participant immediately
          set((s) => ({
            participants: {
              ...s.participants,
              [presence.pubkey]: {
                id: presence.pubkey,
                pubkey: presence.pubkey,
                isMuted: false,
                isDeafened: false,
                isSpeaking: false,
                hasVideo: presence.tracks.some((t: string) => t.endsWith(':video')),
                hasScreenShare: presence.tracks.some((t: string) => t.endsWith(':screenshare')),
              },
            },
          }))
        } else {
          // Existing participant — check if they have new tracks we haven't pulled yet
          // Uses oldTracks captured BEFORE the store was updated
          const newTracks = presence.tracks.filter((t: string) => !oldTracks.includes(t))
          // Filter new tracks: skip screenshare (opt-in) and hidden cameras (opt-out)
          const filteredNew = newTracks.filter((t: string) => {
            if (t.endsWith(':screenshare')) return state._screenWatching.has(presence.pubkey)
            if (t.endsWith(':video')) return !state._cameraHidden.has(presence.pubkey)
            return true
          })
          if (filteredNew.length > 0 && presence.sessionId) {
            console.log(`[VoiceStore] Pulling new tracks from existing participant ${presence.pubkey.slice(0, 8)}...:`, filteredNew)
            state.provider.pullRemoteTracks(presence.sessionId, filteredNew).catch((err) => {
              console.warn('[VoiceStore] Failed to pull new tracks:', err)
            })
          }
        }
      }

      // ── Update spatial engine with remote position (fallback from Nostr) ──
      // DataChannel updates will override these, but this handles initial discovery
      if (presence.status === 'joined') {
        const engine = get()._spatialEngine
        if (engine) {
          engine.updateParticipant({
            id: presence.pubkey,
            position: presence.position,
            heading: presence.heading ?? 0,
            elevation: presence.elevation ?? 0,
            pitch: presence.pitch ?? 0,
          })
        }
      }

      // ── Handle participant leaving (Nostr notification) ──
      if (
        presence.status === 'left' &&
        get().connectionState === 'connected' &&
        get().currentHubDTag === hubDTag
      ) {
        const state = get()
        if (state.participants[presence.pubkey]) {
          console.log(`[VoiceStore] Participant left (Nostr): ${presence.pubkey.slice(0, 8)}..., cleaning up`)
          const engine = state._spatialEngine
          if (engine) engine.removeParticipant(presence.pubkey)
          set((s) => {
            const { [presence.pubkey]: _, ...restParticipants } = s.participants
            const { [presence.pubkey]: __, ...restTracks } = s.remoteTracks
            return { participants: restParticipants, remoteTracks: restTracks }
          })
        }
      }
    })

    set((s) => ({ _presenceSubs: { ...s._presenceSubs, [hubDTag]: sub } }))
  },

  unsubscribePresence: (hubDTag) => {
    const sub = get()._presenceSubs[hubDTag]
    if (sub) {
      sub.close()
      set((s) => {
        const { [hubDTag]: _, ...rest } = s._presenceSubs
        return { _presenceSubs: rest }
      })
    }
  },

  getChannelPresence: (hubDTag, channelId) => {
    const all = get().presenceByHub[hubDTag] || []
    const { connectionState, currentHubDTag, currentChannelId, _dcLastSeen } = get()
    const isConnectedHere = connectionState === 'connected' && currentHubDTag === hubDTag && currentChannelId === channelId
    const myIdentity = useUserStore.getState().pubkey

    return all.filter((p) => {
      if (p.channelId !== channelId || p.status !== 'joined' || isPresenceStale(p)) return false

      // When we're connected to this channel, use DC heartbeat to verify remote users
      // are actually still online. Nostr events linger on relays long after disconnect.
      if (isConnectedHere && p.pubkey !== myIdentity) {
        const lastSeen = _dcLastSeen[p.pubkey]
        if (lastSeen && (Date.now() - lastSeen) > 5_000) return false
      }

      return true
    })
  },

  getAvailableHosts: (hubDTag, groupId?) => {
    const all = get().hostsByHub[hubDTag] || []
    return all.filter((h) => {
      if (h.status !== 'available') return false
      // Filter by scope: match groupId exactly (undefined === hub-wide)
      return groupId ? h.groupId === groupId : !h.groupId
    })
  },

  publishHostAvailability: async (
    hubDTag,
    config,
    status,
    epoch,
    secret,
    relays,
    signer,
    privateKey,
    groupId?,
  ) => {
    if (!signer && !privateKey) return

    // Derive a voice-specific key and encrypt the config
    const { deriveKey } = await import('@/lib/crypto/hkdf')
    const { aesEncrypt } = await import('@/lib/crypto/aes')
    const secretBytes = new Uint8Array(secret.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
    const derivedKey = deriveKey(secretBytes, `voice-host:epoch:${epoch}`)
    const encryptedContent = await aesEncrypt(derivedKey, JSON.stringify(config))

    // Use scoped d tag: "hubDTag" for hub-wide, "hubDTag:groupId" for group-scoped
    const dTagValue = groupId ? `${hubDTag}:${groupId}` : hubDTag

    const tags: [string, ...string[]][] = [
      ['d', dTagValue],
      ['status', status],
      ['provider', config.provider],
      ['epoch', epoch.toString()],
    ]
    if (groupId) tags.push(['group', groupId])

    const unsigned = createUnsignedEvent(KINDS.VOICE_HOST, encryptedContent, tags)
    const signed = await signWithSigner(unsigned, signer, privateKey)

    if (relays.length > 0) {
      await publishToSpecificRelays(getPublishRelays(relays), signed)
    } else {
      await publishToSpecificRelays(getPublishRelays(), signed)
    }
  },

  // ── DataChannel state broadcast (replaces heartbeat) ──

  _startStateBroadcast: () => {
    // Stop existing broadcast if any
    const existing = get()._stateBroadcastInterval
    if (existing) clearInterval(existing)

    const broadcastState = () => {
      const { provider, connectionState, myPosition, myHeading, myElevation, myPitch, mySphereRadius, myConePercent, isMuted, isDeafened, spatialEnabled, virtualSpaceOpen, _isSpeaking, isE2EE } = get()
      if (!provider || connectionState !== 'connected') return

      provider.sendData({
        type: 'state',
        pos: myPosition,
        heading: myHeading,
        elevation: myElevation,
        pitch: myPitch,
        sphere: mySphereRadius,
        cone: myConePercent,
        tracks: provider.getPublishedTrackKinds(),
        muted: isMuted,
        deafened: isDeafened,
        spatial: spatialEnabled,
        vspace: virtualSpaceOpen,
        speaking: _isSpeaking,
        e2ee: isE2EE,
      })
    }

    const interval = setInterval(broadcastState, PRESENCE_CONSTANTS.STATE_BROADCAST_MS)
    set({ _stateBroadcastInterval: interval })

    // Heartbeat check: remove participants who haven't sent a DC state message recently.
    // DC state is broadcast at ~10Hz (100ms), so 5s of silence means they disconnected.
    const existingHeartbeat = get()._heartbeatInterval
    if (existingHeartbeat) clearInterval(existingHeartbeat)

    const heartbeatCheck = () => {
      const { _dcLastSeen, participants, connectionState, _spatialEngine } = get()
      if (connectionState !== 'connected') return

      const now = Date.now()
      const STALE_MS = 5_000  // 5 seconds without a DC state message = disconnected
      const stalePubkeys: string[] = []

      for (const pubkey of Object.keys(participants)) {
        const lastSeen = _dcLastSeen[pubkey]
        if (lastSeen && (now - lastSeen) > STALE_MS) {
          stalePubkeys.push(pubkey)
        }
      }

      if (stalePubkeys.length > 0) {
        set((s) => {
          let newParticipants = { ...s.participants }
          let newRemoteTracks = { ...s.remoteTracks }
          const newLastSeen = { ...s._dcLastSeen }
          const updatedPresences: Record<string, VoicePresence[]> = {}

          for (const [key, presences] of Object.entries(s.presenceByHub)) {
            updatedPresences[key] = presences.filter((p) => !stalePubkeys.includes(p.pubkey))
          }

          for (const pubkey of stalePubkeys) {
            console.log(`[VoiceStore] Heartbeat: removing stale participant ${pubkey.slice(0, 8)}...`)
            if (_spatialEngine) _spatialEngine.removeParticipant(pubkey)
            delete newParticipants[pubkey]
            delete newRemoteTracks[pubkey]
            delete newLastSeen[pubkey]
          }

          return {
            participants: newParticipants,
            remoteTracks: newRemoteTracks,
            presenceByHub: updatedPresences,
            _dcLastSeen: newLastSeen,
          }
        })
      }
    }

    const hbInterval = setInterval(heartbeatCheck, 3_000)
    set({ _heartbeatInterval: hbInterval })
  },

  _startKeepalive: (hubDTag, channelId, hostPubkey, sessionId, relays, signer, privateKey) => {
    // Stop existing keepalive
    const existing = get()._keepaliveInterval
    if (existing) clearInterval(existing)

    const publishKeepalive = async () => {
      const { connectionState } = get()
      if (connectionState !== 'connected') return

      try {
        const { provider } = get()
        // Collect active track names for the Nostr event (still needed for initial discovery)
        const publishedTracks: string[] = []
        if (provider) {
          const pubkey = useUserStore.getState().pubkey
          for (const kind of provider.getPublishedTrackKinds()) {
            publishedTracks.push(`${pubkey}:${kind}`)
          }
        }

        const { myPosition, myElevation, myPitch, mySphereRadius } = get()
        const tags: [string, ...string[]][] = [
          ['d', hubDTag],
          ['c', channelId],
          ['status', 'joined'],
          ['host', hostPubkey],
          ['session', sessionId],
          ['tracks', ...publishedTracks],
          ['pos', myPosition.x.toString(), myPosition.y.toString()],
          ['elevation', myElevation.toString()],
          ['pitch', myPitch.toString()],
          ['sphere', mySphereRadius.toString()],
        ]
        const unsigned = createUnsignedEvent(KINDS.VOICE_PRESENCE, '', tags)
        const signed = await signWithSigner(unsigned, signer, privateKey)
        if (relays.length > 0) {
          await publishToSpecificRelays(getPublishRelays(relays), signed)
        } else {
          await publishToSpecificRelays(getPublishRelays(), signed)
        }
      } catch (err) {
        console.warn('[VoiceStore] Keepalive publish failed:', err)
      }
    }

    // Publish a few times early, then every 45s. Cross-host participants discover
    // each other ONLY via these Nostr presence events (no shared SFU DataChannel),
    // so a single delayed publish that's slow or dropped means a long wait. Firing
    // early + retrying makes that discovery fast and reliable.
    setTimeout(() => publishKeepalive(), 700)
    setTimeout(() => publishKeepalive(), 4_000)
    const interval = setInterval(publishKeepalive, PRESENCE_CONSTANTS.KEEPALIVE_INTERVAL_MS)
    set({ _keepaliveInterval: interval })
  },

  _stopBroadcast: () => {
    const keepalive = get()._keepaliveInterval
    if (keepalive) clearInterval(keepalive)
    const broadcast = get()._stateBroadcastInterval
    if (broadcast) clearInterval(broadcast)
    const heartbeat = get()._heartbeatInterval
    if (heartbeat) clearInterval(heartbeat)
    set({ _keepaliveInterval: null, _stateBroadcastInterval: null, _heartbeatInterval: null, _dcLastSeen: {} })
  },

  _broadcastStateNow: () => {
    const { provider, connectionState, myPosition, myHeading, mySphereRadius, myConePercent, isMuted, spatialEnabled, virtualSpaceOpen, _isSpeaking } = get()
    if (!provider || connectionState !== 'connected') return

    provider.sendData({
      type: 'state',
      pos: myPosition,
      heading: myHeading,
      sphere: mySphereRadius,
      cone: myConePercent,
      tracks: provider.getPublishedTrackKinds(),
      muted: isMuted,
      spatial: spatialEnabled,
      vspace: virtualSpaceOpen,
      speaking: _isSpeaking,
    })
  },

  _subscribeParticipantDC: (pubkey, sessionId) => {
    const { provider } = get()
    if (!provider) return

    // Store sessionId → pubkey mapping for DC message resolution
    set((s) => ({
      _dcSessionToPubkey: { ...s._dcSessionToPubkey, [sessionId]: pubkey },
    }))

    // Subscribe to their DataChannel
    provider.subscribeDataChannel(`state-${pubkey}`, sessionId).catch((err) => {
      console.warn(`[VoiceStore] Failed to subscribe to DC for ${pubkey.slice(0, 8)}:`, err)
    })
  },

  // ── Stream Opt-In/Out Actions ──

  watchScreenShare: (pubkey) => {
    const state = get()
    const newSet = new Set(state._screenWatching)
    newSet.add(pubkey)
    set({ _screenWatching: newSet })

    // Find the session ID for this participant and pull the screenshare track
    const sessionId = Object.entries(state._dcSessionToPubkey).find(([, pk]) => pk === pubkey)?.[0]
    if (sessionId && state.provider) {
      const trackName = `${pubkey}:screenshare`
      console.log(`[VoiceStore] Watching screenshare from ${pubkey.slice(0, 8)}, pulling track`)
      state.provider.pullRemoteTracks(sessionId, [trackName]).catch((err) => {
        console.warn('[VoiceStore] Failed to pull screenshare track:', err)
      })
    } else {
      // Try from presence as fallback
      const hub = state.currentHubDTag
      const ch = state.currentChannelId
      if (hub && ch) {
        const presence = (state.presenceByHub[hub] || []).find(
          (p) => p.pubkey === pubkey && p.channelId === ch && p.status === 'joined' && p.sessionId
        )
        if (presence?.sessionId && state.provider) {
          const trackName = `${pubkey}:screenshare`
          console.log(`[VoiceStore] Watching screenshare from ${pubkey.slice(0, 8)} (via presence), pulling track`)
          state.provider.pullRemoteTracks(presence.sessionId, [trackName]).catch((err) => {
            console.warn('[VoiceStore] Failed to pull screenshare track:', err)
          })
        }
      }
    }
  },

  unwatchScreenShare: (pubkey) => {
    const state = get()
    const newSet = new Set(state._screenWatching)
    newSet.delete(pubkey)
    set({ _screenWatching: newSet })

    // Close the screenshare track to stop bandwidth
    if (state.provider) {
      const trackName = `${pubkey}:screenshare`
      const cfProvider = state.provider as any
      if (cfProvider.getMidsForTrackNames) {
        const mids = cfProvider.getMidsForTrackNames([trackName])
        if (mids.length > 0) {
          console.log(`[VoiceStore] Unwatching screenshare from ${pubkey.slice(0, 8)}, closing track MIDs:`, mids)
          state.provider.closeTracks(mids).catch((err) => {
            console.warn('[VoiceStore] Failed to close screenshare track:', err)
          })
        }
      }
    }

    // Also remove the track from remoteTracks so it won't render
    set((s) => {
      const tracks = s.remoteTracks[pubkey]
      if (!tracks) return {}
      const filtered = tracks.filter((t) => t.kind !== 'screenshare')
      return {
        remoteTracks: {
          ...s.remoteTracks,
          [pubkey]: filtered,
        },
      }
    })
  },

  showCamera: (pubkey) => {
    const state = get()
    const newSet = new Set(state._cameraHidden)
    newSet.delete(pubkey)
    set({ _cameraHidden: newSet })

    // Pull the video track
    const sessionId = Object.entries(state._dcSessionToPubkey).find(([, pk]) => pk === pubkey)?.[0]
    if (sessionId && state.provider) {
      const trackName = `${pubkey}:video`
      console.log(`[VoiceStore] Showing camera from ${pubkey.slice(0, 8)}, pulling track`)
      state.provider.pullRemoteTracks(sessionId, [trackName]).catch((err) => {
        console.warn('[VoiceStore] Failed to pull video track:', err)
      })
    } else {
      const hub = state.currentHubDTag
      const ch = state.currentChannelId
      if (hub && ch) {
        const presence = (state.presenceByHub[hub] || []).find(
          (p) => p.pubkey === pubkey && p.channelId === ch && p.status === 'joined' && p.sessionId
        )
        if (presence?.sessionId && state.provider) {
          const trackName = `${pubkey}:video`
          state.provider.pullRemoteTracks(presence.sessionId, [trackName]).catch((err) => {
            console.warn('[VoiceStore] Failed to pull video track:', err)
          })
        }
      }
    }
  },

  hideCamera: (pubkey) => {
    const state = get()
    const newSet = new Set(state._cameraHidden)
    newSet.add(pubkey)
    set({ _cameraHidden: newSet })

    // Close the video track to stop bandwidth
    if (state.provider) {
      const trackName = `${pubkey}:video`
      const cfProvider = state.provider as any
      if (cfProvider.getMidsForTrackNames) {
        const mids = cfProvider.getMidsForTrackNames([trackName])
        if (mids.length > 0) {
          console.log(`[VoiceStore] Hiding camera from ${pubkey.slice(0, 8)}, closing track MIDs:`, mids)
          state.provider.closeTracks(mids).catch((err) => {
            console.warn('[VoiceStore] Failed to close video track:', err)
          })
        }
      }
    }

    // Also remove the track from remoteTracks so it won't render
    set((s) => {
      const tracks = s.remoteTracks[pubkey]
      if (!tracks) return {}
      const filtered = tracks.filter((t) => t.kind !== 'video')
      return {
        remoteTracks: {
          ...s.remoteTracks,
          [pubkey]: filtered,
        },
      }
    })
  },
}))

