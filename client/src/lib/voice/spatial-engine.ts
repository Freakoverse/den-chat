/**
 * SpatialAudioEngine — Dual-mode spatial audio (3D HRTF + scalar fallback)
 *
 * 3D Mode (HRTF):
 *   Uses Web Audio PannerNode with HRTF panningModel for full directional
 *   audio (left/right + front/back). Each remote participant gets a dedicated
 *   audio graph: MediaElementSource → GainNode → PannerNode → destination.
 *   The local user's position and heading control the AudioListener.
 *
 * Scalar Mode (legacy fallback):
 *   Distance-based volume attenuation only, no panning.
 *   volume = clamp(1 - distance / sphereRadius, 0, 1)
 *
 * The engine manages the shared AudioContext when in 3D mode.
 * Provider audio elements are wired into the graph via connectParticipantAudio().
 */

import type { VoiceProvider } from './types'

export interface SpatialParticipant {
  id: string           // pubkey or participant ID
  position: { x: number; y: number }
  heading: number      // radians, 0 = up/north (visual only in 3D mode)
}

export interface SpatialEngineCallbacks {
  /** Called each tick with computed volume per participant (scalar mode only) */
  onVolumeUpdate: (participantId: string, volume: number) => void
}

/**
 * Audio graph nodes for a single remote participant in 3D mode.
 * MediaStreamSource → GainNode → PannerNode → ctx.destination
 * The HTMLAudioElement is muted while spatial routing is active.
 */
interface Participant3DNodes {
  source: MediaStreamAudioSourceNode
  gain: GainNode
  panner: PannerNode
  element: HTMLAudioElement
}

export class SpatialAudioEngine {
  private myPosition: { x: number; y: number } = { x: 0, y: 0 }
  private myHeading: number = 0  // radians, 0 = up/north (negative Y)
  private mySphereRadius: number = 50
  private myConePercent: number = 0  // 0 = full circle, 100 = tight cone (30°)
  private participants: Map<string, SpatialParticipant> = new Map()
  private callbacks: SpatialEngineCallbacks | null = null
  private timerId: ReturnType<typeof setTimeout> | null = null
  private running = false
  private is3D = true

  // Per-user volume multipliers (from the volume slider, 0-5 range)
  // Applied on top of spatial attenuation so boost works in spatial mode.
  private userVolumes: Map<string, number> = new Map()

  // 3D mode state
  private ctx: AudioContext | null = null
  private participantNodes: Map<string, Participant3DNodes> = new Map()

  // Scalar mode cache
  private lastVolumes: Map<string, number> = new Map()

  // Provider reference for connecting audio elements
  private provider: VoiceProvider | null = null

  setCallbacks(callbacks: SpatialEngineCallbacks): void {
    this.callbacks = callbacks
  }

  setProvider(provider: VoiceProvider): void {
    this.provider = provider
  }

  set3DEnabled(enabled: boolean): void {
    if (this.is3D === enabled) return
    this.is3D = enabled

    if (enabled) {
      // Switching to 3D — create AudioContext and re-connect all existing participants
      this.initAudioContext()
      this.reconnectAll3D()
    } else {
      // Switching to scalar — tear down 3D graph, restore direct playback
      this.teardown3DAll()
    }
  }

  get3DEnabled(): boolean {
    return this.is3D
  }

  updateMyPosition(x: number, y: number): void {
    this.myPosition = { x, y }
    // Listener stays at origin — instead, recompute all PannerNode positions
    // relative to the new listener position
    this.updateAllPannerPositions()
  }

  updateMyHeading(heading: number): void {
    this.myHeading = heading
    this.updateListener()
  }

  updateMySphereRadius(radius: number): void {
    this.mySphereRadius = radius
    // Update maxDistance on all existing PannerNodes
    if (this.is3D) {
      for (const [, nodes] of this.participantNodes) {
        nodes.panner.maxDistance = radius
      }
    }
  }

  updateMyConePercent(percent: number): void {
    this.myConePercent = Math.max(0, Math.min(100, percent))
  }

  /** Set per-user volume (0-5 range). Applied on top of spatial attenuation. */
  setUserVolume(participantId: string, volume: number): void {
    this.userVolumes.set(participantId, volume)
    // Immediately apply to 3D GainNode if connected
    if (this.is3D) {
      const nodes = this.participantNodes.get(participantId)
      if (nodes) {
        const participant = this.participants.get(participantId)
        const coneAtten = (this.myConePercent > 0 && participant)
          ? this.computeConeAttenuation(participant.position) : 1.0
        nodes.gain.gain.value = coneAtten * volume
      }
    }
  }

  updateParticipant(participant: SpatialParticipant): void {
    this.participants.set(participant.id, participant)

    // Update PannerNode position in 3D mode
    if (this.is3D) {
      const nodes = this.participantNodes.get(participant.id)
      if (nodes) {
        this.setPannerPosition(nodes.panner, participant.position)
      }
    }
  }

  removeParticipant(id: string): void {
    this.participants.delete(id)
    this.lastVolumes.delete(id)
    this.disconnect3DParticipant(id)
  }

  /**
   * Connect a participant's audio to the 3D graph.
   * Uses MediaStreamAudioSourceNode (from the stream, NOT from the element)
   * and mutes the HTMLAudioElement to prevent double audio.
   */
  connectParticipantAudio(participantId: string): void {
    if (!this.is3D || !this.provider) return

    const el = this.provider.getAudioElement(participantId)
    if (!el) return

    // Already connected to THIS element? If a node exists but points at a stale
    // element/stream (the participant disconnected and rejoined with a fresh track),
    // tear it down and rebuild below — otherwise the rejoiner plays flat (un-
    // spatialized) until spatial is toggled off/on.
    const existing = this.participantNodes.get(participantId)
    if (existing) {
      const stream0 = el.srcObject as MediaStream | null
      if (existing.element === el && existing.source.mediaStream === stream0) return
      this.disconnect3DParticipant(participantId)
    }

    const stream = el.srcObject as MediaStream
    if (!stream) return

    this.ensureAudioContext()
    if (!this.ctx) return

    // Ensure the participant exists in the map (may not have received DC state yet)
    if (!this.participants.has(participantId)) {
      this.participants.set(participantId, {
        id: participantId,
        position: { x: 250, y: 250 },  // default spawn position
        heading: 0,
      })
    }

    try {
      // Create the audio graph from the raw MediaStream:
      // MediaStreamSource → GainNode → PannerNode → destination
      // This avoids createMediaElementSource which permanently captures elements.
      const source = this.ctx.createMediaStreamSource(stream)
      const gain = this.ctx.createGain()
      // Apply current cone attenuation × user volume immediately
      const participant = this.participants.get(participantId)!
      const coneAtten = this.myConePercent > 0
        ? this.computeConeAttenuation(participant.position) : 1.0
      const userVol = this.userVolumes.get(participantId) ?? 1.0
      gain.gain.value = coneAtten * userVol

      const panner = this.ctx.createPanner()
      panner.panningModel = 'HRTF'
      panner.distanceModel = 'linear'
      panner.refDistance = 1
      panner.maxDistance = this.mySphereRadius
      panner.rolloffFactor = 1
      // No cone — omnidirectional
      panner.coneInnerAngle = 360
      panner.coneOuterAngle = 360
      panner.coneOuterGain = 1

      source.connect(gain)
      gain.connect(panner)
      panner.connect(this.ctx.destination)

      // Set initial position from participant data
      this.setPannerPosition(panner, participant.position)

      this.participantNodes.set(participantId, { source, gain, panner, element: el })

      // Mute the HTMLAudioElement — audio now flows exclusively through PannerNode
      el.muted = true

      // Tell the provider we've taken over audio routing
      this.provider.connectToSpatialNode(participantId, gain, this.ctx)
    } catch (err) {
      console.warn('[SpatialEngine] Failed to connect 3D audio for', participantId, err)
    }
  }

  start(): void {
    if (this.running) return
    this.running = true

    if (this.is3D) {
      this.initAudioContext()
      this.reconnectAll3D()
    }

    this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }

    // In scalar mode, reset all volumes to 1.0
    if (!this.is3D) {
      for (const [id] of this.participants) {
        this.callbacks?.onVolumeUpdate(id, 1.0)
      }
    }

    this.lastVolumes.clear()
  }

  destroy(): void {
    this.stop()
    this.teardown3DAll()
    this.participants.clear()
    this.lastVolumes.clear()
    this.callbacks = null
    this.provider = null
  }

  // ── Private ──

  private tick = (): void => {
    if (!this.running) return

    if (this.is3D) {
      // In 3D mode, PannerNodes handle distance attenuation and HRTF panning.
      // But we need to apply cone attenuation manually via the GainNode.
      if (this.ctx?.state === 'suspended') {
        this.ctx.resume().catch(() => {})
      }
      // Apply cone attenuation × per-user volume to each participant's GainNode
      for (const [id, nodes] of this.participantNodes) {
        const participant = this.participants.get(id)
        if (!participant) continue
        const coneAtten = this.myConePercent > 0
          ? this.computeConeAttenuation(participant.position) : 1.0
        const userVol = this.userVolumes.get(id) ?? 1.0
        nodes.gain.gain.value = coneAtten * userVol
      }
    } else {
      // Scalar mode — compute distance-based volume * cone attenuation
      for (const [id, participant] of this.participants) {
        const dx = participant.position.x - this.myPosition.x
        const dy = participant.position.y - this.myPosition.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        let volume = Math.max(0, Math.min(1, 1 - distance / this.mySphereRadius))

        // Apply cone attenuation
        if (this.myConePercent > 0) {
          volume *= this.computeConeAttenuation(participant.position)
        }

        // Apply per-user volume boost
        const userVol = this.userVolumes.get(id) ?? 1.0
        volume *= userVol

        const lastVol = this.lastVolumes.get(id) ?? -1
        if (Math.abs(volume - lastVol) > 0.01) {
          this.lastVolumes.set(id, volume)
          this.callbacks?.onVolumeUpdate(id, volume)
        }
      }
    }

    this.timerId = setTimeout(this.tick, 50) // ~20 Hz
  }

  /**
   * Compute hearing cone attenuation for a participant at the given position.
   * Returns 0..1 where 1 = fully within cone, 0 = fully outside.
   * Uses a smooth rolloff zone at the cone edges.
   */
  private computeConeAttenuation(pos: { x: number; y: number }): number {
    const dx = pos.x - this.myPosition.x
    const dy = pos.y - this.myPosition.y
    if (dx === 0 && dy === 0) return 1 // same position

    // Direction from me to participant (same convention as heading: 0=up, atan2(dx, -dy))
    const dirToParticipant = Math.atan2(dx, -dy)
    let angleDiff = dirToParticipant - this.myHeading
    // Normalize to [-PI, PI]
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI
    const absAngle = Math.abs(angleDiff)

    // Cone half-angle: PI (360°) at 0% → PI/12 (15°) at 100%
    const halfCone = Math.PI * (1 - this.myConePercent / 100 * (1 - 1 / 12))
    // Smooth rolloff zone: 10° outside the cone edge
    const fadeZone = Math.PI / 18

    if (absAngle <= halfCone) {
      return 1.0
    } else if (absAngle <= halfCone + fadeZone) {
      return 1 - (absAngle - halfCone) / fadeZone
    } else {
      return 0.0
    }
  }

  private ensureAudioContext(): void {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext()
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
  }

  private initAudioContext(): void {
    this.ensureAudioContext()
    this.updateListener()
  }

  /**
   * Update the AudioListener's orientation (heading).
   * The listener ALWAYS stays at origin (0,0,0) — positions are relative.
   * Only orientation changes when heading changes.
   * Heading 0 = facing up (negative Z in audio space).
   */
  private updateListener(): void {
    if (!this.ctx) return
    const listener = this.ctx.listener

    // Listener stays at origin — PannerNode positions are relative offsets
    if (listener.positionX !== undefined) {
      listener.positionX.value = 0
      listener.positionY.value = 0
      listener.positionZ.value = 0
    } else {
      (listener as any).setPosition(0, 0, 0)
    }

    // Forward direction from heading (0 = up = negative Z in audio)
    const fwdX = Math.sin(this.myHeading)
    const fwdZ = -Math.cos(this.myHeading)

    if (listener.forwardX !== undefined) {
      listener.forwardX.value = fwdX
      listener.forwardY.value = 0
      listener.forwardZ.value = fwdZ
      listener.upX.value = 0
      listener.upY.value = 1
      listener.upZ.value = 0
    } else {
      (listener as any).setOrientation(fwdX, 0, fwdZ, 0, 1, 0)
    }
  }

  /**
   * Set a PannerNode's position RELATIVE to the listener.
   * Computes (remote - myPos) so listener stays at origin.
   * X → audio X (left/right), world Y → audio Z (front/back), audio Y = 0.
   */
  private setPannerPosition(panner: PannerNode, pos: { x: number; y: number }): void {
    const relX = pos.x - this.myPosition.x
    const relZ = pos.y - this.myPosition.y
    if (panner.positionX !== undefined) {
      panner.positionX.value = relX
      panner.positionY.value = 0
      panner.positionZ.value = relZ
    } else {
      (panner as any).setPosition(relX, 0, relZ)
    }
  }

  /**
   * Recompute ALL PannerNode positions (called when local user moves).
   * Since positions are relative to the listener, every panner must update.
   */
  private updateAllPannerPositions(): void {
    for (const [id, nodes] of this.participantNodes) {
      const participant = this.participants.get(id)
      if (participant) {
        this.setPannerPosition(nodes.panner, participant.position)
      }
    }
  }

  /**
   * Reconnect all known participants to 3D audio graph.
   * Called when switching from scalar to 3D mode.
   */
  private reconnectAll3D(): void {
    for (const [id] of this.participants) {
      this.connectParticipantAudio(id)
    }
  }

  /**
   * Tear down a single participant's 3D nodes and restore direct playback.
   */
  private disconnect3DParticipant(id: string): void {
    const nodes = this.participantNodes.get(id)
    if (!nodes) return

    try {
      nodes.source.disconnect()
      nodes.gain.disconnect()
      nodes.panner.disconnect()
    } catch { /* already disconnected */ }

    // Unmute the HTMLAudioElement — restore direct playback
    nodes.element.muted = false

    this.participantNodes.delete(id)

    // Tell provider spatial routing is no longer active
    if (this.provider) {
      this.provider.disconnectFromSpatialNode(id)
    }
  }

  /**
   * Tear down all 3D nodes and close the AudioContext.
   */
  private teardown3DAll(): void {
    for (const [id] of this.participantNodes) {
      this.disconnect3DParticipant(id)
    }
    this.participantNodes.clear()

    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
    }
  }
}
