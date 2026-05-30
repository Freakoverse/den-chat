/**
 * SplashScreen — Full-page animated logo intro
 *
 * Shows the animated DEN logo centered on screen with:
 * - 0-3s: Logo fades in (0→1 opacity) while scaling (1→1.25), ease-in-out
 * - 3-4s: Entire screen fades out (1→0 opacity)
 * - Then calls onComplete to unmount
 */

import { useState, useEffect } from 'react'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite resolves SVG imports as URL strings
import logoSvg from '@/assets/den chat logo a animated.svg'

export function SplashScreen({ onComplete }: { onComplete: () => void }) {
  const [phase, setPhase] = useState<'logo' | 'fadeout' | 'done'>('logo')

  useEffect(() => {
    // After 4s logo animation, start screen fade-out
    const t1 = setTimeout(() => setPhase('fadeout'), 4000)
    // After 5s total (4s logo + 1s fade), signal done
    const t2 = setTimeout(() => {
      setPhase('done')
      onComplete()
    }, 5000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [onComplete])

  if (phase === 'done') return null

  return (
    <div
      className="splash-overlay"
      style={{
        opacity: phase === 'fadeout' ? 0 : 1,
        transition: phase === 'fadeout' ? 'opacity 1s ease-in-out' : undefined,
      }}
    >
      <img
        src={logoSvg}
        alt="DEN Chat"
        className="splash-logo"
      />

      <style>{`
        .splash-overlay {
          position: fixed;
          inset: 0;
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          background: hsl(var(--background, 0 0% 7%));
        }

        .splash-logo {
          width: 100%;
          height: 100%;
          max-width: 180px;
          max-height: 180px;
          animation:
            splashOpacity 4s ease-in-out forwards,
            splashScale 5s ease-in-out forwards;
        }

        @media (max-width: 1080px) {
          .splash-logo {
            max-width: 90px;
            max-height: 90px;
          }
        }

        @keyframes splashOpacity {
          0% { opacity: 0; }
          10% { opacity: 0; }
          30% { opacity: 1; }
          70% { opacity: 1; }
          100% { opacity: 0; }
        }

        @keyframes splashScale {
          0% { transform: scale(1); }
          100% { transform: scale(1.15); }
        }
      `}</style>
    </div>
  )
}
