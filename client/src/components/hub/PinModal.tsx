/**
 * PinModal — Shows pinned messages for a hub channel
 *
 * Creator's pins are shown first (expanded by default).
 * Other members' pins are behind a "Show others' pins" toggle,
 * each in a collapsible accordion section grouped by pinner.
 */

import { useState, useMemo, useCallback } from 'react'
import { X, Pin, ChevronDown, ChevronRight, ArrowRight, PinOff } from 'lucide-react'
import { usePinStore } from '@/stores/pinStore'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { useMessages, type ChatMessage } from '@/hooks/useMessages'

interface PinModalProps {
  hubDTag: string
  channelId: string
  onClose: () => void
  onJumpToMessage: (msgRef: string) => void
}

interface PinSection {
  pubkey: string
  displayName: string
  avatar?: string
  pins: {
    aRef: string
    message?: ChatMessage
  }[]
}

export function PinModal({ hubDTag, channelId, onClose, onJumpToMessage }: PinModalProps) {
  const { getProfile } = useProfileCache()
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  // Get decrypted messages for this channel
  const { messages } = useMessages(hubDTag, channelId)

  const hub = useHubStore((s) => hubDTag ? s.hubs[hubDTag] : null)
  const creatorPubkey = hub?.creatorPubkey

  // Select raw store data (stable reference) and filter in useMemo
  const hubPins = usePinStore((s) => s.pinsByHub[hubDTag])
  const unpinMessage = usePinStore((s) => s.unpinMessage)

  const [showOthers, setShowOthers] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

  // Build message lookup by addressable ref (kind:pubkey:dTag)
  const msgByRef = useMemo(() => {
    const map = new Map<string, ChatMessage>()
    for (const msg of messages) {
      const ref = `36943:${msg.pubkey}:${msg.dTag}`
      map.set(ref, msg)
    }
    return map
  }, [messages])

  // Filter pins for this channel and build sections grouped by pinner
  const { creatorSection, mySection, otherSections, totalOtherPins } = useMemo(() => {
    let creatorSection: PinSection | null = null
    let mySection: PinSection | null = null
    const otherSections: PinSection[] = []
    let totalOtherPins = 0

    if (!hubPins) return { creatorSection, mySection, otherSections, totalOtherPins }

    // Filter each pinner's pins to only include the current channel
    const channelPins = hubPins.map((pe) => ({
      ...pe,
      pins: pe.pins.filter((p) => p.channelId === channelId),
    })).filter((pe) => pe.pins.length > 0)

    for (const pe of channelPins) {
      const profile = getProfile(pe.pubkey)
      const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(pe.pubkey))
      const avatar = profile?.picture

      const section: PinSection = {
        pubkey: pe.pubkey,
        displayName,
        avatar,
        pins: pe.pins.map((p) => ({
          aRef: p.aRef,
          message: msgByRef.get(p.aRef),
        })),
      }

      if (pe.pubkey === creatorPubkey) {
        creatorSection = section
      } else if (pe.pubkey === myPubkey) {
        mySection = section
      } else {
        otherSections.push(section)
        totalOtherPins += section.pins.length
      }
    }

    // Add my pins to total if not creator
    if (mySection && myPubkey !== creatorPubkey) {
      totalOtherPins += mySection.pins.length
    }

    return { creatorSection, mySection, otherSections, totalOtherPins }
  }, [hubPins, channelId, msgByRef, creatorPubkey, myPubkey, getProfile])

  const toggleSection = (pubkey: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(pubkey)) next.delete(pubkey)
      else next.add(pubkey)
      return next
    })
  }

  const handleUnpin = useCallback(async (aRef: string) => {
    if (!myPubkey) return
    const relays = hub ? [...hub.generalRelays] : []
    await unpinMessage(hubDTag, channelId, aRef, myPubkey, relays, signer, privateKey)
  }, [myPubkey, hub, hubDTag, channelId, signer, privateKey, unpinMessage])

  const totalPins = (creatorSection?.pins.length || 0) + totalOtherPins

  const renderPinItem = (pin: { aRef: string; message?: ChatMessage }, canUnpin: boolean) => {
    const msg = pin.message
    const msgProfile = msg ? getProfile(msg.pubkey) : null
    const msgName = msgProfile?.display_name || msgProfile?.name || (msg ? truncateNpub(nip19.npubEncode(msg.pubkey)) : '?')

    return (
      <div key={pin.aRef} className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50 hover:bg-secondary/80 transition-colors group">
        {msg ? (
          <>
            <Avatar className="w-8 h-8 shrink-0 mt-0.5">
              <AvatarImage src={msgProfile?.picture} />
              <AvatarFallback className="text-[10px]">{msgName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-xs font-medium text-foreground">{msgName}</span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(msg.timestamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2 break-words">
                {msg.deleted ? (
                  <span className="italic">Message was deleted</span>
                ) : (
                  msg.content || <span className="italic">No text content</span>
                )}
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground italic">Message not loaded</p>
          </div>
        )}
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {msg && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs cursor-pointer"
              onClick={() => onJumpToMessage(pin.aRef)}
            >
              <ArrowRight size={12} className="mr-1" /> Jump
            </Button>
          )}
          {canUnpin && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive cursor-pointer"
              onClick={() => handleUnpin(pin.aRef)}
            >
              <PinOff size={12} className="mr-1" /> Unpin
            </Button>
          )}
        </div>
      </div>
    )
  }

  const renderAccordionSection = (section: PinSection, defaultExpanded: boolean = false) => {
    const isExpanded = defaultExpanded || expandedSections.has(section.pubkey)
    const isMe = section.pubkey === myPubkey

    return (
      <div key={section.pubkey} className="border border-border/50 rounded-lg overflow-hidden">
        <button
          onClick={() => !defaultExpanded && toggleSection(section.pubkey)}
          className={`flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-accent/30 transition-colors ${defaultExpanded ? '' : 'cursor-pointer'}`}
        >
          {!defaultExpanded && (
            isExpanded ? <ChevronDown size={14} className="text-muted-foreground shrink-0" /> : <ChevronRight size={14} className="text-muted-foreground shrink-0" />
          )}
          <Avatar className="w-5 h-5 shrink-0">
            <AvatarImage src={section.avatar} />
            <AvatarFallback className="text-[8px]">{section.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium text-foreground flex-1 truncate">
            {isMe ? 'Your Pins' : `${section.displayName}'s Pins`}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">{section.pins.length}</span>
        </button>
        {isExpanded && (
          <div className="px-3 py-3 space-y-2">
            {section.pins.map((pin) => renderPinItem(pin, isMe))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[500px] max-h-[70vh] bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Pin size={18} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Pinned Messages</h3>
            {totalPins > 0 && (
              <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-full">{totalPins}</span>
            )}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {totalPins === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Pin size={32} className="text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No pinned messages yet</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Right-click a message or use the ⋯ menu to pin it
              </p>
            </div>
          ) : (
            <>
              {/* Creator's pins — always shown, always expanded */}
              {creatorSection && (
                <div>
                  <div className="flex items-center gap-2 px-1 mb-2">
                    <Avatar className="w-5 h-5 shrink-0">
                      <AvatarImage src={creatorSection.avatar} />
                      <AvatarFallback className="text-[8px]">{creatorSection.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
                      {creatorSection.pubkey === myPubkey ? 'Your Pins' : `${creatorSection.displayName}'s Pins`}
                    </span>
                    <span className="text-xs text-muted-foreground">{creatorSection.pins.length}</span>
                  </div>
                  <div className="space-y-2">
                    {creatorSection.pins.map((pin) =>
                      renderPinItem(pin, creatorSection!.pubkey === myPubkey)
                    )}
                  </div>
                </div>
              )}

              {/* Others' pins toggle */}
              {(mySection || otherSections.length > 0) && (
                <>
                  <div className="h-px bg-border" />
                  <button
                    onClick={() => setShowOthers(!showOthers)}
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1"
                  >
                    {showOthers ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>Show others' pins</span>
                    <span className="text-muted-foreground/60">({totalOtherPins})</span>
                  </button>

                  {showOthers && (
                    <div className="space-y-2">
                      {/* Your pins (if you're not the creator) */}
                      {mySection && myPubkey !== creatorPubkey && renderAccordionSection(mySection)}
                      {/* Other members' pins */}
                      {otherSections.map((section) => renderAccordionSection(section))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
