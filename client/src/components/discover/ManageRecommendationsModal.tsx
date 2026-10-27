/**
 * ManageRecommendationsModal — edit the user's own public hub-recommendation list (kind 30078,
 * see lib/hub/hubRecommendations). Followers see these hubs in their Discover when "Following
 * recommendations" is on. Pick from your own hubs or add any discoverable hub by address; changes
 * stay in a local draft until Publish.
 *
 * Lives in its own module (not DiscoverPage) so both Discover and the profile modal's Hubs tab can
 * open the SAME popup without a DiscoverPage <-> UserProfileModal import cycle.
 */

import { useEffect, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { X, Loader2 } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useUserStore } from '@/stores/userStore'
import { useRecommendationStore } from '@/stores/recommendationStore'
import { useHubStore } from '@/stores/hubStore'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { nowSeconds } from '@/lib/time/clockOffset'
import { truncateNpub } from '@/lib/utils'
import { hubCoord, parseHubAddress, type HubRecRef } from '@/lib/hub/hubRecommendations'
import { BannerImage, IconImage } from '@/components/discover/hubCardImages'

export function ManageRecommendationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const myRecs = useRecommendationStore((s) => s.myRecs)
  const saveRecs = useRecommendationStore((s) => s.saveRecs)
  const hubEntries = useHubStore((s) => s.hubEntries)
  const hubsData = useHubStore((s) => s.hubs)
  const hubStatus = useHubStore((s) => s.hubStatus)
  const [addr, setAddr] = useState('')
  const [addErr, setAddErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false) // resolving an add-by-address
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // Local draft: edits stay here until the user hits Publish. Seeded from the published list on open.
  const [draft, setDraft] = useState<Map<string, HubRecRef>>(new Map())
  useEffect(() => {
    if (open) { setDraft(new Map(useRecommendationStore.getState().myRecs)); setSaveErr(null); setAddErr(null); setAddr('') }
  }, [open])
  useEscToClose(onClose, open)
  if (!open) return null

  // Only hubs actually present in the list: skip deleted / not-found / still-fetching entries so the
  // picker matches the sidebar (a created-then-deleted test hub shouldn't resurface here). Also skip
  // hubs with discovery turned off (f=off): recommending one would leak a hub its owner opted out of
  // listing, and followers' Discover filters it out anyway.
  const myHubs = hubEntries
    .filter((e) => hubStatus[e.dTag] === 'loaded')
    .map((e) => hubsData[e.dTag])
    .filter((h) => !!h && !!h.creatorPubkey && h.discoverable !== false)
    .map((h) => ({ dTag: h.dTag, name: h.name, icon: h.icon, banner: h.banner, creatorPubkey: h.creatorPubkey, relayHint: h.generalRelays?.[0], coord: hubCoord(h.creatorPubkey, h.dTag) }))
  const myHubCoords = new Set(myHubs.map((h) => h.coord))
  const external = [...draft.values()].filter((r) => !myHubCoords.has(r.coord))
  // Dirty = the draft differs from the published list (covers both "first list" and "edited existing").
  const dirty = draft.size !== myRecs.size || [...draft.keys()].some((k) => !myRecs.has(k))

  const addToDraft = (ref: HubRecRef) => setDraft((prev) => { const n = new Map(prev); n.set(ref.coord, ref); return n })
  const removeFromDraft = (coord: string) => setDraft((prev) => { const n = new Map(prev); n.delete(coord); return n })
  const toggle = (ref: HubRecRef) => setDraft((prev) => {
    const n = new Map(prev)
    if (n.has(ref.coord)) n.delete(ref.coord); else n.set(ref.coord, ref)
    return n
  })

  const doAdd = async () => {
    setAddErr(null); setBusy(true)
    try {
      const ref = await parseHubAddress(addr)
      if (!ref) { setAddErr('Not a valid hub address (npub/naddr, a 36942:... coordinate, or a share link).'); return }
      // Only recommend hubs their owner has opted into listing (f != off). Fetch the hub event and
      // check before adding, so you can't vouch for a hub that chose not to be discoverable.
      const events = await fetchEvents({ kinds: [KINDS.HUB_EVENT], authors: [ref.pubkey], '#d': [ref.dTag] })
      const maxCreatedAt = nowSeconds() + 3600
      let newestEv: { created_at: number; tags: string[][] } | null = null
      for (const ev of events) {
        if (ev.created_at > maxCreatedAt) continue
        if (!newestEv || ev.created_at > newestEv.created_at) newestEv = ev
      }
      if (!newestEv) { setAddErr('Could not find that hub on the network.'); return }
      const isDeleted = newestEv.tags.some((t) => t[0] === 'deleted' && t[1] === 'true')
      const fTag = newestEv.tags.find((t) => t[0] === 'f')
      const discoverable = fTag ? fTag[1] !== 'off' : true
      if (isDeleted) { setAddErr('Could not find that hub on the network.'); return }
      if (!discoverable) { setAddErr('That hub has discovery turned off, so it cannot be recommended.'); return }
      addToDraft(ref)
      setAddr('')
    } catch (e) { setAddErr(e instanceof Error ? e.message : 'Failed to add') }
    finally { setBusy(false) }
  }

  const doPublish = async () => {
    if (!dirty || saving) return
    setSaving(true); setSaveErr(null)
    try {
      await saveRecs([...draft.values()], signer, privateKey)
      onClose()
    } catch (e) { setSaveErr(e instanceof Error ? e.message : 'Failed to publish') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-2">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md max-h-[85vh] flex flex-col rounded-xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="font-semibold text-foreground">Manage recommendations</h2>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">People who follow you see the hubs you recommend in their Discover (with <span className="font-medium text-foreground">Following recommendations</span> on). Only discoverable hubs are shown. Changes publish when you hit <span className="font-medium text-foreground">Publish</span>.</p>
          <div>
            <label className="text-xs font-medium text-foreground">Add by address</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                value={addr}
                onChange={(e) => { setAddr(e.target.value); setAddErr(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') doAdd() }}
                placeholder="npub/naddr, 36942:..., or a hub share link"
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-secondary/60 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
              <button onClick={doAdd} disabled={!addr.trim() || busy} className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-40 cursor-pointer shrink-0">
                {busy ? <Loader2 size={13} className="animate-spin" /> : 'Add'}
              </button>
            </div>
            {addErr && <p className="text-[11px] text-destructive mt-1">{addErr}</p>}
          </div>
          {myHubs.length > 0 && (
            <div>
              <label className="text-xs font-medium text-foreground">From your hubs</label>
              <p className="text-[11px] text-muted-foreground mt-0.5">Every hub in your list. Tap <span className="text-emerald-400">Recommend</span> to add one.</p>
              <div className="mt-1 space-y-1">
                {myHubs.map((h) => {
                  const on = draft.has(h.coord)
                  return (
                    <div key={h.coord} className="relative flex items-center gap-2.5 p-1.5 rounded-lg border border-border overflow-hidden">
                      {h.banner && (
                        <div className="absolute inset-0 opacity-25 pointer-events-none">
                          <BannerImage src={h.banner} alt="" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-r from-background/75 via-background/85 to-background/95 pointer-events-none" />
                      <div className="relative w-9 h-9 rounded-md overflow-hidden shrink-0 bg-secondary">
                        {h.icon ? (
                          <IconImage src={h.icon} name={h.name || h.dTag} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-xs font-semibold text-primary bg-primary/20">
                            {(h.name || h.dTag).slice(0, 2).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <span className="relative flex-1 min-w-0 text-sm font-medium text-foreground truncate">{h.name || h.dTag.slice(0, 8)}</span>
                      <button
                        onClick={() => toggle({ coord: h.coord, pubkey: h.creatorPubkey, dTag: h.dTag, relayHint: h.relayHint })}
                        className={`relative px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer shrink-0 ${on ? 'bg-emerald-500/15 text-emerald-400' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
                      >
                        {on ? 'Recommended' : 'Recommend'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {external.length > 0 && (
            <div>
              <label className="text-xs font-medium text-foreground">Added by address</label>
              <div className="mt-1 space-y-1">
                {external.map((r) => (
                  <div key={r.coord} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/40">
                    <span className="text-xs text-muted-foreground font-mono truncate">{r.dTag.slice(0, 8)} / {truncateNpub(nip19.npubEncode(r.pubkey), 10)}</span>
                    <button onClick={() => removeFromDraft(r.coord)} className="px-2 py-0.5 rounded text-[11px] font-medium bg-secondary text-muted-foreground hover:text-destructive cursor-pointer shrink-0">Remove</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {draft.size === 0 && myHubs.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">You haven't recommended any hubs yet.</p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border shrink-0">
          {saveErr && <p className="text-[11px] text-destructive mb-2">{saveErr}</p>}
          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 cursor-pointer">Cancel</button>
            <button
              onClick={doPublish}
              disabled={!dirty || saving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : 'Publish'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
