/**
 * SpatialPanel — 2D draggable canvas for spatial audio positioning
 *
 * Features:
 * - Full-width/height canvas that fills its container
 * - Large world space (2000×2000) with camera/viewport + zoom
 * - Mouse scroll / trackpad pinch to zoom in/out
 * - Drag your dot with mouse
 * - WASD / Arrow key movement when canvas is focused
 * - Sphere radius visualized as translucent circle
 * - Remote participant positions from presence data
 * - Sphere radius slider
 */

import { useRef, useEffect, useCallback, useState } from 'react'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

// World space
const WORLD_SIZE = 2000
const DOT_RADIUS = 14       // in world units (larger for avatars)
const KEY_SPEED = 2.5       // world units per frame
const MIN_ZOOM = 0.15
const MAX_ZOOM = 3.0
const DEFAULT_ZOOM = 0.6

interface RemoteParticipantDot {
  pubkey: string
  x: number
  y: number
  heading: number
  isSpeaking: boolean
  sphereRadius: number
  cone: number  // 0 = full circle, 100 = tight cone
}

/**
 * Draw a hearing zone shape that morphs from a full circle (cone=0)
 * to a tight directional sector (cone=100).
 *
 * Canvas arc angles: 0 = right. Heading convention: 0 = up = -PI/2 in canvas.
 */
function drawHearingSector(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  heading: number, conePercent: number,
  fillColor: string, strokeColor: string,
  lineWidth: number, dashed: boolean,
): void {
  // Cone half-angle: PI (full circle 360°) at 0% → PI/12 (15° = 30° total) at 100%
  const halfAngle = Math.PI * (1 - conePercent / 100 * (1 - 1 / 12))

  ctx.beginPath()
  if (halfAngle >= Math.PI - 0.01) {
    // Full circle — no need for sector path
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  } else {
    // Sector: heading to canvas angle (heading 0=up → canvas -PI/2)
    const canvasAngle = heading - Math.PI / 2
    const startAngle = canvasAngle - halfAngle
    const endAngle = canvasAngle + halfAngle
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, radius, startAngle, endAngle)
    ctx.closePath()
  }

  ctx.fillStyle = fillColor
  ctx.fill()
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = lineWidth
  if (dashed) ctx.setLineDash([4, 4])
  ctx.stroke()
  if (dashed) ctx.setLineDash([])
}

export function SpatialPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isFocused, setIsFocused] = useState(false)

  // Camera state (viewport center in world coords + zoom level)
  const cameraRef = useRef({ x: 1000, y: 1000, zoom: DEFAULT_ZOOM })

  // Profile pictures
  const { getProfile } = useProfileCache()
  const myPubkey = useUserStore((s) => s.pubkey)

  // Image cache: url → HTMLImageElement (loaded)
  const imgCacheRef = useRef<Map<string, HTMLImageElement | 'loading' | 'failed'>>(new Map())

  /** Load an image into the cache. Returns the image if ready, null otherwise. */
  const getImage = useCallback((url: string): HTMLImageElement | null => {
    const cache = imgCacheRef.current
    const entry = cache.get(url)
    if (entry === 'loading' || entry === 'failed') return null
    if (entry instanceof HTMLImageElement) return entry

    // Start loading
    cache.set(url, 'loading')
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      cache.set(url, img)
      // Trigger redraw
      drawRef.current()
    }
    img.onerror = () => {
      cache.set(url, 'failed')
    }
    img.src = url
    return null
  }, [])

  // Store state
  const myPosition = useVoiceStore((s) => s.myPosition)
  const myHeading = useVoiceStore((s) => s.myHeading)
  const mySphereRadius = useVoiceStore((s) => s.mySphereRadius)
  const updatePosition = useVoiceStore((s) => s.updatePosition)
  const updateHeading = useVoiceStore((s) => s.updateHeading)
  const updateSphereRadius = useVoiceStore((s) => s.updateSphereRadius)
  const spatial3DEnabled = useVoiceStore((s) => s.spatial3DEnabled)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const isSpeakingLocal = useVoiceStore((s) => s._isSpeaking)
  const presenceByHub = useVoiceStore((s) => s.presenceByHub)
  const currentHubDTag = useVoiceStore((s) => s.currentHubDTag)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const myConePercent = useVoiceStore((s) => s.myConePercent)
  const updateConePercent = useVoiceStore((s) => s.updateConePercent)

  // Dragging state
  const isDragging = useRef(false)
  const keysHeld = useRef<Set<string>>(new Set())
  const animFrameRef = useRef<number | null>(null)
  const drawRef = useRef<() => void>(() => {})

  // Smoothed positions for remote participants (interpolated at 60fps)
  const smoothedPositions = useRef<Map<string, { x: number; y: number; heading: number; sphereRadius: number }>>(new Map())

  // Center camera on self when panel first opens
  useEffect(() => {
    const pos = useVoiceStore.getState().myPosition
    cameraRef.current.x = pos.x
    cameraRef.current.y = pos.y
  }, [])

  // Build target positions from presence data + update smoothed positions
  const remoteTargets: (RemoteParticipantDot & { targetX: number; targetY: number; targetHeading: number; targetSphere: number })[] = []
  const activeKeys = new Set<string>()
  if (currentHubDTag) {
    const presences = presenceByHub[currentHubDTag] || []
    for (const p of presences) {
      if (
        p.channelId === currentChannelId &&
        p.status === 'joined' &&
        participants[p.pubkey]
      ) {
        activeKeys.add(p.pubkey)
        const smooth = smoothedPositions.current.get(p.pubkey)
        if (!smooth) {
          // First time seeing this participant — snap to their position
          smoothedPositions.current.set(p.pubkey, { x: p.position.x, y: p.position.y, heading: p.heading ?? 0, sphereRadius: p.sphereRadius })
        }
        const current = smoothedPositions.current.get(p.pubkey)!
        remoteTargets.push({
          pubkey: p.pubkey,
          x: current.x,    // displayed (smoothed) position
          y: current.y,
          heading: current.heading,
          isSpeaking: participants[p.pubkey]?.isSpeaking ?? activeSpeakers.includes(p.pubkey),
          sphereRadius: current.sphereRadius,
          cone: p.cone ?? 0,
          targetX: p.position.x,
          targetY: p.position.y,
          targetHeading: p.heading ?? 0,
          targetSphere: p.sphereRadius,
        })
      }
    }
  }
  // Clean up stale entries
  for (const key of smoothedPositions.current.keys()) {
    if (!activeKeys.has(key)) smoothedPositions.current.delete(key)
  }
  const remoteTargetsRef = useRef(remoteTargets)
  remoteTargetsRef.current = remoteTargets

  // Alias for the draw function
  const remoteDots = remoteTargets

  // ── Coordinate transforms ──

  /** World coords → canvas pixel coords */
  const worldToScreen = useCallback((wx: number, wy: number, canvasW: number, canvasH: number) => {
    const cam = cameraRef.current
    return {
      sx: (wx - cam.x) * cam.zoom + canvasW / 2,
      sy: (wy - cam.y) * cam.zoom + canvasH / 2,
    }
  }, [])

  /** Canvas pixel coords → world coords */
  const screenToWorld = useCallback((sx: number, sy: number, canvasW: number, canvasH: number) => {
    const cam = cameraRef.current
    return {
      wx: (sx - canvasW / 2) / cam.zoom + cam.x,
      wy: (sy - canvasH / 2) / cam.zoom + cam.y,
    }
  }, [])

  // ── Draw the canvas ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Use CSS dimensions (not buffer) since ctx has setTransform(dpr) applied
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const cam = cameraRef.current

    // Clear
    ctx.clearRect(0, 0, w, h)

    // Background
    ctx.fillStyle = '#111318'
    ctx.fillRect(0, 0, w, h)

    // ── Grid lines (world-space aligned) ──
    const gridSpacing = 100  // world units between grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 1

    // Calculate visible world range
    const worldLeft = cam.x - (w / 2) / cam.zoom
    const worldRight = cam.x + (w / 2) / cam.zoom
    const worldTop = cam.y - (h / 2) / cam.zoom
    const worldBottom = cam.y + (h / 2) / cam.zoom

    // Vertical grid lines
    const startX = Math.floor(worldLeft / gridSpacing) * gridSpacing
    for (let gx = startX; gx <= worldRight; gx += gridSpacing) {
      const { sx } = worldToScreen(gx, 0, w, h)
      ctx.beginPath()
      ctx.moveTo(sx, 0)
      ctx.lineTo(sx, h)
      ctx.stroke()
    }

    // Horizontal grid lines
    const startY = Math.floor(worldTop / gridSpacing) * gridSpacing
    for (let gy = startY; gy <= worldBottom; gy += gridSpacing) {
      const { sy } = worldToScreen(0, gy, w, h)
      ctx.beginPath()
      ctx.moveTo(0, sy)
      ctx.lineTo(w, sy)
      ctx.stroke()
    }

    // ── World boundary ──
    const topLeft = worldToScreen(0, 0, w, h)
    const botRight = worldToScreen(WORLD_SIZE, WORLD_SIZE, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 2
    ctx.strokeRect(topLeft.sx, topLeft.sy, botRight.sx - topLeft.sx, botRight.sy - topLeft.sy)

    // ── My hearing zone (circle or cone sector) ──
    const myScreen = worldToScreen(myPosition.x, myPosition.y, w, h)
    const radiusPixels = mySphereRadius * cam.zoom
    drawHearingSector(ctx, myScreen.sx, myScreen.sy, radiusPixels, myHeading, myConePercent,
      'rgba(16, 185, 129, 0.06)', 'rgba(16, 185, 129, 0.2)', 1.5, false)

    // ── Remote participant dots ──
    const baseDotR = DOT_RADIUS * cam.zoom
    for (const dot of remoteDots) {
      const pos = worldToScreen(dot.x, dot.y, w, h)
      const dotR = Math.max(6, baseDotR)
      const remoteRadiusPx = dot.sphereRadius * cam.zoom

      // Skip if completely off screen (use sphere radius for broader check)
      if (pos.sx < -remoteRadiusPx || pos.sx > w + remoteRadiusPx || pos.sy < -remoteRadiusPx || pos.sy > h + remoteRadiusPx) continue

      // Remote hearing zone (circle or cone sector, low opacity)
      drawHearingSector(ctx, pos.sx, pos.sy, remoteRadiusPx, dot.heading, dot.cone,
        'rgba(156, 163, 175, 0.03)', 'rgba(156, 163, 175, 0.1)', 1, true)

      // Speaking glow ring
      if (dot.isSpeaking) {
        ctx.beginPath()
        ctx.arc(pos.sx, pos.sy, dotR + 4, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(16, 185, 129, 0.3)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Avatar or fallback dot
      const profile = getProfile(dot.pubkey)
      const picUrl = profile?.picture
      const img = picUrl ? getImage(picUrl) : null

      ctx.save()
      ctx.beginPath()
      ctx.arc(pos.sx, pos.sy, dotR, 0, Math.PI * 2)
      ctx.closePath()

      if (img) {
        // Circular clipped profile picture
        ctx.clip()
        ctx.drawImage(img, pos.sx - dotR, pos.sy - dotR, dotR * 2, dotR * 2)
      } else {
        // Fallback: colored circle with initial
        ctx.fillStyle = dot.isSpeaking ? '#10b981' : '#4b5563'
        ctx.fill()
        // Draw initial letter
        const name = profile?.display_name || profile?.name || dot.pubkey.slice(0, 4)
        const initial = name.charAt(0).toUpperCase()
        const initFontSize = Math.max(8, dotR * 1.0)
        ctx.fillStyle = '#fff'
        ctx.font = `bold ${initFontSize}px Inter, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(initial, pos.sx, pos.sy + 1)
      }
      ctx.restore()

      // Border ring
      ctx.beginPath()
      ctx.arc(pos.sx, pos.sy, dotR, 0, Math.PI * 2)
      ctx.strokeStyle = dot.isSpeaking ? 'rgba(16, 185, 129, 0.8)' : 'rgba(255,255,255,0.25)'
      ctx.lineWidth = dot.isSpeaking ? 2 : 1.5
      ctx.stroke()

      // Name label
      const displayName = profile?.display_name || profile?.name || dot.pubkey.slice(0, 8)
      const fontSize = Math.max(9, Math.min(12, 10 * cam.zoom))
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.font = `500 ${fontSize}px Inter, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(displayName, pos.sx, pos.sy - dotR - 5)

      // Heading cone (direction indicator)
      if (spatial3DEnabled) {
        const coneLen = dotR * 1.8
        const coneHalf = 0.35  // half-angle in radians (~20°)
        const tipX = pos.sx + Math.sin(dot.heading) * coneLen
        const tipY = pos.sy - Math.cos(dot.heading) * coneLen
        const leftX = pos.sx + Math.sin(dot.heading - coneHalf) * dotR
        const leftY = pos.sy - Math.cos(dot.heading - coneHalf) * dotR
        const rightX = pos.sx + Math.sin(dot.heading + coneHalf) * dotR
        const rightY = pos.sy - Math.cos(dot.heading + coneHalf) * dotR
        ctx.beginPath()
        ctx.moveTo(leftX, leftY)
        ctx.lineTo(tipX, tipY)
        ctx.lineTo(rightX, rightY)
        ctx.fillStyle = dot.isSpeaking ? 'rgba(16, 185, 129, 0.35)' : 'rgba(156, 163, 175, 0.25)'
        ctx.fill()
      }
    }

    // ── My dot (draw last so it's on top) ──
    const myR = Math.max(8, (DOT_RADIUS + 4) * cam.zoom)
    // Speaking/presence glow
    ctx.beginPath()
    ctx.arc(myScreen.sx, myScreen.sy, myR + 4, 0, Math.PI * 2)
    ctx.fillStyle = isSpeakingLocal ? 'rgba(16, 185, 129, 0.3)' : 'rgba(99, 102, 241, 0.2)'
    ctx.fill()
    if (isSpeakingLocal) {
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // My avatar or fallback
    const myProfile = myPubkey ? getProfile(myPubkey) : undefined
    const myPicUrl = myProfile?.picture
    const myImg = myPicUrl ? getImage(myPicUrl) : null

    ctx.save()
    ctx.beginPath()
    ctx.arc(myScreen.sx, myScreen.sy, myR, 0, Math.PI * 2)
    ctx.closePath()

    if (myImg) {
      ctx.clip()
      ctx.drawImage(myImg, myScreen.sx - myR, myScreen.sy - myR, myR * 2, myR * 2)
    } else {
      ctx.fillStyle = isSpeakingLocal ? '#10b981' : '#6366f1'
      ctx.fill()
      const myName = myProfile?.display_name || myProfile?.name || 'Y'
      const myInitial = myName.charAt(0).toUpperCase()
      const myInitFontSize = Math.max(10, myR * 1.0)
      ctx.fillStyle = '#fff'
      ctx.font = `bold ${myInitFontSize}px Inter, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(myInitial, myScreen.sx, myScreen.sy + 1)
    }
    ctx.restore()

    // My border ring
    ctx.beginPath()
    ctx.arc(myScreen.sx, myScreen.sy, myR, 0, Math.PI * 2)
    ctx.strokeStyle = isSpeakingLocal ? 'rgba(16, 185, 129, 0.8)' : '#a5b4fc'
    ctx.lineWidth = isSpeakingLocal ? 2.5 : 2.5
    ctx.stroke()

    // "You" label
    const labelSize = Math.max(10, Math.min(13, 11 * cam.zoom))
    ctx.fillStyle = '#e0e7ff'
    ctx.font = `600 ${labelSize}px Inter, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('You', myScreen.sx, myScreen.sy - myR - 6)

    // My heading cone
    if (spatial3DEnabled) {
      const coneLen = myR * 1.8
      const coneHalf = 0.35
      const tipX = myScreen.sx + Math.sin(myHeading) * coneLen
      const tipY = myScreen.sy - Math.cos(myHeading) * coneLen
      const leftX = myScreen.sx + Math.sin(myHeading - coneHalf) * myR
      const leftY = myScreen.sy - Math.cos(myHeading - coneHalf) * myR
      const rightX = myScreen.sx + Math.sin(myHeading + coneHalf) * myR
      const rightY = myScreen.sy - Math.cos(myHeading + coneHalf) * myR
      ctx.beginPath()
      ctx.moveTo(leftX, leftY)
      ctx.lineTo(tipX, tipY)
      ctx.lineTo(rightX, rightY)
      ctx.fillStyle = 'rgba(99, 102, 241, 0.4)'
      ctx.fill()
    }

    // ── Zoom indicator ──
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.font = '10px Inter, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(cam.zoom * 100)}%`, w - 8, h - 8)
  }, [myPosition, myHeading, mySphereRadius, myConePercent, spatial3DEnabled, isSpeakingLocal, remoteDots, worldToScreen])

  // ── Size canvas buffer to match CSS layout size ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let lastW = 0
    let lastH = 0

    const resize = () => {
      // Use the CSS layout size (set by w-full h-full)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // Guard against zero and no-change
      if (w === 0 || h === 0) return
      if (w === lastW && h === lastH) return
      lastW = w
      lastH = h
      const dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw()
    }

    resize()
    // Observe the container, not the canvas, to avoid feedback loop
    const container = containerRef.current
    if (container) {
      const observer = new ResizeObserver(resize)
      observer.observe(container)
      return () => observer.disconnect()
    }
  }, [draw])

  // ── Redraw on state changes ──
  useEffect(() => {
    drawRef.current = draw
    draw()
  }, [draw])

  // ── Smooth interpolation loop for remote positions (60fps) ──
  // Also monitors speaking state changes and triggers redraws for those.
  const lastSpeakingLocalRef = useRef(false)
  const lastActiveSpeakersRef = useRef<string[]>([])
  const lastParticipantSpeakingRef = useRef<Record<string, boolean>>({})
  useEffect(() => {
    const LERP_FACTOR = 0.18  // 0 = no movement, 1 = instant snap. 0.15-0.2 = buttery smooth
    const SNAP_THRESHOLD = 0.5  // snap if <0.5 world units away (prevents infinite drift)
    let rafId: number

    const interpolate = () => {
      let needsRedraw = false
      const targets = remoteTargetsRef.current
      for (const t of targets) {
        const smooth = smoothedPositions.current.get(t.pubkey)
        if (!smooth) continue

        const dx = t.targetX - smooth.x
        const dy = t.targetY - smooth.y
        const ds = t.targetSphere - smooth.sphereRadius
        // Heading: interpolate via shortest angular distance
        let dh = t.targetHeading - smooth.heading
        // Normalize to [-PI, PI]
        while (dh > Math.PI) dh -= 2 * Math.PI
        while (dh < -Math.PI) dh += 2 * Math.PI

        if (Math.abs(dx) > SNAP_THRESHOLD || Math.abs(dy) > SNAP_THRESHOLD || Math.abs(ds) > 1 || Math.abs(dh) > 0.02) {
          smooth.x += dx * LERP_FACTOR
          smooth.y += dy * LERP_FACTOR
          smooth.sphereRadius += ds * LERP_FACTOR
          smooth.heading += dh * LERP_FACTOR
          needsRedraw = true
        } else if (dx !== 0 || dy !== 0 || ds !== 0 || dh !== 0) {
          // Close enough — snap
          smooth.x = t.targetX
          smooth.y = t.targetY
          smooth.sphereRadius = t.targetSphere
          smooth.heading = t.targetHeading
          needsRedraw = true
        }
      }

      // Check speaking state changes at 60fps for instant visual feedback
      const nowLocalSpeaking = useVoiceStore.getState()._isSpeaking
      if (nowLocalSpeaking !== lastSpeakingLocalRef.current) {
        lastSpeakingLocalRef.current = nowLocalSpeaking
        needsRedraw = true
      }
      const nowActiveSpeakers = useVoiceStore.getState().activeSpeakers
      if (nowActiveSpeakers !== lastActiveSpeakersRef.current) {
        lastActiveSpeakersRef.current = nowActiveSpeakers
        needsRedraw = true
      }
      // Check DC-broadcast participant speaking states (primary source for remote users)
      const nowParticipants = useVoiceStore.getState().participants
      for (const [id, p] of Object.entries(nowParticipants)) {
        const wasSpeaking = lastParticipantSpeakingRef.current[id]
        if (p.isSpeaking !== wasSpeaking) {
          lastParticipantSpeakingRef.current[id] = p.isSpeaking
          needsRedraw = true
        }
      }

      if (needsRedraw) {
        drawRef.current()
      }

      rafId = requestAnimationFrame(interpolate)
    }

    rafId = requestAnimationFrame(interpolate)
    return () => cancelAnimationFrame(rafId)
  }, [])

  // ── Mouse scroll → zoom ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const cam = cameraRef.current
      const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08
      cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * zoomFactor))
      draw()
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [draw])

  // ── Touch pinch → zoom (centered on pinch midpoint) ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let lastPinchDist = 0
    let lastPinchMid = { x: 0, y: 0 }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        // Cancel any single-finger drag/pan when second finger arrives
        isDragging.current = false
        isPanning.current = false

        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        lastPinchDist = Math.sqrt(dx * dx + dy * dy)
        lastPinchMid = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        const dist = Math.sqrt(dx * dx + dy * dy)
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2

        if (lastPinchDist > 0) {
          const cam = cameraRef.current
          const rect = canvas.getBoundingClientRect()

          // Convert pinch midpoint to world coords BEFORE zoom change
          const cssX = midX - rect.left
          const cssY = midY - rect.top
          const worldX = (cssX - rect.width / 2) / cam.zoom + cam.x
          const worldY = (cssY - rect.height / 2) / cam.zoom + cam.y

          // Apply zoom
          const scale = dist / lastPinchDist
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * scale))
          cam.zoom = newZoom

          // Adjust camera so the pinch midpoint stays at the same screen position
          cam.x = worldX - (cssX - rect.width / 2) / newZoom
          cam.y = worldY - (cssY - rect.height / 2) / newZoom

          draw()
        }
        lastPinchDist = dist
        lastPinchMid = { x: midX, y: midY }
      }
    }

    const onTouchEnd = () => {
      lastPinchDist = 0
    }

    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('touchend', onTouchEnd)
    return () => {
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
    }
  }, [draw])

  // ── Mouse drag ──
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    // Check if clicking on my dot (CSS-pixel coords)
    const myScreen = worldToScreen(myPosition.x, myPosition.y, canvas.clientWidth, canvas.clientHeight)
    const dist = Math.sqrt((sx - myScreen.sx) ** 2 + (sy - myScreen.sy) ** 2)
    const hitRadius = Math.max(12, (DOT_RADIUS + 10) * cameraRef.current.zoom)
    if (dist < hitRadius) {
      isDragging.current = true
    }
  }, [myPosition, worldToScreen])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const { wx, wy } = screenToWorld(sx, sy, canvas.clientWidth, canvas.clientHeight)
    const clampedX = Math.max(0, Math.min(WORLD_SIZE, wx))
    const clampedY = Math.max(0, Math.min(WORLD_SIZE, wy))
    updatePosition(clampedX, clampedY)
    // Don't move camera during drag — avoids feedback loop
  }, [screenToWorld, updatePosition])

  const handleMouseUp = useCallback(() => {
    if (isDragging.current) {
      isDragging.current = false

      // Smooth camera pan to final dot position over ~0.2s
      const targetPos = useVoiceStore.getState().myPosition
      const startX = cameraRef.current.x
      const startY = cameraRef.current.y
      const duration = 200 // ms
      const startTime = performance.now()

      const animate = (now: number) => {
        const elapsed = now - startTime
        const t = Math.min(1, elapsed / duration)
        // Ease-out quad
        const ease = 1 - (1 - t) * (1 - t)
        cameraRef.current.x = startX + (targetPos.x - startX) * ease
        cameraRef.current.y = startY + (targetPos.y - startY) * ease
        drawRef.current()
        if (t < 1) {
          requestAnimationFrame(animate)
        }
      }
      requestAnimationFrame(animate)
    }
  }, [])

  // ── Touch drag (single finger) — dot drag or camera pan ──
  const isPanning = useRef(false)
  const lastTouchPos = useRef({ x: 0, y: 0 })

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length !== 1) return // only single-finger
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const touch = e.touches[0]
    const sx = touch.clientX - rect.left
    const sy = touch.clientY - rect.top

    // Check if touching the dot (CSS-pixel coords, generous hit area for touch)
    const myScreen = worldToScreen(myPosition.x, myPosition.y, canvas.clientWidth, canvas.clientHeight)
    const dist = Math.sqrt((sx - myScreen.sx) ** 2 + (sy - myScreen.sy) ** 2)
    const hitRadius = Math.max(24, (DOT_RADIUS + 16) * cameraRef.current.zoom)
    if (dist < hitRadius) {
      isDragging.current = true
    } else {
      // Not on dot — start camera pan
      isPanning.current = true
      lastTouchPos.current = { x: touch.clientX, y: touch.clientY }
    }
    e.preventDefault()
  }, [myPosition, worldToScreen])

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length !== 1) return
    e.preventDefault()
    const touch = e.touches[0]

    if (isDragging.current) {
      // Drag the dot
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const sx = touch.clientX - rect.left
      const sy = touch.clientY - rect.top
      const { wx, wy } = screenToWorld(sx, sy, canvas.clientWidth, canvas.clientHeight)
      const clampedX = Math.max(0, Math.min(WORLD_SIZE, wx))
      const clampedY = Math.max(0, Math.min(WORLD_SIZE, wy))
      updatePosition(clampedX, clampedY)
    } else if (isPanning.current) {
      // Pan the camera
      const dx = touch.clientX - lastTouchPos.current.x
      const dy = touch.clientY - lastTouchPos.current.y
      const cam = cameraRef.current
      cam.x -= dx / cam.zoom
      cam.y -= dy / cam.zoom
      lastTouchPos.current = { x: touch.clientX, y: touch.clientY }
      drawRef.current()
    }
  }, [screenToWorld, updatePosition])

  const handleTouchEnd = useCallback(() => {
    if (isDragging.current) {
      handleMouseUp() // reuses same camera-pan-to-dot logic
    }
    isPanning.current = false
  }, [handleMouseUp])
  useEffect(() => {
    if (!isFocused) return

    const MOVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']
    const MAX_SPEED = KEY_SPEED      // max world-units per frame
    const ACCEL_RATE = 0.08          // fraction of max speed gained per frame (~12 frames = 0.2s to full)
    const DECEL_RATE = 0.08          // same for deceleration

    let vx = 0
    let vy = 0

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (MOVE_KEYS.includes(key)) {
        e.preventDefault()
        keysHeld.current.add(key)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      keysHeld.current.delete(key)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    const tick = () => {
      const keys = keysHeld.current

      // Determine desired direction
      let targetDx = 0
      let targetDy = 0
      if (keys.has('w') || keys.has('arrowup')) targetDy -= 1
      if (keys.has('s') || keys.has('arrowdown')) targetDy += 1
      if (keys.has('a') || keys.has('arrowleft')) targetDx -= 1
      if (keys.has('d') || keys.has('arrowright')) targetDx += 1

      // Auto-derive heading from movement direction (only when actively pressing keys)
      if (targetDx !== 0 || targetDy !== 0) {
        // atan2(dx, -dy): 0=up, PI/2=right, PI=down, -PI/2=left
        const newHeading = Math.atan2(targetDx, -targetDy)
        updateHeading(newHeading)
      }

      // Normalize diagonal
      if (targetDx !== 0 && targetDy !== 0) {
        const len = Math.sqrt(targetDx * targetDx + targetDy * targetDy)
        targetDx /= len
        targetDy /= len
      }

      const targetVx = targetDx * MAX_SPEED
      const targetVy = targetDy * MAX_SPEED

      // Accelerate / decelerate toward target velocity
      const rate = (targetDx !== 0 || targetDy !== 0) ? ACCEL_RATE : DECEL_RATE
      vx += (targetVx - vx) * rate
      vy += (targetVy - vy) * rate

      // Snap to zero if very small (avoid infinite coast)
      if (Math.abs(vx) < 0.01) vx = 0
      if (Math.abs(vy) < 0.01) vy = 0

      // Apply velocity
      if (vx !== 0 || vy !== 0) {
        const pos = useVoiceStore.getState().myPosition
        const newX = Math.max(0, Math.min(WORLD_SIZE, pos.x + vx))
        const newY = Math.max(0, Math.min(WORLD_SIZE, pos.y + vy))
        updatePosition(newX, newY)
        // Camera follows instantly
        cameraRef.current.x = newX
        cameraRef.current.y = newY
      }

      animFrameRef.current = requestAnimationFrame(tick)
    }

    animFrameRef.current = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      keysHeld.current.clear()
    }
  }, [isFocused, updatePosition, updateHeading])

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0 max-h-full p-2">
      {/* Canvas — fills all available space */}
      <div
        ref={containerRef}
        className={cn(
          'flex-1 min-h-0 rounded-xl overflow-hidden border transition-colors',
          isFocused
            ? 'border-indigo-500/50 ring-1 ring-indigo-500/30'
            : 'border-border/30',
        )}
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false)
            keysHeld.current.clear()
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="w-full h-full cursor-crosshair outline-none block"
        />
      </div>

    <TooltipProvider delayDuration={300}>
      {/* Controls bar */}
      <div className="flex flex-col max-[1080px]:gap-1.5 min-[1081px]:flex-row min-[1081px]:items-center gap-2 px-1 shrink-0">
        {/* Range slider */}
        <div className="flex items-center gap-1.5 flex-1 bg-zinc-800/40 rounded-md px-2 py-1 border border-border/10">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-emerald-400/80 font-medium whitespace-nowrap cursor-default">⊕</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Hearing range radius</TooltipContent>
          </Tooltip>
          <input
            type="range"
            min={10}
            max={500}
            step={10}
            value={mySphereRadius}
            onChange={(e) => {
              updateSphereRadius(Number(e.target.value))
            }}
            className="spatial-slider spatial-slider--emerald flex-1"
          />
          <span className="text-[10px] font-mono text-muted-foreground/70 w-6 text-right tabular-nums">{mySphereRadius}</span>
        </div>

        {/* Cone slider */}
        <div className="flex items-center gap-1.5 flex-1 bg-zinc-800/40 rounded-md px-2 py-1 border border-border/10">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-amber-400/80 font-medium whitespace-nowrap cursor-default">◗</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Hearing cone directivity</TooltipContent>
          </Tooltip>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={myConePercent}
            onChange={(e) => {
              updateConePercent(Number(e.target.value))
            }}
            className="spatial-slider spatial-slider--amber flex-1"
          />
          <span className="text-[10px] font-mono text-muted-foreground/70 w-6 text-right tabular-nums">{myConePercent === 0 ? '○' : `${myConePercent}`}</span>
        </div>
      </div>
    </TooltipProvider>

      {/* Hint */}
      <div className="text-center text-[10px] text-muted-foreground/50 shrink-0">
        {isFocused
          ? 'WASD / Arrows to move • Drag dot • Scroll to zoom'
          : 'Drag dot to move • Pinch or scroll to zoom'}
      </div>

      {/* Slider styling */}
      <style>{`
        .spatial-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          border-radius: 2px;
          outline: none;
          cursor: pointer;
          background: rgba(255,255,255,0.06);
        }
        .spatial-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 2px solid;
          cursor: pointer;
          transition: box-shadow 0.15s ease, transform 0.1s ease;
        }
        .spatial-slider::-moz-range-thumb {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 2px solid;
          cursor: pointer;
          transition: box-shadow 0.15s ease, transform 0.1s ease;
        }
        .spatial-slider::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }
        .spatial-slider::-moz-range-thumb:hover {
          transform: scale(1.2);
        }
        /* Emerald variant (Range) */
        .spatial-slider--emerald::-webkit-slider-thumb {
          background: #10b981;
          border-color: #34d399;
          box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
        }
        .spatial-slider--emerald::-moz-range-thumb {
          background: #10b981;
          border-color: #34d399;
          box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
        }
        .spatial-slider--emerald::-webkit-slider-thumb:hover {
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.6);
        }
        /* Amber variant (Cone) */
        .spatial-slider--amber::-webkit-slider-thumb {
          background: #f59e0b;
          border-color: #fbbf24;
          box-shadow: 0 0 6px rgba(245, 158, 11, 0.4);
        }
        .spatial-slider--amber::-moz-range-thumb {
          background: #f59e0b;
          border-color: #fbbf24;
          box-shadow: 0 0 6px rgba(245, 158, 11, 0.4);
        }
        .spatial-slider--amber::-webkit-slider-thumb:hover {
          box-shadow: 0 0 10px rgba(245, 158, 11, 0.6);
        }
      `}</style>
    </div>
  )
}
