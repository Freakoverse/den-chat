/**
 * Customize the user's virtual-space standee — front + back images.
 * Drag-drop (or click) images, which upload via the normal multi-server Blossom
 * flow (failover + hash), respecting the upload size limit from settings, then
 * publish the NIP-78 (kind 30078) avatar event.
 */
import { useEffect, useRef, useState } from 'react'
import { X, Loader2, ImageUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUserStore } from '@/stores/userStore'
import { uploadToBlossomServers } from '@/lib/blossom/client'
import {
  fetchVirtualAvatarCached,
  publishVirtualAvatar,
  clearVirtualAvatarCache,
} from '@/lib/voice/virtualAvatar'

interface Side { url?: string; preview?: string; uploading: boolean }

function uploadLimitMb(): number {
  return Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
}

export default function VirtualAvatarModal({ onClose }: { onClose: () => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [front, setFront] = useState<Side>({ uploading: false })
  const [back, setBack] = useState<Side>({ uploading: false })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Load the existing avatar.
  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    fetchVirtualAvatarCached(pubkey).then((av) => {
      if (cancelled || !av) return
      if (av.front) setFront((s) => ({ ...s, url: av.front, preview: av.front }))
      if (av.back) setBack((s) => ({ ...s, url: av.back, preview: av.back }))
    })
    return () => { cancelled = true }
  }, [pubkey])

  const handleFile = async (file: File, set: typeof setFront) => {
    setError(null)
    if (!file.type.startsWith('image/')) { setError('Images only.'); return }
    const limit = uploadLimitMb()
    if (file.size > limit * 1024 * 1024) {
      setError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — over the ${limit} MB upload limit.`)
      return
    }
    const localPreview = URL.createObjectURL(file)
    set((s) => ({ ...s, uploading: true, preview: localPreview }))
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { serverUrls } = await uploadToBlossomServers(bytes, signer, privateKey, undefined, file.type)
      if (!serverUrls.length) throw new Error('no servers')
      set((s) => ({ ...s, uploading: false, url: serverUrls[0], preview: localPreview }))
    } catch {
      setError('Upload failed — check your Blossom servers in settings.')
      set((s) => ({ ...s, uploading: false }))
    }
  }

  const save = async () => {
    if (!signer && !privateKey) { setError('Not signed in.'); return }
    setSaving(true)
    setError(null)
    try {
      await publishVirtualAvatar({ front: front.url, back: back.url }, signer, privateKey)
      if (pubkey) clearVirtualAvatarCache(pubkey)
      onClose()
    } catch {
      setError('Failed to save. Try again.')
      setSaving(false)
    }
  }

  const busy = front.uploading || back.uploading || saving

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-card border border-border shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Virtual Space avatar</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={18} /></button>
        </div>

        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          <p className="text-xs text-muted-foreground">
            Your standee shows a <span className="text-foreground">front</span> and <span className="text-foreground">back</span> image
            (9:16 portrait works best). Images only · max {uploadLimitMb()} MB · uploaded to your Blossom servers.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <DropSide label="Front" side={front} onFile={(f) => handleFile(f, setFront)} onClear={() => setFront({ uploading: false })} />
            <DropSide label="Back" side={back} onFile={(f) => handleFile(f, setBack)} onClear={() => setBack({ uploading: false })} />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer">Cancel</button>
          <button
            onClick={save}
            disabled={busy}
            className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function DropSide({ label, side, onFile, onClear }: {
  label: string; side: Side; onFile: (f: File) => void; onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        {side.preview && !side.uploading && (
          <button onClick={onClear} className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">Clear</button>
        )}
      </div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f) }}
        className={cn(
          'relative aspect-[9/16] rounded-xl border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer transition-colors bg-secondary/20',
          drag ? 'border-primary/60 bg-primary/5' : 'border-border/50 hover:border-border',
        )}
      >
        {side.preview ? (
          <img src={side.preview} alt={label} className="absolute inset-0 w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground p-2 text-center">
            <ImageUp size={20} />
            <span className="text-[10px]">Drop or click</span>
          </div>
        )}
        {side.uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Loader2 size={20} className="animate-spin text-white" />
          </div>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
    </div>
  )
}
