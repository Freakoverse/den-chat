/**
 * Cloudflare Realtime SFU Provider
 *
 * Implements VoiceProvider using Cloudflare's Realtime SFU REST API.
 * API: POST /apps/{appId}/sessions/new → create session
 *      POST /apps/{appId}/sessions/{sessionId}/tracks/new → push tracks
 *      PUT  /apps/{appId}/sessions/{sessionId}/renegotiate → update SDP
 *
 * All media flows through Cloudflare's edge network (built-in TURN).
 */

import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceParticipant,
  RemoteTrack,
  TrackKind,
  ConnectionState,
  CloudflareConfig,
  DataChannelMessage,
} from './types'
import { supportsE2EE, getE2EESupport, attachSenderEncryption, attachReceiverDecryption } from './e2ee-crypto'

const CF_API_BASE = 'https://rtc.live.cloudflare.com/v1'

interface CFTrackInfo {
  trackName: string
  mid: string
  location: 'local' | 'remote'
  sessionId?: string
}

export class CloudflareProvider implements VoiceProvider {
  readonly providerType = 'cloudflare' as const

  private config: CloudflareConfig
  private pc: RTCPeerConnection | null = null
  private sessionId: string | null = null
  private roomName: string | null = null
  public identity: string | null = null
  private connectionState: ConnectionState = 'disconnected'
  private callbacks: Partial<VoiceProviderCallbacks> = {}
  private participants = new Map<string, VoiceParticipant>()
  public localTracks = new Map<TrackKind, RTCRtpSender>()
  private pausedSenders = new Map<TrackKind, RTCRtpSender>()
  private remoteTracksMap = new Map<string, RemoteTrack[]>()
  private audioElements = new Map<string, HTMLAudioElement>()
  private outputDeviceId: string = ''  // saved output device for new audio elements
  // Maps MID → track name for pulled remote tracks (used to resolve pubkeys)
  private pulledTracksByMid = new Map<string, string>()
  // Negotiation queue — prevents concurrent SDP operations which crash the PeerConnection
  private negotiationQueue: Promise<void> = Promise.resolve()
  private pulledSessions = new Set<string>()   // track which sessions we've already pulled

  // DataChannel state
  private localDataChannel: RTCDataChannel | null = null
  private subscribedDCSessions = new Set<string>()  // sessions we've subscribed DC from

  // Remote speaking detection — AudioContext analysers per remote participant
  private remoteAnalysers = new Map<string, { ctx: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>()
  private speakingDetectionTimer: ReturnType<typeof setInterval> | null = null
  private currentSpeakers = new Set<string>()

  // E2EE
  private e2eeKey: CryptoKey | null = null
  private e2eeRawKeyBytes: Uint8Array | null = null

  constructor(config: CloudflareConfig) {
    this.config = config
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async connect(roomName: string, identity: string): Promise<void> {
    this.roomName = roomName
    this.identity = identity
    this.setConnectionState('connecting')

    try {
      // Fetch ICE servers (with TURN credentials if configured)
      let iceServers = await this.getIceServers()
      const isFirefox = navigator.userAgent.includes('Firefox')

      const hasTurn = iceServers.some((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
        return urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'))
      })

      // Strict relay-only: refuse to connect without TURN.
      // No P2P, no direct connections, no IP exposure — ever.
      if (!hasTurn) {
        throw new Error(
          'Voice connection requires TURN relay for IP privacy. ' +
          'The voice host has not configured TURN credentials. ' +
          'Please ask the hub admin to set up CF TURN keys.'
        )
      }

      this.pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'relay',
        bundlePolicy: 'max-bundle',
        // Required for Chrome's RTCRtpScriptTransform receiver to properly
        // intercept encoded frames. Without this, Chrome's receiver transform
        // is unreliable (some frames slip through still encrypted → artifacting).
        // Firefox ignores this unknown property.
        // To avoid Chrome's multi-video m-section SDP rejection, we ensure
        // only ONE video m-section exists by reusing transceivers (addTrack).
        // @ts-expect-error — encodedInsertableStreams is a Chromium extension
        encodedInsertableStreams: !!this.e2eeKey && supportsE2EE(),
      })
      console.log(`[CF Provider] PeerConnection created, iceTransportPolicy: relay, iceServers: ${iceServers.length}, browser: ${isFirefox ? 'Firefox' : 'Chromium'}`)

      this.pc.ontrack = this.handleRemoteTrack.bind(this)
      let iceRestartAttempts = 0
      let disconnectTimer: ReturnType<typeof setTimeout> | null = null

      this.pc.oniceconnectionstatechange = () => {
        const state = this.pc?.iceConnectionState
        console.log('[CF Provider] ICE state:', state)
        if (state === 'connected' || state === 'completed') {
          iceRestartAttempts = 0
          if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null }
          this.setConnectionState('connected')
        } else if (state === 'disconnected') {
          disconnectTimer = setTimeout(() => {
            if (this.pc?.iceConnectionState === 'disconnected') {
              this.setConnectionState('reconnecting')
            }
          }, 5000)
        } else if (state === 'failed') {
          if (!this.sessionId) {
            console.log('[CF Provider] ICE failed during initial setup (no session yet), ignoring')
            return
          }
          if (iceRestartAttempts < 2 && this.pc) {
            iceRestartAttempts++
            console.log(`[CF Provider] ICE failed, attempting restart #${iceRestartAttempts}`)
            this.setConnectionState('reconnecting')
            this.enqueueNegotiation(() => this._renegotiateInner()).catch((err) => {
              console.error('[CF Provider] ICE restart renegotiation failed:', err)
              this.setConnectionState('failed')
            })
          } else {
            this.setConnectionState('failed')
          }
        }
      }

      // Firefox requires a real audio track (from getUserMedia) added to the PC
      // before ICE gathering will start — without it, iceGatheringState stays 'new'.
      // Acquire a temporary silent track for the initial offer; the real mic track
      // replaces it later via publishTrack().
      let tempStream: MediaStream | null = null
      if (isFirefox) {
        console.log('[CF Provider] Firefox: acquiring temp audio track for ICE gathering')
        try {
          tempStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const tempTrack = tempStream.getAudioTracks()[0]
          this.pc.addTrack(tempTrack, tempStream)
          console.log('[CF Provider] Firefox: temp audio track added')
        } catch (micErr) {
          console.warn('[CF Provider] Firefox: getUserMedia failed, falling back to recvonly:', micErr)
          this.pc.addTransceiver('audio', { direction: 'recvonly' })
        }
      } else {
        // Chrome: a recvonly transceiver is sufficient for ICE gathering
        this.pc.addTransceiver('audio', { direction: 'recvonly' })
      }

      // Log ICE gathering state changes
      this.pc.onicegatheringstatechange = () => {
        console.log(`[CF Provider] ICE gathering state changed: ${this.pc?.iceGatheringState}`)
      }

      // Log each ICE candidate gathered (diagnostic)
      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log(`[CF Provider] ICE candidate: ${event.candidate.type} ${event.candidate.protocol} ${event.candidate.address}:${event.candidate.port}`)
        } else {
          console.log('[CF Provider] ICE candidate gathering complete (null candidate)')
        }
      }

      // Create and apply offer — use parameter-less setLocalDescription()
      await this.pc.setLocalDescription()
      const offer = this.pc.localDescription!
      console.log(`[CF Provider] Offer created+applied, ice-ufrag: ${offer.sdp!.includes('a=ice-ufrag')}`)
      console.log(`[CF Provider] After setLocalDescription: gatheringState=${this.pc.iceGatheringState}, connectionState=${this.pc.iceConnectionState}`)

      // Wait for ICE gathering to complete so the offer contains all candidates.
      // The CF SFU REST API doesn't support trickle ICE — it needs a full offer.
      const gatheredOffer = await this.waitForIceGathering()
      
      // Log how many candidates are in the gathered offer
      const candidateCount = ((gatheredOffer.sdp || '').match(/a=candidate/g) || []).length
      console.log(`[CF Provider] ICE gathering complete, ${candidateCount} candidates in offer, sending to CF`)

      // Create session on Cloudflare with the fully-gathered offer
      const response = await this.cfApiCall('POST', '/sessions/new', {
        sessionDescription: {
          type: 'offer',
          sdp: gatheredOffer.sdp,
        },
      })

      this.sessionId = response.sessionId
      console.log('[CF Provider] Session created:', this.sessionId)

      // Set remote description (fix SFU's answer to match browser expectations)
      const fixedAnswerSdp = this.fixAnswerSdp(response.sessionDescription.sdp, gatheredOffer.sdp!)
      await this.pc.setRemoteDescription(
        new RTCSessionDescription({
          type: 'answer',
          sdp: fixedAnswerSdp,
        }),
      )

      // Wait for ICE to connect before returning
      // CF returns 425 if we push tracks before the PeerConnection is ready
      await this.waitForIceConnected()

      // Stop the temporary Firefox audio track and REMOVE the sender.
      // Critical: if we don't removeTrack(), Firefox reuses the sender's transceiver
      // when publishTrack('audio') is called later. This causes MID conflicts with the SFU
      // and breaks subsequent video/screenshare track publishing.
      if (tempStream) {
        tempStream.getTracks().forEach((t) => t.stop())
        // Remove the dead sender so the transceiver can't be reused
        if (this.pc) {
          for (const sender of this.pc.getSenders()) {
            if (!sender.track || sender.track.readyState === 'ended') {
              try { this.pc.removeTrack(sender) } catch { /* ignore if already removed */ }
            }
          }
        }
        console.log('[CF Provider] Firefox: temp audio track stopped + sender removed')
      }

      this.setConnectionState('connected')
    } catch (err) {
      console.error('[CF Provider] connect failed:', err)
      this.setConnectionState('failed')
      throw err
    }
  }

  async disconnect(): Promise<void> {
    // Close all audio elements
    for (const [, el] of this.audioElements) {
      el.pause()
      el.srcObject = null
    }
    this.audioElements.clear()

    // Clean up spatial sources (if spatial engine didn't clean up first)
    this.spatialSources.clear()

    // Clean up playback GainNodes, then close the single shared output context
    for (const [, entry] of this.gainNodes) {
      try {
        entry.source.disconnect()
        entry.gain.disconnect()
      } catch { /* ignore */ }
    }
    this.gainNodes.clear()
    if (this.outputCtx && this.outputCtx.state !== 'closed') {
      this.outputCtx.close().catch(() => {})
    }
    this.outputCtx = null

    // Close peer connection
    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    // Notify all participants left
    for (const [id] of this.participants) {
      this.callbacks.onParticipantLeft?.(id)
    }

    this.participants.clear()
    this.localTracks.clear()
    this.pausedSenders.clear()
    this.remoteTracksMap.clear()
    this.pulledTracksByMid.clear()
    this.pulledSessions.clear()
    this.negotiationQueue = Promise.resolve()
    this.localDataChannel = null
    this.subscribedDCSessions.clear()
    this.sessionId = null

    // Stop remote speaking detection
    this.stopSpeakingDetection()

    this.setConnectionState('disconnected')
  }

  // ── Media ─────────────────────────────────────────────────

  async publishTrack(track: MediaStreamTrack, kind: TrackKind): Promise<void> {
    return this.enqueueNegotiation(() => this._publishTrackInner(track, kind))
  }

  private async _publishTrackInner(track: MediaStreamTrack, kind: TrackKind): Promise<void> {
    if (!this.pc || !this.sessionId) {
      throw new Error('Not connected')
    }

    // ── Fast path: republish on an existing transceiver ──
    const pausedSender = this.pausedSenders.get(kind)
    if (pausedSender) {
      await pausedSender.replaceTrack(track)
      this.localTracks.set(kind, pausedSender)
      this.pausedSenders.delete(kind)
      console.log(`[CF Provider] Republished ${kind} via replaceTrack (reused transceiver)`)
      return
    }

    // ── First-time publish ──
    const trackName = `${this.identity}:${kind}`

    // For video/screenshare: try to reuse an existing idle recvonly video
    // transceiver (created by pullRemoteTracks). This minimizes video m-sections,
    // which is critical because Chrome + encodedInsertableStreams rejects SDP
    // answers with multiple video m-sections that have inconsistent params.
    //
    // Strategy:
    //  1. Look for an idle recvonly video transceiver → reuse it (sendrecv)
    //  2. If none found, use addTransceiver (creates new m-section)
    //
    // For audio: always use addTransceiver (audio m-sections don't conflict).
    let sender: RTCRtpSender
    let transceiver: RTCRtpTransceiver | undefined

    if (kind === 'video' || kind === 'screenshare') {
      // Find an idle recvonly video transceiver to reuse
      const idleRecvOnly = this.pc.getTransceivers().find(t =>
        t.receiver.track?.kind === 'video' &&
        t.direction === 'recvonly' &&
        !t.sender.track // no track currently sending
      )

      if (idleRecvOnly) {
        // Reuse: set the track on the existing transceiver's sender
        await idleRecvOnly.sender.replaceTrack(track)
        idleRecvOnly.direction = 'sendrecv'
        sender = idleRecvOnly.sender
        transceiver = idleRecvOnly
        console.log(`[CF Provider] ${kind} reusing idle recvonly transceiver MID ${idleRecvOnly.mid}`)
      } else {
        // No idle transceiver — create new one via addTransceiver
        const newTransceiver = this.pc.addTransceiver(track, { direction: 'sendrecv' })
        sender = newTransceiver.sender
        transceiver = newTransceiver
        console.log(`[CF Provider] ${kind} created new transceiver (no idle recvonly available)`)
      }

      // Force VP8 for video consistency
      if (transceiver) {
        try {
          const vp8 = RTCRtpSender.getCapabilities('video')?.codecs?.filter(
            c => c.mimeType.toLowerCase() === 'video/vp8'
          ) || []
          if (vp8.length > 0) {
            transceiver.setCodecPreferences(vp8)
            console.log(`[CF Provider] VP8 codec preference set for ${kind} publish`)
          }
        } catch (e) {
          console.warn('[CF Provider] setCodecPreferences failed:', e)
        }
      }
    } else {
      // Audio: use addTransceiver for a dedicated m-section
      const audioTransceiver = this.pc.addTransceiver(track, { direction: 'sendrecv' })
      sender = audioTransceiver.sender
    }
    this.localTracks.set(kind, sender)

    // Attach E2EE encryption transform if key is set
    if (this.e2eeKey && supportsE2EE()) {
      attachSenderEncryption(sender, this.e2eeKey, this.e2eeRawKeyBytes ?? undefined)
      console.log(`[CF Provider] E2EE encryption attached to ${kind} sender`)
    }

    // Renegotiate with Cloudflare
    await this.pc.setLocalDescription()
    const sdp = this.pc.localDescription!.sdp

    // Resolve MID for this sender's transceiver
    const mid = this.getTrackMid(sender)
    console.log(`[CF Provider] Publishing ${kind} track "${trackName}" with MID ${mid}`)

    try {
      const response = await this.cfApiCall(
        'POST',
        `/sessions/${this.sessionId}/tracks/new`,
        {
          sessionDescription: {
            type: 'offer',
            sdp,
          },
          tracks: [
            {
              trackName,
              location: 'local',
              mid,
            },
          ],
        },
      )

      console.log(`[CF Provider] tracks/new response:`, JSON.stringify(response.tracks || [], null, 2))

      // Apply answer
      if (response.sessionDescription) {
        const answerSdp = this.fixAnswerSdp(response.sessionDescription.sdp, sdp)

        await this.pc.setRemoteDescription(
          new RTCSessionDescription({
            type: 'answer',
            sdp: answerSdp,
          }),
        )
      }

      // Verify the transceiver is actually sending
      const publishedTransceiver = this.pc?.getTransceivers().find(t => t.mid === mid)
      console.log(`[CF Provider] Successfully published ${kind} track (MID ${mid})`,
        `signalingState=${this.pc?.signalingState}`,
        `direction=${publishedTransceiver?.direction}`,
        `currentDirection=${publishedTransceiver?.currentDirection}`,
        `senderTrack=${publishedTransceiver?.sender?.track?.readyState}`
      )
    } catch (err) {
      console.error(`[CF Provider] Failed to publish ${kind} track:`, err)
      this.localTracks.delete(kind)

      // Rollback the PeerConnection to stable state so future negotiations work.
      // Without this, the PC is stuck in 'have-local-offer' and all subsequent
      // setLocalDescription() calls fail with ERROR_CONTENT.
      try {
        await this.pc?.setLocalDescription({ type: 'rollback' })
        console.log('[CF Provider] Rolled back PeerConnection to stable state')
      } catch (rollbackErr) {
        console.warn('[CF Provider] Rollback failed:', rollbackErr)
      }

      try { this.pc?.removeTrack(sender) } catch { /* ignore */ }
      throw err
    }
  }

  async unpublishTrack(kind: TrackKind): Promise<void> {
    // No negotiation needed — just swap the track to null
    const sender = this.localTracks.get(kind)
    if (!sender || !this.pc) return

    // Stop the device track (releases camera/mic hardware)
    const deviceTrack = sender.track
    if (deviceTrack) {
      deviceTrack.stop()
    }

    // Replace with null — stops sending media but keeps the transceiver alive.
    // The SFU still has this MID allocated. No tracks/close, no renegotiation.
    // When republished, replaceTrack(newTrack) resumes media on the same transceiver.
    try {
      await sender.replaceTrack(null)
    } catch (err) {
      console.warn(`[CF Provider] replaceTrack(null) failed for ${kind}:`, err)
    }

    // Move to paused state so publishTrack can reuse the transceiver
    this.localTracks.delete(kind)
    this.pausedSenders.set(kind, sender)
    console.log(`[CF Provider] Paused ${kind} (transceiver kept alive)`)
  }

  setMuted(kind: TrackKind, muted: boolean): void {
    const sender = this.localTracks.get(kind)
    if (sender?.track) {
      sender.track.enabled = !muted
    }
  }

  // ── State ─────────────────────────────────────────────────

  getConnectionState(): ConnectionState {
    return this.connectionState
  }

  getParticipants(): VoiceParticipant[] {
    return Array.from(this.participants.values())
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  // ── Events ────────────────────────────────────────────────

  setCallbacks(callbacks: Partial<VoiceProviderCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  // ── Spatial / Per-User Volume ────────────────────────────────

  // GainNodes for per-user volume boost (when volume > 1.0)
  // Uses createMediaStreamSource (not createMediaElementSource) because
  // the audio elements are backed by WebRTC MediaStreams, not URLs.
  private gainNodes = new Map<string, { ctx: AudioContext; gain: GainNode; source: MediaStreamAudioSourceNode }>()

  // Spatial 3D routing — tracks which audio elements are managed by the spatial engine.
  // When a participant is in this set, setParticipantVolume() skips (engine handles volume).
  private spatialSources = new Set<string>()
  // Per-participant desired volume (0..5) so deafen can restore the right level.
  private userVolumes = new Map<string, number>()
  private outputDeafened = false
  // Makeup gain for Web-Audio playback. <audio>-element playback of a WebRTC stream
  // is quieter/duller than the direct Web-Audio path; we route playback through a
  // GainNode (like the spatial path and other SFU clients) for full loudness/clarity.
  // Unity matches the spatial path; bump slightly if you want it hotter.
  private readonly REMOTE_PLAYBACK_GAIN = 1.0
  // Single shared output AudioContext for ALL remote playback. Chrome caps the
  // number of concurrent AudioContexts (~6), so we must never create one per
  // participant — that would break multi-party calls.
  private outputCtx: AudioContext | null = null

  // Lazily create + resume the single shared output context.
  private getOutputCtx(): AudioContext {
    if (!this.outputCtx || this.outputCtx.state === 'closed') {
      this.outputCtx = new AudioContext()
    }
    if (this.outputCtx.state === 'suspended') this.outputCtx.resume().catch(() => {})
    return this.outputCtx
  }

  setParticipantVolume(participantId: string, volume: number): void {
    // When spatially connected, the spatial engine's GainNode handles volume — skip here
    if (this.spatialSources.has(participantId)) return

    const el = this.audioElements.get(participantId)
    if (!el) return

    const clampedVolume = Math.max(0, Math.min(5, volume))
    this.userVolumes.set(participantId, clampedVolume)

    // Always route playback through a Web Audio GainNode (never the bare <audio>
    // element). Element playback of a WebRTC stream is quieter/duller than the
    // direct Web-Audio path; routing through a GainNode matches the spatial path
    // (and other SFU clients) for loudness/clarity, gives >1 headroom, and lets
    // deafen gate cleanly via the gain.
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
        // Mute native element — GainNode now handles output (prevents double playback)
        el.muted = true
      } catch (err) {
        console.warn('[CF Provider] Failed to create playback GainNode, falling back to element:', err)
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
    // The spatial engine creates the full audio graph (MediaElementSource → GainNode → PannerNode).
    // This method just marks the participant as spatially managed so that:
    // - setParticipantVolume() skips (the engine's GainNode handles volume)
    // - We know to restore direct playback when disconnecting
    const el = this.audioElements.get(participantId)
    if (!el) return

    // Already connected?
    if (this.spatialSources.has(participantId)) return

    // Disconnect any existing volume boost GainNode — spatial takes over
    const existing = this.gainNodes.get(participantId)
    if (existing) {
      // Disconnect the nodes but DON'T close the shared output context.
      try {
        existing.source.disconnect()
        existing.gain.disconnect()
      } catch { /* ignore */ }
      this.gainNodes.delete(participantId)
    }

    // Mark as spatially managed (the engine has already captured the element
    // via createMediaElementSource, so we just track the flag here)
    this.spatialSources.add(participantId)
    console.log(`[CF Provider] Marked ${participantId.slice(0, 8)}... as spatially managed`)
  }

  disconnectFromSpatialNode(participantId: string): void {
    if (!this.spatialSources.has(participantId)) return
    this.spatialSources.delete(participantId)
    // The spatial engine just unmuted the element; re-route playback through our
    // GainNode so non-spatial playback keeps the same loudness/clarity as spatial.
    this.setParticipantVolume(participantId, this.userVolumes.get(participantId) ?? 1)
  }

  // ── Media State ───────────────────────────────────────────

  getPublishedTrackKinds(): TrackKind[] {
    return Array.from(this.localTracks.keys())
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
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId
    for (const [, el] of this.audioElements) {
      try {
        await (el as any).setSinkId(deviceId)
      } catch (err) {
        console.warn('[CF Provider] Failed to set output device:', err)
      }
    }
  }

  // ── Pull Remote Tracks ────────────────────────────────────

  /**
   * Subscribe to another participant's tracks by pulling them
   * into our session from their session.
   */
  async pullRemoteTracks(
    remoteSessionId: string,
    trackNames: string[],
  ): Promise<void> {
    // Dedup at the track level — filter out tracks we've already pulled
    const newTracks = trackNames.filter((t) => !this.pulledSessions.has(`${remoteSessionId}:${t}`))
    if (newTracks.length === 0) {
      console.log(`[CF Provider] All tracks from session ${remoteSessionId} already pulled, skipping`)
      return
    }
    for (const t of newTracks) {
      this.pulledSessions.add(`${remoteSessionId}:${t}`)
    }

    return this.enqueueNegotiation(() => this._pullRemoteTracksInner(remoteSessionId, newTracks))
  }

  clearPulledTrack(remoteSessionId: string, trackName: string): void {
    const key = `${remoteSessionId}:${trackName}`
    if (this.pulledSessions.has(key)) {
      this.pulledSessions.delete(key)
      console.log(`[CF Provider] Cleared pull dedup for ${trackName} (session ${remoteSessionId.slice(0, 8)}...)`)
    }
  }

  private async _pullRemoteTracksInner(
    remoteSessionId: string,
    trackNames: string[],
  ): Promise<void> {
    if (!this.pc || !this.sessionId) return

    console.log(`[CF Provider] Pulling ${trackNames.length} tracks from session ${remoteSessionId}:`, trackNames)

    const tracks = trackNames.map((name) => ({
      trackName: name,
      location: 'remote' as const,
      sessionId: remoteSessionId,
    }))

    // CF SFU requires a matching transceiver in the SDP for each pulled track.
    // Add a recvonly transceiver for each track BEFORE creating the offer.
    for (const name of trackNames) {
      const kind = name.endsWith(':video') || name.endsWith(':screenshare') ? 'video' : 'audio'
      const t = this.pc.addTransceiver(kind, { direction: 'recvonly' })

      // Force VP8 for video — must match publish transceivers
      if (kind === 'video') {
        try {
          const vp8 = RTCRtpReceiver.getCapabilities('video')?.codecs?.filter(
            c => c.mimeType.toLowerCase() === 'video/vp8'
          ) || []
          if (vp8.length > 0) {
            t.setCodecPreferences(vp8)
            console.log('[CF Provider] VP8 codec preference set for video pull')
          }
        } catch (e) {
          console.warn('[CF Provider] setCodecPreferences failed for pull:', e)
        }
      }
    }

    // Create offer — ICE is already established, no need to re-gather
    await this.pc.setLocalDescription()
    const sdp = this.pc.localDescription!.sdp

    const response = await this.cfApiCall(
      'POST',
      `/sessions/${this.sessionId}/tracks/new`,
      {
        sessionDescription: {
          type: 'offer',
          sdp,
        },
        tracks,
      },
    )

    console.log(`[CF Provider] Pull response tracks:`, JSON.stringify(response.tracks || [], null, 2))

    // Store MID → trackName mappings for pubkey resolution in handleRemoteTrack
    if (response.tracks) {
      for (const t of response.tracks) {
        if (t.mid && t.trackName) {
          this.pulledTracksByMid.set(t.mid, t.trackName)
          console.log(`[CF Provider] Mapped MID ${t.mid} → ${t.trackName}`)
        } else {
          console.warn(`[CF Provider] Pull response track missing mid or name:`, JSON.stringify(t))
        }
      }
    } else {
      console.warn(`[CF Provider] Pull response has no tracks array!`)
    }

    console.log(`[CF Provider] Current pulledTracksByMid:`, Object.fromEntries(this.pulledTracksByMid))

    if (response.sessionDescription) {
      const answerSdp = this.fixAnswerSdp(response.sessionDescription.sdp, sdp)

      await this.pc.setRemoteDescription(
        new RTCSessionDescription({
          type: 'answer',
          sdp: answerSdp,
        }),
      )
      console.log(`[CF Provider] Pull setRemoteDescription succeeded`)
    }
  }

  /**
   * Close (unsubscribe from) pulled remote tracks by their MIDs.
   * Calls CF SFU PUT /sessions/{id}/tracks/close to truly stop media flow.
   */
  async closeTracks(trackMids: string[]): Promise<void> {
    if (!this.sessionId || !this.pc || trackMids.length === 0) return
    return this.enqueueNegotiation(() => this._closeTracksInner(trackMids))
  }

  private async _closeTracksInner(mids: string[]): Promise<void> {
    if (!this.sessionId || !this.pc) return

    console.log(`[CF Provider] Closing tracks with MIDs:`, mids)

    // Build tracks array for the API
    const tracks = mids.map(mid => ({ mid }))

    // Also clean up our local mappings
    for (const mid of mids) {
      const trackName = this.pulledTracksByMid.get(mid)
      if (trackName) {
        this.pulledTracksByMid.delete(mid)
        // Find and remove from pulledSessions so it can be re-pulled later
        for (const key of this.pulledSessions) {
          if (key.endsWith(`:${trackName}`)) {
            this.pulledSessions.delete(key)
            break
          }
        }
      }
    }

    try {
      const response = await this.cfApiCall(
        'PUT',
        `/sessions/${this.sessionId}/tracks/close`,
        {
          tracks,
          // Force renegotiation to update the SDP
          force: true,
        },
      )

      // If server returns a new SDP, apply it
      if (response.sessionDescription) {
        await this.pc.setLocalDescription()
        const offerSdp = this.pc.localDescription!.sdp
        const answerSdp = this.fixAnswerSdp(response.sessionDescription.sdp, offerSdp)
        await this.pc.setRemoteDescription(
          new RTCSessionDescription({
            type: 'answer',
            sdp: answerSdp,
          }),
        )
      }

      // Renegotiate to sync state
      await this._renegotiateInner()

      console.log(`[CF Provider] Closed ${mids.length} tracks successfully`)
    } catch (err) {
      console.warn('[CF Provider] closeTracks failed:', err)
      // Even if close fails, renegotiate to sync
      try { await this._renegotiateInner() } catch { /* ignore */ }
    }
  }

  /**
   * Look up MIDs for given track names (e.g. "pubkey:screenshare").
   * Returns an array of MID strings that can be passed to closeTracks().
   */
  getMidsForTrackNames(trackNames: string[]): string[] {
    const mids: string[] = []
    for (const [mid, name] of this.pulledTracksByMid) {
      if (trackNames.includes(name)) {
        mids.push(mid)
      }
    }
    return mids
  }

  // ── Negotiation Queue ────────────────────────────────────

  /**
   * Serialize all SDP operations (publish, unpublish, pull, renegotiate)
   * through a single queue. Concurrent SDP operations on the same
   * RTCPeerConnection cause "InvalidStateError" and crash the connection.
   */
  private enqueueNegotiation<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.negotiationQueue
    const next = prev.then(fn, fn)  // run fn after previous completes (even if it rejected)
    this.negotiationQueue = next.then(() => {}, () => {})  // swallow to keep chain going
    return next
  }

  // ── DataChannel ──────────────────────────────────────────

  async createDataChannel(channelName: string): Promise<void> {
    return this.enqueueNegotiation(() => this._createDataChannelInner(channelName))
  }

  private async _createDataChannelInner(channelName: string): Promise<void> {
    if (!this.pc || !this.sessionId) throw new Error('Not connected')

    console.log(`[CF Provider] Creating local DataChannel: ${channelName}`)

    // 1. Tell CF SFU about the data channel
    const response = await this.cfApiCall(
      'POST',
      `/sessions/${this.sessionId}/datachannels/new`,
      {
        dataChannels: [{
          location: 'local',
          dataChannelName: channelName,
        }],
      },
    )

    console.log('[CF Provider] DataChannel create response:', JSON.stringify(response, null, 2))

    // 2. Extract the server-assigned channel ID (try multiple property names)
    const dcEntry = response.dataChannels?.[0]
    const dcId = dcEntry?.id ?? dcEntry?.dataChannelId ?? dcEntry?.channelId
    if (dcId == null) {
      // If CF doesn't return an ID, fall back to creating a non-negotiated channel
      // and renegotiating via SDP
      console.warn('[CF Provider] No DataChannel ID in response, falling back to SDP renegotiation')
      this.localDataChannel = this.pc.createDataChannel(channelName)
      this.localDataChannel.onopen = () => {
        console.log(`[CF Provider] Local DataChannel '${channelName}' opened (non-negotiated)`)
      }
      this.localDataChannel.onclose = () => {
        console.log(`[CF Provider] Local DataChannel '${channelName}' closed`)
      }
      // Renegotiate to establish the channel
      await this._renegotiateInner()
      return
    }

    console.log(`[CF Provider] CF assigned DataChannel ID: ${dcId}`)
    this.localDataChannel = this.pc.createDataChannel(channelName, {
      negotiated: true,
      id: dcId,
    })
    this.localDataChannel.onopen = () => {
      console.log(`[CF Provider] Local DataChannel '${channelName}' opened (id=${dcId})`)
    }
    this.localDataChannel.onclose = () => {
      console.log(`[CF Provider] Local DataChannel '${channelName}' closed`)
    }

    // 3. Renegotiate if the server requires it
    if (response.requiresImmediateRenegotiation) {
      await this._renegotiateInner()
    }
  }

  async subscribeDataChannel(channelName: string, remoteSessionId: string): Promise<void> {
    // Don't subscribe to the same session twice
    if (this.subscribedDCSessions.has(remoteSessionId)) return
    this.subscribedDCSessions.add(remoteSessionId)

    return this.enqueueNegotiation(() => this._subscribeDataChannelInner(channelName, remoteSessionId))
  }

  private async _subscribeDataChannelInner(channelName: string, remoteSessionId: string): Promise<void> {
    if (!this.pc || !this.sessionId) throw new Error('Not connected')

    console.log(`[CF Provider] Subscribing to DataChannel '${channelName}' from session ${remoteSessionId.slice(0, 8)}...`)

    // 1. Tell CF SFU to subscribe to the remote session's data channel
    const response = await this.cfApiCall(
      'POST',
      `/sessions/${this.sessionId}/datachannels/new`,
      {
        dataChannels: [{
          location: 'remote',
          dataChannelName: channelName,
          sessionId: remoteSessionId,
        }],
      },
    )

    console.log('[CF Provider] DataChannel subscribe response:', JSON.stringify(response, null, 2))

    // 2. Extract the server-assigned channel ID (try multiple property names)
    const dcEntry = response.dataChannels?.[0]
    const dcId = dcEntry?.id ?? dcEntry?.dataChannelId ?? dcEntry?.channelId
    if (dcId == null) {
      // Fallback: listen for ondatachannel event + renegotiate
      console.warn('[CF Provider] No DataChannel ID for subscription, falling back to ondatachannel')
      const dcPromise = new Promise<RTCDataChannel>((resolve) => {
        const handler = (event: RTCDataChannelEvent) => {
          console.log(`[CF Provider] Received remote DataChannel via ondatachannel: ${event.channel.label}`)
          this.pc?.removeEventListener('datachannel', handler)
          resolve(event.channel)
        }
        this.pc!.addEventListener('datachannel', handler)
      })

      // Renegotiate to pull the data channel
      await this._renegotiateInner()

      // Wait for the channel to arrive (with timeout)
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
      const channel = await Promise.race([dcPromise, timeoutPromise])

      if (!channel) {
        console.warn(`[CF Provider] Timeout waiting for DataChannel from session ${remoteSessionId.slice(0, 8)}`)
        this.subscribedDCSessions.delete(remoteSessionId)
        return
      }

      channel.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as DataChannelMessage
          this.callbacks.onDataMessage?.(remoteSessionId, data)
        } catch (err) {
          console.warn('[CF Provider] Failed to parse DataChannel message:', err)
        }
      }

      channel.onclose = () => {
        console.log(`[CF Provider] Subscribed DataChannel from ${remoteSessionId.slice(0, 8)} closed`)
        this.subscribedDCSessions.delete(remoteSessionId)
      }
      return
    }

    console.log(`[CF Provider] CF assigned subscription DataChannel ID: ${dcId}`)
    const channel = this.pc.createDataChannel(`sub-${channelName}`, {
      negotiated: true,
      id: dcId,
    })

    channel.onopen = () => {
      console.log(`[CF Provider] Subscribed DataChannel from ${remoteSessionId.slice(0, 8)} opened (id=${dcId})`)
    }

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as DataChannelMessage
        this.callbacks.onDataMessage?.(remoteSessionId, data)
      } catch (err) {
        console.warn('[CF Provider] Failed to parse DataChannel message:', err)
      }
    }

    channel.onclose = () => {
      console.log(`[CF Provider] Subscribed DataChannel from ${remoteSessionId.slice(0, 8)} closed`)
      this.subscribedDCSessions.delete(remoteSessionId)
    }

    // 3. Renegotiate if the server requires it
    if (response.requiresImmediateRenegotiation) {
      await this._renegotiateInner()
    }
  }

  sendData(data: DataChannelMessage): void {
    if (this.localDataChannel?.readyState === 'open') {
      this.localDataChannel.send(JSON.stringify(data))
    }
  }

  // ── E2EE ──────────────────────────────────────────────────

  setEncryptionKey(key: CryptoKey | null, rawKeyBytes?: Uint8Array): void {
    this.e2eeKey = key
    this.e2eeRawKeyBytes = rawKeyBytes ?? null
    if (key) {
      console.log('[CF Provider] E2EE key set — frame encryption enabled')
    } else {
      console.log('[CF Provider] E2EE key cleared — frame encryption disabled')
    }
  }

  isE2EEEnabled(): boolean {
    return this.e2eeKey !== null && supportsE2EE()
  }

  // ── Private Helpers ───────────────────────────────────────

  private async cfApiCall(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    if (!this.config.cfAppId || !this.config.cfApiToken) {
      throw new Error(
        `Missing Cloudflare credentials: appId=${this.config.cfAppId ? '✓' : '✗'}, token=${this.config.cfApiToken ? '✓' : '✗'}. ` +
        'Check that the voice host event content contains valid CF credentials.'
      )
    }

    const url = `${CF_API_BASE}/apps/${this.config.cfAppId}${path}`
    console.log(`[CF Provider] ${method} ${url}`)

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`CF API ${method} ${path} failed (${res.status}): ${text}`)
    }

    return res.json()
  }

  /**
   * Fetch ICE servers config. If TURN key is configured, generate
   * ephemeral TURN credentials from CF API. Otherwise fall back to STUN only.
   */
  private async getIceServers(): Promise<RTCIceServer[]> {
    // Default: STUN only
    const stun: RTCIceServer[] = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
    ]

    const { cfTurnKeyId, cfTurnToken } = this.config
    if (!cfTurnKeyId || !cfTurnToken) {
      console.log('[CF Provider] No TURN key configured, using STUN only')
      return stun
    }

    try {
      const url = `${CF_API_BASE}/turn/keys/${cfTurnKeyId}/credentials/generate-ice-servers`
      console.log('[CF Provider] Fetching TURN credentials from:', url)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfTurnToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),  // 24h
      })

      if (!res.ok) {
        const text = await res.text()
        console.warn(`[CF Provider] TURN credential fetch failed (${res.status}): ${text}, falling back to STUN`)
        return stun
      }

      const data = await res.json()
      console.log('[CF Provider] TURN API response:', JSON.stringify(data, null, 2))

      if (data.iceServers && Array.isArray(data.iceServers)) {
        // Filter out port 53 (blocked in browsers, causes timeout)
        const filtered = data.iceServers.map((s: RTCIceServer) => ({
          ...s,
          urls: Array.isArray(s.urls)
            ? s.urls.filter((u: string) => !u.includes(':53'))
            : (typeof s.urls === 'string' && s.urls.includes(':53') ? [] : s.urls),
        })).filter((s: RTCIceServer) => {
          // Remove entries with empty URL arrays
          const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
          return urls.length > 0
        })
        console.log('[CF Provider] Using ICE servers:', JSON.stringify(filtered, null, 2))
        return filtered
      } else {
        console.warn('[CF Provider] Unexpected TURN response shape:', data)
      }
    } catch (err) {
      console.warn('[CF Provider] TURN credential fetch error:', err)
    }

    return stun
  }

  /**
   * Wait for ICE gathering to complete so the local description
   * contains all gathered candidates before sending to the SFU.
   */
  private waitForIceGathering(): Promise<RTCSessionDescription> {
    return new Promise((resolve, reject) => {
      if (!this.pc) return reject(new Error('No PeerConnection'))

      // Already gathered
      if (this.pc.iceGatheringState === 'complete') {
        return resolve(this.pc.localDescription!)
      }

      let resolved = false

      const timeout = setTimeout(() => {
        if (resolved) return
        resolved = true
        cleanup()
        // If gathering hasn't completed, use what we have
        console.warn('[CF Provider] ICE gathering timed out, using partial candidates')
        if (this.pc?.localDescription) {
          resolve(this.pc.localDescription)
        } else {
          reject(new Error('ICE gathering timeout and no local description'))
        }
      }, 10_000)

      const finish = () => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(this.pc!.localDescription!)
      }

      // Method 1: icegatheringstatechange (Chromium-preferred)
      const stateHandler = () => {
        const state = this.pc?.iceGatheringState
        console.log('[CF Provider] ICE gathering state:', state)
        if (state === 'complete') {
          finish()
        }
      }

      // Method 2: null candidate (Firefox-preferred, W3C standard)
      // When onicecandidate fires with null, gathering is complete.
      const candidateHandler = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate === null) {
          console.log('[CF Provider] ICE gathering complete (null candidate)')
          finish()
        }
      }

      const cleanup = () => {
        clearTimeout(timeout)
        this.pc?.removeEventListener('icegatheringstatechange', stateHandler)
        this.pc?.removeEventListener('icecandidate', candidateHandler)
      }

      this.pc.addEventListener('icegatheringstatechange', stateHandler)
      this.pc.addEventListener('icecandidate', candidateHandler)
    })
  }

  /**
   * Fix the SFU's answer SDP to be compatible with the browser.
   *
   * The Cloudflare SFU has two issues with its answer SDP:
   * 1. Direction: always 'sendrecv' even for recvonly/sendonly transceivers
   * 2. Extmap: inconsistent RTP header extension IDs across video m-sections,
   *    which Chrome rejects ("Failed to set remote video description send
   *    parameters"). We replace them with the offer's extmaps (always consistent
   *    because the browser generated them).
   */
  private fixAnswerSdp(answerSdp: string, offerSdp: string): string {
    if (!this.pc) return answerSdp

    // Build MID → expected answer direction from local transceivers
    const midDirectionMap = new Map<string, string>()
    for (const t of this.pc.getTransceivers()) {
      if (t.mid == null) continue
      switch (t.direction) {
        case 'sendonly':  midDirectionMap.set(t.mid, 'recvonly'); break
        case 'recvonly':  midDirectionMap.set(t.mid, 'sendonly'); break
        case 'sendrecv':  midDirectionMap.set(t.mid, 'sendrecv'); break
        case 'inactive':  midDirectionMap.set(t.mid, 'inactive'); break
      }
    }

    // Parse offer video m-sections for extmap reference
    const offerVideoExtmaps = new Map<string, string[]>()
    for (const section of offerSdp.split(/(?=m=)/)) {
      if (!section.startsWith('m=video')) continue
      const midMatch = section.match(/a=mid:(\S+)/)
      if (midMatch) {
        const extmaps = section.split(/\r?\n/).filter(l => /^a=extmap:/.test(l))
        if (extmaps.length > 0) {
          offerVideoExtmaps.set(midMatch[1], extmaps)
        }
      }
    }

    // Split answer into m-sections, fix directions and extmaps
    const sections = answerSdp.split(/(?=m=)/)
    let fixed = false

    for (let i = 0; i < sections.length; i++) {
      const midMatch = sections[i].match(/a=mid:(\S+)/)
      if (!midMatch) continue
      const mid = midMatch[1]

      // Fix direction
      const expectedDir = midDirectionMap.get(mid)
      if (expectedDir) {
        const dirRegex = /^a=(sendrecv|sendonly|recvonly|inactive)$/m
        const currentDir = sections[i].match(dirRegex)?.[1]
        if (currentDir && currentDir !== expectedDir) {
          sections[i] = sections[i].replace(dirRegex, `a=${expectedDir}`)
          console.log(`[CF Provider] SDP fix: MID ${mid} dir ${currentDir} → ${expectedDir}`)
          fixed = true
        }
      }

      // Fix video extmap — replace answer's extmap with offer's
      if (sections[i].startsWith('m=video')) {
        const offerExtmaps = offerVideoExtmaps.get(mid)
        if (offerExtmaps && offerExtmaps.length > 0) {
          // Remove answer's extmap lines
          sections[i] = sections[i].replace(/^a=extmap:.+\r?\n?/gm, '')
          // Insert offer's extmap after a=mid line
          const midLine = `a=mid:${mid}`
          const midIdx = sections[i].indexOf(midLine)
          if (midIdx >= 0) {
            const afterMid = midIdx + midLine.length
            const block = '\r\n' + offerExtmaps.join('\r\n')
            sections[i] = sections[i].slice(0, afterMid) + block + sections[i].slice(afterMid)
          }
          console.log(`[CF Provider] SDP fix: MID ${mid} extmap harmonized (${offerExtmaps.length} entries)`)
          fixed = true
        }
      }
    }

    if (fixed) {
      console.log('[CF Provider] Answer SDP fixed')
    }

    return sections.join('')
  }

  private async _renegotiateInner(): Promise<void> {
    if (!this.pc || !this.sessionId) return

    // Create offer — ICE is already established, no need to re-gather
    await this.pc.setLocalDescription()
    const sdp = this.pc.localDescription!.sdp

    const response = await this.cfApiCall(
      'PUT',
      `/sessions/${this.sessionId}/renegotiate`,
      {
        sessionDescription: {
          type: 'offer',
          sdp,
        },
      },
    )

    if (response.sessionDescription) {
      const answerSdp = this.fixAnswerSdp(response.sessionDescription.sdp, sdp)
      await this.pc.setRemoteDescription(
        new RTCSessionDescription({
          type: 'answer',
          sdp: answerSdp,
        }),
      )
    }
  }

  /**
   * Wait for ICE to reach connected/completed before pushing tracks.
   * CF SFU requires the PeerConnection to be connected before accepting
   * track operations (returns HTTP 425 otherwise).
   */
  private waitForIceConnected(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.pc) return reject(new Error('No PeerConnection'))

      const state = this.pc.iceConnectionState
      if (state === 'connected' || state === 'completed') {
        return resolve()
      }

      // Don't immediately reject on 'failed' — Firefox may have fired 'failed'
      // during gathering before the answer was applied. Wait for state changes.

      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`ICE connection timeout (stuck at '${this.pc?.iceConnectionState}')`))
      }, 15_000)

      const handler = () => {
        const s = this.pc?.iceConnectionState
        console.log('[CF Provider] ICE wait state:', s)
        if (s === 'connected' || s === 'completed') {
          cleanup()
          resolve()
        } else if (s === 'closed') {
          cleanup()
          reject(new Error(`ICE connection ${s}`))
        }
        // Note: 'failed' is NOT treated as terminal here.
        // After setRemoteDescription, Firefox may transition:
        //   failed → checking → connected
        // We let the 15s timeout handle truly stuck connections.
      }

      const cleanup = () => {
        clearTimeout(timeout)
        this.pc?.removeEventListener('iceconnectionstatechange', handler)
      }

      this.pc.addEventListener('iceconnectionstatechange', handler)
    })
  }

  private handleRemoteTrack(event: RTCTrackEvent): void {
    const track = event.track
    const stream = event.streams[0] || new MediaStream([track])
    const mid = event.transceiver?.mid || 'unknown'

    // Attach E2EE decryption transform if key is set
    if (this.e2eeKey && supportsE2EE()) {
      attachReceiverDecryption(event.receiver, this.e2eeKey, this.e2eeRawKeyBytes ?? undefined)
      console.log(`[CF Provider] E2EE decryption attached to receiver MID ${mid}`)
    }

    // Look up the track name from our pulled tracks map
    const trackName = this.pulledTracksByMid.get(mid)

    // Skip tracks we didn't explicitly pull (e.g., the dummy recvonly transceiver)
    if (!trackName) {
      console.log(`[CF Provider] Ignoring track with unknown MID ${mid} (not a pulled track). Known MIDs:`, Object.fromEntries(this.pulledTracksByMid))
      return
    }

    // Track names follow format: `<pubkey>:<kind>` (e.g., "abc123...def:audio")
    const colonIdx = trackName.lastIndexOf(':')
    const pubkey = colonIdx > 0 ? trackName.slice(0, colonIdx) : trackName
    const participantId = pubkey

    // Determine kind from track name suffix, not just WebRTC track.kind
    // Track names: `<pubkey>:audio`, `<pubkey>:video`, `<pubkey>:screenshare`
    const kindSuffix = colonIdx > 0 ? trackName.slice(colonIdx + 1) : ''
    const kind: TrackKind = kindSuffix === 'screenshare' ? 'screenshare' : kindSuffix === 'video' ? 'video' : 'audio'
    console.log(`[CF Provider] Remote track received: ${pubkey.slice(0, 8)}...:${kind}, MID ${mid}`)

    const remoteTrack: RemoteTrack = {
      participantId,
      track,
      stream,
      kind,
    }

    // Store
    const existing = this.remoteTracksMap.get(participantId) || []
    existing.push(remoteTrack)
    this.remoteTracksMap.set(participantId, existing)

    // Create audio element for playback + set up speaking detection analyser
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

      // Set up AudioContext analyser for remote speaking detection
      try {
        const ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.85
        const source = ctx.createMediaStreamSource(stream)
        source.connect(analyser)
        this.remoteAnalysers.set(participantId, { ctx, analyser, source })

        // Start the global speaking detection timer if not already running
        if (!this.speakingDetectionTimer) {
          this.startSpeakingDetection()
        }
      } catch (err) {
        console.warn('[CF Provider] Failed to set up speaking detection for', participantId, err)
      }
    }

    // Track participant
    if (!this.participants.has(participantId)) {
      const participant: VoiceParticipant = {
        id: participantId,
        pubkey,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        hasVideo: kind === 'video',
        hasScreenShare: kind === 'screenshare',
      }
      this.participants.set(participantId, participant)
      this.callbacks.onParticipantJoined?.(participant)
    } else {
      // Update existing participant flags
      const existing = this.participants.get(participantId)!
      if (kind === 'video') existing.hasVideo = true
      if (kind === 'screenshare') existing.hasScreenShare = true
      this.participants.set(participantId, existing)
    }

    this.callbacks.onTrackSubscribed?.(remoteTrack)

    // Handle track end
    track.onended = () => {
      this.callbacks.onTrackUnsubscribed?.(participantId, kind)
      const el = this.audioElements.get(participantId)
      if (el) {
        el.pause()
        el.srcObject = null
        this.audioElements.delete(participantId)
      }
      // Tear down the Web-Audio playback graph for this participant (shared ctx stays open)
      const entry = this.gainNodes.get(participantId)
      if (entry) {
        try { entry.source.disconnect(); entry.gain.disconnect() } catch { /* ignore */ }
        this.gainNodes.delete(participantId)
      }
      this.userVolumes.delete(participantId)
      this.spatialSources.delete(participantId)
      // Clean up speaking detection analyser
      this.cleanupRemoteAnalyser(participantId)
    }
  }

  private getTrackMid(sender: RTCRtpSender): string {
    if (!this.pc) return '0'
    const transceivers = this.pc.getTransceivers()
    for (let i = 0; i < transceivers.length; i++) {
      if (transceivers[i].sender === sender) {
        // Prefer the assigned MID, fall back to transceiver index
        const mid = transceivers[i].mid
        if (mid !== null && mid !== undefined) return mid
        console.warn(`[CF Provider] Transceiver ${i} has no MID assigned yet, using index`)
        return String(i)
      }
    }
    console.error('[CF Provider] Could not find transceiver for sender')
    return '0'
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state
    this.callbacks.onConnectionStateChanged?.(state)
  }

  // ── Remote Speaking Detection ──────────────────────────────

  private startSpeakingDetection(): void {
    if (this.speakingDetectionTimer) return

    const THRESHOLD = 12  // RMS threshold (same as local VAD)
    const HOLD_MS = 350   // keep "speaking" for this long after last detection
    const lastAbove = new Map<string, number>()

    this.speakingDetectionTimer = setInterval(() => {
      const now = Date.now()
      const newSpeakers = new Set<string>()

      for (const [participantId, { analyser }] of this.remoteAnalysers) {
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteTimeDomainData(dataArray)

        // RMS calculation
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128
          sum += val * val
        }
        const rms = Math.sqrt(sum / dataArray.length) * 100

        if (rms > THRESHOLD) {
          lastAbove.set(participantId, now)
        }

        const last = lastAbove.get(participantId) || 0
        if ((now - last) < HOLD_MS) {
          newSpeakers.add(participantId)
        }
      }

      // Only emit if the set changed
      const changed = newSpeakers.size !== this.currentSpeakers.size ||
        [...newSpeakers].some((id) => !this.currentSpeakers.has(id))

      if (changed) {
        this.currentSpeakers = newSpeakers
        this.callbacks.onActiveSpeakerChanged?.([...newSpeakers])
      }
    }, 50)  // ~20Hz — responsive enough for visual indicator
  }

  private stopSpeakingDetection(): void {
    if (this.speakingDetectionTimer) {
      clearInterval(this.speakingDetectionTimer)
      this.speakingDetectionTimer = null
    }
    // Cleanup all analysers
    for (const [id] of this.remoteAnalysers) {
      this.cleanupRemoteAnalyser(id)
    }
    this.currentSpeakers.clear()
    this.callbacks.onActiveSpeakerChanged?.([])
  }

  private cleanupRemoteAnalyser(participantId: string): void {
    const entry = this.remoteAnalysers.get(participantId)
    if (entry) {
      entry.source.disconnect()
      entry.ctx.close().catch(() => {})
      this.remoteAnalysers.delete(participantId)
    }
    this.currentSpeakers.delete(participantId)

    // Stop the timer if no more analysers
    if (this.remoteAnalysers.size === 0 && this.speakingDetectionTimer) {
      clearInterval(this.speakingDetectionTimer)
      this.speakingDetectionTimer = null
    }
  }
}
