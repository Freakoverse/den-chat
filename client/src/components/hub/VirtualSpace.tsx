/**
 * VirtualSpace — barebones first-person 3D "virtual space" for voice channels.
 *
 * PC only (pointer lock + mouse look). Lazy-loaded so three.js / R3F never ship in
 * the main bundle. It drives the SAME store setters the 2D spatial panel uses
 * (updatePosition / updateElevation / updateHeading / updatePitch), so the existing
 * spatial-audio engine spatializes everyone in 3D for free.
 *
 * Controls: WASD move · Space jump · mouse look · click to enter · Esc to release.
 *
 * Known v1 limitations (barebones, by design): cubes have no side-collision (you snap
 * onto a cube top when over its footprint); remote profile pictures only render as a
 * texture if the host serves them with CORS, otherwise a flat colour is shown.
 */
import { useRef, useEffect, useState, useMemo, Suspense, memo } from 'react'
import { Canvas, useFrame, useThree, useLoader } from '@react-three/fiber'
import { Html, Stars, Sparkles } from '@react-three/drei'
import * as THREE from 'three'
import { OBJLoader } from 'three-stdlib'
import { X } from 'lucide-react'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { npubShort, cn } from '@/lib/utils'
import {
  fetchVirtualAvatarCached, loadAvatarBlobUrl, parseVirtualAvatar, clearVirtualAvatarCache,
  VIRTUAL_AVATAR_KIND, VIRTUAL_AVATAR_DTAG, type VirtualAvatar,
} from '@/lib/voice/virtualAvatar'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import VirtualAvatarModal from './VirtualAvatarModal'

// ── Scene constants (world units match the 2D spatial world: ~2000, hearing ~200) ──
const EYE = 34   // camera eye height above feet
const SPEED = 150         // units / second
const GRAVITY = 600
const JUMP = 220          // ~40u apex — clears the tallest cube
const CENTER = 1000       // world spawn center

// ── Fireside layout: a campfire ringed by stump seats, a mountain behind it ──
const FIRE = { x: CENTER, z: CENTER - 150 }    // in front of spawn (the camera looks down -Z)
const STUMP_COUNT = 7
const STUMP_RING_R = 62
const STUMP_S = 16                             // seat height = collision footprint
const MOON_OFFSET: [number, number, number] = [-1000, 1500, 1500]  // from CENTER (high + south — lights the cave); also the moonlight direction

// Stump seats double as the stand-on props (axis-aligned box collision, top at height s).
const CUBES: { x: number; z: number; s: number }[] = Array.from({ length: STUMP_COUNT }, (_, i) => {
  const a = (i / STUMP_COUNT) * Math.PI * 2 - Math.PI / 2
  return { x: FIRE.x + Math.cos(a) * STUMP_RING_R, z: FIRE.z + Math.sin(a) * STUMP_RING_R, s: STUMP_S }
})

const UP = new THREE.Vector3(0, 1, 0)

const WORLD = 2000        // world bounds (matches the store clamp)
const PLAYER_R = 4        // horizontal collision radius

/** Highest ground surface under (x,z): a cube top if within its footprint, else 0. */
function groundHeightAt(x: number, z: number): number {
  let g = 0
  for (const c of CUBES) {
    const h = c.s / 2
    if (x >= c.x - h && x <= c.x + h && z >= c.z - h && z <= c.z + h) {
      g = Math.max(g, c.s)
    }
  }
  return g
}

/**
 * Resolve one horizontal axis against the cubes (axis-aligned box collision).
 * Only collides when the player's feet are below the cube's top — so you walk into
 * the sides but can stand on / walk across the top after jumping up.
 */
function collideAxis(x: number, z: number, feetY: number, axis: 'x' | 'z'): number {
  for (const c of CUBES) {
    if (feetY >= c.s - 0.5) continue   // on or above this cube's top → no side collision
    const half = c.s / 2 + PLAYER_R
    if (x > c.x - half && x < c.x + half && z > c.z - half && z < c.z + half) {
      if (axis === 'x') x = x < c.x ? c.x - half : c.x + half
      else z = z < c.z ? c.z - half : c.z + half
    }
  }
  return axis === 'x' ? x : z
}

// ── Keyboard state (module-scoped so listeners are simple) ──
const keys = new Set<string>()

function Player() {
  const { camera } = useThree()
  const updatePosition = useVoiceStore((s) => s.updatePosition)
  const updateElevation = useVoiceStore((s) => s.updateElevation)
  const updateHeading = useVoiceStore((s) => s.updateHeading)
  const updatePitch = useVoiceStore((s) => s.updatePitch)
  const velY = useRef(0)
  const grounded = useRef(true)
  const jumpQueued = useRef(false)
  const sinceWrite = useRef(0)

  // Initialise camera from the current store position.
  useEffect(() => {
    const { myPosition, myElevation } = useVoiceStore.getState()
    camera.position.set(myPosition.x, EYE + (myElevation || 0), myPosition.y)
  }, [camera])

  useEffect(() => {
    let spaceDown = false
    const down = (e: KeyboardEvent) => {
      if (!document.pointerLockElement) return  // only drive movement while controlling
      const k = e.key.toLowerCase()
      if (k === ' ') {
        e.preventDefault()
        // Edge-trigger: queue a jump only on a fresh press, so holding Space doesn't
        // bunny-hop. Browser key-repeat fires keydown continuously while held.
        if (!spaceDown) { spaceDown = true; jumpQueued.current = true }
        return
      }
      if (['w', 'a', 's', 'd'].includes(k)) { keys.add(k); e.preventDefault() }
    }
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === ' ') spaceDown = false
      keys.delete(k)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); keys.clear() }
  }, [])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)

    // Vertical first: gravity + land on the floor or a cube top, then jump.
    velY.current -= GRAVITY * dt
    camera.position.y += velY.current * dt
    const groundY = EYE + groundHeightAt(camera.position.x, camera.position.z)
    if (camera.position.y <= groundY) {
      camera.position.y = groundY
      velY.current = 0
      grounded.current = true
    } else {
      grounded.current = false
    }
    // One jump per press; a press just before landing still fires (small buffer).
    if (jumpQueued.current && grounded.current) {
      velY.current = JUMP
      grounded.current = false
      jumpQueued.current = false
    }

    // Horizontal: move along the yaw plane, then resolve cube collisions per axis
    // (using the now-settled feet height, so landing on a cube doesn't get side-pushed).
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward)
    forward.y = 0
    if (forward.lengthSq() > 0) forward.normalize()
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize()
    const move = new THREE.Vector3()
    if (keys.has('w')) move.add(forward)
    if (keys.has('s')) move.sub(forward)
    if (keys.has('d')) move.add(right)
    if (keys.has('a')) move.sub(right)
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(SPEED * dt)
      const feetY = camera.position.y - EYE
      let nx = camera.position.x + move.x
      let nz = camera.position.z + move.z
      nx = collideAxis(nx, camera.position.z, feetY, 'x')  // resolve X against current Z
      nz = collideAxis(nx, nz, feetY, 'z')                 // then Z against the resolved X
      camera.position.x = Math.max(0, Math.min(WORLD, nx))
      camera.position.z = Math.max(0, Math.min(WORLD, nz))
    }

    // Throttle store writes (~30Hz) — enough for audio + the 10Hz network broadcast.
    sinceWrite.current += dt
    if (sinceWrite.current >= 0.033) {
      sinceWrite.current = 0
      updatePosition(camera.position.x, camera.position.z)
      updateElevation(camera.position.y - EYE)
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
      updateHeading(-e.y)   // audio heading 0 = facing -Z; sign may need a flip after a listen test
      updatePitch(e.x)
    }
  })

  return null
}

/** VRChat-style nameplate billboarded above a remote user: profile picture + name. */
const Nameplate = memo(function Nameplate({ pubkey, y, speaking }: { pubkey: string; y: number; speaking: boolean }) {
  const { getProfile } = useProfileCache()
  const isHex = /^[0-9a-f]{64}$/i.test(pubkey)
  const profile = isHex ? getProfile(pubkey) : null
  const name = profile?.display_name || profile?.name || npubShort(pubkey)
  const pic = profile?.picture
  return (
    <Html position={[0, y, 0]} center distanceFactor={160} zIndexRange={[30, 0]}>
      <div className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-full backdrop-blur-sm whitespace-nowrap select-none pointer-events-none transition-all',
        speaking
          ? 'bg-emerald-600/85 border border-emerald-300/80 shadow-[0_0_12px_2px_rgba(16,185,129,0.65)]'
          : 'bg-black/75 border border-white/15',
      )}>
        {pic
          ? <img src={pic} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
          : <div className="w-5 h-5 rounded-full bg-zinc-600 shrink-0" />}
        <span className="text-white text-xs font-medium max-w-[140px] truncate">{name}</span>
      </div>
    </Html>
  )
})

// ── Standee avatar (9:16 portrait frame with 45° chamfered corners) ──
const STANDEE_H = 36
const STANDEE_W = (STANDEE_H * 9) / 16
const STANDEE_C = 4   // corner chamfer

function chamferShape(w: number, h: number, c: number): THREE.Shape {
  const hw = w / 2, hh = h / 2
  const s = new THREE.Shape()
  s.moveTo(-hw + c, hh)
  s.lineTo(hw - c, hh)
  s.lineTo(hw, hh - c)
  s.lineTo(hw, -hh + c)
  s.lineTo(hw - c, -hh)
  s.lineTo(-hw + c, -hh)
  s.lineTo(-hw, -hh + c)
  s.lineTo(-hw, hh - c)
  s.closePath()
  return s
}

const FRAME_MARGIN = 1.8   // border width around the image
const FRAME_DEPTH = 2.4    // 3D thickness of the frame
let _standeeGeom: THREE.ShapeGeometry | null = null
let _frameGeom: THREE.ExtrudeGeometry | null = null
let _frameOutline: THREE.BufferGeometry | null = null
function standeeGeom(): THREE.ShapeGeometry {
  if (_standeeGeom) return _standeeGeom
  const g = new THREE.ShapeGeometry(chamferShape(STANDEE_W, STANDEE_H, STANDEE_C))
  // Normalize UVs to the bounding box so a texture fills the frame (corners clipped).
  const pos = g.attributes.position
  const uv: number[] = []
  for (let i = 0; i < pos.count; i++) {
    uv.push((pos.getX(i) + STANDEE_W / 2) / STANDEE_W, (pos.getY(i) + STANDEE_H / 2) / STANDEE_H)
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  _standeeGeom = g
  return g
}
function frameGeom(): THREE.ExtrudeGeometry {
  if (_frameGeom) return _frameGeom
  const shape = chamferShape(STANDEE_W + FRAME_MARGIN * 2, STANDEE_H + FRAME_MARGIN * 2, STANDEE_C + FRAME_MARGIN * (2 - Math.SQRT2))
  const g = new THREE.ExtrudeGeometry(shape, { depth: FRAME_DEPTH, bevelEnabled: false })
  g.translate(0, 0, -FRAME_DEPTH / 2)   // center the slab on z
  _frameGeom = g
  return g
}
function frameOutline(): THREE.BufferGeometry {
  if (_frameOutline) return _frameOutline
  const pts = chamferShape(STANDEE_W + FRAME_MARGIN * 2, STANDEE_H + FRAME_MARGIN * 2, STANDEE_C + FRAME_MARGIN * (2 - Math.SQRT2)).getPoints()
  _frameOutline = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, p.y, 0)))
  return _frameOutline
}

/** Deterministic solid-fill colour from a pubkey (shown until a custom image is set). */
function colorFromPubkey(pubkey: string): string {
  let h = 0
  for (let i = 0; i < pubkey.length; i++) h = (h * 31 + pubkey.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 45%, 42%)`
}

/**
 * Live map of participant pubkey → their NIP-78 virtual avatar. Seeds from cache,
 * then subscribes to kind-30078 / d=virtual-space-avatar for those authors, so an
 * edit (including the editor's own save) updates everyone's standee without a refetch.
 */
function useVirtualAvatars(pubkeys: string[]): Record<string, VirtualAvatar | null> {
  const [avatars, setAvatars] = useState<Record<string, VirtualAvatar | null>>({})
  const seenAt = useRef<Record<string, number>>({})
  const key = pubkeys.slice().sort().join(',')
  useEffect(() => {
    if (!pubkeys.length) return
    pubkeys.forEach((pk) => {
      fetchVirtualAvatarCached(pk).then((av) => setAvatars((prev) => (pk in prev ? prev : { ...prev, [pk]: av })))
    })
    const sub = subscribeToRelays(
      getPublishRelays(),
      { kinds: [VIRTUAL_AVATAR_KIND], '#d': [VIRTUAL_AVATAR_DTAG], authors: pubkeys },
      (ev) => {
        if ((seenAt.current[ev.pubkey] ?? 0) >= ev.created_at) return
        seenAt.current[ev.pubkey] = ev.created_at
        clearVirtualAvatarCache(ev.pubkey)
        setAvatars((prev) => ({ ...prev, [ev.pubkey]: parseVirtualAvatar(ev) }))
      },
    )
    return () => sub.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return avatars
}

/** object-fit: cover for a texture on the 9:16 frame — fills the frame, crops the
 *  overflowing axis (never squishes). flipX mirrors X for the back face. */
function applyCoverFit(tex: THREE.Texture, frameAspect: number, flipX: boolean): void {
  const img = tex.image as { width?: number; height?: number } | undefined
  if (!img?.width || !img?.height) return
  const a = img.width / img.height
  let rx = 1, ry = 1, ox = 0, oy = 0
  if (a > frameAspect) { rx = frameAspect / a; ox = (1 - rx) / 2 }   // image wider → crop sides (height 100%)
  else { ry = a / frameAspect; oy = (1 - ry) / 2 }                    // image taller → crop top/bottom (width 100%)
  if (flipX) { ox = ox + rx; rx = -rx }                              // mirror X for the back-facing copy
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.repeat.set(rx, ry)
  tex.offset.set(ox, oy)
  tex.needsUpdate = true
}

/** Load a virtual avatar's front/back images as CORS-safe textures (reloads on change). */
function useAvatarTextures(avatar: VirtualAvatar | null) {
  const [tex, setTex] = useState<{ front: THREE.Texture | null; back: THREE.Texture | null }>({ front: null, back: null })
  const front = avatar?.front
  const back = avatar?.back
  useEffect(() => {
    let cancelled = false
    const blobUrls: string[] = []
    const made: THREE.Texture[] = []
    if (!front && !back) { setTex({ front: null, back: null }); return }
    const loadTex = async (url: string | undefined, flipX: boolean): Promise<THREE.Texture | null> => {
      const blobUrl = await loadAvatarBlobUrl(url)
      if (!blobUrl) return null
      blobUrls.push(blobUrl)
      return new Promise<THREE.Texture | null>((res) => {
        new THREE.TextureLoader().load(blobUrl, (t) => {
          t.colorSpace = THREE.SRGBColorSpace
          applyCoverFit(t, STANDEE_W / STANDEE_H, flipX)
          res(t)
        }, undefined, () => res(null))
      })
    }
    ;(async () => {
      const [f, b] = await Promise.all([loadTex(front, false), loadTex(back, true)])
      if (cancelled) { f?.dispose(); b?.dispose(); blobUrls.forEach(URL.revokeObjectURL); return }
      if (f) made.push(f)
      if (b) made.push(b)
      setTex({ front: f, back: b })
    })()
    return () => { cancelled = true; made.forEach((t) => t.dispose()); blobUrls.forEach(URL.revokeObjectURL) }
  }, [front, back])
  return tex
}

/** Two-sided framed standee: front faces the user's heading, back behind it. */
function Standee({ avatar, pubkey, speaking }: { avatar: VirtualAvatar | null; pubkey: string; speaking: boolean }) {
  const { front, back } = useAvatarTextures(avatar)
  const color = useMemo(() => colorFromPubkey(pubkey), [pubkey])
  const img = standeeGeom()
  return (
    <group position={[0, 3, 0]}>{/* lift so the frame's bottom clears the floor */}
      {/* 3D frame slab around the image */}
      <mesh geometry={frameGeom()} position={[0, STANDEE_H / 2, 0]} castShadow>
        <meshStandardMaterial color="#0f172a" metalness={0.25} roughness={0.65} />
      </mesh>
      {/* front image (toward heading). key on the texture so the material recompiles
          with the map once it loads (R3F won't add USE_MAP to an existing material). */}
      <mesh geometry={img} position={[0, STANDEE_H / 2, FRAME_DEPTH / 2 + 0.15]}>
        <meshBasicMaterial key={front?.uuid ?? 'solid'} map={front ?? undefined} color={front ? '#ffffff' : color} side={THREE.FrontSide} toneMapped={false} />
      </mesh>
      {/* back image */}
      <mesh geometry={img} position={[0, STANDEE_H / 2, -(FRAME_DEPTH / 2 + 0.15)]} rotation={[0, Math.PI, 0]}>
        <meshBasicMaterial key={back?.uuid ?? 'solid'} map={back ?? undefined} color={back ? '#ffffff' : color} side={THREE.FrontSide} toneMapped={false} />
      </mesh>
      {/* speaking glow on the frame edge */}
      <lineLoop geometry={frameOutline()} position={[0, STANDEE_H / 2, FRAME_DEPTH / 2 + 0.05]}>
        <lineBasicMaterial color={speaking ? '#10b981' : '#475569'} transparent opacity={speaking ? 0.95 : 0.6} />
      </lineLoop>
    </group>
  )
}

function RemoteAvatar({ pubkey, avatar, x, z, elevation, heading, speaking, showRange, radius, conePercent }: {
  pubkey: string; avatar: VirtualAvatar | null; x: number; z: number; elevation: number; heading: number; speaking: boolean
  showRange: boolean; radius: number; conePercent: number
}) {
  const bodyGroup = useRef<THREE.Group>(null)   // position
  const facing = useRef<THREE.Group>(null)      // heading rotation
  const coneGroup = useRef<THREE.Group>(null)   // ground cone (position + heading)
  const cur = useRef({ x, z, elevation, heading })

  // Smoothly interpolate toward the latest networked pose. Updates arrive ~10Hz,
  // so without this the avatar looks choppy. Purely visual — the audio engine still
  // uses the exact positions, so spatialization stays accurate.
  useFrame((_, dt) => {
    const c = cur.current
    const t = 1 - Math.exp(-Math.min(dt, 0.1) * 24)
    c.x += (x - c.x) * t
    c.z += (z - c.z) * t
    c.elevation += (elevation - c.elevation) * t
    let dh = heading - c.heading                 // shortest-angle turn
    while (dh > Math.PI) dh -= 2 * Math.PI
    while (dh < -Math.PI) dh += 2 * Math.PI
    c.heading += dh * t
    bodyGroup.current?.position.set(c.x, c.elevation, c.z)
    // Standee front face is local +Z, so π - heading aims it at the heading direction.
    if (facing.current) facing.current.rotation.y = Math.PI - c.heading
    if (coneGroup.current) {
      coneGroup.current.position.set(c.x, 0.2, c.z)
      coneGroup.current.rotation.y = Math.PI / 2 - c.heading
    }
  })

  return (
    <>
      <group ref={bodyGroup} position={[x, elevation, z]}>
        {/* standee, rotated to face the user's heading */}
        <group ref={facing} rotation={[0, Math.PI - heading, 0]}>
          <Standee avatar={avatar} pubkey={pubkey} speaking={speaking} />
        </group>
        <Nameplate pubkey={pubkey} y={STANDEE_H + 16} speaking={speaking} />
      </group>
      {showRange && (
        <group ref={coneGroup} position={[x, 0.2, z]} rotation={[0, Math.PI / 2 - heading, 0]}>
          <ConeOverlay radius={radius} conePercent={conePercent} color="#60a5fa" fill={0.05} edge={0.22} />
        </group>
      )}
    </>
  )
}

function RemoteAvatars({ showRanges }: { showRanges: boolean }) {
  const presenceByHub = useVoiceStore((s) => s.presenceByHub)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const currentHubDTag = useVoiceStore((s) => s.currentHubDTag)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const currentHostPubkey = useVoiceStore((s) => s.currentHostPubkey)
  const myPubkey = useUserStore((s) => s.pubkey)

  const presences = currentHubDTag
    ? (presenceByHub[currentHubDTag] || []).filter(
        (p) =>
          p.channelId === currentChannelId &&
          p.status === 'joined' &&
          p.pubkey !== myPubkey &&
          participants[p.pubkey] &&
          // virtual-space + plain (non-spatial) people; only 2D-spatial people are sealed off
          (participants[p.pubkey].hasVspace || !participants[p.pubkey].hasSpatial) &&
          (!p.hostPubkey || p.hostPubkey === currentHostPubkey),
      )
    : []

  // Hook must run every render — live avatars for the current participants.
  const avatars = useVirtualAvatars(presences.map((p) => p.pubkey))

  return (
    <>
      {presences.map((p) => (
        <RemoteAvatar
          key={p.pubkey}
          pubkey={p.pubkey}
          avatar={avatars[p.pubkey] ?? null}
          x={p.position.x}
          z={p.position.y}
          elevation={p.elevation ?? 0}
          heading={p.heading ?? 0}
          speaking={participants[p.pubkey]?.isSpeaking ?? activeSpeakers.includes(p.pubkey)}
          showRange={showRanges}
          radius={p.sphereRadius}
          conePercent={p.cone ?? 0}
        />
      ))}
    </>
  )
}

/**
 * A ground hearing overlay: a disc at the given radius that narrows into a
 * forward-facing sector as the cone increases (matching the audio cone). The
 * sector points along local +X — the parent group positions + orients it.
 */
function ConeOverlay({ radius, conePercent, color, fill = 0.07, edge = 0.3 }: {
  radius: number; conePercent: number; color: string; fill?: number; edge?: number
}) {
  const p = Math.max(0, Math.min(100, conePercent)) / 100
  const halfAngle = Math.PI * (1 - p) + (Math.PI / 12) * p   // π (full circle) → π/12 (15°)
  const start = -halfAngle
  const length = 2 * halfAngle                                // 2π at cone 0 → full circle
  const inner = Math.max(1, radius - 3)
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0, radius, 96, 1, start, length]} />
        <meshBasicMaterial color={color} transparent opacity={fill} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
        <ringGeometry args={[inner, radius, 96, 1, start, length]} />
        <meshBasicMaterial color={color} transparent opacity={edge} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </>
  )
}

/** My own hearing overlay — follows the camera and aims where I look. */
function HearingRing() {
  const groupRef = useRef<THREE.Group>(null)
  const sphereRadius = useVoiceStore((s) => s.mySphereRadius)
  const conePercent = useVoiceStore((s) => s.myConePercent)
  const { camera } = useThree()
  useFrame(() => {
    const g = groupRef.current
    if (!g) return
    g.position.x = camera.position.x
    g.position.z = camera.position.z
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    g.rotation.y = Math.PI / 2 + e.y   // aim the sector where we're looking (heading = -e.y)
  })
  return (
    <group ref={groupRef} position={[CENTER, 0.3, CENTER]}>
      <ConeOverlay radius={sphereRadius} conePercent={conePercent} color="#10b981" />
    </group>
  )
}

/** Vertical night-sky gradient (zenith blue → horizon near-black), for the skydome. */
function skyGradientTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 8; c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#070a12')   // bottom of canvas → sphere bottom (horizon)
  g.addColorStop(0.35, '#0a0f1e')
  g.addColorStop(1, '#0c1430')   // top of canvas → zenith
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 8, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Soft radial glow disc (white center → transparent), for the moon halo / sparks. */
function radialGlowTexture(core: string, edge: string): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 128; c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, core)
  g.addColorStop(0.35, core)
  g.addColorStop(1, edge)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

/** Star field + gradient dome + moon + cool moonlight. */
function NightSky() {
  const skyTex = useMemo(skyGradientTexture, [])
  const haloTex = useMemo(() => radialGlowTexture('rgba(224,234,255,0.85)', 'rgba(224,234,255,0)'), [])
  const moon: [number, number, number] = [CENTER + MOON_OFFSET[0], MOON_OFFSET[1], CENTER + MOON_OFFSET[2]]
  return (
    <group>
      {/* gradient skydome (inside-out sphere, never fogged) */}
      <mesh position={[CENTER, 0, CENTER]}>
        <sphereGeometry args={[5500, 32, 16]} />
        <meshBasicMaterial map={skyTex} side={THREE.BackSide} depthWrite={false} fog={false} />
      </mesh>

      <group position={[CENTER, 0, CENTER]}>
        <Stars radius={1500} depth={140} count={1800} factor={5} saturation={0} fade speed={0.3} />
      </group>

      {/* moon disc + halo */}
      <mesh position={moon}>
        <sphereGeometry args={[68, 24, 24]} />
        <meshBasicMaterial color="#eef3ff" fog={false} />
      </mesh>
      <sprite position={moon} scale={[440, 440, 1]}>
        <spriteMaterial map={haloTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} fog={false} />
      </sprite>

      {/* moonlight — direction matches the moon's offset from center */}
      <directionalLight position={MOON_OFFSET} intensity={0.85} color="#aac4ff" />
    </group>
  )
}

// ── Mountain model (low-poly OBJ with a modeled slit cave + crystals) ──
const MOUNTAIN_SCALE = 26
// cave entrance ends up at ~[CENTER, 0, CENTER-448], facing the camp (+Z).
// Y offset drops the model so the cave floor (model Y≈1.5) sits at ground level.
const MOUNTAIN_POS: [number, number, number] = [CENTER, -39, CENTER - 1150]

/** Night-palette materials applied to the model's named groups (keeps glowing crystals). */
function mountainMaterials(): Record<string, THREE.Material> {
  // DoubleSide throughout: the model's winding is inconsistent, so front-side culling
  // makes outer faces vanish (you see through to the interior). Cheap at ~1080 faces.
  return {
    mat_rock: new THREE.MeshStandardMaterial({ color: '#2b2f3a', roughness: 1, flatShading: true, side: THREE.DoubleSide }),
    mat_snow: new THREE.MeshStandardMaterial({ color: '#c2d0ea', roughness: 0.85, flatShading: true, side: THREE.DoubleSide }),
    mat_cave_rock: new THREE.MeshStandardMaterial({ color: '#15171f', roughness: 1, flatShading: true, side: THREE.DoubleSide }),
    mat_cave_floor: new THREE.MeshStandardMaterial({ color: '#0e1016', roughness: 1, flatShading: true, side: THREE.DoubleSide }),
    mat_crystal: new THREE.MeshStandardMaterial({ color: '#1d6f8c', emissive: '#23d3ff', emissiveIntensity: 2.4, roughness: 0.3, flatShading: true, side: THREE.DoubleSide }),
  }
}

function MountainModel() {
  const obj = useLoader(OBJLoader, `${import.meta.env.BASE_URL}models/mountain.obj`)
  const model = useMemo(() => {
    const mats = mountainMaterials()
    const remap = (m: THREE.Material) => mats[m.name] ?? m
    const root = obj.clone()
    root.traverse((c) => {
      const m = c as THREE.Mesh
      if (!m.isMesh) return
      m.material = Array.isArray(m.material) ? m.material.map(remap) : remap(m.material as THREE.Material)
      m.geometry.computeVertexNormals()
    })
    return root
  }, [obj])
  return <primitive object={model} position={MOUNTAIN_POS} rotation={[0, -Math.PI / 2, 0]} scale={MOUNTAIN_SCALE} />
}

/** The ring of stump seats (also the collision props — see CUBES). */
function Stumps() {
  return (
    <>
      {CUBES.map((c, i) => (
        <group key={i} position={[c.x, 0, c.z]}>
          <mesh position={[0, c.s / 2, 0]}>
            <cylinderGeometry args={[c.s * 0.56, c.s * 0.64, c.s, 12]} />
            <meshStandardMaterial color="#4f3d2b" roughness={1} />
          </mesh>
          {/* sawn top, slightly lighter */}
          <mesh position={[0, c.s + 0.15, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[c.s * 0.56, 12]} />
            <meshStandardMaterial color="#735738" roughness={1} />
          </mesh>
        </group>
      ))}
    </>
  )
}

/** Campfire: stone ring, crossed logs, additive flame cones, embers, flickering light. */
function Campfire() {
  const lightRef = useRef<THREE.PointLight>(null)
  const flameRef = useRef<THREE.Group>(null)
  useFrame(() => {
    if (lightRef.current) lightRef.current.intensity = 5.2 + Math.random() * 2.2   // flicker
    if (flameRef.current) {
      const s = 0.9 + Math.sin(performance.now() * 0.013) * 0.1 + Math.random() * 0.08
      flameRef.current.scale.set(1, s, 1)
    }
  })
  return (
    <group position={[FIRE.x, 0, FIRE.z]}>
      {/* stone ring */}
      {Array.from({ length: 9 }).map((_, i) => {
        const a = (i / 9) * Math.PI * 2
        return (
          <mesh key={i} position={[Math.cos(a) * 15, 2.5, Math.sin(a) * 15]} rotation={[a, a * 1.3, 0]}>
            <dodecahedronGeometry args={[4.2, 0]} />
            <meshStandardMaterial color="#4a4e57" roughness={1} flatShading />
          </mesh>
        )
      })}
      {/* crossed logs */}
      <mesh position={[0, 3, 0]} rotation={[0, 0.5, Math.PI / 2.1]}>
        <cylinderGeometry args={[2, 2, 20, 8]} />
        <meshStandardMaterial color="#3a2a1d" roughness={1} />
      </mesh>
      <mesh position={[0, 3, 0]} rotation={[0.5, -0.7, Math.PI / 2.1]}>
        <cylinderGeometry args={[2, 2, 20, 8]} />
        <meshStandardMaterial color="#2f241a" roughness={1} />
      </mesh>
      {/* flames (additive, unlit, never fogged) */}
      <group ref={flameRef} position={[0, 6, 0]}>
        <mesh>
          <coneGeometry args={[7, 18, 10]} />
          <meshBasicMaterial color="#ff5a1e" transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} />
        </mesh>
        <mesh position={[0, 2, 0]}>
          <coneGeometry args={[4.6, 14, 10]} />
          <meshBasicMaterial color="#ff9d2e" transparent opacity={0.7} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} />
        </mesh>
        <mesh position={[0, 4, 0]}>
          <coneGeometry args={[2.4, 9, 8]} />
          <meshBasicMaterial color="#ffd76b" transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} fog={false} />
        </mesh>
      </group>
      {/* rising embers */}
      <Sparkles count={28} scale={[24, 42, 24]} position={[0, 18, 0]} size={3} speed={0.5} color="#ffae53" opacity={0.7} />
      {/* warm glow */}
      <pointLight ref={lightRef} position={[0, 12, 0]} color="#ff7b2e" intensity={6} distance={320} decay={1.4} />
    </group>
  )
}

function Scene({ showRanges }: { showRanges: boolean }) {
  return (
    <>
      <color attach="background" args={['#05070d']} />
      <fogExp2 attach="fog" args={['#070a12', 0.0013]} />

      {/* night ambience */}
      <ambientLight intensity={0.18} color="#5b6b8c" />
      <hemisphereLight args={['#2a3554', '#05060a', 0.35]} />
      <NightSky />

      {/* ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[CENTER, 0, CENTER]}>
        <planeGeometry args={[3000, 3000]} />
        <meshStandardMaterial color="#0f141c" roughness={1} />
      </mesh>
      <gridHelper args={[3000, 75, '#1a2230', '#11161d']} position={[CENTER, 0.1, CENTER]} />

      <Suspense fallback={null}><MountainModel /></Suspense>
      <Stumps />
      <Campfire />

      <HearingRing />
      <Player />
      <RemoteAvatars showRanges={showRanges} />
    </>
  )
}

/**
 * First-person mouse-look + pointer lock. Custom (not drei's PointerLockControls)
 * so we can CLAMP per-event mouse deltas — the browser occasionally reports a huge
 * movementX/Y spike that otherwise slingshots the view somewhere you didn't aim.
 */
function FpsLook({ onLockChange }: { onLockChange: (locked: boolean) => void }) {
  const { camera, gl } = useThree()
  useEffect(() => {
    const el = gl.domElement
    const euler = new THREE.Euler(0, 0, 0, 'YXZ')
    const SENS = 0.0022
    const MAX_DELTA = 100   // px per event — caps spurious spikes
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== el) return
      const dx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e.movementX || 0))
      const dy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e.movementY || 0))
      euler.setFromQuaternion(camera.quaternion)
      euler.y -= dx * SENS
      euler.x -= dy * SENS
      euler.x = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, euler.x))   // clamp pitch
      camera.quaternion.setFromEuler(euler)
    }
    const onPlc = () => {
      const locked = document.pointerLockElement === el
      if (!locked) keys.clear()
      onLockChange(locked)
    }
    const enterEl = document.getElementById('vs-enter')
    const onEnter = () => {
      // unadjustedMovement disables OS pointer acceleration, which otherwise amplifies
      // fast flicks into overshoot in the browser (Tauri's webview doesn't accelerate).
      const p = (el as any).requestPointerLock?.({ unadjustedMovement: true })
      if (p && typeof p.catch === 'function') p.catch(() => el.requestPointerLock?.())
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('pointerlockchange', onPlc)
    enterEl?.addEventListener('click', onEnter)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('pointerlockchange', onPlc)
      enterEl?.removeEventListener('click', onEnter)
      if (document.pointerLockElement === el) document.exitPointerLock?.()
    }
  }, [camera, gl, onLockChange])
  return null
}

export default function VirtualSpace() {
  const toggleVirtualSpace = useVoiceStore((s) => s.toggleVirtualSpace)
  const mySphereRadius = useVoiceStore((s) => s.mySphereRadius)
  const myConePercent = useVoiceStore((s) => s.myConePercent)
  const updateSphereRadius = useVoiceStore((s) => s.updateSphereRadius)
  const updateConePercent = useVoiceStore((s) => s.updateConePercent)
  const [locked, setLocked] = useState(false)
  const [showRanges, setShowRanges] = useState(true)
  const [editAvatar, setEditAvatar] = useState(false)

  return (
    <div className="w-full h-full flex flex-col gap-2">
      <div className="relative flex-1 min-h-0 rounded-xl overflow-hidden border border-indigo-500/40 bg-black">
        <Canvas
          camera={{ fov: 75, near: 0.1, far: 12000, position: [CENTER, EYE, CENTER] }}
          gl={{ antialias: true }}
        >
          <Suspense fallback={null}>
            <Scene showRanges={showRanges} />
            <FpsLook onLockChange={setLocked} />
          </Suspense>
        </Canvas>

        {/* Crosshair while controlling */}
        {locked && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-white/70" />
          </div>
        )}

        {/* Enter prompt — always mounted (a stable target for the pointer-lock
            selector, so only clicking HERE locks; toggles/sliders never do). Hidden
            and non-interactive while controlling. */}
        <div
          id="vs-enter"
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 backdrop-blur-[1px] transition-opacity',
            locked ? 'opacity-0 pointer-events-none' : 'opacity-100 cursor-pointer',
          )}
        >
          <div className="px-4 py-3 rounded-xl bg-popover/90 border border-border text-center">
            <p className="text-sm font-semibold text-foreground">Click to enter</p>
            <p className="text-xs text-muted-foreground mt-1">WASD move · Space jump · Mouse look · Esc to release</p>
          </div>
        </div>

        {/* Exit the virtual space entirely (available when not locked) */}
        {!locked && (
          <button
            onClick={() => toggleVirtualSpace()}
            className="absolute top-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/70 backdrop-blur-sm border border-border/50 text-foreground/80 hover:text-foreground text-xs font-medium transition-colors cursor-pointer"
          >
            Exit <X size={14} />
          </button>
        )}
      </div>

      {/* Hearing range + cone — same controls as the 2D spatial panel (adjust when released) */}
      <div className="flex flex-col min-[1081px]:flex-row min-[1081px]:items-center gap-2 px-1 shrink-0">
        <div className="flex items-center gap-1.5 flex-1 bg-zinc-800/40 rounded-md px-2 py-1 border border-border/10">
          <span title="Hearing range radius" className="text-[10px] text-emerald-400/80 font-medium whitespace-nowrap cursor-default">⊕</span>
          <input
            type="range" min={10} max={500} step={10} value={mySphereRadius}
            onChange={(e) => updateSphereRadius(Number(e.target.value))}
            className="spatial-slider spatial-slider--emerald flex-1"
          />
          <span className="text-[10px] font-mono text-muted-foreground/70 w-6 text-right tabular-nums">{mySphereRadius}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-1 bg-zinc-800/40 rounded-md px-2 py-1 border border-border/10">
          <span title="Hearing cone directivity" className="text-[10px] text-amber-400/80 font-medium whitespace-nowrap cursor-default">◗</span>
          <input
            type="range" min={0} max={100} step={5} value={myConePercent}
            onChange={(e) => updateConePercent(Number(e.target.value))}
            className="spatial-slider spatial-slider--amber flex-1"
          />
          <span className="text-[10px] font-mono text-muted-foreground/70 w-6 text-right tabular-nums">{myConePercent === 0 ? '○' : `${myConePercent}`}</span>
        </div>
        <button
          onClick={() => setShowRanges((v) => !v)}
          title="Show other users' hearing ranges on the ground"
          className={cn(
            'text-[10px] px-2 py-1 rounded-md border transition-colors whitespace-nowrap font-medium shrink-0 cursor-pointer',
            showRanges
              ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
              : 'bg-zinc-800/40 border-border/20 text-muted-foreground hover:text-foreground',
          )}
        >
          Others' ranges
        </button>
        <button
          onClick={() => setEditAvatar(true)}
          title="Customize your virtual-space avatar"
          className="text-[10px] px-2 py-1 rounded-md border border-border/20 bg-zinc-800/40 text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap font-medium shrink-0 cursor-pointer"
        >
          Customize
        </button>
      </div>

      {/* Slider styling (same as the 2D spatial panel; included here since that panel
          isn't mounted while the virtual space is open). */}
      <style>{`
        .spatial-slider {
          -webkit-appearance: none; appearance: none;
          height: 4px; border-radius: 2px; outline: none; cursor: pointer;
          background: rgba(255,255,255,0.06);
        }
        .spatial-slider::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 12px; height: 12px; border-radius: 50%; border: 2px solid; cursor: pointer;
          transition: box-shadow 0.15s ease, transform 0.1s ease;
        }
        .spatial-slider::-moz-range-thumb {
          width: 12px; height: 12px; border-radius: 50%; border: 2px solid; cursor: pointer;
          transition: box-shadow 0.15s ease, transform 0.1s ease;
        }
        .spatial-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
        .spatial-slider::-moz-range-thumb:hover { transform: scale(1.2); }
        .spatial-slider--emerald::-webkit-slider-thumb { background: #10b981; border-color: #34d399; box-shadow: 0 0 6px rgba(16,185,129,0.4); }
        .spatial-slider--emerald::-moz-range-thumb { background: #10b981; border-color: #34d399; box-shadow: 0 0 6px rgba(16,185,129,0.4); }
        .spatial-slider--emerald::-webkit-slider-thumb:hover { box-shadow: 0 0 10px rgba(16,185,129,0.6); }
        .spatial-slider--amber::-webkit-slider-thumb { background: #f59e0b; border-color: #fbbf24; box-shadow: 0 0 6px rgba(245,158,11,0.4); }
        .spatial-slider--amber::-moz-range-thumb { background: #f59e0b; border-color: #fbbf24; box-shadow: 0 0 6px rgba(245,158,11,0.4); }
        .spatial-slider--amber::-webkit-slider-thumb:hover { box-shadow: 0 0 10px rgba(245,158,11,0.6); }
      `}</style>

      {editAvatar && <VirtualAvatarModal onClose={() => setEditAvatar(false)} />}
    </div>
  )
}
