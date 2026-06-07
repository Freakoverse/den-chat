import { useState, useCallback, useEffect, useRef } from 'react'
import { useUserStore } from './stores/userStore'
import { LoginScreen } from './components/auth/LoginScreen'
import { AppLayout } from './components/layout/AppLayout'
import { SplashScreen } from './components/auth/SplashScreen'
import { UpdateToast } from './components/ui/UpdateToast'
import { SignerGuardBanner } from './components/ui/SignerGuardBanner'
import { DenChatLogo } from './components/ui/DenChatLogo'
import { useStartup } from './hooks/useStartup'
import { useDeepLink } from './hooks/useDeepLink'
import { StorageKey } from './lib/constants'
import { ContextMenuProvider } from './components/ui/ContextMenu'

const skipSplash = localStorage.getItem(StorageKey.SKIP_SPLASH) === 'true'

export default function App() {
  useStartup()
  useDeepLink()
  const isAuthenticated = useUserStore((s) => s.isAuthenticated)
  const [splashDone, setSplashDone] = useState(skipSplash)

  // ── Login-to-app transition ──
  // Delays showing AppLayout until the overlay fully covers the screen,
  // preventing a flash of the app during the fade-in.
  const prevAuth = useRef(isAuthenticated)
  const [showOverlay, setShowOverlay] = useState(false)
  const [overlayOpacity, setOverlayOpacity] = useState(0)
  const [showApp, setShowApp] = useState(isAuthenticated)

  useEffect(() => {
    // Detect login transition (was false, now true)
    if (!prevAuth.current && isAuthenticated) {
      // Phase 1: mount overlay transparent, keep LoginScreen visible
      setShowOverlay(true)
      setOverlayOpacity(0)

      // Trigger fade-in on next frame
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setOverlayOpacity(1))
      })

      // Phase 2: after fade-in (500ms), overlay is opaque — safe to swap to AppLayout
      const t1 = setTimeout(() => setShowApp(true), 1000)
      // Phase 3: hold (500ms), then start fade-out
      const t2 = setTimeout(() => setOverlayOpacity(0), 1500)
      // Phase 4: after fade-out (500ms), unmount overlay
      const t3 = setTimeout(() => setShowOverlay(false), 2000)

      prevAuth.current = isAuthenticated
      return () => { cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
    }

    // Handle non-transition cases (already authenticated on mount, or logout)
    if (!isAuthenticated) setShowApp(false)
    prevAuth.current = isAuthenticated
  }, [isAuthenticated])

  const handleSplashComplete = useCallback(() => setSplashDone(true), [])

  return (
    <ContextMenuProvider>
      {showApp ? <AppLayout /> : <LoginScreen />}
      {!splashDone && <SplashScreen onComplete={handleSplashComplete} />}
      <UpdateToast />
      <SignerGuardBanner />
      {showOverlay && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            backgroundColor: 'hsl(var(--background))',
            opacity: overlayOpacity,
            transition: 'opacity 500ms ease',
            pointerEvents: overlayOpacity === 0 ? 'none' : 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <DenChatLogo size={96} className="grayscale opacity-25" />
        </div>
      )}
    </ContextMenuProvider>
  )
}
