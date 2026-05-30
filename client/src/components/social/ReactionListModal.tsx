/**
 * ReactionListModal — Shows who reacted on a post and with what emoji
 */

import { useMemo } from 'react'
import { X, Smile } from 'lucide-react'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { getEmojiMap } from '@/stores/emojiStore'

export interface ReactionInfo {
  eventId: string
  pubkey: string
  emoji: string        // the raw emoji content (could be ':shortcode:' or unicode or '+')
  emojiUrl?: string    // resolved URL for custom emojis
  createdAt: number
}

interface ReactionListModalProps {
  open: boolean
  onClose: () => void
  reactions: ReactionInfo[]
  onOpenProfile?: (pubkey: string) => void
}

export function ReactionListModal({ open, onClose, reactions, onOpenProfile }: ReactionListModalProps) {
  const { getProfile } = useProfileCache()

  const sorted = useMemo(
    () => [...reactions].sort((a, b) => b.createdAt - a.createdAt),
    [reactions]
  )

  // Group by emoji for summary
  const emojiGroups = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of reactions) {
      const key = r.emoji === '+' ? '❤️' : r.emoji
      map.set(key, (map.get(key) || 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [reactions])

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
            <Smile size={16} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              Reactions ({reactions.length})
            </h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Emoji summary bar */}
        {emojiGroups.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-5 py-3 border-b border-border/50">
            {emojiGroups.map(([emoji, count]) => (
              <span
                key={emoji}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent/40 border border-border/50"
              >
                <ResolvedEmoji emoji={emoji} size={14} />
                <span className="text-muted-foreground font-medium">{count}</span>
              </span>
            ))}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Smile size={24} className="text-muted-foreground/30 mb-2" />
              <span className="text-sm">No reactions yet</span>
            </div>
          ) : (
            sorted.map((reaction) => {
              const profile = getProfile(reaction.pubkey)
              const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(reaction.pubkey))
              const displayEmoji = reaction.emoji === '+' ? '❤️' : reaction.emoji

              return (
                <div
                  key={reaction.eventId}
                  className="flex items-center gap-3 px-5 py-2.5 border-b border-border/50 hover:bg-accent/20 transition-colors cursor-pointer"
                  onClick={() => onOpenProfile?.(reaction.pubkey)}
                >
                  {/* Emoji */}
                  <div className="w-8 flex items-center justify-center shrink-0">
                    <ResolvedEmoji emoji={displayEmoji} url={reaction.emojiUrl} size={20} />
                  </div>

                  {/* Avatar */}
                  <Avatar className="w-7 h-7 shrink-0">
                    {profile?.picture && <AvatarImage src={profile.picture} />}
                    <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                      {name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  {/* Name */}
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-foreground truncate block">{name}</span>
                  </div>

                  {/* Timestamp */}
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatTimestamp(reaction.createdAt)}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

/** Renders an emoji — resolves custom shortcodes from the emoji map */
function ResolvedEmoji({ emoji, url, size = 16 }: { emoji: string; url?: string; size?: number }) {
  // If a direct URL was provided (from emoji tag)
  if (url) {
    return <img src={url} alt={emoji} className="object-contain inline" style={{ width: size, height: size }} />
  }

  // Check for custom emoji shortcode pattern :name:
  const scMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/)
  if (scMatch) {
    const entry = getEmojiMap().get(scMatch[1])
    if (entry) {
      return <img src={entry.url} alt={emoji} className="object-contain inline" style={{ width: size, height: size }} />
    }
  }

  // Unicode emoji or fallback
  return <span style={{ fontSize: size }} className="leading-none">{emoji}</span>
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
