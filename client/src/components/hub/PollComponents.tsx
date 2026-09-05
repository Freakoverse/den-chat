/**
 * PollComponents — UI for creating polls and displaying poll cards in hub channels
 *
 * CreatePollModal: modal to compose a new poll
 * PollCard: inline poll card shown in the message timeline
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { usePollStore, type RawPoll, type VoteData } from '@/stores/pollStore'
import { usePoll, type PollCreationData } from '@/hooks/usePoll'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { verifyEventIdentity } from '@/lib/nostr/identity'
import { isV2 } from '@/lib/hub/version'
import type { Event } from 'nostr-tools'
import { X, Plus, Trash2, Info, Vote, Clock, Check, Circle, Eye, EyeOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { MessageActionBar, ReactionBar } from '@/components/hub/ChannelView'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import type { Reaction } from '@/components/hub/ChannelView'
import { cn } from '@/lib/utils'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { useEscToClose } from '@/hooks/useEscToClose'

// ─── Decrypted poll content type ───

export interface DecryptedPoll {
  id: string
  pubkey: string
  createdAt: number
  text: string
  options: { id: string; label: string }[]
  polltype: 'singlechoice' | 'multiplechoice'
  endsAt?: number
  allowVoteChange: boolean
  showResultsBeforeVoting: boolean
  showVoterIdentity: boolean
}

export interface DecryptedVote {
  /** Wire author of the vote event (pseudonym `P` in v2, real key `R` in v1). */
  pubkey: string
  /** Resolved real key `R` (from the v2 identity tag; equals `pubkey` in v1 or if unresolved). */
  realPubkey: string
  response: string[]
  createdAt: number
}

// ─── VotersModal ───

interface VotersModalProps {
  optionLabel: string
  voters: { pubkey: string }[]
  onClose: () => void
}

function VotersModal({ optionLabel, voters, onClose }: VotersModalProps) {
  useEscToClose(onClose)
  const { getProfile } = useProfileCache()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[360px] max-h-[400px] bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-foreground truncate">Voters for "{optionLabel}"</h4>
            <span className="text-[11px] text-muted-foreground">{voters.length} vote{voters.length !== 1 ? 's' : ''}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {voters.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6">No votes yet</div>
          ) : (
            voters.map((v) => {
              const profile = getProfile(v.pubkey)
              const name = profile?.display_name || profile?.name || truncateNpub(v.pubkey)
              return (
                <div key={v.pubkey} className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-accent/30 transition-colors">
                  <Avatar className="w-6 h-6">
                    <AvatarImage src={profile?.picture} />
                    <AvatarFallback className="text-[9px] bg-muted">{name.slice(0, 2)}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-foreground truncate">{name}</span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// ─── CreatePollModal ───

interface CreatePollModalProps {
  hubDTag: string
  channelId: string
  onClose: () => void
}

export function CreatePollModal({ hubDTag, channelId, onClose }: CreatePollModalProps) {
  useEscToClose(onClose)
  const { createPoll } = usePoll(hubDTag, channelId)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<{ id: string; label: string }[]>([
    { id: crypto.randomUUID().slice(0, 8), label: '' },
    { id: crypto.randomUUID().slice(0, 8), label: '' },
  ])
  const [polltype, setPolltype] = useState<'singlechoice' | 'multiplechoice'>('singlechoice')
  const [durationHours, setDurationHours] = useState(0) // 0 = forever
  const [allowVoteChange, setAllowVoteChange] = useState(true)
  const [showResultsBeforeVoting, setShowResultsBeforeVoting] = useState(false)
  const [showVoterIdentity, setShowVoterIdentity] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const addOption = () => {
    if (options.length >= 10) return
    setOptions([...options, { id: crypto.randomUUID().slice(0, 8), label: '' }])
  }

  const removeOption = (index: number) => {
    if (options.length <= 2) return
    setOptions(options.filter((_, i) => i !== index))
  }

  const updateOption = (index: number, label: string) => {
    setOptions(options.map((o, i) => (i === index ? { ...o, label } : o)))
  }

  const canSubmit = question.trim() && options.filter((o) => o.label.trim()).length >= 2 && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)

    const data: PollCreationData = {
      text: question.trim(),
      options: options.filter((o) => o.label.trim()).map((o) => ({ id: o.id, label: o.label.trim() })),
      polltype,
      allowVoteChange,
      showResultsBeforeVoting,
      showVoterIdentity,
      ...(durationHours > 0 ? { endsAt: Math.floor(Date.now() / 1000) + durationHours * 3600 } : {}),
    }

    try {
      await createPoll(data)
      onClose()
    } catch (err) {
      console.error('[Poll] Failed to create poll:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[480px] max-h-[90vh] bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Vote size={18} className="text-primary" />
            <h3 className="text-base font-semibold text-foreground">Create Poll</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Question */}
          <div className="space-y-2.5">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">Question</label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask something..."
              className="w-full px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none"
              rows={2}
              maxLength={500}
              autoFocus
            />
          </div>

          {/* Options */}
          <div className="space-y-2.5">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">Options</label>
            <div className="space-y-2">
              {options.map((option, i) => (
                <div key={option.id} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-5 text-right shrink-0">{i + 1}.</span>
                  <input
                    value={option.label}
                    onChange={(e) => updateOption(i, e.target.value)}
                    placeholder={`Option ${i + 1}`}
                    className="flex-1 px-3 py-1.5 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground outline-none"
                    maxLength={200}
                  />
                  {options.length > 2 && (
                    <button onClick={() => removeOption(i)} className="p-1 rounded cursor-pointer text-muted-foreground hover:text-destructive transition-colors">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {options.length < 10 && (
                <button onClick={addOption} className="flex items-center gap-1.5 text-xs text-primary/80 hover:text-primary transition-colors cursor-pointer ml-7">
                  <Plus size={14} /> Add option
                </button>
              )}
            </div>
          </div>

          {/* Poll type */}
          <div className="space-y-2.5">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</label>
            <div className="flex gap-2">
              <button
                onClick={() => setPolltype('singlechoice')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer border',
                  polltype === 'singlechoice' ? 'bg-primary/15 border-primary/40 text-primary' : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground'
                )}
              >
                Single choice
              </button>
              <button
                onClick={() => setPolltype('multiplechoice')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer border',
                  polltype === 'multiplechoice' ? 'bg-primary/15 border-primary/40 text-primary' : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground'
                )}
              >
                Multiple choice
              </button>
            </div>
          </div>

          {/* Duration */}
          <div className="space-y-2.5">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">Duration</label>
            <div className="flex flex-wrap gap-2">
              {[
                { value: 0, label: 'Forever' },
                { value: 1, label: '1 hour' },
                { value: 6, label: '6 hours' },
                { value: 12, label: '12 hours' },
                { value: 24, label: '24 hours' },
                { value: 48, label: '2 days' },
                { value: 72, label: '3 days' },
                { value: 168, label: '1 week' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setDurationHours(opt.value)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer border',
                    durationHours === opt.value
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Settings toggles */}
          <div className="space-y-2.5 pt-1">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">Settings</label>

            {/* Allow vote change */}
            <button
              onClick={() => setAllowVoteChange(!allowVoteChange)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/20 border border-border/30 hover:bg-secondary/40 transition-colors cursor-pointer"
            >
              <span className="text-xs text-foreground/90">Allow vote changes</span>
              <div className={cn(
                'w-8 h-[18px] rounded-full transition-colors relative',
                allowVoteChange ? 'bg-primary' : 'bg-muted-foreground/30'
              )}>
                <div className={cn(
                  'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform',
                  allowVoteChange ? 'translate-x-[16px]' : 'translate-x-[2px]'
                )} />
              </div>
            </button>

            {/* Show results before voting */}
            <button
              onClick={() => setShowResultsBeforeVoting(!showResultsBeforeVoting)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/20 border border-border/30 hover:bg-secondary/40 transition-colors cursor-pointer"
            >
              <span className="text-xs text-foreground/90">Show results before voting</span>
              <div className={cn(
                'w-8 h-[18px] rounded-full transition-colors relative',
                showResultsBeforeVoting ? 'bg-primary' : 'bg-muted-foreground/30'
              )}>
                <div className={cn(
                  'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform',
                  showResultsBeforeVoting ? 'translate-x-[16px]' : 'translate-x-[2px]'
                )} />
              </div>
            </button>

            {/* Show voter identity */}
            <button
              onClick={() => setShowVoterIdentity(!showVoterIdentity)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/20 border border-border/30 hover:bg-secondary/40 transition-colors cursor-pointer"
            >
              <span className="text-xs text-foreground/90">Show who voted for each option</span>
              <div className={cn(
                'w-8 h-[18px] rounded-full transition-colors relative',
                showVoterIdentity ? 'bg-primary' : 'bg-muted-foreground/30'
              )}>
                <div className={cn(
                  'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform',
                  showVoterIdentity ? 'translate-x-[16px]' : 'translate-x-[2px]'
                )} />
              </div>
            </button>

            {/* Note */}
            <p className="text-[11px] text-muted-foreground/60 leading-relaxed mt-1 px-1">
              <Info size={11} className="inline -mt-px mr-1" />
              These settings control client-side display only. Advanced users with access to the hub key can decrypt all votes and see full results regardless of these toggles.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? 'Creating...' : 'Create Poll'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── PollCard ───

interface PollCardProps {
  poll: RawPoll
  hubDTag: string
  channelId: string
  onOpenProfile: (pubkey: string) => void
  onReply?: (msg: { id: string; pubkey: string; content: string }) => void
  onThreadReply?: (msg: { id: string; pubkey: string; content: string }) => void
  onRequestDelete?: (eventId: string) => void
  onViewRaw?: (raw: string) => void
  onAddReaction?: (messageId: string, emoji: string, customUrl?: string) => void
  reactions?: Reaction[]
  canPublish?: boolean
  highlighted?: boolean
  onHideMessage?: () => Promise<void>
  onUnhideMessage?: () => Promise<void>
  isHidden?: boolean
  canHide?: boolean
  hiddenBy?: string
}

export function PollCard({ poll, hubDTag, channelId, onOpenProfile, onReply, onThreadReply, onRequestDelete, onViewRaw, onAddReaction, reactions, canPublish, highlighted, onHideMessage, onUnhideMessage, isHidden, canHide, hiddenBy }: PollCardProps) {
  const pubkey = useUserStore((s) => s.pubkey)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const hubs = useHubStore((s) => s.hubs)
  const { getProfile } = useProfileCache()
  const { castVote } = usePoll(hubDTag, channelId)

  const votesRaw = usePollStore((s) => s.votes[poll.id])
  const votes = useMemo(() => votesRaw || [], [votesRaw])
  const fetchStatus = usePollStore((s) => s.voteFetchStatus[poll.id])
  const fetchVotes = usePollStore((s) => s.fetchVotes)

  const [decrypted, setDecrypted] = useState<DecryptedPoll | null>(null)
  const [decryptedVotes, setDecryptedVotes] = useState<DecryptedVote[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [voting, setVoting] = useState(false)
  const [votersModal, setVotersModal] = useState<{ optionId: string; optionLabel: string } | null>(null)
  const [showResults, setShowResults] = useState(false)
  const fetchedRef = useRef(false)

  // Hover action bar state
  const [showActions, setShowActions] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  // v2: the poll is authored by the pseudonym `P`; its true author is `realPubkey`
  // (resolved from the identity tag). v1: `pubkey` IS `R`, so this stays `poll.pubkey`.
  const [pollRealPubkey, setPollRealPubkey] = useState(poll.pubkey)
  const isMine = pollRealPubkey === pubkey
  const [hiddenPreviewRevealed, setHiddenPreviewRevealed] = useState(false)

  const popoverOpen = showEmoji || showMenu

  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent) => {
      if (rowRef.current && rowRef.current.contains(e.target as Node)) return
      const target = e.target as HTMLElement
      if (target.closest('.EmojiPickerReact') || target.closest('[class*="epr"]') || target.closest('[data-emoji-picker]') || target.closest('[data-emoji-picker-portal]')) return
      setShowActions(false)
      setShowEmoji(false)
      setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen])

  const handleMouseLeave = () => {
    if (popoverOpen) return
    setShowActions(false)
  }

  // Derive channel key — epoch-aware for historical polls, and GROUP-aware (a group/private channel
  // is keyed by its group secret, not the hub-wide secret — else any hub member could read it).
  const epochSecrets = useHubStore((s) => s.epochSecrets)
  const groupSecrets = useHubStore((s) => s.groupSecrets)
  const groupEpochSecrets = useHubStore((s) => s.groupEpochSecrets)
  const getChannelKey = useCallback((epoch?: number): Uint8Array | null => {
    if (!hubDTag || !channelId) return null
    const hub = hubs[hubDTag]
    if (!hub) return null

    const channel = hub.channels?.find((c) => c.channelId === channelId)
    let groupId: string | undefined
    if (channel?.encryption) groupId = channel.encryption
    else if (channel?.synced && channel.categoryId) {
      const cat = hub.categories?.find((c) => c.categoryId === channel.categoryId)
      if (cat?.encryption) groupId = cat.encryption
    }

    let secretHex: string | undefined
    let targetEpoch: number
    if (groupId) {
      const currentGroupEpoch = hub.groupedRoles?.find((g) => g.groupId === groupId)?.epoch || 1
      targetEpoch = epoch ?? currentGroupEpoch
      secretHex = targetEpoch === currentGroupEpoch
        ? groupSecrets[hubDTag]?.[groupId]
        : (groupEpochSecrets[hubDTag]?.[groupId]?.[targetEpoch] ?? groupSecrets[hubDTag]?.[groupId])
    } else {
      const currentEpoch = hub.epoch || 1
      targetEpoch = epoch ?? currentEpoch
      secretHex = targetEpoch === currentEpoch
        ? hubSecrets[hubDTag]
        : (epochSecrets[hubDTag]?.[targetEpoch] ?? hubSecrets[hubDTag])
    }
    if (!secretHex) return null

    const secret = new Uint8Array(secretHex.length / 2)
    for (let i = 0; i < secretHex.length; i += 2) {
      secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
    }
    return deriveChannelKey(secret, channelId, targetEpoch)
  }, [hubDTag, channelId, hubSecrets, epochSecrets, groupSecrets, groupEpochSecrets, hubs])

  // Decrypt poll content
  useEffect(() => {
    const key = getChannelKey(poll.epoch)
    if (!key || !poll.content) return

    let cancelled = false
    ;(async () => {
      // v2: the poll's `identity` tag is the author's unforgeable R attestation. If it's PRESENT but
      // INVALID, the poll is a forgery (an owner can author as a victim's P but can't sign as their R)
      // → DROP it (don't render), consistent with the vote drop-rule below and the calendar path. A
      // valid tag yields the real author R. Tag-less legacy polls (rare on v2) still render.
      const hub = hubs[hubDTag]
      if (hub && isV2(hub)) {
        let idEvent: Event | null = null
        try { idEvent = poll.rawEvent ? (JSON.parse(poll.rawEvent) as Event) : null } catch { idEvent = null }
        const hasIdentityTag = !!idEvent?.tags?.some((t) => t[0] === 'identity')
        if (hasIdentityTag) {
          let ok = false, rPub: string | undefined
          try { const res = await verifyEventIdentity(idEvent!, key); ok = res.ok; rPub = res.rPub } catch { ok = false }
          if (cancelled) return
          if (!ok) return // present-but-invalid identity ⇒ forged poll, drop it
          if (rPub) setPollRealPubkey(rPub)
        }
      }

      const plaintext = await aesDecrypt(key, poll.content).catch(() => null)
      if (cancelled || plaintext == null) return
      try {
        const parsed = JSON.parse(plaintext)
        setDecrypted({
          id: poll.id,
          pubkey: poll.pubkey,
          createdAt: poll.createdAt,
          text: parsed.text || '',
          options: parsed.options || [],
          polltype: parsed.polltype || 'singlechoice',
          endsAt: parsed.endsAt,
          allowVoteChange: parsed.allowVoteChange !== false, // default true for backwards compat
          showResultsBeforeVoting: parsed.showResultsBeforeVoting === true,
          showVoterIdentity: parsed.showVoterIdentity === true,
        })
      } catch {
        // Failed to parse
      }
    })()
    return () => { cancelled = true }
  }, [poll, getChannelKey, hubs, hubDTag])

  // Fetch votes on mount
  useEffect(() => {
    if (fetchedRef.current || !decrypted) return
    fetchedRef.current = true
    fetchVotes(poll.id, hubDTag, poll.createdAt, decrypted.endsAt)
  }, [decrypted, poll.id, hubDTag, poll.createdAt, fetchVotes])

  // Decrypt votes
  useEffect(() => {
    const key = getChannelKey(poll.epoch)
    if (!key || votes.length === 0) return

    const hub = hubs[hubDTag]
    const v2 = hub ? isV2(hub) : false

    Promise.all(
      votes.map(async (v) => {
        try {
          const plaintext = await aesDecrypt(key, v.content)
          const parsed = JSON.parse(plaintext)
          // v2: the vote MUST carry a verifiable identity tag (every legit vote is authored via
          // signHubMemberEvent, which attaches one). Resolve the voter's real key R from it (P → R)
          // for own-vote detection + display, and DROP votes whose identity doesn't verify — otherwise
          // an event authored under an arbitrary P with a missing/forged identity tag would be tallied.
          let realPubkey = v.pubkey
          if (v2) {
            if (!v.rawEvent) return null
            try {
              const res = await verifyEventIdentity(JSON.parse(v.rawEvent) as Event, key)
              if (!res.ok || !res.rPub) return null
              realPubkey = res.rPub
            } catch { return null }
          }
          return { pubkey: v.pubkey, realPubkey, response: parsed.response || [], createdAt: v.createdAt } as DecryptedVote
        } catch {
          return null
        }
      })
    ).then((results) => {
      setDecryptedVotes(results.filter(Boolean) as DecryptedVote[])
    })
  }, [votes, getChannelKey, hubs, hubDTag])

  // Filter votes to only those within the valid time window
  const validVotes = useMemo(() => {
    if (!decrypted) return decryptedVotes
    return decryptedVotes.filter((v) => {
      // Must be after poll creation
      if (v.createdAt < decrypted.createdAt) return false
      // Must be before poll end (if set)
      if (decrypted.endsAt && v.createdAt > decrypted.endsAt) return false
      return true
    })
  }, [decryptedVotes, decrypted])

  // Computed state
  const isExpired = decrypted?.endsAt ? decrypted.endsAt < Math.floor(Date.now() / 1000) : false
  const myVote = validVotes.find((v) => v.realPubkey === pubkey)
  const hasVoted = !!myVote
  const totalVotes = validVotes.length

  // Determine if results should be displayed
  const resultsVisible = useMemo(() => {
    if (isExpired) return true
    if (hasVoted && selectedOptions.length === 0) return true // voted and not changing
    if (showResults && decrypted?.showResultsBeforeVoting) return true
    return false
  }, [isExpired, hasVoted, selectedOptions.length, showResults, decrypted?.showResultsBeforeVoting])

  // Tally votes per option
  const tally = useMemo(() => {
    if (!decrypted) return {}
    const counts: Record<string, number> = {}
    for (const opt of decrypted.options) {
      counts[opt.id] = 0
    }
    for (const vote of validVotes) {
      for (const optId of vote.response) {
        if (counts[optId] !== undefined) counts[optId]++
      }
    }
    return counts
  }, [decrypted, validVotes])

  const maxVoteCount = Math.max(...Object.values(tally), 1)

  // Get voters for a specific option
  const getVotersForOption = useCallback((optionId: string) => {
    return validVotes.filter((v) => v.response.includes(optionId)).map((v) => ({ pubkey: v.realPubkey }))
  }, [validVotes])

  // Handle option select
  const handleOptionClick = (optionId: string) => {
    if (isExpired || voting || resultsVisible) return
    if (decrypted?.polltype === 'singlechoice') {
      setSelectedOptions([optionId])
    } else {
      setSelectedOptions((prev) =>
        prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId]
      )
    }
  }

  // Submit vote
  const handleVote = async () => {
    if (selectedOptions.length === 0 || voting) return
    setVoting(true)
    try {
      await castVote(poll.id, selectedOptions)
      setSelectedOptions([])
      setShowResults(false)
    } catch (err) {
      console.error('[Poll] Failed to cast vote:', err)
    } finally {
      setVoting(false)
    }
  }

  // Change Vote
  const handleChangeVote = () => {
    if (myVote) {
      setSelectedOptions(myVote.response)
    }
  }

  const isChangingVote = hasVoted && selectedOptions.length > 0

  // Time remaining
  const timeRemaining = useMemo(() => {
    if (!decrypted?.endsAt) return null
    const now = Math.floor(Date.now() / 1000)
    const diff = decrypted.endsAt - now
    if (diff <= 0) return 'Ended'
    if (diff < 3600) return `${Math.ceil(diff / 60)}m left`
    if (diff < 86400) return `${Math.ceil(diff / 3600)}h left`
    return `${Math.ceil(diff / 86400)}d left`
  }, [decrypted?.endsAt])

  // Creator profile — resolve the real member R (v2 authors under pseudonym P)
  const creatorProfile = getProfile(pollRealPubkey)
  const creatorName = creatorProfile?.display_name || creatorProfile?.name || truncateNpub(pollRealPubkey)

  // Hidden poll placeholder — non-privileged users see a minimal placeholder
  // Check before decryption so we don't show a loading skeleton for hidden polls
  if (isHidden && !canHide) {
    return (
      <div className="mt-4 py-2 px-3 -mx-2 rounded-lg border border-border/40 bg-muted/30">
        <div className="flex items-center gap-2.5 text-muted-foreground/60">
          <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted/60 shrink-0">
            <EyeOff size={12} />
          </div>
          <span className="text-xs font-medium">Poll hidden by moderator</span>
        </div>
      </div>
    )
  }

  // Hidden poll — mod/creator collapsed view (click to reveal)
  if (isHidden && canHide && !hiddenPreviewRevealed) {
    return (
      <div className="mt-4 py-2 px-3 -mx-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/15 shrink-0">
            <EyeOff size={12} className="text-amber-400" />
          </div>
          <span className="text-xs font-medium text-amber-400">Poll hidden by {hiddenBy || 'moderator'}</span>
          <button
            onClick={() => setHiddenPreviewRevealed(true)}
            className="ml-auto text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer font-medium"
          >
            Show
          </button>
        </div>
      </div>
    )
  }

  if (!decrypted) {
    return (
      <div className="flex items-start gap-4 py-1 px-2 -mx-2 mt-4">
        <div className="w-10 h-10 rounded-full bg-secondary/60 animate-pulse shrink-0" />
        <div className="flex-1 min-w-0 animate-pulse">
          <div className="h-3.5 w-32 bg-secondary/60 rounded mb-2" />
          <div className="h-4 w-48 bg-secondary/60 rounded mb-2" />
          <div className="space-y-1.5">
            <div className="h-8 bg-secondary/40 rounded-lg" />
            <div className="h-8 bg-secondary/40 rounded-lg" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      id={`msg-${poll.id}`}
      ref={rowRef}
      className={`flex items-start gap-4 py-1 px-2 -mx-2 mt-4 rounded-md group hover:bg-accent/30 relative transition-colors duration-100 ${highlighted ? 'bg-primary/10' : ''} ${isHidden && canHide ? 'border border-amber-500/30 bg-amber-500/5' : ''}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={handleMouseLeave}
    >
      {/* Avatar */}
      <button onClick={() => onOpenProfile(pollRealPubkey)} className="shrink-0 cursor-pointer">
        <Avatar className="h-10 w-10 mt-0.5">
          {creatorProfile?.picture && <AvatarImage src={creatorProfile.picture} alt={creatorName} />}
          <AvatarFallback className="text-xs bg-primary/20 text-primary">
            {creatorName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </button>

      <div className="min-w-0 flex-1">
        {/* Name + timestamp header */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onOpenProfile(pollRealPubkey)}
            className="text-sm font-semibold cursor-pointer hover:underline text-foreground"
          >
            {creatorName}
          </button>
          <span className="text-xs text-muted-foreground cursor-default">
            {formatTimestamp(poll.createdAt)}
          </span>
          {timeRemaining && (
            <span className={cn('text-[10px] flex items-center gap-1', isExpired ? 'text-red-400' : 'text-muted-foreground')}>
              <Clock size={10} /> {timeRemaining}
            </span>
          )}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="p-0.5 text-muted-foreground/40 cursor-help">
                  <Info size={12} />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs max-w-[240px]">
                Votes can be modified outside the client. Results may not be fully tamper-proof.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {isHidden && canHide && (
            <button
              onClick={() => setHiddenPreviewRevealed(false)}
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium cursor-pointer select-none ml-1 hover:bg-amber-500/25 transition-colors"
            >
              hidden by {hiddenBy || 'moderator'}
            </button>
          )}
        </div>

        {/* Poll body */}
        <div className="mt-1.5 rounded-xl bg-secondary/20 border border-border/40 overflow-hidden max-w-md">
          {/* Question */}
          <div className="px-4 pt-3 pb-2">
            <div className="flex items-center gap-2 mb-1">
              <Vote size={14} className="text-primary shrink-0" />
              <span className="text-[11px] font-medium text-muted-foreground">Poll</span>
            </div>
            <h4 className="text-sm font-semibold text-foreground leading-snug">{decrypted.text}</h4>
          </div>

          {/* Options */}
          <div className="px-4 pb-2 space-y-1.5">
            {decrypted.options.map((option) => {
              const count = tally[option.id] || 0
              const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0
              const isMyChoice = myVote?.response.includes(option.id)
              const isSelected = selectedOptions.includes(option.id)
              const isLeading = count === maxVoteCount && count > 0

              return (
                <div key={option.id} className="flex items-center gap-1">
                  <button
                    onClick={() => !resultsVisible && handleOptionClick(option.id)}
                    disabled={(isExpired && !resultsVisible) || resultsVisible}
                    className={cn(
                      'relative flex-1 text-left rounded-lg transition-all duration-200 overflow-hidden border',
                      resultsVisible
                        ? 'cursor-default border-border/30 bg-secondary/20'
                        : cn(
                          'cursor-pointer hover:border-primary/40',
                          isSelected ? 'border-primary/50 bg-primary/8' : 'border-border/30 bg-secondary/10 hover:bg-secondary/30'
                        )
                    )}
                  >
                    {/* Progress bar background */}
                    {resultsVisible && (
                      <div
                        className={cn(
                          'absolute inset-0 transition-all duration-500 rounded-lg',
                          isLeading ? 'bg-primary/12' : 'bg-secondary/30'
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    )}
                    <div className="relative flex items-center justify-between px-3 py-2 z-10">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {/* Checkbox / radio indicator */}
                        {!resultsVisible && (
                          decrypted.polltype === 'singlechoice' ? (
                            /* Radio — outer ring + inner dot */
                            <div
                              className="w-[18px] h-[18px] shrink-0 rounded-full border-2 flex items-center justify-center transition-all duration-200"
                              style={{ borderColor: isSelected ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.35)' }}
                            >
                              <div className={cn(
                                'rounded-full bg-primary transition-all duration-200',
                                isSelected ? 'w-2.5 h-2.5 scale-100' : 'w-0 h-0 scale-0'
                              )} />
                            </div>
                          ) : (
                            /* Checkbox — outer border + inner filled rounded square */
                            <div
                              className="w-[18px] h-[18px] shrink-0 rounded-[5px] border-2 flex items-center justify-center transition-all duration-200"
                              style={{ borderColor: isSelected ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.35)' }}
                            >
                              <div className={cn(
                                'rounded-[2px] bg-primary transition-all duration-200',
                                isSelected ? 'w-2.5 h-2.5 scale-100' : 'w-0 h-0 scale-0'
                              )} />
                            </div>
                          )
                        )}
                        {resultsVisible && isMyChoice && (
                          <Check size={14} className="text-primary shrink-0" />
                        )}
                        <span className={cn('text-sm truncate', isMyChoice && resultsVisible ? 'font-medium text-foreground' : 'text-foreground/90')}>
                          {option.label}
                        </span>
                      </div>
                      {resultsVisible && (
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className="text-xs text-muted-foreground">{count}</span>
                          <span className={cn('text-xs font-medium min-w-[36px] text-right', isLeading ? 'text-primary' : 'text-muted-foreground')}>
                            {pct}%
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                  {/* Voter identity eye button */}
                  {resultsVisible && decrypted.showVoterIdentity && (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setVotersModal({ optionId: option.id, optionLabel: option.label })}
                            className="p-1 rounded cursor-pointer text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
                          >
                            <Eye size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="text-xs">See who voted</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              )
            })}
          </div>

          {/* Footer */}
          <div className="px-4 pb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                {totalVotes} vote{totalVotes !== 1 ? 's' : ''}
              </span>
              {decrypted.polltype === 'multiplechoice' && (
                <span className="text-[10px] text-muted-foreground/60">• Multiple choice</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* "See Results" button for non-voters when showResultsBeforeVoting is enabled */}
              {!isExpired && !hasVoted && decrypted.showResultsBeforeVoting && !showResults && selectedOptions.length === 0 && (
                <button
                  onClick={() => setShowResults(true)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1"
                >
                  <Eye size={12} /> See Results
                </button>
              )}
              {/* Back to voting from results view */}
              {!isExpired && !hasVoted && showResults && (
                <button
                  onClick={() => setShowResults(false)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1"
                >
                  <EyeOff size={12} /> Hide Results
                </button>
              )}
              {/* Vote button */}
              {!isExpired && !hasVoted && selectedOptions.length > 0 && !showResults && (
                <Button size="sm" className="h-7 text-xs px-3" onClick={handleVote} disabled={voting}>
                  {voting ? 'Voting...' : 'Vote'}
                </Button>
              )}
              {/* Change Vote (only if allowed) */}
              {!isExpired && hasVoted && !isChangingVote && decrypted.allowVoteChange && (
                <button
                  onClick={handleChangeVote}
                  className="text-[11px] text-primary/70 hover:text-primary transition-colors cursor-pointer"
                >
                  Change Vote
                </button>
              )}
              {/* Changing vote actions */}
              {!isExpired && isChangingVote && (
                <>
                  <button
                    onClick={() => setSelectedOptions([])}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <Button size="sm" className="h-7 text-xs px-3" onClick={handleVote} disabled={voting}>
                    {voting ? 'Updating...' : 'Update Vote'}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
        {/* Reaction pills */}
        {reactions && onAddReaction && (
          <ReactionBar reactions={reactions} messageId={poll.id} onAddReaction={onAddReaction} />
        )}

        {/* Hover action bar */}
        {showActions && (
          <MessageActionBar
            isMine={isMine}
            msgId={poll.id}
            msgDTag=""
            msgPubkey={poll.pubkey}
            emojiButtonRef={emojiButtonRef}
            showMenu={showMenu}
            setShowMenu={setShowMenu}
            onEmoji={() => setShowEmoji(!showEmoji)}
            onEdit={() => { }}
            hideEdit
            onReply={() => onReply?.({ id: poll.id, pubkey: poll.pubkey, content: decrypted?.text || 'Poll' })}
            onThreadReply={() => onThreadReply?.({ id: poll.id, pubkey: poll.pubkey, content: decrypted?.text || 'Poll' })}
            onRequestDelete={() => onRequestDelete?.(poll.id)}
            rawEvent={poll.rawEvent}
            onViewRaw={(raw) => onViewRaw?.(raw)}
            hideThreadReply={false}
            hideReply={false}
            canPublish={canPublish ?? false}
            hubDTag={hubDTag}
            channelId={channelId}
            onHideMessage={onHideMessage}
            onUnhideMessage={onUnhideMessage}
            isHidden={isHidden}
          />
        )}
        {showEmoji && onAddReaction && (
          <EmojiPickerPopover
            anchorRef={emojiButtonRef}
            onClose={() => setShowEmoji(false)}
            onSelect={(emoji, custom) => { onAddReaction(poll.id, emoji, custom?.url); setShowEmoji(false); setShowActions(false) }}
          />
        )}
      </div>

      {/* Voters modal */}
      {votersModal && (
        <VotersModal
          optionLabel={votersModal.optionLabel}
          voters={getVotersForOption(votersModal.optionId)}
          onClose={() => setVotersModal(null)}
        />
      )}
    </div>
  )
}

