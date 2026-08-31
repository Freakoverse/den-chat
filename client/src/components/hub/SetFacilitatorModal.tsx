/**
 * SetFacilitatorModal — lets a not-yet-approved user unlock a hub via a facilitator.
 *
 * A facilitator is a member (with the `facilitate` permission) who can vouch people in without an
 * admin approving them. If such a member added the user to their facilitation list, the user enters
 * that facilitator's npub here; we fetch the facilitator's list → tree and try to decrypt the hub
 * secret from it. Success unlocks the hub; failure means they weren't actually vouched.
 */

import { useState } from 'react'
import { X, UserCheck, Loader2, AlertTriangle } from 'lucide-react'
import { nip19 } from 'nostr-tools'
import { useUserStore } from '@/stores/userStore'
import { useHubStore, type HubData } from '@/stores/hubStore'
import { loadFacilitatorSecret } from '@/hooks/useHubLoader'

export function SetFacilitatorModal({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const setHubSecret = useHubStore((s) => s.setHubSecret)
  const setHubPref = useHubStore((s) => s.setHubPref)
  const setHubFacilitatorMembers = useHubStore((s) => s.setHubFacilitatorMembers)
  const setEpochSecrets = useHubStore((s) => s.setEpochSecrets)

  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!pubkey || busy) return
    setBusy(true)
    setError(null)
    try {
      const t = input.trim()
      let facilitatorPubkey: string
      if (t.startsWith('npub1')) {
        const d = nip19.decode(t)
        if (d.type !== 'npub') throw new Error('That’s not a valid npub')
        facilitatorPubkey = d.data as string
      } else if (/^[0-9a-f]{64}$/i.test(t)) {
        facilitatorPubkey = t.toLowerCase()
      } else {
        throw new Error('Enter a valid npub or 64-character hex public key')
      }
      if (facilitatorPubkey === pubkey) throw new Error('You can’t be your own facilitator')

      const result = await loadFacilitatorSecret(hub, facilitatorPubkey, pubkey, privateKey, signer)
      if (!result?.secretHex) {
        setError('You aren’t facilitated by this person — they haven’t added you to their list (or they don’t maintain one for this hub).')
        setBusy(false)
        return
      }

      // Populate the epoch history so the facilitated user can decrypt every epoch the facilitator
      // knows (v1 facilitator trees now carry the same history blob the owner tree does).
      if (result.epochSecrets && Object.keys(result.epochSecrets).length > 0) {
        setEpochSecrets(hub.dTag, result.epochSecrets)
      }
      // Remember the facilitator regardless, so rotation re-fetches (Part 4) can find them later.
      setHubPref(hub.dTag, 'facilitator', facilitatorPubkey)
      if (result.facilitatorMembers.length > 0) {
        setHubFacilitatorMembers(hub.dTag, facilitatorPubkey, result.facilitatorMembers)
      }

      // The facilitator's distributed secret is the CURRENT hub secret ONLY when their list is at
      // the current epoch. If they're behind (haven't rebuilt for a rotation yet), set only the
      // epoch history — old messages stay readable, but we must NOT install a stale secret as the
      // live one (it would let us send at the new epoch with an old key → undecryptable for everyone,
      // and read nothing new). getChannelKey returns null for the current epoch until they catch up.
      const isCurrent = result.epoch == null || result.epoch === hub.epoch
      if (isCurrent) {
        setHubSecret(hub.dTag, result.secretHex)
        setHubPref(hub.dTag, 'facilitatorSecret', result.secretHex)
        // v2: decrypt the hub's structural content (channels/roles) now, so the user lands in a
        // populated hub instead of an empty one until the next reload.
        try {
          const { isV2 } = await import('@/lib/hub/version')
          if (isV2(hub)) {
            const { getHubEvent } = await import('@/lib/cache/hubEventCache')
            const { KINDS } = await import('@/lib/crypto/constants')
            const { decryptAndMergeV2HubContent } = await import('@/hooks/useHubLoader')
            const ev = await getHubEvent(KINDS.HUB_EVENT, hub.creatorPubkey, hub.dTag)
            if (ev) await decryptAndMergeV2HubContent(hub.dTag, ev, hub as HubData & { creatorPubkey: string }, result.secretHex)
          }
        } catch { /* content will populate on the next hub load */ }
        onClose()
      } else {
        setHubSecret(hub.dTag, '')
        setError('Your facilitator hasn’t updated their list for the hub’s current epoch yet. You can read older messages, but the latest ones will appear once they’re back online and rebuild.')
        setBusy(false)
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to set facilitator')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-3" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <UserCheck size={16} className="text-primary" /> Set your facilitator
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-5 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            A facilitator is a hub member who can vouch you in without waiting for an admin. Enter the
            <strong> facilitator handle they shared with you</strong> to unlock this hub. In a private
            hub this is their <em>in-hub handle</em> (shown to them under “Your facilitator handle”) —
            <strong> not</strong> their normal public npub.
          </p>
          <input
            type="text"
            autoFocus
            placeholder="npub1… (facilitator handle)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <button
            onClick={submit}
            disabled={busy || !input.trim()}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? (
              <><Loader2 size={14} className="animate-spin" /> Checking…</>
            ) : (
              <><UserCheck size={14} /> Unlock via facilitator</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
