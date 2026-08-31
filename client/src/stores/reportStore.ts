/**
 * reportStore — Zustand store for hub reports (kind 36948)
 *
 * Reports are hub-scoped, encrypted, addressable replaceable events.
 * Each report has a unique d-tag (UUID), a reported user (p tag),
 * an optional reported message (report tag), a type (y tag), and
 * a status (s tag: open | retracted).
 *
 * Encryption uses HKDF-SHA256 with "reports" domain separation.
 */

import { create } from 'zustand'
import { KINDS } from '@/lib/crypto/constants'
import {
  createReportEvent,
  createRetractedReportEvent,
  mineAndSign,
  type ReportType,
} from '@/lib/nostr/events'
import {
  publishToSpecificRelays,
} from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { deriveReportsKey } from '@/lib/crypto/hkdf'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { fromHex } from '@/lib/crypto/lkh'
import { useHubStore } from '@/stores/hubStore'
import { signHubMemberEvent } from '@/lib/hub/hubMemberSign'
import { isV2 } from '@/lib/hub/version'

import { SimplePool, type Filter, type Event } from 'nostr-tools'
import type { ISigner } from '@/stores/userStore'

/** Local pool for querying hub-specific relays */
const pool = new SimplePool()

/* ─── Types ─── */

export interface HubReport {
  /** Report event d-tag (unique ID) */
  dTag: string
  /** Reporter pubkey (event author) */
  reporterPubkey: string
  /** Reported user pubkey */
  reportedPubkey: string
  /** Optional: reported message a-tag ref ("36943:pubkey:dTag") */
  reportedMessageATag?: string
  /** Report type classification */
  reportType: ReportType
  /** Status: open or retracted */
  status: 'open' | 'retracted'
  /** Epoch used for encryption */
  epoch: number
  /** Decrypted report reason text (null if not yet decrypted) */
  reasonText: string | null
  /** Event timestamp */
  createdAt: number
  /** Raw event ID */
  eventId: string
}

export interface ReportFilters {
  /** Start of date range (unix timestamp) */
  since?: number
  /** End of date range (unix timestamp) */
  until?: number
  /** Filter by reporter pubkey */
  reporterPubkey?: string
  /** Filter by reported/violator pubkey */
  reportedPubkey?: string
  /** Filter by status */
  status?: 'open' | 'retracted' | 'all'
}

interface ReportState {
  /** Reports for hub settings view, keyed by hub d-tag */
  reportsByHub: Record<string, HubReport[]>
  /** Current user's reports, keyed by hub d-tag */
  myReportsByHub: Record<string, HubReport[]>
  /** Loading states */
  loadingHub: Record<string, boolean>
  loadingMy: Record<string, boolean>

  /** Fetch reports for a hub (for mod/creator view) */
  fetchHubReports: (
    hubDTag: string,
    hubCreatorPubkey: string,
    hubSecretHex: string,
    relays: string[],
    filters?: ReportFilters,
  ) => Promise<void>

  /** Fetch current user's own reports for a hub */
  fetchMyReports: (
    hubDTag: string,
    hubCreatorPubkey: string,
    hubSecretHex: string,
    myPubkey: string,
    relays: string[],
    signer?: ISigner | null,
    privateKey?: string | null,
  ) => Promise<void>

  /** Submit a new report */
  submitReport: (params: {
    hubDTag: string
    hubCreatorPubkey: string
    hubSecretHex: string
    reportedPubkey: string
    reportType: ReportType
    reasonText: string
    epoch: number
    relays: string[]
    signer: ISigner | null
    privateKey: string | null
    pubkey: string
    minPow?: number
    reportedMessageATag?: string
  }) => Promise<void>

  /** Retract an existing report */
  retractReport: (params: {
    report: HubReport
    hubDTag: string
    hubCreatorPubkey: string
    hubSecretHex: string
    epoch: number
    relays: string[]
    signer: ISigner | null
    privateKey: string | null
    pubkey: string
    minPow?: number
  }) => Promise<void>
}

/* ─── Helpers ─── */

function parseReportEvent(event: any): Omit<HubReport, 'reasonText'> & { reasonText: null } {
  const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1] || ''
  const reportedPubkey = event.tags.find((t: string[]) => t[0] === 'p')?.[1] || ''
  const reportTag = event.tags.find((t: string[]) => t[0] === 'report')
  const reportType = (event.tags.find((t: string[]) => t[0] === 'y')?.[1] || 'other') as ReportType
  const status = (event.tags.find((t: string[]) => t[0] === 's')?.[1] || 'open') as 'open' | 'retracted'
  const epoch = parseInt(event.tags.find((t: string[]) => t[0] === 'epoch')?.[1] || '1', 10)

  return {
    dTag,
    reporterPubkey: event.pubkey,
    reportedPubkey,
    reportedMessageATag: reportTag?.[1] || undefined,
    reportType,
    status,
    epoch,
    reasonText: null,
    createdAt: event.created_at,
    eventId: event.id,
  }
}

async function decryptReportContent(
  content: string,
  hubSecretHex: string,
  hubDTag: string,
  epoch: number,
): Promise<string | null> {
  if (!content) return null
  try {
    const secretBytes = fromHex(hubSecretHex)
    const key = deriveReportsKey(secretBytes, hubDTag, epoch)
    const decrypted = await aesDecrypt(key, content)
    const parsed = JSON.parse(decrypted)
    return parsed.text || ''
  } catch (err) {
    console.warn('Failed to decrypt report content:', err)
    return null
  }
}

/* ─── Store ─── */

export const useReportStore = create<ReportState>((set, get) => ({
  reportsByHub: {},
  myReportsByHub: {},
  loadingHub: {},
  loadingMy: {},

  fetchHubReports: async (hubDTag, hubCreatorPubkey, hubSecretHex, relays, filters) => {
    set((s) => ({ loadingHub: { ...s.loadingHub, [hubDTag]: true } }))
    try {
      const hubATag = `${KINDS.HUB_EVENT}:${hubCreatorPubkey}:${hubDTag}`
      const filter: any = {
        kinds: [KINDS.REPORT as number],
        '#a': [hubATag],
      }

      // Date range
      if (filters?.since) filter.since = filters.since
      if (filters?.until) filter.until = filters.until

      // Author filter (reporter)
      if (filters?.reporterPubkey) filter.authors = [filters.reporterPubkey]

      // Violator filter
      if (filters?.reportedPubkey) filter['#p'] = [filters.reportedPubkey]

      const events = await pool.querySync(relays, filter)

      // Parse and deduplicate by d-tag (latest wins)
      const reportMap = new Map<string, any>()
      for (const event of events) {
        const parsed = parseReportEvent(event)
        parsed.eventId = event.id
        const existing = reportMap.get(parsed.dTag)
        if (!existing || event.created_at > existing.createdAt) {
          reportMap.set(parsed.dTag, { ...parsed, _content: event.content })
        }
      }

      // Decrypt all
      const reports: HubReport[] = []
      for (const [, report] of reportMap) {
        const { _content, ...rest } = report
        const reasonText = await decryptReportContent(_content, hubSecretHex, hubDTag, rest.epoch)
        reports.push({ ...rest, reasonText })
      }

      // Apply status filter client-side
      let filtered = reports
      if (filters?.status && filters.status !== 'all') {
        filtered = reports.filter((r) => r.status === filters.status)
      }

      // Sort by createdAt descending (latest first)
      filtered.sort((a, b) => b.createdAt - a.createdAt)

      set((s) => ({
        reportsByHub: { ...s.reportsByHub, [hubDTag]: filtered },
        loadingHub: { ...s.loadingHub, [hubDTag]: false },
      }))
    } catch (err) {
      console.error('Failed to fetch hub reports:', err)
      set((s) => ({ loadingHub: { ...s.loadingHub, [hubDTag]: false } }))
    }
  },

  fetchMyReports: async (hubDTag, hubCreatorPubkey, hubSecretHex, myPubkey, relays, signer, privateKey) => {
    set((s) => ({ loadingMy: { ...s.loadingMy, [hubDTag]: true } }))
    try {
      const hubATag = `${KINDS.HUB_EVENT}:${hubCreatorPubkey}:${hubDTag}`
      // v2: our own reports are authored under our pseudonym — member `P` OR facilitated `Pf`. Query by
      // the SAME key submitReport authored under, via resolveV2PostingSigner (which picks member-P vs
      // facilitated-Pf exactly like the send path). Falls back to the roster R→P (then R) if we can't
      // derive it. v1 queries by R. This is what lets a FACILITATED reporter find their own reports
      // (their Pf isn't in the roster, so the old roster-only lookup missed them entirely).
      const hub = useHubStore.getState().hubs[hubDTag]
      let queryAuthor = myPubkey
      if (hub && isV2(hub)) {
        try {
          const { resolveV2PostingSigner } = await import('@/lib/hub/hubMemberSign')
          queryAuthor = await (await resolveV2PostingSigner(hub, myPubkey, privateKey ?? null, signer ?? null)).getPublicKey()
        } catch {
          const p = useHubStore.getState().hubMembers[hubDTag]?.find((m) => m.pubkey === myPubkey)?.p
          if (p) queryAuthor = p
        }
      }
      // Fail CLOSED: on v2 we must NOT query by our real key R against the hub coordinate — that would tie
      // R to this private hub on the wire. If we couldn't resolve to a pseudonym (P/Pf), skip the query
      // (show no "my reports" rather than leak R). resolveV2PostingSigner is deterministic and effectively
      // never fails, so this is defense-in-depth for the catch/roster-miss path above.
      if (hub && isV2(hub) && queryAuthor === myPubkey) {
        set((s) => ({
          myReportsByHub: { ...s.myReportsByHub, [hubDTag]: [] },
          loadingMy: { ...s.loadingMy, [hubDTag]: false },
        }))
        return
      }
      const events = await pool.querySync(relays, {
        kinds: [KINDS.REPORT as number],
        authors: [queryAuthor],
        '#a': [hubATag],
      })

      // Parse and deduplicate
      const reportMap = new Map<string, any>()
      for (const event of events) {
        const parsed = parseReportEvent(event)
        const existing = reportMap.get(parsed.dTag)
        if (!existing || event.created_at > existing.createdAt) {
          reportMap.set(parsed.dTag, { ...parsed, _content: event.content })
        }
      }

      // Decrypt
      const reports: HubReport[] = []
      for (const [, report] of reportMap) {
        const { _content, ...rest } = report
        const reasonText = await decryptReportContent(_content, hubSecretHex, hubDTag, rest.epoch)
        reports.push({ ...rest, reasonText })
      }

      reports.sort((a, b) => b.createdAt - a.createdAt)

      set((s) => ({
        myReportsByHub: { ...s.myReportsByHub, [hubDTag]: reports },
        loadingMy: { ...s.loadingMy, [hubDTag]: false },
      }))
    } catch (err) {
      console.error('Failed to fetch my reports:', err)
      set((s) => ({ loadingMy: { ...s.loadingMy, [hubDTag]: false } }))
    }
  },

  submitReport: async ({
    hubDTag, hubCreatorPubkey, hubSecretHex, reportedPubkey, reportType,
    reasonText, epoch, relays, signer, privateKey, pubkey, minPow, reportedMessageATag,
  }) => {
    // Encrypt content
    const secretBytes = fromHex(hubSecretHex)
    const key = deriveReportsKey(secretBytes, hubDTag, epoch)
    const plaintext = JSON.stringify({ text: reasonText })
    const encrypted = await aesEncrypt(key, plaintext)

    // v2: reports are member events — author under the reporter's pseudonym P (with an identity tag,
    // so mods can still resolve R), and tag the REPORTED user by their pseudonym P too. Otherwise the
    // report would publish the reporter's (and a profile-reported target's) real key R on an event
    // bound to the hub coordinate — an R-on-wire leak. v1 stays R-authored.
    const hub = useHubStore.getState().hubs[hubDTag]
    const v2 = !!hub && isV2(hub)
    let targetPubkey = reportedPubkey
    if (v2) {
      // The reported user must be tagged by their PSEUDONYM `P` — the `p` tag is plaintext/relay-visible,
      // so a real key `R` here is an R-on-wire leak of a third party. `reportedPubkey` may arrive as the
      // target's `R` (profile-originated report) or already as a pseudonym `P`/`Pf` (message report).
      // Resolve via the roster in EITHER direction; if it resolves, tag the pseudonym. If it does NOT
      // resolve (e.g. the roster hasn't loaded that member yet), FAIL CLOSED — do not fall back to the
      // raw value, which could be an unmapped `R`. Better a "try again" than leaking R.
      const members = useHubStore.getState().hubMembers[hubDTag]
      const entry = members?.find((m) => m.pubkey === reportedPubkey || m.p === reportedPubkey)
      if (entry?.p) {
        targetPubkey = entry.p
      } else {
        // Not a roster member. A FACILITATED author posts under `Pf`, which lives only in the
        // facilitator's mesh list — not the main roster. If `reportedPubkey` is a known `Pf`, it is
        // already a pseudonym and is safe to tag directly (this is the message-report path). Otherwise
        // it's unresolvable (e.g. a profile report carrying a real key `R`, or an unloaded roster) →
        // FAIL CLOSED rather than risk publishing `R` in the plaintext `p` tag.
        const facMap = useHubStore.getState().hubFacilitatorMembers[hubDTag] || {}
        const isKnownPf = Object.values(facMap).some((pfs) => pfs.includes(reportedPubkey))
        if (!isKnownPf) {
          throw new Error('Can’t file this report yet — the reported user’s hub identity is still loading. Please try again in a moment.')
        }
        targetPubkey = reportedPubkey // a facilitated pseudonym Pf — safe to tag
      }
    }

    // Build event
    let unsigned = createReportEvent(
      encrypted,
      hubDTag,
      hubCreatorPubkey,
      targetPubkey,
      reportType,
      epoch,
      reportedMessageATag,
    )

    // PoW + sign — v2 authors under P (+ identity tag via channelKey); v1 authors under R.
    const signed = v2 && hub
      ? await signHubMemberEvent({ hub, unsigned, pubkey, privateKey, signer, minPow: minPow || 0, channelKey: key })
      : await mineAndSign(unsigned, minPow || 0, pubkey, signer, privateKey)
    await publishToSpecificRelays(getPublishRelays(relays, { hubOnly: v2 }), signed)

    // Optimistic local update — add to myReportsByHub. Key by the WIRE author (P on v2) so it matches
    // what fetchMyReports enumerates.
    const dTag = signed.tags.find((t: string[]) => t[0] === 'd')?.[1] || ''
    const newReport: HubReport = {
      dTag,
      reporterPubkey: signed.pubkey,
      reportedPubkey: targetPubkey,
      reportedMessageATag,
      reportType,
      status: 'open',
      epoch,
      reasonText,
      createdAt: signed.created_at,
      eventId: signed.id,
    }

    set((s) => ({
      myReportsByHub: {
        ...s.myReportsByHub,
        [hubDTag]: [newReport, ...(s.myReportsByHub[hubDTag] || [])],
      },
    }))
  },

  retractReport: async ({
    report, hubDTag, hubCreatorPubkey, hubSecretHex, epoch,
    relays, signer, privateKey, pubkey, minPow,
  }) => {
    // Encrypt empty retraction content
    const secretBytes = fromHex(hubSecretHex)
    const key = deriveReportsKey(secretBytes, hubDTag, epoch)
    const plaintext = JSON.stringify({ text: '' })
    const encrypted = await aesEncrypt(key, plaintext)

    // Build retracted event with same d-tag
    let unsigned = createRetractedReportEvent(
      report.dTag,
      hubDTag,
      hubCreatorPubkey,
      report.reportedPubkey,
      report.reportType,
      epoch,
      encrypted,
      report.reportedMessageATag,
    )

    // PoW + sign — v2 authors the retraction under the same pseudonym P as the original report (matching
    // d-tag, so relays replace it); v1 authors under R. report.reportedPubkey is already the P target.
    const hub = useHubStore.getState().hubs[hubDTag]
    const signed = hub && isV2(hub)
      ? await signHubMemberEvent({ hub, unsigned, pubkey, privateKey, signer, minPow: minPow || 0, channelKey: key })
      : await mineAndSign(unsigned, minPow || 0, pubkey, signer, privateKey)
    await publishToSpecificRelays(getPublishRelays(relays, { hubOnly: !!hub && isV2(hub) }), signed)

    // Optimistic local update — mark as retracted
    set((s) => ({
      myReportsByHub: {
        ...s.myReportsByHub,
        [hubDTag]: (s.myReportsByHub[hubDTag] || []).map((r) =>
          r.dTag === report.dTag ? { ...r, status: 'retracted' as const, reasonText: '' } : r
        ),
      },
      reportsByHub: {
        ...s.reportsByHub,
        [hubDTag]: (s.reportsByHub[hubDTag] || []).map((r) =>
          r.dTag === report.dTag ? { ...r, status: 'retracted' as const, reasonText: '' } : r
        ),
      },
    }))
  },
}))
