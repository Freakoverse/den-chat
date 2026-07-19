import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useUserStore, type ISigner } from '@/stores/userStore'
import { isTauri, isMobileOS } from '@/lib/utils'
import { ADMIN_PUBKEY, StorageKey } from '@/lib/constants'
import { fetchReplaceable, fetchEvents, publishToSpecificRelays, getRelayList } from '@/lib/nostr/relay-pool'
import { MonitorSmartphone, Import, Plus, Loader2, AlertCircle, Link2, KeyRound, Copy, Check, AppWindow, ChevronDown, ChevronLeft, ChevronRight, X, Shield, ExternalLink, User, Lock, Eye, EyeOff, GitBranch, Sprout, KeySquare, Download, FileUp, BookOpen, Camera, Settings2, XCircle, FileText, Package, LockOpen, Globe, RefreshCw, Rocket, QrCode } from 'lucide-react'
import { useProfileCache } from '@/hooks/useProfileCache'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { DenChatLogo } from '@/components/ui/DenChatLogo'
import { WarningCarousel } from '@/components/auth/WarningCarousel'
import { PinInput } from '@/components/auth/PinInput'
import { QRCodeSVG } from 'qrcode.react'
import { isValidMnemonic, generateSeedPhrase } from '@/lib/auth'
import { uploadToBlossomServers, blossomServers as blossomServerManager } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import {
  type StoredAccount, type StoredSeed,
} from '@/lib/auth/secure-storage'
import { rustBackend, vaultBackend, applyLogin } from '@/lib/auth/authBackend'
import { verifyBackupMatches } from '@/lib/auth/backupCrypto'
import { QRScanner } from '@/components/auth/QRScanner'
import { PC55Signer, discover } from '@/lib/auth/pc55'
import { BunkerSigner } from '@/lib/auth/bunker'
import { NostrConnectSigner, generateNostrConnectDetails } from '@/lib/auth/nostr-connect'
import { Nip07Signer } from '@/lib/auth/nip07'
import upv2Service from '@/services/upv2.service'

const LOGIN_BG_DTAG = 'den-chat-background-login'
const ADS_DTAG = 'den-chat-ads'

interface LoginBgButton { text: string; link: string }
interface LoginBgEntry {
  image: string
  profilePic: string
  name: string
  description?: string
  buttons: LoginBgButton[]
}

type Screen = 'main' | 'advanced' | 'upv2' | 'import' | 'nip46' | 'pin-login' | 'generate-pin' | 'import-pin' | 'derive-pin' | 'seed-backup' | 'saved-accounts' | 'onboarding-profile'

export function LoginScreen() {
  const login = useUserStore((s) => s.login)
  const setSeedPhrase = useUserStore((s) => s.setSeedPhrase)
  const setSigner = useUserStore((s) => s.setSigner)
  const localSignerName = useUserStore((s) => s.localSignerName)
  const isDesktop = isTauri()
  const isMobile = isMobileOS()

  const [screen, setScreen] = useState<Screen>('main')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLocalSignerModal, setShowLocalSignerModal] = useState(false)

  // Import
  const [importWords, setImportWords] = useState('')

  // NIP-46 bunker
  const [bunkerUrl, setBunkerUrl] = useState('')

  // NIP-46 nostr connect — generated on dialog open
  const [connectDetails, setConnectDetails] = useState<ReturnType<typeof generateNostrConnectDetails> | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectPending, setConnectPending] = useState(false)
  const connectAbortRef = useRef<AbortController | null>(null)
  const [copied, setCopied] = useState(false)
  const [showTerms, setShowTerms] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [showExtensionGuide, setShowExtensionGuide] = useState(false)

  // ── Saved accounts (desktop keyring) ──
  const [savedAccounts, setSavedAccounts] = useState<StoredAccount[]>([])
  const [savedSeeds, setSavedSeeds] = useState<StoredSeed[]>([])
  const [selectedAccount, setSelectedAccount] = useState<StoredAccount | null>(null)
  const [pin, setPin] = useState('')
  const [pinHint, setPinHint] = useState('')
  const [accountName, setAccountName] = useState('')
  // Mobile-web (PWA) uses the vault for key storage; desktop uses the OS keyring. One UI, one backend.
  const useVault = !isDesktop && isMobile
  const backend = useVault ? vaultBackend : rustBackend
  // Desktop generate flow: the seed is held here IN MEMORY and only written to the
  // keyring once the user has verified their backup (handleFinishGenerate). Until then
  // no account exists, so abandoning the flow (navigate/refresh/close) leaves nothing.
  const [pendingGen, setPendingGen] = useState<{ mnemonic: string; pin: string; name?: string; hint?: string } | null>(null)
  const [backupMnemonic, setBackupMnemonic] = useState<string | null>(null)
  const [showBackupWords, setShowBackupWords] = useState(false)
  // Recovery-phrase grid is collapsed by default so focus lands on the backup download.
  const [showSeedAccordion, setShowSeedAccordion] = useState(false)
  const [backupCopied, setBackupCopied] = useState(false)
  const [deriveSeedId, setDeriveSeedId] = useState<string | null>(null)
  const [showBackupPinPrompt, setShowBackupPinPrompt] = useState(false)
  const [backupPin, setBackupPin] = useState('')
  const [backupPinError, setBackupPinError] = useState<string | null>(null)
  const [backupDownloading, setBackupDownloading] = useState(false)
  const [backupDownloaded, setBackupDownloaded] = useState(false)
  // Re-upload-to-verify: confirm the saved backup file decrypts to this exact seed before continuing.
  const [backupVerified, setBackupVerified] = useState(false)
  const [backupVerifyPin, setBackupVerifyPin] = useState('')
  const [backupVerifying, setBackupVerifying] = useState(false)
  const [backupVerifyError, setBackupVerifyError] = useState<string | null>(null)
  const verifyFileRef = useRef<HTMLInputElement>(null)

  // Reveal-seed confirmation + 5s countdown (guards against shoulder-surfing)
  const [showRevealConfirm, setShowRevealConfirm] = useState(false)
  const [revealCountdown, setRevealCountdown] = useState<number | null>(null)
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [showCopyConfirm, setShowCopyConfirm] = useState(false)

  const startRevealCountdown = () => {
    let remaining = 5
    setRevealCountdown(remaining)
    if (revealTimerRef.current) clearInterval(revealTimerRef.current)
    revealTimerRef.current = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        if (revealTimerRef.current) { clearInterval(revealTimerRef.current); revealTimerRef.current = null }
        setRevealCountdown(null)
        setShowRevealConfirm(false)
        setShowBackupWords(true)
      } else {
        setRevealCountdown(remaining)
      }
    }, 1000)
  }

  const cancelReveal = () => {
    if (revealTimerRef.current) { clearInterval(revealTimerRef.current); revealTimerRef.current = null }
    setRevealCountdown(null)
    setShowRevealConfirm(false)
  }

  // Clear any pending reveal countdown on unmount
  useEffect(() => () => { if (revealTimerRef.current) clearInterval(revealTimerRef.current) }, [])

  // File import (encrypted backup)
  const [fileImportPassword, setFileImportPassword] = useState('')
  const [fileImportError, setFileImportError] = useState<string | null>(null)
  const [fileImportLoading, setFileImportLoading] = useState(false)
  const [showFilePasswordPrompt, setShowFilePasswordPrompt] = useState(false)
  const [showQrScanner, setShowQrScanner] = useState(false)
  const [pendingFileData, setPendingFileData] = useState<string | null>(null)

  // Carousel state for account picker
  const [selectedSeedIdx, setSelectedSeedIdx] = useState(0)
  const [accountIdx, setAccountIdx] = useState(0)
  const [showSeedPicker, setShowSeedPicker] = useState(false)

  // ── Onboarding state (post-generate profile setup) ──
  const [onboardingPubkey, setOnboardingPubkey] = useState<string | null>(null)
  const [onboardingPrivateKey, setOnboardingPrivateKey] = useState<string | null>(null)
  // Signer to sign onboarding events with (vault path); null on desktop (uses the raw key above).
  const [onboardingSigner, setOnboardingSigner] = useState<ISigner | null>(null)
  const [profileName, setProfileName] = useState('')
  const [profilePicUrl, setProfilePicUrl] = useState('')
  const [picUploadStatus, setPicUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle')
  const [picUploadProgress, setPicUploadProgress] = useState<UploadProgress | null>(null)
  const [picUploadError, setPicUploadError] = useState<string | null>(null)
  const picInputRef = useRef<HTMLInputElement>(null)
  const picAbortRef = useRef<AbortController | null>(null)
  const [showAdvancedModal, setShowAdvancedModal] = useState(false)
  const [onboardRelays, setOnboardRelays] = useState<{ url: string; enabled: boolean }[]>([])
  const [onboardBlossoms, setOnboardBlossoms] = useState<{ url: string; enabled: boolean }[]>([])
  const [customRelayInput, setCustomRelayInput] = useState('')
  const [customBlossomInput, setCustomBlossomInput] = useState('')
  const [advancedTab, setAdvancedTab] = useState<'relays' | 'blossoms'>('relays')
  const [publishing, setPublishing] = useState(false)

  // Profile cache for NIP-05 display names
  const { getProfile } = useProfileCache()

  // Build account groups: seeds + standalone nsec imports as a pseudo-group
  const accountGroups = useMemo(() => {
    const groups: { type: 'seed' | 'standalone'; seed?: typeof savedSeeds[0]; accounts: StoredAccount[] }[] = []
    for (const seed of savedSeeds) {
      const accts = savedAccounts.filter((a) => a.seed_id === seed.id)
      if (accts.length > 0) groups.push({ type: 'seed', seed, accounts: accts })
    }
    const standalone = savedAccounts.filter((a) => !a.seed_id)
    if (standalone.length > 0) groups.push({ type: 'standalone', accounts: standalone })
    return groups
  }, [savedAccounts, savedSeeds])

  // Current group + account
  const currentGroup = accountGroups[selectedSeedIdx] || null
  const currentAccounts = currentGroup?.accounts || []
  const currentAccount = currentAccounts[accountIdx] || null

  // After generate/import, jump the carousel to the new account once the lists refresh.
  const [pendingSelectPubkey, setPendingSelectPubkey] = useState<string | null>(null)
  useEffect(() => {
    if (!pendingSelectPubkey) return
    for (let gi = 0; gi < accountGroups.length; gi++) {
      const ai = accountGroups[gi].accounts.findIndex((a) => a.pubkey === pendingSelectPubkey)
      if (ai !== -1) { setSelectedSeedIdx(gi); setAccountIdx(ai); setPendingSelectPubkey(null); break }
    }
  }, [accountGroups, pendingSelectPubkey])

  // Load saved accounts from the active backend (desktop keyring, or mobile vault).
  const loadAccounts = useCallback(async () => {
    if (!isDesktop && !useVault) return
    const [accounts, seeds] = await Promise.all([backend.listAccounts(), backend.listSeeds()])
    setSavedAccounts(accounts)
    setSavedSeeds(seeds)
  }, [isDesktop, useVault, backend])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  // ── Pending deletion from Settings (deferred to LoginScreen for stability) ──
  const [pendingDelete, setPendingDelete] = useState<{ pubkey: string; pin: string } | null>(null)
  const [deleteStatus, setDeleteStatus] = useState<'deleting' | 'done' | 'error'>('deleting')
  const [deleteError, setDeleteError] = useState('')

  // Effect 1: Read pending-delete from sessionStorage (no cleanup → StrictMode-safe)
  useEffect(() => {
    const raw = sessionStorage.getItem('pending-delete')
    if (!raw) return
    sessionStorage.removeItem('pending-delete')
    try {
      const data = JSON.parse(raw) as { pubkey: string; pin: string }
      // Vault confirms the delete PIN in its own overlay, so an empty pin is expected there.
      if (data.pubkey && (data.pin || backend.promptsInVault)) {
        setPendingDelete(data)
        setDeleteStatus('deleting')
      }
    } catch { /* corrupt data, ignore */ }
  }, [])

  // Effect 2: Execute deletion when pendingDelete is set (survives StrictMode double-mount)
  useEffect(() => {
    if (!pendingDelete) return

    let cancelled = false

    // Safety timeout — if the backend never responds, don't leave the user stuck
    const safetyTimer = setTimeout(() => {
      if (!cancelled) {
        cancelled = true
        setDeleteError('Deletion timed out. Please restart the app and try again.')
        setDeleteStatus('error')
      }
    }, 30_000)

    // Short delay so the UI transition fully settles
    const invokeTimer = setTimeout(() => {
      if (cancelled) return
      backend.deleteAccount(pendingDelete.pubkey, pendingDelete.pin)
        .then(() => {
          if (cancelled) return
          cancelled = true
          clearTimeout(safetyTimer)
          setDeleteStatus('done')
          loadAccounts()
        })
        .catch((err: unknown) => {
          if (cancelled) return
          cancelled = true
          clearTimeout(safetyTimer)
          const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Deletion failed'
          setDeleteError(msg)
          setDeleteStatus('error')
        })
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(invokeTimer)
      clearTimeout(safetyTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDelete])

  // ── Pending account-switch from UserPanel (stashed before page reload) ──
  useEffect(() => {
    const raw = sessionStorage.getItem('pending-switch')
    if (!raw) return
    sessionStorage.removeItem('pending-switch')
    try {
      const data = JSON.parse(raw) as { pubkey: string; authMethod: string; privKeyHex?: string }
      if (data.pubkey && data.privKeyHex) {
        // Desktop: the released private key was stashed before the reload.
        login(data.pubkey, data.authMethod as 'seed' | 'nsec', data.privKeyHex)
      } else if (data.pubkey && data.authMethod === 'vault') {
        // PWA: re-unlock the target account in the vault's own overlay (the app never sees the PIN).
        // The vault collects the PIN in its own overlay, so the pin arg is unused here.
        vaultBackend.loginAccount(data.pubkey, '').then((r) => applyLogin(data.pubkey, r)).catch(() => {})
      }
    } catch { /* corrupt data, ignore */ }
  }, [login])

  // ── Bunker auto-login from localStorage (NIP-46 remote signer) ──
  useEffect(() => {
    const bunkerStored = localStorage.getItem(StorageKey.BUNKER_URL)
    const clientSecretStored = localStorage.getItem(StorageKey.BUNKER_CLIENT_SECRET)
    if (!bunkerStored || !clientSecretStored) return

    let cancelled = false
    let retryCount = 0
    const maxRetries = 3

    const attempt = async (): Promise<void> => {
      try {
        const signer = new BunkerSigner(clientSecretStored)
        // Bound each attempt: a flaky/suspended relay can leave login() hanging
        // forever (common on mobile after the PWA was backgrounded), which would
        // stall the whole retry loop. Time out so the next retry actually fires.
        const pubkey = await Promise.race([
          signer.login(bunkerStored, false),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out reaching the remote signer')), 20_000)),
        ])
        if (cancelled) return
        setSigner(signer)
        login(pubkey, 'nip46')
      } catch (err) {
        if (cancelled) return
        retryCount++
        if (retryCount < maxRetries) {
          setError(`Reconnecting to remote signer… (${retryCount + 1}/${maxRetries})`)
          await new Promise((r) => setTimeout(r, 2000))
          if (!cancelled) return attempt()
        } else {
          const msg = err instanceof Error ? err.message : 'Connection failed'
          setError(`Remote signer unreachable: ${msg}. Try again from the Connect button below.`)
        }
      }
    }

    setError('Connecting to remote signer… (1/3)')
    attempt()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [bgEntries, setBgEntries] = useState<LoginBgEntry[]>([])
  const [adEntries, setAdEntries] = useState<LoginBgEntry[]>([])
  const bgShowcaseEnabled = typeof window !== 'undefined' && localStorage.getItem(StorageKey.BG_SHOWCASE) !== 'false'
  const adShowcaseEnabled = typeof window !== 'undefined' && localStorage.getItem(StorageKey.AD_SHOWCASE) !== 'false'
  const [bgLoading, setBgLoading] = useState(bgShowcaseEnabled || adShowcaseEnabled)

  useEffect(() => {
    if (!bgShowcaseEnabled && !adShowcaseEnabled) return

    let bgDone = !bgShowcaseEnabled, adDone = !adShowcaseEnabled
    const checkDone = () => { if (bgDone && adDone) setBgLoading(false) }

    if (bgShowcaseEnabled) {
      fetchReplaceable(ADMIN_PUBKEY, 30078, LOGIN_BG_DTAG).then((event) => {
        if (event && event.content) {
          try {
            const arr = JSON.parse(event.content)
            if (Array.isArray(arr) && arr.length > 0) {
              setBgEntries(arr.filter((e: LoginBgEntry) => e.image))
            }
          } catch { /* ignore parse errors */ }
        }
      }).finally(() => { bgDone = true; checkDone() })
    }

    if (adShowcaseEnabled) {
      fetchReplaceable(ADMIN_PUBKEY, 30078, ADS_DTAG).then((event) => {
        if (event && event.content) {
          try {
            const arr = JSON.parse(event.content)
            if (Array.isArray(arr) && arr.length > 0) {
              // Ads use 'banner' field as background image
              setAdEntries(arr.filter((e: any) => e.banner).map((e: any) => ({
                image: e.banner,
                profilePic: e.profilePic || '',
                name: e.name || '',
                description: e.description || '',
                buttons: Array.isArray(e.buttons) ? e.buttons : [],
              })))
            }
          } catch { /* ignore parse errors */ }
        }
      }).finally(() => { adDone = true; checkDone() })
    }
  }, [])

  // Read which list was last shown — once, at mount time
  const BG_LIST_KEY = 'den-chat-login-bg-last-list'
  const BG_SEEN_KEY = 'den-chat-login-bg-seen'
  const AD_SEEN_KEY = 'den-chat-login-ad-seen'
  const lastListRef = useRef(typeof window !== 'undefined' ? localStorage.getItem(BG_LIST_KEY) : null)

  /**
   * Pick a random entry from `list` that hasn't been shown yet (round-robin).
   * - Tracks seen image URLs in localStorage under `storageKey`.
   * - Prunes stale URLs that are no longer in the current list (handles list edits).
   * - Resets the cycle when every entry has been shown.
   */
  const pickUnseen = useCallback((list: LoginBgEntry[], storageKey: string): LoginBgEntry => {
    const allUrls = new Set(list.map(e => e.image))

    // Load previously seen URLs and prune any that no longer exist in the list
    let seen: Set<string>
    try {
      const raw = localStorage.getItem(storageKey)
      const arr: string[] = raw ? JSON.parse(raw) : []
      seen = new Set(arr.filter(url => allUrls.has(url)))
    } catch {
      seen = new Set<string>()
    }

    // Find entries not yet shown in this cycle
    let unseen = list.filter(e => !seen.has(e.image))
    if (unseen.length === 0) {
      // All shown — reset cycle
      seen.clear()
      unseen = list
    }

    // Pick randomly from unseen
    const pick = unseen[Math.floor(Math.random() * unseen.length)]

    // Mark as seen and persist
    seen.add(pick.image)
    localStorage.setItem(storageKey, JSON.stringify([...seen]))

    return pick
  }, [])

  // Alternate between bg and ad lists.
  // First-time / new user always sees the non-ad list.
  const { activeBg, isAd } = useMemo(() => {
    const hasBg = bgEntries.length > 0
    const hasAd = adEntries.length > 0

    if (!hasBg && !hasAd) return { activeBg: null, isAd: false }
    if (!hasAd) return { activeBg: pickUnseen(bgEntries, BG_SEEN_KEY), isAd: false }
    if (!hasBg) return { activeBg: pickUnseen(adEntries, AD_SEEN_KEY), isAd: true }

    // Both lists available — alternate
    // If last was 'bg' → show ad. If last was 'ad' or null (first visit) → show bg.
    const useAd = lastListRef.current === 'bg'
    return {
      activeBg: pickUnseen(useAd ? adEntries : bgEntries, useAd ? AD_SEEN_KEY : BG_SEEN_KEY),
      isAd: useAd,
    }
  }, [bgEntries, adEntries, pickUnseen])

  // Persist the list alternation choice ONCE after both lists have loaded
  useEffect(() => {
    if (bgEntries.length > 0 && adEntries.length > 0) {
      localStorage.setItem(BG_LIST_KEY, isAd ? 'ad' : 'bg')
    }
  }, [bgEntries, adEntries, isAd])

  const bgImageUrl = activeBg?.image || null

  const clearError = () => { setError(null); setConnectError(null) }
  const goBack = () => { connectAbortRef.current?.abort(); setScreen('main'); clearError(); setConnectDetails(null); setConnectPending(false) }

  // ─── UPV2 Login (main form) ───
  const handleUPV2Login = async () => {
    if (!username.trim()) { setError('Enter a DNN ID or npub'); return }
    if (!password.trim()) { setError('Enter your password'); return }

    setLoading('upv2')
    clearError()
    try {
      const result = await upv2Service.login(username.trim(), password)
      if (!result.success || !result.session) {
        setError(result.error || 'UPV2 login failed')
        return
      }
      setSigner(upv2Service as any)
      login(result.session.signerPubkey, 'upv2')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(null)
    }
  }

  // ─── PC55 Login (detect-on-click) ───
  const handleLocalLogin = async () => {
    setLoading('pc55')
    clearError()
    try {
      // Step 1: Try to discover the signer first
      const info = await discover()
      if (!info) {
        // No signer found — show the friendly modal
        setShowLocalSignerModal(true)
        return
      }
      // Step 2: Signer found — proceed with login
      const signer = new PC55Signer()
      await signer.init()
      const pubkey = await signer.getPublicKey()
      setSigner(signer)
      login(pubkey, 'pc55')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to local signer')
    } finally {
      setLoading(null)
    }
  }

  // ─── NIP-07 Login (Browser Extension) ───
  const handleNip07Login = async () => {
    clearError()
    // If no extension detected, show the install guide
    if (!window.nostr) {
      setShowExtensionGuide(true)
      return
    }
    setLoading('nip07')
    try {
      const signer = new Nip07Signer()
      await signer.init()
      const pubkey = await signer.getPublicKey()
      setSigner(signer)
      login(pubkey, 'nip46') // group with external signers
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browser extension login failed')
    } finally {
      setLoading(null)
    }
  }

  // ─── NIP-46 Bunker Login ───
  const handleBunkerLogin = async () => {
    if (!bunkerUrl.trim()) { setError('Enter a bunker:// URL'); return }

    setLoading('bunker')
    clearError()
    try {
      const signer = new BunkerSigner()
      const pubkey = await signer.login(bunkerUrl.trim())
      // Persist bunker URL + client secret for auto-login on startup
      localStorage.setItem(StorageKey.BUNKER_URL, bunkerUrl.trim())
      localStorage.setItem(StorageKey.BUNKER_CLIENT_SECRET, signer.getClientSecretKey())
      setSigner(signer)
      login(pubkey, 'nip46')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bunker login failed')
    } finally {
      setLoading(null)
    }
  }

  // ─── NIP-46: Open combined dialog ───
  const openNip46Dialog = () => {
    clearError()
    const details = generateNostrConnectDetails()
    setConnectDetails(details)
    setConnectPending(true)
    setScreen('nip46')
  }

  // ─── NIP-46 Nostr Connect auto-login (runs when dialog opens) ───
  const handleNostrConnectLogin = useCallback(async () => {
    if (!connectDetails) return

    // Abort any previous attempt
    connectAbortRef.current?.abort()
    const abortController = new AbortController()
    connectAbortRef.current = abortController

    setConnectPending(true)
    setConnectError(null)
    try {
      const signer = new NostrConnectSigner(connectDetails.privKey)
      const { pubkey } = await signer.login(connectDetails.connectionString, abortController.signal)
      if (abortController.signal.aborted) return
      setSigner(signer)
      login(pubkey, 'nip46')
    } catch (err) {
      if (abortController.signal.aborted) return
      setConnectError(
        err instanceof Error
          ? `${err.message}. Tap Retry or go back and try again.`
          : 'Connection failed. Tap Retry or go back and try again.'
      )
      setConnectPending(false)
    }
  }, [connectDetails, setSigner, login])

  // Auto-start nostr connect when dialog opens (StrictMode-safe: abort on cleanup)
  useEffect(() => {
    if (screen === 'nip46' && connectDetails) {
      handleNostrConnectLogin()
    }
    return () => {
      connectAbortRef.current?.abort()
    }
  }, [screen, connectDetails, handleNostrConnectLogin])

  // Re-subscribe with the SAME key when the PWA returns to the foreground. Mobile
  // suspends the relay WebSocket while you're in your signer app — the cause of
  // "subscription closed before connection was established" — so on return we
  // re-establish the subscription (same nostrconnect:// code) for the signer to land on.
  useEffect(() => {
    if (screen !== 'nip46') return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && connectDetails) handleNostrConnectLogin()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [screen, connectDetails, handleNostrConnectLogin])

  const copyConnectionString = () => {
    if (!connectDetails?.connectionString) return
    navigator.clipboard.writeText(connectDetails.connectionString)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ─── Import Account (now asks for PIN first) ───
  const handleImportValidate = () => {
    clearError()
    const words = importWords.trim()
    if (!words) { setError('Enter your seed phrase or private key'); return }
    if (!isValidMnemonic(words) && !/^(nsec1[a-z0-9]+|[0-9a-f]{64})$/i.test(words)) {
      setError('Invalid seed phrase, nsec, or hex private key')
      return
    }
    setPin('')
    setPinHint('')
    setAccountName('')
    setScreen('import-pin')
  }

  // ─── Import from encrypted backup (file or QR) ───
  // Validate a backup JSON string and open the password prompt. Shared by file + QR.
  const loadBackupText = (text: string): boolean => {
    try {
      const data = JSON.parse(text)
      if (data.version !== 1 || data.alg !== 'AES-256-GCM') { setError('Unrecognized backup format'); return false }
      setPendingFileData(text)
      setFileImportPassword('')
      setFileImportError(null)
      setShowFilePasswordPrompt(true)
      return true
    } catch {
      setError("Could not read backup — make sure it's a valid backup")
      return false
    }
  }

  const handleFileImportPick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) loadBackupText(await file.text())
    }
    input.click()
  }

  const handleFileDecrypt = async () => {
    if (!pendingFileData) return
    if (!fileImportPassword) { setFileImportError('Enter the backup password'); return }
    setFileImportLoading(true)
    setFileImportError(null)
    try {
      const data = JSON.parse(pendingFileData)
      const salt = Uint8Array.from(atob(data.salt), c => c.charCodeAt(0))
      const iv = Uint8Array.from(atob(data.iv), c => c.charCodeAt(0))
      const ciphertext = Uint8Array.from(atob(data.ciphertext), c => c.charCodeAt(0))
      const iterations = data.iterations || 600_000

      const enc = new TextEncoder()
      const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(fileImportPassword), 'PBKDF2', false, ['deriveKey'])
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      )
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
      const mnemonic = new TextDecoder().decode(decrypted)

      // Reuse the backup password as the device PIN — no need to ask again
      const usedPin = fileImportPassword
      setShowFilePasswordPrompt(false)
      setPendingFileData(null)
      setFileImportPassword('')

      // Import directly — skip the PIN screen
      try {
        const imported = isValidMnemonic(mnemonic)
          ? await backend.importSeed(mnemonic, usedPin)
          : await backend.importNsec(mnemonic, usedPin)
        await loadAccounts()
        setPendingSelectPubkey(imported.pubkey)
        setScreen('saved-accounts')
      } catch (importErr: unknown) {
        setError(typeof importErr === 'string' ? importErr : importErr instanceof Error ? importErr.message : 'Import failed')
      }
    } catch {
      setFileImportError('Incorrect password or corrupted file')
    } finally {
      setFileImportLoading(false)
    }
  }

  // Vault: the secret (phrase/nsec/backup file) + PIN are entered in the vault overlay;
  // the app never sees them. Then land on saved-accounts with the new account selected.
  const runVaultImport = async () => {
    clearError()
    setLoading('import')
    try {
      const imported = await backend.importSeed('', '')
      await loadAccounts()
      setPendingSelectPubkey(imported.pubkey)
      setScreen('saved-accounts')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      if (!/cancel/i.test(msg)) setError(typeof err === 'string' ? err : msg)
    } finally {
      setLoading(null)
    }
  }

  const handleImportWithPin = async () => {
    clearError()
    if (!pin) { setError('PIN is required'); return }
    const words = importWords.trim()
    setLoading('import')
    try {
      const imported = isValidMnemonic(words)
        ? await backend.importSeed(words, pin, accountName || undefined, pinHint || undefined)
        : await backend.importNsec(words, pin, accountName || undefined, pinHint || undefined)
      await loadAccounts()
      setImportWords('')
      setPendingSelectPubkey(imported.pubkey)
      setScreen('saved-accounts')
    } catch (err: unknown) {
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Import failed')
    } finally {
      setLoading(null)
    }
  }

  // ─── Generate New Account (PIN-gated) ───
  // Vault: the mnemonic reveal, label, PIN, hint, and backup download all happen in the
  // vault's overlay — the app never sees the seed or PIN. Then continue to profile setup.
  const runVaultGenerate = async () => {
    setLoading('generate')
    try {
      const result = savedSeeds.length === 0
        ? await backend.generateAccount('')
        : await backend.generateNewSeed('')
      await loadAccounts()
      setOnboardingPubkey(result.pubkey)
      const loginResult = await backend.loginAccount(result.pubkey, '')
      setOnboardingPrivateKey(loginResult.privKey)
      setOnboardingSigner(loginResult.signer)
      const clientRelays = getRelayList()
      setOnboardRelays([...clientRelays].sort(() => Math.random() - 0.5).slice(0, 3).map((r) => ({ url: r.url, enabled: true })))
      const clientBlossoms = blossomServerManager.getList()
      setOnboardBlossoms([...clientBlossoms].sort(() => Math.random() - 0.5).slice(0, 3).map((b) => ({ url: b.url, enabled: true })))
      setScreen('onboarding-profile')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Generation failed'
      if (!/cancel/i.test(msg)) setError(typeof err === 'string' ? err : msg)
    } finally {
      setLoading(null)
    }
  }

  const openGenerateFlow = async () => {
    clearError()
    setPin('')
    setPinHint('')
    setAccountName('')
    if (backend.promptsInVault) { await runVaultGenerate(); return }
    setScreen('generate-pin')
  }

  const handleGenerateWithPin = async () => {
    clearError()
    if (!pin) { setError('PIN is required'); return }
    setLoading('generate')
    try {
      // Generate the seed IN MEMORY only — nothing is written to the keyring here.
      // The account is persisted later, in handleFinishGenerate, once the user has
      // downloaded AND re-verified their backup. Abandoning before that leaves nothing.
      const mnemonic = generateSeedPhrase()
      setPendingGen({ mnemonic, pin, name: accountName || undefined, hint: pinHint || undefined })
      setBackupMnemonic(mnemonic)
      setShowBackupWords(false)
      setShowSeedAccordion(false)
      setBackupDownloaded(false)
      setBackupVerified(false)
      setBackupVerifyPin('')

      // Pre-populate relay/blossom lists with 3 random enabled entries
      const clientRelays = getRelayList()
      const shuffledRelays = [...clientRelays].sort(() => Math.random() - 0.5).slice(0, 3)
      setOnboardRelays(shuffledRelays.map(r => ({ url: r.url, enabled: true })))

      const clientBlossoms = blossomServerManager.getList()
      const shuffledBlossoms = [...clientBlossoms].sort(() => Math.random() - 0.5).slice(0, 3)
      setOnboardBlossoms(shuffledBlossoms.map(b => ({ url: b.url, enabled: true })))

      setScreen('seed-backup')
    } catch (err: unknown) {
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setLoading(null)
    }
  }

  // Persist the just-generated account NOW (deferred until the backup was verified),
  // then continue to profile onboarding. Nothing was stored before this ran.
  const handleFinishGenerate = async () => {
    if (!pendingGen) { setScreen('onboarding-profile'); return }
    clearError()
    setLoading('generate')
    try {
      const result = await backend.importSeed(pendingGen.mnemonic, pendingGen.pin, pendingGen.name, pendingGen.hint)
      await loadAccounts()
      setOnboardingPubkey(result.pubkey)
      const loginResult = await backend.loginAccount(result.pubkey, pendingGen.pin)
      setOnboardingPrivateKey(loginResult.privKey)
      setOnboardingSigner(loginResult.signer)
      setPendingGen(null)
      setBackupMnemonic(null)
      setShowBackupWords(false)
      setBackupDownloaded(false)
      setBackupVerified(false)
      setBackupVerifyPin('')
      setScreen('onboarding-profile')
    } catch (err: unknown) {
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Failed to save account')
    } finally {
      setLoading(null)
    }
  }

  const handleDeriveFromSeed = async (seedId: string) => {
    clearError()
    if (!pin) { setError('PIN is required'); return }
    setLoading('derive')
    try {
      await backend.deriveNextAccount(seedId, pin, pinHint || undefined)
      await loadAccounts()
      setScreen('main')
    } catch (err: unknown) {
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Derivation failed')
    } finally {
      setLoading(null)
    }
  }

  // ─── Derive from carousel + button ───
  // Vault: the seed's PIN is entered in the vault overlay; then show the new account.
  const runVaultDerive = async (seedId: string) => {
    clearError()
    setLoading('derive')
    try {
      const r = await backend.deriveNextAccount(seedId, '')
      await loadAccounts()
      setPendingSelectPubkey(r.pubkey)
      setScreen('saved-accounts')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Derivation failed'
      if (!/cancel/i.test(msg)) setError(typeof err === 'string' ? err : msg)
    } finally {
      setLoading(null)
    }
  }

  const openDeriveFlow = (seedId: string) => {
    clearError()
    setDeriveSeedId(seedId)
    setPin('')
    if (backend.promptsInVault) { void runVaultDerive(seedId); return }
    setScreen('derive-pin')
  }

  // ─── Onboarding: Image Upload ───
  const handleOnboardingImageUpload = async (file: File) => {
    setPicUploadStatus('uploading')
    setPicUploadProgress(null)
    setPicUploadError(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const enabledBlossoms = onboardBlossoms.filter(b => b.enabled).map(b => b.url)
      const servers = enabledBlossoms.length > 0 ? enabledBlossoms : undefined
      const { hash, serverUrls } = await uploadToBlossomServers(
        data, onboardingSigner, onboardingPrivateKey, servers, file.type,
        (p) => setPicUploadProgress({ ...p }),
        () => { const c = new AbortController(); picAbortRef.current = c; return c.signal },
      )
      const baseUrl = serverUrls[0] || 'https://blossom.primal.net'
      setProfilePicUrl(`${baseUrl}/${hash}`)
      setPicUploadStatus('success')
    } catch (err) {
      setPicUploadStatus('error')
      setPicUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setPicUploadProgress(null)
      picAbortRef.current = null
    }
  }

  // ─── Onboarding: Publish profile + relay list + blossom list ───
  const handleOnboardingPublish = async () => {
    if (!onboardingPubkey) return
    if (!onboardingSigner && !onboardingPrivateKey) return
    const oSigner = onboardingSigner
    const oPk = onboardingPrivateKey
    setPublishing(true)
    try {
      const enabledRelays = onboardRelays.filter(r => r.enabled)
      const publishRelays = enabledRelays.map(r => r.url)
      if (publishRelays.length === 0) {
        // Fallback to client defaults if user disabled all
        publishRelays.push(...getRelayList().filter(r => r.enabled).map(r => r.url))
      }

      // 1. Kind 0 — Profile metadata
      const profileContent = JSON.stringify({
        ...(profileName ? { name: profileName, display_name: profileName } : {}),
        ...(profilePicUrl ? { picture: profilePicUrl } : {}),
      })
      const profileUnsigned = createUnsignedEvent(0, profileContent, [])
      const signedProfile = await signWithSigner(profileUnsigned, oSigner, oPk)

      // 2. Kind 10002 — Relay list (NIP-65)
      const relayTags: [string, ...string[]][] = enabledRelays.map(r => ['r', r.url])
      const relayUnsigned = createUnsignedEvent(10002, '', relayTags)
      const signedRelays = await signWithSigner(relayUnsigned, oSigner, oPk)

      // 3. Kind 10063 — Blossom server list
      const enabledBlossoms = onboardBlossoms.filter(b => b.enabled)
      const blossomTags: [string, ...string[]][] = enabledBlossoms.map(b => ['server', b.url])
      const blossomUnsigned = createUnsignedEvent(10063, '', blossomTags)
      const signedBlossoms = await signWithSigner(blossomUnsigned, oSigner, oPk)

      // Publish all 3 in parallel
      await Promise.allSettled([
        publishToSpecificRelays(publishRelays, signedProfile),
        publishToSpecificRelays(publishRelays, signedRelays),
        publishToSpecificRelays(publishRelays, signedBlossoms),
      ])
    } catch (err) {
      console.error('Onboarding publish failed:', err)
    } finally {
      setPublishing(false)
      // Select the just-created account once the carousel data refreshes.
      if (onboardingPubkey) setPendingSelectPubkey(onboardingPubkey)
      // Clear sensitive state + navigate
      setOnboardingPubkey(null)
      setOnboardingPrivateKey(null); setOnboardingSigner(null)
      setProfileName('')
      setProfilePicUrl('')
      setPicUploadStatus('idle')
      setPicUploadProgress(null)
      setPicUploadError(null)
      setScreen('saved-accounts')
    }
  }

  // ─── Onboarding: Skip ───
  const handleOnboardingSkip = () => {
    if (onboardingPubkey) setPendingSelectPubkey(onboardingPubkey)
    setOnboardingPubkey(null)
    setOnboardingPrivateKey(null); setOnboardingSigner(null)
    setProfileName('')
    setProfilePicUrl('')
    setPicUploadStatus('idle')
    setPicUploadProgress(null)
    setPicUploadError(null)
    setScreen('saved-accounts')
  }

  // ─── Encrypted backup download ───
  const handleEncryptedBackup = async () => {
    if (!backupPin) { setBackupPinError('Enter your PIN'); return }
    if (!backupMnemonic) return
    setBackupDownloading(true)
    setBackupPinError(null)
    try {
      // In the deferred-generate flow the account isn't stored yet, so the backup
      // password is simply the PIN the user set at generation. Otherwise fall back to
      // verifying against the stored account.
      if (pendingGen) {
        if (backupPin !== pendingGen.pin) { setBackupPinError('Incorrect PIN'); setBackupDownloading(false); return }
      } else {
        const newest = savedAccounts[savedAccounts.length - 1]
        if (newest) {
          const valid = await backend.verifyPin(newest.pubkey, backupPin)
          if (!valid) { setBackupPinError('Incorrect PIN'); setBackupDownloading(false); return }
        }
      }
      // Encrypt mnemonic with PBKDF2 + AES-256-GCM
      const enc = new TextEncoder()
      const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(backupPin), 'PBKDF2', false, ['deriveKey'])
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const iterations = 600_000
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt'],
      )
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(backupMnemonic))
      const payload = JSON.stringify({
        version: 1,
        alg: 'AES-256-GCM',
        kdf: 'PBKDF2-SHA256',
        iterations,
        salt: btoa(String.fromCharCode(...salt)),
        iv: btoa(String.fromCharCode(...iv)),
        ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
      })
      // Trigger download
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `den-seed-backup-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setShowBackupPinPrompt(false)
      setBackupVerifyPin(backupPin)   // keep the PIN to verify the re-uploaded file
      setBackupPin('')
      setBackupDownloaded(true)
      setBackupVerified(false)
      setBackupVerifyError(null)
    } catch (err: unknown) {
      setBackupPinError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Encryption failed')
    } finally {
      setBackupDownloading(false)
    }
  }

  // ─── Re-upload the downloaded backup to verify it decrypts to this seed ───
  const handleVerifyReupload = async (file: File) => {
    if (!backupMnemonic) return
    setBackupVerifying(true); setBackupVerifyError(null)
    try {
      const text = await file.text()
      const result = await verifyBackupMatches(text, backupVerifyPin, backupMnemonic)
      if (result === 'ok') setBackupVerified(true)
      else setBackupVerifyError(result === 'mismatch' ? "That file is a different account's backup." : result === 'wrong-password' ? "That file doesn't match this PIN." : 'Not a valid backup file.')
    } catch (e) {
      setBackupVerifyError(e instanceof Error ? e.message : 'Verification failed')
    } finally { setBackupVerifying(false) }
  }

  // ─── PIN Login for saved account ───
  const openPinLogin = async (account: StoredAccount) => {
    clearError()
    setSelectedAccount(account)
    setPin('')
    // Vault collects the PIN in its own overlay — don't show the app's PIN screen.
    if (backend.promptsInVault) {
      setLoading('pin-login')
      try {
        const r = await backend.loginAccount(account.pubkey, '')
        applyLogin(account.pubkey, r)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!/cancel/i.test(msg)) setError(msg) // a dismissed prompt is not an error
      } finally {
        setLoading(null)
      }
      return
    }
    setScreen('pin-login')
  }

  const handlePinLogin = async () => {
    clearError()
    if (!selectedAccount) return
    if (!pin) { setError('Enter your PIN'); return }
    setLoading('pin-login')
    try {
      const r = await backend.loginAccount(selectedAccount.pubkey, pin)
      applyLogin(selectedAccount.pubkey, r)
    } catch (err: unknown) {
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Wrong PIN or login failed')
    } finally {
      setLoading(null)
    }
  }

  // ── Background overlay card ──
  const bgSkeletonOverlay = bgLoading && (bgShowcaseEnabled || adShowcaseEnabled) ? (
    <div className="fixed bottom-4 left-4 z-[5] max-w-[280px]">
      <div className="rounded-xl bg-black/60 backdrop-blur-md border border-white/10 p-3 space-y-2.5 animate-pulse">
        <div className="h-2.5 w-28 rounded bg-white/10" />
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-full bg-white/10 shrink-0" />
          <div className="h-3.5 w-20 rounded bg-white/10" />
        </div>
        <div className="flex gap-1.5">
          <div className="h-6 w-16 rounded-md bg-white/10" />
          <div className="h-6 w-14 rounded-md bg-white/10" />
        </div>
      </div>
    </div>
  ) : null

  const bgOverlay = !bgLoading && activeBg ? (
    <div className="fixed bottom-4 left-4 z-[5] max-w-[280px] animate-in fade-in duration-500">
      <div className="rounded-xl bg-black/60 backdrop-blur-md border border-white/10 p-3 space-y-2.5">
        <p className="text-[10px] text-white/50 uppercase tracking-wider font-medium">{isAd ? 'Advertisement' : 'Background Showcase'}</p>
        <div className="flex items-center gap-2.5">
          {activeBg.profilePic ? (
            <BlossomImage src={activeBg.profilePic} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 ring-1 ring-white/20" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-white/10 shrink-0" />
          )}
          <span className="text-sm text-white font-medium truncate">{activeBg.name || ''}</span>
        </div>
        {isAd && activeBg.description && (
          <p className="text-[11px] text-white/60 leading-snug line-clamp-2">{activeBg.description}</p>
        )}
        {activeBg.buttons && activeBg.buttons.filter((b) => b.text?.trim()).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {activeBg.buttons.filter((b) => b.text?.trim()).map((btn, i) => (
              <a
                key={i}
                href={btn.link || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-white/15 hover:bg-white/25 text-white/90 transition-colors"
              >
                {btn.text}
                {btn.link && <ExternalLink size={10} className="opacity-60" />}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  ) : null

  // ────────────────────────────────────────────
  // ─── Render: Import Screen ───
  // ────────────────────────────────────────────
  if (screen === 'import') {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <h2 className="text-xl font-bold text-foreground">Import Account</h2>
            <p className="text-sm text-muted-foreground text-center">
              Enter your 24-word seed phrase, nsec, or hex private key.
            </p>
            <textarea
              value={importWords}
              onChange={(e) => { setImportWords(e.target.value); clearError() }}
              placeholder="word1 word2 word3 ... (24 words) or nsec1... or hex"
              className="w-full h-32 rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none resize-none"
              spellCheck={false}
            />
            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle size={14} /> {error}
              </div>
            )}
            <Button onClick={handleImportValidate} className="w-full">
              Continue
            </Button>

            <div className="flex items-center gap-3 w-full">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">or</span>
              <Separator className="flex-1" />
            </div>

            <div className="w-full grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={handleFileImportPick} className="gap-2">
                <FileUp size={15} /> Backup File
              </Button>
              <Button variant="outline" onClick={() => { clearError(); setShowQrScanner(true) }} className="gap-2">
                <QrCode size={15} /> Scan QR
              </Button>
            </div>

            <Button variant="ghost" onClick={goBack} className="w-full text-muted-foreground">Back</Button>

            {showQrScanner && (
              <QRScanner onResult={(text) => { setShowQrScanner(false); loadBackupText(text) }} onClose={() => setShowQrScanner(false)} />
            )}

            {/* File decryption password prompt */}
            {showFilePasswordPrompt && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { setShowFilePasswordPrompt(false); setPendingFileData(null) }}>
                <Card className="w-full max-w-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
                  <CardContent className="p-6 flex flex-col items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Lock size={18} className="text-primary" />
                      <h3 className="text-lg font-semibold text-foreground">Decrypt Backup</h3>
                    </div>
                    <p className="text-sm text-muted-foreground text-center">
                      Enter the password used when this backup was created.
                    </p>
                    <PinInput
                      value={fileImportPassword}
                      onChange={(v) => { setFileImportPassword(v); setFileImportError(null) }}
                      placeholder="Backup password / PIN"
                      autoFocus
                      onEnter={handleFileDecrypt}
                    />
                    {fileImportError && (
                      <div className="flex items-center gap-2 text-sm text-destructive w-full">
                        <AlertCircle size={14} className="shrink-0" /> <span>{fileImportError}</span>
                      </div>
                    )}
                    <Button onClick={handleFileDecrypt} className="w-full" disabled={fileImportLoading}>
                      {fileImportLoading ? <Loader2 size={16} className="animate-spin" /> : 'Decrypt'}
                    </Button>
                    <Button variant="ghost" onClick={() => { setShowFilePasswordPrompt(false); setPendingFileData(null) }} className="w-full text-muted-foreground">
                      Cancel
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Import PIN Screen ───
  // ────────────────────────────────────────────
  if (screen === 'import-pin') {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <Lock size={20} className="text-primary" />
              <h2 className="text-xl font-bold text-foreground">Set PIN</h2>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Choose a PIN to encrypt this account on your device. You'll need it to log in.
            </p>

            <WarningCarousel />

            <Input
              type="text"
              placeholder="Local seed label (optional)"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              className="h-10"
            />

            <PinInput
              value={pin}
              onChange={(v) => { setPin(v); clearError() }}
              placeholder="Enter PIN"
              onEnter={handleImportWithPin}
            />

            <Input
              type="text"
              placeholder="PIN hint (optional)"
              value={pinHint}
              onChange={(e) => setPinHint(e.target.value)}
              className="h-10"
            />

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive w-full">
                <AlertCircle size={14} className="shrink-0" /> <span>{error}</span>
              </div>
            )}

            <Button onClick={handleImportWithPin} className="w-full" disabled={loading === 'import'}>
              {loading === 'import' ? <Loader2 size={16} className="animate-spin" /> : 'Import & Login'}
            </Button>
            <Button variant="ghost" onClick={() => setScreen('import')} className="w-full text-muted-foreground">Back</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Generate PIN Screen ───
  // ────────────────────────────────────────────
  if (screen === 'generate-pin') {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <Lock size={20} className="text-primary" />
              <h2 className="text-xl font-bold text-foreground">Create Account</h2>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Choose a PIN to protect your new account. You'll need it every time you log in.
            </p>

            <WarningCarousel />

            <Input
              type="text"
              placeholder="Local seed label (optional)"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              className="h-10"
            />

            <PinInput
              value={pin}
              onChange={(v) => { setPin(v); clearError() }}
              placeholder="Enter PIN"
              onEnter={handleGenerateWithPin}
            />

            <Input
              type="text"
              placeholder="PIN hint (optional)"
              value={pinHint}
              onChange={(e) => setPinHint(e.target.value)}
              className="h-10"
            />


            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive w-full">
                <AlertCircle size={14} className="shrink-0" /> <span>{error}</span>
              </div>
            )}

            <Button onClick={handleGenerateWithPin} className="w-full" disabled={loading === 'generate'}>
              {loading === 'generate' ? <Loader2 size={16} className="animate-spin" /> : 'Generate New Seed'}
            </Button>
            <Button variant="ghost" onClick={goBack} className="w-full text-muted-foreground">Back</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Derive PIN Screen ───
  // ────────────────────────────────────────────
  if (screen === 'derive-pin' && deriveSeedId) {
    const deriveSeed = savedSeeds.find((s) => s.id === deriveSeedId)
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <GitBranch size={20} className="text-primary" />
              <h2 className="text-xl font-bold text-foreground">Derive New Account</h2>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Enter the PIN for <strong>{deriveSeed?.name || 'this seed'}</strong> to derive a new account.
            </p>

            <PinInput
              value={pin}
              onChange={(v) => { setPin(v); clearError() }}
              placeholder="Enter seed PIN"
              autoFocus
              onEnter={() => handleDeriveFromSeed(deriveSeedId)}
            />

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive w-full">
                <AlertCircle size={14} className="shrink-0" /> <span>{error}</span>
              </div>
            )}

            <Button onClick={() => handleDeriveFromSeed(deriveSeedId)} className="w-full" disabled={loading === 'derive'}>
              {loading === 'derive' ? <Loader2 size={16} className="animate-spin" /> : 'Derive account'}
            </Button>
            <Button variant="ghost" onClick={goBack} className="w-full text-muted-foreground">Back</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Seed Backup Screen ───
  // ────────────────────────────────────────────
  if (screen === 'seed-backup' && backupMnemonic) {
    const words = backupMnemonic.split(' ')
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-md shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <Shield size={20} className="text-primary" />
              <h2 className="text-xl font-bold text-foreground">Backup Seed Phrase</h2>
            </div>

            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 w-full">
              <AlertCircle size={14} className="text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive">
                Write down these words and store them securely. Anyone with these words can access your keys and funds.
              </p>
            </div>

            {/* Recovery phrase — collapsed by default; download the backup first */}
            <div className="w-full rounded-lg border border-border overflow-hidden">
              <button
                onClick={() => { setShowSeedAccordion((v) => { if (v) setShowBackupWords(false); return !v }) }}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <KeyRound size={14} /> View recovery phrase
                </span>
                <ChevronDown size={16} className={`text-muted-foreground transition-transform ${showSeedAccordion ? 'rotate-180' : ''}`} />
              </button>
              {showSeedAccordion && (
                <div className="p-3 space-y-3 border-t border-border">
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 w-full">
                    {words.map((word, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-secondary/50 rounded-lg border border-border">
                        <span className="text-[10px] text-muted-foreground w-5 text-right">{i + 1}.</span>
                        <span className="font-mono text-sm">{showBackupWords ? word : '••••'}</span>
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-2 w-full">
                    <button
                      onClick={() => {
                        if (showBackupWords) {
                          setShowBackupWords(false)
                        } else {
                          // Revealing is gated behind an "are you sure" + countdown
                          setRevealCountdown(null)
                          setShowRevealConfirm(true)
                        }
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs hover:bg-secondary transition-colors cursor-pointer"
                    >
                      {showBackupWords ? <><EyeOff size={14} /> Censor</> : <><Eye size={14} /> Reveal</>}
                    </button>
                    <button
                      onClick={() => setShowCopyConfirm(true)}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs hover:bg-secondary transition-colors cursor-pointer"
                    >
                      {backupCopied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy</>}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Encrypted backup download */}
            {!showBackupPinPrompt ? (
              <button
                onClick={() => { setBackupPin(''); setBackupPinError(null); setShowBackupPinPrompt(true) }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border text-xs hover:bg-secondary/60 transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <Download size={14} />
                Download Encrypted Backup
              </button>
            ) : (
              <div className="w-full space-y-2 p-3 rounded-lg border border-border bg-secondary/20">
                <p className="text-xs text-muted-foreground">Re-enter your PIN to encrypt and download:</p>
                <PinInput
                  value={backupPin}
                  onChange={(v) => { setBackupPin(v); setBackupPinError(null) }}
                  autoFocus
                  onEnter={handleEncryptedBackup}
                />
                {backupPinError && (
                  <div className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle size={12} /> {backupPinError}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 text-xs"
                    onClick={() => setShowBackupPinPrompt(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 text-xs gap-1.5"
                    disabled={backupDownloading}
                    onClick={handleEncryptedBackup}
                  >
                    {backupDownloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    Encrypt & Download
                  </Button>
                </div>
              </div>
            )}

            {/* Re-upload the file you just saved, to confirm it's valid before continuing */}
            <input ref={verifyFileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVerifyReupload(f) }} />
            {backupDownloaded && !backupVerified && (
              <Button className="w-full" variant="outline" disabled={backupVerifying} onClick={() => verifyFileRef.current?.click()}>
                {backupVerifying ? <><Loader2 size={16} className="animate-spin" /> Verifying…</> : <><FileUp size={16} /> Re-upload backup to verify</>}
              </Button>
            )}
            {backupVerifyError && <p className="text-xs text-destructive w-full text-center">{backupVerifyError}</p>}
            {backupVerified && <p className="flex items-center justify-center gap-1.5 text-xs text-emerald-500 w-full"><Check size={13} /> Backup verified</p>}

            <Button className="w-full mt-2" disabled={!backupDownloaded || !backupVerified || loading === 'generate'} onClick={handleFinishGenerate}>
              {loading === 'generate' ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : !backupDownloaded ? 'Download backup to continue' : !backupVerified ? 'Verify your backup to continue' : "I've Saved My Seed · Continue"}
            </Button>
          </CardContent>
        </Card>

        {/* Reveal-seed confirmation + countdown */}
        {showRevealConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
            onClick={revealCountdown === null ? () => setShowRevealConfirm(false) : undefined}
          >
            <div
              className="w-full max-w-sm rounded-xl bg-card border border-border shadow-xl p-6 flex flex-col items-center gap-4 text-center"
              onClick={(e) => e.stopPropagation()}
            >
              {revealCountdown === null ? (
                <>
                  <div className="flex items-center justify-center w-12 h-12 rounded-full bg-destructive/10">
                    <AlertCircle size={22} className="text-destructive" />
                  </div>
                  <h3 className="text-lg font-bold text-foreground">Reveal your secret keys?</h3>
                  <p className="text-sm text-muted-foreground">
                    These 24 words <strong>are</strong> your account. Anyone who sees them — over your shoulder, on a screen share, or in a screenshot — gains <strong className="text-destructive">full and permanent control</strong> of your identity and funds. There is no recovery and no undo.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Make sure no one is watching your screen and nothing is recording.
                  </p>
                  <div className="flex gap-2 w-full mt-1">
                    <Button variant="outline" className="flex-1" onClick={() => setShowRevealConfirm(false)}>Cancel</Button>
                    <Button variant="destructive" className="flex-1 gap-1.5" onClick={startRevealCountdown}>
                      <Eye size={14} /> Yes, show
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="relative flex items-center justify-center w-16 h-16">
                    <svg className="animate-spin h-16 w-16 text-destructive/30" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span key={revealCountdown} className="absolute text-2xl font-bold text-foreground tabular-nums animate-in zoom-in-50 fade-in duration-300">
                      {revealCountdown}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-foreground">Showing keys in {revealCountdown}…</h3>
                  <p className="text-sm text-muted-foreground">Last chance — make sure no one can see your screen.</p>
                  <Button variant="outline" className="w-full gap-1.5" onClick={cancelReveal}>
                    <EyeOff size={14} /> Wait, never mind
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Copy-seed confirmation */}
        {showCopyConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
            onClick={() => setShowCopyConfirm(false)}
          >
            <div
              className="w-full max-w-sm rounded-xl bg-card border border-border shadow-xl p-6 flex flex-col items-center gap-4 text-center"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-destructive/10">
                <AlertCircle size={22} className="text-destructive" />
              </div>
              <h3 className="text-lg font-bold text-foreground">Copy seed to clipboard?</h3>
              <p className="text-sm text-muted-foreground">
                Your clipboard can be read by other apps and clipboard-history tools, and may sync across your devices. Only copy if you're pasting it somewhere safe <strong>right now</strong> — and clear your clipboard afterward.
              </p>
              <div className="flex gap-2 w-full mt-1">
                <Button variant="outline" className="flex-1" onClick={() => setShowCopyConfirm(false)}>Cancel</Button>
                <Button
                  variant="destructive"
                  className="flex-1 gap-1.5"
                  onClick={() => {
                    navigator.clipboard.writeText(backupMnemonic)
                    setBackupCopied(true)
                    setShowCopyConfirm(false)
                    setTimeout(() => setBackupCopied(false), 2000)
                  }}
                >
                  <Copy size={14} /> Yes, copy
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Onboarding Profile Screen ───
  // ────────────────────────────────────────────
  if (screen === 'onboarding-profile') {
    const hasContent = profileName.trim() || profilePicUrl
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <User size={20} className="text-primary" />
              <h2 className="text-xl font-bold text-foreground">Set Up Profile</h2>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Optional — add a display name and profile picture. You can always change these later.
            </p>

            {/* Profile Picture */}
            <input
              ref={picInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) handleOnboardingImageUpload(file)
              }}
            />
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => { if (picUploadStatus !== 'uploading') picInputRef.current?.click() }}
                className="relative w-24 h-24 rounded-full bg-secondary/50 border-2 border-dashed border-border hover:border-primary/50 transition-colors cursor-pointer group overflow-hidden"
              >
                {profilePicUrl ? (
                  <BlossomImage src={profilePicUrl} alt="Profile" className="w-full h-full rounded-full" imgClassName="object-cover" />
                ) : (
                  <div className="flex flex-col items-center justify-center w-full h-full text-muted-foreground group-hover:text-primary transition-colors">
                    <Camera size={24} />
                    <span className="text-[10px] mt-1">Upload</span>
                  </div>
                )}
                {/* Upload overlay */}
                {picUploadStatus === 'uploading' && (
                  <div className="absolute inset-0 bg-black/50 rounded-full flex items-center justify-center">
                    <Loader2 size={20} className="animate-spin text-white" />
                  </div>
                )}
                {/* Hover overlay when image exists */}
                {profilePicUrl && picUploadStatus !== 'uploading' && (
                  <div className="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100">
                    <Camera size={16} className="text-white" />
                  </div>
                )}
                {/* Success checkmark overlay */}
                {picUploadStatus === 'success' && profilePicUrl && (
                  <div className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center border-2 border-background">
                    <Check size={12} className="text-white" />
                  </div>
                )}
              </button>
              {profilePicUrl && picUploadStatus !== 'uploading' && (
                <button onClick={() => { setProfilePicUrl(''); setPicUploadStatus('idle') }} className="text-[10px] text-destructive hover:underline cursor-pointer">Remove</button>
              )}
              {picUploadStatus === 'uploading' && picUploadProgress && (
                <div className="flex flex-col gap-0.5 w-full mt-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-amber-400 truncate max-w-[120px]">
                      {(() => { try { return new URL(picUploadProgress.serverUrl).hostname.replace('www.', '') } catch { return picUploadProgress.serverUrl } })()} ({picUploadProgress.serverIndex + 1}/{picUploadProgress.totalServers})
                    </span>
                    <button
                      onClick={() => { picAbortRef.current?.abort(); picAbortRef.current = null }}
                      className="text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-0.5"
                    >
                      <XCircle size={10} /><span className="text-[10px]">Skip</span>
                    </button>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${picUploadProgress.percent}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{Math.round(picUploadProgress.percent)}%</span>
                    <span>{picUploadProgress.speed < 1024 ? `${Math.round(picUploadProgress.speed)} B/s` : picUploadProgress.speed < 1024 * 1024 ? `${(picUploadProgress.speed / 1024).toFixed(1)} KB/s` : `${(picUploadProgress.speed / (1024 * 1024)).toFixed(1)} MB/s`}</span>
                  </div>
                </div>
              )}
            </div>
            {picUploadStatus === 'error' && picUploadError && (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle size={12} /> {picUploadError}
              </div>
            )}

            {/* Display Name */}
            <Input
              type="text"
              placeholder="Display name (optional)"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              className="h-10"
            />

            {/* Advanced — gear icon */}
            <button
              type="button"
              onClick={() => setShowAdvancedModal(true)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <Settings2 size={14} />
              Advanced (relays & media servers)
            </button>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle size={16} /> {error}
              </div>
            )}

            {/* Publish */}
            <Button
              className="w-full"
              disabled={publishing || !hasContent}
              onClick={handleOnboardingPublish}
            >
              {publishing ? (
                <><Loader2 size={16} className="animate-spin mr-2" /> Publishing...</>
              ) : (
                'Publish Profile'
              )}
            </Button>

            {/* Skip */}
            <button
              type="button"
              onClick={handleOnboardingSkip}
              disabled={publishing}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
            >
              Skip for now
            </button>
          </CardContent>
        </Card>

        {/* ─── Advanced Modal: Relays & Blossoms ─── */}
        {showAdvancedModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAdvancedModal(false)}>
            <div className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h4 className="text-sm font-semibold text-foreground">Advanced Setup</h4>
                <button onClick={() => setShowAdvancedModal(false)} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <X size={16} />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-border">
                <button
                  onClick={() => setAdvancedTab('relays')}
                  className={`flex-1 px-4 py-2 text-xs font-medium transition-colors cursor-pointer ${advancedTab === 'relays' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  Relays ({onboardRelays.filter(r => r.enabled).length}/{onboardRelays.length})
                </button>
                <button
                  onClick={() => setAdvancedTab('blossoms')}
                  className={`flex-1 px-4 py-2 text-xs font-medium transition-colors cursor-pointer ${advancedTab === 'blossoms' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  Media Servers ({onboardBlossoms.filter(b => b.enabled).length}/{onboardBlossoms.length})
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                {advancedTab === 'relays' ? (
                  <>
                    <p className="text-[11px] text-muted-foreground mb-2">
                      Relays store and distribute your profile data. Toggle to enable/disable.
                    </p>
                    {onboardRelays.map((relay, idx) => (
                      <div key={idx} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/20 border border-border">
                        <button
                          onClick={() => setOnboardRelays(prev => prev.map((r, i) => i === idx ? { ...r, enabled: !r.enabled } : r))}
                          className={`w-8 h-5 rounded-full flex items-center transition-colors cursor-pointer shrink-0 ${relay.enabled ? 'bg-primary justify-end' : 'bg-secondary justify-start'}`}
                        >
                          <span className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all mx-0.5`} />
                        </button>
                        <span className="text-xs text-foreground font-mono truncate flex-1">{relay.url}</span>
                        <button
                          onClick={() => setOnboardRelays(prev => prev.filter((_, i) => i !== idx))}
                          className="p-0.5 rounded text-muted-foreground hover:text-destructive transition-colors cursor-pointer shrink-0"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    <div className="flex gap-1.5 mt-2">
                      <input
                        type="text"
                        placeholder="wss://relay.example.com"
                        value={customRelayInput}
                        onChange={(e) => setCustomRelayInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && customRelayInput.trim().startsWith('wss://')) {
                            setOnboardRelays(prev => [...prev, { url: customRelayInput.trim(), enabled: true }])
                            setCustomRelayInput('')
                          }
                        }}
                        className="flex-1 px-2.5 py-1.5 rounded border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono"
                      />
                      <button
                        onClick={() => {
                          if (customRelayInput.trim().startsWith('wss://')) {
                            setOnboardRelays(prev => [...prev, { url: customRelayInput.trim(), enabled: true }])
                            setCustomRelayInput('')
                          }
                        }}
                        className="px-2.5 py-1.5 rounded border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-muted-foreground mb-2">
                      Media servers (Blossom) store your profile picture and other uploads.
                    </p>
                    {onboardBlossoms.map((blossom, idx) => (
                      <div key={idx} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/20 border border-border">
                        <button
                          onClick={() => setOnboardBlossoms(prev => prev.map((b, i) => i === idx ? { ...b, enabled: !b.enabled } : b))}
                          className={`w-8 h-5 rounded-full flex items-center transition-colors cursor-pointer shrink-0 ${blossom.enabled ? 'bg-primary justify-end' : 'bg-secondary justify-start'}`}
                        >
                          <span className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all mx-0.5`} />
                        </button>
                        <span className="text-xs text-foreground font-mono truncate flex-1">{blossom.url}</span>
                        <button
                          onClick={() => setOnboardBlossoms(prev => prev.filter((_, i) => i !== idx))}
                          className="p-0.5 rounded text-muted-foreground hover:text-destructive transition-colors cursor-pointer shrink-0"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    <div className="flex gap-1.5 mt-2">
                      <input
                        type="text"
                        placeholder="https://blossom.example.com"
                        value={customBlossomInput}
                        onChange={(e) => setCustomBlossomInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && customBlossomInput.trim().startsWith('https://')) {
                            setOnboardBlossoms(prev => [...prev, { url: customBlossomInput.trim(), enabled: true }])
                            setCustomBlossomInput('')
                          }
                        }}
                        className="flex-1 px-2.5 py-1.5 rounded border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono"
                      />
                      <button
                        onClick={() => {
                          if (customBlossomInput.trim().startsWith('https://')) {
                            setOnboardBlossoms(prev => [...prev, { url: customBlossomInput.trim(), enabled: true }])
                            setCustomBlossomInput('')
                          }
                        }}
                        className="px-2.5 py-1.5 rounded border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Footer */}
              <div className="px-4 py-3 border-t border-border">
                <Button className="w-full" onClick={() => setShowAdvancedModal(false)}>Done</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: PIN Login Screen ───
  // ────────────────────────────────────────────
  if (screen === 'pin-login' && selectedAccount) {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            {(() => {
              const profile = getProfile(selectedAccount.pubkey)
              const displayName = profile?.display_name || profile?.name || selectedAccount.name || 'Unnamed Account'
              const picture = profile?.picture
              return (
                <>
                  {picture ? (
                    <BlossomImage
                      src={picture}
                      alt={displayName}
                      className="w-14 h-14 rounded-full ring-2 ring-primary/20"
                      imgClassName="object-cover rounded-full"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                      <User size={28} className="text-primary" />
                    </div>
                  )}
                  <div className="text-center">
                    <h2 className="text-lg font-bold text-foreground">
                      {displayName}
                    </h2>
                    <p className="text-xs text-muted-foreground font-mono mt-1">
                      {selectedAccount.npub.slice(0, 12)}...{selectedAccount.npub.slice(-6)}
                    </p>
                  </div>
                </>
              )
            })()}

            <PinInput
              value={pin}
              onChange={(v) => { setPin(v); clearError() }}
              placeholder="Enter PIN"
              autoFocus
              onEnter={handlePinLogin}
            />

            {selectedAccount.pin_hint && (
              <p className="text-xs text-muted-foreground w-full">
                <span className="font-medium">Hint:</span> {selectedAccount.pin_hint}
              </p>
            )}

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive w-full">
                <AlertCircle size={14} className="shrink-0" /> <span>{error}</span>
              </div>
            )}

            <Button onClick={handlePinLogin} className="w-full" disabled={loading === 'pin-login'}>
              {loading === 'pin-login' ? <Loader2 size={16} className="animate-spin" /> : 'Unlock'}
            </Button>
            <Button variant="ghost" onClick={goBack} className="w-full text-muted-foreground">Back</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: NIP-46 Combined Dialog ───
  // ────────────────────────────────────────────
  if (screen === 'nip46') {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <h2 className="text-xl font-bold text-foreground">Nostr Connect / Bunker</h2>

            {/* ── Nostr Connect: QR code + copy URI, auto-connecting ── */}
            <div className="w-full flex flex-col items-center gap-3">
              <p className="text-sm text-muted-foreground text-center">
                Scan the QR code or copy the URI below into your signer app.
              </p>

              {connectDetails && (
                <>
                  {/* QR Code */}
                  <a href={connectDetails.connectionString} aria-label="Open with Nostr signer app">
                    <div className="p-3 bg-white rounded-xl">
                      <QRCodeSVG
                        value={connectDetails.connectionString}
                        size={180}
                        level="M"
                        includeMargin={false}
                      />
                    </div>
                  </a>

                  {/* Copy URI pill */}
                  <div
                    className="flex items-center gap-2 text-xs text-muted-foreground bg-muted px-3 py-2.5 rounded-lg cursor-pointer transition-colors hover:bg-muted/80 w-full max-w-[280px]"
                    onClick={copyConnectionString}
                    role="button"
                    tabIndex={0}
                  >
                    <span className="flex-grow min-w-0 truncate select-none font-mono">
                      {connectDetails.connectionString}
                    </span>
                    <span className="shrink-0">
                      {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                    </span>
                  </div>
                </>
              )}

              {connectPending && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-1">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Waiting for signer to connect...</span>
                </div>
              )}

              {connectError && (
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle size={14} className="shrink-0" /> {connectError}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setConnectError(null); handleNostrConnectLogin() }}
                    className="gap-1.5"
                  >
                    <RefreshCw size={13} /> Retry
                  </Button>
                  <button
                    onClick={() => {
                      // Only when the code is truly stale — this invalidates the QR/URI
                      // your signer may already have scanned, so it isn't the default.
                      const details = generateNostrConnectDetails()
                      setConnectDetails(details)
                      setConnectError(null)
                      setConnectPending(true)
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    Generate a new code
                  </button>
                </div>
              )}
            </div>

            {/* ── OR divider ── */}
            <div className="flex items-center w-full">
              <div className="flex-grow border-t border-border/40" />
              <span className="px-3 text-xs text-muted-foreground">OR</span>
              <div className="flex-grow border-t border-border/40" />
            </div>

            {/* ── Bunker: paste bunker:// URL ── */}
            <div className="w-full flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Input
                  value={bunkerUrl}
                  onChange={(e) => { setBunkerUrl(e.target.value); setError(null) }}
                  placeholder="bunker://..."
                  className="h-10 flex-1"
                  onKeyDown={(e) => e.key === 'Enter' && handleBunkerLogin()}
                />
                <Button onClick={handleBunkerLogin} disabled={loading === 'bunker'} size="sm" className="shrink-0">
                  {loading === 'bunker' ? <Loader2 size={14} className="animate-spin" /> : 'Login'}
                </Button>
              </div>
              {error && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle size={14} className="shrink-0" /> {error}
                </div>
              )}
            </div>

            <Button variant="ghost" onClick={goBack} className="w-full text-muted-foreground">Back</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Saved Accounts Page ───
  // ────────────────────────────────────────────
  if (screen === 'saved-accounts') {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-6 flex flex-col items-center gap-4">
            {/* Header with back button */}
            <div className="w-full flex items-center gap-2">
              <button onClick={goBack} className="p-1.5 rounded-md hover:bg-secondary/60 transition-colors cursor-pointer">
                <ChevronLeft size={16} className="text-muted-foreground" />
              </button>
              <h2 className="text-lg font-bold text-foreground">Saved Accounts</h2>
            </div>

            {accountGroups.length > 0 && currentAccount && (() => {
              const profile = getProfile(currentAccount.pubkey)
              const displayName = profile?.display_name || profile?.name || null
              const groupLabel = currentGroup?.type === 'seed' ? currentGroup.seed!.name : 'Imported Keys'
              const groupIcon = currentGroup?.type === 'seed'
                ? <Sprout size={13} className="text-emerald-500 shrink-0" />
                : <KeySquare size={13} className="text-orange-500 shrink-0" />

              return (
                <div className="w-full space-y-2">
                  {/* Seed/group selector */}
                  <button
                    onClick={() => setShowSeedPicker(true)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md border border-border/60 bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer text-left"
                  >
                    {groupIcon}
                    <span className="text-xs font-medium text-foreground truncate flex-1">{groupLabel}</span>
                    <ChevronRight size={12} className="text-muted-foreground shrink-0" />
                  </button>

                  {/* Account card — click to login */}
                  <button
                    onClick={() => openPinLogin(currentAccount)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg border border-border/60 bg-secondary/20 hover:bg-secondary/40 transition-colors cursor-pointer text-left"
                  >
                    {profile?.picture ? (
                      <BlossomImage src={profile.picture} alt="" className="w-10 h-10 rounded-full object-cover shrink-0 ring-2 ring-border" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <User size={18} className="text-primary" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {displayName || currentAccount.npub.slice(0, 12) + '...' + currentAccount.npub.slice(-6)}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">
                        {currentAccount.npub.slice(0, 16)}...{currentAccount.npub.slice(-6)}
                      </p>
                    </div>
                    <Lock size={14} className="text-muted-foreground/50 shrink-0" />
                  </button>

                  {/* Derive button (seed groups only) */}
                  {currentGroup?.type === 'seed' && (
                    <button
                      onClick={() => openDeriveFlow(currentGroup.seed!.id)}
                      className="w-full flex items-center justify-center gap-1.5 py-2 rounded-md border border-dashed border-border/60 hover:bg-secondary/40 hover:border-primary/40 transition-colors cursor-pointer"
                    >
                      <Plus size={13} className="text-muted-foreground" />
                      <span className="text-[11px] text-muted-foreground font-medium">Derive New Account</span>
                    </button>
                  )}

                  {/* Navigation arrows */}
                  {currentAccounts.length > 1 && (
                    <div className="flex items-center justify-center gap-3">
                      <button
                        onClick={() => setAccountIdx((i) => Math.max(0, i - 1))}
                        disabled={accountIdx === 0}
                        className="p-2 grow-1 flex justify-center rounded-md hover:bg-secondary/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft size={16} className="text-muted-foreground" />
                      </button>
                      <span className="text-xs text-muted-foreground font-medium tabular-nums">
                        {accountIdx + 1} / {currentAccounts.length}
                      </span>
                      <button
                        onClick={() => setAccountIdx((i) => Math.min(currentAccounts.length - 1, i + 1))}
                        disabled={accountIdx === currentAccounts.length - 1}
                        className="p-2 grow-1 flex justify-center rounded-md hover:bg-secondary/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronRight size={16} className="text-muted-foreground" />
                      </button>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Empty state */}
            {accountGroups.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No saved accounts on this device.</p>
            )}

            {/* Import + Generate buttons */}
            <Separator />
            <div className="w-full flex gap-2">
              <Button
                variant="outline"
                onClick={() => { clearError(); if (backend.promptsInVault) runVaultImport(); else setScreen('import') }}
                className="gap-1.5"
              >
                <Import size={14} />
                Import
              </Button>
              <Button
                variant="outline"
                onClick={openGenerateFlow}
                className="w-full gap-1.5"
              >
                <Plus size={14} />
                Generate Account
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Seed picker modal */}
        {showSeedPicker && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
            <div className="bg-card border border-border rounded-xl shadow-2xl w-[340px] max-h-[400px] flex flex-col animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                <h3 className="text-sm font-semibold text-foreground">Select Seed</h3>
                <button
                  onClick={() => setShowSeedPicker(false)}
                  className="p-1 rounded-md hover:bg-secondary/60 transition-colors cursor-pointer"
                >
                  <X size={14} className="text-muted-foreground" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {accountGroups.map((group, idx) => {
                  const isActive = idx === selectedSeedIdx
                  const label = group.type === 'seed' ? group.seed!.name : 'Imported Keys'
                  const icon = group.type === 'seed'
                    ? <Sprout size={16} className="text-emerald-500 shrink-0" />
                    : <KeySquare size={16} className="text-orange-500 shrink-0" />
                  return (
                    <button
                      key={group.type === 'seed' ? group.seed!.id : 'standalone'}
                      onClick={() => {
                        setSelectedSeedIdx(idx)
                        setAccountIdx(0)
                        setShowSeedPicker(false)
                      }}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${isActive
                        ? 'bg-primary/10 ring-1 ring-primary/30'
                        : 'hover:bg-secondary/40'
                        }`}
                    >
                      {icon}
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${isActive ? 'text-primary' : 'text-foreground'}`}>{label}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {group.accounts.length} account{group.accounts.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      {isActive && (
                        <Check size={14} className="text-primary shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Advanced (ID/Address & Pass + Connect) ───
  // ────────────────────────────────────────────
  if (screen === 'advanced') {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-5">
            <div className="w-full flex items-center gap-2">
              <button onClick={() => { setScreen('main'); clearError() }} className="p-1.5 -ml-1.5 rounded-lg hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <ChevronLeft size={18} />
              </button>
              <h2 className="text-lg font-bold text-foreground">Advanced sign-in</h2>
            </div>
            <p className="text-sm text-muted-foreground text-center -mt-2">
              Extra ways to sign in for existing Nostr users.
            </p>

            <div className="w-full flex flex-col gap-2.5">
              {/* UPV2: DNN ID / Address + Password */}
              <Button
                variant="outline"
                onClick={() => { setScreen('upv2'); clearError() }}
                className="w-full h-12 gap-2 justify-start px-4"
              >
                <KeyRound size={16} className="shrink-0 text-primary" />
                <span className="flex flex-col items-start leading-tight">
                  <span className="text-sm font-medium">ID/Address &amp; Pass</span>
                  <span className="text-[10px] text-muted-foreground">Log in with a DNN ID or npub + password</span>
                </span>
              </Button>

              {/* NIP-46: Connect / Bunker */}
              <Button
                variant="outline"
                onClick={openNip46Dialog}
                className="w-full h-12 gap-2 justify-start px-4"
              >
                <Link2 size={16} className="shrink-0 text-primary" />
                <span className="flex flex-col items-start leading-tight">
                  <span className="text-sm font-medium">Connect</span>
                  <span className="text-[10px] text-muted-foreground">Remote signer via Nostr Connect or bunker://</span>
                </span>
              </Button>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive w-full">
                <AlertCircle size={14} className="shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: UPV2 (DNN ID/Address + Password) ───
  // ────────────────────────────────────────────
  if (screen === 'upv2') {
    return (
      <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
        {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
        {bgSkeletonOverlay}
        {bgOverlay}
        <Card className="w-full max-w-sm shadow-lg relative z-10">
          <CardContent className="p-8 flex flex-col items-center gap-5">
            <div className="w-full flex items-center gap-2">
              <button onClick={() => { setScreen('advanced'); clearError() }} className="p-1.5 -ml-1.5 rounded-lg hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <ChevronLeft size={18} />
              </button>
              <h2 className="text-lg font-bold text-foreground">ID/Address &amp; Pass</h2>
            </div>
            <p className="text-sm text-muted-foreground text-center -mt-2">
              Log in with your DNN ID or npub and password. Requires a running remote signer that supports this flow (e.g. DENOS).
            </p>

            <div className="w-full flex flex-col gap-3">
              <Input
                type="text"
                placeholder="DNN ID or npub"
                value={username}
                onChange={(e) => { setUsername(e.target.value); clearError() }}
                className="h-11"
                autoFocus
              />
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearError() }}
                className="h-11"
                onKeyDown={(e) => e.key === 'Enter' && handleUPV2Login()}
              />
              <Button variant="secondary" onClick={handleUPV2Login} size="lg" className="w-full hover:!bg-primary hover:!text-primary-foreground" disabled={loading === 'upv2'}>
                {loading === 'upv2' ? <Loader2 size={16} className="animate-spin" /> : 'Login'}
              </Button>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive w-full">
                <AlertCircle size={14} className="shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ────────────────────────────────────────────
  // ─── Render: Main Login ───
  // ────────────────────────────────────────────
  return (
    <div className="flex items-center justify-center h-full overflow-y-auto bg-surface-background relative p-4 max-[1080px]:items-start">
      {bgImageUrl && <BlossomImage src={bgImageUrl} alt="" className="fixed inset-0 w-full h-full" imgClassName="object-right-bottom" />}
      {bgSkeletonOverlay}
      {bgOverlay}
      <Card className="w-full max-w-sm shadow-lg relative z-10">
        <CardContent className="p-8 flex flex-col items-center gap-6">
          {/* Logo */}
          <div className="flex flex-col items-center gap-3 mb-2">
            <DenChatLogo size={64} />
            <h1 className="text-2xl font-bold text-foreground">DEN Chat</h1>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive w-full">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="w-full flex flex-col gap-2">
            {/* External signer row — Local | Extension (both hidden on mobile OS) */}
            {!isMobile && (
              <div className="w-full flex flex-wrap gap-2">
                {/* NIP-PC55: Local Signer — hidden on mobile OS */}
                {!isMobile && (
                  <Button
                    variant="outline"
                    onClick={handleLocalLogin}
                    className="grow gap-1.5 text-xs"
                    disabled={loading === 'pc55'}
                  >
                    {loading === 'pc55' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <MonitorSmartphone size={14} />
                    )}
                    Local
                  </Button>
                )}

                {/* NIP-07: Browser Extension — browser only, hidden on mobile OS */}
                {!isDesktop && !isMobile && (
                  <Button
                    variant="outline"
                    onClick={handleNip07Login}
                    className="grow gap-1.5 text-xs"
                    disabled={loading === 'nip07'}
                  >
                    {loading === 'nip07' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <AppWindow size={14} />
                    )}
                    Extension
                  </Button>
                )}
              </div>
            )}

            {/* Local-key accounts (desktop keyring or mobile vault): Saved Accounts or Import+Generate */}
            {(isDesktop || useVault) && (
              savedAccounts.length > 0 ? (
                <Button
                  variant="outline"
                  onClick={() => { setScreen('saved-accounts'); clearError() }}
                  className="w-full gap-2"
                >
                  <KeyRound size={15} />
                  Saved Accounts
                  <span className="ml-auto text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                    {savedAccounts.length}
                  </span>
                </Button>
              ) : (
                <div className="w-full flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => { clearError(); if (backend.promptsInVault) runVaultImport(); else setScreen('import') }}
                    className="gap-1.5 text-xs"
                  >
                    <Import size={14} />
                    Import
                  </Button>
                  <Button
                    variant="outline"
                    onClick={openGenerateFlow}
                    className="w-full gap-1.5 text-xs"
                  >
                    <Plus size={14} />
                    Generate Account
                  </Button>
                </div>
              )
            )}

            {/* New user? */}
            <Button
              className="w-full gap-2"
              onClick={() => setShowGuide(true)}
            >
              <BookOpen size={15} />
              New user?
            </Button>

            {/* Advanced — collapses ID/Address & Pass + Connect onto their own page */}
            <Button
              variant="ghost"
              onClick={() => { clearError(); setScreen('advanced') }}
              className="w-full gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Settings2 size={14} />
              Advanced
            </Button>
          </div>

          {/* Terms of use link */}
          <p className="text-[11px] text-muted-foreground text-center mt-1">
            By continuing to use DEN Chat, you agree to its{' '}
            <button onClick={() => setShowTerms(true)} className="underline text-foreground/70 hover:text-foreground transition-colors cursor-pointer">
              Terms of Use
            </button>
          </p>
        </CardContent>
      </Card>

      <TermsModal open={showTerms} onClose={() => setShowTerms(false)} />
      <GuideModal
        open={showGuide}
        onClose={() => setShowGuide(false)}
        isDesktop={isDesktop}
        isMobile={isMobile}
        onGenerate={() => { setShowGuide(false); openGenerateFlow() }}
        onLocalSigner={() => { setShowGuide(false); handleLocalLogin() }}
        onExtension={() => { setShowGuide(false); handleNip07Login() }}
      />
      <ExtensionGuideModal open={showExtensionGuide} onClose={() => setShowExtensionGuide(false)} />
      <NoLocalSignerModal open={showLocalSignerModal} onClose={() => setShowLocalSignerModal(false)} isDesktop={isDesktop} />


      {/* ── Pending Deletion Modal ── */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[340px] bg-card border border-border rounded-xl shadow-2xl p-6 space-y-4 text-center">
            {deleteStatus === 'deleting' && (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                  <Loader2 size={24} className="text-destructive animate-spin" />
                </div>
                <h3 className="text-lg font-bold text-foreground">Deleting Account</h3>
                <p className="text-sm text-muted-foreground">
                  Removing account from this device…<br />
                  Please don't close the app.
                </p>
              </>
            )}
            {deleteStatus === 'done' && (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-green-500/10 flex items-center justify-center">
                  <Check size={24} className="text-green-500" />
                </div>
                <h3 className="text-lg font-bold text-foreground">Account Deleted</h3>
                <p className="text-sm text-muted-foreground">The account has been removed from this device.</p>
                <button
                  onClick={() => setPendingDelete(null)}
                  className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  OK
                </button>
              </>
            )}
            {deleteStatus === 'error' && (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertCircle size={24} className="text-destructive" />
                </div>
                <h3 className="text-lg font-bold text-foreground">Deletion Failed</h3>
                <p className="text-sm text-destructive">{deleteError}</p>
                <button
                  onClick={() => setPendingDelete(null)}
                  className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  OK
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Terms of Use Modal ─── */

const TERMS_SECTIONS = [
  {
    title: 'Account Responsibility',
    content: 'DEN Chat and its creator(s) bear no responsibility for any lost, stolen, or compromised accounts or funds. You are solely responsible for safeguarding your cryptographic keys, seed phrases, and any associated credentials. No recovery mechanism exists. If you lose access, it cannot be restored by anyone.',
  },
  {
    title: 'Self-Custodial Software',
    content: 'DEN Chat is self-custodial software that generates and manages cryptographic keypairs on your behalf. You hold full and exclusive custody of your keys at all times. No third party, including the developers of DEN Chat, has access to, manages, or can retrieve your private keys. You bear complete responsibility for maintaining the security and privacy of your accounts.',
  },
  {
    title: 'Emerging Technology',
    content: 'The underlying technologies, including the Nostr protocol, Blossom media storage, Cashu eCash, and cryptographic signing mechanisms, are under active development. These systems may contain undiscovered vulnerabilities, bugs, or design limitations that could result in loss of account access, funds, data, or other unintended consequences. You acknowledge and accept these risks by using this software.',
  },
  {
    title: 'Decentralized & Permissionless',
    content: 'DEN Chat is decentralized, open-source software that does not require permission from any authority to use. It enables you to generate a cryptographic keypair and participate in social, messaging, and other operations on the Nostr network. Because of its decentralized architecture, DEN Chat is inherently censorship-resistant. No single entity can restrict, moderate, or revoke access to the network on your behalf.',
  },
  {
    title: 'Privacy & Data Collection',
    content: 'As a decentralized and permissionless application, DEN Chat does not collect, store, or process any personally identifiable information. No age verification, identity checks, or surveillance mechanisms are implemented. You acknowledge that implementing such systems in a decentralized context would be ineffective at best and actively harmful at worst, creating centralized stores of sensitive data that are vulnerable to breaches, corruption, and misuse, posing a potential direct threat to the privacy and safety of individuals or groups, from men and women, to the elderly and especially children. In other words, to "protect children", DEN Chat does not collect personal identifiable information such as ID and age verification.',
  },
  {
    title: 'Minor Users',
    content: 'DEN Chat is primarily a communications tool that connects you with a global population of users. If you are under the legal age of adulthood as defined by the laws of your country or jurisdiction, we strongly advise that a parent, familial guardian, or legal guardian be present to oversee your use of this software, otherwise you should not use DEN Chat. While DEN Chat does not knowingly target or market to minors, its open and permissionless nature means that interactions with the broader public are inherent to its function.',
  },
  {
    title: 'Open-Source Software',
    content: 'DEN Chat is provided as free and open-source software. You are free to inspect, modify, and distribute the source code in accordance with its license. The software is provided in the spirit of transparency, and you are encouraged to verify its behavior independently.',
  },
  {
    title: 'No Warranty',
    content: 'This software is provided "as is" without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.',
  },
  {
    title: 'Limitation of Liability',
    content: 'You acknowledge that DEN Chat and its creator(s) are not responsible for any mental, emotional, or physical harm that you may experience as a result of using this software or interacting with other users through it. This includes, but is not limited to, exposure to objectionable content, harassment, misinformation, or any other negative interactions that may occur on a decentralized and permissionless communication platform.',
  },
  {
    title: 'Mental Health & Sound Judgment',
    content: 'By using DEN Chat, you confirm that you are of sound mental health and capable of exercising reasonable judgment. This may include, but is not limited to, the ability to differentiate between fiction and reality, to recognize satire, sarcasm, and hypothetical scenarios, and to understand that content shared by other users does not constitute professional advice of any kind (medical, legal, financial, or otherwise). If you are experiencing a mental health crisis or are unable to make sound decisions, you should not use this software as it may negatively affect you or others. DEN Chat is a communication tool and is not a substitute for professional help.',
  },
  {
    title: 'Encryption & Communications Privacy',
    content: 'DEN Chat implements cryptographic encryption for direct messages and hub communications. However, encryption alone does not guarantee private communications. You acknowledge that message confidentiality can be compromised by any participant, intentionally or unintentionally, through leaked encryption keys, screen sharing or streaming, physical observers viewing a screen, operating systems or installed software monitoring activity, compromised devices, or any other means outside the scope of the encryption itself. DEN Chat guarantees the implementation of encryption flows, but cannot and does not guarantee that your communications will remain private under all circumstances. Note: Media files (images, videos, audio) uploaded to Blossom servers are not encrypted and are stored in plaintext that can be viewed by server operators. Only message text and metadata are encrypted.',
  },
  {
    title: 'Third-Party Relays & Services',
    content: "DEN Chat connects to third-party Nostr relays, Blossom media servers, and other decentralized infrastructure that are not owned, operated, or controlled by DEN Chat or its creator(s). The availability, uptime, performance, and data handling practices of these services are entirely outside the scope of DEN Chat's responsibility. Relay operators may impose their own policies, filter content, or cease operation at any time without notice.",
  },
  {
    title: 'Content Responsibility',
    content: 'You are solely responsible for all content you create, publish, and broadcast through DEN Chat. Once a Nostr event is signed and published to the network, it may be replicated and stored across multiple relays indefinitely. Deletion requests are best-effort and cannot be guaranteed; any content you publish should be considered potentially permanent. DEN Chat does not monitor, moderate, or endorse any user-generated content.',
  },
]

function TermsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [expanded, setExpanded] = useState<number | null>(null)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col bg-card rounded-xl border border-border shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <Shield size={18} className="text-primary" />
            <h2 className="font-semibold text-foreground">Terms of Use</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Description */}
        <div className="px-5 py-3 border-b border-border/50 bg-secondary/30 shrink-0">
          <p className="text-xs text-muted-foreground leading-relaxed">
            By using DEN Chat, you confirm that you have fully read, acknowledge, and understand the following:
          </p>
        </div>

        {/* Accordion sections */}
        <div className="flex-1 overflow-y-auto px-5 py-3 max-h-[500px]">
          {TERMS_SECTIONS.map((section, i) => {
            const isOpen = expanded === i
            return (
              <div key={i} className="border-b border-border/40 last:border-0">
                <button
                  onClick={() => setExpanded(isOpen ? null : i)}
                  className="w-full flex items-center justify-between py-3.5 text-left cursor-pointer group"
                >
                  <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                    {section.title}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`text-muted-foreground shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                <div
                  className={`overflow-hidden transition-all duration-150 ease-in-out ${isOpen ? 'max-h-[200px] opacity-100 pb-3' : 'max-h-0 opacity-0'
                    }`}
                >
                  <p className="text-xs text-muted-foreground leading-relaxed pl-0.5">
                    {section.content}
                  </p>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
          >
            I Understand
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Guide / Tutorial Modal ─── */

const GUIDE_PAGES: { title: string; icon: React.ReactNode; content: React.ReactNode }[] = [
  {
    title: 'What is Your Account?',
    icon: <KeyRound size={22} className="text-primary" />,
    content: (
      <div className="space-y-3 text-[13px] text-muted-foreground leading-relaxed">
        <p>
          Your account isn't stored on a server somewhere. It lives <strong className="text-foreground">entirely on your device</strong>. When you
          create an account, the app generates a unique pair of cryptographic keys:
        </p>
        <div className="rounded-lg bg-secondary/40 border border-border/50 p-3 space-y-2">
          <p><strong className="text-foreground">Public key</strong> - Like your username. Others use it to find and message you. It's safe to share.</p>
          <p><strong className="text-foreground">Private key</strong> - Like your password, but much more powerful. It proves you are you.{' '}
            <span className="text-amber-400 font-medium">Never share it with anyone.</span>
          </p>
        </div>
        <p>
          There is no company holding your account. No email, no phone number, no "forgot password" link.
          If you lose your private key (or the seed phrase that generates it), <strong className="text-foreground">nobody can recover it for you</strong>. Not
          even the developers of this app.
        </p>
      </div>
    ),
  },
  {
    title: 'Your Seed Phrase',
    icon: <Sprout size={22} className="text-emerald-500" />,
    content: (
      <div className="space-y-3 text-[13px] text-muted-foreground leading-relaxed">
        <p>
          When you generate a new account, you'll receive a <strong className="text-foreground">24-word seed phrase</strong>. Think of it as the
          master key to your account. From these 24 words, your private key is mathematically derived.
        </p>
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 space-y-2">
          <p className="font-medium text-amber-400 flex items-center gap-1.5"><Lock size={14} className="shrink-0" /> Treat your seed phrase like a bank vault key:</p>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>Write it down on paper and store it somewhere safe</li>
            <li>Download the encrypted backup when prompted</li>
            <li>Never type it into any website or share it in a message</li>
            <li>Anyone with these words has <em>full control</em> of your account</li>
          </ul>
        </div>
        <p>
          You can also derive <strong className="text-foreground">multiple accounts</strong> from a single seed phrase. Each one gets its own
          unique identity, but they all trace back to the same 24 words.
        </p>
      </div>
    ),
  },
  {
    title: 'Logging In',
    icon: <Lock size={22} className="text-primary" />,
    content: (
      <div className="space-y-3 text-[13px] text-muted-foreground leading-relaxed">
        <p>
          There are several ways to log in, depending on your setup. Here's a quick overview:
        </p>
        <div className="space-y-2">
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><MonitorSmartphone size={13} className="shrink-0" /> Desktop App (Normal)</p>
            <p className="text-xs">Your keys are stored securely in your device's keychain when you generate it through DEN Chat, protected by a PIN you choose. Just enter your PIN to unlock.</p>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><Link2 size={13} className="shrink-0" /> Remote Signer (Advanced)</p>
            <p className="text-xs">Apps like <strong>DENOS</strong> (desktop) or <strong>Amber</strong> (Android) hold your keys separately and approve requests
              from DEN Chat. Your private key never touches this app. This is the recomended ways to login and use DEN Chat as it would be more secure.</p>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><AppWindow size={13} className="shrink-0" /> Browser Extension</p>
            <p className="text-xs">Extensions like <strong>nos2x</strong> or <strong>Keys.Band</strong> manage your key in the browser. Quick to set up,
              but be sure you trust the extension, and even other extensions you've installed, as well as the browser you have, as it has access to your private key.</p>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><KeyRound size={13} className="shrink-0" /> DNN ID + Password</p>
            <p className="text-xs">If you have a DNN ID, you can log in with a username and password, done by having a running remote signer that supports this flow like DENOS</p>
          </div>
        </div>
      </div>
    ),
  },
  {
    title: 'Backups Matter',
    icon: <Download size={22} className="text-cyan-500" />,
    content: (
      <div className="space-y-3 text-[13px] text-muted-foreground leading-relaxed">
        <p>
          Since no one can recover your account for you, <strong className="text-foreground">backups are everything</strong>. Here's what you should do:
        </p>
        <div className="space-y-2">
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><FileText size={13} className="shrink-0" /> Write down your 24 words</p>
            <p className="text-xs">Physical paper, stored offline and somewhere safe. This is your ultimate fallback. If everything else fails, these words can restore your account.</p>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><Package size={13} className="shrink-0" /> Download the encrypted backup</p>
            <p className="text-xs">When creating an account, the app offers a PIN-encrypted backup file. Save this file on a USB drive or a cloud storage you trust. You'll need your PIN to decrypt it later.</p>
          </div>
        </div>
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
          <p className="text-xs text-destructive font-medium flex items-center gap-1.5"><AlertCircle size={13} className="shrink-0" /> No backup = no recovery. If your device breaks, gets stolen, or you forget your PIN, your only
            lifeline is the 24-word seed phrase or the encrypted backup file.</p>
        </div>
      </div>
    ),
  },
  {
    title: 'Security Basics',
    icon: <Shield size={22} className="text-emerald-500" />,
    content: (
      <div className="space-y-3 text-[13px] text-muted-foreground leading-relaxed">
        <p>
          A few important security truths to keep in mind:
        </p>
        <div className="space-y-2">
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><XCircle size={13} className="shrink-0" /> There is no "Forgot Password"</p>
            <p className="text-xs">Nobody can reset your access. Not the developers, not a support team. If you lose your seed phrase and forget your PIN, that account is gone forever.</p>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><LockOpen size={13} className="shrink-0" /> If your key leaks, it's over</p>
            <p className="text-xs">Anyone who gets your private key or seed phrase can post as you, read your encrypted messages, and spend any funds in your wallet. There is no way to "change your password" - you'd have to create a new account entirely.</p>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><MonitorSmartphone size={13} className="shrink-0" /> Your device is your vault</p>
            <p className="text-xs">If your device is compromised (malware, someone else has access), then your account is also compromised. Keep your OS updated and be mindful of what you install.</p>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/50 p-2.5">
            <p className="font-medium text-foreground text-xs mb-1 flex items-center gap-1.5"><EyeOff size={13} className="shrink-0" /> Encrypted doesn't mean private</p>
            <p className="text-xs">While your DMs and hub chat messages are encrypted, others can still see <em>who</em> you've talked to and <em>which</em> hubs you've been active in. On top of that, closed-source operating systems like Windows or macOS could potentially monitor your messages before encryption even happens, so you're trusting that they don't considering these systems are closed source.</p>
          </div>
        </div>
      </div>
    ),
  },
  {
    title: 'You\'re Ready!',
    icon: <Check size={22} className="text-emerald-500" />,
    content: (
      <div className="space-y-3 text-[13px] text-muted-foreground leading-relaxed">
        <p>
          That covers the essentials. Here's a quick recap:
        </p>
        <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 space-y-2">
          <ul className="space-y-2 text-xs">
            <li className="flex items-start gap-2"><Check size={14} className="text-emerald-500 shrink-0 mt-0.5" /> Your account is a cryptographic key pair that lives on your device. No servers, no company.</li>
            <li className="flex items-start gap-2"><Check size={14} className="text-emerald-500 shrink-0 mt-0.5" /> Your 24-word seed phrase is your ultimate backup. Keep it safe, keep it secret.</li>
            <li className="flex items-start gap-2"><Check size={14} className="text-emerald-500 shrink-0 mt-0.5" /> There are multiple ways to log in. Choose what fits your comfort level.</li>
            <li className="flex items-start gap-2"><Check size={14} className="text-emerald-500 shrink-0 mt-0.5" /> Always back up your account. No backup means no recovery.</li>
            <li className="flex items-start gap-2"><Check size={14} className="text-emerald-500 shrink-0 mt-0.5" /> If your key leaks, nobody can fix it. Treat it like cash - once it's gone, it's gone.</li>
          </ul>
        </div>
        <p className="text-center text-sm text-foreground font-medium pt-1 flex items-center justify-center gap-1.5">
          Welcome to DEN Chat. Enjoy the freedom. <Check size={16} className="text-emerald-500" />
        </p>
      </div>
    ),
  },
]

function GuideModal({ open, onClose, isDesktop, isMobile, onGenerate, onLocalSigner, onExtension }: {
  open: boolean
  onClose: () => void
  isDesktop: boolean
  isMobile: boolean
  onGenerate: () => void
  onLocalSigner: () => void
  onExtension: () => void
}) {
  type Track = 'choice' | 'quick' | 'detailed'
  const [track, setTrack] = useState<Track>('choice')
  const [page, setPage] = useState(0)
  const [showDownload, setShowDownload] = useState(false)
  const [latestBuild, setLatestBuild] = useState<{
    version: string
    platforms: { platform: string; url: string; ext: string }[]
    published_at: number
  } | null>(null)
  const [buildLoading, setBuildLoading] = useState(false)

  // Reset state when modal opens
  useEffect(() => {
    if (open) { setTrack('choice'); setPage(0); setShowDownload(false) }
  }, [open])

  // Fetch latest build when download modal opens (web only)
  useEffect(() => {
    if (!showDownload) return
    setBuildLoading(true)
    const BUILD_PREFIX = 'den-chat-build-'
    fetchEvents({ authors: [ADMIN_PUBKEY], kinds: [30078] }).then((events) => {
      const parsed: { version: string; platforms: { platform: string; url: string; ext: string }[]; published_at: number }[] = []
      for (const ev of events) {
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1]
        if (!dTag || !dTag.startsWith(BUILD_PREFIX)) continue
        try {
          const data = JSON.parse(ev.content)
          if (data.deleted || ev.tags.some(t => t[0] === 'deleted')) continue
          if (data.version) {
            parsed.push({
              version: data.version,
              platforms: Array.isArray(data.platforms)
                ? data.platforms.map((p: Record<string, string>) => ({ platform: p.platform || '', url: p.url || '', ext: p.ext || '' }))
                : [],
              published_at: data.published_at || ev.created_at,
            })
          }
        } catch { /* ignore */ }
      }
      parsed.sort((a, b) => b.published_at - a.published_at)
      if (parsed.length > 0) setLatestBuild(parsed[0])
    }).finally(() => setBuildLoading(false))
  }, [showDownload])

  if (!open) return null

  // Quick-start slides
  const QUICK_SLIDES = [
    {
      icon: <KeyRound size={40} className="text-primary" />,
      bg: 'bg-primary/10',
      title: 'Your keys, your identity',
      body: 'Your account is a pair of cryptographic keys that live only on your device. No email, no phone number, no company.',
    },
    {
      icon: <Shield size={40} className="text-emerald-500" />,
      bg: 'bg-emerald-500/10',
      title: 'Back it up, or lose it forever',
      body: 'When you create an account, you may receive a seed phrase (24 words) or a private key. Write it down and keep it safe. If you lose it, nobody can recover your account for you. Not even the developers.',
    },
  ]

  const quickTotal = QUICK_SLIDES.length + 1 // +1 for CTA slide

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg mx-4 flex flex-col bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            {track !== 'choice' && (
              <button
                onClick={() => { setTrack('choice'); setPage(0) }}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                <ChevronLeft size={16} />
              </button>
            )}
            <BookOpen size={18} className="text-primary" />
            <h2 className="font-semibold text-foreground">Getting Started</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* ── Choice Screen ── */}
        {track === 'choice' && (
          <div className="px-5 py-6 space-y-3">
            <p className="text-sm text-muted-foreground text-center mb-4">How would you like to get started?</p>

            {/* Quick Start card */}
            <button
              onClick={() => { setTrack('quick'); setPage(0) }}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-secondary/30 hover:bg-secondary/50 hover:border-primary/30 transition-all cursor-pointer text-left group"
            >
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/15 transition-colors">
                <Rocket size={24} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-foreground">Quick Start</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Get up and running in under a minute</p>
              </div>
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            </button>

            {/* Detailed Guide — de-emphasized text link so non-technical users go for Quick Start */}
            <div className="text-center pt-1">
              <button
                onClick={() => { setTrack('detailed'); setPage(0) }}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors cursor-pointer"
              >
                Or read the detailed guide
              </button>
            </div>
          </div>
        )}

        {/* ── Quick Start Track ── */}
        {track === 'quick' && (
          <>
            {/* Info slides */}
            {page < QUICK_SLIDES.length && (
              <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 text-center min-h-[280px]">
                <div className={`w-20 h-20 rounded-2xl ${QUICK_SLIDES[page].bg} flex items-center justify-center mb-5`}>
                  {QUICK_SLIDES[page].icon}
                </div>
                <h3 className="text-lg font-bold text-foreground mb-2">{QUICK_SLIDES[page].title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-sm">
                  {QUICK_SLIDES[page].body}
                </p>
              </div>
            )}

            {/* CTA slide */}
            {page === QUICK_SLIDES.length && (
              <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 text-center min-h-[280px]">
                <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
                  <Rocket size={40} className="text-primary" />
                </div>
                <h3 className="text-lg font-bold text-foreground mb-2">Ready to go!</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mb-5">
                  Create your account and start using DEN Chat.
                </p>

                <div className="w-full max-w-xs space-y-2">
                  {isDesktop ? (
                    <>
                      <Button variant="outline" onClick={onLocalSigner} className="w-full gap-2">
                        <MonitorSmartphone size={16} />
                        Local Signer
                      </Button>
                      <Button onClick={onGenerate} className="w-full gap-2">
                        <Plus size={16} />
                        Generate Account
                      </Button>
                    </>
                  ) : isMobile ? (
                    <Button onClick={onGenerate} className="w-full gap-2">
                      <Plus size={16} />
                      Generate Account
                    </Button>
                  ) : (
                    <>
                      <Button variant="outline" onClick={onExtension} className="w-full gap-2">
                        <AppWindow size={16} />
                        Use Extension
                      </Button>
                      <Button onClick={() => setShowDownload(true)} className="w-full gap-2">
                        <Download size={16} />
                        Download DEN Chat
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Footer navigation */}
            <div className="px-5 py-3 border-t border-border shrink-0 flex items-center justify-between">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <ChevronLeft size={16} /> Back
              </button>

              {/* Page dots */}
              <div className="flex items-center gap-1.5">
                {Array.from({ length: quickTotal }).map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setPage(i)}
                    className={`w-2 h-2 rounded-full transition-all cursor-pointer ${i === page ? 'bg-primary scale-110' : 'bg-border hover:bg-muted-foreground/50'}`}
                  />
                ))}
              </div>

              {page < quickTotal - 1 ? (
                <button
                  onClick={() => setPage(p => Math.min(quickTotal - 1, p + 1))}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Next <ChevronRight size={16} />
                </button>
              ) : (
                <button
                  onClick={onClose}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
                >
                  Close
                </button>
              )}
            </div>
          </>
        )}

        {/* ── Detailed Track (existing pages) ── */}
        {track === 'detailed' && (() => {
          const detailedTotal = GUIDE_PAGES.length
          const current = GUIDE_PAGES[page]
          return (
            <>
              {/* Page title */}
              <div className="px-5 py-3 border-b border-border/50 bg-secondary/30 shrink-0 flex items-center gap-2.5">
                {current.icon}
                <h3 className="text-sm font-semibold text-foreground">{current.title}</h3>
                <span className="ml-auto text-[10px] text-muted-foreground font-medium tabular-nums">{page + 1} / {detailedTotal}</span>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-5 py-4 min-h-[260px] max-h-[50vh]">
                {current.content}
              </div>

              {/* Footer navigation */}
              <div className="px-5 py-3 border-t border-border shrink-0 flex items-center justify-between">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                >
                  <ChevronLeft size={16} /> Back
                </button>

                {/* Page dots */}
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: detailedTotal }).map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setPage(i)}
                      className={`w-2 h-2 rounded-full transition-all cursor-pointer ${i === page ? 'bg-primary scale-110' : 'bg-border hover:bg-muted-foreground/50'}`}
                    />
                  ))}
                </div>

                {page < detailedTotal - 1 ? (
                  <button
                    onClick={() => setPage(p => Math.min(detailedTotal - 1, p + 1))}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                  >
                    Next <ChevronRight size={16} />
                  </button>
                ) : (
                  <button
                    onClick={onClose}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                  >
                    Got it <Check size={16} />
                  </button>
                )}
              </div>
            </>
          )
        })()}
      </div>

      {/* ── Download Sub-modal (web only) ── */}
      {showDownload && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowDownload(false)} />
          <div className="relative z-10 w-full max-w-md mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2.5">
                <Download size={18} className="text-primary" />
                <h2 className="font-semibold text-foreground">Download DEN Chat</h2>
              </div>
              <button onClick={() => setShowDownload(false)} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
              {buildLoading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2">
                  <Loader2 size={24} className="animate-spin text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">Fetching latest build...</p>
                </div>
              ) : latestBuild ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{latestBuild.version}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(latestBuild.published_at * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  {latestBuild.platforms.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">Choose your platform:</p>
                      {latestBuild.platforms.map((p, i) => (
                        <a
                          key={i}
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-secondary/40 border border-border hover:bg-secondary/60 hover:border-primary/30 transition-all group w-full"
                        >
                          <Download size={14} className="text-primary shrink-0" />
                          <span className="text-sm text-foreground font-medium">{p.platform}</span>
                          {p.ext && (
                            <span className="text-[11px] text-muted-foreground ml-auto">.{p.ext.replace(/^\./, '')}</span>
                          )}
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">No platform downloads available.</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">No builds available yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Extension Guide Modal ─── */

const CHROME_EXTENSIONS = [
  { name: 'nos2x', url: 'https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp' },
  { name: 'Keys.Band', url: 'https://chromewebstore.google.com/detail/keysband/jdencabhccnfhedpfoojbbdlgmecnlkm' },
]

const FIREFOX_EXTENSIONS = [
  { name: 'nos2x-fox', url: 'https://addons.mozilla.org/en-US/firefox/addon/nos2x-fox/' },
  { name: 'Nostr Connect', url: 'https://addons.mozilla.org/en-US/firefox/addon/nostr-connect/' },
]

function ExtensionGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-md mx-4 flex flex-col bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <AppWindow size={18} className="text-primary" />
            <h2 className="font-semibold text-foreground">Browser Extension Required</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            No Nostr signer extension was detected in your browser. To log in this way, you'll need to install one first.
          </p>

          {/* Chrome */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Globe size={13} className="shrink-0" /> Chrome / Chromium-based browsers
            </p>
            <div className="flex gap-2">
              {CHROME_EXTENSIONS.map(ext => (
                <a
                  key={ext.name}
                  href={ext.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-secondary/40 border border-border/50 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors"
                >
                  {ext.name}
                  <ExternalLink size={11} className="text-muted-foreground" />
                </a>
              ))}
            </div>
          </div>

          {/* Firefox */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Globe size={13} className="shrink-0" /> Firefox
            </p>
            <div className="flex gap-2">
              {FIREFOX_EXTENSIONS.map(ext => (
                <a
                  key={ext.name}
                  href={ext.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-secondary/40 border border-border/50 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors"
                >
                  {ext.name}
                  <ExternalLink size={11} className="text-muted-foreground" />
                </a>
              ))}
            </div>
          </div>

          {/* Refresh reminder */}
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 flex items-start gap-2">
            <RefreshCw size={14} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              After installing an extension and generating or importing an account in it, <strong className="text-foreground">refresh this page</strong> and click "Extension" again to log in.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── No Local Signer Modal ─── */


/** s-tag value used by DENOS to group version history events */
const DENOS_VERSIONS_TAG = 'denos-versions'

/** Platform labels for display */
const PLATFORM_LABELS: Record<string, string> = {
  'windows-x86_64': 'Windows',
  'windows-aarch64': 'Windows (ARM)',
  'linux-x86_64': 'Linux',
  'linux-x86_64-bin': 'Linux (binary)',
  'linux-aarch64': 'Linux (ARM)',
  'linux-aarch64-bin': 'Linux ARM (binary)',
  'darwin-x86_64': 'macOS (Intel)',
  'darwin-aarch64': 'macOS (ARM)',
}

interface DenosPlatformBinary {
  target: string   // e.g. "windows-x86_64"
  label: string    // e.g. "Windows"
  hash: string     // SHA-256 hash (blossom file ID)
  ext: string      // e.g. "nsis.zip", "dmg", "AppImage"
}

interface DenosBuild {
  version: string
  notes: string
  pub_date: string
  platforms: DenosPlatformBinary[]
  source?: { hash: string; ext: string }
  created_at: number
}

function NoLocalSignerModal({ open, onClose, isDesktop }: { open: boolean; onClose: () => void; isDesktop: boolean }) {
  const [view, setView] = useState<'info' | 'downloads'>('info')
  const [builds, setBuilds] = useState<DenosBuild[]>([])
  const [loadingBuilds, setLoadingBuilds] = useState(false)
  const [buildError, setBuildError] = useState(false)
  const [openBuildIdx, setOpenBuildIdx] = useState<number | null>(null)

  // Reset view when modal opens
  useEffect(() => {
    if (open) setView('info')
  }, [open])

  const fetchDenosBuilds = useCallback(() => {
    setLoadingBuilds(true)
    setBuildError(false)

    // Fetch kind:30078 events from DENOS creator with s=denos-versions
    fetchEvents({ authors: [ADMIN_PUBKEY], kinds: [30078] }).then((events) => {
      const parsed: DenosBuild[] = []
      for (const ev of events) {
        // Only include version history events (s-tag = denos-versions)
        const hasVersionsTag = ev.tags.some((t) => t[0] === 's' && t[1] === DENOS_VERSIONS_TAG)
        if (!hasVersionsTag) continue
        try {
          const data = JSON.parse(ev.content)
          if (!data.version) continue
          // Map platforms from { target: { hash, ext } } to array
          const platforms: DenosPlatformBinary[] = []
          if (data.platforms && typeof data.platforms === 'object') {
            for (const [target, info] of Object.entries(data.platforms)) {
              const bin = info as { hash?: string; ext?: string }
              if (bin.hash) {
                platforms.push({
                  target,
                  label: PLATFORM_LABELS[target] || target,
                  hash: bin.hash,
                  ext: bin.ext || 'bin',
                })
              }
            }
          }
          parsed.push({
            version: data.version,
            notes: data.notes || '',
            pub_date: data.pub_date || '',
            platforms,
            source: data.source?.hash ? data.source : undefined,
            created_at: ev.created_at,
          })
        } catch { /* ignore */ }
      }
      // Sort by created_at (newest first), deduplicate by version
      parsed.sort((a, b) => b.created_at - a.created_at)
      const seen = new Set<string>()
      const deduped = parsed.filter((b) => {
        if (seen.has(b.version)) return false
        seen.add(b.version)
        return true
      })
      setBuilds(deduped)
      if (deduped.length > 0) setOpenBuildIdx(0)
    }).catch(() => setBuildError(true)).finally(() => setLoadingBuilds(false))
  }, [])

  const handleShowDownloads = () => {
    setView('downloads')
    if (builds.length === 0 && !loadingBuilds) fetchDenosBuilds()
  }

  /** Construct a blossom download URL from hash + ext */
  const getDownloadUrl = (hash: string, ext: string) => {
    const servers = blossomServerManager.getServers()
    const base = servers.length > 0
      ? servers[0].replace(/\/+$/, '')
      : 'https://blossom.primal.net'
    return `${base}/${hash}.${ext}`
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col overflow-hidden"
        style={{ maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            {view === 'downloads' && (
              <button
                onClick={() => setView('info')}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
              >
                <ChevronLeft size={16} />
              </button>
            )}
            <MonitorSmartphone size={18} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              {view === 'info' ? 'Local Signer' : 'Download DENOS'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {view === 'info' ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                No local signer was detected. The Local login connects to a NIP-PC55 signer application
                (like <span className="text-foreground font-medium">DENOS</span>) running on your device.
              </p>

              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">To use this login method:</p>
                <div className="space-y-1.5">
                  <div className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="text-primary font-semibold mt-0.5">1.</span>
                    <span>Download and install <span className="text-foreground font-medium">DENOS</span> or another NIP-PC55 compatible signer</span>
                  </div>
                  <div className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="text-primary font-semibold mt-0.5">2.</span>
                    <span>Open the signer app and create or import an account</span>
                  </div>
                  <div className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="text-primary font-semibold mt-0.5">3.</span>
                    <span>Come back here and click <span className="text-foreground font-medium">Local</span> again</span>
                  </div>
                </div>
              </div>

              {!isDesktop && (
                <div className="rounded-lg bg-secondary/50 border border-border px-3 py-2.5">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    <span className="text-foreground font-medium">Browser users:</span> Your browser may block access to local
                    network resources (<code className="text-[10px] bg-secondary px-1 py-0.5 rounded">ws://localhost</code>).
                    If a signer is running, check your browser&apos;s security settings or try the desktop app.
                  </p>
                </div>
              )}

              <button
                onClick={handleShowDownloads}
                className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
              >
                <Download size={15} />
                Download DENOS
              </button>
            </div>
          ) : (
            /* Downloads view */
            <div className="space-y-3">
              {loadingBuilds ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <Loader2 size={20} className="text-primary animate-spin" />
                  <p className="text-sm text-muted-foreground">Fetching available builds...</p>
                </div>
              ) : buildError ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <p className="text-sm text-muted-foreground">Failed to load builds.</p>
                  <button
                    onClick={fetchDenosBuilds}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border bg-secondary/40 text-sm font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
                  >
                    <RefreshCw size={14} /> Try Again
                  </button>
                </div>
              ) : builds.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-12">No builds published yet.</p>
              ) : (
                builds.map((build, idx) => {
                  const isOpen = openBuildIdx === idx
                  const dateStr = build.pub_date
                    ? new Date(build.pub_date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                    : new Date(build.created_at * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                  return (
                    <div key={build.version} className="rounded-lg border border-border overflow-hidden bg-secondary/20">
                      <button
                        onClick={() => setOpenBuildIdx(isOpen ? null : idx)}
                        className="flex items-center justify-between w-full px-4 py-3 text-left cursor-pointer hover:bg-secondary/40 transition-colors"
                      >
                        <div className="flex items-center gap-3 pr-4">
                          <span className="text-sm font-semibold text-foreground">v{build.version}</span>
                          <span className="text-xs text-muted-foreground">{dateStr}</span>
                          {idx === 0 && <span className="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Latest</span>}
                        </div>
                        <svg className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 space-y-2">
                          {build.notes && (
                            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{build.notes}</p>
                          )}
                          {build.platforms.length > 0 && (
                            <div className="space-y-1.5">
                              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Downloads</div>
                              {build.platforms.map((p) => (
                                <a
                                  key={p.target}
                                  href={getDownloadUrl(p.hash, p.ext)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/40 border border-border hover:bg-secondary/60 transition-colors group w-full text-left no-underline"
                                >
                                  <Download size={14} className="text-primary shrink-0" />
                                  <span className="text-sm text-foreground font-medium">{p.label}</span>
                                  <span className="text-xs text-muted-foreground truncate flex-1 text-right group-hover:text-foreground/60 transition-colors">
                                    .{p.ext}
                                  </span>
                                </a>
                              ))}
                            </div>
                          )}
                          {build.source && (
                            <a
                              href={getDownloadUrl(build.source.hash, build.source.ext)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/40 border border-border hover:bg-secondary/60 transition-colors group w-full text-left no-underline"
                            >
                              <FileText size={14} className="text-muted-foreground shrink-0" />
                              <span className="text-sm text-foreground font-medium">Source Code</span>
                              <span className="text-xs text-muted-foreground truncate flex-1 text-right group-hover:text-foreground/60 transition-colors">
                                .{build.source.ext}
                              </span>
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg bg-secondary text-foreground text-sm font-medium hover:bg-secondary/80 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
