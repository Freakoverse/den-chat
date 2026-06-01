/**
 * HubInfoModal — Public hub info display
 *
 * Shows banner, icon, name, description, tags, and creator card.
 * Opened by clicking the hub name in the channel list banner.
 */

import { useState, useEffect } from 'react'
import { X, Copy, Check, Tag } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { BlossomImage } from '@/components/ui/BlossomImage'
import type { HubData } from '@/stores/hubStore'
import { truncateNpub } from '@/lib/utils'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { nip19 } from 'nostr-tools'

interface HubInfoModalProps {
  open: boolean
  onClose: () => void
  hub: HubData
  /** When true, banner & icon images are heavily blurred (used on Discover page for safety) */
  blurMedia?: boolean
  /** Called when the user clicks the creator's avatar or name */
  onCreatorClick?: (pubkey: string) => void
}

interface CreatorProfile {
  name?: string
  picture?: string
  about?: string
  npub: string
}

export function HubInfoModal({ open, onClose, hub, blurMedia, onCreatorClick }: HubInfoModalProps) {
  const [creator, setCreator] = useState<CreatorProfile | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open || !hub.creatorPubkey) return
    let cancelled = false

    const npub = nip19.npubEncode(hub.creatorPubkey)

    // Fetch kind:0 metadata for the creator
    fetchEvents({ kinds: [0], authors: [hub.creatorPubkey], limit: 1 })
      .then((events) => {
        if (cancelled) return
        if (events.length > 0) {
          try {
            const meta = JSON.parse(events[0].content)
            setCreator({
              name: meta.name || meta.display_name,
              picture: meta.picture,
              about: meta.about,
              npub,
            })
          } catch {
            setCreator({ npub })
          }
        } else {
          setCreator({ npub })
        }
      })
      .catch(() => {
        if (!cancelled) setCreator({ npub })
      })

    return () => { cancelled = true }
  }, [open, hub.creatorPubkey])

  const copyNpub = () => {
    if (!creator) return
    navigator.clipboard.writeText(creator.npub)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2">
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />

      <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-background shadow-lg animate-in fade-in-0 zoom-in-95 overflow-hidden">
        {/* Banner */}
        {hub.banner ? (
          <div className="h-32 w-full">
            <BlossomImage src={hub.banner} alt="" className={`w-full h-full object-cover${blurMedia ? ' blur-lg' : ''}`} fallback={
              <div className="w-full h-full bg-gradient-to-br from-primary/30 to-primary/10" />
            } />
          </div>
        ) : (
          <div className="h-20 w-full bg-gradient-to-br from-primary/30 to-primary/10" />
        )}

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 cursor-pointer z-10"
        >
          <X size={14} />
        </button>

        {/* Icon overlapping banner/content boundary */}
        <div className="px-5 -mt-10 relative">
          <div className="w-20 h-20 rounded-2xl bg-secondary border-4 border-background overflow-hidden">
            {hub.icon ? (
              <BlossomImage src={hub.icon} alt={hub.name} className={`w-full h-full object-cover${blurMedia ? ' blur-sm' : ''}`} fallback={
                <div className="w-full h-full flex items-center justify-center text-xl font-bold text-muted-foreground">
                  {hub.name.slice(0, 2).toUpperCase()}
                </div>
              } />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xl font-bold text-muted-foreground">
                {hub.name.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="px-5 pb-5 pt-3 flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-bold text-foreground">{hub.name}</h2>
            {hub.description && (
              <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{hub.description}</p>
            )}
          </div>

          {/* Tags */}
          {hub.tags && hub.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {hub.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                  <Tag size={10} />
                  {tag}
                </span>
              ))}
            </div>
          )}

          <Separator />

          {/* Creator card */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 block">Created by</label>
            {creator ? (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50 border border-border/50">
                {/* Clickable avatar */}
                {onCreatorClick && hub.creatorPubkey ? (
                  <button onClick={() => onCreatorClick(hub.creatorPubkey)} className="cursor-pointer shrink-0">
                    <Avatar className="h-10 w-10">
                      {creator.picture && <AvatarImage src={creator.picture} />}
                      <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                        {(creator.name || 'U').slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                ) : (
                  <Avatar className="h-10 w-10 shrink-0">
                    {creator.picture && <AvatarImage src={creator.picture} />}
                    <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                      {(creator.name || 'U').slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                )}
                <div className="flex-1 min-w-0">
                  {onCreatorClick && hub.creatorPubkey ? (
                    <button
                      onClick={() => onCreatorClick(hub.creatorPubkey)}
                      className="text-sm font-medium text-foreground truncate hover:underline cursor-pointer text-left block max-w-full"
                    >
                      {creator.name || 'Unknown'}
                    </button>
                  ) : (
                    <div className="text-sm font-medium text-foreground truncate">
                      {creator.name || 'Unknown'}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground truncate font-mono">
                    {truncateNpub(creator.npub)}
                  </div>
                </div>
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={copyNpub}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer shrink-0"
                      >
                        {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">Copy npub</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            ) : (
              <div className="h-16 rounded-lg bg-secondary animate-pulse" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
