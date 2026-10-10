import { useState, useCallback, useEffect, useRef } from 'react'
import { useUserStore } from './stores/userStore'
import { LoginScreen } from './components/auth/LoginScreen'
import { AppLayout } from './components/layout/AppLayout'
import { SplashScreen } from './components/auth/SplashScreen'
import { UpdateToast } from './components/ui/UpdateToast'
import { SignerGuardBanner } from './components/ui/SignerGuardBanner'
import { VaultLockGate } from './components/auth/VaultLockGate'
import { DenChatLogo } from './components/ui/DenChatLogo'
import { useStartup } from './hooks/useStartup'
import { useDeepLink } from './hooks/useDeepLink'
import { StorageKey } from './lib/constants'
import { ContextMenuProvider } from './components/ui/ContextMenu'
import { UserProfileModal } from './components/hub/UserProfileModal'

/** Listens for 'open-profile-modal' custom events and renders a UserProfileModal at the app root. */
function GlobalProfileModalListener() {
  const [pubkey, setPubkey] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const pk = (e as CustomEvent).detail as string
      if (pk) setPubkey(pk)
    }
    window.addEventListener('open-profile-modal', handler)
    return () => window.removeEventListener('open-profile-modal', handler)
  }, [])

  if (!pubkey) return null
  return (
    <UserProfileModal
      // Key by target: 'open-profile-modal' can switch the target A→B without `open` going false,
      // and the modal fetches once (guarded by `loaded`). Without the key the card would keep showing
      // user A while the action buttons (Block/Follow/DM) target user B — a click hits the wrong user.
      key={pubkey}
      open={true}
      onClose={() => setPubkey(null)}
      targetPubkey={pubkey}
    />
  )
}

// Guarded: this runs at module-eval, before React mounts — an unguarded throw here (Firefox with
// blocked site data) would blank the app. storageGuard normally prevents it; read safely regardless.
const skipSplash = (() => {
  try { return localStorage.getItem(StorageKey.SKIP_SPLASH) === 'true' } catch { return false }
})()

// Game-style tips shown on the login transition overlay. One is picked at random per login.
const LOGIN_TIPS = [
  'Lose your private key or seed words and you lose your account. No one can recover them for you.',
  'If your private key or seed words are ever exposed, that account is permanently compromised.',
  'There is no "reset password" or "forgot password" here. Keep your keys and seed words safe and secure.',
  'Want to keep your and your members\' messages from disappearing forever? Run your own nostr relay and Blossom server.',
]

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
  const [loginTip, setLoginTip] = useState('')

  useEffect(() => {
    // Detect login transition (was false, now true)
    if (!prevAuth.current && isAuthenticated) {
      // Phase 1: mount overlay transparent, keep LoginScreen visible
      setLoginTip(LOGIN_TIPS[Math.floor(Math.random() * LOGIN_TIPS.length)])
      setShowOverlay(true)
      setOverlayOpacity(0)

      // Trigger fade-in on next frame
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setOverlayOpacity(1))
      })

      // Phase 2: after fade-in (500ms), overlay is opaque — safe to swap to AppLayout
      const t1 = setTimeout(() => setShowApp(true), 1000)
      // Phase 3: hold (5500ms: the original 500ms plus 5 extra seconds), then start fade-out
      const t2 = setTimeout(() => setOverlayOpacity(0), 6500)
      // Phase 4: after fade-out (500ms), unmount overlay
      const t3 = setTimeout(() => setShowOverlay(false), 7000)

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
      <GlobalProfileModalListener />
      <SignerGuardBanner />
      <VaultLockGate />
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
          <div className="flex flex-col items-center gap-7 px-6 w-full max-w-md text-center">
            <DenChatLogo size={96} className="grayscale opacity-25" />
            {/* Game-style loading tip */}
            <div className="flex flex-col items-center gap-1.5 min-h-[4.5rem]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/50">Tip</span>
              <p className="text-sm text-muted-foreground/90 leading-relaxed">{loginTip}</p>
            </div>
            {/* Loading bar: cosmetic, fills over the overlay hold */}
            <div className="w-56 h-1 rounded-full bg-muted-foreground/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-muted-foreground/50"
                style={{ animation: 'loginLoadingBarFill 6500ms linear forwards' }}
              />
            </div>
          </div>
        </div>
      )}
    </ContextMenuProvider>
  )
}
