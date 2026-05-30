/**
 * InviteModal — Invite users to the current hub
 *
 * Two sections:
 * - Copy hub address (naddr1...) to clipboard
 * - Search follows list, select a user, send DM invite
 */

import { useState, useMemo } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useDMStore } from '@/stores/dmStore'
import { useFollowStore } from '@/stores/followStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { X, Search, Copy, Check, Send, Link, Loader2 } from 'lucide-react'
import type { HubData } from '@/stores/hubStore'

interface InviteModalProps {
  open: boolean
  onClose: () => void
  hub: HubData
}

export function InviteModal({ open, onClose, hub }: InviteModalProps) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const sendMessage = useDMStore((s) => s.sendMessage)
  const followedPubkeys = useFollowStore((s) => s.followedPubkeys)
  const { getProfile } = useProfileCache()

  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  // Generate hub naddr (must be before early return — hooks depend on it)
  const hubAddress = useMemo(() => nip19.naddrEncode({
    identifier: hub.dTag,
    pubkey: hub.creatorPubkey,
    kind: 36942,
    relays: hub.generalRelays.slice(0, 3),
  }), [hub.dTag, hub.creatorPubkey, hub.generalRelays])

  // Filter follows by search
  const follows = useMemo(() => {
    const list = Array.from(followedPubkeys).filter(pk => pk !== myPubkey)
    if (!search.trim()) return list

    const q = search.toLowerCase().trim()
    return list.filter((pk) => {
      const profile = getProfile(pk)
      const name = (profile?.display_name || profile?.name || '').toLowerCase()
      const npub = nip19.npubEncode(pk).toLowerCase()
      const nip05 = (profile?.nip05 || '').toLowerCase()
      return name.includes(q) || npub.includes(q) || nip05.includes(q)
    })
  }, [search, followedPubkeys, getProfile, myPubkey])

  if (!open) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(hubAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
      const el = document.createElement('textarea')
      el.value = hubAddress
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleSendInvite = async () => {
    if (!selected || !myPubkey || sending) return
    setSending(true)
    setSendError(null)
    try {
      const content = `Join this DEN Chat hub:\n${hubAddress}`
      await sendMessage(selected, content, myPubkey, signer, privateKey)
      setSent(true)
      setTimeout(() => {
        setSent(false)
        setSelected(null)
      }, 2000)
    } catch (err: any) {
      setSendError(err?.message || 'Failed to send invite')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60" onClick={onClose}>
      <div
        className="bg-background rounded-xl w-full max-w-md max-h-[75vh] overflow-hidden shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-base font-semibold text-foreground">Invite to {hub.name}</h3>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-accent/50 transition-colors cursor-pointer">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        {/* Copy Hub Address */}
        <div className="px-4 pt-4 pb-3 border-b border-border space-y-2">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Link size={12} />
            Hub Address
          </label>
          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs text-muted-foreground font-mono bg-secondary/50 px-3 py-2 rounded-lg truncate select-all">
              {hubAddress}
            </div>
            <button
              onClick={handleCopy}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer"
            >
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
            </button>
          </div>
        </div>

        {/* DM Invite Section */}
        <div className="px-4 pt-3 pb-2">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Send size={12} />
            Send Invite by DM
          </label>
        </div>

        {/* Search */}
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search follows by name or npub..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
        </div>

        {/* User list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
          {follows.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              {search ? 'No follows match your search.' : 'No follows yet.'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {follows.map((pk) => {
                const profile = getProfile(pk)
                const npubStr = nip19.npubEncode(pk)
                const displayName = profile?.display_name || profile?.name || truncateNpub(npubStr, 10)
                const isSelected = selected === pk
                return (
                  <button
                    key={pk}
                    onClick={() => setSelected(isSelected ? null : pk)}
                    className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors cursor-pointer text-left
                      ${isSelected
                        ? 'bg-primary/15 border border-primary/30'
                        : 'hover:bg-secondary/50 border border-transparent'
                      }`}
                  >
                    <Avatar className="h-9 w-9">
                      {profile?.picture && <AvatarImage src={profile.picture} />}
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">
                        {displayName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {profile?.nip05 || truncateNpub(npubStr, 16)}
                      </p>
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                        <div className="w-2 h-2 rounded-full bg-white" />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border space-y-2">
          {sendError && (
            <p className="text-xs text-destructive">{sendError}</p>
          )}
          <button
            onClick={handleSendInvite}
            disabled={!selected || sending}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? (
              <><Loader2 size={14} className="animate-spin" /> Sending...</>
            ) : sent ? (
              <><Check size={14} /> Invite Sent!</>
            ) : (
              <><Send size={14} /> Send Invite by DM</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
