/**
 * HashRecoveryModal — Tries remaining blossom servers to find a hash-verified file.
 *
 * Shown when a tamper warning badge is clicked. Iterates through servers showing
 * per-server status, and if successful swaps in the verified media. If all fail,
 * offers a "Download anyway (highly unrecommended)" option.
 */

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Check, AlertTriangle, Download, ShieldAlert } from 'lucide-react'

interface ServerAttempt {
  url: string
  status: 'waiting' | 'fetching' | 'hashing' | 'success' | 'hash-mismatch' | 'error'
}

interface HashRecoveryModalProps {
  expectedHash: string
  servers: string[]
  ext: string
  onClose: () => void
  /** Called with a verified blob URL when recovery succeeds */
  onRecovered: (blobUrl: string) => void
}

async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function HashRecoveryModal({ expectedHash, servers, ext, onClose, onRecovered }: HashRecoveryModalProps) {
  const [attempts, setAttempts] = useState<ServerAttempt[]>(
    () => servers.map(s => ({ url: s.replace(/\/+$/, ''), status: 'waiting' as const }))
  )
  const [allDone, setAllDone] = useState(false)
  const [anySuccess, setAnySuccess] = useState(false)
  const cancelledRef = useRef(false)
  const unmatchedBlobRef = useRef<string | null>(null)

  useEffect(() => {
    cancelledRef.current = false
    let recoveredBlobUrl = ''

    const run = async () => {
      for (let i = 0; i < servers.length; i++) {
        if (cancelledRef.current) return
        const baseUrl = servers[i].replace(/\/+$/, '')
        const srcUrl = `${baseUrl}/${expectedHash}${ext}`

        // Update status: fetching
        setAttempts(prev => prev.map((a, idx) => idx === i ? { ...a, status: 'fetching' } : a))

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30000)
          const res = await fetch(srcUrl, { signal: controller.signal })
          clearTimeout(timer)

          if (!res.ok) {
            if (!cancelledRef.current) {
              setAttempts(prev => prev.map((a, idx) => idx === i ? { ...a, status: 'error' } : a))
            }
            continue
          }

          // Update status: hashing
          if (!cancelledRef.current) {
            setAttempts(prev => prev.map((a, idx) => idx === i ? { ...a, status: 'hashing' } : a))
          }

          const blob = await res.blob()
          if (cancelledRef.current) return

          const actualHash = await hashBlob(blob)

          if (actualHash === expectedHash) {
            // Success!
            const blobUrl = URL.createObjectURL(blob)
            recoveredBlobUrl = blobUrl
            if (!cancelledRef.current) {
              setAttempts(prev => prev.map((a, idx) => idx === i ? { ...a, status: 'success' } : a))
              setAnySuccess(true)
              setAllDone(true)
              // Brief delay so user can see the success, then recover
              setTimeout(() => {
                if (!cancelledRef.current) onRecovered(blobUrl)
              }, 800)
            }
            return
          } else {
            // Store the unmatched blob for "download anyway"
            unmatchedBlobRef.current = URL.createObjectURL(blob)
            if (!cancelledRef.current) {
              setAttempts(prev => prev.map((a, idx) => idx === i ? { ...a, status: 'hash-mismatch' } : a))
            }
          }
        } catch {
          if (!cancelledRef.current) {
            setAttempts(prev => prev.map((a, idx) => idx === i ? { ...a, status: 'error' } : a))
          }
        }
      }

      // All servers exhausted without success
      if (!cancelledRef.current) setAllDone(true)
    }

    run()

    return () => {
      cancelledRef.current = true
      if (recoveredBlobUrl) URL.revokeObjectURL(recoveredBlobUrl)
    }
  }, [servers, expectedHash, ext, onRecovered])

  const handleDownloadAnyway = () => {
    // Build a direct download URL from the first server
    const baseUrl = servers[0]?.replace(/\/+$/, '') || ''
    const url = unmatchedBlobRef.current || `${baseUrl}/${expectedHash}${ext}`

    const a = document.createElement('a')
    a.href = url
    a.download = `${expectedHash.slice(0, 12)}${ext}`
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    onClose()
  }

  const statusIcon = (status: ServerAttempt['status']) => {
    switch (status) {
      case 'waiting':
        return <div className="w-4 h-4 rounded-full border border-border" />
      case 'fetching':
        return <Loader2 size={14} className="animate-spin text-primary" />
      case 'hashing':
        return <Loader2 size={14} className="animate-spin text-amber-400" />
      case 'success':
        return <Check size={14} className="text-emerald-400" />
      case 'hash-mismatch':
        return <ShieldAlert size={14} className="text-red-400" />
      case 'error':
        return <AlertTriangle size={14} className="text-muted-foreground" />
    }
  }

  const statusLabel = (status: ServerAttempt['status']) => {
    switch (status) {
      case 'waiting': return 'Waiting…'
      case 'fetching': return 'Downloading…'
      case 'hashing': return 'Verifying hash…'
      case 'success': return 'Verified ✓'
      case 'hash-mismatch': return 'Hash mismatch'
      case 'error': return 'Failed'
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[420px] max-w-[90vw] bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <ShieldAlert size={18} className="text-red-400" />
            <h3 className="text-sm font-semibold text-foreground">File Integrity Recovery</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            The file's hash doesn't match what was expected. This may indicate the file was modified or corrupted in transit.
            Attempting to find the original file from other servers…
          </p>

          {/* Expected hash */}
          <div className="px-3 py-2 rounded-lg bg-secondary/30 border border-border">
            <p className="text-[10px] text-muted-foreground mb-0.5">Expected SHA-256</p>
            <p className="text-xs font-mono text-foreground break-all">{expectedHash}</p>
          </div>

          {/* Server attempts */}
          <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
            {attempts.map((attempt, i) => (
              <div
                key={i}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors ${
                  attempt.status === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/30'
                    : attempt.status === 'hash-mismatch'
                    ? 'bg-red-500/10 border-red-500/30'
                    : attempt.status === 'error'
                    ? 'bg-secondary/20 border-border/50'
                    : 'bg-secondary/30 border-border'
                }`}
              >
                <div className="shrink-0">{statusIcon(attempt.status)}</div>
                <span className="text-xs font-mono text-foreground/80 truncate flex-1">
                  {attempt.url.replace('https://', '')}
                </span>
                <span className={`text-[10px] shrink-0 ${
                  attempt.status === 'success' ? 'text-emerald-400' :
                  attempt.status === 'hash-mismatch' ? 'text-red-400' :
                  'text-muted-foreground'
                }`}>
                  {statusLabel(attempt.status)}
                </span>
              </div>
            ))}
          </div>

          {/* All done — no success */}
          {allDone && !anySuccess && (
            <div className="space-y-3 pt-1">
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs text-red-400 font-medium">
                    Could not find the original file on any server.
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    All servers returned files that don't match the expected hash. The file may have been permanently modified or replaced.
                  </p>
                </div>
              </div>

              <button
                onClick={handleDownloadAnyway}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-red-500/30 bg-red-500/5 hover:bg-red-500/15 text-red-400 text-xs font-medium transition-colors cursor-pointer"
              >
                <Download size={14} />
                Download anyway (highly unrecommended)
              </button>
              <p className="text-[10px] text-muted-foreground/60 text-center leading-relaxed">
                This file has failed integrity verification on all available servers.
                Downloading it may expose you to tampered or malicious content.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
