/**
 * HubMessageCard — Inline card for rendering hub chat message links (naddr for kind 36943)
 *
 * States:
 * 1. Loading — fetching event from relays
 * 2. Not found — event not found
 * 3. Not a member — user doesn't have the hub in their hub list
 * 4. Encrypted — user is a member but can't decrypt (missing secret / wrong epoch)
 * 5. Decrypted — shows message preview with "Go to Message" button
 */

import { useState, useEffect } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents, subscribeToRelays } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import {
  MessageSquare, ExternalLink, Lock, Loader2, AlertTriangle,
} from 'lucide-react'

interface HubMessageCardProps {
  /** naddr data */
  identifier: string
  pubkey: string
  relays?: string[]
}

interface FetchedMessage {
  id: string
  pubkey: string
  content: string
  createdAt: number
  hubDTag: string
  channelId: string
  dTag: string
}

export function HubMessageCard({ identifier, pubkey, relays }: HubMessageCardProps) {
  const hubs = useHubStore((s) => s.hubs)
  const hubEntries = useHubStore((s) => s.hubEntries)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const setActiveHub = useHubStore((s) => s.setActiveHub)
  const setActiveChannel = useHubStore((s) => s.setActiveChannel)
  const { getProfile } = useProfileCache()

  const [msg, setMsg] = useState<FetchedMessage | null>(null)
  const [loading, setLoading] = useState(true)
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null)
  const [decryptionFailed, setDecryptionFailed] = useState(false)

  // Fetch the message event
  useEffect(() => {
    let cancelled = false

    const filter: any = {
      kinds: [KINDS.MESSAGE],
      authors: [pubkey],
      '#d': [identifier],
      limit: 1,
    }

    const handleEvent = (event: any) => {
      if (cancelled) return
      const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1] || identifier
      const hubDTag = event.tags.find((t: string[]) => t[0] === 'h')?.[1]
      const channelId = event.tags.find((t: string[]) => t[0] === 'c')?.[1]

      if (!hubDTag || !channelId) return

      setMsg({
        id: event.id,
        pubkey: event.pubkey,
        content: event.content,
        createdAt: event.created_at,
        hubDTag,
        channelId,
        dTag,
      })
    }

    if (relays && relays.length > 0) {
      // Use relay hints from the naddr
      const sub = subscribeToRelays(
        relays,
        filter,
        handleEvent,
        () => {
          sub.close()
          if (!cancelled) setLoading(false)
        }
      )
      // Safety timeout
      const timer = setTimeout(() => { sub.close(); if (!cancelled) setLoading(false) }, 10000)
      return () => { cancelled = true; clearTimeout(timer); sub.close() }
    } else {
      // Fallback: fetch from default pool
      fetchEvents(filter).then((events) => {
        if (!cancelled && events.length > 0) {
          handleEvent(events[0])
        }
        if (!cancelled) setLoading(false)
      }).catch(() => {
        if (!cancelled) setLoading(false)
      })
      return () => { cancelled = true }
    }
  }, [identifier, pubkey, relays])

  // Attempt decryption once we have the message
  useEffect(() => {
    if (!msg) return

    const tryDecrypt = async () => {
      const secretHex = hubSecrets[msg.hubDTag]
      if (!secretHex) {
        setDecryptionFailed(true)
        return
      }

      const hub = hubs[msg.hubDTag]
      const epoch = hub?.epoch || 1

      try {
        const secret = new Uint8Array(secretHex.length / 2)
        for (let i = 0; i < secretHex.length; i += 2) {
          secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
        }

        const channelKey = deriveChannelKey(secret, msg.channelId, epoch)
        let content = await aesDecrypt(channelKey, msg.content)

        // Try parsing JSON format {text, attachments}
        try {
          const parsed = JSON.parse(content)
          if (parsed && typeof parsed.text === 'string') {
            content = parsed.text
          }
        } catch {
          // Not JSON — plain text, content stays as-is
        }

        setDecryptedContent(content)
      } catch {
        setDecryptionFailed(true)
      }
    }

    tryDecrypt()
  }, [msg, hubSecrets, hubs])

  // Check hub membership
  const isMember = msg ? hubEntries.some((e) => e.dTag === msg.hubDTag) || !!hubs[msg.hubDTag] : false

  const handleGoToMessage = () => {
    if (!msg) return

    // Navigate to the hub and channel
    setActiveHub(msg.hubDTag)
    setActiveChannel(msg.channelId)
    useNavigationStore.getState().setActivePage('hubs')

    // Dispatch time-travel event (MessageList listens for this)
    const aRef = `${KINDS.MESSAGE}:${msg.pubkey}:${msg.dTag}`
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pin-jump-to-message', { detail: { aRef } }))
    }, 300) // delay to allow channel to mount
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 max-w-[350px] animate-pulse">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-secondary" />
          <div className="h-3 bg-secondary rounded w-24" />
        </div>
        <div className="h-3 bg-secondary rounded w-full mt-2" />
        <div className="h-3 bg-secondary rounded w-3/4 mt-1" />
      </div>
    )
  }

  // ── Not found ──
  if (!msg) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 max-w-[350px] text-xs text-muted-foreground flex items-center gap-2">
        <AlertTriangle size={12} />
        Hub message not found
      </div>
    )
  }

  // Resolve author profile
  const profile = getProfile(msg.pubkey)
  const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(msg.pubkey))

  // Resolve hub name
  const hub = hubs[msg.hubDTag]
  const hubName = hub?.name || msg.hubDTag.slice(0, 12) + '…'

  // Resolve channel name
  const channel = hub?.channels.find((c) => c.channelId === msg.channelId)
  const channelName = channel?.name || msg.channelId.slice(0, 8) + '…'

  return (
    <div
      className="my-2 rounded-lg border border-border overflow-hidden bg-secondary/20 hover:bg-secondary/30 transition-colors max-w-[350px]"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header — hub/channel context */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/40 border-b border-border/50 text-[10px] text-muted-foreground">
        <MessageSquare size={10} className="shrink-0" />
        <span className="font-medium truncate">{hubName}</span>
        <span className="text-muted-foreground/50">›</span>
        <span className="truncate">#{channelName}</span>
      </div>

      <div className="p-3 space-y-2">
        {/* Author + timestamp */}
        <div className="flex items-center gap-2">
          <Avatar className="h-5 w-5">
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
              {authorName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-xs font-semibold text-foreground">{authorName}</span>
          <span className="text-[10px] text-muted-foreground">{formatTimestamp(msg.createdAt)}</span>
        </div>

        {/* Message content preview */}
        {!isMember ? (
          // Not a member
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Lock size={12} className="shrink-0 text-amber-400/70" />
            <span>You're not a member of this hub — join to view this message</span>
          </div>
        ) : decryptedContent ? (
          // Decrypted — show preview
          <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words line-clamp-4">
            {decryptedContent}
          </p>
        ) : decryptionFailed ? (
          // Failed to decrypt
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Lock size={12} className="shrink-0 text-red-400/70" />
            <span>Encrypted message — unable to decrypt</span>
          </div>
        ) : (
          // Still decrypting
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Loader2 size={12} className="animate-spin shrink-0" />
            <span>Decrypting…</span>
          </div>
        )}

        {/* Go to Message button — only if member AND decrypted */}
        {isMember && decryptedContent && (
          <button
            onClick={handleGoToMessage}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors cursor-pointer"
          >
            <ExternalLink size={12} />
            Go to Message
          </button>
        )}
      </div>
    </div>
  )
}
