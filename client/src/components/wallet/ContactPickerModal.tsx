/**
 * ContactPickerModal — Select a recipient from the user's Nostr follows
 *
 * Shows a searchable list of followed profiles with avatars and names.
 * When selected, returns the pubkey hex which gets converted to npub in the parent.
 */

import { useState, useMemo } from 'react'
import { X, Search, UserPlus, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useFollowStore } from '@/stores/followStore'
import { useProfileCache, type NostrProfile } from '@/hooks/useProfileCache'
import { nip19 } from 'nostr-tools'

function truncateHex(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`
}

interface ContactPickerProps {
  onSelect: (npub: string) => void
  onClose: () => void
}

export function ContactPickerModal({ onSelect, onClose }: ContactPickerProps) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const followedPubkeys = useFollowStore((s) => s.followedPubkeys)
  const { getProfile } = useProfileCache()

  // Convert Set to array and enrich with profiles
  const contacts = useMemo(() => {
    const list = Array.from(followedPubkeys).map((pubkey) => {
      const profile = getProfile(pubkey)
      return {
        pubkey,
        name: profile?.display_name || profile?.name || '',
        picture: profile?.picture || '',
        nip05: profile?.nip05 || '',
        npub: nip19.npubEncode(pubkey),
      }
    })
    // Sort: profiles with names first, then by name
    list.sort((a, b) => {
      if (a.name && !b.name) return -1
      if (!a.name && b.name) return 1
      return a.name.localeCompare(b.name)
    })
    return list
  }, [followedPubkeys, getProfile])

  // Filter by search query
  const filtered = useMemo(() => {
    if (!search.trim()) return contacts
    const q = search.toLowerCase()
    return contacts.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.nip05.toLowerCase().includes(q) ||
      c.npub.includes(q) ||
      c.pubkey.includes(q)
    )
  }, [contacts, search])

  const handleAdd = () => {
    if (selected) {
      const contact = contacts.find((c) => c.pubkey === selected)
      if (contact) {
        onSelect(contact.npub)
      }
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4 max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <UserPlus size={16} />
            Select Contact
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-border/50 shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, npub, or NIP-05..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-secondary/40 border border-border/50 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 transition-colors"
              autoFocus
            />
          </div>
        </div>

        {/* Contact list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {contacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Loading follows...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-muted-foreground">No matches found</p>
            </div>
          ) : (
            filtered.map((contact) => {
              const isSelected = selected === contact.pubkey
              return (
                <button
                  key={contact.pubkey}
                  onClick={() => setSelected(isSelected ? null : contact.pubkey)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all cursor-pointer mb-0.5',
                    isSelected
                      ? 'bg-primary/10 border border-primary/30'
                      : 'hover:bg-secondary/40 border border-transparent'
                  )}
                >
                  {/* Avatar */}
                  {contact.picture ? (
                    <img
                      src={contact.picture}
                      alt=""
                      className="w-9 h-9 rounded-full object-cover shrink-0 bg-secondary"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-muted-foreground">
                        {contact.name ? contact.name[0].toUpperCase() : '?'}
                      </span>
                    </div>
                  )}

                  {/* Name + npub */}
                  <div className="flex-1 min-w-0 text-left">
                    <p className={cn(
                      'text-sm font-medium leading-tight truncate',
                      isSelected ? 'text-primary' : 'text-foreground'
                    )}>
                      {contact.name || truncateHex(contact.pubkey)}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                      {contact.nip05 || `${contact.npub.slice(0, 16)}…${contact.npub.slice(-8)}`}
                    </p>
                  </div>

                  {/* Selection indicator */}
                  <div className={cn(
                    'w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                    isSelected
                      ? 'border-primary bg-primary'
                      : 'border-border'
                  )}>
                    {isSelected && (
                      <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border shrink-0">
          <Button
            variant="default"
            className="w-full h-10 rounded-xl gap-2"
            disabled={!selected}
            onClick={handleAdd}
          >
            <UserPlus size={14} />
            Add Recipient
          </Button>
        </div>
      </div>
    </div>
  )
}
