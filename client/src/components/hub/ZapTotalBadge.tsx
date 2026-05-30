/**
 * ZapTotalBadge — Inline badge showing total zap sats for a message
 *
 * Rendered next to the ReactionBar in message rows.
 * Self-contained — reads directly from zapStore.
 */

import { useState, useMemo } from 'react'
import { Zap } from 'lucide-react'
import { useZapStore } from '@/stores/zapStore'
import { useHubStore } from '@/stores/hubStore'
import { formatSats, type ZapInfo } from '@/lib/nostr/zap'
import { ZapListModal } from '@/components/hub/ZapListModal'

export function ZapTotalBadge({ hubDTag, messageId, onOpenProfile }: {
  hubDTag: string
  messageId: string
  onOpenProfile?: (pubkey: string) => void
}) {
  const rawZaps = useZapStore((s) => s.zaps[hubDTag]?.[messageId]) || []
  const [showZapList, setShowZapList] = useState(false)

  // Filter out zaps from banned users (mod-banned + creator-banned)
  const modBanLists = useHubStore((s) => s.modBanLists[hubDTag])
  const hubBanList = useHubStore((s) => s.hubBanLists[hubDTag])
  const hubMembers = useHubStore((s) => s.hubMembers[hubDTag])
  const zaps = useMemo(() => {
    const bannedSet = new Set<string>()
    const whitelisted = new Set(
      (hubMembers || []).filter(m => m.flags?.includes('w')).map(m => m.pubkey)
    )
    if (modBanLists) {
      for (const pks of Object.values(modBanLists)) {
        for (const pk of pks) {
          if (!whitelisted.has(pk)) bannedSet.add(pk)
        }
      }
    }
    if (hubBanList) {
      for (const pk of hubBanList) bannedSet.add(pk)
    }
    if (bannedSet.size === 0) return rawZaps
    return rawZaps.filter(z => !bannedSet.has(z.senderPubkey))
  }, [rawZaps, modBanLists, hubBanList, hubMembers])

  if (zaps.length === 0) return null

  const totalSats = zaps.reduce((sum: number, z: ZapInfo) => sum + z.amount, 0)

  return (
    <>
      <button
        onClick={() => setShowZapList(true)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs cursor-pointer transition-colors border bg-yellow-400/10 border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/20"
      >
        <Zap size={12} fill="currentColor" />
        <span className="font-semibold">{formatSats(totalSats)}</span>
        {zaps.length > 1 && (
          <span className="text-yellow-400/60">({zaps.length})</span>
        )}
      </button>
      {showZapList && (
        <ZapListModal
          open={showZapList}
          onClose={() => setShowZapList(false)}
          zaps={zaps}
          onOpenProfile={onOpenProfile}
        />
      )}
    </>
  )
}
