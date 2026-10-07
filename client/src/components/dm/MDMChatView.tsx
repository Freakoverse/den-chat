/**
 * MDMChatView — NIP-MDM (Masked DM) chat view. See docs/NIP-MDM.md.
 *
 * Focused v1: text send/receive with the masked-sender model. The sender is hidden on the wire (the
 * recipient is addressed by their real key); each received message is verified per docs §1.3 and shown
 * with a trust badge. Reactions / attachments / edit UI are deferred to a later pass (the store and the
 * NIP-MDM lib already carry the self-copy + verification machinery).
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { nip19 } from 'nostr-tools'
import { useUserStore } from '@/stores/userStore'
import { useMdmStore } from '@/stores/dmMdmStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTimestamp } from '@/lib/utils'
import { Loader2, Send, ChevronLeft, VenetianMask, ShieldCheck, ShieldAlert } from 'lucide-react'

function shortNpub(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey)
    return `${npub.slice(0, 10)}…${npub.slice(-4)}`
  } catch {
    return `${pubkey.slice(0, 8)}…`
  }
}

export function MDMChatView({ recipientPubkey, onBack }: { recipientPubkey: string; onBack?: () => void }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const conversations = useMdmStore((s) => s.conversations)
  const setActive = useMdmStore((s) => s.setActiveConversation)

  const { getProfile } = useProfileCache()
  const profile = getProfile(recipientPubkey)
  const name = profile?.display_name || profile?.name || shortNpub(recipientPubkey)

  const messages = useMemo(() => conversations.get(recipientPubkey)?.messages ?? [], [conversations, recipientPubkey])

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Mark this conversation read on open.
  useEffect(() => { setActive(recipientPubkey) }, [recipientPubkey, setActive])

  // Autoscroll to newest.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const send = useCallback(async () => {
    const body = text.trim()
    if (!body || sending) return
    if (!myPubkey) { setError('Not signed in.'); return }
    setSending(true)
    setError(null)
    try {
      await useMdmStore.getState().sendMessage(recipientPubkey, body, myPubkey, signer, privateKey)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send.')
    } finally {
      setSending(false)
    }
  }, [text, sending, myPubkey, recipientPubkey, signer, privateKey])

  return (
    <div className="flex flex-col h-full min-h-0 bg-secondary/30 rounded-md overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 bg-secondary/50 shadow-sm flex items-center gap-2 shrink-0">
        {onBack && (
          <button onClick={onBack} className="min-[1081px]:hidden p-1 -ml-1 text-muted-foreground hover:text-foreground cursor-pointer">
            <ChevronLeft size={18} />
          </button>
        )}
        <Avatar className="h-8 w-8">
          <AvatarImage src={profile?.picture} alt={name} />
          <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground truncate">{name}</div>
          <div className="text-[11px] text-muted-foreground truncate">{shortNpub(recipientPubkey)}</div>
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                <VenetianMask size={11} /> Masked
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs max-w-[220px]">
              Your identity is hidden from relays: you write under a per-recipient masked key. The recipient
              is addressed by their real key.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-xs text-muted-foreground px-6">
            No masked messages yet. Your messages are sent under a key that hides you from relays.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.coord} className={`flex ${m.isMine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.isMine ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'}`}>
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
                <div className={`mt-0.5 flex items-center gap-1 text-[10px] ${m.isMine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                  <span>{formatTimestamp(m.createdAt)}</span>
                  {!m.isMine && !m.verified && (
                    <span className="inline-flex items-center gap-0.5 text-amber-500">
                      <ShieldAlert size={10} /> unverified
                    </span>
                  )}
                  {!m.isMine && m.verified && <ShieldCheck size={10} className="text-emerald-500" />}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 px-3 py-2 bg-secondary/50">
        {error && <div className="mb-1 text-[11px] text-destructive">{error}</div>}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            placeholder={`Message ${name} (masked)…`}
            rows={1}
            className="flex-1 resize-none max-h-32 rounded-lg bg-background border border-border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !text.trim()}
            className="h-9 w-9 shrink-0 flex items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40 cursor-pointer"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}
