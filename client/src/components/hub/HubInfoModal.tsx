/**
 * HubInfoModal — Public hub info display
 *
 * Shows banner, icon, name, description, tags, and creator card.
 * Opened by clicking the hub name in the channel list banner.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Copy, Check, Tag, MoreVertical, Code, Link2, Radio, Loader2, Archive, AlertTriangle, RefreshCw, Database, ChevronDown } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { RawEventModal } from '@/components/social/SocialPost'
import { useHubStore, type HubData } from '@/stores/hubStore'
import { truncateNpub } from '@/lib/utils'
import { fetchEvents, fetchReplaceable } from '@/lib/nostr/relay-pool'
import { checkEventAvailability, type RelayAvailability } from '@/lib/nostr/eventRedundancy'
import { checkBlossomFileAvailability, directUploadHubFiles, type BlossomFileAvailability } from '@/lib/blossom/blossomRedundancy'
import { useUserStore } from '@/stores/userStore'
import { getHubEvent, putHubEvent } from '@/lib/cache/hubEventCache'
import { buildHubBackup, fmtBytes } from '@/lib/hub/hubBackup'
import { KINDS } from '@/lib/crypto/constants'
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

  // ── 3-dot menu / actions ──
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [addressCopied, setAddressCopied] = useState(false)
  const [rawJson, setRawJson] = useState<string | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [showAvailability, setShowAvailability] = useState(false)
  const [showBlossomAvailability, setShowBlossomAvailability] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupProgress, setBackupProgress] = useState<{ done: number; total: number; bytes: number } | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)

  // ── Hub version (event created_at) — lets members compare what they're seeing ──
  const retryHub = useHubStore((s) => s.retryHub)
  // Read the version live from the store so it updates after "Fetch latest".
  const liveVersion = useHubStore((s) => s.hubs[hub.dTag]?.eventCreatedAt) ?? hub.eventCreatedAt
  const [versionCopied, setVersionCopied] = useState(false)
  const [fetchingLatest, setFetchingLatest] = useState(false)

  const copyVersion = () => {
    if (liveVersion == null) return
    navigator.clipboard.writeText(String(liveVersion))
    setVersionCopied(true)
    setTimeout(() => setVersionCopied(false), 2000)
  }
  const fetchLatest = () => {
    setFetchingLatest(true)
    retryHub(hub.dTag) // re-fetch from relays (+ local cache) via the loader; store updates in place
    setTimeout(() => setFetchingLatest(false), 4000)
  }

  /** Resolve the signed hub event: relays first, local cache if it's been wiped. */
  const resolveHubEvent = async () => {
    const ev = await fetchReplaceable(hub.creatorPubkey, KINDS.HUB_EVENT, hub.dTag)
    if (ev) { putHubEvent(ev).catch(() => {}); return ev }
    return getHubEvent(KINDS.HUB_EVENT, hub.creatorPubkey, hub.dTag)
  }

  const exportBackup = async () => {
    setMenuOpen(false)
    setBackupError(null)
    setBackupBusy(true)
    setBackupProgress(null)
    try {
      const ev = await resolveHubEvent()
      if (!ev) throw new Error('Hub event not found on any relay or in the local cache.')
      const blob = await buildHubBackup(hub, ev, (done, total, bytes) => setBackupProgress({ done, total, bytes }))
      const safe = hub.name.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase().slice(0, 40) || hub.dTag.slice(0, 8)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `den-hub-${safe}-backup.json.gz`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : 'Backup failed')
    } finally {
      setBackupBusy(false)
      setBackupProgress(null)
    }
  }

  const hubAddress = nip19.naddrEncode({
    identifier: hub.dTag,
    pubkey: hub.creatorPubkey,
    kind: KINDS.HUB_EVENT,
    relays: hub.generalRelays.slice(0, 3),
  })

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const copyHubAddress = () => {
    navigator.clipboard.writeText(hubAddress)
    setAddressCopied(true)
    setMenuOpen(false)
    setTimeout(() => setAddressCopied(false), 2000)
  }

  const viewRawEvent = async () => {
    setMenuOpen(false)
    setRawLoading(true)
    try {
      // Relays first; falls back to the local IndexedDB copy if it's been wiped.
      const ev = await resolveHubEvent()
      setRawJson(ev ? JSON.stringify(ev, null, 2) : '// Hub event not found on any relay or in local cache')
    } catch {
      setRawJson('// Failed to fetch the hub event')
    } finally {
      setRawLoading(false)
    }
  }

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

        {/* Top-right actions: 3-dot menu + close */}
        <div className="absolute top-2 right-2 flex items-center gap-1.5 z-20">
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="bg-black/50 text-white p-1 rounded-full hover:bg-black/70 cursor-pointer"
            >
              {rawLoading ? <Loader2 size={14} className="animate-spin" /> : <MoreVertical size={14} />}
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-56 rounded-xl border border-border bg-popover/95 backdrop-blur-md shadow-xl z-50 p-1 flex flex-col gap-0.5 text-sm animate-in fade-in-0 zoom-in-95">
                <button onClick={viewRawEvent} className="flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
                  <Code size={14} className="text-muted-foreground" /> View raw event
                </button>
                <button onClick={copyHubAddress} className="flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
                  {addressCopied ? <Check size={14} className="text-emerald-400" /> : <Link2 size={14} className="text-muted-foreground" />}
                  {addressCopied ? 'Copied!' : 'Copy hub address'}
                </button>
                <button onClick={() => { setMenuOpen(false); setShowAvailability(true) }} className="flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
                  <Radio size={14} className="text-muted-foreground" /> Check hub availability
                </button>
                <button onClick={() => { setMenuOpen(false); setShowBlossomAvailability(true) }} className="flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
                  <Database size={14} className="text-muted-foreground" /> Check Blossom files
                </button>
                <button onClick={exportBackup} disabled={backupBusy} className="flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-50">
                  <Archive size={14} className="text-muted-foreground" /> Export hub backup
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="bg-black/50 text-white p-1 rounded-full hover:bg-black/70 cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

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
          {/* Backup progress / error */}
          {backupBusy && (
            <div className="flex items-center gap-2 rounded-md bg-secondary/50 border border-border px-3 py-2 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin shrink-0" />
              {backupProgress
                ? `Downloading hub data… ${backupProgress.done}/${backupProgress.total} files (${fmtBytes(backupProgress.bytes)})`
                : 'Preparing backup…'}
            </div>
          )}
          {backupError && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{backupError}</span>
            </div>
          )}

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

          <Separator />

          {/* Hub version — so members can compare which event version they're on */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 block">Hub version</label>
            <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary/50 border border-border/50">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground font-mono truncate">{liveVersion ?? '—'}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {liveVersion != null ? new Date(liveVersion * 1000).toLocaleString() : 'Unknown'}
                </div>
              </div>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={copyVersion}
                      disabled={liveVersion == null}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                    >
                      {versionCopied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Copy version number</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <button
                onClick={fetchLatest}
                disabled={fetchingLatest}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer shrink-0 text-xs font-medium disabled:opacity-60 disabled:cursor-wait"
              >
                {fetchingLatest ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {fetchingLatest ? 'Fetching…' : 'Fetch latest'}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
              This is the hub event's timestamp. If members see different channels or content, compare this number — the highest is newest — and fetch the latest.
            </p>
          </div>
        </div>
      </div>

      {rawJson !== null && <RawEventModal rawJson={rawJson} onClose={() => setRawJson(null)} />}
      {showAvailability && <HubAvailabilityModal hub={hub} onClose={() => setShowAvailability(false)} />}
      {showBlossomAvailability && <BlossomAvailabilityModal hub={hub} onClose={() => setShowBlossomAvailability(false)} />}
    </div>
  )
}

/** Queries each of the user's relays for the hub event and reports coverage. */
function HubAvailabilityModal({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [results, setResults] = useState<RelayAvailability[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Pass the version the client holds so relays with an OLDER copy read as
    // 'outdated' rather than 'present'.
    checkEventAvailability({ kinds: [KINDS.HUB_EVENT], authors: [hub.creatorPubkey], '#d': [hub.dTag], limit: 1 }, hub.eventCreatedAt)
      .then((r) => { if (!cancelled) setResults(r) })
      .catch(() => { if (!cancelled) setResults([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [hub.creatorPubkey, hub.dTag, hub.eventCreatedAt])

  const presentCount = results.filter((r) => r.status === 'present').length
  const outdatedCount = results.filter((r) => r.status === 'outdated').length
  const total = results.length
  const healthy = presentCount >= 3

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-background shadow-lg animate-in fade-in-0 zoom-in-95">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Hub availability</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer"><X size={15} /></button>
        </div>

        <div className="p-4">
          {loading ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Loader2 size={22} className="animate-spin" />
              <span className="text-xs">Checking your relays…</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-2xl font-bold ${healthy ? 'text-emerald-400' : presentCount > 0 ? 'text-amber-400' : 'text-destructive'}`}>
                  {presentCount}
                </span>
                <span className="text-sm text-muted-foreground">of {total} relays have the latest version</span>
              </div>
              <p className={`text-xs mb-3 ${healthy ? 'text-emerald-400/80' : 'text-amber-400/80'}`}>
                {healthy
                  ? 'Well-replicated — the latest hub event is safely redundant.'
                  : presentCount > 0
                    ? 'Under-replicated. The background rebroadcast will try to fill gaps as you use the hub.'
                    : outdatedCount > 0
                      ? 'No relay has the latest version — only older copies. Rebroadcast from Settings → My Hubs to propagate the current version.'
                      : 'Not found on any of your relays.'}
              </p>
              <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                {results.map((r) => (
                  <div key={r.relay} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-secondary/40 text-xs">
                    <span className="truncate text-foreground/80 font-mono">{r.relay.replace(/^wss:\/\//, '')}</span>
                    {r.status === 'present'
                      ? <span className="flex items-center gap-1 text-emerald-400 shrink-0"><Check size={12} /> present</span>
                      : r.status === 'outdated'
                        ? <span className="flex items-center gap-1 text-amber-400 shrink-0"><Radio size={12} /> outdated</span>
                        : <span className="flex items-center gap-1 text-muted-foreground shrink-0"><X size={12} /> absent</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function BlossomAvailabilityModal({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const [loading, setLoading] = useState(true)
  const [files, setFiles] = useState<BlossomFileAvailability[]>([])
  const [serverCount, setServerCount] = useState(0)
  const [target, setTarget] = useState(3)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [mirroring, setMirroring] = useState(false)
  const [uploadNote, setUploadNote] = useState<string | null>(null)

  const runCensus = useCallback((signal?: { cancelled: boolean }) => {
    setLoading(true)
    return checkBlossomFileAvailability(hub.dTag, pubkey || '')
      .then((r) => { if (!signal?.cancelled) { setFiles(r.files); setServerCount(r.servers.length); setTarget(r.target) } })
      .catch(() => { if (!signal?.cancelled) setFiles([]) })
      .finally(() => { if (!signal?.cancelled) setLoading(false) })
  }, [hub.dTag, pubkey])

  useEffect(() => {
    const signal = { cancelled: false }
    runCensus(signal)
    return () => { signal.cancelled = true }
  }, [runCensus])

  const healthyCount = files.filter((f) => f.presentCount >= target).length
  const allHealthy = files.length > 0 && healthyCount === files.length

  const reupload = async () => {
    setMirroring(true)
    setUploadNote(null)
    try {
      const results = await directUploadHubFiles(hub.dTag, pubkey || '')
      await runCensus()
      const refused = results.filter((r) => r.error === 'every server refused the upload').length
      const partial = results.filter((r) => r.error && r.error.startsWith('only reached')).length
      const unfetched = results.filter((r) => r.error === 'could not fetch the file from any server').length
      if (refused > 0 && partial === 0 && unfetched === 0) {
        setUploadNote('Every one of your Blossom servers refused the upload. You likely need a server you have write access to (your own, or one you have an account on) in Settings → Network.')
      } else if (unfetched > 0) {
        setUploadNote(`${unfetched} file(s) couldn't be fetched from any server.`)
      } else if (refused > 0 || partial > 0) {
        setUploadNote('Some files still couldn\'t reach 3 servers — the remaining servers refused the upload.')
      } else {
        setUploadNote(null)
      }
    } finally {
      setMirroring(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-background shadow-lg animate-in fade-in-0 zoom-in-95">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Blossom file availability</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer"><X size={15} /></button>
        </div>

        <div className="p-4">
          {loading ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Loader2 size={22} className="animate-spin" />
              <span className="text-xs">Checking Blossom servers…</span>
            </div>
          ) : files.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4">Couldn't read this hub's member-list files (no Blossom servers, or the index is unavailable).</p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-2xl font-bold ${allHealthy ? 'text-emerald-400' : healthyCount > 0 ? 'text-amber-400' : 'text-destructive'}`}>
                  {healthyCount}
                </span>
                <span className="text-sm text-muted-foreground">of {files.length} files replicated on ≥{target} of {serverCount} servers</span>
              </div>
              <p className={`text-xs mb-3 ${allHealthy ? 'text-emerald-400/80' : 'text-amber-400/80'}`}>
                {allHealthy
                  ? 'Well-replicated — the hub\'s member data is safely redundant.'
                  : 'Some files are under-replicated. The background mirror re-uploads them as members open the hub.'}
              </p>
              <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
                {files.map((f) => {
                  const healthy = f.presentCount >= target
                  const isOpen = expanded === f.hash
                  return (
                    <div key={f.hash} className="rounded-md bg-secondary/40 overflow-hidden">
                      <button
                        onClick={() => setExpanded(isOpen ? null : f.hash)}
                        className="flex items-center justify-between gap-2 w-full px-2.5 py-1.5 text-xs hover:bg-secondary/60 transition-colors cursor-pointer"
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          <ChevronDown size={12} className={`text-muted-foreground shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                          <span className="truncate text-foreground/90">{f.label}</span>
                        </span>
                        <span className={`shrink-0 font-medium ${healthy ? 'text-emerald-400' : f.presentCount > 0 ? 'text-amber-400' : 'text-destructive'}`}>
                          {f.presentCount}/{serverCount}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="px-2.5 pb-2 pt-0.5 flex flex-col gap-1 border-t border-border/40">
                          {f.servers.map((s) => (
                            <div key={s.server} className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="truncate text-foreground/70 font-mono">{s.server.replace(/^https?:\/\//, '')}</span>
                              {s.present
                                ? <span className="flex items-center gap-1 text-emerald-400 shrink-0"><Check size={11} /> present</span>
                                : <span className="flex items-center gap-1 text-muted-foreground shrink-0"><X size={11} /> absent</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {!allHealthy && (
                <button
                  onClick={reupload}
                  disabled={mirroring || loading}
                  className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                >
                  {mirroring ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
                  {mirroring ? 'Re-uploading…' : `Re-upload missing files (to ${target} servers)`}
                </button>
              )}
              {uploadNote && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" /> {uploadNote}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
