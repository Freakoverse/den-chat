/**
 * PostThread — Thread view showing a post and its replies
 */

import { useState, useEffect } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { SocialPost } from '@/components/social/SocialPost'
import { ComposeBox } from '@/components/social/ComposeBox'
import { ArrowLeft, Loader2 } from 'lucide-react'
import type { Event } from 'nostr-tools'

export function PostThread() {
  const activeThreadId = useSocialStore((s) => s.activeThreadId)
  const posts = useSocialStore((s) => s.posts)
  const goBack = useSocialStore((s) => s.goBack)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)
  const setActiveThread = useSocialStore((s) => s.setActiveThread)

  const [rootEvent, setRootEvent] = useState<Event | null>(null)
  const [replies, setReplies] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!activeThreadId) return

    setLoading(true)
    setReplies([])

    const found = posts.find((p) => p.id === activeThreadId)
    if (found) setRootEvent(found)

    Promise.all([
      !found ? fetchEvents({ ids: [activeThreadId], limit: 1 }) : Promise.resolve([]),
      fetchEvents({ kinds: [1], '#e': [activeThreadId], limit: 50 }),
    ]).then(([rootEvents, replyEvents]) => {
      if (!found && rootEvents.length > 0) {
        setRootEvent(rootEvents[0])
      }
      setReplies(replyEvents.sort((a, b) => a.created_at - b.created_at))
      setLoading(false)
    })
  }, [activeThreadId, posts])

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
                  fetchEvents({ kinds: [1], '#e': [activeThreadId!], limit: 50 }).then((events) => {
                    setReplies(events.sort((a, b) => a.created_at - b.created_at))
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
              {replies.length > 0 && (
                <div className="px-1 py-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                  </span>
                </div>
              )}
              {replies.map((reply) => (
                <div key={reply.id} className="bg-secondary/30 rounded-lg overflow-hidden">
                  <SocialPost
                    event={reply}
                    onOpenProfile={setActiveProfile}
                    onOpenThread={setActiveThread}
                    compact
                  />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
