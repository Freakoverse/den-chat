/**
 * GroupFaceEditor: the banner + picture upload block shared by group creation and group editing.
 * Same system as hub creation: pick or drop an image, crop it (or upload the original), upload to
 * the client's Blossom servers sequentially with the per-server progress bar, keep the first
 * accepting server's URL. For a private (v2) group the Blossom auth is signed as the owner
 * pseudonym O derived from the group's d tag, so the blob isn't linked to the real key.
 */
import { useEffect, useRef, useState } from 'react'
import type { UnsignedEvent, Event as NostrEvent } from 'nostr-tools'
import { Loader2, AlertTriangle, Camera, ImageIcon, XCircle, Check } from 'lucide-react'
import { ImageCropModal } from '@/components/ui/ImageCropModal'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { uploadToBlossomServers } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import { makeSubkeySigner } from '@/lib/nostr/v2send'
import { ChatContext, canUseV2 } from '@/lib/crypto/skd'
import { useUserStore } from '@/stores/userStore'
import { cn } from '@/lib/utils'

const ACCEPTED_IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp'
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}
function shortServerName(url: string): string {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}
const uploadLimitMb = () => Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10

/** One image slot: local preview (or the existing URL), Blossom URL once uploaded, upload progress. */
interface ImageSlot {
  preview: string | null
  url: string | null
  status: UploadStatus
  progress: UploadProgress | null
  successCount: number
  /** The Blossom auth was signed as the owner pseudonym O (true) or the real key R (false). */
  authedAsO: boolean
}
const emptySlot: ImageSlot = { preview: null, url: null, status: 'idle', progress: null, successCount: 0, authedAsO: false }
const slotFrom = (url?: string | null): ImageSlot => (url ? { ...emptySlot, preview: url, url } : emptySlot)

export interface GroupFace { picture: string | null; banner: string | null }
export interface GroupFaceState {
  face: GroupFace
  /** An upload is in flight; the parent should not publish yet. */
  uploading: boolean
  /** A crop editor or the size warning is open; the parent should not close on Escape. */
  overlayOpen: boolean
  /** Slots whose blob was uploaded under the REAL key (before Private was turned on). A private group
   *  must not reference them: the upload auth would tie the real key to the O-authored event. */
  realKeyUploads: ('picture' | 'banner')[]
}

/** The multi-server upload bar from hub creation: current server, percent, speed, skip. */
function UploadStatusDisplay({ slot, onSkip }: { slot: ImageSlot; onSkip: () => void }) {
  const { status, progress, successCount } = slot
  if (status === 'uploading' && progress) {
    return (
      <div className="flex flex-col gap-0.5 w-full mt-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-amber-400 truncate max-w-[140px]">{shortServerName(progress.serverUrl)} ({progress.serverIndex + 1}/{progress.totalServers})</span>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onSkip} className="text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-0.5">
                  <XCircle size={10} /><span className="text-[10px]">Skip</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="z-[300] text-xs">Skip this server</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>{progress.percent}%</span><span>{formatSpeed(progress.speed)}</span></div>
      </div>
    )
  }
  if (status === 'uploading') return <span className="flex items-center gap-1 text-xs text-amber-400 mt-1"><Loader2 size={10} className="animate-spin" /> Preparing...</span>
  if (status === 'success') return <span className="flex items-center gap-1 text-xs text-emerald-400 mt-1"><Check size={10} /> {successCount} server{successCount !== 1 ? 's' : ''}</span>
  if (status === 'error') return <span className="flex items-center gap-1 text-xs text-destructive mt-1"><AlertTriangle size={10} /> Failed</span>
  return null
}

export function GroupFaceEditor({ dTag, v2, initial, onChange, onError }: {
  dTag: string
  /** Sign the Blossom auth as the owner pseudonym O (private group). */
  v2: boolean
  initial?: Partial<GroupFace>
  onChange: (state: GroupFaceState) => void
  onError: (message: string) => void
}) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [picture, setPicture] = useState<ImageSlot>(() => slotFrom(initial?.picture))
  const [banner, setBanner] = useState<ImageSlot>(() => slotFrom(initial?.banner))
  const [pictureEditFile, setPictureEditFile] = useState<File | null>(null)
  const [bannerEditFile, setBannerEditFile] = useState<File | null>(null)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ name: string; limitMb: number } | null>(null)
  const pictureInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const pictureAbortRef = useRef<AbortController | null>(null)
  const bannerAbortRef = useRef<AbortController | null>(null)
  const [pictureDragOver, setPictureDragOver] = useState(false)
  const [bannerDragOver, setBannerDragOver] = useState(false)

  // Report upward without making the parent's inline callback an effect dependency.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    onChangeRef.current({
      face: { picture: picture.url, banner: banner.url },
      uploading: picture.status === 'uploading' || banner.status === 'uploading',
      overlayOpen: !!pictureEditFile || !!bannerEditFile || !!fileSizeWarning,
      realKeyUploads: [
        ...(picture.url && picture.status === 'success' && !picture.authedAsO ? ['picture' as const] : []),
        ...(banner.url && banner.status === 'success' && !banner.authedAsO ? ['banner' as const] : []),
      ],
    })
  }, [picture, banner, pictureEditFile, bannerEditFile, fileSizeWarning])

  const uploadImage = async (file: File, set: (fn: (s: ImageSlot) => ImageSlot) => void, abortRef: React.MutableRefObject<AbortController | null>) => {
    if (file.size > uploadLimitMb() * 1024 * 1024) { setFileSizeWarning({ name: file.name, limitMb: uploadLimitMb() }); return }
    set(() => ({ ...emptySlot, preview: URL.createObjectURL(file), status: 'uploading' }))
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      let ownerAuthSigner: ((e: UnsignedEvent) => Promise<NostrEvent>) | undefined
      if (v2 && canUseV2({ privateKey, signer })) ownerAuthSigner = makeSubkeySigner(ChatContext.owner(dTag), { privateKey, signer }).signEvent
      const { hash, successCount, serverUrls } = await uploadToBlossomServers(
        data, signer, privateKey, undefined, file.type,
        (progress) => set((s) => ({ ...s, progress: { ...progress } })),
        () => { const c = new AbortController(); abortRef.current = c; return c.signal },
        ownerAuthSigner,
      )
      const base = (serverUrls[0] ?? '').replace(/\/+$/, '')
      set((s) => ({ ...s, url: `${base}/${hash}`, successCount, status: 'success', progress: null, authedAsO: !!ownerAuthSigner }))
    } catch (err) {
      console.error('[Group] image upload failed:', err)
      set((s) => ({ ...s, status: 'error', progress: null }))
    } finally {
      abortRef.current = null
    }
  }
  const startEdit = (f: File, set: (f: File | null) => void) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(f.type)) { onError('Only image files are allowed (PNG, JPG, GIF, WebP)'); return }
    if (f.size > uploadLimitMb() * 1024 * 1024) { setFileSizeWarning({ name: f.name, limitMb: uploadLimitMb() }); return }
    set(f)
  }
  const uploadPicture = (f: File) => uploadImage(f, setPicture, pictureAbortRef)
  const uploadBanner = (f: File) => uploadImage(f, setBanner, bannerAbortRef)
  const skip = (ref: React.MutableRefObject<AbortController | null>) => { ref.current?.abort(); ref.current = null }
  const dragOver = (e: React.DragEvent, set: (v: boolean) => void) => { e.preventDefault(); e.stopPropagation(); set(true) }
  const dragLeave = (e: React.DragEvent, set: (v: boolean) => void) => { e.preventDefault(); e.stopPropagation(); set(false) }

  return (
    <div>
      {/* Banner with the picture overlapping its bottom-left corner */}
      <div className="relative">
        <button
          type="button"
          onClick={() => bannerInputRef.current?.click()}
          disabled={banner.status === 'uploading'}
          onDragOver={(e) => dragOver(e, setBannerDragOver)}
          onDragLeave={(e) => dragLeave(e, setBannerDragOver)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setBannerDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) startEdit(f, setBannerEditFile) }}
          className={cn('relative w-full aspect-[3/1] rounded-lg border-2 border-dashed flex items-center justify-center overflow-hidden transition-colors cursor-pointer group', bannerDragOver ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50')}
        >
          {banner.preview ? <img src={banner.preview} alt="Group banner" className="w-full h-full object-cover" /> : (
            <span className="flex flex-col items-center gap-1 text-muted-foreground group-hover:text-primary/70"><ImageIcon size={22} /><span className="text-xs">Banner</span></span>
          )}
          {banner.status === 'uploading' && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><Loader2 size={18} className="animate-spin text-white" /></div>}
          {banner.preview && banner.status !== 'uploading' && (
            <div className={cn('absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity', bannerDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}><ImageIcon size={16} className="text-white" /></div>
          )}
        </button>
        <button
          type="button"
          onClick={() => pictureInputRef.current?.click()}
          disabled={picture.status === 'uploading'}
          onDragOver={(e) => dragOver(e, setPictureDragOver)}
          onDragLeave={(e) => dragLeave(e, setPictureDragOver)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setPictureDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) startEdit(f, setPictureEditFile) }}
          className={cn('absolute left-4 -bottom-7 w-[72px] h-[72px] rounded-full border-2 border-dashed bg-card flex items-center justify-center overflow-hidden transition-colors cursor-pointer group shadow-lg', pictureDragOver ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50')}
        >
          {picture.preview ? <img src={picture.preview} alt="Group picture" className="w-full h-full object-cover" /> : <Camera size={20} className="text-muted-foreground group-hover:text-primary/70" />}
          {picture.status === 'uploading' && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><Loader2 size={16} className="animate-spin text-white" /></div>}
          {picture.preview && picture.status !== 'uploading' && (
            <div className={cn('absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity', pictureDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}><Camera size={16} className="text-white" /></div>
          )}
        </button>
      </div>
      <div className="flex items-start gap-4 mt-8 pl-1">
        <div className="w-[88px] shrink-0 flex flex-col">
          <span className="text-xs text-muted-foreground">Picture</span>
          <UploadStatusDisplay slot={picture} onSkip={() => skip(pictureAbortRef)} />
          {picture.preview && picture.status !== 'uploading' && <button type="button" onClick={() => setPicture(emptySlot)} className="text-xs text-destructive hover:underline cursor-pointer mt-0.5 text-left">Remove</button>}
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-xs text-muted-foreground">Banner</span>
          <UploadStatusDisplay slot={banner} onSkip={() => skip(bannerAbortRef)} />
          {banner.preview && banner.status !== 'uploading' && <button type="button" onClick={() => setBanner(emptySlot)} className="text-xs text-destructive hover:underline cursor-pointer mt-0.5 text-left">Remove</button>}
        </div>
      </div>
      <input ref={pictureInputRef} type="file" accept={ACCEPTED_IMAGE_EXTENSIONS} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) startEdit(f, setPictureEditFile); e.target.value = '' }} />
      <input ref={bannerInputRef} type="file" accept={ACCEPTED_IMAGE_EXTENSIONS} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) startEdit(f, setBannerEditFile); e.target.value = '' }} />

      {/* Crop editors, opened before uploading a picked or dropped image */}
      {pictureEditFile && (
        <ImageCropModal file={pictureEditFile} aspect={1} round maxOutput={512} title="Edit group picture"
          onCancel={() => setPictureEditFile(null)}
          onUploadOriginal={() => { const f = pictureEditFile; setPictureEditFile(null); uploadPicture(f) }}
          onSave={(f) => { setPictureEditFile(null); uploadPicture(f) }} />
      )}
      {bannerEditFile && (
        <ImageCropModal file={bannerEditFile} aspect={3} maxOutput={1500} title="Edit group banner"
          onCancel={() => setBannerEditFile(null)}
          onUploadOriginal={() => { const f = bannerEditFile; setBannerEditFile(null); uploadBanner(f) }}
          onSave={(f) => { setBannerEditFile(null); uploadBanner(f) }} />
      )}
      {fileSizeWarning && (
        <div className="fixed inset-0 z-[260] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={() => setFileSizeWarning(null)}>
          <div className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2"><AlertTriangle size={18} className="text-amber-500 shrink-0" /><h4 className="text-sm font-semibold text-foreground">File too large</h4></div>
            <p className="text-xs text-muted-foreground">{fileSizeWarning.name} is over the {fileSizeWarning.limitMb} MB upload limit set in Settings.</p>
            <div className="flex justify-end"><button onClick={() => setFileSizeWarning(null)} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 cursor-pointer">OK</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
