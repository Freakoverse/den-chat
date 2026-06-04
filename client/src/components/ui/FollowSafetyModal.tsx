/**
 * FollowSafetyModal — Warning dialog shown when a user tries to follow someone
 * but their local follow list is empty or failed to load.
 *
 * This is a last line of defense against accidentally wiping a follow list.
 * Gives the user 3 options: Cancel, Retry Fetch, Follow Anyway.
 */

import { useState } from 'react'
import { AlertTriangle, RotateCw, UserPlus, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFollowStore, type FollowLoadStatus } from '@/stores/followStore'
import { useUserStore } from '@/stores/userStore'

interface FollowSafetyModalProps {
  open: boolean
  onClose: () => void
  /** The pubkey the user wants to follow */
  targetPubkey: string
  /** Called after the user confirms they want to proceed */
  onConfirmFollow: () => void
  /** Current safety status */
  status: 'empty-list' | 'not-loaded' | 'load-error'
}

export function FollowSafetyModal({
  open,
  onClose,
  targetPubkey,
  onConfirmFollow,
  status,
}: FollowSafetyModalProps) {
  const [refetching, setRefetching] = useState(false)
  const [refetchResult, setRefetchResult] = useState<'none' | 'success' | 'still-empty' | 'error'>('none')
  const pubkey = useUserStore((s) => s.pubkey)
  const refetchFollowList = useFollowStore((s) => s.refetchFollowList)
  const followedPubkeys = useFollowStore((s) => s.followedPubkeys)
  const loadStatus = useFollowStore((s) => s.loadStatus)

  if (!open) return null

  const handleRetry = async () => {
    if (!pubkey) return
    setRefetching(true)
    setRefetchResult('none')
    try {
      await refetchFollowList(pubkey)
      // Check the result after refetch
      const updated = useFollowStore.getState()
      if (updated.loadStatus === 'error') {
        setRefetchResult('error')
      } else if (updated.followedPubkeys.size === 0) {
        setRefetchResult('still-empty')
      } else {
        setRefetchResult('success')
        // Follow list recovered — auto-close and proceed
        setTimeout(() => {
          onClose()
          onConfirmFollow()
        }, 500)
      }
    } catch {
      setRefetchResult('error')
    } finally {
      setRefetching(false)
    }
  }

  const isEmptyOrFailed = status === 'empty-list' || status === 'load-error'

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[200]"
      onClick={() => !refetching && onClose()}
    >
      <div
        className="bg-card border border-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center">
            <AlertTriangle size={20} className="text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-foreground">Follow List Warning</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {status === 'load-error' ? (
                <>Your follow list <strong>failed to load</strong> from relays. Following someone now would publish a new follow list with <strong>only that person</strong>, potentially erasing your existing follows.</>
              ) : status === 'not-loaded' ? (
                <>Your follow list <strong>hasn't finished loading</strong> yet. Following someone now could publish an incomplete list, potentially erasing your existing follows.</>
              ) : (
                <>Your follow list appears to be <strong>empty</strong>. If you have follows on other clients (Damus, Primal, etc.), continuing would overwrite them. If you're a new user, this is normal.</>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Refetch result feedback */}
        {refetchResult === 'success' && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm mb-4">
            <span>✓ Follow list recovered ({followedPubkeys.size} follows). Proceeding...</span>
          </div>
        )}
        {refetchResult === 'still-empty' && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm mb-4">
            <AlertTriangle size={14} className="shrink-0" />
            <span>Follow list is still empty after re-fetching. You may be a new user, or relays may not have your list.</span>
          </div>
        )}
        {refetchResult === 'error' && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm mb-4">
            <AlertTriangle size={14} className="shrink-0" />
            <span>Failed to fetch follow list from relays. Check your connection.</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={refetching}
            className="gap-1.5"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={refetching || refetchResult === 'success'}
            className="gap-1.5"
          >
            {refetching ? (
              <><Loader2 size={13} className="animate-spin" /> Fetching...</>
            ) : (
              <><RotateCw size={13} /> Retry Fetch</>
            )}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              onClose()
              onConfirmFollow()
            }}
            disabled={refetching}
            className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
          >
            <UserPlus size={13} />
            Follow Anyway
          </Button>
        </div>
      </div>
    </div>
  )
}
