/**
 * ZapListModal — Shows who zapped a message
 *
 * Displays a list of all zap receipts for a given message,
 * showing sender, amount, and zap comment.
 */

import { useMemo } from 'react'
import { X, Zap } from 'lucide-react'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { formatSats, type ZapInfo } from '@/lib/nostr/zap'

interface ZapListModalProps {
  open: boolean
  onClose: () => void
  zaps: ZapInfo[]
  onOpenProfile?: (pubkey: string) => void
}

export function ZapListModal({ open, onClose, zaps, onOpenProfile }: ZapListModalProps) {
  const { getProfile } = useProfileCache()

  const sorted = useMemo(
    () => [...zaps].sort((a, b) => b.amount - a.amount),
    [zaps]
  )

  const totalSats = useMemo(
    () => zaps.reduce((sum, z) => sum + z.amount, 0),
    [zaps]
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-yellow-400" />
            <h3 className="text-sm font-semibold text-foreground">
              Zaps ({zaps.length})
            </h3>
            <span className="text-xs text-yellow-400 font-medium">
              ⚡ {formatSats(totalSats)} sats
            </span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Zap size={24} className="text-muted-foreground/30 mb-2" />
              <span className="text-sm">No zaps yet</span>
            </div>
          ) : (
            sorted.map((zap) => {
              const senderProfile = getProfile(zap.senderPubkey)
              const senderName = senderProfile?.display_name || senderProfile?.name || truncateNpub(nip19.npubEncode(zap.senderPubkey))

              return (
                <div
                  key={zap.receiptId}
                  className="flex items-start gap-3 px-5 py-3 border-b border-border/50 hover:bg-accent/20 transition-colors cursor-pointer"
                  onClick={() => onOpenProfile?.(zap.senderPubkey)}
                >
                  {/* Amount badge */}
                  <div className="flex flex-col items-center gap-0.5 shrink-0 mt-0.5 min-w-[40px]">
                    <Zap size={14} className="text-yellow-400" />
                    <span className="text-xs font-bold text-yellow-400">{formatSats(zap.amount)}</span>
                  </div>

                  {/* Sender info */}
                  <Avatar className="w-8 h-8 shrink-0 mt-0.5">
                    {senderProfile?.picture && <AvatarImage src={senderProfile.picture} />}
                    <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                      {senderName.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-foreground truncate">{senderName}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {formatTimestamp(zap.createdAt)}
                      </span>
                    </div>
                    {zap.message && (
                      <p className="text-xs text-muted-foreground mt-0.5 break-words line-clamp-3">{zap.message}</p>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

function formatTimestamp(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - unixSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}
