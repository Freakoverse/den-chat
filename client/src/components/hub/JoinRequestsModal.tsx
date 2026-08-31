/**
 * JoinRequestsModal — Creator-only modal to review and process hub join requests
 *
 * Features:
 * - Fetches kind 36944 join request events from general relays
 * - Filters out: existing members, insufficient PoW, duplicates
 * - Time-based filtering (24h, 48h, 7d, 30d, 3mo, 1yr, all)
 * - Search by name or npub
 * - Multi-select toggle + "Add Member" batch action
 * - Step-by-step progress feedback during member addition
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useHubStore, type HubData, type HubMember } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { isV2 } from '@/lib/hub/version'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub, cn } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { markJoinRequestsSeen } from '@/hooks/useJoinRequestCount'
import {
  X, Search, Loader2, Check, CheckSquare, Square, AlertTriangle, ChevronDown, ChevronUp, UserPlus, RotateCw,
} from 'lucide-react'
import { UserProfileModal } from '@/components/hub/UserProfileModal'

interface JoinRequestsModalProps {
  open: boolean
  onClose: () => void
  hub: HubData
}

interface JoinRequest {
  /** Identity we display + dedup on: the joiner's real key `R` (v2) or the author (v1). */
  pubkey: string
  createdAt: number
  powBits: number
  eventId: string
  /** v2 only: the member pseudonym `P` (leaf identifier in the tree). */
  pPub?: string
}

/** Time filter options */
const TIME_FILTERS = [
  { label: 'Last 24 hours', seconds: 24 * 3600 },
  { label: 'Last 48 hours', seconds: 48 * 3600 },
  { label: 'Last 7 days', seconds: 7 * 24 * 3600 },
  { label: 'Last 30 days', seconds: 30 * 24 * 3600 },
  { label: 'Last 3 months', seconds: 90 * 24 * 3600 },
  { label: 'Last year', seconds: 365 * 24 * 3600 },
  { label: 'All time', seconds: 0 },
] as const

/** localStorage key for the creator's preferred join-request lookback range (persists across sessions). */
const TIME_FILTER_KEY = 'den_join_requests_time_filter'

const EMPTY_MEMBERS: HubMember[] = []

const ADD_STEPS = [
  'Downloading index file',
  'Downloading spine tree',
  'Recovering page keys',
  'Downloading leaf pages',
  'Encrypting keys for members',
  'Uploading leaf pages & spine',
  'Building & uploading index',
  'Verifying uploads',
  'Signing hub event',
  'Publishing to relays',
]

export function JoinRequestsModal({ open, onClose, hub }: JoinRequestsModalProps) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hubMembersRaw = useHubStore((s) => s.hubMembers[hub.dTag])
  const hubMembers = hubMembersRaw || EMPTY_MEMBERS
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const hubBanList = useHubStore((s) => s.hubBanLists[hub.dTag])
  const setHubMembers = useHubStore((s) => s.setHubMembers)
  const setHubData = useHubStore((s) => s.setHubData)
  const { getProfile } = useProfileCache()

  const [requests, setRequests] = useState<JoinRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)
  const [timeFilterIdx, setTimeFilterIdx] = useState(() => {
    // Restore the creator's last-chosen lookback range; default to 48h (index 1).
    try {
      const raw = localStorage.getItem(TIME_FILTER_KEY)
      if (raw !== null) {
        const n = parseInt(raw, 10)
        if (Number.isInteger(n) && n >= 0 && n < TIME_FILTERS.length) return n
      }
    } catch { /* ignore */ }
    return 1
  })
  // Persist the chosen range so reopening the modal shows the same window (and its entries).
  useEffect(() => {
    try { localStorage.setItem(TIME_FILTER_KEY, String(timeFilterIdx)) } catch { /* ignore */ }
  }, [timeFilterIdx])
  const [showTimeDropdown, setShowTimeDropdown] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addedCount, setAddedCount] = useState(0)
  // Where the member-list update actually landed (servers/relays), for the "Show details" panel
  const [publishDetails, setPublishDetails] = useState<{
    uploadedServers: string[]; targetedServers: string[]; publishedRelays: string[]; targetedRelays: string[]
  } | null>(null)
  const [showPublishDetails, setShowPublishDetails] = useState(false)
  // Progress tracking
  const [addStep, setAddStep] = useState<string | null>(null)
  const [addSteps, setAddSteps] = useState<string[]>([])
  const addAbortRef = useRef<AbortController | null>(null)
  const addTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addStepRef = useRef<string | null>(null)

  // On success the overlay stays open showing the result + "Show details" until
  // the user closes it (see the Done block below) — no auto-dismiss.

  // Fetch join requests
  const loadRequests = useCallback(async () => {
    if (!hub.generalRelays.length) return
    setLoading(true)
    try {
      const since = TIME_FILTERS[timeFilterIdx].seconds > 0
        ? Math.floor(Date.now() / 1000) - TIME_FILTERS[timeFilterIdx].seconds
        : undefined

      const v2 = isV2(hub)
      const coord = `${KINDS.HUB_EVENT}:${hub.creatorPubkey}:${hub.dTag}`
      const filter: any = {
        kinds: [KINDS.JOIN_REQUEST],
        // v2 joins are sealed-sender and indexed by the hub coordinate; v1 by the d-tag.
        ...(v2 ? { '#a': [coord] } : { '#d': [hub.dTag] }),
        limit: 500,
      }
      if (since) filter.since = since

      const events = await fetchEvents(filter)

      // Deduplicate: one per identity, keep latest.
      // Skip events that carry the ["deleted", "true"] marker (rescinded requests).
      const byPubkey = new Map<string, JoinRequest>()
      if (v2) {
        // Sealed-sender: the author is a throwaway addr key; decrypt (as owner O) to recover
        // the joiner's real key R + pseudonym P. parseV2JoinRequest returns null if it can't.
        const { parseV2JoinRequest } = await import('@/lib/hub/v2join')
        for (const e of events) {
          if (e.tags?.some((t: string[]) => t[0] === 'deleted' && t[1] === 'true')) continue
          // Enforce the hub's join PoW BEFORE the expensive ECDH+nip44 decrypt. joinMinPow exists to price
          // join spam; without this gate an outsider floods zero-PoW junk 36944 events under `#a:[coord]`
          // and the owner burns an asymmetric-crypto decrypt on each one (a cheap-event → expensive-owner
          // amplification). PoW is on the event id, so it's checkable without decrypting.
          if (hub.joinMinPow > 0 && countLeadingZeroBits(e.id) < hub.joinMinPow) continue
          const payload = await parseV2JoinRequest(e, hub.dTag, privateKey, signer)
          if (!payload) continue
          // SECURITY (proof-of-control): a local-key owner re-derives P from the claimed R inside
          // parseV2JoinRequest (`verified`). Producing a request with verified===true requires the
          // applicant's R private key, so it proves they control R. Drop requests that FAIL the check
          // — otherwise anyone could seal a request claiming a VICTIM's R (with a bogus P) and get the
          // owner to insert that third party into the private hub's roster without consent (roster
          // pollution + non-consensual membership disclosure). verified===undefined = remote-signer
          // owner that couldn't re-derive locally (documented tradeoff → trust); only false is rejected.
          if (payload.verified === false) continue
          const existing = byPubkey.get(payload.rPub)
          if (existing && existing.createdAt > e.created_at) continue
          byPubkey.set(payload.rPub, {
            pubkey: payload.rPub,
            createdAt: e.created_at,
            powBits: countLeadingZeroBits(e.id),
            eventId: e.id,
            pPub: payload.pPub,
          })
        }
      } else {
        for (const e of events) {
          if (e.tags?.some((t: string[]) => t[0] === 'deleted' && t[1] === 'true')) continue
          const existing = byPubkey.get(e.pubkey)
          if (existing && existing.createdAt > e.created_at) continue
          byPubkey.set(e.pubkey, {
            pubkey: e.pubkey,
            createdAt: e.created_at,
            powBits: countLeadingZeroBits(e.id),
            eventId: e.id,
          })
        }
      }

      // Filter out hub creator, existing members, and banned users
      const memberPubkeys = new Set(hubMembers.map(m => m.pubkey))
      const bannedPubkeys = new Set(hubBanList || [])
      const filtered = Array.from(byPubkey.values()).filter(r => {
        if (r.pubkey === hub.creatorPubkey) return false
        if (memberPubkeys.has(r.pubkey)) return false
        if (bannedPubkeys.has(r.pubkey)) return false
        // Filter by PoW requirement
        if (hub.minPow > 0 && r.powBits < hub.minPow) return false
        return true
      })

      // Sort: oldest first
      filtered.sort((a, b) => a.createdAt - b.createdAt)

      setRequests(filtered)
    } catch (err) {
      console.error('Failed to fetch join requests:', err)
    } finally {
      setLoading(false)
    }
  }, [hub, hub.dTag, hub.generalRelays, hub.creatorPubkey, hub.minPow, hubMembers.length, hubBanList, timeFilterIdx, privateKey, signer])

  // Reset transient UI state ONLY when the modal opens — not when loadRequests'
  // identity changes (e.g. hubMembers.length bumps after an approval), which
  // would otherwise wipe the success overlay the moment a member is added.
  useEffect(() => {
    if (!open) return
    markJoinRequestsSeen(hub.dTag)
    setSelected(new Set())
    setAddedCount(0)
    setAddError(null)
    setAddStep(null)
    setAddSteps([])
    setPublishDetails(null)
    setShowPublishDetails(false)
  }, [open, hub.dTag])

  // (Re)load requests on open and whenever the relevant hub state changes.
  useEffect(() => {
    if (open) loadRequests()
  }, [open, loadRequests])

  // Filter by search
  const filteredRequests = useMemo(() => {
    if (!search.trim()) return requests
    const q = search.toLowerCase().trim()
    return requests.filter(r => {
      const profile = getProfile(r.pubkey)
      const name = (profile?.display_name || profile?.name || '').toLowerCase()
      const npub = nip19.npubEncode(r.pubkey).toLowerCase()
      return name.includes(q) || npub.includes(q)
    })
  }, [requests, search, getProfile])

  const toggleSelect = (pk: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(pk)) next.delete(pk)
      else next.add(pk)
      return next
    })
  }

  const markStep = async (step: string) => {
    setAddStep(step)
    addStepRef.current = step
    await new Promise(r => setTimeout(r, 0))
  }
  const markDone = (step: string) => setAddSteps(prev => [...prev, step])

  // v2 admit — mirrors handleAddMembers but keys leaves on the pseudonym `P`, wraps each
  // new leaf key to the member's real key `R` via the owner `O`, and re-publishes the hub
  // event as `O` (encrypted content preserved) instead of the v1 root-key path.
  const handleAddMembersV2 = async () => {
    if (selected.size === 0 || !pubkey || adding) return
    setAdding(true)
    setAddError(null)
    setAddedCount(0)
    setPublishDetails(null)
    setShowPublishDetails(false)
    setAddStep(null)
    setAddSteps([])

    const abort = new AbortController()
    addAbortRef.current = abort
    if (addTimeoutRef.current) clearTimeout(addTimeoutRef.current)
    addTimeoutRef.current = setTimeout(() => {
      if (!abort.signal.aborted) {
        abort.abort()
        setAddError('Operation timed out after 2 minutes')
        setAdding(false)
      }
    }, 120_000)

    // Single-flight: serialize this approval with other membership mutations for this hub on this device
    // so concurrent approvals/kicks/role-changes don't clobber each other's index write (the CAS in
    // republishV2 is the cross-device backstop).
    const { acquireHubMutationLock } = await import('@/lib/hub/hubMutationGuard')
    const releaseHubLock = await acquireHubMutationLock(hub.dTag)
    try {
      // Build on the CURRENT index, not the stale render-time closure: re-read the hub from the store
      // AFTER acquiring the lock, so a prior op on this device that just advanced the index is respected
      // (else the single-flight only orders the ops, it doesn't prevent the lost update).
      const freshHub = useHubStore.getState().hubs[hub.dTag] ?? hub
      await markStep('Downloading index file')
      const {
        findPageForPubkey, parseIndexFile,
        rehydratePageKeysV2, addMemberToPageV2,
      } = await import('@/lib/blossom/members')
      const { downloadTextFromBlossom } = await import('@/lib/blossom')
      const {
        fromHex, deserializeSpine, recoverPageRootKeys,
        buildSpine, serializeLeafPage, serializeSpine,
      } = await import('@/lib/crypto/lkh')
      const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
      const { ChatContext } = await import('@/lib/crypto/skd')

      // Read secret + epoch from the FRESH post-lock snapshot too — a concurrent kick that the lock
      // serialized before this op rotates BOTH, and stamping a new leaf with the old epoch or encrypting
      // the spine with the old secret would mis-key it against the freshly-downloaded index.
      const secretHex = useHubStore.getState().hubSecrets[hub.dTag]
      if (!secretHex) throw new Error('Hub secret not available')
      const hubSecret = fromHex(secretHex)

      // Owner sub-signer (O) — wraps each new leaf key to the member's real key R.
      const ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })

      // Resolve a page's roster-segment epoch → secret (history, else current).
      const epochMap = useHubStore.getState().epochSecrets[hub.dTag] || {}
      const resolveEpochSecret = (epoch: number): Uint8Array | undefined =>
        epochMap[epoch] ? fromHex(epochMap[epoch]) : (epoch === freshHub.epoch ? hubSecret : undefined)

      // Resolve the selected requests → { P (leaf id), R (real key) }.
      const selectedReqs = requests.filter(r => selected.has(r.pubkey) && r.pPub)
      if (selectedReqs.length === 0) throw new Error('No valid v2 join requests selected')

      const indexContent = await downloadTextFromBlossom(freshHub.indexFileHash, freshHub.blossomServers)
      const index = parseIndexFile(indexContent)
      if (!index.spineHash || index.leafPages.length === 0) {
        throw new Error('Hub does not use paginated format')
      }
      markDone('Downloading index file')

      // BAN RE-CHECK (fail-closed): verify no selected user is banned, against a FRESH ban-list fetch —
      // the store's ban list can be empty from a failed cold-start load, which would let a banned user
      // be re-approved. downloadBanListV2 now throws if any ban page can't be read, so we block rather
      // than admit on an unverifiable list. (No ban pages → empty → nothing to check.)
      if (index.banPages.length > 0) {
        let bannedSet: Set<string>
        try {
          const { downloadBanListV2 } = await import('@/lib/blossom')
          bannedSet = new Set((await downloadBanListV2(index.banPages, hubSecret, freshHub.blossomServers)).map(e => e.pubkey))
        } catch {
          throw new Error('Could not load the hub’s ban list — can’t safely approve members right now. Please try again.')
        }
        const bannedSelected = selectedReqs.filter(r => bannedSet.has(r.pubkey))
        if (bannedSelected.length > 0) throw new Error(`Can’t approve ${bannedSelected.length} selected request(s): that user is banned.`)
      }

      await markStep('Downloading spine tree')
      const spineContent = await downloadTextFromBlossom(index.spineHash, hub.blossomServers)
      const spine = deserializeSpine(spineContent)
      markDone('Downloading spine tree')

      await markStep('Recovering page keys')
      const pageRootKeys = await recoverPageRootKeys(spine, hubSecret)
      markDone('Recovering page keys')

      // Group members by their target page (binary search by P).
      await markStep('Downloading leaf pages')
      const pageMods = new Map<number, { pageEntry: typeof index.leafPages[0]; members: Array<{ p: string; r: string }> }>()
      for (const req of selectedReqs) {
        const P = req.pPub!
        const pageEntry = findPageForPubkey(index, P)
        if (!pageEntry) { console.warn(`No page for P ${P.slice(0, 8)}…`); continue }
        const existing = pageMods.get(pageEntry.pageIndex)
        if (existing) existing.members.push({ p: P, r: req.pubkey })
        else pageMods.set(pageEntry.pageIndex, { pageEntry, members: [{ p: P, r: req.pubkey }] })
      }

      const updatedPages: Array<{ pageIndex: number; content: string; firstPubkey: string }> = []
      const newPages: Array<{ content: string; firstPubkey: string }> = []
      const updatedPageRoots = new Map<string, { nodeId: string; rawKey: Uint8Array }>()
      let count = 0

      // Download + rehydrate (v2) all affected pages.
      const rehydratedPages = new Map<number, Awaited<ReturnType<typeof rehydratePageKeysV2>>>()
      for (const [pageIndex, mod] of pageMods) {
        const pageContent = await downloadTextFromBlossom(mod.pageEntry.hash, hub.blossomServers)
        const rehydrated = await rehydratePageKeysV2(pageContent, ownerSigner, resolveEpochSecret)
        rehydratedPages.set(pageIndex, rehydrated)
      }
      markDone('Downloading leaf pages')

      await markStep('Encrypting keys for members')
      for (const [pageIndex, mod] of pageMods) {
        let rehydrated = rehydratedPages.get(pageIndex)!
        for (const m of mod.members) {
          try {
            const result = await addMemberToPageV2(rehydrated, m.p, m.r, 'everyone', hubSecret, freshHub.epoch, ownerSigner)
            if (result.split) {
              updatedPages.push({
                pageIndex,
                content: serializeLeafPage(result.pages[0]),
                firstPubkey: result.pages[0].leaves[0].pubkey,
              })
              updatedPageRoots.set(
                result.pages[0].pageRoot.nodeId,
                { nodeId: result.pages[0].pageRoot.nodeId, rawKey: result.pages[0].pageRoot.rawKey! },
              )
              newPages.push({
                content: serializeLeafPage(result.pages[1]),
                firstPubkey: result.pages[1].leaves[0].pubkey,
              })
              rehydrated = result.pages[0]
            } else {
              rehydrated = result.pages[0]
            }
            count++
          } catch (err) {
            console.error(`Failed to add member P=${m.p}:`, err)
          }
        }
        if (!updatedPages.some(p => p.pageIndex === pageIndex)) {
          updatedPages.push({
            pageIndex,
            content: serializeLeafPage(rehydrated),
            firstPubkey: rehydrated.leaves[0].pubkey,
          })
          updatedPageRoots.set(
            pageRootKeys.find((_pr, i) => index.leafPages[i]?.pageIndex === pageIndex)?.nodeId || rehydrated.pageRoot.nodeId,
            { nodeId: rehydrated.pageRoot.nodeId, rawKey: rehydrated.pageRoot.rawKey! },
          )
        }
      }
      if (count === 0) throw new Error('Failed to add any members')
      markDone('Encrypting keys for members')

      // Rebuild spine with updated page-root keys.
      const allPageRoots = pageRootKeys.map((prk) => updatedPageRoots.get(prk.nodeId) || prk)
      for (const np of newPages) {
        const rehydratedNew = await rehydratePageKeysV2(np.content, ownerSigner, resolveEpochSecret)
        allPageRoots.push({ nodeId: rehydratedNew.pageRoot.nodeId, rawKey: rehydratedNew.pageRoot.rawKey! })
      }
      const newSpine = await buildSpine(allPageRoots, hubSecret)
      const newSpineContent = serializeSpine(newSpine)

      const { safePaginatedTreeUpdate } = await import('@/lib/blossom/treeUpdater')
      const result = await safePaginatedTreeUpdate({
        hub, signer, privateKey,
        updatedPages,
        newPages: newPages.length > 0 ? newPages : undefined,
        newSpineContent,
        existingIndexData: {
          spineHash: index.spineHash,
          historyHash: index.historyHash,
          groupTrees: index.groupTrees,
          leafPages: index.leafPages,
        },
        skipPublish: true, // v2: re-publish as O below (root-key path would break the hub)
        authSigner: (e) => ownerSigner.signEvent(e), // Blossom auth as O, not R_owner
        onStep: (step) => {
          if (addStepRef.current) markDone(addStepRef.current)
          markStep(step)
        },
      })
      if (addStepRef.current) markDone(addStepRef.current)

      // Re-publish the v2 hub event as O with the new index hash (encrypted content unchanged).
      await markStep('Signing hub event')
      const { republishV2HubIndex } = await import('@/lib/hub/republishV2')
      const pub = await republishV2HubIndex({
        hub: freshHub, ownerPub: freshHub.creatorPubkey, newIndexHash: result.newIndexHash, privateKey, signer,
      })
      markDone('Signing hub event')
      await markStep('Publishing to relays')
      markDone('Publishing to relays')

      // Update local store — the v2 roster keys members by their real key R. Base the new list on the
      // FRESH store snapshot (a concurrent kick may have changed it), not the render-time closure.
      const newMembers: HubMember[] = [
        ...(useHubStore.getState().hubMembers[hub.dTag] || []),
        ...selectedReqs.map(r => ({ pubkey: r.pubkey, roles: 'everyone' })),
      ]
      setHubMembers(hub.dTag, newMembers)
      setHubData(hub.dTag, { ...freshHub, indexFileHash: result.newIndexHash, eventCreatedAt: pub.eventCreatedAt ?? freshHub.eventCreatedAt })

      // Delete the superseded blobs ONLY now that the new hub event is published — safePaginatedTreeUpdate
      // deferred them (skipPublish) so the live event never pointed at a deleted index/spine/page.
      if (result.deferredCleanupHashes?.length) {
        const { deleteFromBlossom } = await import('@/lib/blossom/client')
        for (const h of result.deferredCleanupHashes) {
          deleteFromBlossom(h, signer, privateKey, freshHub.blossomServers, (e) => ownerSigner.signEvent(e)).catch(() => {})
        }
      }

      setAddedCount(count)
      setPublishDetails({
        uploadedServers: result.uploadedServers ?? [],
        targetedServers: result.targetedServers ?? hub.blossomServers,
        publishedRelays: pub.publishedRelays ?? [],
        targetedRelays: pub.targetedRelays ?? [],
      })
      setRequests(prev => prev.filter(r => !selected.has(r.pubkey)))
      setSelected(new Set())
      await markStep('Done')
    } catch (err: any) {
      if (!abort.signal.aborted) {
        console.error('Failed to add members (v2):', err)
        setAddError(err?.message || 'Failed to add members')
      }
    } finally {
      releaseHubLock()
      setAdding(false)
      addAbortRef.current = null
      if (addTimeoutRef.current) { clearTimeout(addTimeoutRef.current); addTimeoutRef.current = null }
    }
  }

  const handleAddMembers = async () => {
    if (selected.size === 0 || !pubkey || adding) return
    if (isV2(hub)) { void handleAddMembersV2(); return }
    setAdding(true)
    setAddError(null)
    setAddedCount(0)
    setPublishDetails(null)
    setShowPublishDetails(false)
    setAddStep(null)
    setAddSteps([])

    // Create abort controller for cancellation
    const abort = new AbortController()
    addAbortRef.current = abort

    // Safety timeout — auto-error after 2 minutes to prevent permanent lock
    if (addTimeoutRef.current) clearTimeout(addTimeoutRef.current)
    addTimeoutRef.current = setTimeout(() => {
      if (!abort.signal.aborted) {
        abort.abort()
        setAddError('Operation timed out after 2 minutes')
        setAdding(false)
      }
    }, 120_000)

    // Single-flight: v1 approvals must serialize with kicks/bans/role-changes too (same lost-update bug
    // as v2). safePaginatedTreeUpdate below carries the cross-device CAS.
    const { acquireHubMutationLock } = await import('@/lib/hub/hubMutationGuard')
    const releaseHubLock = await acquireHubMutationLock(hub.dTag)
    try {
      // Re-read the current hub AFTER acquiring the lock so we build on the latest index (see the v2 path).
      const freshHub = useHubStore.getState().hubs[hub.dTag] ?? hub
      await markStep('Downloading index file')
      const {
        rehydratePageKeys, addMemberToPage, findPageForPubkey,
        parseIndexFile, createPaginatedIndexFile,
      } = await import('@/lib/blossom/members')
      const { downloadTextFromBlossom } = await import('@/lib/blossom')
      const {
        fromHex, deserializeSpine, recoverPageRootKeys,
        buildSpine, serializeLeafPage, serializeSpine,
      } = await import('@/lib/crypto/lkh')

      const secretHex = hubSecrets[hub.dTag]
      if (!secretHex) throw new Error('Hub secret not available')
      const hubSecret = fromHex(secretHex)

      // Download current index + spine
      const indexContent = await downloadTextFromBlossom(freshHub.indexFileHash, freshHub.blossomServers)
      const index = parseIndexFile(indexContent)

      if (!index.spineHash || index.leafPages.length === 0) {
        throw new Error('Hub does not use paginated format')
      }
      markDone('Downloading index file')

      await markStep('Downloading spine tree')
      const spineContent = await downloadTextFromBlossom(index.spineHash, hub.blossomServers)
      const spine = deserializeSpine(spineContent)
      markDone('Downloading spine tree')

      // Recover all page-root keys from spine (O(pages) AES decryptions, no page downloads needed)
      await markStep('Recovering page keys')
      const pageRootKeys = await recoverPageRootKeys(spine, hubSecret)
      markDone('Recovering page keys')

      // Group members by target page
      await markStep('Downloading leaf pages')
      const pubkeysToAdd = Array.from(selected)

      // Track which pages need modification
      const pageMods = new Map<number, { pageEntry: typeof index.leafPages[0]; newMembers: string[] }>()

      for (const memberPk of pubkeysToAdd) {
        // Find which page this member should go into (binary search by pubkey)
        const pageEntry = findPageForPubkey(index, memberPk)
        if (!pageEntry) {
          // No pages exist — shouldn't happen since hub has at least creator
          console.warn(`No page found for ${memberPk.slice(0, 8)}…`)
          continue
        }
        const existing = pageMods.get(pageEntry.pageIndex)
        if (existing) {
          existing.newMembers.push(memberPk)
        } else {
          pageMods.set(pageEntry.pageIndex, { pageEntry, newMembers: [memberPk] })
        }
      }

      // Process each modified page — first download all needed pages
      const updatedPages: Array<{ pageIndex: number; content: string; firstPubkey: string }> = []
      const newPages: Array<{ content: string; firstPubkey: string }> = []
      const updatedPageRoots = new Map<string, { nodeId: string; rawKey: Uint8Array }>()
      let count = 0

      // Download and rehydrate all affected pages
      const rehydratedPages = new Map<number, Awaited<ReturnType<typeof rehydratePageKeys>>>()
      for (const [pageIndex, mod] of pageMods) {
        const pageContent = await downloadTextFromBlossom(mod.pageEntry.hash, hub.blossomServers)
        const rehydrated = await rehydratePageKeys(pageContent, signer, privateKey)
        rehydratedPages.set(pageIndex, rehydrated)
      }
      markDone('Downloading leaf pages')

      // Encrypt keys for each new member
      await markStep('Encrypting keys for members')
      for (const [pageIndex, mod] of pageMods) {
        let rehydrated = rehydratedPages.get(pageIndex)!

        for (const memberPk of mod.newMembers) {
          try {
            const result = await addMemberToPage(rehydrated, memberPk, 'everyone', signer, privateKey)

            if (result.split) {
              // Page was split — both new pages need uploading
              // First half replaces the original page
              updatedPages.push({
                pageIndex,
                content: serializeLeafPage(result.pages[0]),
                firstPubkey: result.pages[0].leaves[0].pubkey,
              })
              updatedPageRoots.set(
                pageRootKeys.find(pr => pr.nodeId === spine.encryptedPageRootKeys.find(e => e.nodeId === pr.nodeId)?.nodeId)?.nodeId || result.pages[0].pageRoot.nodeId,
                { nodeId: result.pages[0].pageRoot.nodeId, rawKey: result.pages[0].pageRoot.rawKey! },
              )
              // Second half is a new page
              newPages.push({
                content: serializeLeafPage(result.pages[1]),
                firstPubkey: result.pages[1].leaves[0].pubkey,
              })
              // Update rehydrated to the first page for subsequent members
              rehydrated = result.pages[0]
            } else {
              rehydrated = result.pages[0]
            }
            count++
          } catch (err) {
            console.error(`Failed to add member ${memberPk}:`, err)
          }
        }

        // If no split occurred, update the page in place
        if (!updatedPages.some(p => p.pageIndex === pageIndex)) {
          updatedPages.push({
            pageIndex,
            content: serializeLeafPage(rehydrated),
            firstPubkey: rehydrated.leaves[0].pubkey,
          })
          updatedPageRoots.set(
            pageRootKeys.find((_pr, i) => index.leafPages[i]?.pageIndex === pageIndex)?.nodeId || rehydrated.pageRoot.nodeId,
            { nodeId: rehydrated.pageRoot.nodeId, rawKey: rehydrated.pageRoot.rawKey! },
          )
        }
      }

      if (count === 0) throw new Error('Failed to add any members')
      markDone('Encrypting keys for members')

      // Rebuild spine with updated page-root keys — start with recovered keys, replace modified ones
      const allPageRoots = pageRootKeys.map((prk, i) => {
        const updated = updatedPageRoots.get(prk.nodeId)
        return updated || prk
      })
      // Add new page roots from splits
      for (const np of newPages) {
        // Parse to get pageRoot — we serialized it above so need to re-deserialize
        const { deserializeLeafPage } = await import('@/lib/crypto/lkh')
        const parsed = deserializeLeafPage(np.content)
        // New pages won't have rawKey after deserialization, so we rehydrate
        const rehydratedNew = await rehydratePageKeys(np.content, signer, privateKey)
        allPageRoots.push({ nodeId: rehydratedNew.pageRoot.nodeId, rawKey: rehydratedNew.pageRoot.rawKey! })
      }

      const newSpine = await buildSpine(allPageRoots, hubSecret)
      const newSpineContent = serializeSpine(newSpine)

      const { safePaginatedTreeUpdate } = await import('@/lib/blossom/treeUpdater')
      const result = await safePaginatedTreeUpdate({
        hub: freshHub,
        signer,
        privateKey,
        updatedPages,
        newPages: newPages.length > 0 ? newPages.map(np => ({
          content: np.content,
          firstPubkey: np.firstPubkey,
        })) : undefined,
        newSpineContent,
        existingIndexData: {
          spineHash: index.spineHash,
          historyHash: index.historyHash,
          groupTrees: index.groupTrees,
          leafPages: index.leafPages,
        },
        onStep: (step) => {
          if (addStepRef.current) markDone(addStepRef.current)
          markStep(step)
        },
      })
      // Mark the last treeUpdater step as done
      if (addStepRef.current) markDone(addStepRef.current)

      // Update local store
      const newMembers: HubMember[] = [
        ...hubMembers,
        ...pubkeysToAdd.map(pk => ({ pubkey: pk, roles: 'everyone' })),
      ]
      setHubMembers(hub.dTag, newMembers)
      setHubData(hub.dTag, { ...freshHub, indexFileHash: result.newIndexHash, eventCreatedAt: result.eventCreatedAt ?? freshHub.eventCreatedAt })

      setAddedCount(count)
      setPublishDetails({
        uploadedServers: result.uploadedServers ?? [],
        targetedServers: result.targetedServers ?? hub.blossomServers,
        publishedRelays: result.publishedRelays ?? [],
        targetedRelays: result.targetedRelays ?? [],
      })
      setRequests(prev => prev.filter(r => !selected.has(r.pubkey)))
      setSelected(new Set())

      await markStep('Done')
    } catch (err: any) {
      if (!abort.signal.aborted) {
        console.error('Failed to add members:', err)
        setAddError(err?.message || 'Failed to add members')
      }
    } finally {
      releaseHubLock()
      setAdding(false)
      addAbortRef.current = null
      if (addTimeoutRef.current) { clearTimeout(addTimeoutRef.current); addTimeoutRef.current = null }
    }
  }

  if (!open) return null

  const timeFilter = TIME_FILTERS[timeFilterIdx]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60" onClick={onClose}>
      <div
        className="bg-background rounded-xl w-full max-w-lg max-h-[80vh] overflow-hidden shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-base font-semibold text-foreground">Join Requests</h3>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-accent/50 transition-colors cursor-pointer">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        {/* Toolbar: time filter + multi-select + search */}
        <div className="px-4 pt-3 pb-2 space-y-2 border-b border-border">
          <div className="flex items-center gap-2">
            {/* Time filter dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowTimeDropdown(!showTimeDropdown)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                {timeFilter.label}
                <ChevronDown size={12} />
              </button>
              {showTimeDropdown && (
                <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded-lg shadow-lg z-10 p-1 flex flex-col gap-1 min-w-[160px]">
                  {TIME_FILTERS.map((tf, i) => (
                    <button
                      key={i}
                      onClick={() => { setTimeFilterIdx(i); setShowTimeDropdown(false) }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer rounded-md
                        ${i === timeFilterIdx ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1" />

            <span className="text-xs text-muted-foreground">
              {filteredRequests.length} request{filteredRequests.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search by name or npub..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
        </div>

        {/* Request list */}
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 size={18} className="animate-spin mr-2" /> Loading requests...
            </div>
          ) : filteredRequests.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              {requests.length === 0
                ? 'No pending join requests.'
                : 'No requests match your search.'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredRequests.map((req) => {
                const profile = getProfile(req.pubkey)
                const npubStr = nip19.npubEncode(req.pubkey)
                const displayName = profile?.display_name || profile?.name || truncateNpub(npubStr, 10)
                const isSelected = selected.has(req.pubkey)
                const timeAgo = formatTimeAgo(req.createdAt)

                return (
                  <button
                    key={req.pubkey}
                    onClick={() => toggleSelect(req.pubkey)}
                    className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors cursor-pointer text-left
                      ${isSelected
                        ? 'bg-primary/15 border border-primary/30'
                        : 'hover:bg-secondary/50 border border-transparent'
                      }`}
                  >
                    <div className="shrink-0">
                      {isSelected
                        ? <CheckSquare size={16} className="text-primary" />
                        : <Square size={16} className="text-muted-foreground" />
                      }
                    </div>
                    <Avatar
                      className="h-9 w-9 shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); setProfilePubkey(req.pubkey) }}
                      title="View profile"
                    >
                      {profile?.picture && <AvatarImage src={profile.picture} />}
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">
                        {displayName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p
                        className="text-sm font-medium text-foreground truncate hover:underline cursor-pointer w-fit"
                        onClick={(e) => { e.stopPropagation(); setProfilePubkey(req.pubkey) }}
                        title="View profile"
                      >{displayName}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {truncateNpub(npubStr, 5)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[10px] text-muted-foreground">{timeAgo}</span>
                      {req.powBits > 0 && (
                        <span className="text-[10px] text-amber-400">Processing needed: {req.powBits}</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border space-y-2">
          {addError && !addStep && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle size={12} /> {addError}
            </div>
          )}
          {addedCount > 0 && !addStep && (
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <Check size={12} /> Added {addedCount} member{addedCount !== 1 ? 's' : ''} successfully
            </div>
          )}
          <button
            onClick={handleAddMembers}
            disabled={selected.size === 0 || adding}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {adding ? (
              <><Loader2 size={14} className="animate-spin" /> Adding...</>
            ) : (
              <><UserPlus size={14} /> Add Member{selected.size > 1 ? `s (${selected.size})` : ''}</>
            )}
          </button>
        </div>
      </div>

      {/* Progress overlay */}
      {(adding || addSteps.length > 0) && createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="bg-card rounded-xl border border-border shadow-2xl w-[340px] p-5 space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5">
              {addStep === 'Done' && !addError ? (
                <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                  <Check size={16} className="text-emerald-400" />
                </div>
              ) : addError ? (
                <div className="w-8 h-8 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                  <AlertTriangle size={16} className="text-destructive" />
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                  <Loader2 size={16} className="text-primary animate-spin" />
                </div>
              )}
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  {addError ? 'Failed to Add Members' : addStep === 'Done' ? 'Members Added' : 'Adding Members...'}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  {addError ? addError : addStep === 'Done' ? `${addedCount} member${addedCount !== 1 ? 's' : ''} added successfully` : addStep || 'Starting...'}
                </p>
              </div>
              {/* Always-visible close / cancel button */}
              <div className="flex-1" />
              <button
                onClick={() => {
                  // Cancel in-progress operation
                  if (addAbortRef.current && !addAbortRef.current.signal.aborted) {
                    addAbortRef.current.abort()
                  }
                  if (addTimeoutRef.current) { clearTimeout(addTimeoutRef.current); addTimeoutRef.current = null }
                  setAdding(false)
                  setAddSteps([])
                  setAddStep(null)
                  setAddError(null)
                }}
                className="p-1 rounded-full hover:bg-accent/50 transition-colors cursor-pointer shrink-0 self-start"
                title="Close"
              >
                <X size={14} className="text-muted-foreground" />
              </button>
            </div>

            {/* Step list */}
            <div className="space-y-1.5">
              {ADD_STEPS.map((step) => {
                const isDone = addSteps.includes(step)
                const isCurrent = addStep === step
                return (
                  <div key={step} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs">
                    {isDone ? (
                      <Check size={12} className="text-emerald-400 shrink-0" />
                    ) : isCurrent ? (
                      <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />
                    ) : (
                      <div className="w-3 h-3 rounded-full border border-border shrink-0" />
                    )}
                    <span className={cn(
                      'transition-colors',
                      isDone ? 'text-emerald-400' : isCurrent ? 'text-foreground' : 'text-muted-foreground/50'
                    )}>
                      {step}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Success: optional details + close */}
            {addStep === 'Done' && !addError && (
              <div className="space-y-2">
                {publishDetails && (
                  <>
                    <button
                      onClick={() => setShowPublishDetails((v) => !v)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      {showPublishDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {showPublishDetails ? 'Hide details' : 'Show details'}
                    </button>
                    {showPublishDetails && (
                      <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-2.5 max-h-[220px] overflow-y-auto">
                        <PublishDetailGroup title="Blossom servers" targeted={publishDetails.targetedServers} succeeded={publishDetails.uploadedServers} />
                        <PublishDetailGroup title="Relays" targeted={publishDetails.targetedRelays} succeeded={publishDetails.publishedRelays} />
                      </div>
                    )}
                  </>
                )}
                <button
                  onClick={() => { setAddSteps([]); setAddStep(null); setShowPublishDetails(false) }}
                  className="w-full h-9 text-sm rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            )}

            {/* Error: Retry + Dismiss */}
            {addError && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setAddError(null)
                    setAddStep(null)
                    setAddSteps([])
                    handleAddMembers()
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 text-xs rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  <RotateCw size={12} /> Retry
                </button>
                <button
                  onClick={() => { setAddSteps([]); setAddStep(null); setAddError(null) }}
                  className="flex-1 h-8 text-xs rounded-lg font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
      {/* User profile modal */}
      <UserProfileModal
        open={!!profilePubkey}
        onClose={() => setProfilePubkey(null)}
        targetPubkey={profilePubkey || undefined}
      />
    </div>
  )
}

/** Normalize a server/relay URL for comparison (drop protocol + trailing slash, lowercase). */
function normalizeEndpoint(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').toLowerCase()
}

/** Lists each targeted server/relay with a ✓ (accepted) or ✗ (failed) marker. */
function PublishDetailGroup({ title, targeted, succeeded }: { title: string; targeted: string[]; succeeded: string[] }) {
  if (targeted.length === 0) return null
  const ok = new Set(succeeded.map(normalizeEndpoint))
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title} <span className="font-normal normal-case text-muted-foreground/60">({succeeded.length}/{targeted.length})</span>
      </p>
      {targeted.map((url) => {
        const accepted = ok.has(normalizeEndpoint(url))
        return (
          <div key={url} className="flex items-center gap-1.5 text-xs">
            {accepted
              ? <Check size={11} className="text-emerald-400 shrink-0" />
              : <X size={11} className="text-destructive shrink-0" />}
            <span className={cn('truncate', accepted ? 'text-foreground/80' : 'text-destructive')}>
              {normalizeEndpoint(url)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Format timestamp as relative time ago */
function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`
  return `${Math.floor(diff / (86400 * 365))}y ago`
}
