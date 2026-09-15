/**
 * ShortAddressCard — renders a NIP-SHORT address (`snpub1…f3c49d`, `snabandondeliveraf3c49d`) as
 * the card of the event it resolves to. Resolution is one author-scoped `#s` query plus mandatory
 * recomputation of the code and signature check (see lib/nostr/nipShort). The resolved event is
 * primed into the kind-specific card's cache so that card renders instantly instead of refetching.
 */
import { Loader2, Copy, Check } from 'lucide-react'
import { useState } from 'react'
import type { Event } from 'nostr-tools'
import { useCachedFetch, primeCachedFetch } from '@/hooks/useCachedFetch'
import { resolveShortAddress, parseShortAddress, isDnnAuthority, type ShortResolution } from '@/lib/nostr/nipShort'
import { NoteCard, CommentCard, LongFormCard, LiveActivityCard, GameModCard } from '@/components/nostr/NostrCards'
import { HubEventCard } from '@/components/hub/HubEventCard'
import { HubMessageCard } from '@/components/hub/HubMessageCard'
import { CalendarTimeEventCard } from '@/components/hub/CalendarTimeEventCard'
import { parseModEvent, MOD_KIND } from '@/lib/mods/modEvent'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

export function ShortAddressCard({ address, href, disableHubInviteCards }: {
  address: string
  /** Set when the address came from inside a link — the game-mod card then opens that link. */
  href?: string
  disableHubInviteCards?: boolean
}) {
  const { data, loading } = useCachedFetch<ShortResolution>(`short:${address}`, async () => {
    const res = await resolveShortAddress(address)
    // Misses aren't cached (null) so a later mount can retry once relays / DNN come back.
    return res.status === 'not-found' ? null : res
  })

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Resolving short address...
      </div>
    )
  }

  if (!data || data.status === 'not-found' || data.status === 'bad-address') {
    const parsed = parseShortAddress(address)
    // A DNN-authority token is what the text scanner can mistake an ordinary word for (anything
    // "sn…" ending in six hex-looking letters). When it doesn't resolve, give the text back rather
    // than stamping a "not found" badge on what may just be a word.
    if (parsed && isDnnAuthority(parsed.authority)) return <span>{address}</span>
    return <ShortFallback label="Short address not found" address={address} />
  }

  if (data.status === 'ambiguous') {
    return (
      <div className="my-2 max-w-[350px]">
        <p className="text-[10px] text-muted-foreground mb-1">
          This short address matches {data.candidates.length} events by the same author:
        </p>
        {data.candidates.map((ev) => <ResolvedEventCard key={ev.id} event={ev} href={href} disableHubInviteCards={disableHubInviteCards} />)}
      </div>
    )
  }

  return <ResolvedEventCard event={data.event} href={href} disableHubInviteCards={disableHubInviteCards} />
}

/** Route a resolved event to the card we already have for its kind, priming that card's cache first. */
function ResolvedEventCard({ event, href, disableHubInviteCards }: { event: Event; href?: string; disableHubInviteCards?: boolean }) {
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  switch (event.kind) {
    case 1:
      primeCachedFetch(`e:${event.id}`, event)
      return <NoteCard eventId={event.id} />
    case 1111:
      primeCachedFetch(`e:${event.id}`, event)
      return <CommentCard eventId={event.id} />
    case 30023:
      primeCachedFetch(`30023:${event.pubkey}:${d}`, event)
      return <LongFormCard identifier={d} pubkey={event.pubkey} />
    case 30311:
      primeCachedFetch(`30311:${event.pubkey}:${d}`, event)
      return <LiveActivityCard identifier={d} pubkey={event.pubkey} />
    case MOD_KIND: {
      const mod = parseModEvent(event)
      if (!mod.isDeleted) primeCachedFetch(`31142:${event.pubkey}:${d}|`, { mod, event })
      return <GameModCard identifier={d} pubkey={event.pubkey} openUrl={href} />
    }
    case 36942:
      if (disableHubInviteCards) return <ShortFallback label="Hub invite" address={`s…${event.tags.find((t) => t[0] === 's')?.[1] ?? ''}`} />
      return <HubEventCard identifier={d} pubkey={event.pubkey} />
    case 36943:
      return <HubMessageCard identifier={d} pubkey={event.pubkey} />
    case 31923:
      return <CalendarTimeEventCard identifier={d} pubkey={event.pubkey} />
    default:
      return <ShortFallback label={`Rendering of kind ${event.kind} not supported`} address={address(event)} />
  }
}

function address(event: Event): string {
  const code = event.tags.find((t) => t[0] === 's')?.[1] ?? ''
  return `s…${code}`
}

function ShortFallback({ label, address }: { label: string; address: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex items-center gap-1.5 my-1 px-2 py-1 rounded-md border border-border text-xs text-muted-foreground">
      {label}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation()
                navigator.clipboard.writeText(address)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              {copied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Copy address</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  )
}
