/**
 * VaultAuth — mobile/PWA login backed by the isolated vault origin.
 *
 * Rendered by LoginScreen only when `!isTauri() && isMobileOS()`. Mirrors the
 * desktop account flow (list → pick → PIN), plus Create (generate → save seed →
 * set PIN → download backup → re-upload to verify) and Import (file). The private
 * key lives entirely in the vault; on success the app authenticates with
 * `vaultSigner()` (authMethod 'vault') so all signing routes through the vault.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Import, ChevronLeft, KeyRound, Download, FileUp, Check, Copy, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { getVaultClient, vaultSigner, type VaultAccount } from '@/lib/auth/vaultClient'
import { encryptBackup, parseBackupPayload, verifyBackupMatches } from '@/lib/auth/backupCrypto'
import { truncateNpub } from '@/lib/utils'

type Screen = 'loading' | 'accounts' | 'unlock' | 'create' | 'import'
type CreateStep = 'seed' | 'pin' | 'backup' | 'verify'

const vault = getVaultClient()

function completeLogin(pubkey: string) {
  useUserStore.getState().setSigner(vaultSigner())
  useUserStore.getState().login(pubkey, 'vault')
}

export function VaultAuth() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [accounts, setAccounts] = useState<VaultAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<VaultAccount | null>(null)

  const refresh = () => vault.status().then((s) => {
    setAccounts(s.accounts)
    setScreen('accounts')
  }).catch((e) => setError(e instanceof Error ? e.message : 'Vault unavailable'))

  useEffect(() => { refresh() }, [])

  if (screen === 'loading') return <Centered><Loader2 className="animate-spin text-muted-foreground" /></Centered>
  if (screen === 'unlock' && selected) return <UnlockScreen account={selected} onBack={() => setScreen('accounts')} onDone={completeLogin} />
  if (screen === 'create') return <CreateScreen onExit={() => setScreen('accounts')} onDone={completeLogin} />
  if (screen === 'import') return <ImportScreen onBack={() => setScreen('accounts')} onDone={completeLogin} />

  return (
    <div className="w-full max-w-sm mx-auto space-y-4">
      <Header title="Welcome to DEN" subtitle={accounts.length ? 'Choose an account to unlock, or add one.' : 'Create a new account, or import a backup.'} />
      {error && <p className="text-sm text-destructive text-center">{error}</p>}
      {accounts.length > 0 && (
        <div className="space-y-2">
          {accounts.map((a) => (
            <AccountRow key={a.pubkey} account={a} onClick={() => { setSelected(a); setScreen('unlock') }} />
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => setScreen('create')}><Plus size={16} /> Create</Button>
        <Button variant="outline" onClick={() => setScreen('import')}><Import size={16} /> Import</Button>
      </div>
    </div>
  )
}

/* ─── Account list ─── */
function AccountRow({ account, onClick }: { account: VaultAccount; onClick: () => void }) {
  const { getProfile } = useProfileCache()
  const p = getProfile(account.pubkey)
  const name = account.name || p?.display_name || p?.name || truncateNpub(account.npub, 10)
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
    <Pane onBack={onBack}>
      <Header title={`Unlock ${display}`} subtitle="Enter your PIN to sign in." />
      <Input type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="PIN" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" disabled={!pin || busy} onClick={submit}>{busy ? <Loader2 size={16} className="animate-spin" /> : 'Unlock'}</Button>
    </Pane>
  )
}

/* ─── Create ─── */
function CreateScreen({ onExit, onDone }: { onExit: () => void; onDone: (pubkey: string) => void }) {
  const [step, setStep] = useState<CreateStep>('seed')
  const [mnemonic, setMnemonic] = useState('')
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { vault.generate().then((r) => setMnemonic(r.mnemonic)).catch((e) => setError(e instanceof Error ? e.message : 'Generate failed')) }, [])

  const download = async () => {
    const p = await encryptBackup(mnemonic, pin)
    const blob = new Blob([JSON.stringify(p)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `den-backup-${Date.now()}.json`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    setDownloaded(true)
  }

  const onVerifyFile = async (file: File) => {
    setBusy(true); setError(null)
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
    } finally { setBusy(false) }
  }

  if (!mnemonic && !error) return <Centered><Loader2 className="animate-spin text-muted-foreground" /></Centered>

  if (step === 'seed') {
    const words = mnemonic.split(' ')
    return (
      <Pane onBack={onExit}>
        <Header title="Your recovery phrase" subtitle="Write these 24 words down and keep them safe. They're the only way to recover your account on any client." />
        <div className="grid grid-cols-3 gap-1.5">
          {words.map((w, i) => (
            <div key={i} className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-muted/40 text-xs">
              <span className="text-muted-foreground tabular-nums w-4 text-right">{i + 1}</span>
              <span className="font-medium text-foreground truncate">{w}</span>
            </div>
          ))}
        </div>
        <button onClick={() => { navigator.clipboard?.writeText(mnemonic); setCopied(true); setTimeout(() => setCopied(false), 1500) }} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer">
          {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy phrase'}
        </button>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button className="w-full" onClick={() => setStep('pin')}>I've saved it · Continue</Button>
      </Pane>
    )
  }

  if (step === 'pin') {
    const ok = pin.length >= 4 && pin === pinConfirm
    return (
      <Pane onBack={() => setStep('seed')}>
        <Header title="Set a PIN" subtitle="Unlocks this device and encrypts your backup file. It can't be reset — your recovery phrase is the fallback." />
        <Input placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input type="password" inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        <Input type="password" inputMode="numeric" placeholder="Confirm PIN" value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value)} />
        {pin && pinConfirm && pin !== pinConfirm && <p className="text-xs text-destructive">PINs don't match.</p>}
        <Button className="w-full" disabled={!ok} onClick={() => setStep('backup')}>Continue</Button>
      </Pane>
    )
  }

  if (step === 'backup') {
    return (
      <Pane onBack={() => setStep('pin')}>
        <Header title="Download your backup" subtitle="A PIN-encrypted file. Save it somewhere safe — if this device loses its data, this file (with your PIN) restores your account." />
        <Button className="w-full" variant="outline" onClick={download}><Download size={16} /> {downloaded ? 'Downloaded · Download again' : 'Download encrypted backup'}</Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button className="w-full" disabled={!downloaded} onClick={() => setStep('verify')}>Continue</Button>
      </Pane>
    )
  }

  // verify
  return (
    <Pane onBack={() => setStep('backup')}>
      <Header title="Verify your backup" subtitle="Re-upload the file you just downloaded so we can confirm it's saved and works. Nothing leaves your device." />
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onVerifyFile(f) }} />
      <Button className="w-full" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? <><Loader2 size={16} className="animate-spin" /> Verifying…</> : <><FileUp size={16} /> Re-upload to verify & finish</>}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Pane>
  )
}

/* ─── Import ─── */
function ImportScreen({ onBack, onDone }: { onBack: () => void; onDone: (pubkey: string) => void }) {
  const [fileText, setFileText] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const pick = (file: File) => {
    file.text().then((t) => {
      if (!parseBackupPayload(t)) { setError('Not a valid DEN backup file.'); return }
      setFileText(t); setError(null)
    })
  }
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
    <Pane onBack={onBack}>
      <Header title="Import backup" subtitle="Restore an account from its encrypted backup file." />
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f) }} />
      <Button className="w-full" variant="outline" onClick={() => fileRef.current?.click()}><FileUp size={16} /> {fileText ? 'File selected · choose another' : 'Choose backup file'}</Button>
      {fileText && (
        <>
          <Input type="password" placeholder="Backup password / PIN" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <Input placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        </>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" disabled={!fileText || !password || busy} onClick={submit}>{busy ? <Loader2 size={16} className="animate-spin" /> : 'Import & sign in'}</Button>
    </Pane>
  )
}

/* ─── Layout helpers ─── */
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-sm mx-auto flex items-center justify-center py-16">{children}</div>
}
function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center space-y-1">
      <h2 className="text-lg font-bold text-foreground">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground leading-relaxed">{subtitle}</p>}
    </div>
  )
}
function Pane({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <Card className="w-full max-w-sm mx-auto">
      <CardContent className="p-4 space-y-3">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"><ChevronLeft size={14} /> Back</button>
        {children}
        <p className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground/70 pt-1"><ShieldCheck size={11} /> Your key is generated and stored in an isolated vault</p>
      </CardContent>
    </Card>
  )
}
