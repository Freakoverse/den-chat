/**
 * OfflineBanner — Shows a persistent banner when the user has no internet connection.
 * Uses the browser's native online/offline events (event-driven, zero polling).
 * Pushes all content below it when visible.
 */

import { useState, useEffect } from 'react'
import { WifiOff } from 'lucide-react'

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine)

  useEffect(() => {
    const goOffline = () => setIsOffline(true)
    const goOnline = () => setIsOffline(false)

    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)

    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  if (!isOffline) return null

  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-destructive text-destructive-foreground text-xs font-medium shrink-0 select-none">
      <WifiOff size={13} />
      <span>You're offline — messages won't send until you reconnect</span>
    </div>
  )
}
