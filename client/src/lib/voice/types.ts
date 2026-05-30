/**
 * Voice Channel Types & Provider Interface
 *
 * Defines the abstraction layer that both Cloudflare Realtime SFU
 * and self-hosted LiveKit implement. UI code ONLY interacts with
 * VoiceProvider — never with provider-specific APIs directly.
 */

// ─── Provider Configuration ────────────────────────────────────

export type VoiceProviderType = 'cloudflare' | 'livekit'

export interface CloudflareConfig {
  provider: 'cloudflare'
  cfAppId: string
  cfApiToken: string
  cfTurnKeyId?: string     // TURN key ID (from CF dashboard → Realtime → TURN)
  cfTurnToken?: string     // TURN key API token (used to generate ephemeral TURN credentials)
}

export interface LiveKitConfig {
  provider: 'livekit'
  lkUrl: string      // wss://lk.example.com
  lkApiKey: string
  lkApiSecret: string
}

export type VoiceProviderConfig = CloudflareConfig | LiveKitConfig

// ─── Host & Presence (mirroring NIP-CHAT kinds) ────────────────

/** Decoded from kind 36946 Voice Host Availability event */
export interface VoiceHost {
  pubkey: string
  hubDTag: string
  status: 'available' | 'paused'
  providerType: VoiceProviderType
  config: VoiceProviderConfig          // decrypted credentials
  epoch: number                        // hub/group epoch when credentials were encrypted
  createdAt: number
  groupId?: string                     // group scope (undefined = hub-wide)
  encryptedContent?: string            // raw encrypted content for retry decryption
}

/** Decoded from kind 36947 Voice Presence Heartbeat event */
export interface VoicePresence {
  pubkey: string
  hubDTag: string
  channelId: string
  status: 'joined' | 'left'
  hostPubkey: string
  sessionId: string
  position: { x: number; y: number }
  heading: number                      // radians, 0 = up/north
  sphereRadius: number
  cone: number                         // hearing cone percent (0=full circle, 100=tight cone)
  tracks: string[]                     // track names published (e.g. ['pubkey:audio'])
  createdAt: number                    // used for 60s timeout check
}

// ─── Media Track Types ─────────────────────────────────────────

export type TrackKind = 'audio' | 'video' | 'screenshare'

export interface RemoteTrack {
  participantId: string
  track: MediaStreamTrack
  stream: MediaStream
  kind: TrackKind
}

// ─── Connection State ──────────────────────────────────────────

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'reconnecting'
  | 'failed'

// ─── Participant Info ──────────────────────────────────────────

export interface VoiceParticipant {
  id: string          // pubkey or provider-specific ID
  pubkey?: string     // Nostr pubkey (if resolved)
  isMuted: boolean
  isDeafened: boolean
  isSpeaking: boolean
  hasVideo: boolean
  hasScreenShare: boolean
  hasSpatial?: boolean
}

// ─── Provider Event Callbacks ──────────────────────────────────

export interface VoiceProviderCallbacks {
  onTrackSubscribed: (track: RemoteTrack) => void
  onTrackUnsubscribed: (participantId: string, kind: TrackKind) => void
  onParticipantJoined: (participant: VoiceParticipant) => void
  onParticipantLeft: (participantId: string) => void
  onConnectionStateChanged: (state: ConnectionState) => void
  onActiveSpeakerChanged: (participantIds: string[]) => void
  /** Received a DataChannel message from a remote participant */
  onDataMessage: (senderIdentity: string, data: DataChannelMessage) => void
}

// ─── Provider Interface ────────────────────────────────────────

/**
 * Abstract interface that both Cloudflare and LiveKit providers implement.
 * The UI layer ONLY uses this interface — never provider internals.
 */
export interface VoiceProvider {
  readonly providerType: VoiceProviderType

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Create or join a room for the given channel.
   * @param roomName  Unique room identifier (e.g., `hubDTag:channelId`)
   * @param identity  The local user's identity (hex pubkey)
   */
  connect(roomName: string, identity: string): Promise<void>

  /** Gracefully disconnect from the current room */
  disconnect(): Promise<void>

  // ── Media ───────────────────────────────────────────────────

  /** Publish a local media track to the room */
  publishTrack(track: MediaStreamTrack, kind: TrackKind): Promise<void>

  /** Remove a published track */
  unpublishTrack(kind: TrackKind): Promise<void>

  /** Mute/unmute a published track */
  setMuted(kind: TrackKind, muted: boolean): void

  // ── State ───────────────────────────────────────────────────

  /** Current connection state */
  getConnectionState(): ConnectionState

  /** List of currently connected participants */
  getParticipants(): VoiceParticipant[]

  /** The session ID (CF session ID or LK room name) */
  getSessionId(): string | null

  /**
   * Pull (subscribe to) remote tracks from another participant's session.
   * CF SFU-specific: each participant has an independent session,
   * and must explicitly pull tracks from others.
   */
  pullRemoteTracks(remoteSessionId: string, trackNames: string[]): Promise<void>

  /**
   * Clear a pulled-track dedup entry so the same track name can be re-pulled.
   * Called when a remote participant stops and later restarts a track (e.g. video toggle).
   */
  clearPulledTrack(remoteSessionId: string, trackName: string): void

  /**
   * Close (unsubscribe from) remote tracks, stopping media data from flowing.
   * This is a true bandwidth stop — no media bytes are received after closing.
   * The track can be re-pulled later via pullRemoteTracks() + clearPulledTrack().
   */
  closeTracks(trackMids: string[]): Promise<void>

  // ── Events ──────────────────────────────────────────────────

  /** Register callbacks for provider events */
  setCallbacks(callbacks: Partial<VoiceProviderCallbacks>): void

  // ── Spatial (provider-agnostic volume control) ──────────────

  /**
   * Set the playback volume for a remote participant.
   * Used by the SpatialAudioEngine to implement distance-based attenuation.
   * @param participantId  Remote participant ID
   * @param volume         0.0 (silent) to 1.0 (full volume)
   */
  setParticipantVolume(participantId: string, volume: number): void

  /**
   * Get the HTMLAudioElement for a remote participant's audio playback.
   * Used by the SpatialAudioEngine to route audio through Web Audio PannerNodes.
   */
  getAudioElement(participantId: string): HTMLAudioElement | null

  /**
   * Connect a participant's audio element to a spatial audio destination node.
   * When connected, audio is routed through the Web Audio graph instead of
   * playing directly through the element.
   * @param participantId  Remote participant ID
   * @param destination    AudioNode to connect the MediaElementSource to
   * @param ctx            AudioContext that owns the destination node
   */
  connectToSpatialNode(participantId: string, destination: AudioNode, ctx: AudioContext): void

  /**
   * Disconnect a participant's audio from spatial routing, restoring direct playback.
   */
  disconnectFromSpatialNode(participantId: string): void

  // ── Media State ─────────────────────────────────────────────

  /**
   * Get the list of currently published local track kinds.
   * E.g. ['audio', 'video'] if mic + camera are active.
   */
  getPublishedTrackKinds(): TrackKind[]

  /**
   * Set deafen state — mute or unmute all incoming remote audio.
   * Provider handles the implementation (e.g. muting HTMLAudioElements).
   */
  setDeafened(deafened: boolean): void

  /**
   * Set the audio output device for all remote audio playback.
   * Uses HTMLAudioElement.setSinkId() to route to the specified device.
   * @param deviceId  MediaDeviceInfo.deviceId, or '' for system default
   */
  setOutputDevice(deviceId: string): Promise<void>

  // ── DataChannel ─────────────────────────────────────────────

  /**
   * Create a local (publishing) DataChannel.
   * Messages sent via sendData() will be fanned out to all subscribers.
   */
  createDataChannel(channelName: string): Promise<void>

  /**
   * Subscribe to a remote participant's DataChannel.
   * Incoming messages trigger onDataMessage callback.
   */
  subscribeDataChannel(channelName: string, remoteSessionId: string): Promise<void>

  /**
   * Send data to all subscribers of our local DataChannel.
   */
  sendData(data: DataChannelMessage): void

  // ── E2EE ──────────────────────────────────────────────────────

  /**
   * Set the E2EE encryption key for frame-level encryption.
   * When set, all outgoing frames are encrypted and all incoming frames are decrypted.
   * Pass null to disable E2EE.
   * @param key CryptoKey for inline transforms (Chromium), null to disable
   * @param rawKeyBytes Raw key bytes for Worker transfer (Safari/WebKit)
   */
  setEncryptionKey(key: CryptoKey | null, rawKeyBytes?: Uint8Array): void

  /** Whether this provider instance has E2EE active */
  isE2EEEnabled(): boolean
}

// ─── Voice Store State ─────────────────────────────────────────

export interface VoiceState {
  // Connection
  connectionState: ConnectionState
  currentChannelId: string | null
  currentHubDTag: string | null
  currentSessionId: string | null
  currentHostPubkey: string | null
  provider: VoiceProvider | null

  // Local media
  isMuted: boolean
  isVideoEnabled: boolean
  isScreenSharing: boolean
  localAudioTrack: MediaStreamTrack | null
  localVideoTrack: MediaStreamTrack | null
  localScreenTrack: MediaStreamTrack | null

  // Remote participants (from SFU)
  participants: Map<string, VoiceParticipant>
  remoteTracks: Map<string, RemoteTrack[]>
  activeSpeakers: string[]

  // Spatial
  spatialEnabled: boolean
  myPosition: { x: number; y: number }
  mySphereRadius: number

  // Host pool (from kind 36946 events)
  availableHosts: VoiceHost[]

  // Presence (from kind 36947 events, for sidebar display)
  presenceByChannel: Map<string, VoicePresence[]>

  // Timing
  joinedAt: number | null         // for call duration display

  // E2EE
  isE2EE: boolean
}

// ─── Default spatial constants ─────────────────────────────────

export const SPATIAL_DEFAULTS = {
  SPAWN_POSITION: { x: 1000, y: 1000 },
  DEFAULT_SPHERE_RADIUS: 200,
  MAX_SPHERE_RADIUS: 500,
  MIN_SPHERE_RADIUS: 20,
  POSITION_SYNC_THROTTLE_MS: 100,   // ~10 Hz via DataChannel
} as const

// ─── Presence constants ────────────────────────────────────────

export const PRESENCE_CONSTANTS = {
  KEEPALIVE_INTERVAL_MS: 45_000,     // Nostr keepalive every 45s (for sidebar staleness)
  STALE_TIMEOUT_MS: 60_000,          // consider offline after 60s
  STATE_BROADCAST_MS: 100,           // DataChannel state broadcast interval (~10Hz)
} as const

// ─── DataChannel Message Types ─────────────────────────────────

/** State broadcast — sent at ~10Hz via DataChannel */
export interface DCStateMessage {
  type: 'state'
  pos: { x: number; y: number }
  heading: number               // radians, 0 = up/north
  sphere: number
  tracks: string[]  // e.g. ['audio', 'video', 'screenshare']
  muted?: boolean
  deafened?: boolean
  spatial?: boolean
  speaking?: boolean  // local VAD speaking state — used for remote speaking indicators
  e2ee?: boolean      // whether this participant has E2EE enabled
  cone?: number       // hearing cone percent (0=full circle, 100=tight cone)
}

/** Graceful leave notification */
export interface DCLeftMessage {
  type: 'left'
}

export type DataChannelMessage = DCStateMessage | DCLeftMessage
