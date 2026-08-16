/**
 * PostThread — Thread view showing a post, its replies, and its quote-reposts
 * (split into tabs).
 */

import { useState, useEffect, useMemo } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { fetchEventsWide } from '@/lib/nostr/readRelays'
import { SocialPost } from '@/components/social/SocialPost'
import { ComposeBox } from '@/components/social/ComposeBox'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Event } from 'nostr-tools'

/**
 * Is `ev` a quote-repost OF the root post (id `rootId`) — as opposed to a reply?
 * A quote-repost references the root via a NIP-18 `q` tag, or an old-style
 * `mention`-marked `e` tag, and does NOT reply-tag the root. A reply that merely
 * quotes some *other* post is still a reply and stays in the replies list.
 */
function isQuoteOfRoot(ev: Event, rootId: string): boolean {
  if (ev.tags.some((t) => t[0] === 'q' && t[1] === rootId)) return true
  const eToRoot = ev.tags.filter((t) => t[0] === 'e' && t[1] === rootId)
  if (eToRoot.length === 0) return false
  const hasReplyMarker = eToRoot.some((t) => t[3] === 'root' || t[3] === 'reply')
  const hasMentionMarker = eToRoot.some((t) => t[3] === 'mention')
  return hasMentionMarker && !hasReplyMarker
}

export function PostThread() {
  const activeThreadId = useSocialStore((s) => s.activeThreadId)
  const posts = useSocialStore((s) => s.posts)
  const goBack = useSocialStore((s) => s.goBack)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)
  const setActiveThread = useSocialStore((s) => s.setActiveThread)

  const [rootEvent, setRootEvent] = useState<Event | null>(null)
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'replies' | 'quotes'>('replies')

  useEffect(() => {
    if (!activeThreadId) return

    setLoading(true)
    setEvents([])
    setTab('replies')

    const found = posts.find((p) => p.id === activeThreadId)
    if (found) setRootEvent(found)

    const loadEngagement = () =>
      Promise.all([
        // Replies reference the root via an `e` tag…
        fetchEventsWide({ kinds: [1], '#e': [activeThreadId], limit: 50 }),
        // …while NIP-18 quote-reposts reference it via a `q` tag (often no `e` tag).
        fetchEventsWide({ kinds: [1], '#q': [activeThreadId], limit: 50 }),
      ]).then(([eTagged, qTagged]) => {
        const byId = new Map<string, Event>()
        for (const ev of [...eTagged, ...qTagged]) byId.set(ev.id, ev)
        return [...byId.values()].sort((a, b) => a.created_at - b.created_at)
      })

    Promise.all([
      !found ? fetchEventsWide({ ids: [activeThreadId], limit: 1 }) : Promise.resolve([]),
      loadEngagement(),
    ]).then(([rootEvents, engagement]) => {
      if (!found && rootEvents.length > 0) {
        setRootEvent(rootEvents[0])
      }
      setEvents(engagement)
      setLoading(false)
    })
  }, [activeThreadId, posts])

  const { replies, quoteReposts } = useMemo(() => {
    if (!activeThreadId) return { replies: [] as Event[], quoteReposts: [] as Event[] }
    const q: Event[] = []
    const r: Event[] = []
    for (const ev of events) {
      if (isQuoteOfRoot(ev, activeThreadId)) q.push(ev)
      else r.push(ev)
    }
    return { replies: r, quoteReposts: q }
  }, [events, activeThreadId])

  const list = tab === 'replies' ? replies : quoteReposts

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-12 min-h-12 border-b border-border shrink-0">
        <button onClick={goBack} className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
          <ArrowLeft size={18} />
        </button>
        <span className="font-semibold text-sm text-foreground">Thread</span>
      </div>

      {/* Scrollable thread content */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full mx-auto p-4 max-[1080px]:pb-12 flex flex-col gap-3" style={{ maxWidth: 640 }}>
          {rootEvent && (
            <>
              <div className="bg-secondary/30 rounded-lg overflow-hidden">
                <SocialPost
                  event={rootEvent}
                  onOpenProfile={setActiveProfile}
                  onOpenThread={setActiveThread}
                />
              </div>
              {/* Reply composer — separate card */}
              <ComposeBox
                replyTo={{ id: rootEvent.id, pubkey: rootEvent.pubkey }}
                placeholder="Post your reply..."
                onPosted={() => {
                  Promise.all([
                    fetchEventsWide({ kinds: [1], '#e': [activeThreadId!], limit: 50 }),
                    fetchEventsWide({ kinds: [1], '#q': [activeThreadId!], limit: 50 }),
                  ]).then(([eTagged, qTagged]) => {
                    const byId = new Map<string, Event>()
                    for (const ev of [...eTagged, ...qTagged]) byId.set(ev.id, ev)
                    setEvents([...byId.values()].sort((a, b) => a.created_at - b.created_at))
                  })
                }}
              />
            </>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {(replies.length > 0 || quoteReposts.length > 0) && (
                <div className="flex items-center gap-2 px-1 py-1">
                  <TabButton
                    active={tab === 'replies'}
                    onClick={() => setTab('replies')}
                    label={`${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
                  />
                  <TabButton
                    active={tab === 'quotes'}
                    onClick={() => setTab('quotes')}
                    label={`${quoteReposts.length} ${quoteReposts.length === 1 ? 'quote-repost' : 'quote-reposts'}`}
                  />
                </div>
              )}

              {list.map((ev) => (
                <div key={ev.id} className="bg-secondary/30 rounded-lg overflow-hidden">
                  <SocialPost
                    event={ev}
                    onOpenProfile={setActiveProfile}
                    onOpenThread={setActiveThread}
                    compact
                  />
                </div>
              ))}

              {!loading && (replies.length > 0 || quoteReposts.length > 0) && list.length === 0 && (
                <div className="px-1 py-4 text-xs text-muted-foreground">
                  {tab === 'quotes' ? 'No quote-reposts yet.' : 'No replies yet.'}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'text-xs font-medium px-2.5 py-1 rounded-md transition-colors cursor-pointer',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50',
      )}
    >
      {label}
    </button>
  )
}
