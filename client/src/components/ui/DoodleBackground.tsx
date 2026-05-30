/**
 * DoodleBackground — WhatsApp-style scattered icon pattern background
 *
 * Renders a grid of randomly-selected, randomly-rotated Lucide gaming/adventure
 * icons as a decorative background layer. Each mount produces a unique layout
 * using a seeded-random approach (stable per session, randomized on remount).
 *
 * Usage:
 *   <div className="relative">
 *     <DoodleBackground />
 *     <div className="relative z-10">...content...</div>
 *   </div>
 */

import { useMemo } from 'react'
import {
  GamepadDirectional,
  BowArrow,
  Dice5,
  Joystick,
  Sword,
  Swords,
  Gamepad,
  Gamepad2,
  ChessKnight,
  Headset,
  Bone,
  Gem,
  Castle,
  FlaskRound,
  Ghost,
  Heart,
  Pickaxe,
  Rocket,
  Shield,
  Star,
  Skull,
  Shovel,
  Volleyball,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const ICONS: LucideIcon[] = [
  GamepadDirectional,
  BowArrow,
  Dice5,
  Joystick,
  Sword,
  Swords,
  Gamepad,
  Gamepad2,
  ChessKnight,
  Headset,
  Bone,
  Gem,
  Castle,
  FlaskRound,
  Ghost,
  Heart,
  Pickaxe,
  Rocket,
  Shield,
  Star,
  Skull,
  Shovel,
  Volleyball,
]

interface DoodleItem {
  Icon: LucideIcon
  x: number        // percentage 0-100
  y: number        // percentage 0-100
  rotation: number  // degrees 0-360
  size: number      // px
  opacity: number   // 0-1
}

/**
 * Generate a deterministic-ish but visually random grid of icons.
 * Uses a simple seeded PRNG so the layout is stable for the component lifetime.
 */
function generateDoodles(count: number, seed: number): DoodleItem[] {
  // Simple mulberry32 PRNG
  let s = seed | 0
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const items: DoodleItem[] = []

  // Compute cols/rows based on screen aspect ratio so cells stay roughly square
  // On portrait screens (mobile), fewer cols + more rows; on landscape, the opposite
  const aspect = typeof window !== 'undefined'
    ? Math.max(0.3, Math.min(3, window.innerWidth / window.innerHeight))
    : 1
  const cols = Math.max(1, Math.round(Math.sqrt(count * aspect)))
  const rows = Math.ceil(count / cols)
  const cellW = 100 / cols
  const cellH = 100 / rows

  let placed = 0
  for (let row = 0; row < rows && placed < count; row++) {
    for (let col = 0; col < cols && placed < count; col++) {
      // Offset every other row by half a cell width (brick pattern)
      const rowOffset = row % 2 === 1 ? cellW * 0.5 : 0

      // Wide jitter (70% of cell) but centered, plus the row offset
      const x = col * cellW + rowOffset + rand() * cellW * 0.7 + cellW * 0.15
      const y = row * cellH + rand() * cellH * 0.7 + cellH * 0.15

      const Icon = ICONS[Math.floor(rand() * ICONS.length)]
      const rotation = Math.floor(rand() * 360)
      const size = 18 + Math.floor(rand() * 12)       // 18-30px
      const opacity = 0.05

      items.push({ Icon, x: x % 100, y, rotation, size, opacity })
      placed++
    }
  }

  return items
}

interface DoodleBackgroundProps {
  /** Number of icons to scatter (default: 80) */
  count?: number
  /** CSS class to apply to the container */
  className?: string
}

export function DoodleBackground({ count = 500, className = '' }: DoodleBackgroundProps) {
  // Halve icon count on narrow screens to reduce visual clutter
  const effectiveCount = typeof window !== 'undefined' && window.innerWidth <= 1080
    ? Math.round(count / 4)
    : count

  const doodles = useMemo(
    () => generateDoodles(effectiveCount, Math.floor(Math.random() * 0xffffffff)),
    [effectiveCount],
  )

  return (
    <div
      className={`absolute inset-0 overflow-hidden pointer-events-none select-none ${className}`}
      aria-hidden="true"
    >
      {doodles.map((d, i) => (
        <d.Icon
          key={i}
          size={d.size}
          strokeWidth={1.5}
          className="absolute"
          style={{
            left: `${d.x}%`,
            top: `${d.y}%`,
            transform: `rotate(${d.rotation}deg)`,
            opacity: d.opacity,
            color: '#4169E1',  // Royal blue — matches DEN Chat logo inner accent
          }}
        />
      ))}
    </div>
  )
}
