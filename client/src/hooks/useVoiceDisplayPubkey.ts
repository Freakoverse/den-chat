/**
 * useVoiceDisplayPubkey — resolve a voice participant's wire pubkey to a displayable key.
 *
 * On a v2 (Hub Privacy v2) hub the wire pubkey is the member pseudonym `P` — the author
 * of voice host/presence events, the SFU/room identity, and the DataChannel label. Voice
 * UI must map it back to the real key `R` to show a face + name:
 *   - primary:  decrypt the presence event's `ir` tag (`enc(hub_content_key, R)`) — works
 *               cross-page, exactly like the typing-indicator reveal;
 *   - fallback: the same-page roster (`hubMembers`) `m.p === P → m.pubkey` (R);
 *   - neither:  return `P` unchanged (graceful — a faceless but functional tile).
 *
 * On a v1 hub the wire pubkey IS `R`, so this is a no-op. `P → R` is deterministic and
 * epoch-independent, so a tiny module cache makes resolution flicker-free and cheap even
 * as presence updates stream in at ~10 Hz.
 */

import { useEffect, useState } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUserStore } from '@/stores/userStore'

const _pToRCache = new Map<string, string>()
const _myVoiceCache = new Map<string, string>()

/**
 * Clear the voice pseudonym caches. MUST be called on account switch — `_pToRCache` maps voice
 * `P → R` for a hub with NO account discriminator, and its cache-hit short-circuits the isV2/secret
 * checks, so a leftover entry would leak the P↔R linkage account A decrypted to account B on the same
 * device (even if B is a non-member / lacks the secret). `_myVoiceCache` is pubkey-keyed but cleared
 * here too so a logged-out account's derived pseudonym doesn't linger.
 */
export function clearVoiceDisplayCache() {
  _pToRCache.clear()
  _myVoiceCache.clear()
}

/**
 * The current user's OWN voice wire pubkey for a hub: their member pseudonym `P` on a v2 hub
 * (what their voice host + presence events are authored under), or their real key `R` on v1.
 * Use it to recognize "is this MY voice host?" — a v2 host is authored by `P`, so comparing a
 * host's pubkey against `R` misses it. Returns `R` as a graceful fallback until `P` resolves.
 */
export function useMyVoicePubkey(hubDTag: string | undefined | null): string {
  const pubkey = useUserStore((s) => s.pubkey)
  const hub = useHubStore((s) => (hubDTag ? s.hubs[hubDTag] : null))
  const [vp, setVp] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    if (!hubDTag || !hub || !pubkey) { setVp(undefined); return }
    const cacheKey = `${hubDTag}:${pubkey}`
    const cached = _myVoiceCache.get(cacheKey)
    if (cached) { setVp(cached); return }
    ;(async () => {
      const { isV2 } = await import('@/lib/hub/version')
      if (!isV2(hub)) { _myVoiceCache.set(cacheKey, pubkey); if (alive) setVp(pubkey); return }
      const { privateKey, signer } = useUserStore.getState()
      const { canUseV2, ChatContext } = await import('@/lib/crypto/skd')
      if (!canUseV2({ privateKey, signer })) { if (alive) setVp(pubkey); return } // can't derive P → fall back to R
      const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
      const p = await makeSubkeySigner(ChatContext.member(hub.dTag), { privateKey, signer, peerPub: hub.creatorPubkey }).getPublicKey()
      _myVoiceCache.set(cacheKey, p)
      if (alive) setVp(p)
    })()
    return () => { alive = false }
  }, [hubDTag, hub, pubkey])

  return vp || pubkey || ''
}

export function useVoiceDisplayPubkey(wirePubkey: string | undefined): string {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const hubMembers = useHubStore((s) => (activeHubId ? s.hubMembers[activeHubId] : undefined))
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const epochSecrets = useHubStore((s) => s.epochSecrets)
  const presenceByHub = useVoiceStore((s) => s.presenceByHub)
  const [resolved, setResolved] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    if (!wirePubkey || !hub || !activeHubId) { setResolved(undefined); return }

    const cacheKey = `${activeHubId}:${wirePubkey}`
    const cached = _pToRCache.get(cacheKey)
    if (cached) { setResolved(cached); return }
    setResolved(undefined)

    ;(async () => {
      const { isV2 } = await import('@/lib/hub/version')
      if (!isV2(hub)) return // v1: the wire pubkey already IS R

      // Fallback: same-page roster P → R (synchronous once the roster is loaded).
      const rosterR = hubMembers?.find((m) => m.p === wirePubkey)?.pubkey
      if (rosterR) { _pToRCache.set(cacheKey, rosterR); if (alive) setResolved(rosterR); return }

      // Primary: decrypt this participant's presence `ir` tag (cross-page).
      const pres = (presenceByHub[activeHubId] || []).find((p) => p.pubkey === wirePubkey && p.ir)
      if (!pres?.ir) return
      const secretHex =
        (pres.irEpoch != null ? epochSecrets[activeHubId]?.[pres.irEpoch] : undefined) || hubSecrets[activeHubId]
      if (!secretHex) return
      try {
        const { deriveHubContentKey } = await import('@/lib/hub/hubContent')
        const { aesDecrypt } = await import('@/lib/crypto/aes')
        const { fromHex } = await import('@/lib/crypto/lkh')
        const epoch = pres.irEpoch ?? hub.epoch
        const r = await aesDecrypt(deriveHubContentKey(fromHex(secretHex), epoch), pres.ir)
        if (/^[0-9a-f]{64}$/i.test(r)) { _pToRCache.set(cacheKey, r); if (alive) setResolved(r) }
      } catch { /* wrong key/epoch or forged — leave as P */ }
    })()

    return () => { alive = false }
  }, [wirePubkey, hub, activeHubId, hubMembers, presenceByHub, hubSecrets, epochSecrets])

  return resolved || wirePubkey || ''
}
