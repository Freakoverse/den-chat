/**
 * HubEventCard — Inline card for rendering hub event links (naddr for kind 36942)
 *
 * Displays hub banner, icon, name, description, tags, NSFW badge, PoW difficulty.
 * Buttons: "Preview" (ephemeral sidebar add) and "Request Join" (publish kind 36944 + add to hub list).
 */

import { useState, useEffect } from 'react'
import { useHubStore, type HubData } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { HubInfoModal } from '@/components/hub/HubInfoModal'
import {
  Info, UserPlus, Zap, AlertTriangle, Loader2, Check, Hash, X,
} from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { HubJoinWarningModal, isJoinWarningDismissed } from '@/components/hub/HubJoinWarningModal'
import { MAX_HUB_LIST_ENTRIES } from '@/lib/hub/hubLimits'

interface HubEventCardProps {
  /** naddr data */
  identifier: string
  pubkey: string
  relays?: string[]
}

export function HubEventCard({ identifier, pubkey, relays }: HubEventCardProps) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hubs = useHubStore((s) => s.hubs)
  const hubEntries = useHubStore((s) => s.hubEntries)
  const setHubData = useHubStore((s) => s.setHubData)
  const setHubEntries = useHubStore((s) => s.setHubEntries)
  const folders = useHubStore((s) => s.folders)

  const { getProfile } = useProfileCache()
  const creatorProfile = getProfile(pubkey)

  const [hubData, setLocalHubData] = useState<HubData | null>(null)
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [showInfoModal, setShowInfoModal] = useState(false)
  const [showJoinWarning, setShowJoinWarning] = useState(false)
  const [showHubLimitModal, setShowHubLimitModal] = useState(false)

  // Check if already a member/entry
  const isAlreadyInList = hubEntries.some(e => e.dTag === identifier)
  // "Actually in the hub" (resolved on load): holding the hub secret means we decrypted
  // it from the LKH tree → real member; or our pubkey is a member leaf on our page.
  const dTag = hubData?.dTag || identifier
  const hubSecret = useHubStore((s) => s.hubSecrets[dTag])
  const hubMembers = useHubStore((s) => s.hubMembers[dTag])
  const isMember = !!hubSecret || (!!myPubkey && (hubMembers?.some(m => m.pubkey === myPubkey) ?? false))

  // Fetch hub event data
  useEffect(() => {
    // Check if hub is already in store
    if (hubs[identifier]) {
      setLocalHubData(hubs[identifier])
      setLoading(false)
      return
    }

    // Fetch from relays
    const fetchHub = async () => {
      try {
        const filter: any = {
          kinds: [KINDS.HUB_EVENT],
          '#d': [identifier],
          limit: 5,
        }
        if (pubkey) filter.authors = [pubkey]

        const events = await fetchEvents(filter)
        if (events.length === 0) {
          setLoading(false)
          return
        }

        // Get latest event
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0]

        // Parse hub data (minimal inline parsing)
        const dTag = latest.tags.find(t => t[0] === 'd')?.[1] || identifier
        const name = latest.tags.find(t => t[0] === 'n')?.[1] || 'Unnamed Hub'
        const epochTag = latest.tags.find(t => t[0] === 'epoch')?.[1]
        const epoch = epochTag ? parseInt(epochTag, 10) : 1

        const generalRelays = latest.tags.filter(t => t[0] === 'r' && t[1]).map(t => t[1])
        const blossomServers = latest.tags.filter(t => t[0] === 'o' && t[1]).map(t => t[1])
        const indexFileHash = latest.tags.find(t => t[0] === 'm')?.[1] || ''
        const tags = latest.tags.filter(t => t[0] === 't' && t[1]).map(t => t[1])

        // Read PoW from w tag (source of truth), fallback to legacy JSON
        const wTagVal = latest.tags.find(t => t[0] === 'w')?.[1]
        let minPow = wTagVal ? parseInt(wTagVal, 10) : 0
        // Join PoW from the W tag. No W tag ⇒ 0 (join PoW is explicit, not inherited).
        const wjTagVal = latest.tags.find(t => t[0] === 'W')?.[1]
        // Read NSFW from content-warning tag (source of truth), fallback to legacy JSON
        let nsfw = latest.tags.some(t => t[0] === 'content-warning')

        let description = ''
        let icon: string | undefined
        let banner: string | undefined

        try {
          const content = JSON.parse(latest.content)
          description = content.settings?.description || ''
          icon = content.settings?.icon
          banner = content.settings?.banner
          // Legacy fallback
          if (minPow === 0) minPow = content.settings?.min_pow || 0
          if (!nsfw) nsfw = !!content.settings?.nsfw
        } catch { }

        const parsed: HubData = {
          dTag,
          creatorPubkey: latest.pubkey,
          name,
          icon,
          banner,
          tags: tags.length > 0 ? tags : undefined,
          description,
          epoch,
          generalRelays,
          blossomServers,
          indexFileHash,
          channels: [],
          categories: [],
          roles: [],
          minPow,
          joinMinPow: wjTagVal ? parseInt(wjTagVal, 10) : 0,
          nsfw,
          version: (() => { const v = latest.tags.find(t => t[0] === 'version')?.[1]; return v ? (parseInt(v, 10) || undefined) : undefined })(),
        }

        setLocalHubData(parsed)
      } catch (err) {
        console.error('Failed to fetch hub event:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchHub()
  }, [identifier, pubkey, hubs])

  const handleRequestJoin = async () => {
    if (!myPubkey || !hubData || joining) return

    // Check hub list limit before joining
    if (!isAlreadyInList && hubEntries.length >= MAX_HUB_LIST_ENTRIES) {
      setShowHubLimitModal(true)
      return
    }

    // Show warning modal if not dismissed
    if (!isJoinWarningDismissed()) {
      setShowJoinWarning(true)
      return
    }

    doJoin()
  }

  const doJoin = async () => {
    if (!myPubkey || !hubData || joining) return
    setJoining(true)
    setJoinError(null)

    try {
      const { createUnsignedEvent, signWithSigner, mineAndSign, createHubListEvent } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const hubRelays = [...(hubData.generalRelays || [])]

      // Create join request event — v2 hubs use a sealed-sender join (§6.3).
      const { isV2 } = await import('@/lib/hub/version')
      let signed
      if (isV2(hubData)) {
        const { buildV2JoinRequest } = await import('@/lib/hub/v2join')
        const { canUseV2 } = await import('@/lib/crypto/skd')
        if (!canUseV2({ privateKey, signer })) {
          throw new Error('This hub is private (v2) — use the DEN client or a NIP-SKD signer to join.')
        }
        const coord = `${KINDS.HUB_EVENT}:${hubData.creatorPubkey}:${hubData.dTag}`
        signed = await buildV2JoinRequest({ hubDTag: hubData.dTag, ownerPub: hubData.creatorPubkey, coord, joinPow: hubData.joinMinPow || 0, rPub: myPubkey, privateKey, signer })
      } else {
        const unsigned = createUnsignedEvent(KINDS.JOIN_REQUEST, '', [['d', hubData.dTag]])
        signed = await mineAndSign(unsigned, hubData.joinMinPow, myPubkey, signer, privateKey)
      }
      // v2: hub relays ONLY (mirrors DiscoverPage) — the sealed join request carries the hub coordinate;
      // fanning it out to the applicant's personal NIP-65 relays lets an observer correlate the addr key → R.
      await publishToSpecificRelays(getPublishRelays(hubRelays, { hubOnly: isV2(hubData) }), signed)

      // Add to user's hub list
      if (!isAlreadyInList) {
        // Store hub data BEFORE updating entries — prevents hub loader
        // from racing with the signer (which can drop extension connections)
        setHubData(hubData.dTag, hubData)

        const relayHint = hubData.generalRelays[0] || ''
        const newEntry = {
          dTag: hubData.dTag,
          relayHint,
          position: hubEntries.length,
          folderId: undefined,
        }
        const newEntries = [...hubEntries, newEntry]
        setHubEntries(newEntries, folders)

        // Publish updated hub list (failover across all the user's relays — see hubListPrivacy)
        const { buildHubListEvent, publishHubList } = await import('@/lib/hub/hubListPrivacy')
        const hubListEvent = await buildHubListEvent(
          newEntries.map(e => ({
            dTag: e.dTag,
            relayHint: e.relayHint,
            position: e.position,
            folderId: e.folderId,
          })),
          folders,
        )
        const signedList = await signWithSigner(hubListEvent, signer, privateKey)
        await publishHubList(signedList)
      }

      setJoined(true)
    } catch (err: any) {
      console.error('Failed to send join request:', err)
      setJoinError(err?.message || 'Failed to send request')
    } finally {
      setJoining(false)
    }
  }

  const handleShowInfo = () => {
    if (!hubData) return
    setShowInfoModal(true)
  }

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-4 animate-pulse">
        <div className="h-16 bg-secondary rounded mb-2" />
        <div className="h-4 bg-secondary rounded w-1/2" />
      </div>
    )
  }

  if (!hubData) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
        Hub not found
      </div>
    )
  }

  const visibleTags = hubData.tags?.slice(0, 3) || []
  const hiddenTagCount = (hubData.tags?.length || 0) - 3

  const creatorName = creatorProfile?.display_name || creatorProfile?.name || truncateNpub(nip19.npubEncode(pubkey), 10)

  return (
    <div
      className="my-2 rounded-lg border border-border overflow-visible bg-secondary/20 hover:bg-secondary/30 transition-colors max-w-[350px]"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Banner */}
      {hubData.banner && (
        <div className="relative h-20 overflow-hidden rounded-t-lg">
          <BlossomBanner src={hubData.banner} alt={`${hubData.name} banner`} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
        </div>
      )}

      <div className="p-3 space-y-2 relative">
        {/* Hub identity */}
        <div className="flex items-center gap-3">
          {hubData.icon ? (
            <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 border border-border">
              <BlossomIcon src={hubData.icon} name={hubData.name} />
            </div>
          ) : (
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
              <Hash size={16} className="text-primary" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-foreground truncate">{hubData.name}</h4>
            <p className="text-[10px] text-muted-foreground">by {creatorName}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium cursor-help ${hubData.version === 2 ? 'bg-violet-500/15 text-violet-400' : 'bg-sky-500/15 text-sky-400'}`}>
                  {hubData.version === 2 ? 'Private' : 'Public'}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs max-w-[240px]">
                {hubData.version === 2
                  ? "Messages are encrypted, activity is hidden behind mask addresses, and a hub's structure is hidden."
                  : "Messages are encrypted/hidden, but all other activity and a hub's structure are public."}
              </TooltipContent>
            </Tooltip>
            {hubData.nsfw && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/20 text-red-400">NSFW</span>
            )}
            {hubData.joinMinPow > 0 && (
              <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/15 text-amber-400">
                Processing needed: {hubData.joinMinPow}
              </span>
            )}
          </div>
        </div>

        {/* Description */}
        {hubData.description && (
          <p
            onClick={() => setShowFullDesc(true)}
            className="text-xs text-muted-foreground leading-relaxed line-clamp-3 whitespace-pre-line cursor-pointer hover:text-foreground/70 transition-colors"
          >
            {hubData.description}
          </p>
        )}

        {/* Tags */}
        {visibleTags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {visibleTags.map((tag) => (
              <span key={tag} className="px-1.5 py-0.5 rounded-md text-[10px] bg-secondary border border-border text-muted-foreground">
                #{tag}
              </span>
            ))}
            {hiddenTagCount > 0 && (
              <button
                onClick={() => setShowAllTags(true)}
                className="px-1.5 py-0.5 rounded-md text-[10px] bg-primary/10 text-primary cursor-pointer hover:bg-primary/20"
              >
                +{hiddenTagCount} more
              </button>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleShowInfo}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-secondary border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <Info size={12} /> Info
          </button>
          {isMember ? (
            <span className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <Check size={12} /> Joined
            </span>
          ) : isAlreadyInList || joined ? (
            <span className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Check size={12} /> Request Sent
            </span>
          ) : (
            <button
              onClick={handleRequestJoin}
              disabled={joining}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              {joining ? (
                <><Loader2 size={12} className="animate-spin" /> {hubData.joinMinPow > 0 ? 'Processing...' : 'Joining...'}</>
              ) : (
                <><UserPlus size={12} /> Request Join</>
              )}
            </button>
          )}
        </div>

        {joinError && (
          <p className="text-[10px] text-destructive flex items-center gap-1">
            <AlertTriangle size={10} /> {joinError}
          </p>
        )}
      </div>

      {/* Full tags modal */}
      {showAllTags && hubData.tags && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60"
          onClick={() => setShowAllTags(false)}
        >
          <div
            className="bg-background rounded-lg p-4 max-w-sm w-full max-h-[50vh] overflow-y-auto shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-foreground">Tags</h4>
              <button onClick={() => setShowAllTags(false)} className="cursor-pointer text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {hubData.tags.map(tag => (
                <span key={tag} className="px-2 py-1 rounded-md text-xs bg-secondary border border-border text-muted-foreground">
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Full description modal */}
      {showFullDesc && hubData.description && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60"
          onClick={() => setShowFullDesc(false)}
        >
          <div
            className="bg-background rounded-lg p-4 max-w-md w-full max-h-[50vh] overflow-y-auto shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-foreground">{hubData.name} — Description</h4>
              <button onClick={() => setShowFullDesc(false)} className="cursor-pointer text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            </div>
            <p className="text-sm text-foreground/80 whitespace-pre-wrap">{hubData.description}</p>
          </div>
        </div>
      )}

      {/* Hub info modal */}
      {hubData && (
        <HubInfoModal
          open={showInfoModal}
          onClose={() => setShowInfoModal(false)}
          hub={hubData}
        />
      )}

      {/* Join warning modal */}
      <HubJoinWarningModal
        open={showJoinWarning}
        onClose={() => setShowJoinWarning(false)}
        onConfirm={doJoin}
      />

      {/* Hub limit reached modal */}
      {showHubLimitModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-2"
          onClick={() => setShowHubLimitModal(false)}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
                <AlertTriangle size={24} className="text-amber-500" />
              </div>
              <h3 className="text-base font-semibold text-foreground">Hub Limit Reached</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                You've reached the maximum of <span className="font-semibold text-foreground">{MAX_HUB_LIST_ENTRIES}</span> hubs
                in your hub list. Remove some hubs from <span className="font-medium text-foreground">Settings → My Hubs</span> before
                joining new ones.
              </p>
              <div className="flex items-center gap-2 w-full mt-1">
                <button
                  onClick={() => setShowHubLimitModal(false)}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Got it
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Blossom-aware image helpers ──────────────────────────── */

function BlossomBanner({ src, alt }: { src: string; alt: string }) {
  const blossom = useBlossomMedia(src)

  if (blossom.error === 'not-found') {
    return (
      <div className="w-full h-full bg-secondary flex items-center justify-center text-xs text-muted-foreground">
        Banner not found
      </div>
    )
  }
  if (blossom.loading) {
    return (
      <div className="w-full h-full bg-secondary animate-pulse flex items-center justify-center">
        <Loader2 size={14} className="animate-spin text-muted-foreground" />
      </div>
    )
  }
  return <img src={blossom.src || src} alt={alt} className="w-full h-full object-cover" loading="lazy" />
}

function BlossomIcon({ src, name }: { src: string; name: string }) {
  const blossom = useBlossomMedia(src)

  if (blossom.error || blossom.loading) {
    return (
      <div className="w-full h-full bg-primary/20 flex items-center justify-center text-xs font-semibold text-primary">
        {name.slice(0, 2).toUpperCase()}
      </div>
    )
  }
  return <img src={blossom.src || src} alt="" className="w-full h-full object-cover" loading="lazy" />
}
