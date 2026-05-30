/**
 * VerificationBadge — Small overlay badge showing SHA-256 hash verification status
 *
 * States:
 *   pending  — subtle pulsing shield outline
 *   verified — green shield with checkmark, fades out after 2s
 *   tampered — red/amber warning icon, clickable to open recovery modal
 */

import { useState, useEffect } from 'react'
import { Shield, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import type { VerificationStatus } from '@/hooks/useBlossomMedia'
import { HashRecoveryModal } from './HashRecoveryModal'

interface VerificationBadgeProps {
  verified: VerificationStatus
  expectedHash: string
  servers: string[]
  ext: string
  /** Called when recovery finds a verified blob URL */
  onRecovered?: (blobUrl: string) => void
  /** Position — defaults to 'top-right' */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  /** Size variant */
  size?: 'sm' | 'md'
}

export function VerificationBadge({
  verified,
  expectedHash,
  servers,
  ext,
  onRecovered,
  position = 'top-right',
  size = 'sm',
}: VerificationBadgeProps) {
  const [showRecovery, setShowRecovery] = useState(false)
  const [fadeOut, setFadeOut] = useState(false)

  // Auto-fade the verified badge after 2s
  useEffect(() => {
    if (verified === 'verified') {
      const timer = setTimeout(() => setFadeOut(true), 2000)
      return () => clearTimeout(timer)
    } else {
      setFadeOut(false)
    }
  }, [verified])

  const positionClasses: Record<string, string> = {
    'top-right': 'top-1.5 right-1.5',
    'top-left': 'top-1.5 left-1.5',
    'bottom-right': 'bottom-1.5 right-1.5',
    'bottom-left': 'bottom-1.5 left-1.5',
  }

  const iconSize = size === 'sm' ? 14 : 18

  if (verified === 'pending') {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`absolute ${positionClasses[position]} z-10 pointer-events-auto`}>
              <div className="rounded-full bg-black/40 backdrop-blur-sm p-1 animate-pulse">
                <Shield size={iconSize} className="text-white/70" />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Verifying file integrity…
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  if (verified === 'verified') {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={`absolute ${positionClasses[position]} z-10 pointer-events-auto transition-opacity duration-500 ${fadeOut ? 'opacity-0' : 'opacity-100'}`}
            >
              <div className="rounded-full bg-emerald-500/80 backdrop-blur-sm p-1">
                <ShieldCheck size={iconSize} className="text-white" />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={12} className="text-emerald-400" />
              File integrity verified
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // tampered
  return (
    <>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => { e.stopPropagation(); setShowRecovery(true) }}
              className={`absolute ${positionClasses[position]} z-10 cursor-pointer group`}
            >
              <div className="rounded-full bg-red-500/90 backdrop-blur-sm p-1 group-hover:bg-red-500 transition-colors shadow-lg shadow-red-500/20">
                <ShieldAlert size={iconSize} className="text-white" />
              </div>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px]">
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-red-400">
                <ShieldAlert size={12} />
                Hash mismatch detected
              </span>
              <span className="text-[11px] text-muted-foreground">
                The file's hash doesn't match the expected value. Click to attempt recovery from other servers.
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {showRecovery && (
        <HashRecoveryModal
          expectedHash={expectedHash}
          servers={servers}
          ext={ext}
          onClose={() => setShowRecovery(false)}
          onRecovered={(blobUrl: string) => {
            onRecovered?.(blobUrl)
            setShowRecovery(false)
          }}
        />
      )}
    </>
  )
}
