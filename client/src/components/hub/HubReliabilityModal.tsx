/**
 * Explains the "History at risk" indicator: a hub that runs no dedicated relay and/or Blossom server has
 * only best-effort retention on shared public servers (NIP-CHAT 6.1.1). Opened from the amber warning icon
 * in the hub header. A future "help me set this up" button (pointing to a setup page) will live here.
 */

import { X, AlertTriangle, Settings } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import type { HubData } from '@/stores/hubStore'

interface HubReliabilityModalProps {
  open: boolean
  onClose: () => void
  hub: HubData
  isCreator: boolean
  /** Owners only: open Hub Settings on the Network page to mark a dedicated relay/server. */
  onOpenNetworkSettings?: () => void
}

export function HubReliabilityModal({ open, onClose, hub, isCreator, onOpenNetworkSettings }: HubReliabilityModalProps) {
  useEscToClose(onClose, open)
  if (!open) return null

  const hasDedicatedRelay = (hub.dedicatedRelays || []).some((r) => hub.generalRelays.includes(r))
  const hasDedicatedBlossom = (hub.dedicatedBlossomServers || []).some((s) => hub.blossomServers.includes(s))

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-2">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md max-h-[85vh] flex flex-col rounded-xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-500" /> History may not be reliable
          </h2>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 overflow-y-auto text-sm text-muted-foreground leading-relaxed space-y-3">
          <p>
            {!hasDedicatedRelay && !hasDedicatedBlossom
              ? 'This hub runs no dedicated relay or Blossom server of its own.'
              : !hasDedicatedRelay
                ? 'This hub runs no dedicated relay of its own.'
                : 'This hub runs no dedicated Blossom server of its own.'}
          </p>
          <p>
            DEN is a client, like a web browser, not a host. A hub's data lives wherever its relays and Blossom servers are, and <span className="text-foreground font-medium">shared public servers can drop, evict, or garbage-collect it at any time</span>. Without a server the hub operates itself, nobody is committed to keeping its history, so over time it may become incomplete or disappear.
          </p>
          <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 space-y-1.5">
            <p className="text-xs font-medium text-foreground">What is at risk here:</p>
            {!hasDedicatedRelay && (
              <p className="text-xs">Via relays: the hub's <span className="text-foreground">messages</span> and other events.</p>
            )}
            {!hasDedicatedBlossom && (
              <p className="text-xs">Via Blossom: the hub's <span className="text-foreground">media</span> and <span className="text-foreground">vital hub files</span> (the member list, structure, and key material).</p>
            )}
          </div>
          <p>
            The fix is for the hub to run (or rent) its own relay{!hasDedicatedBlossom && ' and Blossom server'}, then mark it <span className="text-foreground font-medium">Dedicated</span> in the hub's Network settings. A dedicated server commits to retaining this hub's data instead of leaving it to shared servers.
          </p>
          {!isCreator && (
            <p className="text-xs">You are not this hub's owner. If this matters to you, let the owner know, only they can set up a dedicated server.</p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border shrink-0 flex items-center justify-end gap-2">
          {isCreator && onOpenNetworkSettings && (
            <button
              onClick={onOpenNetworkSettings}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 cursor-pointer"
            >
              <Settings size={13} /> Open Network settings
            </button>
          )}
          {/* TODO: a "Help me set this up" button leading to a setup/rent page will go here. */}
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 cursor-pointer">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
