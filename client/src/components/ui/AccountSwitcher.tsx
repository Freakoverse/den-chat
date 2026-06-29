/**
 * AccountSwitcher — switch between locally-stored accounts.
 *
 * Backend-agnostic, mirroring LoginScreen:
 *   - Desktop (Tauri):  accounts live in the OS keyring (rustBackend; seed/nsec).
 *                       The PIN is entered in-app, the released private key is stashed,
 *                       and the page reloads for a clean re-init (pending-switch).
 *   - PWA mobile:       accounts live in the isolated vault origin (vaultBackend;
 *                       authMethod 'vault'). The PIN is entered in the vault's OWN
 *                       overlay — so we stash the target pubkey and reload; LoginScreen's
 *                       pending-switch then unlocks it via the vault (single prompt,
 *                       clean teardown, the app never sees the PIN).
 *
 * Rendered via a `trigger` render-prop so the same modal backs both the compact
 * icon button (UserPanel) and the full-width button (Settings › General).
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useUserStore } from '@/stores/userStore'
import { isTauri, truncateNpub, cn } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { ChevronsUpDown, Sprout, Key, Lock, Eye, EyeOff, Check, X, Loader2 } from 'lucide-react'
import { rustBackend, vaultBackend, type StoredAccount, type StoredSeed } from '@/lib/auth/authBackend'
import { useProfileCache } from '@/hooks/useProfileCache'
import { useCachedImageUrl } from '@/lib/imageCache'

/** True when the active session can switch accounts via a local backend (desktop keyring or vault). */
export function useAccountSwitcherAvailable(): boolean {
  const authMethod = useUserStore((s) => s.authMethod)
  // seed/nsec only occur on desktop (OS keyring); 'vault' only on PWA mobile.
  return (isTauri() && (authMethod === 'seed' || authMethod === 'nsec')) || authMethod === 'vault'
}

export function AccountSwitcher({ trigger }: { trigger: (open: () => void) => React.ReactNode }) {
  const available = useAccountSwitcherAvailable()
  const pubkey = useUserStore((s) => s.pubkey)

  const usesVault = !isTauri()
  const backend = usesVault ? vaultBackend : rustBackend

  const [open, setOpen] = useState(false)
  const [accounts, setAccounts] = useState<StoredAccount[]>([])
  const [seeds, setSeeds] = useState<StoredSeed[]>([])
  const [target, setTarget] = useState<StoredAccount | null>(null)
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadAccounts = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([backend.listAccounts(), backend.listSeeds()])
      setAccounts(a)
      setSeeds(s)
    } catch { /* backend unavailable */ }
  }, [backend])

  useEffect(() => {
    if (open) loadAccounts()
  }, [open, loadAccounts])

  const accountGroups = useMemo(() => {
    const groups: { type: 'seed' | 'standalone'; seed?: StoredSeed; accounts: StoredAccount[] }[] = []
    for (const seed of seeds) {
      const accts = accounts.filter((a) => a.seed_id === seed.id)
      if (accts.length > 0) groups.push({ type: 'seed', seed, accounts: accts })
    }
    const standalone = accounts.filter((a) => !a.seed_id)
    if (standalone.length > 0) groups.push({ type: 'standalone', accounts: standalone })
    return groups
  }, [accounts, seeds])

  const close = () => {
    setOpen(false)
    setTarget(null)
    setPin('')
    setError(null)
    setShowPin(false)
    setLoading(false)
  }

  // Desktop: verify PIN in-app, stash the released key, reload for a clean re-init.
  const desktopSwitch = async () => {
    if (!target || !pin) return
    setLoading(true)
    setError(null)
    try {
      const r = await backend.loginAccount(target.pubkey, pin)
      sessionStorage.setItem('pending-switch', JSON.stringify({
        pubkey: target.pubkey,
        authMethod: r.authMethod,
        privKeyHex: r.privKey,
      }))
      window.location.reload()
    } catch {
      setError('Incorrect PIN')
      setLoading(false)
    }
  }

  const pickAccount = (acct: StoredAccount) => {
    if (acct.pubkey === pubkey) return
    if (usesVault) {
      // The vault prompts for the PIN in its own overlay after the reload — stash the
      // target and reload so every store/subscription is torn down for a clean switch.
      sessionStorage.setItem('pending-switch', JSON.stringify({ pubkey: acct.pubkey, authMethod: 'vault' }))
      window.location.reload()
      return
    }
    setTarget(acct)
    setPin('')
    setError(null)
    setShowPin(false)
  }

  if (!available) return null

  return (
    <>
      {trigger(() => setOpen(true))}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={close}>
          <div
            className="w-[380px] max-h-[70vh] bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h4 className="text-sm font-semibold flex items-center gap-2"><ChevronsUpDown size={16} /> Switch Account</h4>
              <button onClick={close} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
            </div>

            {/* Account list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {accountGroups.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">No accounts found</p>
              )}
              {accountGroups.map((group, gi) => (
                <div key={gi}>
                  <div className="flex items-center gap-1.5 px-2 mb-1.5">
                    {group.type === 'seed' ? (
                      <Sprout size={12} className="text-emerald-400 shrink-0" />
                    ) : (
                      <Key size={12} className="text-amber-400 shrink-0" />
                    )}
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                      {group.type === 'seed' ? (group.seed?.name || 'Seed') : 'Imported Keys'}
                    </span>
                  </div>

                  <div className="space-y-1">
                    {group.accounts.map((acct) => {
                      const isActive = acct.pubkey === pubkey
                      const acctNpub = acct.npub || nip19.npubEncode(acct.pubkey)
                      const acctName = acct.name || truncateNpub(acctNpub)

                      return (
                        <button
                          key={acct.pubkey}
                          onClick={() => pickAccount(acct)}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors',
                            isActive
                              ? 'bg-primary/10 cursor-default'
                              : target?.pubkey === acct.pubkey
                                ? 'bg-secondary ring-1 ring-primary/40'
                                : 'hover:bg-secondary/60 cursor-pointer',
                          )}
                        >
                          <AccountAvatar pubkey={acct.pubkey} size={32} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate text-foreground">{acctName}</div>
                            <div className="text-[10px] text-muted-foreground truncate">{truncateNpub(acctNpub)}</div>
                          </div>
                          <span className={cn(
                            'shrink-0 text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider',
                            acct.auth_method === 'seed'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : 'bg-amber-500/15 text-amber-400',
                          )}>
                            {acct.auth_method === 'seed' ? `#${(acct.account_index ?? 0)}` : 'nsec'}
                          </span>
                          {isActive && <Check size={14} className="shrink-0 text-primary" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* PIN prompt — desktop only; the vault collects the PIN in its own overlay */}
            {!usesVault && target && (
              <div className="border-t border-border px-4 py-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Enter PIN for <span className="font-medium text-foreground">{target.name || truncateNpub(target.npub || '')}</span>
                  {target.pin_hint && (
                    <span className="text-muted-foreground/70"> — hint: {target.pin_hint}</span>
                  )}
                </p>
                {error && (
                  <p className="text-xs text-destructive">{error}</p>
                )}
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showPin ? 'text' : 'password'}
                      value={pin}
                      onChange={(e) => { setPin(e.target.value); setError(null) }}
                      onKeyDown={(e) => e.key === 'Enter' && desktopSwitch()}
                      placeholder="PIN"
                      autoFocus
                      className="w-full h-9 rounded-lg border border-input bg-background px-3 pr-9 text-sm focus:outline-none [&::-ms-reveal]:hidden"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPin(!showPin)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button
                    onClick={desktopSwitch}
                    disabled={!pin || loading}
                    className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                    Switch
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** Small avatar for the account switcher — fetches profile from cache */
function AccountAvatar({ pubkey, size = 32 }: { pubkey: string; size?: number }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey) // synchronous — triggers bg fetch + re-render via hook
  const cachedUrl = useCachedImageUrl(profile?.picture ?? undefined)
  const npub = nip19.npubEncode(pubkey)
  const fallback = truncateNpub(npub).slice(0, 2).toUpperCase()

  return (
    <span
      className="relative flex shrink-0 overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      {cachedUrl ? (
        <img src={cachedUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full text-[10px] bg-primary text-primary-foreground">
          {fallback}
        </span>
      )}
    </span>
  )
}
