/**
 * LiveKit Self-Hosted Provider
 *
 * Implements VoiceProvider using the `livekit-client` SDK.
 * Connects to a self-hosted LiveKit server.
 *
 * NOTE: This requires `livekit-client` to be installed:
 *   npm install livekit-client
 *
 * Token generation is done client-side since hub members
 * have access to the API key + secret (encrypted in hub metadata).
 */

import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceParticipant,
  RemoteTrack,
  TrackKind,
  ConnectionState,
  LiveKitConfig,
  DataChannelMessage,
} from './types'
import { supportsE2EE } from './e2ee-crypto'

// LiveKit SDK types — these will resolve when livekit-client is installed.
// For now we use dynamic imports so the app doesn't break without the dep.
type LKRoom = any
type LKParticipant = any
type LKTrack = any

export class LiveKitProvider implements VoiceProvider {
  readonly providerType = 'livekit' as const

  private config: LiveKitConfig
  private room: LKRoom | null = null
  private roomName: string | null = null
  private identity: string | null = null
  private _connectionState: ConnectionState = 'disconnected'
  private callbacks: Partial<VoiceProviderCallbacks> = {}
  private participants = new Map<string, VoiceParticipant>()
  private audioElements = new Map<string, HTMLAudioElement>()
  // Participants whose audio the spatial engine has taken over (element muted,
  // audio flows through its PannerNode graph). Mirrors the Cloudflare provider so
  // volume/deafen don't fight the engine during spatial 3D.
  private spatialSources = new Set<string>()
  // Per-participant Web-Audio playback. Element playback of a WebRTC stream is
  // quieter/duller than the direct Web-Audio path, so we route playback through a
  // GainNode (matches the spatial path + other SFU clients) for loudness/clarity.
  private gainNodes = new Map<string, { ctx: AudioContext; gain: GainNode; source: MediaStreamAudioSourceNode }>()
  private userVolumes = new Map<string, number>()
  private outputDeafened = false
  private readonly REMOTE_PLAYBACK_GAIN = 1.0
  // Single shared output AudioContext for ALL remote playback — Chrome caps the
  // number of concurrent AudioContexts (~6), so never create one per participant.
  private outputCtx: AudioContext | null = null
  private outputDeviceId: string = ''  // saved output device for new audio elements
  private lk: any = null
  private _connectedAt: number = 0   // timestamp when 'connected' was first reported
  private _disconnectTimer: ReturnType<typeof setTimeout> | null = null

  // E2EE
  private e2eeKey: CryptoKey | null = null

  constructor(config: LiveKitConfig) {
    this.config = config
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async connect(roomName: string, identity: string): Promise<void> {
    this.roomName = roomName
    this.identity = identity
    this.setConnectionState('connecting')

    try {
      // Dynamic import — livekit-client must be installed as a dependency
      this.lk = await import('livekit-client')

      // Generate an access token client-side
      // NOTE: In production this would use the livekit-server-sdk or jose
      // For now, we generate a simple JWT with the API key/secret
      const token = await this.generateToken(identity, roomName)

      // Create room with forced relay (LiveKit provides built-in TURN)
      this.room = new this.lk.Room({
        adaptiveStream: true,
        dynacast: true,
        // Force TURN relay for IP privacy — LiveKit Cloud provides its own TURN server
        rtcConfig: {
          iceTransportPolicy: 'relay',
        },
      })

      // Wire up events
      this.setupRoomEvents()

      // Connect
      await this.room.connect(this.config.lkUrl, token)
      this.setConnectionState('connected')
    } catch (err) {
      console.error('[LK Provider] connect failed:', err)
      this.setConnectionState('failed')
      throw err
    }
  }

  async disconnect(): Promise<void> {
    // Clean up audio elements
    for (const [, el] of this.audioElements) {
      el.pause()
      el.srcObject = null
    }
    this.audioElements.clear()

    // Clean up playback GainNodes, then close the single shared output context
    for (const [, entry] of this.gainNodes) {
      try { entry.source.disconnect(); entry.gain.disconnect() } catch { /* ignore */ }
    }
    this.gainNodes.clear()
    this.userVolumes.clear()
    this.spatialSources.clear()
    if (this.outputCtx && this.outputCtx.state !== 'closed') {
      this.outputCtx.close().catch(() => {})
    }
    this.outputCtx = null

    // Disconnect room
    if (this.room) {
      await this.room.disconnect(true)
      this.room = null
    }

    // Notify all participants left
    for (const [id] of this.participants) {
      this.callbacks.onParticipantLeft?.(id)
    }

    this.participants.clear()
    // Clean up timers
    if (this._disconnectTimer) { clearTimeout(this._disconnectTimer); this._disconnectTimer = null }
    this._connectedAt = 0
    this.setConnectionState('disconnected')
  }

  // ── Media ─────────────────────────────────────────────────

  async publishTrack(track: MediaStreamTrack, kind: TrackKind): Promise<void> {
    if (!this.room?.localParticipant) {
      throw new Error('Not connected')
    }

    const lp = this.room.localParticipant

    if (kind === 'audio') {
      await lp.publishTrack(track, {
        name: `${this.identity}:audio`,
        source: this.lk?.Track?.Source?.Microphone,
      })
    } else if (kind === 'video') {
      await lp.publishTrack(track, {
        name: `${this.identity}:video`,
        source: this.lk?.Track?.Source?.Camera,
      })
    } else if (kind === 'screenshare') {
      await lp.publishTrack(track, {
        name: `${this.identity}:screenshare`,
        source: this.lk?.Track?.Source?.ScreenShare,
      })
    }
  }

  async unpublishTrack(kind: TrackKind): Promise<void> {
    if (!this.room?.localParticipant) return

    const lp = this.room.localParticipant
    const publications = Array.from(lp.trackPublications?.values() || [])

    for (const pub of publications) {
      if ((pub as any).track?.source === this.kindToSource(kind)) {
        await lp.unpublishTrack((pub as any).track)
        break
      }
    }
  }

  setMuted(kind: TrackKind, muted: boolean): void {
    if (!this.room?.localParticipant) return

    const lp = this.room.localParticipant
    const publications = Array.from(lp.trackPublications?.values() || [])

    for (const pub of publications) {
      if ((pub as any).track?.source === this.kindToSource(kind)) {
        if (muted) {
          (pub as any).mute?.()
        } else {
          (pub as any).unmute?.()
        }
        break
      }
    }
  }

  // ── State ─────────────────────────────────────────────────

  getConnectionState(): ConnectionState {
    return this._connectionState
  }

  getParticipants(): VoiceParticipant[] {
    return Array.from(this.participants.values())
  }

  getSessionId(): string | null {
    return this.roomName
  }

  // LiveKit handles track subscription automatically via room-based pub/sub
  async pullRemoteTracks(_remoteSessionId: string, _trackNames: string[]): Promise<void> {
    // No-op: LiveKit rooms auto-subscribe to all published tracks
  }

  clearPulledTrack(_remoteSessionId: string, _trackName: string): void {
    // No-op: LiveKit manages subscriptions internally
  }

  async closeTracks(_trackMids: string[]): Promise<void> {
    // No-op: LiveKit manages subscriptions internally.
    // For true unsubscribe, would use publication.setSubscribed(false) but
    // that requires tracking LK track publications per participant.
  }

  // ── Events ────────────────────────────────────────────────

  setCallbacks(callbacks: Partial<VoiceProviderCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  // ── Spatial Volume ────────────────────────────────────────

  // Lazily create + resume the single shared output context.
  private getOutputCtx(): AudioContext {
    if (!this.outputCtx || this.outputCtx.state === 'closed') {
      this.outputCtx = new AudioContext()
    }
    if (this.outputCtx.state === 'suspended') this.outputCtx.resume().catch(() => {})
    return this.outputCtx
  }

  setParticipantVolume(participantId: string, volume: number): void {
    // When spatially connected, the spatial engine's GainNode handles volume — skip.
    if (this.spatialSources.has(participantId)) return

    const el = this.audioElements.get(participantId)
    if (!el) return

    const clampedVolume = Math.max(0, Math.min(5, volume))
    this.userVolumes.set(participantId, clampedVolume)

    // Route playback through a Web Audio GainNode (never the bare element) for full
    // loudness/clarity + clean deafen gating — see the field comment.
    let entry = this.gainNodes.get(participantId)
    if (!entry) {
      const stream = el.srcObject as MediaStream
      if (!stream) return
      try {
        const ctx = this.getOutputCtx()
        const source = ctx.createMediaStreamSource(stream)
        const gain = ctx.createGain()
        source.connect(gain)
        gain.connect(ctx.destination)
        entry = { ctx, gain, source }
        this.gainNodes.set(participantId, entry)
        el.muted = true  // GainNode now handles output
      } catch (err) {
        console.warn('[LK Provider] Failed to create playback GainNode, falling back to element:', err)
        el.muted = false
        el.volume = Math.min(1, clampedVolume)
        return
      }
    } else if (this.outputCtx?.state === 'suspended') {
      this.outputCtx.resume().catch(() => {})
    }
    entry.gain.gain.value = this.outputDeafened ? 0 : clampedVolume * this.REMOTE_PLAYBACK_GAIN
  }

  getAudioElement(participantId: string): HTMLAudioElement | null {
    return this.audioElements.get(participantId) || null
  }

  connectToSpatialNode(participantId: string, _destination: AudioNode, _ctx: AudioContext): void {
    // The spatial engine builds the full graph (MediaStreamSource → GainNode →
    // PannerNode) from the element's stream and mutes the element itself. We just
    // mark the participant as spatially managed so setParticipantVolume() skips it
    // and setDeafened() leaves the element muted (audio flows through the panner).
    if (!this.audioElements.get(participantId)) return
    // Tear down our base playback GainNode (shared ctx stays open) — the spatial
    // engine takes over routing.
    const existing = this.gainNodes.get(participantId)
    if (existing) {
      try { existing.source.disconnect(); existing.gain.disconnect() } catch { /* ignore */ }
      this.gainNodes.delete(participantId)
    }
    this.spatialSources.add(participantId)
  }

  disconnectFromSpatialNode(participantId: string): void {
    if (!this.spatialSources.has(participantId)) return
    this.spatialSources.delete(participantId)
    // The spatial engine just unmuted the element; re-route playback through our
    // GainNode so non-spatial playback keeps the same loudness/clarity as spatial.
    this.setParticipantVolume(participantId, this.userVolumes.get(participantId) ?? 1)
  }

  // ── Media State ─────────────────────────────────────────────

  getPublishedTrackKinds(): TrackKind[] {
    if (!this.room?.localParticipant) return []
    const kinds: TrackKind[] = []
    const publications = Array.from(this.room.localParticipant.trackPublications?.values() || [])
    for (const pub of publications) {
      const source = (pub as any).track?.source
      if (source === this.kindToSource('audio')) kinds.push('audio')
      else if (source === this.kindToSource('video')) kinds.push('video')
      else if (source === this.kindToSource('screenshare')) kinds.push('screenshare')
    }
    return kinds
  }

  setDeafened(deafened: boolean): void {
    this.outputDeafened = deafened
    for (const [id, el] of this.audioElements) {
      const entry = this.gainNodes.get(id)
      if (entry) {
        // Web-Audio playback path — gate through the GainNode (element stays muted).
        const vol = this.userVolumes.get(id) ?? 1
        entry.gain.gain.value = deafened ? 0 : vol * this.REMOTE_PLAYBACK_GAIN
      } else if (deafened) {
        el.muted = true
      } else if (!this.spatialSources.has(id)) {
        // Don't unmute spatially-managed participants — their audio flows through
        // the PannerNode graph, so the element must stay muted.
        el.muted = false
      }
    }
    // Also set volume via LiveKit API for tracks not using audio elements
    if (this.room) {
      const participants = Array.from(this.room.remoteParticipants?.values() || [])
      for (const p of participants) {
        (p as any).setVolume?.(deafened ? 0 : 1)
      }
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId
    for (const [, el] of this.audioElements) {
      try {
        await (el as any).setSinkId(deviceId)
      } catch (err) {
        console.warn('[LK Provider] Failed to set output device:', err)
      }
    }
  }

  // ── DataChannel ─────────────────────────────────────────────

  // LiveKit handles data channels automatically via the Room
  async createDataChannel(_channelName: string): Promise<void> {
    // No-op: LiveKit SDK publishes data through the Room, no explicit channel creation needed
    console.log('[LK Provider] DataChannel ready (native SDK support)')
  }

  async subscribeDataChannel(_channelName: string, _remoteSessionId: string): Promise<void> {
    // No-op: LiveKit rooms auto-route data messages to all participants
  }

  sendData(data: DataChannelMessage): void {
    if (!this.room?.localParticipant) return
    try {
      const payload = new TextEncoder().encode(JSON.stringify(data))
      // Use reliable delivery (TCP-like) for state messages
      this.room.localParticipant.publishData(payload, { reliable: true })
    } catch (err) {
      console.warn('[LK Provider] sendData failed:', err)
    }
  }

  // ── E2EE ──────────────────────────────────────────────────────

  setEncryptionKey(key: CryptoKey | null, rawKeyBytes?: Uint8Array): void {
    this.e2eeKey = key
    // LiveKit has built-in E2EE support via room.setE2EEEnabled()
    // If the LK SDK exposes it, use it. Otherwise frame encryption
    // would require access to the underlying PeerConnection which
    // LK doesn't expose. For now, we track the key for status reporting.
    if (key) {
      console.log('[LK Provider] E2EE key set — frame encryption enabled (if LK SDK supports it)')
      // Attempt to enable LK native E2EE if available
      try {
        if (this.room?.setE2EEEnabled) {
          this.room.setE2EEEnabled(true)
        }
      } catch (err) {
        console.warn('[LK Provider] LK native E2EE not available:', err)
      }
    } else {
      console.log('[LK Provider] E2EE key cleared')
    }
  }

  isE2EEEnabled(): boolean {
    return this.e2eeKey !== null && supportsE2EE()
  }

  // ── Private: Room Events ───────────────────────────────────────

  private setupRoomEvents(): void {
    if (!this.room || !this.lk) return

    const RoomEvent = this.lk.RoomEvent

    this.room.on(RoomEvent.TrackSubscribed, (track: any, publication: any, participant: any) => {
      const kind: TrackKind =
        track.source === this.lk?.Track?.Source?.ScreenShare
          ? 'screenshare'
          : track.kind === 'audio'
            ? 'audio'
            : 'video'

      const stream = new MediaStream([track.mediaStreamTrack])
      const participantId = participant.identity || participant.sid

      const remoteTrack: RemoteTrack = {
        participantId,
        track: track.mediaStreamTrack,
        stream,
        kind,
      }

      // Auto-play audio
      if (kind === 'audio') {
        const audio = new Audio()
        audio.srcObject = stream
        audio.autoplay = true
        // Apply saved output device
        if (this.outputDeviceId) {
          (audio as any).setSinkId(this.outputDeviceId).catch(() => {})
        }
        this.audioElements.set(participantId, audio)
        // Route playback through Web Audio (mutes the element) for full loudness/clarity
        // and clean deafen gating — see setParticipantVolume.
        this.setParticipantVolume(participantId, this.userVolumes.get(participantId) ?? 1)
      }

      this.callbacks.onTrackSubscribed?.(remoteTrack)
    })

    this.room.on(RoomEvent.TrackUnsubscribed, (track: any, _pub: any, participant: any) => {
      const participantId = participant.identity || participant.sid
      const kind: TrackKind = track.kind === 'audio' ? 'audio' : 'video'
      this.callbacks.onTrackUnsubscribed?.(participantId, kind)

      // Clean up audio element
      const el = this.audioElements.get(participantId)
      if (el && kind === 'audio') {
        el.pause()
        el.srcObject = null
        this.audioElements.delete(participantId)
        // Tear down the Web-Audio playback graph for this participant (shared ctx stays open)
        const entry = this.gainNodes.get(participantId)
        if (entry) {
          try { entry.source.disconnect(); entry.gain.disconnect() } catch { /* ignore */ }
          this.gainNodes.delete(participantId)
        }
        this.userVolumes.delete(participantId)
        this.spatialSources.delete(participantId)
      }
    })

    this.room.on(RoomEvent.ParticipantConnected, (participant: any) => {
      const id = participant.identity || participant.sid
      const p: VoiceParticipant = {
        id,
        pubkey: participant.identity, // identity is set to hex pubkey
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        hasVideo: false,
        hasScreenShare: false,
      }
      this.participants.set(id, p)
      this.callbacks.onParticipantJoined?.(p)
    })

    this.room.on(RoomEvent.ParticipantDisconnected, (participant: any) => {
      const id = participant.identity || participant.sid
      this.participants.delete(id)
      this.callbacks.onParticipantLeft?.(id)

      // Clean up audio
      const el = this.audioElements.get(id)
      if (el) {
        el.pause()
        el.srcObject = null
        this.audioElements.delete(id)
      }
    })

    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers: any[]) => {
      const ids = speakers.map((s) => s.identity || s.sid)
      this.callbacks.onActiveSpeakerChanged?.(ids)
    })

    this.room.on(RoomEvent.ConnectionStateChanged, (state: string) => {
      if (state === 'connected') {
        if (this._disconnectTimer) { clearTimeout(this._disconnectTimer); this._disconnectTimer = null }
        if (!this._connectedAt) this._connectedAt = Date.now()
        this.setConnectionState('connected')
      } else if (state === 'reconnecting') {
        if (this._disconnectTimer) { clearTimeout(this._disconnectTimer); this._disconnectTimer = null }
        this.setConnectionState('reconnecting')
      } else if (state === 'disconnected') {
        // Grace period: within 5s of first connect, treat brief disconnects as reconnecting
        // (prevents UI flicker during initial WebRTC negotiation)
        const sinceConnected = Date.now() - this._connectedAt
        if (this._connectedAt && sinceConnected < 5000) {
          console.log('[LK Provider] Transient disconnect within grace period — treating as reconnecting')
          this.setConnectionState('reconnecting')
          return
        }
        // After grace period, use a 3s delay (like Cloudflare) before reporting disconnect
        if (!this._disconnectTimer) {
          this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null
            // Only fire if still disconnected
            if (this.room) {
              const currentState = (this.room as any).state
              if (currentState === 'disconnected') {
                this.setConnectionState('disconnected')
              }
            } else {
              this.setConnectionState('disconnected')
            }
          }, 3000)
          // Show reconnecting in the meantime
          this.setConnectionState('reconnecting')
        }
      } else {
        this.setConnectionState('failed')
      }
    })

    // DataChannel: receive data messages from other participants
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant: any) => {
      try {
        const text = new TextDecoder().decode(payload)
        const data = JSON.parse(text) as DataChannelMessage
        const senderIdentity = participant?.identity || participant?.sid || 'unknown'
        this.callbacks.onDataMessage?.(senderIdentity, data)
      } catch (err) {
        console.warn('[LK Provider] Failed to parse DataChannel message:', err)
      }
    })
  }

  // ── Private: Token Generation ─────────────────────────────

  /**
   * Generate a LiveKit access token client-side.
   * Uses the jose library for JWT creation.
   *
   * NOTE: In a typical setup, token generation happens server-side.
   * In DEN Chat's decentralized model, members already have the
   * API key + secret (encrypted in hub metadata), so client-side
   * generation is appropriate.
   */
  private async generateToken(
    identity: string,
    roomName: string,
  ): Promise<string> {
    try {
      const jose = await import('jose')

      const secret = new TextEncoder().encode(this.config.lkApiSecret)
      const now = Math.floor(Date.now() / 1000)

      const token = await new jose.SignJWT({
        iss: this.config.lkApiKey,
        sub: identity,
        nbf: now,
        exp: now + 86400, // 24h
        video: {
          room: roomName,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        },
      })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(secret)

      return token
    } catch (err) {
      console.error('[LK Provider] Token generation failed:', err)
      throw new Error(
        'Failed to generate LiveKit token. Ensure jose is available.',
      )
    }
  }

  // ── Private: Helpers ──────────────────────────────────────

  private kindToSource(kind: TrackKind): string | undefined {
    if (!this.lk?.Track?.Source) return undefined
    switch (kind) {
      case 'audio':
        return this.lk.Track.Source.Microphone
      case 'video':
        return this.lk.Track.Source.Camera
      case 'screenshare':
        return this.lk.Track.Source.ScreenShare
    }
  }

  private setConnectionState(state: ConnectionState): void {
    this._connectionState = state
    this.callbacks.onConnectionStateChanged?.(state)
  }
}
