/**
 * LongFormDraftsPage — Show user's kind:30024 drafts
 */

import { useState, useEffect, useCallback } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useUserStore } from '@/stores/userStore'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { Loader2, FileText, RefreshCw, Pencil, Trash2, Eye } from 'lucide-react'
import { formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'

interface Draft {
  event: Event; dTag: string; title: string; summary: string; wordCount: number; updatedAt: number
}

function parseDraft(ev: Event): Draft {
  const t = ev.tags
  return {
    event: ev, dTag: t.find(x => x[0] === 'd')?.[1] || '',
    title: t.find(x => x[0] === 'title')?.[1] || 'Untitled Draft',
    summary: t.find(x => x[0] === 'summary')?.[1] || '',
    wordCount: ev.content.split(/\s+/).filter(Boolean).length,
    updatedAt: ev.created_at,
  }
}

export function LongFormDraftsPage() {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const setEditingArticle = useSocialStore((s) => s.setEditingArticle)
  const setPreviewDraft = useSocialStore((s) => s.setPreviewDraft)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!pubkey) return
    setLoading(true)
    try {
      const events = await fetchEvents({ kinds: [30024], authors: [pubkey], limit: 50 })
      const coordMap = new Map<string, Event>()
      for (const ev of events) {
        const d = ev.tags.find(t => t[0] === 'd')?.[1] || ''
        const existing = coordMap.get(d)
        if (!existing || ev.created_at > existing.created_at) coordMap.set(d, ev)
      }
      const parsed = Array.from(coordMap.values()).map(parseDraft)
      parsed.sort((a, b) => b.updatedAt - a.updatedAt)
      setDrafts(parsed)
    } catch (err) { console.error('[LongForm] Failed to load drafts:', err) }
    finally { setLoading(false) }
  }, [pubkey])

  useEffect(() => { load() }, [load])

  const handlePreview = (d: Draft) => {
    try {
      const naddr = nip19.naddrEncode({ kind: 30024, pubkey: d.event.pubkey, identifier: d.dTag })
      setPreviewDraft(naddr)
    } catch { /* fallback */ }
  }

  const handleEdit = (d: Draft) => {
    try {
      // Drafts use kind:30024 but we edit them and can promote to 30023
      const naddr = nip19.naddrEncode({ kind: 30024, pubkey: d.event.pubkey, identifier: d.dTag })
      setEditingArticle(naddr)
    } catch { /* fallback */ }
  }

  const handleDelete = useCallback(async (d: Draft) => {
    if (!pubkey) return
    setDeleting(d.dTag)
    try {
      const { signWithSigner } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getDeletePublishRelays } = await import('@/stores/postingBehaviourStore')
      const aRef = `30024:${pubkey}:${d.dTag}`
      const unsigned = { kind: 5, pubkey, created_at: Math.floor(Date.now() / 1000), tags: [['a', aRef]], content: 'delete draft' }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getDeletePublishRelays(), signed)
      setDrafts(prev => prev.filter(x => x.dTag !== d.dTag))
    } catch (err) { console.error('[LongForm] Delete draft failed:', err) }
    finally { setDeleting(null) }
  }, [pubkey, signer, privateKey])

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
      <div className="flex items-center justify-between px-4 h-12 min-h-12 border-b border-border shrink-0">
        <span className="font-semibold text-sm text-foreground">Drafts</span>
        <button onClick={load} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"><RefreshCw size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="w-full mx-auto py-4 px-4 max-[1080px]:px-2 max-[1080px]:pb-12" style={{ maxWidth: 720 }}>
          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
          ) : drafts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-4">
              <FileText size={32} className="text-muted-foreground/40" />
              <h3 className="text-sm font-semibold text-foreground">No drafts</h3>
              <p className="text-xs text-muted-foreground">Saved drafts will appear here.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {drafts.map(d => (
                <div key={d.dTag} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-accent/20 transition-colors group">
                  <FileText size={18} className="text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-foreground line-clamp-1">{d.title}</span>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                      <span>{formatTimestamp(d.updatedAt)}</span>
                      <span>·</span>
                      <span>{d.wordCount} words</span>
                    </div>
                  </div>
                  <button onClick={() => handlePreview(d)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><Eye size={14} /></button>
                  <button onClick={() => handleEdit(d)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><Pencil size={14} /></button>
                  <button onClick={() => handleDelete(d)} disabled={deleting === d.dTag}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 disabled:opacity-50">
                    {deleting === d.dTag ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
