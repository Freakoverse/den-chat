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
import { useRef, useEffect, useState, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PointerLockControls } from '@react-three/drei'
import * as THREE from 'three'
import { X } from 'lucide-react'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'

// ── Scene constants (world units match the 2D spatial world: ~2000, hearing ~200) ──
const EYE = 20            // eye height above feet
const BODY_H = 22
const HEAD = 10
const SPEED = 150         // units / second
const GRAVITY = 600
const JUMP = 180          // ~27u apex — clears the cubes
const CENTER = 1000       // world spawn center

// A few cubes to jump on, near spawn. [x, z, size]
const CUBES: { x: number; z: number; s: number }[] = [
  { x: CENTER + 60, z: CENTER, s: 28 },
  { x: CENTER - 70, z: CENTER + 40, s: 36 },
  { x: CENTER + 20, z: CENTER - 90, s: 22 },
  { x: CENTER - 30, z: CENTER - 50, s: 30 },
]

const UP = new THREE.Vector3(0, 1, 0)

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
  const sinceWrite = useRef(0)

  // Initialise camera from the current store position.
  useEffect(() => {
    const { myPosition, myElevation } = useVoiceStore.getState()
    camera.position.set(myPosition.x, EYE + (myElevation || 0), myPosition.y)
  }, [camera])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', ' '].includes(k)) { keys.add(k); e.preventDefault() }
    }
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); keys.clear() }
  }, [])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)

    // Horizontal movement along the camera's yaw plane.
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
      camera.position.x += move.x
      camera.position.z += move.z
    }

    // Gravity + jump + ground snap.
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
    if (keys.has(' ') && grounded.current) { velY.current = JUMP; grounded.current = false }

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

/** Load a participant's profile picture as a texture (CORS permitting); null otherwise. */
function usePfpTexture(pubkey: string): THREE.Texture | null {
  const { getProfile } = useProfileCache()
  const url = /^[0-9a-f]{64}$/i.test(pubkey) ? getProfile(pubkey)?.picture : undefined
  const [tex, setTex] = useState<THREE.Texture | null>(null)
  useEffect(() => {
    if (!url) { setTex(null); return }
    let cancelled = false
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    loader.load(
      url,
      (t) => { if (!cancelled) { t.colorSpace = THREE.SRGBColorSpace; setTex(t) } },
      undefined,
      () => { if (!cancelled) setTex(null) },
    )
    return () => { cancelled = true }
  }, [url])
  return tex
}

function RemoteAvatar({ pubkey, x, z, elevation, heading, speaking }: {
  pubkey: string; x: number; z: number; elevation: number; heading: number; speaking: boolean
}) {
  const tex = usePfpTexture(pubkey)
  const accent = speaking ? '#10b981' : '#6b7280'
  return (
    <group position={[x, elevation, z]} rotation={[0, -heading, 0]}>
      {/* body */}
      <mesh position={[0, BODY_H / 2, 0]} castShadow>
        <boxGeometry args={[HEAD * 0.7, BODY_H, HEAD * 0.5]} />
        <meshStandardMaterial color="#4b5563" />
      </mesh>
      {/* head */}
      <mesh position={[0, BODY_H + HEAD / 2, 0]} castShadow>
        <boxGeometry args={[HEAD, HEAD, HEAD]} />
        <meshStandardMaterial color={accent} />
      </mesh>
      {/* profile picture on the front (-Z) face of the head */}
      <mesh position={[0, BODY_H + HEAD / 2, -HEAD / 2 - 0.1]}>
        <planeGeometry args={[HEAD * 0.9, HEAD * 0.9]} />
        <meshBasicMaterial map={tex ?? undefined} color={tex ? '#ffffff' : '#9ca3af'} toneMapped={false} />
      </mesh>
    </group>
  )
}

function RemoteAvatars() {
  const presenceByHub = useVoiceStore((s) => s.presenceByHub)
  const participants = useVoiceStore((s) => s.participants)
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers)
  const currentHubDTag = useVoiceStore((s) => s.currentHubDTag)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const currentHostPubkey = useVoiceStore((s) => s.currentHostPubkey)
  const myPubkey = useUserStore((s) => s.pubkey)

  if (!currentHubDTag) return null
  const presences = (presenceByHub[currentHubDTag] || []).filter(
    (p) =>
      p.channelId === currentChannelId &&
      p.status === 'joined' &&
      p.pubkey !== myPubkey &&
      participants[p.pubkey] &&
      (!p.hostPubkey || p.hostPubkey === currentHostPubkey),
  )

  return (
    <>
      {presences.map((p) => (
        <RemoteAvatar
          key={p.pubkey}
          pubkey={p.pubkey}
          x={p.position.x}
          z={p.position.y}
          elevation={p.elevation ?? 0}
          heading={p.heading ?? 0}
          speaking={participants[p.pubkey]?.isSpeaking ?? activeSpeakers.includes(p.pubkey)}
        />
      ))}
    </>
  )
}

function Scene() {
  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[CENTER + 300, 600, CENTER + 200]} intensity={1.1} castShadow />
      <hemisphereLight args={['#bcd4ff', '#202830', 0.5]} />

      {/* floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[CENTER, 0, CENTER]} receiveShadow>
        <planeGeometry args={[2400, 2400]} />
        <meshStandardMaterial color="#1b2026" />
      </mesh>
      <gridHelper args={[2400, 60, '#3a4452', '#2a313a']} position={[CENTER, 0.1, CENTER]} />

      {/* cubes to jump on */}
      {CUBES.map((c, i) => (
        <mesh key={i} position={[c.x, c.s / 2, c.z]} castShadow receiveShadow>
          <boxGeometry args={[c.s, c.s, c.s]} />
          <meshStandardMaterial color="#374151" />
        </mesh>
      ))}

      <Player />
      <RemoteAvatars />
    </>
  )
}

export default function VirtualSpace() {
  const toggleVirtualSpace = useVoiceStore((s) => s.toggleVirtualSpace)
  const controlsRef = useRef<any>(null)
  const [locked, setLocked] = useState(false)

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-indigo-500/40 bg-black">
      <Canvas
        shadows
        camera={{ fov: 75, near: 0.1, far: 6000, position: [CENTER, EYE, CENTER] }}
        gl={{ antialias: true }}
      >
        <Suspense fallback={null}>
          <Scene />
          <PointerLockControls
            ref={controlsRef}
            onLock={() => setLocked(true)}
            onUnlock={() => setLocked(false)}
          />
        </Suspense>
      </Canvas>

      {/* Crosshair while controlling */}
      {locked && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-white/70" />
        </div>
      )}

      {/* Enter prompt (shown when not pointer-locked) */}
      {!locked && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 backdrop-blur-[1px] cursor-pointer"
          onClick={() => controlsRef.current?.lock?.()}
        >
          <div className="px-4 py-3 rounded-xl bg-popover/90 border border-border text-center">
            <p className="text-sm font-semibold text-foreground">Click to enter</p>
            <p className="text-xs text-muted-foreground mt-1">WASD move · Space jump · Mouse look · Esc to release</p>
          </div>
        </div>
      )}

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
  )
}
