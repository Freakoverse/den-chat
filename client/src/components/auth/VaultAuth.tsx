/**
 * VaultAuth — mobile/PWA login backed by the isolated vault origin.
 *
 * Rendered by LoginScreen only when `!isTauri() && isMobileOS()`. Mirrors the
 * desktop flow (account list → pick → PIN; Create Account → Backup Seed Phrase;
 * Import) one-for-one — same wordings, hidden-by-default dotted words, reveal
 * confirm + countdown — plus a local re-upload-to-verify step before the key is
 * saved. The private key lives entirely in the vault; on success the app
 * authenticates with `vaultSigner()` (authMethod 'vault') so signing routes
 * through the vault.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Import, KeyRound, Download, FileUp, Check, Copy, ShieldCheck, Eye, EyeOff, Lock, Shield, AlertCircle, QrCode, Sprout, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DenChatLogo } from '@/components/ui/DenChatLogo'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { getVaultClient, vaultSigner, type VaultAccount, type VaultSeed } from '@/lib/auth/vaultClient'
import { encryptBackup, parseBackupPayload, verifyBackupMatches } from '@/lib/auth/backupCrypto'
import { WarningCarousel } from '@/components/auth/WarningCarousel'
import { PinInput } from '@/components/auth/PinInput'
import { QRScanner } from '@/components/auth/QRScanner'
import { truncateNpub } from '@/lib/utils'

type Screen = 'loading' | 'accounts' | 'seed' | 'unlock' | 'derive' | 'create' | 'import'

const vault = getVaultClient()

function completeLogin(pubkey: string) {
  useUserStore.getState().setSigner(vaultSigner())
  useUserStore.getState().login(pubkey, 'vault')
}

function downloadBackup(payload: object) {
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `den-backup-${Date.now()}.json`
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
}

export function VaultAuth({ onCreated }: { onCreated?: (pubkey: string) => void } = {}) {
  const [screen, setScreen] = useState<Screen>('loading')
  const [seeds, setSeeds] = useState<VaultSeed[]>([])
  const [accounts, setAccounts] = useState<VaultAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedSeed, setSelectedSeed] = useState<VaultSeed | null>(null)
  const [selectedAccount, setSelectedAccount] = useState<VaultAccount | null>(null)

  const loadStatus = () => vault.status().then((s) => { setSeeds(s.seeds); setAccounts(s.accounts) })
  const refresh = () => loadStatus().then(() => setScreen('accounts')).catch((e) => setError(e instanceof Error ? e.message : 'Vault unavailable'))

  useEffect(() => { refresh() }, [])

  const accountsOf = (seedId: string) => accounts.filter((a) => a.seedId === seedId).sort((a, b) => a.index - b.index)

  const openSeed = (seed: VaultSeed) => {
    const accts = accountsOf(seed.id)
    // A single key can't derive → straight to unlock. A seed always opens its detail
    // screen (even with one account) so you can pick OR derive a new account.
    if (seed.kind === 'key' && accts[0]) {
      setSelectedSeed(seed); setSelectedAccount(accts[0]); setScreen('unlock'); return
    }
    setSelectedSeed(seed); setScreen('seed')
  }

  if (screen === 'loading') return <VaultCard><Loader2 className="animate-spin text-muted-foreground my-6" /></VaultCard>
  if (screen === 'seed' && selectedSeed) return <SeedScreen seed={selectedSeed} accounts={accountsOf(selectedSeed.id)} onBack={() => setScreen('accounts')} onPick={(a) => { setSelectedAccount(a); setScreen('unlock') }} onDerive={() => setScreen('derive')} />
  if (screen === 'unlock' && selectedAccount) return <UnlockScreen account={selectedAccount} onBack={() => setScreen(selectedSeed?.kind === 'seed' ? 'seed' : 'accounts')} onDone={completeLogin} />
  if (screen === 'derive' && selectedSeed) return <DeriveScreen seed={selectedSeed} onBack={() => setScreen('seed')} onDone={() => { loadStatus().finally(() => setScreen('seed')) }} />
  if (screen === 'create') return <CreateScreen onExit={() => setScreen('accounts')} onDone={onCreated ?? completeLogin} />
  if (screen === 'import') return <ImportScreen onBack={() => setScreen('accounts')} onDone={completeLogin} />

  return (
    <VaultCard>
      <Header title="DEN Chat" subtitle={seeds.length ? 'Choose an identity to unlock, or add one.' : 'Create a new account, or import a backup.'} />
      {error && <p className="text-sm text-destructive text-center">{error}</p>}
      {seeds.length > 0 && (
        <div className="w-full space-y-2">
          {seeds.map((s) => (
            <SeedRow key={s.id} seed={s} count={accountsOf(s.id).length} firstAccount={accountsOf(s.id)[0]} onClick={() => openSeed(s)} />
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 w-full">
        <Button variant="outline" onClick={() => setScreen('create')}><Plus size={16} /> Create</Button>
        <Button variant="outline" onClick={() => setScreen('import')}><Import size={16} /> Import</Button>
      </div>
    </VaultCard>
  )
}

/* ─── Seed row (top-level identity: a seed or a single key) ─── */
function SeedRow({ seed, count, firstAccount, onClick }: { seed: VaultSeed; count: number; firstAccount?: VaultAccount; onClick: () => void }) {
  const { getProfile } = useProfileCache()
  const p = firstAccount ? getProfile(firstAccount.pubkey) : undefined
  const label = seed.name || p?.display_name || p?.name || (firstAccount ? truncateNpub(firstAccount.npub, 10) : 'Identity')
  const isKey = seed.kind === 'key'
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:border-border/80 transition-colors cursor-pointer text-left">
      <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        {isKey ? <KeyRound size={16} className="text-primary" /> : <Sprout size={16} className="text-primary" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{label}</p>
        <p className="text-xs text-muted-foreground truncate">{isKey ? 'Single key' : `${count} account${count === 1 ? '' : 's'}`}</p>
      </div>
      <ChevronRight size={16} className="text-muted-foreground shrink-0" />
    </button>
  )
}

/* ─── Account row (an account under a seed) ─── */
function AccountRow({ account, onClick }: { account: VaultAccount; onClick: () => void }) {
  const { getProfile } = useProfileCache()
  const p = getProfile(account.pubkey)
  const name = account.name || p?.display_name || p?.name || `Account #${account.index + 1}`
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:border-border/80 transition-colors cursor-pointer text-left">
      <Avatar className="h-9 w-9"><AvatarImage src={p?.picture as string | undefined} /><AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{name}</p>
        <p className="text-xs text-muted-foreground truncate font-mono">{truncateNpub(account.npub, 14)}</p>
      </div>
      <KeyRound size={16} className="text-muted-foreground shrink-0" />
    </button>
  )
}

/* ─── Seed detail (accounts under a seed + derive) ─── */
function SeedScreen({ seed, accounts, onBack, onPick, onDerive }: { seed: VaultSeed; accounts: VaultAccount[]; onBack: () => void; onPick: (a: VaultAccount) => void; onDerive: () => void }) {
  return (
    <VaultCard onBack={onBack}>
      <Header icon={Sprout} title={seed.name || 'Seed'} subtitle="Select an account to unlock, or derive a new one." />
      <div className="w-full space-y-2">
        {accounts.map((a) => <AccountRow key={a.pubkey} account={a} onClick={() => onPick(a)} />)}
      </div>
      {seed.kind === 'seed' && (
        <Button variant="outline" className="w-full" onClick={onDerive}><Plus size={16} /> Derive New Account</Button>
      )}
    </VaultCard>
  )
}

/* ─── Derive a new account from a seed (same PIN) ─── */
function DeriveScreen({ seed, onBack, onDone }: { seed: VaultSeed; onBack: () => void; onDone: () => void }) {
  const [pin, setPin] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!pin || busy) return
    setBusy(true); setError(null)
    try { await vault.deriveAccount(seed.id, pin, name.trim() || undefined); onDone() }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not derive account') }
    finally { setBusy(false) }
  }
  return (
    <VaultCard onBack={onBack}>
      <Header icon={Plus} title="Derive New Account" subtitle={`A new account from ${seed.name || 'this seed'} — enter the seed's PIN.`} />
      <Input placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
      <PinInput value={pin} onChange={setPin} placeholder="Seed PIN" autoFocus onEnter={submit} />
      {error && <p className="flex items-center gap-1.5 text-sm text-destructive w-full"><AlertCircle size={14} className="shrink-0" /> {error}</p>}
      <Button className="w-full" disabled={!pin || busy} onClick={submit}>{busy ? <Loader2 size={16} className="animate-spin" /> : 'Derive account'}</Button>
    </VaultCard>
  )
}

/* ─── Unlock ─── */
function UnlockScreen({ account, onBack, onDone }: { account: VaultAccount; onBack: () => void; onDone: (pubkey: string) => void }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!pin || busy) return
    setBusy(true); setError(null)
    try { const r = await vault.unlock(account.pubkey, pin); onDone(r.pubkey) }
    catch (e) { setError(e instanceof Error ? e.message : 'Unlock failed') }
    finally { setBusy(false) }
  }
  const display = account.name || truncateNpub(account.npub, 12)
  return (
    <VaultCard onBack={onBack}>
      <Header icon={Lock} title={`Unlock ${display}`} subtitle="Enter your PIN to sign in." />
      <PinInput value={pin} onChange={setPin} autoFocus onEnter={submit} />
      {error && <p className="flex items-center gap-1.5 text-sm text-destructive w-full"><AlertCircle size={14} className="shrink-0" /> {error}</p>}
      <Button className="w-full" disabled={!pin || busy} onClick={submit}>{busy ? <Loader2 size={16} className="animate-spin" /> : 'Unlock'}</Button>
    </VaultCard>
  )
}

/* ─── Create (Create Account → Backup Seed Phrase) ─── */
function CreateScreen({ onExit, onDone }: { onExit: () => void; onDone: (pubkey: string) => void }) {
  const [step, setStep] = useState<'pin' | 'backup'>('pin')
  const [mnemonic, setMnemonic] = useState('')
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Backup-step state (mirrors the desktop seed-backup screen)
  const [showBackupWords, setShowBackupWords] = useState(false)
  const [backupCopied, setBackupCopied] = useState(false)
  const [showRevealConfirm, setShowRevealConfirm] = useState(false)
  const [revealCountdown, setRevealCountdown] = useState<number | null>(null)
  const [showCopyConfirm, setShowCopyConfirm] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (revealTimerRef.current) clearInterval(revealTimerRef.current) }, [])

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

  const handleGenerate = async () => {
    if (pin.length < 4 || pin !== pinConfirm || generating) return
    setGenerating(true); setError(null)
    try {
      const r = await vault.generate()
      setMnemonic(r.mnemonic)
      setStep('backup')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate a seed')
    } finally { setGenerating(false) }
  }

  const handleDownload = async () => {
    const payload = await encryptBackup(mnemonic, pin)
    downloadBackup(payload)
    setDownloaded(true)
  }

  const handleVerifyFile = async (file: File) => {
    setVerifying(true); setError(null)
    try {
      const text = await file.text()
      const result = await verifyBackupMatches(text, pin, mnemonic)
      if (result !== 'ok') {
        setError(result === 'mismatch' ? "That file is a different account's backup." : result === 'wrong-password' ? "That file doesn't match this PIN." : 'Not a valid backup file.')
        return
      }
      const r = await vault.saveNew(mnemonic, pin, name.trim() || undefined)
      onDone(r.pubkey)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed')
    } finally { setVerifying(false) }
  }

  // ── Step 1: Create Account (PIN) ──
  if (step === 'pin') {
    const ok = pin.length >= 4 && pin === pinConfirm
    return (
      <VaultCard onBack={onExit}>
        <Header icon={Lock} title="Create Account" subtitle="Choose a PIN to protect your new account. You'll need it every time you log in." />
        <WarningCarousel />
        <Input type="text" placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
        <PinInput value={pin} onChange={(v) => { setPin(v); setError(null) }} placeholder="Enter PIN" />
        <PinInput value={pinConfirm} onChange={setPinConfirm} placeholder="Confirm PIN" />
        {pin && pinConfirm && pin !== pinConfirm && <p className="text-xs text-destructive w-full">PINs don't match.</p>}
        {error && <p className="flex items-center gap-1.5 text-sm text-destructive w-full"><AlertCircle size={14} className="shrink-0" /> {error}</p>}
        <Button className="w-full" disabled={!ok || generating} onClick={handleGenerate}>
          {generating ? <Loader2 size={16} className="animate-spin" /> : 'Generate New Seed'}
        </Button>
      </VaultCard>
    )
  }

  // ── Step 2: Backup Seed Phrase ──
  const words = mnemonic.split(' ')
  return (
    <VaultCard onBack={() => setStep('pin')} wide>
      <Header icon={Shield} title="Backup Seed Phrase" />

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 w-full">
        <AlertCircle size={14} className="text-destructive shrink-0 mt-0.5" />
        <p className="text-xs text-destructive">Write down these words and store them securely. Anyone with these words can access your keys and funds.</p>
      </div>

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
          onClick={() => { if (showBackupWords) { setShowBackupWords(false) } else { setRevealCountdown(null); setShowRevealConfirm(true) } }}
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

      <button
        onClick={handleDownload}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border text-xs hover:bg-secondary/60 transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
      >
        <Download size={14} /> {downloaded ? 'Download Encrypted Backup again' : 'Download Encrypted Backup'}
      </button>

      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVerifyFile(f) }} />
      <Button className="w-full mt-1" disabled={!downloaded || verifying} onClick={() => fileRef.current?.click()}>
        {verifying ? <><Loader2 size={16} className="animate-spin" /> Verifying…</> : downloaded ? <><FileUp size={16} /> Re-upload backup to verify & finish</> : 'Download backup to continue'}
      </Button>
      {downloaded && !verifying && <p className="text-[11px] text-muted-foreground text-center -mt-1">Re-upload the file you just saved to confirm it works.</p>}
      {error && <p className="flex items-center gap-1.5 text-sm text-destructive w-full"><AlertCircle size={14} className="shrink-0" /> {error}</p>}

      {/* Reveal-seed confirmation + countdown */}
      {showRevealConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150" onClick={revealCountdown === null ? () => setShowRevealConfirm(false) : undefined}>
          <div className="w-full max-w-sm rounded-xl bg-card border border-border shadow-xl p-6 flex flex-col items-center gap-4 text-center" onClick={(e) => e.stopPropagation()}>
            {revealCountdown === null ? (
              <>
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-destructive/10"><AlertCircle size={22} className="text-destructive" /></div>
                <h3 className="text-lg font-bold text-foreground">Reveal your secret keys?</h3>
                <p className="text-sm text-muted-foreground">These 24 words <strong>are</strong> your account. Anyone who sees them — over your shoulder, on a screen share, or in a screenshot — gains <strong className="text-destructive">full and permanent control</strong> of your identity and funds. There is no recovery and no undo.</p>
                <p className="text-xs text-muted-foreground">Make sure no one is watching your screen and nothing is recording.</p>
                <div className="flex gap-2 w-full mt-1">
                  <Button variant="outline" className="flex-1" onClick={() => setShowRevealConfirm(false)}>Cancel</Button>
                  <Button variant="destructive" className="flex-1 gap-1.5" onClick={startRevealCountdown}><Eye size={14} /> Yes, show</Button>
                </div>
              </>
            ) : (
              <>
                <div className="relative flex items-center justify-center w-16 h-16">
                  <svg className="animate-spin h-16 w-16 text-destructive/30" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span key={revealCountdown} className="absolute text-2xl font-bold text-foreground tabular-nums animate-in zoom-in-50 fade-in duration-300">{revealCountdown}</span>
                </div>
                <h3 className="text-lg font-bold text-foreground">Showing keys in {revealCountdown}…</h3>
                <p className="text-sm text-muted-foreground">Last chance — make sure no one can see your screen.</p>
                <Button variant="outline" className="w-full gap-1.5" onClick={cancelReveal}><EyeOff size={14} /> Wait, never mind</Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Copy-seed confirmation */}
      {showCopyConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150" onClick={() => setShowCopyConfirm(false)}>
          <div className="w-full max-w-sm rounded-xl bg-card border border-border shadow-xl p-6 flex flex-col items-center gap-4 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-destructive/10"><AlertCircle size={22} className="text-destructive" /></div>
            <h3 className="text-lg font-bold text-foreground">Copy seed to clipboard?</h3>
            <p className="text-sm text-muted-foreground">Your clipboard can be read by other apps and clipboard-history tools, and may sync across your devices. Only copy if you're pasting it somewhere safe <strong>right now</strong> — and clear your clipboard afterward.</p>
            <div className="flex gap-2 w-full mt-1">
              <Button variant="outline" className="flex-1" onClick={() => setShowCopyConfirm(false)}>Cancel</Button>
              <Button variant="destructive" className="flex-1 gap-1.5" onClick={() => { navigator.clipboard?.writeText(mnemonic); setBackupCopied(true); setShowCopyConfirm(false); setTimeout(() => setBackupCopied(false), 2000) }}><Copy size={14} /> Yes, copy</Button>
            </div>
          </div>
        </div>
      )}
    </VaultCard>
  )
}

/* ─── Import ─── */
function ImportScreen({ onBack, onDone }: { onBack: () => void; onDone: (pubkey: string) => void }) {
  const [fileText, setFileText] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadText = (t: string) => {
    if (!parseBackupPayload(t)) { setError('Not a valid DEN backup (file or QR).'); return false }
    setFileText(t); setError(null); return true
  }
  const pick = (file: File) => { file.text().then(loadText) }
  const submit = async () => {
    if (!fileText || !password || busy) return
    setBusy(true); setError(null)
    try {
      const payload = parseBackupPayload(fileText)!
      const r = await vault.importBackup(payload, password, name.trim() || undefined)
      onDone(r.pubkey)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed (check the password)')
    } finally { setBusy(false) }
  }

  return (
    <VaultCard onBack={onBack}>
      <Header icon={Import} title="Import backup" subtitle="Restore an account from its encrypted backup file or QR code." />
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f) }} />
      <div className="grid grid-cols-2 gap-2 w-full">
        <Button variant="outline" onClick={() => fileRef.current?.click()}><FileUp size={16} /> {fileText ? 'Loaded ✓' : 'File'}</Button>
        <Button variant="outline" onClick={() => { setError(null); setScanning(true) }}><QrCode size={16} /> Scan QR</Button>
      </div>
      {scanning && <QRScanner onResult={(t) => { loadText(t); setScanning(false) }} onClose={() => setScanning(false)} />}
      {fileText && (
        <>
          <PinInput value={password} onChange={setPassword} placeholder="Backup password / PIN" onEnter={submit} />
          <Input placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
        </>
      )}
      {error && <p className="flex items-center gap-1.5 text-sm text-destructive w-full"><AlertCircle size={14} className="shrink-0" /> {error}</p>}
      <Button className="w-full" disabled={!fileText || !password || busy} onClick={submit}>{busy ? <Loader2 size={16} className="animate-spin" /> : 'Import & sign in'}</Button>
    </VaultCard>
  )
}

/* ─── Layout helpers ─── */
function VaultCard({ onBack, wide, children }: { onBack?: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <Card className={`w-full ${wide ? 'max-w-md' : 'max-w-sm'} mx-auto shadow-lg`}>
      <CardContent className="p-6 sm:p-8 flex flex-col items-center gap-4">
        <DenChatLogo size={40} />
        {children}
        {onBack && <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground cursor-pointer">Back</button>}
        <p className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground/70"><ShieldCheck size={11} /> Your key is generated and stored in an isolated vault</p>
      </CardContent>
    </Card>
  )
}
function Header({ icon: Icon, title, subtitle }: { icon?: React.ComponentType<{ size?: number; className?: string }>; title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <div className="flex items-center gap-2">
        {Icon && <Icon size={20} className="text-primary" />}
        <h2 className="text-xl font-bold text-foreground">{title}</h2>
      </div>
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  )
}
