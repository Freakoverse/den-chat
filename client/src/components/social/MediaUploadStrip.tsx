/**
 * MediaUploadStrip — Reusable file upload preview strip with progress bars
 * Used by social compose areas (ComposeBox, QuoteRepostModal)
 * 
 * Provides the same rich upload experience as the hub chat (ChatInputBar):
 * image preview, file name/size, progress bar with speed, server info, retry/remove.
 */

import { useState, useRef, useCallback } from 'react'
import { Upload, Loader2, FileIcon, X, ImagePlus } from 'lucide-react'
import { uploadToBlossomServers, computeHash } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import type { ISigner } from '@/stores/userStore'

/* ─── Types ─── */

export type PendingFile = {
  id: string
  file: File
  status: 'pending' | 'uploading' | 'success' | 'failed'
  hash?: string
  progress?: UploadProgress
  previewUrl?: string
}

/* ─── Helpers ─── */

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bps: number) {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function shortServerName(url: string) {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

/* ─── Hook ─── */

export function useMediaUpload(signer: ISigner | null | undefined, privateKey: string | null | undefined) {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ names: string[]; limitMb: number } | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const knownHashesRef = useRef<Set<string>>(new Set())

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    const limitBytes = limitMb * 1024 * 1024
    const tooLarge = files.filter((f) => f.size > limitBytes)
    const allowed = files.filter((f) => f.size <= limitBytes)
    if (tooLarge.length > 0) {
      setFileSizeWarning({ names: tooLarge.map((f) => f.name), limitMb })
    }
    if (allowed.length === 0) return

    const newPending: PendingFile[] = []
    for (const file of allowed) {
      const buffer = await file.arrayBuffer()
      const hash = computeHash(new Uint8Array(buffer))
      if (knownHashesRef.current.has(hash)) continue
      knownHashesRef.current.add(hash)

      const pf: PendingFile = {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        status: 'pending',
        hash,
      }
      if (file.type.startsWith('image/')) {
        pf.previewUrl = URL.createObjectURL(file)
      }
      newPending.push(pf)
    }
    if (newPending.length > 0) {
      setPendingFiles((prev) => [...prev, ...newPending])
    }
  }, [])

  const removeFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((f) => f.id === fileId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      if (removed?.hash) knownHashesRef.current.delete(removed.hash)
      return prev.filter((f) => f.id !== fileId)
    })
  }, [])

  const uploadAll = useCallback(async (): Promise<string[]> => {
    const toUpload = pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed')
    if (toUpload.length === 0) {
      return pendingFiles.filter((f) => f.status === 'success' && f.hash).map((f) => f.hash!)
    }
    setIsUploading(true)
    const hashes: string[] = []

    for (const pf of toUpload) {
      setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'uploading' as const, progress: undefined } : f))
      try {
        const buffer = await pf.file.arrayBuffer()
        const data = new Uint8Array(buffer)
        const { hash } = await uploadToBlossomServers(
          data, signer || null, privateKey || null, undefined, pf.file.type,
          (progress) => {
            setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, progress: { ...progress } } : f))
          },
          () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
        )
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'success' as const, hash, progress: undefined } : f))
        hashes.push(hash)
      } catch {
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'failed' as const, progress: undefined } : f))
      }
    }
    // Also include already-successful files
    setPendingFiles((prev) => {
      prev.filter((f) => f.status === 'success' && f.hash && !hashes.includes(f.hash!)).forEach((f) => hashes.push(f.hash!))
      return prev
    })
    setIsUploading(false)
    return hashes
  }, [pendingFiles, signer, privateKey])

  const clearAll = useCallback(() => {
    pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
    setPendingFiles([])
    knownHashesRef.current.clear()
  }, [pendingFiles])

  const getUploadedUrls = useCallback(() => {
    return pendingFiles
      .filter((f) => f.status === 'success' && f.hash)
      .map((f) => `https://blossom.primal.net/${f.hash}`)
  }, [pendingFiles])

  const hasPendingOrFailed = pendingFiles.some((f) => f.status === 'pending' || f.status === 'failed')
  const allSuccess = pendingFiles.length > 0 && pendingFiles.every((f) => f.status === 'success')

  return {
    pendingFiles,
    isUploading,
    fileSizeWarning,
    dismissSizeWarning: useCallback(() => setFileSizeWarning(null), []),
    addFiles,
    removeFile,
    uploadAll,
    clearAll,
    getUploadedUrls,
    hasPendingOrFailed,
    allSuccess,
    uploadAbortRef,
    setPendingFiles,
  }
}

/* ─── Component ─── */

interface MediaUploadStripProps {
  pendingFiles: PendingFile[]
  isUploading: boolean
  onRemove: (id: string) => void
  onUpload: () => void
  onRetry: (id: string) => void
  onSkipServer: () => void
  fileSizeWarning?: { names: string[]; limitMb: number } | null
  onDismissSizeWarning?: () => void
}

export function MediaUploadStrip({
  pendingFiles, isUploading, onRemove, onUpload, onRetry, onSkipServer, fileSizeWarning, onDismissSizeWarning,
}: MediaUploadStripProps) {
  if (pendingFiles.length === 0 && !fileSizeWarning) return null

  return (
    <>
    {fileSizeWarning && (
      <div className="flex items-start gap-2 px-3 py-2 mx-1 mb-1 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive">
        <div className="flex-1">
          <p>
            The following file{fileSizeWarning.names.length > 1 ? 's exceed' : ' exceeds'} the {fileSizeWarning.limitMb} MB upload limit and {fileSizeWarning.names.length > 1 ? 'were' : 'was'} not added:
          </p>
          <p className="font-medium mt-0.5">{fileSizeWarning.names.join(', ')}</p>
          <p className="text-destructive/70 mt-0.5">You can change this in <strong>Settings → Network → Media Upload Limit</strong>.</p>
        </div>
        {onDismissSizeWarning && (
          <button onClick={onDismissSizeWarning} className="p-0.5 rounded hover:bg-destructive/20 cursor-pointer shrink-0 mt-0.5">
            <X size={12} />
          </button>
        )}
      </div>
    )}
    <div className="flex flex-wrap gap-2 px-1 py-2">
      {pendingFiles.map((pf) => (
        <div key={pf.id} className="relative flex items-center gap-2 bg-background rounded-lg border border-border px-2 py-1.5 min-w-[140px] max-w-[200px]">
          {/* Thumbnail or file icon */}
          {pf.previewUrl ? (
            <img src={pf.previewUrl} alt={pf.file.name} className="w-10 h-10 rounded object-cover shrink-0" />
          ) : (
            <div className="w-10 h-10 rounded bg-secondary flex items-center justify-center shrink-0">
              <FileIcon size={18} className="text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs text-foreground truncate">{pf.file.name}</p>
            <p className="text-[10px] text-muted-foreground">{formatFileSize(pf.file.size)}</p>
            {/* Upload progress */}
            {pf.status === 'uploading' && pf.progress && (
              <div className="mt-0.5">
                <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${pf.progress.percent}%` }} />
                </div>
                <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
                  <span className="truncate">{shortServerName(pf.progress.serverUrl)} ({pf.progress.serverIndex + 1}/{pf.progress.totalServers})</span>
                  <span className="flex items-center gap-1">
                    {pf.progress.percent >= 100
                      ? <span className="text-amber-400">Processing...</span>
                      : formatSpeed(pf.progress.speed)
                    }
                    <button
                      onClick={() => onSkipServer()}
                      className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5"
                    >
                      skip
                    </button>
                  </span>
                </div>
              </div>
            )}
            {pf.status === 'success' && <span className="text-[10px] text-emerald-400">✓ Uploaded</span>}
            {pf.status === 'failed' && (
              <button onClick={() => onRetry(pf.id)} className="text-[10px] text-destructive hover:underline cursor-pointer">✗ Failed – retry</button>
            )}
          </div>
          {/* Remove button */}
          {pf.status !== 'uploading' && (
            <button onClick={() => onRemove(pf.id)} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center cursor-pointer hover:bg-destructive/80 transition-colors">
              <X size={10} />
            </button>
          )}
        </div>
      ))}
      {/* Upload button */}
      {pendingFiles.some((f) => f.status === 'pending' || f.status === 'failed') && !isUploading && (
        <button
          onClick={onUpload}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer self-center"
        >
          <Upload size={14} />
          Upload {pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length} file{pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length > 1 ? 's' : ''}
        </button>
      )}
      {isUploading && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground self-center">
          <Loader2 size={14} className="animate-spin" />
          Uploading...
        </div>
      )}
    </div>
    </>
  )
}

/* ─── Add Media Button ─── */

interface AddMediaButtonProps {
  onFilesSelected: (files: File[]) => void
  uploading?: boolean
}

export function AddMediaButton({ onFilesSelected, uploading }: AddMediaButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={(e) => {
          onFilesSelected(Array.from(e.target.files || []))
          e.target.value = ''
        }}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="p-1.5 rounded-full cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
      >
        {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
      </button>
    </>
  )
}
