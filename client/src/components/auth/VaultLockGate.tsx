/**
 * VaultLockGate — transparent re-unlock for vault sessions.
 *
 * The vault auto-locks after idle. When a signing/decrypt op hits a locked
 * vault, vaultClient calls the handler registered here; this shows a PIN modal,
 * unlocks, and the original op retries. Mounted once at the app root; inert
 * unless the active account is vault-backed.
 */
import { useEffect, useState } from 'react'
import { Lock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PinInput } from '@/components/auth/PinInput'
import { useUserStore } from '@/stores/userStore'
import { getVaultClient } from '@/lib/auth/vaultClient'

export function VaultLockGate() {
  const authMethod = useUserStore((s) => s.authMethod)
  const logout = useUserStore((s) => s.logout)
  const [req, setReq] = useState<{ pubkey: string; resolve: () => void } | null>(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const vault = getVaultClient()
    if (authMethod !== 'vault') { setReq(null); return }
    vault.setUnlockHandler((pubkey: string) => new Promise<void>((resolve) => {
      setPin(''); setError(null)
      setReq({ pubkey, resolve })
    }))
    return () => vault.setUnlockHandler(null)
  }, [authMethod])

  if (!req) return null

  const submit = async () => {
    if (!pin || busy) return
    setBusy(true); setError(null)
    try {
      await getVaultClient().unlock(req.pubkey, pin)
      req.resolve()
      setReq(null); setPin('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unlock failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl bg-card border border-border shadow-xl p-6 flex flex-col items-center gap-4 text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10"><Lock size={22} className="text-primary" /></div>
        <h3 className="text-lg font-bold text-foreground">Vault locked</h3>
        <p className="text-sm text-muted-foreground">Your vault locked after a period of inactivity. Enter your PIN to continue.</p>
        <PinInput value={pin} onChange={setPin} autoFocus onEnter={submit} />
        {error && <p className="text-sm text-destructive w-full">{error}</p>}
        <Button className="w-full" disabled={!pin || busy} onClick={submit}>{busy ? <Loader2 size={16} className="animate-spin" /> : 'Unlock'}</Button>
        <button onClick={() => { setReq(null); logout() }} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer">Log out instead</button>
      </div>
    </div>
  )
}
