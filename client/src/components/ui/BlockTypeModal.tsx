/**
 * BlockTypeModal — Asks the user whether to block publicly or privately.
 *
 * Public: visible to WoT followers, helps others filter unwanted users.
 * Private: encrypted, only visible to self.
 */

import { Globe, Lock, X } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import type { BlockType } from '@/stores/blockStore'

interface BlockTypeModalProps {
  open: boolean
  onClose: () => void
  onSelect: (type: BlockType) => void
  /** Display name of the user being blocked */
  displayName?: string
}

export function BlockTypeModal({ open, onClose, onSelect, displayName }: BlockTypeModalProps) {
  useEscToClose(onClose, open)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative z-10 w-full max-w-[360px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">
            Block {displayName ? `"${displayName}"` : 'User'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        {/* Options */}
        <div className="p-4 space-y-2.5">
          <p className="text-xs text-muted-foreground mb-3">
            Choose how you want to block this user:
          </p>

          {/* Private block */}
          <button
            onClick={() => onSelect('private')}
            className="w-full flex items-start gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60 hover:border-border/80 transition-all cursor-pointer text-left group"
          >
            <Lock size={16} className="text-muted-foreground mt-0.5 shrink-0 group-hover:text-foreground transition-colors" />
            <div>
              <p className="text-sm font-medium text-foreground">Block Privately</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Only you will see this block. Others won't know you've blocked this person.
              </p>
            </div>
          </button>

          {/* Public block */}
          <button
            onClick={() => onSelect('public')}
            className="w-full flex items-start gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60 hover:border-border/80 transition-all cursor-pointer text-left group"
          >
            <Globe size={16} className="text-muted-foreground mt-0.5 shrink-0 group-hover:text-foreground transition-colors" />
            <div>
              <p className="text-sm font-medium text-foreground">Block Publicly</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Your followers and Web of Trust connections will see this block, helping them filter unwanted users.
              </p>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
