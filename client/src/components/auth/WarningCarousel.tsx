/** Rotating amber warning carousel shown on the create-account screens (desktop + vault). */
import { useState, useEffect } from 'react'
import { AlertCircle, ShieldAlert } from 'lucide-react'

const WARNING_MESSAGES = [
  {
    icon: AlertCircle,
    text: (
      <>
        <span className="font-semibold">There is no PIN recovery.</span> If you forget your PIN,
        your only option is to re-import using your raw seed phrase (the 24 words).
      </>
    ),
  },
  {
    icon: ShieldAlert,
    text: (
      <>
        If your device is compromised, then so is your account, and you wouldn't know about it
        unless the attacker takes action you notice. No solution.
      </>
    ),
  },
]

export function WarningCarousel() {
  const [index, setIndex] = useState(0)
  const [fading, setFading] = useState(false)
  const [paused, setPaused] = useState(false)
  const INTERVAL = 10_000

  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => {
      setFading(true)
      setTimeout(() => {
        setIndex(i => (i + 1) % WARNING_MESSAGES.length)
        setFading(false)
      }, 200)
    }, INTERVAL)
    return () => clearInterval(timer)
  }, [paused])

  const { icon: Icon, text } = WARNING_MESSAGES[index]

  return (
    <div
      className="w-full rounded-lg bg-amber-500/10 border border-amber-500/30 overflow-hidden cursor-pointer select-none"
      onClick={() => setPaused(p => !p)}
    >
      <div
        className="flex items-start gap-2 px-3 py-2 transition-opacity duration-200"
        style={{ opacity: fading ? 0 : 1 }}
      >
        <Icon size={14} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-600 dark:text-amber-400">{text}</p>
      </div>
      {/* Timer progress bar — pure CSS animation */}
      <div className="h-[2px] w-full bg-amber-500/10">
        <div
          key={`${index}-${paused}`}
          className="h-full bg-amber-500/50"
          style={{
            animation: `warningProgress ${INTERVAL}ms linear`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
        />
      </div>
      <style>{`
        @keyframes warningProgress {
          from { width: 0%; }
          to   { width: 100%; }
        }
      `}</style>
    </div>
  )
}
