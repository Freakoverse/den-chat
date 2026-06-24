/**
 * VaultLockGate — transparent re-unlock for vault sessions.
 *
 * The vault auto-locks after idle. When a signing/decrypt op hits a locked vault,
 * vaultClient calls the handler registered here, which asks the vault to prompt for
 * the PIN in its OWN overlay (the app never sees it); the original op then retries.
 * Mounted once at the app root; inert unless the active account is vault-backed.
 */
import { useEffect } from 'react'
import { useUserStore } from '@/stores/userStore'
import { getVaultClient } from '@/lib/auth/vaultClient'

export function VaultLockGate() {
  const authMethod = useUserStore((s) => s.authMethod)

  useEffect(() => {
    const vault = getVaultClient()
    if (authMethod !== 'vault') { vault.setUnlockHandler(null); return }
    // Re-unlock in the vault's own overlay — the PIN never touches the app origin.
    vault.setUnlockHandler((pubkey: string) => vault.unlockInteractive(pubkey).then(() => undefined))
    return () => vault.setUnlockHandler(null)
  }, [authMethod])

  return null
}
