/**
 * SignerGuardBanner — Shows when the signer circuit breaker opens.
 *
 * Listens for 'signer-circuit-open' custom DOM event from signerGuard.ts.
 * Shows a persistent banner with:
 * - Warning about signer connection
 * - "Reconnect & Retry" → resets guard + reloads page
 * - "Dismiss" → hides banner
 *
 * Responsive: full-width on mobile, card on desktop.
 */

import { useState, useEffect, useCallback } from 'react'
import { WifiOff, RefreshCw, X, Loader2 } from 'lucide-react'
import { resetSignerGuard } from '@/lib/auth/signerGuard'
import { useUserStore } from '@/stores/userStore'
import { useHubStore } from '@/stores/hubStore'

export function SignerGuardBanner() {
  const [visible, setVisible] = useState(false)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    const handler = () => setVisible(true)
    window.addEventListener('signer-circuit-open', handler)
    return () => window.removeEventListener('signer-circuit-open', handler)
  }, [])

  // Reconnect the remote signer in place (no full reload) and re-attempt the
  // work that failed, instead of reloading the app (which re-runs login and,
  // for nostrconnect, would spawn a fresh connection string).
  const handleRetry = useCallback(async () => {
    if (retrying) return
    setRetrying(true)
    try {
      const { signer, privateKey } = useUserStore.getState()
      if (signer && !privateKey && typeof signer.reconnect === 'function') {
        await signer.reconnect()
      }
      resetSignerGuard()
      useHubStore.getState().bumpHubSecretRetry()
    } catch {
      /* best-effort */
    } finally {
      setRetrying(false)
      setVisible(false)
    }
  }, [retrying])

  if (!visible) return null

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[100] sm:max-w-sm animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-card border border-amber-500/30 shadow-xl">
        <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
          <WifiOff size={16} className="text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">Signer connection issue</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Your remote signer declined or couldn't process requests. Some content may not be visible.
          </p>
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 transition-colors cursor-pointer disabled:opacity-60"
            >
              {retrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {retrying ? 'Reconnecting…' : 'Reconnect & Retry'}
            </button>
            <button
              onClick={() => setVisible(false)}
              className="px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
        <button
          onClick={() => setVisible(false)}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors cursor-pointer shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
