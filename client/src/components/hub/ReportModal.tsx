/**
 * ReportModal — Submit a hub report (kind 36948)
 *
 * Used from two entry points:
 * 1. Message dropdown → reports a specific message (reportedMessageATag provided)
 * 2. Profile modal → reports a user generally (no message ref)
 *
 * Features: report type picker, free-text reason, PoW mining indicator, encryption.
 */

import { useState, useEffect, useCallback } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useHubStore } from '@/stores/hubStore'
import { useReportStore } from '@/stores/reportStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import {
  X, Flag, Loader2, Check, AlertTriangle, Pickaxe,
} from 'lucide-react'
import type { ReportType } from '@/lib/nostr/events'

interface ReportModalProps {
  open: boolean
  onClose: () => void
  hubDTag: string
  hubCreatorPubkey: string
  reportedPubkey: string
  /** Present when reporting from message dropdown */
  reportedMessageATag?: string
  /** Decrypted text snippet for context */
  reportedMessagePreview?: string
}

const REPORT_TYPES: { value: ReportType; label: string; color: string }[] = [
  { value: 'spam', label: 'Spam', color: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
  { value: 'nsfw', label: 'NSFW', color: 'bg-pink-500/15 text-pink-400 border-pink-500/30' },
  { value: 'scam', label: 'Scam', color: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  { value: 'illegal', label: 'Illegal', color: 'bg-red-500/15 text-red-400 border-red-500/30' },
  { value: 'malware', label: 'Malware', color: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  { value: 'harassment', label: 'Harassment', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  { value: 'other', label: 'Other', color: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
]

export function ReportModal({
  open, onClose, hubDTag, hubCreatorPubkey, reportedPubkey,
  reportedMessageATag, reportedMessagePreview,
}: ReportModalProps) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hub = useHubStore((s) => s.hubs[hubDTag])
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const submitReport = useReportStore((s) => s.submitReport)
  const { getProfile } = useProfileCache()

  const [selectedType, setSelectedType] = useState<ReportType | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [mining, setMining] = useState(false)

  // Reset state on open
  useEffect(() => {
    if (open) {
      setSelectedType(null)
      setReasonText('')
      setError(null)
      setSuccess(false)
      setSubmitting(false)
      setMining(false)
    }
  }, [open])

  const reportedProfile = reportedPubkey ? getProfile(reportedPubkey) : null
  const reportedName = reportedProfile?.display_name || reportedProfile?.name ||
    (reportedPubkey ? truncateNpub(nip19.npubEncode(reportedPubkey), 12) : 'Unknown')
  const hubSecret = hubDTag ? hubSecrets[hubDTag] : null
  const minPow = hub?.minPow || 0

  const handleSubmit = useCallback(async () => {
    if (!selectedType || !pubkey || !hubSecret || !hub) return
    setSubmitting(true)
    setError(null)

    if (minPow > 0) setMining(true)

    try {
      const relays = [...new Set(hub.generalRelays)].filter(Boolean)

      await submitReport({
        hubDTag,
        hubCreatorPubkey,
        hubSecretHex: hubSecret,
        reportedPubkey,
        reportType: selectedType,
        reasonText: reasonText.trim(),
        epoch: hub.epoch,
        relays,
        signer,
        privateKey,
        pubkey,
        minPow: minPow > 0 ? minPow : undefined,
        reportedMessageATag,
      })

      setSuccess(true)
      setTimeout(() => onClose(), 1200)
    } catch (err: any) {
      console.error('Report submission failed:', err)
      setError(err?.message || 'Failed to submit report')
    } finally {
      setSubmitting(false)
      setMining(false)
    }
  }, [selectedType, reasonText, pubkey, hubSecret, hub, hubDTag, hubCreatorPubkey, reportedPubkey, reportedMessageATag, minPow, signer, privateKey, submitReport, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-background rounded-xl w-full max-w-md max-h-[85vh] overflow-hidden shadow-2xl flex flex-col border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <Flag size={16} className="text-amber-400" />
            <h3 className="text-base font-semibold text-foreground">Report User</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-accent/50 transition-colors cursor-pointer">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 min-h-0">
          {/* Reported user info */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 border border-border">
            <Avatar className="h-9 w-9">
              {reportedProfile?.picture && <AvatarImage src={reportedProfile.picture} />}
              <AvatarFallback className="text-xs bg-red-500/20 text-red-400">
                {reportedName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{reportedName}</p>
              <p className="text-xs text-muted-foreground truncate">
                {reportedPubkey ? truncateNpub(nip19.npubEncode(reportedPubkey), 20) : ''}
              </p>
            </div>
          </div>

          {/* Reported message preview (if reporting a specific message) */}
          {reportedMessagePreview && (
            <div className="rounded-lg bg-secondary/20 border border-border p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Reported Message</p>
              <p className="text-xs text-foreground/80 line-clamp-3 italic">"{reportedMessagePreview}"</p>
            </div>
          )}

          {/* Report type selector */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Report Type</p>
            <div className="flex flex-wrap gap-1.5">
              {REPORT_TYPES.map((rt) => (
                <button
                  key={rt.value}
                  onClick={() => setSelectedType(rt.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all cursor-pointer
                    ${selectedType === rt.value
                      ? `${rt.color} ring-1 ring-current scale-[1.02]`
                      : 'bg-secondary/30 text-muted-foreground border-border hover:bg-secondary/60'
                    }`}
                >
                  {rt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Reason text */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Reason <span className="font-normal text-muted-foreground/60">(optional)</span>
            </p>
            <textarea
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="Describe the issue..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none"
            />
          </div>

          {/* Encryption notice */}
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5">
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <p className="text-[10px] text-emerald-400/80 leading-relaxed">
              This report is encrypted with the hub secret. Only hub members can read it.
            </p>
          </div>

          {/* PoW notice */}
          {minPow > 0 && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10">
              <Pickaxe size={12} className="text-amber-400 shrink-0 mt-0.5" />
              <p className="text-[10px] text-amber-400/80 leading-relaxed">
                This hub requires proof-of-work (difficulty {minPow}). Mining will run before publishing.
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle size={12} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border">
          <button
            onClick={handleSubmit}
            disabled={!selectedType || submitting || success || !hubSecret}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-500 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {success ? (
              <><Check size={14} /> Report Submitted</>
            ) : mining ? (
              <><Pickaxe size={14} className="animate-bounce" /> Mining PoW...</>
            ) : submitting ? (
              <><Loader2 size={14} className="animate-spin" /> Submitting...</>
            ) : (
              <><Flag size={14} /> Submit Report</>
            )}
          </button>
          {!hubSecret && (
            <p className="text-[10px] text-muted-foreground text-center mt-2">
              Hub secret required to encrypt the report
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
